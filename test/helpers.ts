// 테스트 공용 도우미: CLI 를 자식 프로세스로 실행하고, serve 서버를 띄웠다가 확실히 닫는다.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));

/** 언어 관련 환경 변수를 지운 깨끗한 환경 + 덮어쓸 값 */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of ['LANG', 'LC_ALL', 'LC_MESSAGES', 'MCP_REFRESH_DOCTOR_LANG']) delete env[k];
  return { ...env, ...extra };
}

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
  /** SIGTERM 으로 끄고 종료 코드를 돌려준다 */
  stop: () => Promise<number | null>;
}

/** `serve` 를 별도 프로세스로 띄우고 MCP 주소가 출력될 때까지 기다린다 */
export function startServe(preset: string, ttl: number): Promise<Served> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, 'serve', '--preset', preset, '--port', '0', '--ttl', String(ttl), '--lang', 'en'], {
      env: cleanEnv(),
    });
    let out = '';
    let resolved = false;
    const exited = new Promise<number | null>((r) => child.on('close', (code) => r(code)));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const m = /http:\/\/127\.0\.0\.1:\d+\/mcp/.exec(out);
      if (m && !resolved) {
        resolved = true;
        resolve({
          url: m[0],
          child,
          log: () => out,
          stop: async () => {
            child.kill('SIGTERM');
            return exited;
          },
        });
      }
    });
    child.on('error', reject);
    void exited.then((code) => {
      if (!resolved) reject(new Error(`serve exited early (${code}): ${out}`));
    });
  });
}

/** 연습용 서버에서 DCR → authorize(자동 승인) → 코드 교환까지 해 액세스 토큰을 얻는다 */
export async function obtainAccessToken(base: string): Promise<string> {
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
