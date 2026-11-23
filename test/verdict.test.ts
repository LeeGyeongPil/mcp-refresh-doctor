// AC-3: 판정 규칙표가 결정적이고, 진행 불가(발견 네트워크 오류·DCR 실패·로그인 시간 초과)는 inconclusive.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { runChecks } from '../src/checks.js';
import { startFakeServer } from '../src/fake/server.js';
import { CHECK_IDS, type Blocked, type CheckId, type CheckResult, type Status } from '../src/types.js';
import { SERVER_DECISIVE, decideVerdict } from '../src/verdict.js';

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
