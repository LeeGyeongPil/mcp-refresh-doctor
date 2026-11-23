// AC-2: check 가 따로 띄운 serve 서버(실제 소켓)에 --auto-consent 로 끝까지 돌고,
// 종료 코드가 판정과 맞으며, --wait-expiry 가 실제 만료 후의 응답을 판정한다.
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

/**
 * 단언이 실패할 때 CI 로그만 보고 원인을 알 수 있도록 붙이는 설명:
 * 종료 코드, 막힌 단계(blocked), 검사별 상태, 걸린 시간, 표준 오류와 serve 로그의 끝부분.
 */
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

/**
 * 요청 하나의 시간 제한(--timeout). 기본 15초는 실제 서버용이고, 이 시험은 속도가 아니라 판정을 본다.
 * 붐비는 러너에서 요청이 15초를 넘겨 판정 불가(종료 2)로 끝난 적이 있어 넉넉히 준다(매달림은 여전히 막는다).
 */
const REQUEST_TIMEOUT = ['--timeout', '30'];

/**
 * serve 를 띄우고 check 를 돌린다. expectLog 는 serve 로그에 나와야 하는 줄 —
 * 다른 프로세스의 파이프로 늦게 도착할 수 있으므로 단언 전에 나타날 때까지 기다린다.
 */
async function checkServed(
  preset: string,
  ttl: number,
  extra: string[] = [],
  expectLog: RegExp[] = [],
): Promise<{ code: number | null; report: Report; serveLog: string; why: string }> {
  const served = await startServe(preset, ttl);
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

test('check against served presets', async (t) => {
  await t.test('good → exit 0, verdict client, --out writes the same JSON report', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mrd-'));
    try {
      const outFile = join(dir, 'report.json');
      const { code, report, serveLog, why } = await checkServed('good', 3600, ['--out', outFile], [/reuse detected, family revoked/]);
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

  await t.test('unwritable --out keeps the verdict exit code and prints a translated warning', async () => {
    const served = await startServe('refresh-needs-secret', 3600);
    try {
      const bad = join(tmpdir(), 'mrd-no-such-dir', 'sub', 'r.json');
      const r = await runCli(['check', served.url, '--auto-consent', '--json', ...REQUEST_TIMEOUT, '--out', bad, '--lang', 'ko'], cleanEnv());
      assert.equal(r.code, 1, explain(r, served.log())); // 서버 원인 판정이 그대로 나온다
      assert.match(r.stderr, /보고서를 .* 저장하지 못했습니다/);
      assert.equal(r.stderr.includes('ENOENT: no such'), false);
      assert.equal((JSON.parse(r.stdout) as Report).verdict.exitCode, 1);
    } finally {
      assert.equal(await served.stop(), 0);
    }
  });

  await t.test('refresh-needs-secret → exit 1, C09 FAIL', async () => {
    const { code, report, why } = await checkServed('refresh-needs-secret', 3600);
    assert.equal(code, 1, why);
    assert.equal(report.verdict.verdict, 'server', why);
    assert.equal(status(report, 'C09'), 'FAIL', why);
  });

  await t.test('--wait-expiry against --ttl 10: good → C15 PASS, expired-403 → C15 FAIL', async () => {
    // 수명 10초: 발급 직후의 C08·C12 핸드셰이크가 붐비는 러너에서도 만료 전에 끝나도록 여유를 둔다.
    // 부하 재현 실행에서 수명 5초일 때 코드 교환과 initialize 사이가 5초 넘게 벌어져
    // C08 이 "token expired" 401 로 FAIL → good 이 server 판정으로 바뀐 것을 관찰했다(2초는 더 위험).
    const [good, broken] = await Promise.all([
      checkServed('good', 10, ['--wait-expiry', '--max-wait', '30'], [/\(token expired\) -> 401/]),
      checkServed('expired-403', 10, ['--wait-expiry', '--max-wait', '30'], [/\(token expired\) -> 403/]),
    ]);
    // 실패하면 원인을 바로 볼 수 있게 C08·C12(만료 전 핸드셰이크)도 확인한다.
    assert.equal(status(good.report, 'C08'), 'PASS', good.why);
    assert.equal(status(good.report, 'C12'), 'PASS', good.why);
    assert.equal(status(good.report, 'C15'), 'PASS', good.why);
    assert.equal(good.code, 0, good.why);
    assert.equal(status(broken.report, 'C15'), 'FAIL', broken.why);
    assert.equal(broken.report.checks.find((c) => c.id === 'C15')?.evidence?.status, 403, broken.why);
    assert.equal(broken.code, 1, broken.why);
    // 서버 로그에 "token expired" 가 찍혀야 위조 토큰이 아니라 실제 만료로 판정한 것이다.
    assert.match(good.serveLog, /\(token expired\) -> 401/);
    assert.match(broken.serveLog, /\(token expired\) -> 403/);
  });

  await t.test('--max-wait shorter than the token lifetime skips C15 instead of waiting', async () => {
    const { report, why } = await checkServed('good', 3600, ['--wait-expiry', '--max-wait', '1']);
    assert.equal(status(report, 'C15'), 'SKIP', why);
  });
});
