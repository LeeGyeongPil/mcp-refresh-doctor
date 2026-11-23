// AC-7: 언어 — 두 언어 키가 같고, 우선순위가 --lang > MCP_REFRESH_DOCTOR_LANG > LC_ALL/LC_MESSAGES/LANG 이며,
// 실제 CLI 출력(도움말·demo 표)이 고른 언어로 바뀐다. main() 을 같은 프로세스에서 부른다(자식 프로세스 없음).
import './support/no-network.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MESSAGES, resolveLang, translator } from '../src/i18n.js';
import { cleanEnv, runMain } from './helpers.js';

test('en and ko have exactly the same keys, with non-empty text', () => {
  const en = Object.keys(MESSAGES.en).sort();
  const ko = Object.keys(MESSAGES.ko).sort();
  assert.deepEqual(ko, en);
  for (const key of en) {
    assert.ok(MESSAGES.ko[key as keyof typeof MESSAGES.ko].trim().length > 0, `ko ${key}`);
    // 같은 자리표시자({name})를 써야 번역이 값을 잃지 않는다.
    const holes = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();
    assert.deepEqual(holes(MESSAGES.ko[key as keyof typeof MESSAGES.ko]), holes(MESSAGES.en[key as keyof typeof MESSAGES.en]), `placeholders ${key}`);
  }
});

test('language precedence', () => {
  const cases: [string | undefined, Record<string, string>, 'en' | 'ko'][] = [
    ['ko', { MCP_REFRESH_DOCTOR_LANG: 'en', LANG: 'en_US.UTF-8' }, 'ko'],
    ['en', { MCP_REFRESH_DOCTOR_LANG: 'ko', LANG: 'ko_KR.UTF-8' }, 'en'],
    [undefined, { MCP_REFRESH_DOCTOR_LANG: 'ko', LANG: 'en_US.UTF-8' }, 'ko'],
    [undefined, { MCP_REFRESH_DOCTOR_LANG: 'en', LC_ALL: 'ko_KR.UTF-8' }, 'en'],
    [undefined, { MCP_REFRESH_DOCTOR_LANG: 'xx', LANG: 'ko_KR.UTF-8' }, 'ko'],
    [undefined, { LC_ALL: 'ko_KR.UTF-8', LANG: 'en_US.UTF-8' }, 'ko'],
    [undefined, { LC_ALL: 'en_US.UTF-8', LANG: 'ko_KR.UTF-8' }, 'en'],
    [undefined, { LC_MESSAGES: 'ko_KR', LANG: 'en_US' }, 'ko'],
    [undefined, { LANG: 'ko_KR.UTF-8' }, 'ko'],
    [undefined, { LANG: 'ja_JP.UTF-8' }, 'en'],
    [undefined, { LANG: 'C' }, 'en'],
    [undefined, {}, 'en'],
  ];
  for (const [arg, env, expected] of cases) {
    assert.equal(resolveLang(arg, env), expected, `${arg ?? '-'} ${JSON.stringify(env)}`);
  }
});

test('translator fills placeholders and changes with the language', () => {
  assert.equal(translator('en')('report.verdict'), 'Verdict');
  assert.equal(translator('ko')('report.verdict'), '판정');
  assert.equal(translator('en')('c07.ok', { seconds: 60 }), 'expires_in=60s');
  assert.equal(translator('ko')('c07.ok', { seconds: 60 }), 'expires_in=60초');
});

test('cli output follows --lang, the env var and the locale', async () => {
  const helpEn = await runMain(['--help', '--lang', 'en'], cleanEnv({ LANG: 'ko_KR.UTF-8' }));
  assert.equal(helpEn.code, 0);
  assert.match(helpEn.stdout, /Usage/);

  const helpKo = await runMain(['--help', '--lang', 'ko'], cleanEnv({ LANG: 'en_US.UTF-8' }));
  assert.match(helpKo.stdout, /사용법/);

  const viaEnv = await runMain(['--help'], cleanEnv({ MCP_REFRESH_DOCTOR_LANG: 'ko', LANG: 'en_US.UTF-8' }));
  assert.match(viaEnv.stdout, /사용법/);

  const viaLocale = await runMain(['--help'], cleanEnv({ LANG: 'ko_KR.UTF-8' }));
  assert.match(viaLocale.stdout, /사용법/);

  const other = await runMain(['--help'], cleanEnv({ LANG: 'de_DE.UTF-8' }));
  assert.match(other.stdout, /Usage/);

  const demoKo = await runMain(['demo', '--lang', 'ko'], cleanEnv());
  assert.equal(demoKo.code, 0);
  assert.match(demoKo.stdout, /판정/);
  assert.match(demoKo.stdout, /연습용 목\(mock\)/);

  const demoEn = await runMain(['demo', '--lang', 'en'], cleanEnv({ LANG: 'ko_KR.UTF-8' }));
  assert.match(demoEn.stdout, /Verdict/);
  assert.match(demoEn.stdout, /Practice mock servers/);
  assert.equal(/판정/.test(demoEn.stdout), false);

  const bad = await runMain(['demo', '--lang', 'fr']);
  assert.equal(bad.code, 2);
});
