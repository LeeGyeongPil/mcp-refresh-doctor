// 브라우저 로그인 1회: 127.0.0.1 루프백 콜백 서버로 인가 코드를 받는다(RFC 8252 §7.3).
// --auto-consent 는 브라우저 대신 authorize 주소의 리다이렉트를 직접 따라간다(루프백 시험 서버 전용).
// in-process 전송(callback: 'capture')에서는 콜백 서버를 열지 않고 리다이렉트 주소에서 code 를 바로 읽는다.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { isLoopbackHost, request } from './http.js';
import { realTransport, type Transport } from './transport.js';

export type LoginOutcome =
  | { ok: true; code: string; iss?: string }
  | { ok: false; reason: 'timeout' | 'closed' | 'denied' | 'state_mismatch' | 'no_code'; error?: string };

/**
 * 콜백 주소의 쿼리(?code=…&state=…&iss=… 또는 ?error=…)를 로그인 결과로 바꾼다.
 * 루프백 콜백 서버와 capture 경로가 같은 규칙을 쓰도록 한 곳에 둔다.
 */
export function parseCallback(params: URLSearchParams, state: string): LoginOutcome {
  if (params.get('error')) return { ok: false, reason: 'denied', error: params.get('error') ?? '' };
  if (params.get('state') !== state) return { ok: false, reason: 'state_mismatch' };
  const code = params.get('code');
  if (!code) return { ok: false, reason: 'no_code' };
  const iss = params.get('iss');
  return iss ? { ok: true, code, iss } : { ok: true, code };
}

export interface CallbackServer {
  redirectUri: string;
  /** state 가 맞는 콜백이 올 때까지(또는 시간 초과까지) 기다린다 */
  waitForCode(state: string, timeoutMs: number): Promise<LoginOutcome>;
  close(): Promise<void>;
}

export async function startCallbackServer(port: number, pageText: string): Promise<CallbackServer> {
  let deliver: ((params: URLSearchParams) => void) | undefined;
  const received = new Promise<URLSearchParams>((resolve) => {
    deliver = resolve;
  });
  // close() 가 불리면 기다리던 waitForCode 를 바로 끝낸다.
  // (자동 승인 실패처럼 대기 중에 일찍 끝나는 경로에서 로그인 타이머가 남아
  //  프로세스가 로그인 대기 시간(기본 300초)만큼 종료되지 않던 문제를 막는다)
  let stopWaiting: (() => void) | undefined;
  const stopped = new Promise<'stopped'>((resolve) => {
    stopWaiting = () => resolve('stopped');
  });

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(pageText);
    deliver?.(url.searchParams); // 처음 온 콜백만 쓰인다(Promise 는 한 번만 풀린다)
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    redirectUri: `http://127.0.0.1:${actualPort}/callback`,
    async waitForCode(state, timeoutMs) {
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      try {
        const got = await Promise.race([received, timeout, stopped]);
        if (got === 'timeout') return { ok: false, reason: 'timeout' };
        // close() 로 대기를 멈춘 경우 — 시간 초과와 구분해 "로그인 시간 초과"라는 틀린 문구가 나오지 않게 한다.
        if (got === 'stopped') return { ok: false, reason: 'closed' };
        return parseCallback(got, state);
      } finally {
        clearTimeout(timer); // 타이머가 남아 프로세스 종료를 막지 않게
      }
    },
    async close() {
      stopWaiting?.(); // 대기 타이머를 풀어 이벤트 루프에 남지 않게 한다
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function buildAuthorizeUrl(endpoint: string, p: {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  scope?: string;
  resource: string;
}): string {
  const u = new URL(endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', p.state);
  if (p.scope) u.searchParams.set('scope', p.scope);
  u.searchParams.set('resource', p.resource); // RFC 8707 — MCP 명세는 authorize·token 요청 모두에 요구
  return u.toString();
}

/**
 * 브라우저 없이 authorize 리다이렉트를 따라가 콜백 주소까지 도달시킨다.
 * 루프백 시험 서버(serve·demo)처럼 로그인 화면 없이 바로 302 를 주는 서버에서만 쓸 수 있다.
 * - loopback 전송: 콜백 서버를 실제로 두드려 브라우저 경로와 같은 코드 수신 경로를 탄다.
 * - capture 전송: 콜백 주소를 두드리지 않고 그대로 돌려준다(호출한 쪽이 parseCallback 으로 읽는다).
 */
export async function followAutoConsent(
  authorizeUrl: string,
  redirectUri: string,
  timeoutMs: number,
  transport: Transport = realTransport,
): Promise<{ ok: true; callbackUrl: string } | { ok: false; error: string }> {
  let url = authorizeUrl;
  for (let hop = 0; hop < 5; hop++) {
    if (!isLoopbackHost(new URL(url).hostname)) return { ok: false, error: 'non_loopback' };
    const res = await request(url, { timeoutMs, redirect: 'manual', transport });
    if (!res.reached) return { ok: false, error: res.error ?? 'network' };
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location) {
      return { ok: false, error: `no_redirect_${res.status}` };
    }
    url = new URL(location, url).toString();
    if (url.startsWith(redirectUri)) {
      if (transport.callback === 'capture') return { ok: true, callbackUrl: url };
      const cb = await request(url, { timeoutMs, transport });
      return cb.reached ? { ok: true, callbackUrl: url } : { ok: false, error: cb.error ?? 'network' };
    }
  }
  return { ok: false, error: 'too_many_redirects' };
}

/** OS 기본 브라우저로 연다. 실패해도 조용히 넘어간다(주소는 항상 화면에 따로 출력한다). */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // 헤드리스 환경 등 — 사용자가 출력된 주소를 직접 연다.
  }
}
