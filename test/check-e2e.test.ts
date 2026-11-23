// AC-2: check 가 따로 띄운 serve 서버(실제 소켓)에 --auto-consent 로 끝까지 돌고,
// 종료 코드가 판정과 맞으며, --wait-expiry 가 실제 만료 후의 응답을 판정한다.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanEnv, runCli, startServe } from './helpers.js';

interface Report {
  verdict: { verdict: string; exitCode: number };
  checks: { id: string; status: string; evidence?: Record<string, unknown> }[];
}

const status = (r: Report, id: string): string | undefined => r.checks.find((c) => c.id === id)?.status;

async function checkServed(preset: string, ttl: number, extra: string[] = []): Promise<{ code: number | null; report: Report; serveLog: string }> {
  const served = await startServe(preset, ttl);
  try {
    const r = await runCli(['check', served.url, '--auto-consent', '--json', ...extra], cleanEnv({ LANG: 'en_US.UTF-8' }));
    assert.equal(r.stderr.includes('error:'), false, r.stderr);
    return { code: r.code, report: JSON.parse(r.stdout) as Report, serveLog: served.log() };
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
      const { code, report, serveLog } = await checkServed('good', 3600, ['--out', outFile]);
      assert.equal(code, 0);
      assert.equal(report.verdict.verdict, 'client');
      assert.equal(status(report, 'C14'), 'PASS');
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
      const r = await runCli(['check', served.url, '--auto-consent', '--json', '--out', bad, '--lang', 'ko'], cleanEnv());
      assert.equal(r.code, 1); // 서버 원인 판정이 그대로 나온다
      assert.match(r.stderr, /보고서를 .* 저장하지 못했습니다/);
      assert.equal(r.stderr.includes('ENOENT: no such'), false);
      assert.equal((JSON.parse(r.stdout) as Report).verdict.exitCode, 1);
    } finally {
      assert.equal(await served.stop(), 0);
    }
  });

  await t.test('refresh-needs-secret → exit 1, C09 FAIL', async () => {
    const { code, report } = await checkServed('refresh-needs-secret', 3600);
    assert.equal(code, 1);
    assert.equal(report.verdict.verdict, 'server');
    assert.equal(status(report, 'C09'), 'FAIL');
  });

  await t.test('--wait-expiry against --ttl 2: good → C15 PASS, expired-403 → C15 FAIL', async () => {
    const [good, broken] = await Promise.all([
      checkServed('good', 2, ['--wait-expiry', '--max-wait', '30']),
      checkServed('expired-403', 2, ['--wait-expiry', '--max-wait', '30']),
    ]);
    assert.equal(status(good.report, 'C15'), 'PASS');
    assert.equal(good.code, 0);
    assert.equal(status(broken.report, 'C15'), 'FAIL');
    assert.equal(broken.report.checks.find((c) => c.id === 'C15')?.evidence?.status, 403);
    assert.equal(broken.code, 1);
    // 서버 로그에 "token expired" 가 찍혀야 위조 토큰이 아니라 실제 만료로 판정한 것이다.
    assert.match(good.serveLog, /\(token expired\) -> 401/);
    assert.match(broken.serveLog, /\(token expired\) -> 403/);
  });

  await t.test('--max-wait shorter than the token lifetime skips C15 instead of waiting', async () => {
    const { report } = await checkServed('good', 3600, ['--wait-expiry', '--max-wait', '1']);
    assert.equal(status(report, 'C15'), 'SKIP');
  });
});
