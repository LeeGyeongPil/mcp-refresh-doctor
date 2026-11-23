// AC-1: demo 가 프리셋 6종을 실제 HTTP 로 점검하고 판정이 기대와 같다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runDemo, runPreset } from '../src/demo.js';
import { translator } from '../src/i18n.js';
import { CHECK_IDS } from '../src/types.js';
import { cleanEnv, runCli } from './helpers.js';

const status = (checks: { id: string; status: string }[], id: string): string | undefined =>
  checks.find((c) => c.id === id)?.status;

test('each preset yields the expected verdict', async () => {
  const rows = await runDemo();
  assert.equal(rows.length, 6);
  const by = Object.fromEntries(rows.map((r) => [r.preset, r]));

  // good → client, C01~C14 전부 PASS(C15 는 --wait-expiry 가 없어 SKIP)
  assert.equal(by.good?.verdict, 'client');
  for (const id of CHECK_IDS.filter((x) => x !== 'C15')) assert.equal(status(by.good!.checks, id), 'PASS', `good ${id}`);
  assert.equal(status(by.good!.checks, 'C15'), 'SKIP');

  assert.equal(by['no-refresh']?.verdict, 'server');
  assert.equal(status(by['no-refresh']!.checks, 'C06'), 'FAIL');

  assert.equal(by['expired-403']?.verdict, 'server');
  assert.equal(status(by['expired-403']!.checks, 'C13'), 'FAIL');

  assert.equal(by['no-rotation']?.verdict, 'client');
  assert.equal(status(by['no-rotation']!.checks, 'C11'), 'WARN');
  assert.equal(status(by['no-rotation']!.checks, 'C14'), 'SKIP');

  assert.equal(by['refresh-needs-secret']?.verdict, 'server');
  assert.equal(status(by['refresh-needs-secret']!.checks, 'C09'), 'FAIL');

  assert.equal(by['resource-required']?.verdict, 'client');
  assert.equal(status(by['resource-required']!.checks, 'C10'), 'WARN');

  for (const r of rows) assert.ok(r.matchesExpected, `${r.preset} matches its expectation`);
});

test('refresh-needs-secret is classified as invalid_client with its fix hint', async () => {
  const { run, verdict } = await runPreset('refresh-needs-secret');
  const c09 = run.checks.find((c) => c.id === 'C09');
  assert.equal(c09?.status, 'FAIL');
  assert.equal((c09?.evidence as { classified?: string }).classified, 'invalid_client');
  assert.equal(c09?.hint, 'hint.token.invalid_client');
  assert.ok(verdict.fixes.includes('hint.token.invalid_client'));
  assert.deepEqual(verdict.reasons, ['C09']);
});

test('resource-required reports invalid_target on the refresh without resource', async () => {
  const { run } = await runPreset('resource-required');
  const c10 = run.checks.find((c) => c.id === 'C10');
  assert.equal(c10?.status, 'WARN');
  assert.equal((c10?.evidence as { classified?: string }).classified, 'invalid_target');
});

test('every message key produced by the engine exists in both languages', async () => {
  const en = translator('en');
  const ko = translator('ko');
  const rows = await Promise.all((['good', 'no-refresh', 'expired-403', 'no-rotation', 'refresh-needs-secret', 'resource-required'] as const).map((p) => runPreset(p)));
  for (const { run, verdict } of rows) {
    for (const c of run.checks) {
      for (const key of [c.detail, `title.${c.id}`, ...(c.hint ? [c.hint] : [])]) {
        assert.notEqual(en(key), key, `en has ${key}`);
        assert.notEqual(ko(key), key, `ko has ${key}`);
      }
    }
    for (const key of verdict.fixes) assert.notEqual(ko(key), key, `ko has ${key}`);
  }
});

test('cli: demo --json prints 6 entries with the expected verdicts and exits 0', async () => {
  const r = await runCli(['demo', '--json'], cleanEnv({ LANG: 'en_US.UTF-8' }));
  assert.equal(r.code, 0, r.stderr);
  const rows = JSON.parse(r.stdout) as { preset: string; verdict: string }[];
  assert.equal(rows.length, 6);
  assert.deepEqual(
    Object.fromEntries(rows.map((x) => [x.preset, x.verdict])),
    {
      good: 'client', 'no-refresh': 'server', 'expired-403': 'server',
      'no-rotation': 'client', 'refresh-needs-secret': 'server', 'resource-required': 'client',
    },
  );
});
