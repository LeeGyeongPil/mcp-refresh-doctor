// 안전장치와 인자 오류 — 루프백이 아닌 평문 http·원격 --auto-consent·잘못된 인자는 종료 2 와 고른 언어의 안내로 끝난다.
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

  // 아래 경우는 모두 요청·소켓을 열기 전에 끝나야 한다 — 열면 no-network 가드가 이 파일을 실패시킨다.
  const enEnv = cleanEnv({ LANG: 'en_US.UTF-8' });

  await t.test('an extra positional argument is a usage error, not silently ignored', async () => {
    const check = await runMain(['check', 'https://example.com/mcp', 'extra'], enEnv);
    assert.equal(check.code, 2);
    assert.match(check.stderr, /unexpected extra argument "extra" for check/);
    assert.equal(check.stdout, '');
    const serve = await runMain(['serve', 'good'], enEnv);
    assert.equal(serve.code, 2);
    assert.match(serve.stderr, /unexpected extra argument "good" for serve/);
    const demo = await runMain(['demo', 'now', '--lang', 'ko'], cleanEnv());
    assert.equal(demo.code, 2);
    assert.match(demo.stderr, /demo 명령에 쓰지 않는 인자 "now"/);
  });

  await t.test('an out-of-range port gets a localized message, not the raw Node error', async () => {
    for (const args of [
      ['serve', '--port', '99999'],
      ['serve', '--port', '8787.5'],
      ['check', 'https://example.com/mcp', '--client-id', 'abc', '--redirect-port', '70000'],
    ]) {
      const en = await runMain(args, enEnv);
      assert.equal(en.code, 2, args.join(' '));
      assert.match(en.stderr, /needs a whole number from 0 to 65535/);
      assert.equal(/options\.port|Received/.test(en.stderr), false, en.stderr);
      const ko = await runMain([...args, '--lang', 'ko'], cleanEnv());
      assert.equal(ko.code, 2);
      assert.match(ko.stderr, /0~65535 사이의 정수가 필요합니다/);
    }
  });

  await t.test('a negative number is reported as negative, not as a missing value', async () => {
    for (const [opt, value] of [['--ttl', '-1'], ['--max-wait', '-5'], ['--ttl=-1', undefined]] as const) {
      const args = value === undefined ? ['serve', opt] : ['serve', opt, value];
      const r = await runMain(args, enEnv);
      assert.equal(r.code, 2, args.join(' '));
      assert.match(r.stderr, /needs a non-negative number/);
      assert.equal(/needs a value/.test(r.stderr), false, r.stderr);
    }
    const port = await runMain(['serve', '--port', '-1', '--lang', 'ko'], cleanEnv());
    assert.equal(port.code, 2);
    assert.match(port.stderr, /--port 에는 0~65535 사이의 정수가 필요합니다/);
    // 숫자가 아닌 다음 옵션이 오면 여전히 "값이 필요하다"고 안내한다.
    const missing = await runMain(['serve', '--ttl', '--lang', 'en'], enEnv);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /option --ttl needs a value/);
  });

  await t.test('--timeout 0 is refused (every request would time out at once)', async () => {
    const r = await runMain(['check', 'https://example.com/mcp', '--timeout', '0'], enEnv);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--timeout needs a number greater than 0/);
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
