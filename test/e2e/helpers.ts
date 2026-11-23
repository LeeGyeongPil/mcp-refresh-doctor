// e2e 시험 도우미(실 소켓·자식 프로세스): CLI 를 자식 프로세스로 실행하고, serve 를 띄웠다가 확실히 닫는다.
// `npm run test:e2e` 에서만 쓰인다(CI 비대상). 단위 시험은 ../helpers.ts 의 in-process 도우미를 쓴다.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from '../helpers.js';

export { cleanEnv };

// dist-test/test/e2e/helpers.js → dist-test/src/cli.js
export const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runCli(args: string[], env: NodeJS.ProcessEnv = cleanEnv(), timeoutMs = 60_000): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`cli timed out: ${args.join(' ')}\n${stderr}`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export interface Served {
  url: string;
  child: ChildProcessWithoutNullStreams;
  log: () => string;
  /**
   * serve 로그에 pattern 이 나타날 때까지 기다린다(최대 timeoutMs).
   * serve 는 응답을 보낸 "뒤" 로그 줄을 쓰고, 그 줄은 다른 프로세스의 파이프를 거쳐 온다.
   * 시간이 지나도 없으면 그때까지의 로그를 돌려준다(단언이 실패하며 로그를 보여 준다).
   */
  waitForLog: (pattern: RegExp, timeoutMs?: number) => Promise<string>;
  /** SIGTERM 으로 끄고 종료 코드를 돌려준다(10초 안에 안 끝나면 SIGKILL 후 null) */
  stop: () => Promise<number | null>;
}

/** `serve` 를 별도 프로세스(--port 0)로 띄우고 MCP 주소가 출력될 때까지 기다린다 */
export function startServe(preset: string, ttl: number, startTimeoutMs = 60_000): Promise<Served> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--preset', preset, '--port', '0', '--ttl', String(ttl), '--lang', 'en'], {
      env: cleanEnv(),
    });
    let out = '';
    let resolved = false;
    const waiters = new Set<() => void>();
    const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    // 시작이 끝없이 늦어지면 시험이 매달리지 않고 실패하게 한다.
    const startTimer = setTimeout(() => {
      if (resolved) return;
      child.kill('SIGKILL');
      reject(new Error(`serve did not start within ${startTimeoutMs}ms: ${out}`));
    }, startTimeoutMs);
    const onOutput = (d: Buffer): void => {
      out += d.toString();
      for (const wake of waiters) wake();
      const m = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(out);
      if (m && !resolved) {
        resolved = true;
        clearTimeout(startTimer);
        resolve({
          url: m[0],
          child,
          log: () => out,
          waitForLog: (pattern, timeoutMs = 10_000) =>
            new Promise<string>((done) => {
              if (pattern.test(out)) return done(out);
              const finish = (): void => {
                clearTimeout(timer);
                waiters.delete(check);
                done(out);
              };
              const check = (): void => {
                if (pattern.test(out)) finish();
              };
              const timer = setTimeout(finish, timeoutMs);
              waiters.add(check);
            }),
          stop: async () => {
            child.kill('SIGTERM');
            let killTimer: NodeJS.Timeout | undefined;
            const forced = new Promise<null>((r) => {
              killTimer = setTimeout(() => {
                child.kill('SIGKILL');
                r(null);
              }, 10_000);
            });
            try {
              return await Promise.race([exited, forced]);
            } finally {
              clearTimeout(killTimer);
            }
          },
        });
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('error', (err) => {
      clearTimeout(startTimer);
      reject(err);
    });
    void exited.then((code) => {
      clearTimeout(startTimer);
      if (!resolved) reject(new Error(`serve exited early (${code}): ${out}`));
    });
  });
}

/** 실제 HTTP 로 연 목 서버에서 DCR → authorize(자동 승인) → 코드 교환까지 해 액세스 토큰을 얻는다 */
export async function obtainAccessTokenHttp(base: string): Promise<string> {
  const redirectUri = 'http://127.0.0.1:9/callback'; // 실제로 열지 않는다(Location 만 읽음)
  const reg = (await (await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' }),
  })).json()) as { client_id: string };
  const verifier = 'v'.repeat(43);
  const { createHash } = await import('node:crypto');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(`${base}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', state: 's',
  }).toString();
  const location = (await fetch(authorize, { redirect: 'manual' })).headers.get('location') ?? '';
  const code = new URL(location).searchParams.get('code') ?? '';
  const tok = (await (await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier }).toString(),
  })).json()) as { access_token: string };
  return tok.access_token;
}
