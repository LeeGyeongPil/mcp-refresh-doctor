// 점검 엔진(runChecks)을 끝까지 — in-process 목 + 수동 시계.
// C15(--wait-expiry)는 토큰 수명만큼 "기다리지만" 수동 시계라 시계만 앞으로 돌고 실제로는 기다리지 않는다.
// 그래서 수명 1시간 토큰의 실제 만료 응답도 몇 밀리초 안에, 언제나 같은 결과로 확인된다.
import './support/no-network.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runPreset } from '../src/demo.js';
import type { PresetName } from '../src/fake/presets.js';
import { translator } from '../src/i18n.js';
import { Redactor } from '../src/mask.js';
import { buildJsonReport } from '../src/report.js';
import type { CheckResult, RunResult } from '../src/types.js';
import { cleanEnv, inProcess, runMain } from './helpers.js';

const TTL_SEC = 3600; // 한 시간 — 실제로 기다렸다면 시험 시간 상한(30초)을 한참 넘는다

const get = (run: RunResult, id: string): CheckResult | undefined => run.checks.find((c) => c.id === id);

/** 실패할 때 원인을 바로 알 수 있도록 붙이는 설명 */
function explain(run: RunResult, log: string[]): string {
  return JSON.stringify({
    blocked: run.blocked,
    checks: run.checks.map((c) => `${c.id}:${c.status}:${c.detail}`).join(' '),
    log: log.slice(-12),
  }, null, 2);
}

async function lifecycle(preset: PresetName): Promise<{ run: RunResult; exitCode: number; verdict: string; slept: number; realMs: number; log: string[] }> {
  const log: string[] = [];
  const started = performance.now();
  const r = await runPreset(preset, { waitExpiry: true, ttlSec: TTL_SEC, log: (l) => log.push(l) });
  const realMs = performance.now() - started;

  // JSON 보고서의 판정·15개 검사가 run 과 같다(en·ko 둘 다)
  for (const lang of ['en', 'ko'] as const) {
    const json = buildJsonReport(r.run, r.verdict, lang, translator(lang), new Redactor());
    assert.equal(json.verdict.verdict, r.verdict.verdict);
    assert.equal(json.verdict.exitCode, r.verdict.exitCode);
    assert.equal(json.checks.length, 15);
    assert.deepEqual(json.checks.map((c) => `${c.id}:${c.status}`), r.run.checks.map((c) => `${c.id}:${c.status}`));
  }
  return { run: r.run, exitCode: r.verdict.exitCode, verdict: r.verdict.verdict, slept: r.clock.slept, realMs, log };
}

test('full lifecycle per preset with a manual clock', async (t) => {
  await t.test('good → C15 PASS (401 invalid_token after real expiry), verdict client, exit 0', async () => {
    const r = await lifecycle('good');
    const why = explain(r.run, r.log);
    assert.equal(get(r.run, 'C08')?.status, 'PASS', why);
    assert.equal(get(r.run, 'C12')?.status, 'PASS', why);
    assert.equal(get(r.run, 'C15')?.status, 'PASS', why);
    assert.equal(r.verdict, 'client', why);
    assert.equal(r.exitCode, 0, why);
    // 위조 토큰이 아니라 "만료된" 토큰으로 판정했다는 증거: 목 서버 로그의 사유
    assert.ok(r.log.some((l) => l.includes('(token expired) -> 401')), why);
    // 시계는 토큰 수명 이상 돌았지만 실제로는 기다리지 않았다
    assert.ok(r.slept >= TTL_SEC * 1000, `manual clock advanced ${r.slept} ms`);
    assert.ok(r.realMs < 20_000, `real time ${Math.round(r.realMs)} ms`);
  });

  await t.test('expired-403 → C13 and C15 FAIL (403), verdict server, exit 1', async () => {
    const r = await lifecycle('expired-403');
    const why = explain(r.run, r.log);
    assert.equal(get(r.run, 'C13')?.status, 'FAIL', why);
    assert.equal(get(r.run, 'C15')?.status, 'FAIL', why);
    assert.equal(get(r.run, 'C15')?.evidence?.status, 403, why);
    assert.equal(r.verdict, 'server', why);
    assert.equal(r.exitCode, 1, why);
    assert.ok(r.log.some((l) => l.includes('(token expired) -> 403')), why);
    assert.ok(r.slept >= TTL_SEC * 1000);
  });

  await t.test('refresh-needs-secret → C09 FAIL (invalid_client), verdict server, exit 1', async () => {
    const r = await lifecycle('refresh-needs-secret');
    const why = explain(r.run, r.log);
    assert.equal(get(r.run, 'C09')?.status, 'FAIL', why);
    assert.equal((get(r.run, 'C09')?.evidence as { classified?: string }).classified, 'invalid_client', why);
    assert.equal(r.verdict, 'server', why);
    assert.equal(r.exitCode, 1, why);
  });

  await t.test('--max-wait shorter than the token lifetime skips C15 without advancing the clock', async () => {
    const r = await runPreset('good', { waitExpiry: true, ttlSec: TTL_SEC, maxWaitSec: 1 });
    assert.equal(get(r.run, 'C15')?.status, 'SKIP');
    assert.equal(get(r.run, 'C15')?.detail, 'skip.c15_too_long');
    assert.equal(r.clock.slept, 0);
  });
});

test('check command end to end through main() with an in-process transport', async (t) => {
  await t.test('good --wait-expiry --json --out: exit 0 and the saved report equals stdout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrd-'));
    try {
      const outFile = join(dir, 'report.json');
      const { fake, transport } = inProcess('good', { ttlSec: 60 });
      const r = await runMain(
        ['check', fake.mcpUrl, '--auto-consent', '--wait-expiry', '--json', '--out', outFile],
        cleanEnv({ LANG: 'en_US.UTF-8' }),
        { transport },
      );
      assert.equal(r.code, 0, r.stderr);
      const printed = JSON.parse(r.stdout) as { verdict: { verdict: string }; checks: { id: string; status: string }[] };
      assert.equal(printed.verdict.verdict, 'client');
      assert.equal(printed.checks.find((c) => c.id === 'C15')?.status, 'PASS');
      assert.match(r.stderr, /Waiting \d+s for the access token to really expire/);
      const saved = JSON.parse(await readFile(outFile, 'utf8')) as typeof printed;
      assert.deepEqual(saved, printed);
      assert.equal(saved.checks.length, 15);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test('unwritable --out keeps the verdict exit code and prints a translated warning', async () => {
    const { fake, transport } = inProcess('refresh-needs-secret');
    const bad = join(tmpdir(), 'mrd-no-such-dir', 'sub', 'r.json');
    const r = await runMain(['check', fake.mcpUrl, '--auto-consent', '--json', '--out', bad, '--lang', 'ko'], cleanEnv(), { transport });
    assert.equal(r.code, 1, r.stderr); // 서버 원인 판정이 그대로 나온다
    assert.match(r.stderr, /보고서를 .* 저장하지 못했습니다/);
    assert.equal(r.stderr.includes('ENOENT: no such'), false);
    assert.equal((JSON.parse(r.stdout) as { verdict: { exitCode: number } }).verdict.exitCode, 1);
  });

  await t.test('text report shows the verdict, reasons and fixes', async () => {
    const { fake, transport } = inProcess('expired-403');
    const r = await runMain(['check', fake.mcpUrl, '--auto-consent', '--lang', 'en'], cleanEnv(), { transport });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Verdict: SERVER-SIDE \(exit 1\)/);
    assert.match(r.stdout, /C13 FAIL/);
  });
});
