// CI 와 같은 조건에서 결정적인가.
//  (a) .github/workflows/ci.yml 의 형태 — job 1개, matrix 없음, Node 22 한 번, 짧은 상한, e2e·schedule 없음, test:ci | tee
//  (b) 단위 시험 안에서는 소켓·자식 프로세스를 열 수 없다(가드)
// YAML 해석기를 의존성으로 들이지 않으려고, 이 파일 하나의 들여쓰기 규칙에 맞춘 줄 단위 검사로 본다.
import './support/no-network.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import { runChecks } from '../src/checks.js';
import { realTransport } from '../src/transport.js';
import { GUARD_MESSAGE, takeViolations } from './support/no-network.js';

// 시험은 dist-test/test/ 에서 돈다 → 레포 루트는 두 단계 위
const root = new URL('../../', import.meta.url);
// 주석 줄(# …)은 빼고 본다 — 설명 주석에 "test:e2e" 같은 낱말이 나와도 실제 설정이 아니다
const lines = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8')
  .split('\n')
  .filter((l) => !l.trim().startsWith('#'));
const workflow = lines.join('\n');

/** 들여쓰기가 indent 칸인 "키:" 줄의 키 목록(주석·빈 줄 제외) */
function keysAt(indent: number, from = 0, to = lines.length): string[] {
  const out: string[] = [];
  for (let i = from; i < to; i++) {
    const m = /^( *)([A-Za-z0-9_-]+):/.exec(lines[i] ?? '');
    if (m && m[1]?.length === indent) out.push(m[2] ?? '');
  }
  return out;
}

/** steps: 아래의 단계들(각 단계는 "      - " 로 시작하는 줄부터 다음 단계 전까지) */
function steps(): string[] {
  const start = lines.findIndex((l) => /^ {4}steps:/.test(l));
  assert.ok(start >= 0, 'steps: found');
  const blocks: string[] = [];
  let current: string[] | undefined;
  for (const line of lines.slice(start + 1)) {
    if (/^ {6}- /.test(line)) {
      if (current) blocks.push(current.join('\n'));
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current.join('\n'));
  return blocks;
}

test('workflow shape', async (t) => {
  await t.test('one job, no matrix, Node 22 exactly once', () => {
    const jobsLine = lines.findIndex((l) => l === 'jobs:');
    assert.ok(jobsLine >= 0);
    assert.deepEqual(keysAt(2, jobsLine + 1), ['test']);
    assert.equal(/\bmatrix\b/.test(workflow), false, 'no matrix');
    const versions = workflow.match(/node-version:\s*(\S+)/g) ?? [];
    assert.deepEqual(versions, ['node-version: 22']);
  });

  await t.test('bounded: job timeout <= 10 minutes and every run step has its own timeout', () => {
    const job = /^ {4}timeout-minutes:\s*(\d+)/m.exec(workflow);
    assert.ok(job, 'job timeout-minutes');
    assert.ok(Number(job[1]) <= 10, `job timeout ${job[1]}`);
    const runSteps = steps().filter((s) => /^\s+run:/m.test(s) || /^ {6}- run:/m.test(s));
    assert.ok(runSteps.length >= 6, `run steps: ${runSteps.length}`);
    for (const s of runSteps) {
      const m = /timeout-minutes:\s*(\d+)/.exec(s);
      assert.ok(m, `step has timeout-minutes:\n${s}`);
      assert.ok(Number(m[1]) <= 3, `step timeout <= 3:\n${s}`);
    }
  });

  await t.test('runs test:ci through tee with pipefail bash, never e2e or a schedule', () => {
    assert.match(workflow, /^ {8}shell: bash/m);
    assert.match(workflow, /run: npm run test:ci 2>&1 \| tee test-output\.tap/);
    assert.equal(workflow.includes('test:e2e'), false);
    assert.equal(/^\s*schedule:/m.test(workflow), false);
    assert.match(workflow, /if: failure\(\)/);
    assert.match(workflow, /GITHUB_STEP_SUMMARY/);
    // 첫 run 단계가 환경 표시다 — 단계 목록이 비어 있으면 job 이 시작되지 않은 것으로 구분된다
    const firstRun = steps().find((s) => /run:/.test(s));
    assert.match(firstRun ?? '', /name: Show environment/);
  });

  await t.test('actions are pinned to existing major tags', () => {
    const uses = workflow.match(/uses:\s*(\S+)/g) ?? [];
    assert.deepEqual(uses, ['uses: actions/checkout@v6', 'uses: actions/setup-node@v6']);
  });

  await t.test('package.json: npm test and test:ci run the same files and options; e2e is separate; engines >=22', () => {
    const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
      scripts: Record<string, string>;
      engines: { node: string };
    };
    const testRun = pkg.scripts.test?.replace('npm run build && npm run build:test && ', '');
    const ciRun = pkg.scripts['test:ci']?.replace(' --test-reporter=tap', '');
    assert.equal(testRun, ciRun);
    assert.match(ciRun ?? '', /--test-concurrency=1/);
    assert.match(ciRun ?? '', / dist-test\/test\/\*\.test\.js$/);
    assert.match(pkg.scripts['test:e2e'] ?? '', / dist-test\/test\/e2e\/\*\.test\.js$/);
    assert.equal(pkg.engines.node, '>=22');
  });

  await t.test('every unit test file turns the socket guard on first and imports no socket/process modules', () => {
    const dir = new URL('test/', root);
    const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts'));
    assert.ok(files.length >= 9, files.join(' '));
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      const firstImport = src.split('\n').find((l) => l.startsWith('import '));
      assert.equal(firstImport, "import './support/no-network.js';", f);
      if (f === 'ci-workflow.test.ts') continue; // 가드 자체를 시험하므로 예외
      assert.equal(/from 'node:(http|net|child_process)'/.test(src), false, `${f} imports a socket or process module`);
      assert.equal(src.includes('fake/server.js'), false, `${f} must use the in-process mock, not the HTTP server`);
    }
  });
});

test('unit tests cannot open sockets', async () => {
  takeViolations(); // 앞에서 쌓인 것이 없음을 전제로 비운다
  const blocked = new RegExp(GUARD_MESSAGE);
  await assert.rejects(fetch('http://127.0.0.1:1/'), blocked);
  await assert.rejects(realTransport.fetch('http://127.0.0.1:1/', {}), blocked, 'the real transport looks up fetch at call time');
  assert.throws(() => createServer().listen(0, '127.0.0.1'), blocked);
  assert.throws(() => net.connect(1, '127.0.0.1'), blocked);
  assert.throws(() => spawn(process.execPath, ['--version']), blocked);
  // 엔진에 전송을 넣는 것을 잊으면(실제 네트워크) 발견 단계에서 가드 메시지와 함께 멈춘다
  const run = await runChecks({ url: 'http://127.0.0.1:1/mcp', autoConsent: true, timeoutSec: 5 });
  assert.equal(run.blocked?.stage, 'discovery');
  assert.match(String(run.blocked?.vars?.error), blocked);
  const seen = takeViolations();
  assert.equal(seen.length, 6, seen.join('\n'));
  // 여기서 비웠으므로 파일 끝 after 훅은 통과한다. 비우지 않았다면 그 훅이 막힌 호출 목록과 함께 실패한다.
});
