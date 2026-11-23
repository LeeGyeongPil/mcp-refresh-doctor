// AC-9 (e2e, 실 소켓·자식 프로세스, `npm run test:e2e` 전용 — CI 비대상):
// `serve` 를 별도 프로세스(--port 0)로 띄우고 `check --auto-consent` 프로세스가 실제 HTTP 로 끝까지 돈다.
// 종료 코드가 판정과 맞고, serve 는 SIGTERM 에 소켓을 닫고 0 으로 끝난다.
// (실제 만료 대기 --wait-expiry 는 수동 시계를 쓰는 in-process 시험 test/check-engine.test.ts 가 맡는다)
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanEnv, runCli, startServe, type CliResult } from './helpers.js';

interface Report {
  verdict: { verdict: string; exitCode: number };
  durationMs?: number;
  blocked?: { stage: string; detail: string };
  checks: { id: string; status: string; detail?: string; evidence?: Record<string, unknown> }[];
}

const status = (r: Report, id: string): string | undefined => r.checks.find((c) => c.id === id)?.status;

/** 단언이 실패할 때 원인을 알 수 있게 붙이는 설명: 종료 코드, 막힌 단계, 검사별 상태, 표준 오류와 serve 로그의 끝부분 */
function explain(r: CliResult, serveLog: string): string {
  let report: Report | undefined;
  try {
    report = JSON.parse(r.stdout) as Report;
  } catch {
    report = undefined;
  }
  return JSON.stringify({
    exit: r.code,
    blocked: report?.blocked,
    durationMs: report?.durationMs,
    checks: report?.checks.map((c) => `${c.id}:${c.status}`).join(' '),
    failed: report?.checks.filter((c) => c.status === 'FAIL').map((c) => ({ id: c.id, detail: c.detail, evidence: c.evidence })),
    stderr: r.stderr.slice(-800),
    serveLog: serveLog.slice(-2000),
  }, null, 2);
}

/** 요청 하나의 시간 제한. 이 시험은 속도가 아니라 판정을 본다(매달림은 여전히 막는다) */
const REQUEST_TIMEOUT = ['--timeout', '30'];

async function checkServed(
  preset: string,
  extra: string[] = [],
  expectLog: RegExp[] = [],
): Promise<{ code: number | null; report: Report; serveLog: string; why: string }> {
  const served = await startServe(preset, 3600);
  try {
    const r = await runCli(['check', served.url, '--auto-consent', '--json', ...REQUEST_TIMEOUT, ...extra], cleanEnv({ LANG: 'en_US.UTF-8' }));
    assert.equal(r.stderr.includes('error:'), false, explain(r, served.log()));
    for (const pattern of expectLog) await served.waitForLog(pattern);
    const serveLog = served.log();
    return { code: r.code, report: JSON.parse(r.stdout) as Report, serveLog, why: explain(r, serveLog) };
  } finally {
    // serve 프로세스는 SIGTERM 에 소켓을 닫고 0 으로 끝나야 한다(남는 프로세스 없음).
    assert.equal(await served.stop(), 0);
  }
}

test('check against served presets (real sockets, child processes)', async (t) => {
  await t.test('good → exit 0, verdict client, --out writes the same JSON report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrd-'));
    try {
      const outFile = join(dir, 'report.json');
      const { code, report, serveLog, why } = await checkServed('good', ['--out', outFile], [/reuse detected, family revoked/]);
      assert.equal(code, 0, why);
      assert.equal(report.verdict.verdict, 'client', why);
      assert.equal(status(report, 'C14'), 'PASS', why);
      // 서버 로그로 실제 왕복을 확인: 재사용 감지와 가족 폐기가 일어났다.
      assert.match(serveLog, /reuse detected, family revoked/);
      const saved = JSON.parse(await readFile(outFile, 'utf8')) as Report;
      assert.equal(saved.verdict.verdict, 'client');
      assert.equal(saved.checks.length, 15);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await t.test('refresh-needs-secret → exit 1, C09 FAIL', async () => {
    const { code, report, why } = await checkServed('refresh-needs-secret');
    assert.equal(code, 1, why);
    assert.equal(report.verdict.verdict, 'server', why);
    assert.equal(status(report, 'C09'), 'FAIL', why);
  });

  await t.test('--max-wait shorter than the token lifetime skips C15 instead of waiting', async () => {
    const { report, why } = await checkServed('good', ['--wait-expiry', '--max-wait', '1']);
    assert.equal(status(report, 'C15'), 'SKIP', why);
  });
});
