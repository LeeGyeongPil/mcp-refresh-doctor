// 단위·in-process 시험 공용 도우미 — 소켓·자식 프로세스·실시간 대기를 쓰지 않는다.
//  - inProcess(): 프리셋 목 handler + 수동 시계 + in-process 전송 한 벌
//  - runMain()  : CLI 입구 main() 을 같은 프로세스에서 부르고 표준 출력·오류를 모은다
//  - obtainAccessToken(): 목 서버에서 DCR → authorize → 코드 교환으로 액세스 토큰을 얻는다
import { createHash } from 'node:crypto';
import { main, type Io, type MainDeps } from '../src/cli.js';
import { createFakeHandler, type FakeHandler } from '../src/fake/handler.js';
import {
  createInProcessTransport, createManualClock, type Fault, type FaultRequest, type InProcessTransport, type Route,
} from '../src/fake/inprocess.js';
import type { PresetName } from '../src/fake/presets.js';

/** 언어 관련 환경 변수를 지운 깨끗한 환경 + 덮어쓸 값 */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['LANG', 'LC_ALL', 'LC_MESSAGES', 'MCP_REFRESH_DOCTOR_LANG']) delete env[k];
  return { ...env, ...extra };
}

export interface MainResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** main(argv, env, io) 를 같은 프로세스에서 실행한다(자식 프로세스 없음) */
export async function runMain(args: string[], env: NodeJS.ProcessEnv = cleanEnv(), deps: MainDeps = {}): Promise<MainResult> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (text) => out.push(text), err: (text) => err.push(text) };
  const code = await main(args, env, io, deps);
  return { code, stdout: out.length ? out.join('\n') + '\n' : '', stderr: err.length ? err.join('\n') + '\n' : '' };
}

export interface InProcessSetup {
  fake: FakeHandler;
  transport: InProcessTransport;
  /** 목 서버 요청 로그(토큰은 가려진 형태) */
  log: string[];
}

export function inProcess(
  preset: PresetName,
  opts: {
    ttlSec?: number;
    mcpResponseMode?: 'json' | 'sse';
    trackSecrets?: boolean;
    faults?: (req: FaultRequest) => Fault | undefined;
    wrap?: (handle: Route) => Route;
  } = {},
): InProcessSetup {
  const clock = createManualClock();
  const log: string[] = [];
  const fake = createFakeHandler({
    preset,
    now: clock.now,
    log: (line) => log.push(line),
    ...(opts.ttlSec !== undefined ? { ttlSec: opts.ttlSec } : {}),
    ...(opts.mcpResponseMode ? { mcpResponseMode: opts.mcpResponseMode } : {}),
    ...(opts.trackSecrets ? { trackSecrets: true } : {}),
  });
  const handle: Route = (req) => fake.handle(req);
  const transport = createInProcessTransport({
    routes: { [fake.base]: opts.wrap ? opts.wrap(handle) : handle },
    clock,
    ...(opts.faults ? { faults: opts.faults } : {}),
  });
  return { fake, transport, log };
}

/** 목 서버에서 DCR → authorize(자동 승인) → 코드 교환까지 해 액세스 토큰을 얻는다 */
export async function obtainAccessToken(transport: InProcessTransport, base: string): Promise<string> {
  const redirectUri = 'http://127.0.0.1:9/callback'; // 실제로 열지 않는다(Location 만 읽음)
  const reg = (await (await transport.fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' }),
  })).json()) as { client_id: string };
  const verifier = 'v'.repeat(43);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state: 's',
  }).toString();
  const location = (await transport.fetch(authorize.toString(), { redirect: 'manual' })).headers.get('location') ?? '';
  const code = new URL(location).searchParams.get('code') ?? '';
  const tok = (await (await transport.fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier }).toString(),
  })).json()) as { access_token: string };
  return tok.access_token;
}

/** 지정한 경로·메서드 요청만 다른 응답으로 바꾸는 wrap 을 만든다(나머지는 목 handler 그대로) */
export function override(method: string, path: string, respond: (req: Request) => Response | Promise<Response>): (handle: Route) => Route {
  return (handle) => async (req) => {
    const url = new URL(req.url);
    if (req.method === method && url.pathname === path) return respond(req);
    return handle(req);
  };
}
