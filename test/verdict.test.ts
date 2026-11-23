// AC-3: 판정 규칙표가 결정적이고, 진행 불가 경로는 inconclusive — 고장은 in-process 전송에 결정적으로 주입한다.
// (실제 서버를 일부러 끊던 예전 시험은 러너 부하에 따라 결과가 흔들렸다. 여기서는 정한 요청 하나만 정한 방식으로 실패한다)
import './support/no-network.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runChecks } from '../src/checks.js';
import { runPreset } from '../src/demo.js';
import { createInProcessTransport, createManualClock, type Fault } from '../src/fake/inprocess.js';
import { CHECK_IDS, type Blocked, type CheckId, type CheckResult, type RunResult, type Status } from '../src/types.js';
import { SERVER_DECISIVE, decideVerdict } from '../src/verdict.js';
import { override } from './helpers.js';

function checks(overrides: Partial<Record<CheckId, Status>>, hints: Partial<Record<CheckId, string>> = {}): CheckResult[] {
  return CHECK_IDS.map((id) => ({
    id,
    status: overrides[id] ?? 'PASS',
    detail: 'x',
    ...(hints[id] ? { hint: hints[id] } : {}),
  }));
}

const explain = (run: RunResult): string =>
  JSON.stringify({ blocked: run.blocked, checks: run.checks.map((c) => `${c.id}:${c.status}:${c.detail}`).join(' ') });

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
    assert.deepEqual([...SERVER_DECISIVE], ['C03', 'C06', 'C08', 'C09', 'C12', 'C13', 'C15']);
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
    for (const stage of ['discovery', 'registration', 'login', 'tokens'] as const) {
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

  await t.test('same preset run twice → same statuses and verdict', async () => {
    const a = await runPreset('no-rotation');
    const b = await runPreset('no-rotation');
    assert.deepEqual(a.run.checks.map((c) => c.status), b.run.checks.map((c) => c.status));
    assert.deepEqual(a.verdict, b.verdict);
  });
});

test('in-process fault paths end inconclusive', async (t) => {
  await t.test('discovery: connection refused → inconclusive(discovery)', async () => {
    // 아무 주소도 등록하지 않은 전송 — 실제 fetch 의 연결 거부와 같은 모양으로 실패한다
    const transport = createInProcessTransport({ routes: {} });
    const run = await runChecks({ url: 'http://127.0.0.1:1/mcp', autoConsent: true, timeoutSec: 5, transport });
    assert.equal(run.blocked?.stage, 'discovery', explain(run));
    assert.equal(run.blocked?.detail, 'blocked.network');
    assert.match(String(run.blocked?.vars?.error), /ECONNREFUSED/);
    const v = decideVerdict(run);
    assert.equal(v.verdict, 'inconclusive');
    assert.equal(v.exitCode, 2);
    assert.equal(run.checks.length, 15);
  });

  await t.test('discovery: the first request dropped → inconclusive(discovery)', async () => {
    const { run } = await runPreset('good', { faults: (r) => (r.method === 'POST' && r.path === '/mcp' && r.n === 1 ? 'drop' : undefined) });
    assert.equal(run.blocked?.stage, 'discovery', explain(run));
    assert.equal(decideVerdict(run).verdict, 'inconclusive');
  });

  await t.test('DCR 400 → C05 FAIL + inconclusive(registration)', async () => {
    const { run, verdict } = await runPreset('good', {
      wrap: override('POST', '/register', () => Response.json({ error: 'invalid_client_metadata' }, { status: 400 })),
    });
    const c05 = run.checks.find((c) => c.id === 'C05');
    assert.equal(c05?.status, 'FAIL', explain(run));
    assert.equal(c05?.detail, 'c05.failed');
    assert.equal(c05?.vars?.error, 'invalid_client_metadata');
    assert.equal(run.blocked?.stage, 'registration');
    assert.equal(verdict.verdict, 'inconclusive');
    assert.equal(verdict.exitCode, 2);
  });

  await t.test('no registration_endpoint → C05 FAIL (unsupported) + inconclusive(registration)', async () => {
    const { run, verdict } = await runPreset('good', {
      wrap: (handle) => async (req) => {
        const res = await handle(req);
        if (new URL(req.url).pathname !== '/.well-known/oauth-authorization-server') return res;
        const meta = (await res.json()) as Record<string, unknown>;
        delete meta.registration_endpoint;
        return Response.json(meta);
      },
    });
    assert.equal(run.checks.find((c) => c.id === 'C05')?.detail, 'c05.unsupported', explain(run));
    assert.equal(run.blocked?.stage, 'registration');
    assert.equal(verdict.verdict, 'inconclusive');
  });

  await t.test('auto-consent: authorize answers 200 (a login page) → inconclusive(login), no login wait at all', async () => {
    const clock = createManualClock();
    const started = performance.now();
    const { run, verdict } = await runPreset('good', {
      clock,
      wrap: override('GET', '/authorize', () => new Response('<html>login</html>', { status: 200, headers: { 'content-type': 'text/html' } })),
    });
    assert.equal(run.blocked?.stage, 'login', explain(run));
    assert.equal(run.blocked?.detail, 'blocked.auto_consent_failed');
    assert.equal(run.blocked?.vars?.error, 'no_redirect_200');
    assert.equal(verdict.verdict, 'inconclusive');
    // 로그인 대기 타이머 자체가 없다: 시계가 돌지 않았고 실제로도 바로 끝났다
    assert.equal(clock.slept, 0);
    assert.ok(performance.now() - started < 20_000);
  });

  await t.test('no auto-consent and nobody logs in → login timeout after the (manual) login wait', async () => {
    const { run, clock } = await runPreset('good', { autoConsent: false, loginTimeoutSec: 300 });
    assert.equal(run.blocked?.stage, 'login', explain(run));
    assert.equal(run.blocked?.detail, 'blocked.login_timeout');
    assert.equal(decideVerdict(run).verdict, 'inconclusive');
    assert.equal(clock.slept, 300_000, 'waited 300 s on the manual clock, not in real time');
  });

  // 로그인 뒤 요청이 응답을 받지 못하면 그 검사는 FAIL 이 아니라 SKIP, 판정은 inconclusive(tokens).
  // 고치기 전에는 이것이 C06·C09·C08 FAIL 로 적혀 "서버 원인(종료 1)"이라는 틀린 판정이 났다.
  const points = [
    { name: 'code exchange', check: 'C06', method: 'POST', path: '/token', n: 1 },
    { name: 'first refresh', check: 'C09', method: 'POST', path: '/token', n: 2 },
    { name: 'MCP initialize', check: 'C08', method: 'POST', path: '/mcp', n: 2 }, // 1번째는 C01(토큰 없음)
  ] as const;
  const faults: Fault[] = ['drop', 'cut-body', 'timeout'];
  for (const p of points) {
    for (const fault of faults) {
      await t.test(`${fault} on ${p.name} (${p.check}) → SKIP no_response + inconclusive(tokens)`, async () => {
        const { run, verdict } = await runPreset('good', {
          faults: (r) => (r.method === p.method && r.path === p.path && r.n === p.n ? fault : undefined),
        });
        const why = explain(run);
        const hit = run.checks.find((x) => x.id === p.check);
        assert.equal(hit?.status, 'SKIP', why);
        assert.equal(hit?.detail, 'skip.no_response', why);
        assert.equal(run.blocked?.stage, 'tokens', why);
        assert.equal(run.blocked?.detail, 'blocked.no_response');
        assert.equal(run.blocked?.vars?.check, p.check);
        if (fault === 'timeout') assert.equal(run.blocked?.vars?.error, 'timeout');
        // 응답이 없었던 검사 뒤로는 더 진행하지 않는다
        assert.equal(run.checks.find((x) => x.id === 'C14')?.detail, 'skip.not_reached', why);
        assert.equal(run.checks.some((x) => x.status === 'FAIL'), false, why);
        assert.equal(verdict.verdict, 'inconclusive');
        assert.equal(verdict.exitCode, 2);
        assert.ok(verdict.fixes.includes('hint.blocked.tokens'));
      });
    }
  }

  await t.test('an already proven decisive FAIL wins over a later stop (no-refresh C03 FAIL, then C08 dropped)', async () => {
    const { run, verdict } = await runPreset('no-refresh', {
      faults: (r) => (r.method === 'POST' && r.path === '/mcp' && r.n === 2 ? 'drop' : undefined),
    });
    assert.equal(run.checks.find((c) => c.id === 'C03')?.status, 'FAIL', explain(run));
    assert.equal(run.blocked?.stage, 'tokens');
    assert.equal(verdict.verdict, 'server');
    assert.equal(verdict.exitCode, 1);
  });
});
