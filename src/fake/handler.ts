// 연습용 목(mock) 인가 서버(AS) + 보호된 MCP 서버의 처리 로직: Web 표준 Request → Response.
//
// 고정된 가짜 응답이 아니라 실제 OAuth 2.1 흐름을 수행한다 —
// DCR 등록, PKCE S256 검증, 코드 1회 사용, 갱신·회전·재사용 감지(가족 폐기), 토큰 만료, audience 확인,
// Mcp-Session-Id 강제. 프리셋은 그 흐름의 한 지점을 일부러 고장 낸다(presets.ts).
//
// 같은 handle() 을 두 길로 쓴다.
//  - demo·단위 시험: fake/inprocess.ts 가 소켓 없이 직접 호출한다(시각은 주입된 수동 시계).
//  - serve·e2e   : fake/server.ts 가 node:http 요청을 Request 로 바꿔 넘긴다(시각은 실제 시계).
import { maskValue } from '../mask.js';
import { challengeS256, randomToken } from '../pkce.js';
import { TOOL_VERSION } from '../types.js';
import { PRESETS, type PresetName } from './presets.js';

export interface FakeHandlerOptions {
  preset: PresetName;
  /** 서버 주소(origin). 발급 주소·메타데이터에 그대로 쓰인다. 기본 http://127.0.0.1:1 (in-process 용, 실제로 열지 않음) */
  base?: string;
  /** 액세스 토큰 수명(초) */
  ttlSec?: number;
  /** MCP 응답 형식: JSON(기본) 또는 SSE 스트림 */
  mcpResponseMode?: 'json' | 'sse';
  /** 요청 로그 한 줄씩(토큰은 가린 형태로만 전달된다) */
  log?: (line: string) => void;
  /** 시험용: 발급한 비밀 값 원문을 모아 둔다(가림 검사용). 기본 꺼짐 */
  trackSecrets?: boolean;
  /** 현재 시각(ms). 기본 Date.now — in-process 시험은 수동 시계를 넣어 만료를 실제로 기다리지 않는다 */
  now?: () => number;
}

export interface FakeHandler {
  base: string;
  mcpUrl: string;
  /** 요청 하나를 처리한다. 예외를 던지지 않는다(처리 중 오류는 500 응답) */
  handle(req: Request): Promise<Response>;
  /** trackSecrets 일 때 발급한 client_id·code·토큰 원문 */
  issuedSecrets: ReadonlySet<string>;
}

/** in-process 목의 기본 주소: 루프백이라 안전장치를 통과하고, 포트 1 은 실제로 열지 않는다(실수로 전역 fetch 가 쓰이면 바로 연결 거부) */
export const IN_PROCESS_BASE = 'http://127.0.0.1:1';

interface AccessRecord { exp: number; clientId: string; family: string; resource: string | undefined }
interface RefreshRecord { clientId: string; family: string; used: boolean; resource: string | undefined }
interface CodeRecord { clientId: string; redirectUri: string; challenge: string; resource: string | undefined; exp: number }

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
// 오래 켜 둔 serve 에서도 메모리가 끝없이 늘지 않도록 상한을 둔다.
const MAX_ENTRIES = 5000;
// 요청 본문 상한(목 서버가 거대한 본문으로 메모리를 잃지 않게)
export const MAX_REQUEST_BODY = 1_000_000;

export function createFakeHandler(opts: FakeHandlerOptions): FakeHandler {
  const behavior = PRESETS[opts.preset].behavior;
  const base = (opts.base ?? IN_PROCESS_BASE).replace(/\/$/, '');
  const ttlMs = (opts.ttlSec ?? 3600) * 1000;
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((): void => undefined);
  const issued = new Set<string>();

  const clients = new Map<string, { redirectUris: string[]; grantTypes: string[] }>();
  const codes = new Map<string, CodeRecord>();
  const accessTokens = new Map<string, AccessRecord>();
  const refreshTokens = new Map<string, RefreshRecord>();
  const sessions = new Set<string>();

  const mcpPath = '/mcp';
  const resourceId = `${base}${mcpPath}`;
  const prmUrl = `${base}/.well-known/oauth-protected-resource${mcpPath}`;

  const track = (value: string): string => {
    if (opts.trackSecrets) issued.add(value);
    return value;
  };

  // ── 토큰 발급 ───────────────────────────────────────────────────────
  const issueTokens = (clientId: string, family: string, resource: string | undefined, withRefresh: boolean): Record<string, unknown> => {
    prune();
    const access = track(`at_${randomToken(24)}`);
    accessTokens.set(access, { exp: now() + ttlMs, clientId, family, resource });
    const body: Record<string, unknown> = {
      access_token: access, token_type: 'Bearer', expires_in: Math.round(ttlMs / 1000),
    };
    if (withRefresh) {
      const refresh = track(`rt_${randomToken(24)}`);
      refreshTokens.set(refresh, { clientId, family, used: false, resource });
      body.refresh_token = refresh;
    }
    return body;
  };

  const revokeFamily = (family: string): void => {
    for (const [k, v] of refreshTokens) if (v.family === family) refreshTokens.delete(k);
    for (const [k, v] of accessTokens) if (v.family === family) accessTokens.delete(k);
  };

  const prune = (): void => {
    const t = now();
    for (const [k, v] of accessTokens) if (v.exp < t) accessTokens.delete(k);
    for (const [k, v] of codes) if (v.exp < t) codes.delete(k);
    for (const map of [clients, codes, accessTokens, refreshTokens] as Map<string, unknown>[]) {
      // Map 은 넣은 순서를 기억하므로 가장 오래된 것부터 지운다.
      while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
    }
    while (sessions.size > MAX_ENTRIES) sessions.delete(sessions.values().next().value as string);
  };

  // ── 요청 처리 ───────────────────────────────────────────────────────
  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    const done = (res: Response, note = ''): Response => {
      log(`${method} ${path}${note ? ' ' + note : ''} -> ${res.status}`);
      return res;
    };

    // 보호 자원 메타데이터(RFC 9728)
    if (method === 'GET' && (path === `/.well-known/oauth-protected-resource${mcpPath}` || path === '/.well-known/oauth-protected-resource')) {
      return done(json(200, {
        resource: resourceId,
        authorization_servers: [base],
        scopes_supported: ['mcp:tools'], // SEP-2207: offline_access 는 여기 넣지 않는다
        bearer_methods_supported: ['header'],
      }));
    }

    // 인가 서버 메타데이터(RFC 8414)
    if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return done(json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: behavior.issueRefreshToken ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp:tools', 'offline_access'],
      }));
    }

    // 동적 클라이언트 등록(RFC 7591)
    if (method === 'POST' && path === '/register') {
      const meta = asRecord(safeJson(await readText(req)));
      const redirectUris = Array.isArray(meta?.redirect_uris) ? meta.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
      if (redirectUris.length === 0) return done(json(400, { error: 'invalid_redirect_uri' }));
      const requested = Array.isArray(meta?.grant_types) ? meta.grant_types.filter((g): g is string => typeof g === 'string') : ['authorization_code'];
      // 갱신 토큰을 안 주는 서버는 등록 응답에서도 refresh_token 을 빼 버린다(보고된 사례와 같은 증상).
      const grantTypes = behavior.issueRefreshToken ? requested : requested.filter((g) => g !== 'refresh_token');
      prune();
      const clientId = track(`c_${randomToken(18)}`);
      clients.set(clientId, { redirectUris, grantTypes });
      return done(json(201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(now() / 1000),
        redirect_uris: redirectUris,
        grant_types: grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }), `client_id=${maskValue(clientId)}`);
    }

    // 인가 엔드포인트 — 연습용 서버라 로그인 화면 없이 바로 동의(자동 승인)한다.
    if (method === 'GET' && path === '/authorize') {
      const q = url.searchParams;
      const clientId = q.get('client_id') ?? '';
      const client = clients.get(clientId);
      const redirectUri = q.get('redirect_uri') ?? '';
      if (!client || !client.redirectUris.includes(redirectUri)) {
        // 등록되지 않은 리다이렉트로는 절대 보내지 않는다(오픈 리다이렉트 방지).
        return done(text(400, 'invalid client_id or redirect_uri'), `client_id=${maskValue(clientId)}`);
      }
      const back = new URL(redirectUri);
      const state = q.get('state');
      if (state !== null) back.searchParams.set('state', state);
      const challenge = q.get('code_challenge');
      if (q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256' || !challenge) {
        back.searchParams.set('error', 'invalid_request');
        back.searchParams.set('error_description', 'PKCE S256 is required');
      } else {
        prune();
        const code = track(`code_${randomToken(18)}`);
        codes.set(code, { clientId, redirectUri, challenge, resource: q.get('resource') ?? undefined, exp: now() + 60_000 });
        back.searchParams.set('code', code);
        back.searchParams.set('iss', base);
      }
      const res = new Response(null, { status: 302, headers: { location: back.toString(), 'cache-control': 'no-store' } });
      return done(res, `client_id=${maskValue(clientId)} (auto-approved, practice mock)`);
    }

    // 토큰 엔드포인트
    if (method === 'POST' && path === '/token') {
      const p = new URLSearchParams(await readText(req));
      const grant = p.get('grant_type') ?? '';
      const clientId = p.get('client_id') ?? '';
      const resource = p.get('resource') ?? undefined;
      const fail = (status: number, error: string, description?: string): Response =>
        done(json(status, { error, ...(description ? { error_description: description } : {}) }), `grant_type=${grant} error=${error}`);
      if (!clients.has(clientId)) return fail(401, 'invalid_client', 'unknown client');
      if (resource !== undefined && resource !== resourceId) return fail(400, 'invalid_target', 'unknown resource');

      if (grant === 'authorization_code') {
        const code = p.get('code') ?? '';
        const rec = codes.get(code);
        codes.delete(code); // 코드는 한 번만 쓸 수 있다
        if (!rec || rec.exp < now() || rec.clientId !== clientId) return fail(400, 'invalid_grant', 'unknown or expired code');
        if (rec.redirectUri !== p.get('redirect_uri')) return fail(400, 'invalid_grant', 'redirect_uri mismatch');
        if (challengeS256(p.get('code_verifier') ?? '') !== rec.challenge) return fail(400, 'invalid_grant', 'PKCE verification failed');
        const withRefresh = behavior.issueRefreshToken && (clients.get(clientId)?.grantTypes.includes('refresh_token') ?? false);
        const body = issueTokens(clientId, randomToken(8), resource ?? rec.resource, withRefresh);
        return done(json(200, body), `grant_type=authorization_code code=${maskValue(code)} issued access=${maskValue(String(body.access_token))}${body.refresh_token ? ` refresh=${maskValue(String(body.refresh_token))}` : ' (no refresh_token)'}`);
      }

      if (grant === 'refresh_token') {
        const presented = p.get('refresh_token') ?? '';
        const note = `grant_type=refresh_token refresh=${maskValue(presented)}`;
        if (behavior.refreshRequiresSecret) {
          // 코드 교환은 공개 클라이언트로 받아 줬으면서 갱신에서만 비밀을 요구한다.
          return done(json(401, { error: 'invalid_client', error_description: 'client authentication required' }, { 'www-authenticate': 'Basic realm="token"' }), `${note} error=invalid_client`);
        }
        if (behavior.requireResourceOnRefresh && resource === undefined) {
          return done(json(400, { error: 'invalid_target', error_description: 'resource parameter is required' }), `${note} error=invalid_target`);
        }
        const rec = refreshTokens.get(presented);
        if (!rec || rec.clientId !== clientId) return fail(400, 'invalid_grant', 'unknown refresh token');
        if (rec.used && behavior.detectReuse) {
          revokeFamily(rec.family); // 재사용 감지 → 가족 전체 폐기(OAuth 2.1 §4.3.1)
          return done(json(400, { error: 'invalid_grant', error_description: 'refresh token reuse detected' }), `${note} error=invalid_grant (reuse detected, family revoked)`);
        }
        if (behavior.rotate) {
          rec.used = true;
          const body = issueTokens(clientId, rec.family, resource ?? rec.resource, true);
          return done(json(200, body), `${note} issued access=${maskValue(String(body.access_token))} refresh=${maskValue(String(body.refresh_token))} (rotated)`);
        }
        // 회전 없음: 같은 갱신 토큰을 계속 쓰게 두고 새 갱신 토큰을 돌려주지 않는다.
        const body = issueTokens(clientId, rec.family, resource ?? rec.resource, false);
        return done(json(200, body), `${note} issued access=${maskValue(String(body.access_token))} (no rotation)`);
      }
      return fail(400, 'unsupported_grant_type');
    }

    // 보호된 MCP 엔드포인트(Streamable HTTP)
    if (path === mcpPath) {
      const header = req.headers.get('authorization') ?? '';
      const token = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : '';
      if (!token) {
        return done(json(401, { error: 'unauthorized' }, {
          'www-authenticate': `Bearer resource_metadata="${prmUrl}", scope="mcp:tools"`,
        }), 'no token');
      }
      const rec = accessTokens.get(token);
      const t = now();
      if (!rec || rec.exp < t || (rec.resource !== undefined && rec.resource !== resourceId)) {
        const why = !rec ? 'unknown token' : rec.exp < t ? 'token expired' : 'wrong audience';
        if (behavior.invalidTokenStatus === 403) {
          // 고장 재현: 만료·무효 토큰에 403 + WWW-Authenticate 없음 → 클라이언트가 갱신을 시작하지 않는다
          return done(json(403, { error: 'forbidden' }), `token=${maskValue(token)} (${why})`);
        }
        return done(json(401, { error: 'invalid_token' }, {
          'www-authenticate': `Bearer error="invalid_token", error_description="${why}", resource_metadata="${prmUrl}"`,
        }), `token=${maskValue(token)} (${why})`);
      }
      return handleMcp(req, done);
    }

    return done(json(404, { error: 'not_found' }));
  }

  // 최소한의 MCP 서버: initialize·ping·tools/list·tools/call(ping)
  async function handleMcp(req: Request, done: (res: Response, note?: string) => Response): Promise<Response> {
    const sessionId = req.headers.get('mcp-session-id') ?? undefined;
    if (req.method === 'DELETE') {
      if (sessionId) sessions.delete(sessionId);
      return done(new Response(null, { status: 200 }), 'session closed');
    }
    if (req.method !== 'POST') return done(new Response(null, { status: 405, headers: { allow: 'POST, DELETE' } }));
    const msg = asRecord(safeJson(await readText(req)));
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return done(json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } }), 'invalid json-rpc');
    }
    const id = msg.id;
    if (msg.method === 'initialize') {
      const params = asRecord(msg.params);
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      prune();
      const newSession = randomToken(12);
      sessions.add(newSession);
      return done(reply(id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-refresh-doctor-practice-mock', version: TOOL_VERSION },
      }, { 'mcp-session-id': newSession }), 'initialize');
    }
    // initialize 이후 요청은 세션 ID 를 이어 보내야 한다(Streamable HTTP).
    if (!sessionId) {
      return done(json(400, { jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' } }), `${msg.method} (missing session id)`);
    }
    if (!sessions.has(sessionId)) {
      return done(json(404, { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message: 'Session not found' } }), `${msg.method} (unknown session)`);
    }
    // 알림(notifications/initialized 등)은 본문 없이 202
    if (id === undefined) return done(new Response(null, { status: 202 }), msg.method);
    if (msg.method === 'tools/list') {
      return done(reply(id, {
        tools: [{ name: 'ping', description: 'Returns pong', inputSchema: { type: 'object', properties: {} } }],
      }), 'tools/list');
    }
    if (msg.method === 'tools/call') return done(reply(id, { content: [{ type: 'text', text: 'pong' }] }), 'tools/call');
    if (msg.method === 'ping') return done(reply(id, {}), 'ping');
    return done(json(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }), `${msg.method} (method not found)`);
  }

  function reply(id: unknown, result: unknown, headers: Record<string, string> = {}): Response {
    const message = JSON.stringify({ jsonrpc: '2.0', id, result });
    if (opts.mcpResponseMode === 'sse') {
      // SSE: 응답 전에 알림 이벤트를 하나 끼워 넣어, 클라이언트가 id 로 응답을 골라내는지도 시험한다.
      const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'practice mock' } });
      const body = `event: message\ndata: ${note}\n\nevent: message\nid: 1\ndata: ${message}\n\n`;
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers } });
    }
    return new Response(message, { status: 200, headers: { 'content-type': 'application/json', ...headers } });
  }

  return {
    base,
    mcpUrl: resourceId,
    issuedSecrets: issued,
    async handle(req) {
      try {
        return await route(req);
      } catch (err) {
        // 처리 중 예기치 못한 오류 — 서버가 죽지 않고 500 으로 답한다.
        log(`${req.method} ${new URL(req.url).pathname} -> 500 (${String(err)})`);
        return json(500, { error: 'server_error' });
      }
    },
  };
}

// ── 작은 도우미 ───────────────────────────────────────────────────────
async function readText(req: Request): Promise<string> {
  const body = await req.text();
  if (body.length > MAX_REQUEST_BODY) throw new Error('body too large');
  return body;
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });
}

function text(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}
