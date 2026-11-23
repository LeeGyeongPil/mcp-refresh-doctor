// AC-5: 텍스트·JSON 보고서(en·ko)와 목 handler 로그 어디에도 토큰·code·client_id 원문이 나오지 않는다.
import './support/no-network.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPreset } from '../src/demo.js';
import { PRESET_NAMES } from '../src/fake/presets.js';
import { translator } from '../src/i18n.js';
import { Redactor, maskValue } from '../src/mask.js';
import { buildJsonReport, renderText } from '../src/report.js';

test('maskValue keeps only the first 3 and last 2 characters', () => {
  assert.equal(maskValue('at_abcdefghijklmnop'), 'at_…op');
  assert.equal(maskValue('short'), '…');
});

test('Redactor.scrub removes raw secrets even when a server echoes them, longest first', () => {
  const red = new Redactor();
  red.add('rt_secret_value_1234');
  red.add('rt_secret_value_1234_longer');
  const out = red.scrub('error: token rt_secret_value_1234_longer and rt_secret_value_1234 rejected');
  assert.equal(out.includes('rt_secret_value_1234'), false);
  assert.match(out, /rt_…er and rt_…34/);
  // JSON 으로 이스케이프된 형태도 지운다
  red.add('ab/cd"ef_secret');
  assert.equal(red.scrub(JSON.stringify({ e: 'ab/cd"ef_secret' })).includes('ef_secret'), false);
});

test('no raw secrets in outputs', async () => {
  let totalSecrets = 0;
  for (const preset of PRESET_NAMES) {
    const logLines: string[] = [];
    const red = new Redactor();
    // --wait-expiry 까지 켜서 가능한 한 많은 토큰이 발급·사용되게 한다(수동 시계라 즉시 끝난다)
    const { run, verdict, fake } = await runPreset(preset, {
      redactor: red, trackSecrets: true, waitExpiry: true, log: (l) => logLines.push(l),
    });
    const outputs = [
      renderText(run, verdict, translator('en'), red),
      renderText(run, verdict, translator('ko'), red),
      JSON.stringify(buildJsonReport(run, verdict, 'en', translator('en'), red)),
      JSON.stringify(buildJsonReport(run, verdict, 'ko', translator('ko'), red)),
      logLines.join('\n'),
    ];
    const secrets = [...fake.issuedSecrets];
    // 실제로 비밀이 발급됐어야 의미 있는 검사다(client_id·code·access token 은 모든 프리셋에서 나온다).
    assert.ok(secrets.length >= 3, `${preset}: issued ${secrets.length} secrets`);
    totalSecrets += secrets.length;
    for (const secret of secrets) {
      for (const text of outputs) {
        assert.equal(text.includes(secret), false, `${preset}: raw secret ${maskValue(secret)} leaked`);
      }
    }
    // 가린 형태(앞 3 + … + 끝 2)는 로그에 실제로 나타난다.
    assert.ok(logLines.some((l) => /client_id=c_\S…\S\S /.test(l)), `${preset}: masked client_id in log`);
  }
  assert.ok(totalSecrets >= 30);
});
