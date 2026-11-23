// 연습용 목(mock) 서버: 인가 서버(AS) + 보호된 MCP 서버를 한 포트에 띄운다.
// 고정된 가짜 응답이 아니라 실제 OAuth 2.1 흐름을 수행한다 —
// DCR 등록, PKCE S256 검증, 코드 1회 사용, 갱신·회전·재사용 감지(가족 폐기), 토큰 만료.
// 프리셋은 그 흐름의 한 지점을 일부러 고장 낸다(presets.ts).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { maskValue } from '../mask.js';
import { challengeS256, randomToken } from '../pkce.js';
import { TOOL_VERSION } from '../types.js';
import { PRESETS, type PresetName } from './presets.js';

export interface FakeServerOptions {
  preset: PresetName;
  port?: number;
  /** 액세스 토큰 수명(초) */
  ttlSec?: number;
  /** MCP 응답 형식: JSON(기본) 또는 SSE 스트림 */
  mcpResponseMode?: 'json' | 'sse';
  /** 요청 로그 한 줄씩(토큰은 가린 형태로만 전달된다) */
  log?: (line: string) => void;
  /** 시험용: 발급한 비밀 값 원문을 모아 둔다(가림 검사용). 기본 꺼짐 */
  trackSecrets?: boolean;
  /**
   * 시험용 고장 주입: true 를 돌려준 요청은 응답 없이 연결을 끊는다(네트워크 오류 재현).
   * n 은 같은 "메서드 경로" 요청의 순번(1부터). 기본 없음.
   */
  dropConnection?: (request: { method: string; path: string; n: number }) => boolean;
}

export interface FakeServer {
  base: string;
  mcpUrl: string;
  /** trackSecrets 일 때 발급한 client_id·code·토큰 원문 */
  issuedSecrets: ReadonlySet<string>;
  close(): Promise<void>;
}

interface AccessRecord { exp: number; clientId: string; family: string; resource: string | undefined }
interface RefreshRecord { clientId: string; family: string; used: boolean; resource: string | undefined }
interface CodeRecord { clientId: string; redirectUri: string; challenge: string; resource: string | undefined; exp: number }

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
// 오래 켜 둔 serve 에서도 메모리가 끝없이 늘지 않도록 상한을 둔다.
const MAX_ENTRIES = 5000;

export async function startFakeServer(opts: FakeServerOptions): Promise<FakeServer> {
  const behavior = PRESETS[opts.preset].behavior;
  const ttlMs = (opts.ttlSec ?? 3600) * 1000;
  const log = opts.log ?? ((): void => undefined);
  const issued = new Set<string>();

  const clients = new Map<string, { redirectUris: string[]; grantTypes: string[] }>();
  const codes = new Map<string, CodeRecord>();
  const accessTokens = new Map<string, AccessRecord>();
  const refreshTokens = new Map<string, RefreshRecord>();
  const sessions = new Set<string>();
  // dropConnection 을 쓸 때만 채운다(키 = "메서드 경로", 시험용이라 경로 수만큼만 생긴다)
  const requestCounts = new Map<string, number>();

  let base = '';
  const mcpPath = '/mcp';
  const resourceId = (): string => base + mcpPath;
  const prmUrl = (): string => `${base}/.well-known/oauth-protected-resource${mcpPath}`;

  const track = (value: string): string => {
    if (opts.trackSecrets) issued.add(value);
    return value;
  };

  // ── 토큰 발급 ───────────────────────────────────────────────────────
  const issueTokens = (clientId: string, family: string, resource: string | undefined, withRefresh: boolean): Record<string, unknown> => {
    prune();
    const access = track(`at_${randomToken(24)}`);
    accessTokens.set(access, { exp: Date.now() + ttlMs, clientId, family, resource });
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
    const now = Date.now();
    for (const [k, v] of accessTokens) if (v.exp < now) accessTokens.delete(k);
    for (const [k, v] of codes) if (v.exp < now) codes.delete(k);
    for (const map of [clients, codes, accessTokens, refreshTokens] as Map<string, unknown>[]) {
      // Map 은 넣은 순서를 기억하므로 가장 오래된 것부터 지운다.
      while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value as string);
    }
    while (sessions.size > MAX_ENTRIES) sessions.delete(sessions.values().next().value as string);
  };

  // ── 요청 처리 ───────────────────────────────────────────────────────
  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      log(`${req.method ?? '?'} ${req.url?.split('?')[0] ?? ''} -> 500 (${String(err)})`);
      if (!res.headersSent) sendJson(res, 500, { error: 'server_error' });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', base);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const done = (status: number, note = ''): void => log(`${method} ${path}${note ? ' ' + note : ''} -> ${status}`);

    // 시험용 고장 주입(dropConnection): 응답 없이 연결을 끊어 클라이언트가 네트워크 오류를 겪게 한다.
    if (opts.dropConnection) {
      const key = `${method} ${path}`;
      const n = (requestCounts.get(key) ?? 0) + 1;
      requestCounts.set(key, n);
      if (opts.dropConnection({ method, path, n })) {
        log(`${method} ${path} -> connection dropped (test fault)`);
        req.socket.destroy();
        return;
      }
    }

    // 보호 자원 메타데이터(RFC 9728)
    if (method === 'GET' && (path === `/.well-known/oauth-protected-resource${mcpPath}` || path === '/.well-known/oauth-protected-resource')) {
      sendJson(res, 200, {
        resource: resourceId(),
        authorization_servers: [base],
        scopes_supported: ['mcp:tools'], // SEP-2207: offline_access 는 여기 넣지 않는다
        bearer_methods_supported: ['header'],
      });
      return done(200);
    }

    // 인가 서버 메타데이터(RFC 8414)
    if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      sendJson(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: behavior.issueRefreshToken ? ['authorization_code', 'refresh_token'] : ['authorization_code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp:tools', 'offline_access'],
      });
      return done(200);
    }

    // 동적 클라이언트 등록(RFC 7591)
    if (method === 'POST' && path === '/register') {
      const meta = asRecord(safeJson(await readBody(req)));
      const redirectUris = Array.isArray(meta?.redirect_uris) ? meta.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
      if (redirectUris.length === 0) {
        sendJson(res, 400, { error: 'invalid_redirect_uri' });
        return done(400);
      }
      const requested = Array.isArray(meta?.grant_types) ? meta.grant_types.filter((g): g is string => typeof g === 'string') : ['authorization_code'];
      // 갱신 토큰을 안 주는 서버는 등록 응답에서도 refresh_token 을 빼 버린다(보고된 사례와 같은 증상).
      const grantTypes = behavior.issueRefreshToken ? requested : requested.filter((g) => g !== 'refresh_token');
      prune();
      const clientId = track(`c_${randomToken(18)}`);
      clients.set(clientId, { redirectUris, grantTypes });
      sendJson(res, 201, {
        client_id: clientId,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        redirect_uris: redirectUris,
        grant_types: grantTypes,
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      });
      return done(201, `client_id=${maskValue(clientId)}`);
    }

    // 인가 엔드포인트 — 연습용 서버라 로그인 화면 없이 바로 동의(자동 승인)한다.
    if (method === 'GET' && path === '/authorize') {
      const q = url.searchParams;
      const clientId = q.get('client_id') ?? '';
      const client = clients.get(clientId);
      const redirectUri = q.get('redirect_uri') ?? '';
      if (!client || !client.redirectUris.includes(redirectUri)) {
        // 등록되지 않은 리다이렉트로는 절대 보내지 않는다(오픈 리다이렉트 방지).
        sendText(res, 400, 'invalid client_id or redirect_uri');
        return done(400, `client_id=${maskValue(clientId)}`);
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
        codes.set(code, { clientId, redirectUri, challenge, resource: q.get('resource') ?? undefined, exp: Date.now() + 60_000 });
        back.searchParams.set('code', code);
        back.searchParams.set('iss', base);
      }
      res.writeHead(302, { location: back.toString(), 'cache-control': 'no-store' });
      res.end();
      return done(302, `client_id=${maskValue(clientId)} (auto-approved, practice mock)`);
    }

    // 토큰 엔드포인트
    if (method === 'POST' && path === '/token') {
      const p = new URLSearchParams(await readBody(req));
      const grant = p.get('grant_type') ?? '';
      const clientId = p.get('client_id') ?? '';
      const resource = p.get('resource') ?? undefined;
      const fail = (status: number, error: string, description?: string): void => {
        sendJson(res, status, { error, ...(description ? { error_description: description } : {}) });
        done(status, `grant_type=${grant} error=${error}`);
      };
      if (!clients.has(clientId)) return fail(401, 'invalid_client', 'unknown client');
      if (resource !== undefined && resource !== resourceId()) return fail(400, 'invalid_target', 'unknown resource');

      if (grant === 'authorization_code') {
        const code = p.get('code') ?? '';
        const rec = codes.get(code);
        codes.delete(code); // 코드는 한 번만 쓸 수 있다
        if (!rec || rec.exp < Date.now() || rec.clientId !== clientId) return fail(400, 'invalid_grant', 'unknown or expired code');
        if (rec.redirectUri !== p.get('redirect_uri')) return fail(400, 'invalid_grant', 'redirect_uri mismatch');
        if (challengeS256(p.get('code_verifier') ?? '') !== rec.challenge) return fail(400, 'invalid_grant', 'PKCE verification failed');
        const withRefresh = behavior.issueRefreshToken && (clients.get(clientId)?.grantTypes.includes('refresh_token') ?? false);
        const body = issueTokens(clientId, randomToken(8), resource ?? rec.resource, withRefresh);
        sendJson(res, 200, body);
        return done(200, `grant_type=authorization_code code=${maskValue(code)} issued access=${maskValue(String(body.access_token))}${body.refresh_token ? ` refresh=${maskValue(String(body.refresh_token))}` : ' (no refresh_token)'}`);
      }

      if (grant === 'refresh_token') {
        const presented = p.get('refresh_token') ?? '';
        const note = `grant_type=refresh_token refresh=${maskValue(presented)}`;
        if (behavior.refreshRequiresSecret) {
          // 코드 교환은 공개 클라이언트로 받아 줬으면서 갱신에서만 비밀을 요구한다.
          sendJson(res, 401, { error: 'invalid_client', error_description: 'client authentication required' }, { 'www-authenticate': 'Basic realm="token"' });
          return done(401, `${note} error=invalid_client`);
        }
        if (behavior.requireResourceOnRefresh && resource === undefined) {
          sendJson(res, 400, { error: 'invalid_target', error_description: 'resource parameter is required' });
          return done(400, `${note} error=invalid_target`);
        }
        const rec = refreshTokens.get(presented);
        if (!rec || rec.clientId !== clientId) return fail(400, 'invalid_grant', 'unknown refresh token');
        if (rec.used) {
          if (behavior.detectReuse) {
            revokeFamily(rec.family); // 재사용 감지 → 가족 전체 폐기(OAuth 2.1 §4.3.1)
            sendJson(res, 400, { error: 'invalid_grant', error_description: 'refresh token reuse detected' });
            return done(400, `${note} error=invalid_grant (reuse detected, family revoked)`);
          }
        }
        if (behavior.rotate) {
          rec.used = true;
          const body = issueTokens(clientId, rec.family, resource ?? rec.resource, true);
          sendJson(res, 200, body);
          return done(200, `${note} issued access=${maskValue(String(body.access_token))} refresh=${maskValue(String(body.refresh_token))} (rotated)`);
        }
        // 회전 없음: 같은 갱신 토큰을 계속 쓰게 두고 새 갱신 토큰을 돌려주지 않는다.
        const body = issueTokens(clientId, rec.family, resource ?? rec.resource, false);
        sendJson(res, 200, body);
        return done(200, `${note} issued access=${maskValue(String(body.access_token))} (no rotation)`);
      }
      return fail(400, 'unsupported_grant_type');
    }

    // 보호된 MCP 엔드포인트(Streamable HTTP)
    if (path === mcpPath) {
      const header = req.headers.authorization ?? '';
      const token = /^Bearer\s+/i.test(header) ? header.replace(/^Bearer\s+/i, '') : '';
      if (!token) {
        await drain(req);
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': `Bearer resource_metadata="${prmUrl()}", scope="mcp:tools"`,
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return done(401, 'no token');
      }
      const rec = accessTokens.get(token);
      if (!rec || rec.exp < Date.now() || (rec.resource !== undefined && rec.resource !== resourceId())) {
        await drain(req);
        const why = !rec ? 'unknown token' : rec.exp < Date.now() ? 'token expired' : 'wrong audience';
        if (behavior.invalidTokenStatus === 403) {
          // 고장 재현: 만료·무효 토큰에 403 + WWW-Authenticate 없음 → 클라이언트가 갱신을 시작하지 않는다
          sendJson(res, 403, { error: 'forbidden' });
          return done(403, `token=${maskValue(token)} (${why})`);
        }
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': `Bearer error="invalid_token", error_description="${why}", resource_metadata="${prmUrl()}"`,
        });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return done(401, `token=${maskValue(token)} (${why})`);
      }
      return handleMcp(req, res, method, done);
    }

    await drain(req);
    sendJson(res, 404, { error: 'not_found' });
    return done(404);
  }

  // 최소한의 MCP 서버: initialize·ping·tools/list·tools/call(ping)
  async function handleMcp(req: IncomingMessage, res: ServerResponse, method: string, done: (s: number, n?: string) => void): Promise<void> {
    const sessionHeader = req.headers['mcp-session-id'];
    const sessionId = typeof sessionHeader === 'string' ? sessionHeader : undefined;
    if (method === 'DELETE') {
      if (sessionId) sessions.delete(sessionId);
      res.writeHead(200).end();
      return done(200, 'session closed');
    }
    if (method !== 'POST') {
      res.writeHead(405, { allow: 'POST, DELETE' }).end();
      return done(405);
    }
    const msg = asRecord(safeJson(await readBody(req)));
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return done(400, 'invalid json-rpc');
    }
    const id = msg.id;
    if (msg.method === 'initialize') {
      const params = asRecord(msg.params);
      const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : SUPPORTED_VERSIONS[0];
      prune();
      const newSession = randomToken(12);
      sessions.add(newSession);
      reply(res, id, {
        protocolVersion: version,
        capabilities: { tools: {} },
        serverInfo: { name: 'mcp-refresh-doctor-practice-mock', version: TOOL_VERSION },
      }, { 'mcp-session-id': newSession });
      return done(200, 'initialize');
    }
    // initialize 이후 요청은 세션 ID 를 이어 보내야 한다(Streamable HTTP).
    if (!sessionId) {
      sendJson(res, 400, { jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required' } });
      return done(400, `${msg.method} (missing session id)`);
    }
    if (!sessions.has(sessionId)) {
      sendJson(res, 404, { jsonrpc: '2.0', id: id ?? null, error: { code: -32001, message: 'Session not found' } });
      return done(404, `${msg.method} (unknown session)`);
    }
    if (id === undefined) {
      // 알림(notifications/initialized 등)은 본문 없이 202
      res.writeHead(202).end();
      return done(202, msg.method);
    }
    if (msg.method === 'tools/list') {
      reply(res, id, {
        tools: [{ name: 'ping', description: 'Returns pong', inputSchema: { type: 'object', properties: {} } }],
      });
      return done(200, 'tools/list');
    }
    if (msg.method === 'tools/call') {
      reply(res, id, { content: [{ type: 'text', text: 'pong' }] });
      return done(200, 'tools/call');
    }
    if (msg.method === 'ping') {
      reply(res, id, {});
      return done(200, 'ping');
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    return done(200, `${msg.method} (method not found)`);
  }

  function reply(res: ServerResponse, id: unknown, result: unknown, headers: Record<string, string> = {}): void {
    const message = JSON.stringify({ jsonrpc: '2.0', id, result });
    if (opts.mcpResponseMode === 'sse') {
      // SSE: 응답 전에 알림 이벤트를 하나 끼워 넣어, 클라이언트가 id 로 응답을 골라내는지도 시험한다.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...headers });
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info', data: 'practice mock' } })}\n\n`);
      res.write(`event: message\nid: 1\ndata: ${message}\n\n`);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json', ...headers });
    res.end(message);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  base = `http://127.0.0.1:${port}`;

  return {
    base,
    mcpUrl: resourceId(),
    issuedSecrets: issued,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// ── 작은 도우미 ───────────────────────────────────────────────────────
const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > MAX_BODY) req.destroy(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

async function drain(req: IncomingMessage): Promise<void> {
  await readBody(req).catch(() => '');
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(text);
}
