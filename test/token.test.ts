// AC-4: 토큰 엔드포인트 오류 분류 — 각 실패가 고유 코드와 두 언어 모두에 있는 힌트 키로 매핑된다.
import './support/no-network.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translator } from '../src/i18n.js';
import { classifyTokenError } from '../src/token.js';

const res = (status: number, json: unknown) => ({ reached: true, status, json });

test('classifyTokenError', async (t) => {
  const cases = [
    { name: '401 invalid_client', input: res(401, { error: 'invalid_client' }), code: 'invalid_client' },
    { name: '400 invalid_grant', input: res(400, { error: 'invalid_grant' }), code: 'invalid_grant' },
    { name: '400 invalid_scope', input: res(400, { error: 'invalid_scope' }), code: 'invalid_scope' },
    { name: '400 invalid_target', input: res(400, { error: 'invalid_target' }), code: 'invalid_target' },
    { name: '400 unsupported_grant_type', input: res(400, { error: 'unsupported_grant_type' }), code: 'unsupported_grant_type' },
    { name: '502 with JSON body', input: res(502, { error: 'invalid_grant' }), code: 'server_error' },
    { name: '400 HTML body', input: res(400, undefined), code: 'non_json' },
  ] as const;

  const seenCodes = new Set<string>();
  const seenHints = new Set<string>();
  for (const c of cases) {
    await t.test(c.name, () => {
      const out = classifyTokenError(c.input);
      assert.equal(out.code, c.code);
      assert.equal(out.status, c.input.status);
      seenCodes.add(out.code);
      seenHints.add(out.hint);
      // 힌트 키는 두 언어 모두에 실제 문장이 있어야 한다.
      assert.notEqual(translator('en')(out.hint), out.hint);
      assert.notEqual(translator('ko')(out.hint), out.hint);
    });
  }
  await t.test('7 distinct codes and 7 distinct hints', () => {
    assert.equal(seenCodes.size, 7);
    assert.equal(seenHints.size, 7);
  });

  await t.test('5xx wins over the error field, and the server error value is kept as evidence', () => {
    const out = classifyTokenError(res(503, { error: 'temporarily_unavailable' }));
    assert.equal(out.code, 'server_error');
    assert.equal(out.serverError, 'temporarily_unavailable');
  });

  await t.test('unknown OAuth error → other, network failure → network', () => {
    assert.equal(classifyTokenError(res(400, { error: 'invalid_request' })).code, 'other');
    assert.equal(classifyTokenError({ reached: false, status: 0, json: undefined }).code, 'network');
  });
});
