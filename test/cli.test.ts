// AC-6: 안전장치 — 루프백이 아닌 평문 http 와 원격 --auto-consent 를 거부한다(종료 2).
// 이 검사들은 요청을 보내기 전에 막히므로 네트워크가 필요 없다. main() 을 같은 프로세스에서 부른다.
import './support/no-network.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isLoopbackHost, urlPolicyError } from '../src/http.js';
import { TOOL_VERSION } from '../src/types.js';
import { cleanEnv, runMain } from './helpers.js';

test('argument errors', async (t) => {
  await t.test('--client-id without --redirect-port is refused (en and ko)', async () => {
    const en = await runMain(['check', 'https://example.com/mcp', '--client-id', 'abc'], cleanEnv({ LANG: 'en_US.UTF-8' }));
    assert.equal(en.code, 2);
    assert.match(en.stderr, /--client-id needs --redirect-port/);
    const ko = await runMain(['check', 'https://example.com/mcp', '--client-id', 'abc', '--lang', 'ko'], cleanEnv());
    assert.equal(ko.code, 2);
    assert.match(ko.stderr, /함께 써야 합니다/);
  });

  await t.test('parseArgs errors follow --lang', async () => {
    const unknown = await runMain(['check', 'https://example.com/mcp', '--frob', '--lang', 'ko'], cleanEnv());
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /알 수 없는 옵션 --frob/);
    const missing = await runMain(['check', 'https://example.com/mcp', '--scope', '--lang=ko'], cleanEnv());
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /값이 필요합니다/);
    const en = await runMain(['check', 'https://example.com/mcp', '--frob'], cleanEnv({ LANG: 'en_US.UTF-8' }));
    assert.match(en.stderr, /unknown option --frob/);
  });
});

test('safety guards', async (t) => {
  await t.test('plain http to a non-loopback host is refused without --allow-http', async () => {
    const r = await runMain(['check', 'http://example.com/mcp'], cleanEnv({ LANG: 'en_US.UTF-8' }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refusing plain http/);
    assert.equal(r.stdout, '');
  });

  await t.test('the Korean message keeps the searchable English phrase', async () => {
    const r = await runMain(['check', 'http://example.com/mcp'], cleanEnv({ LANG: 'ko_KR.UTF-8' }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /refusing plain http/);
    assert.match(r.stderr, /평문 http/);
  });

  await t.test('--auto-consent is refused for non-loopback hosts', async () => {
    const r = await runMain(['check', 'https://example.com/mcp', '--auto-consent'], cleanEnv({ LANG: 'en_US.UTF-8' }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--auto-consent is only allowed for loopback hosts/);
  });

  await t.test('invalid URL, unknown command, bad numbers and unknown options exit 2', async () => {
    const env = cleanEnv({ LANG: 'en_US.UTF-8' });
    assert.equal((await runMain(['check', 'ftp://example.com/mcp'], env)).code, 2);
    assert.equal((await runMain(['check'], env)).code, 2);
    assert.equal((await runMain(['frobnicate'], env)).code, 2);
    assert.equal((await runMain(['check', 'https://example.com/mcp', '--timeout', 'abc'], env)).code, 2);
    assert.equal((await runMain(['check', 'https://example.com/mcp', '--no-such-flag'], env)).code, 2);
    assert.equal((await runMain(['serve', '--preset', 'nope'], env)).code, 2);
  });

  await t.test('url policy helper', () => {
    assert.equal(urlPolicyError('https://example.com/mcp', false), undefined);
    assert.equal(urlPolicyError('http://127.0.0.1:8787/mcp', false), undefined);
    assert.equal(urlPolicyError('http://localhost/mcp', false), undefined);
    assert.equal(urlPolicyError('http://[::1]:9/mcp', false), undefined);
    assert.equal(urlPolicyError('http://example.com/mcp', false), 'plain_http');
    assert.equal(urlPolicyError('http://example.com/mcp', true), undefined);
    assert.equal(urlPolicyError('not a url', false), 'invalid_url');
    assert.equal(isLoopbackHost('127.10.0.1'), true);
    assert.equal(isLoopbackHost('127.0.0.1.example.com'), false);
  });
});

test('--version matches package.json', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.equal(TOOL_VERSION, pkg.version);
  const r = await runMain(['--version']);
  assert.equal(r.stdout.trim(), pkg.version);
});
