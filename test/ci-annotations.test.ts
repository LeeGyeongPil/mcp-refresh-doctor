// CI 전용 reporter(.github/test-annotations.mjs) 확인: 실패한 테스트가 GitHub 주석 한 줄로 바뀌고,
// 이상한 입력에도 예외를 던지지 않는다(reporter 가 깨지면 그 자체가 CI 실패 원인이 되므로).
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';

interface ReporterModule {
  default: (source: AsyncIterable<unknown>) => AsyncGenerator<string>;
  annotationFor: (data: unknown, stderrTail?: string) => string | undefined;
  escapeData: (text: string) => string;
}

// dist-test/test/ 에서 저장소 루트의 .github/ 로
const reporterUrl = new URL('../../.github/test-annotations.mjs', import.meta.url);
const load = async (): Promise<ReporterModule> => (await import(reporterUrl.href)) as ReporterModule;

const failure = (name: string, message: string, extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const err = new Error('test failed') as Error & { cause?: unknown; failureType?: string };
  err.cause = new Error(message);
  err.failureType = 'testCodeFailure';
  return { name, file: resolve('dist-test/test/x.test.js'), details: { error: err }, ...extra };
};

test('a failed test becomes one GitHub error annotation with escaped title and message', async () => {
  const { annotationFor } = await load();
  const line = annotationFor(failure('good → exit 0, verdict client', '{\n  "exit": 1\n}\n100% done'));
  assert.ok(line);
  assert.match(line, /^\n::error title=test failed%3A x\.test\.js > good → exit 0%2C verdict client::/);
  // 본문의 줄바꿈·% 는 이스케이프되어 명령이 한 줄로 남는다
  assert.equal(line.trim().includes('\n'), false);
  assert.match(line, /%0A {2}"exit": 1%0A}%0A100%25 done/);
});

test('a parent that failed only because of its subtests gets no annotation', async () => {
  const { annotationFor } = await load();
  const err = Object.assign(new Error('1 subtest failed'), { failureType: 'subtestsFailed' });
  assert.equal(annotationFor({ name: 'group', details: { error: err } }), undefined);
});

test('a test file that crashed carries the end of its stderr', async () => {
  const { annotationFor } = await load();
  const crashed = { name: 'dist-test/test/x.test.js', details: { error: Object.assign(new Error('x'), { cause: 'test failed' }) } };
  const line = annotationFor(crashed, 'Error [ERR_MODULE_NOT_FOUND]: Cannot find module');
  assert.match(line ?? '', /test file failed; last stderr:%0AError \[ERR_MODULE_NOT_FOUND\]/);
});

test('the long message is cut and odd events never throw', async () => {
  const mod = await load();
  const long = mod.annotationFor(failure('long', 'x'.repeat(10_000))) ?? '';
  assert.ok(long.length < 3_500, `length ${long.length}`);

  async function* events(): AsyncGenerator<unknown> {
    yield { type: 'test:stderr', data: { file: 'dist-test/test/x.test.js', message: 'boom on stderr\n' } };
    yield { type: 'test:pass', data: { name: 'ok' } };
    yield null;
    yield { type: 'test:fail' };
    yield { type: 'test:fail', data: { name: 'crash', file: resolve('dist-test/test/x.test.js'), details: { error: { cause: 'test failed' } } } };
    yield { type: 'test:fail', data: failure('real', 'assertion text') };
  }
  const lines: string[] = [];
  for await (const line of mod.default(events())) lines.push(line);
  assert.equal(lines.length, 3);
  // 상대 경로(표준 오류 이벤트)와 절대 경로(실패 이벤트)가 같은 파일로 묶인다
  assert.match(lines[1] ?? '', /last stderr:%0Aboom on stderr/);
  assert.match(lines[2] ?? '', /assertion text/);
  assert.equal(mod.escapeData('a%b\r\nc'), 'a%25b%0D%0Ac');
});
