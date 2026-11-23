// C08·C12·C13·C15: 액세스 토큰으로 MCP 서버(Streamable HTTP)에 실제로 말을 걸어 본다.
// initialize → notifications/initialized → tools/list. 응답은 JSON 이거나 SSE 스트림일 수 있다.
import { bearerChallenge } from './discovery.js';
import { MAX_BODY_BYTES, asObject, describeError, readLimited } from './http.js';
import { TOOL_VERSION, type CheckId, type CheckResult } from './types.js';

export const REQUESTED_PROTOCOL_VERSION = '2025-11-25';

export interface RpcReply {
  reached: boolean;
  status: number;
  sessionId?: string;
  wwwAuthenticate?: string;
  /** id 가 맞는 JSON-RPC 응답 메시지 */
  message?: Record<string, unknown>;
  error?: string;
}

interface RpcInput {
  url: string;
  token: string;
  body: Record<string, unknown>;
  sessionId?: string;
  protocolVersion?: string;
  timeoutMs: number;
}

/** JSON-RPC 한 건을 POST 하고, id 가 맞는 응답을 JSON 또는 SSE 에서 찾아 돌려준다 */
export async function rpc(input: RpcInput): Promise<RpcReply> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${input.token}`,
  };
  // 세션 ID·프로토콜 버전은 initialize 이후 요청마다 이어 보내야 한다(MCP Streamable HTTP).
  if (input.sessionId) headers['mcp-session-id'] = input.sessionId;
  if (input.protocolVersion) headers['mcp-protocol-version'] = input.protocolVersion;

  let res: Response;
  try {
    res = await fetch(input.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body),
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (err) {
    return { reached: false, status: 0, error: describeError(err) };
  }
  const reply: RpcReply = { reached: true, status: res.status };
  const sid = res.headers.get('mcp-session-id');
  if (sid) reply.sessionId = sid;
  const www = res.headers.get('www-authenticate');
  if (www) reply.wwwAuthenticate = www;

  const id = input.body.id;
  if (id === undefined || !res.ok || !res.body) {
    // 알림(id 없음)이거나 오류 상태면 본문은 버린다(연결은 정리).
    await res.body?.cancel().catch(() => undefined);
    return reply;
  }
  try {
    const type = res.headers.get('content-type') ?? '';
    const found = type.includes('text/event-stream')
      ? await readSseUntil(res.body, id)
      : asObject(JSON.parse(await readLimited(res, MAX_BODY_BYTES)));
    if (found) reply.message = found;
    else reply.error = 'no_response_message';
  } catch (err) {
    reply.error = describeError(err);
  }
  return reply;
}

/**
 * SSE 스트림을 조금씩 읽어 id 가 맞는 응답이 나오면 바로 멈춘다.
 * 서버가 스트림을 닫지 않고 열어 두어도 기다리지 않게 하기 위함이다.
 */
export async function readSseUntil(
  body: ReadableStream<Uint8Array>,
  id: unknown,
): Promise<Record<string, unknown> | undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') {
          // 빈 줄 = 이벤트 하나 끝. data 줄들을 이어 붙여 JSON 으로 해석한다.
          const msg = parseEventData(dataLines);
          dataLines = [];
          if (msg && msg.id === id && ('result' in msg || 'error' in msg)) return msg;
        } else if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // event:, id:, retry:, 주석(:) 줄은 무시
      }
    }
    const last = parseEventData(dataLines);
    return last && last.id === id ? last : undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseEventData(lines: string[]): Record<string, unknown> | undefined {
  if (lines.length === 0) return undefined;
  try {
    return asObject(JSON.parse(lines.join('\n')));
  } catch {
    return undefined;
  }
}

export interface Handshake {
  ok: boolean;
  /** 실패한 단계 */
  step?: 'initialize' | 'initialized' | 'tools/list';
  status: number;
  protocolVersion?: string;
  sessionId?: boolean;
  toolCount?: number;
  error?: string;
  wwwAuthenticate?: string;
}

/** initialize → initialized → tools/list 를 한 토큰으로 끝까지 해 본다 */
export async function mcpHandshake(url: string, token: string, timeoutMs: number): Promise<Handshake> {
  const init = await rpc({
    url, token, timeoutMs,
    body: {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        protocolVersion: REQUESTED_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'mcp-refresh-doctor', version: TOOL_VERSION },
      },
    },
  });
  const initResult = asObject(init.message?.result);
  if (!init.reached || init.status !== 200 || !initResult) {
    return failed('initialize', init);
  }
  const protocolVersion = typeof initResult.protocolVersion === 'string' ? initResult.protocolVersion : REQUESTED_PROTOCOL_VERSION;
  const session = { sessionId: init.sessionId, protocolVersion };

  try {
    const note = await rpc({ url, token, timeoutMs, ...session, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    if (!note.reached || note.status < 200 || note.status >= 300) return failed('initialized', note);

    const list = await rpc({ url, token, timeoutMs, ...session, body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } });
    const listResult = asObject(list.message?.result);
    if (!list.reached || list.status !== 200 || !listResult) return failed('tools/list', list);
    const tools = Array.isArray(listResult.tools) ? listResult.tools.length : 0;
    return {
      ok: true, status: list.status, protocolVersion, sessionId: Boolean(init.sessionId), toolCount: tools,
    };
  } finally {
    // 세션을 만든 서버에는 끝났다고 알려 서버 쪽 자원을 돌려준다(실패해도 무시).
    if (init.sessionId) await endSession(url, token, init.sessionId, protocolVersion, timeoutMs);
  }
}

async function endSession(url: string, token: string, sessionId: string, protocolVersion: string, timeoutMs: number): Promise<void> {
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel().catch(() => undefined);
  } catch {
    // 정리 실패는 진단 결과와 무관
  }
}

function failed(step: NonNullable<Handshake['step']>, r: RpcReply): Handshake {
  const rpcError = asObject(r.message?.error);
  const error = r.error ?? (typeof rpcError?.message === 'string' ? rpcError.message : `http_${r.status}`);
  return {
    ok: false, step, status: r.status, error,
    ...(r.wwwAuthenticate ? { wwwAuthenticate: r.wwwAuthenticate } : {}),
  };
}

export function handshakeEvidence(h: Handshake): Record<string, unknown> {
  return h.ok
    ? { status: h.status, protocolVersion: h.protocolVersion, sessionId: h.sessionId, tools: h.toolCount }
    : { step: h.step, status: h.status, error: h.error, wwwAuthenticate: h.wwwAuthenticate ?? null };
}

/** C08·C12: 받은 액세스 토큰으로 MCP 핸드셰이크가 되는가 */
export function evaluateHandshake(id: 'C08' | 'C12', h: Handshake): CheckResult {
  if (h.ok) {
    return { id, status: 'PASS', detail: `${id.toLowerCase()}.ok`, vars: { tools: h.toolCount ?? 0 }, evidence: handshakeEvidence(h) };
  }
  return {
    id, status: 'FAIL', detail: `${id.toLowerCase()}.failed`,
    vars: { step: h.step ?? 'initialize', status: h.status, error: h.error ?? '' },
    hint: id === 'C08' ? 'hint.c08_accept_token' : 'hint.c12_accept_refreshed',
    evidence: handshakeEvidence(h),
  };
}

/**
 * C13·C15: 무효(위조) 또는 만료된 토큰에 서버가 어떻게 답하는가.
 * RFC 6750 §3: 401 + WWW-Authenticate: Bearer error="invalid_token" 이어야
 * 클라이언트가 "토큰이 만료됐구나 → 갱신하자"를 안다. 403·5xx 는 갱신을 시작시키지 못한다.
 */
export async function probeRejectedToken(url: string, token: string, timeoutMs: number): Promise<RpcReply> {
  return rpc({
    url, token, timeoutMs,
    body: { jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} },
  });
}

export function evaluateRejection(id: Extract<CheckId, 'C13' | 'C15'>, r: RpcReply): CheckResult {
  const error = bearerChallenge(r.wwwAuthenticate)?.params.error;
  const evidence = { status: r.status, wwwAuthenticate: r.wwwAuthenticate ?? null, ...(r.error ? { network: r.error } : {}) };
  const key = id.toLowerCase();
  if (r.status === 401 && error === 'invalid_token') {
    return { id, status: 'PASS', detail: `${key}.ok`, evidence };
  }
  if (r.status === 401) {
    return { id, status: 'WARN', detail: `${key}.no_error`, vars: { error: error ?? '-' }, hint: 'hint.invalid_token_header', evidence };
  }
  return {
    id, status: 'FAIL', detail: `${key}.wrong_status`, vars: { status: r.reached ? r.status : (r.error ?? 'network') },
    hint: 'hint.expired_must_be_401', evidence,
  };
}
