// AC-3: 판정 규칙표가 결정적이고, 진행 불가(발견 네트워크 오류·DCR 실패·로그인 시간 초과)는 inconclusive.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { runChecks } from '../src/checks.js';
import { startFakeServer } from '../src/fake/server.js';
import { startCallbackServer } from '../src/login.js';
import { CHECK_IDS, type Blocked, type CheckId, type CheckResult, type Status } from '../src/types.js';
import { SERVER_DECISIVE, decideVerdict } from '../src/verdict.js';
import { cleanEnv, runCli } from './helpers.js';

function checks(overrides: Partial<Record<CheckId, Status>>, hints: Partial<Record<CheckId, string>> = {}): CheckResult[] {
  return CHECK_IDS.map((id) => ({
    id,
    status: overrides[id] ?? 'PASS',
    detail: 'x',
    ...(hints[id] ? { hint: hints[id] } : {}),
  }));
}

test('rule table', async (t) => {
  await t.test('all PASS → client, exit 0, client-side hint', () => {
    const v = decideVerdict({ checks: checks({}) });
    assert.equal(v.verdict, 'client');
    assert.equal(v.exitCode, 0);
    assert.deepEqual(v.fixes, ['hint.client_side']);
  });

  await t.test('WARN only → client, exit 0, WARN ids are listed as reasons', () => {
    const v = decideVerdict({ checks: checks({ C07: 'WARN', C11: 'WARN', C14: 'SKIP' }, { C11: 'hint.c11_rotate' }) });
    assert.equal(v.verdict, 'client');
    assert.equal(v.exitCode, 0);
    assert.deepEqual(v.reasons, ['C07', 'C11']);
    assert.deepEqual(v.fixes, ['hint.c11_rotate', 'hint.client_side']);
  });

  await t.test('each decisive FAIL alone → server, exit 1', () => {
    for (const id of SERVER_DECISIVE) {
      const v = decideVerdict({ checks: checks({ [id]: 'FAIL' }) });
      assert.equal(v.verdict, 'server', id);
      assert.equal(v.exitCode, 1, id);
      assert.deepEqual(v.reasons, [id]);
    }
  });

  await t.test('non-decisive FAIL (C10) without a block → client', () => {
    assert.equal(decideVerdict({ checks: checks({ C10: 'FAIL' }) }).verdict, 'client');
  });

  await t.test('blocked without decisive FAIL → inconclusive, exit 2', () => {
    for (const stage of ['discovery', 'registration', 'login'] as const) {
      const blocked: Blocked = { stage, detail: 'blocked.x' };
      const v = decideVerdict({ checks: checks({ C05: 'FAIL' }), blocked });
      assert.equal(v.verdict, 'inconclusive');
      assert.equal(v.exitCode, 2);
      assert.ok(v.fixes.includes(`hint.blocked.${stage}`));
    }
  });

  await t.test('decisive FAIL wins over a later block (proven server defect stays proven)', () => {
    const v = decideVerdict({ checks: checks({ C03: 'FAIL' }), blocked: { stage: 'login', detail: 'blocked.login_timeout' } });
    assert.equal(v.verdict, 'server');
  });

  await t.test('same input → same output', () => {
    const input = { checks: checks({ C09: 'FAIL', C11: 'WARN' }, { C09: 'hint.token.invalid_client', C11: 'hint.c11_rotate' }) };
    const a = decideVerdict(input);
    const b = decideVerdict(structuredClone(input));
    assert.deepEqual(a, b);
  });
});

test('engine: discovery network error → inconclusive', async () => {
  // 바로 닫은 포트로 연결이 거부되게 만든다.
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  const run = await runChecks({ url: `http://127.0.0.1:${port}/mcp`, autoConsent: true, timeoutSec: 5 });
  assert.equal(run.blocked?.stage, 'discovery');
  assert.equal(run.blocked?.detail, 'blocked.network');
  const v = decideVerdict(run);
  assert.equal(v.verdict, 'inconclusive');
  assert.equal(v.exitCode, 2);
  assert.equal(run.checks.length, 15);
});

test('engine: DCR failure → C05 FAIL and inconclusive', async () => {
  // 메타데이터는 정상이지만 registration_endpoint 가 없는 서버
  let base = '';
  const s = createServer((req, res) => {
    const send = (code: number, body: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/mcp') return send(401, {}, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
    if (req.url === '/.well-known/oauth-protected-resource/mcp') return send(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    if (req.url === '/.well-known/oauth-authorization-server') {
      return send(200, {
        issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
        grant_types_supported: ['authorization_code', 'refresh_token'],
      });
    }
    return send(404, {});
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  try {
    const run = await runChecks({ url: `${base}/mcp`, autoConsent: true, timeoutSec: 5 });
    assert.equal(run.checks.find((c) => c.id === 'C05')?.status, 'FAIL');
    assert.equal(run.blocked?.stage, 'registration');
    assert.equal(decideVerdict(run).verdict, 'inconclusive');
    assert.equal(decideVerdict(run).exitCode, 2);
  } finally {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

test('engine: busy --redirect-port → inconclusive at login, not a crash', async () => {
  const server = await startFakeServer({ preset: 'good' });
  const busy = createServer();
  await new Promise<void>((r) => busy.listen(0, '127.0.0.1', () => r()));
  try {
    const port = (busy.address() as { port: number }).port;
    const run = await runChecks({ url: server.mcpUrl, autoConsent: true, timeoutSec: 5, redirectPort: port });
    assert.equal(run.blocked?.detail, 'blocked.callback_port');
    assert.equal(decideVerdict(run).verdict, 'inconclusive');
  } finally {
    await new Promise<void>((r) => busy.close(() => r()));
    await server.close();
  }
});

test('engine: no response after login → inconclusive at token checks, never a server-side verdict', async (t) => {
  // 서버가 요청을 받자마자 연결을 끊는다(응답 없음). 고치기 전에는 이것이 C06·C09·C08 FAIL 로 적혀
  // "서버 원인(종료 1)"이라는 틀린 판정이 났다 — 느린 러너에서 연결이 끊긴 e2e 실행에서 실제로 관찰됨.
  const cases = [
    { name: 'code exchange (C06)', check: 'C06', method: 'POST', path: '/token', n: 1 },
    { name: 'first refresh (C09)', check: 'C09', method: 'POST', path: '/token', n: 2 },
    { name: 'MCP handshake (C08)', check: 'C08', method: 'POST', path: '/mcp', n: 2 }, // 1번째는 C01(토큰 없음)
  ] as const;
  for (const c of cases) {
    await t.test(c.name, async () => {
      const server = await startFakeServer({
        preset: 'good',
        dropConnection: (r) => r.method === c.method && r.path === c.path && r.n === c.n,
      });
      try {
        const run = await runChecks({ url: server.mcpUrl, autoConsent: true, timeoutSec: 5 });
        const hit = run.checks.find((x) => x.id === c.check);
        assert.equal(hit?.status, 'SKIP', JSON.stringify(hit));
        assert.equal(hit?.detail, 'skip.no_response');
        assert.equal(run.blocked?.stage, 'tokens');
        assert.equal(run.blocked?.detail, 'blocked.no_response');
        assert.equal(run.blocked?.vars?.check, c.check);
        // 응답이 없었던 검사 뒤로는 더 진행하지 않는다
        assert.equal(run.checks.find((x) => x.id === 'C14')?.detail, 'skip.not_reached');
        assert.equal(run.checks.some((x) => x.status === 'FAIL'), false);
        const v = decideVerdict(run);
        assert.equal(v.verdict, 'inconclusive');
        assert.equal(v.exitCode, 2);
        assert.ok(v.fixes.includes('hint.blocked.tokens'));
      } finally {
        await server.close();
      }
    });
  }
});

test('engine: login timeout → inconclusive', async () => {
  const server = await startFakeServer({ preset: 'good' });
  try {
    let shownUrl = '';
    const run = await runChecks({
      url: server.mcpUrl,
      openBrowser: false, // 브라우저를 열지 않으므로 콜백이 오지 않는다
      loginTimeoutSec: 0.3,
      timeoutSec: 5,
      progress: (e) => {
        if (e.type === 'login_url') shownUrl = e.url;
      },
    });
    assert.match(shownUrl, /\/authorize\?response_type=code/);
    assert.equal(run.blocked?.stage, 'login');
    assert.equal(run.blocked?.detail, 'blocked.login_timeout');
    assert.equal(decideVerdict(run).verdict, 'inconclusive');
  } finally {
    await server.close();
  }
});

test('closing the callback server ends a pending login wait as "closed", not as a timeout', async () => {
  const cb = await startCallbackServer(0, 'ok');
  const started = Date.now();
  const waiting = cb.waitForCode('state', 60_000);
  await cb.close();
  assert.deepEqual(await waiting, { ok: false, reason: 'closed' });
  assert.ok(Date.now() - started < 5_000, 'the 60 s login timer did not keep the wait alive');
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
    // 로그인 대기 기본값은 300초다. 타이머가 남으면 자식 프로세스가 끝나지 않아 20초 감시에 걸린다.
    const r = await runCli(['check', `${base}/mcp`, '--auto-consent', '--json'], cleanEnv({ LANG: 'en_US.UTF-8' }), 20_000);
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
