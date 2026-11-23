// e2e(실 소켓·자식 프로세스, `npm run test:e2e` 전용): 실제 check 의 루프백 콜백 서버.
//  - 콜백 서버를 닫으면 대기 중인 로그인이 "closed" 로 바로 끝난다(로그인 타이머가 남지 않음)
//  - --redirect-port 가 이미 쓰이는 중이면 판정 불가(login), 충돌하지 않는다
//  - 로그인이 오지 않으면 시간 초과 → 판정 불가(login)
//  - 자동 승인이 실패하면 CLI 프로세스가 로그인 대기(기본 300초) 없이 바로 끝난다
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { runChecks } from '../../src/checks.js';
import { startFakeServer } from '../../src/fake/server.js';
import { startCallbackServer } from '../../src/login.js';
import { decideVerdict } from '../../src/verdict.js';
import { cleanEnv, runCli } from './helpers.js';

test('closing the callback server ends a pending login wait as "closed", not as a timeout', async () => {
  const cb = await startCallbackServer(0, 'ok');
  const started = Date.now();
  const waiting = cb.waitForCode('state', 60_000);
  await cb.close();
  assert.deepEqual(await waiting, { ok: false, reason: 'closed' });
  assert.ok(Date.now() - started < 5_000, 'the 60 s login timer did not keep the wait alive');
});

test('busy --redirect-port → inconclusive at login, not a crash', async () => {
  const server = await startFakeServer({ preset: 'good' });
  const busy = createServer();
  await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
  try {
    const port = (busy.address() as { port: number }).port;
    const run = await runChecks({ url: server.mcpUrl, autoConsent: true, timeoutSec: 10, redirectPort: port });
    assert.equal(run.blocked?.detail, 'blocked.callback_port');
    assert.equal(decideVerdict(run).verdict, 'inconclusive');
  } finally {
    await new Promise<void>((r) => busy.close(() => r()));
    await server.close();
  }
});

test('login timeout on the real loopback callback → inconclusive', async () => {
  const server = await startFakeServer({ preset: 'good' });
  try {
    let shownUrl = '';
    const run = await runChecks({
      url: server.mcpUrl,
      openBrowser: false, // 브라우저를 열지 않으므로 콜백이 오지 않는다
      loginTimeoutSec: 0.3,
      timeoutSec: 10,
      progress: (e) => {
        if (e.type === 'login_url') shownUrl = e.url;
      },
    });
    assert.match(shownUrl, /\/authorize\?response_type=code/);
    assert.match(shownUrl, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fcallback/);
    assert.equal(run.blocked?.stage, 'login');
    assert.equal(run.blocked?.detail, 'blocked.login_timeout');
    assert.equal(decideVerdict(run).verdict, 'inconclusive');
  } finally {
    await server.close();
  }
});

test('auto-consent failure ends inconclusive and the CLI exits right away (no login timer left behind)', async () => {
  // authorize 가 리다이렉트 대신 200(로그인 화면)을 주는 서버 — 자동 승인이 실패한다.
  let base = '';
  const s = createServer((req, res) => {
    const send = (code: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    const path = (req.url ?? '').split('?')[0];
    if (path === '/mcp') return send(401, {}, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
    if (path === '/.well-known/oauth-protected-resource/mcp') return send(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (path === '/.well-known/oauth-authorization-server') {
      return send(200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`, grant_types_supported: ['authorization_code', 'refresh_token'],
      });
    }
    if (path === '/register') return send(201, { client_id: 'c_login_page_client', token_endpoint_auth_method: 'none' });
    if (path === '/authorize') return send(200, { page: 'login' });
    return send(404, {});
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  try {
    // 로그인 대기 기본값은 300초다. 타이머가 남으면 자식 프로세스가 끝나지 않아 60초 감시에 걸린다.
    const r = await runCli(['check', `${base}/mcp`, '--auto-consent', '--json'], cleanEnv({ LANG: 'en_US.UTF-8' }), 60_000);
    assert.equal(r.code, 2, r.stderr);
    const report = JSON.parse(r.stdout) as { verdict: { verdict: string }; blocked?: { stage: string; detail: string } };
    assert.equal(report.verdict.verdict, 'inconclusive');
    assert.equal(report.blocked?.stage, 'login');
    assert.match(report.blocked?.detail ?? '', /no_redirect_200/);
  } finally {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});
