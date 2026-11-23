// demo: 연습용 목(mock) 서버를 프리셋마다 만들고, check 와 똑같은 엔진(runChecks)으로 점검한다.
// 목은 in-process 로 돈다 — 소켓·포트·자식 프로세스 없이 handler 를 직접 부르고, 시각은 수동 시계다.
// 그래도 결과는 고정 출력이 아니다: DCR·PKCE·회전·재사용 감지·만료를 handler 가 실제로 수행한 결과다.
// (같은 목을 실제 HTTP 로 띄우려면 `serve --preset <이름>`)
import { runChecks } from './checks.js';
import { createFakeHandler, type FakeHandler } from './fake/handler.js';
import { createInProcessTransport, createManualClock, type Fault, type FaultRequest, type ManualClock, type Route } from './fake/inprocess.js';
import { PRESET_NAMES, PRESETS, type PresetName } from './fake/presets.js';
import type { Translate } from './i18n.js';
import { Redactor } from './mask.js';
import { displayWidth, padDisplay } from './report.js';
import type { RunResult, Verdict, VerdictResult } from './types.js';
import { decideVerdict } from './verdict.js';

export interface DemoRow {
  preset: PresetName;
  verdict: Verdict;
  exitCode: number;
  expectedVerdict: Verdict;
  matchesExpected: boolean;
  /** FAIL·WARN 검사(표에 보여 줄 발견 사항) */
  findings: { id: string; status: string; detail: string }[];
  checks: { id: string; status: string }[];
}

export interface PresetRunOptions {
  redactor?: Redactor;
  /** C15: 실제 만료까지 "기다리기"(수동 시계라 즉시 끝난다) */
  waitExpiry?: boolean;
  maxWaitSec?: number;
  /** 액세스 토큰 수명(초). 기본 3600 */
  ttlSec?: number;
  mcpResponseMode?: 'json' | 'sse';
  /** 목 서버 요청 로그 */
  log?: (line: string) => void;
  /** 발급한 비밀 원문 모으기(가림 시험용) */
  trackSecrets?: boolean;
  /** 고장 주입(시험용) */
  faults?: (req: FaultRequest) => Fault | undefined;
  /** handler 앞에 끼워 특정 응답을 바꾸는 함수(시험용). 없으면 handler 그대로 */
  wrap?: (handle: Route) => Route;
  clock?: ManualClock;
  /** auto-consent 대신 로그인 대기(시험용) */
  autoConsent?: boolean;
  loginTimeoutSec?: number;
}

export interface PresetRun {
  run: RunResult;
  verdict: VerdictResult;
  fake: FakeHandler;
  clock: ManualClock;
}

export async function runPreset(preset: PresetName, options: PresetRunOptions = {}): Promise<PresetRun> {
  const clock = options.clock ?? createManualClock();
  const fake = createFakeHandler({
    preset,
    now: clock.now,
    ...(options.ttlSec !== undefined ? { ttlSec: options.ttlSec } : {}),
    ...(options.mcpResponseMode ? { mcpResponseMode: options.mcpResponseMode } : {}),
    ...(options.log ? { log: options.log } : {}),
    ...(options.trackSecrets ? { trackSecrets: true } : {}),
  });
  const handle: Route = (req) => fake.handle(req);
  const transport = createInProcessTransport({
    routes: { [fake.base]: options.wrap ? options.wrap(handle) : handle },
    clock,
    ...(options.faults ? { faults: options.faults } : {}),
  });
  const run = await runChecks({
    url: fake.mcpUrl,
    autoConsent: options.autoConsent ?? true,
    openBrowser: false,
    timeoutSec: 10,
    ...(options.loginTimeoutSec !== undefined ? { loginTimeoutSec: options.loginTimeoutSec } : {}),
    ...(options.waitExpiry ? { waitExpiry: true } : {}),
    ...(options.maxWaitSec !== undefined ? { maxWaitSec: options.maxWaitSec } : {}),
    redactor: options.redactor ?? new Redactor(),
    transport,
  });
  return { run, verdict: decideVerdict(run), fake, clock };
}

export async function runDemo(): Promise<DemoRow[]> {
  const rows: DemoRow[] = [];
  for (const preset of PRESET_NAMES) {
    const { run, verdict } = await runPreset(preset);
    const expected = PRESETS[preset].expected;
    const statusesOk = Object.entries(expected.statuses)
      .every(([id, status]) => run.checks.find((c) => c.id === id)?.status === status);
    rows.push({
      preset,
      verdict: verdict.verdict,
      exitCode: verdict.exitCode,
      expectedVerdict: expected.verdict,
      matchesExpected: verdict.verdict === expected.verdict && statusesOk,
      findings: run.checks
        .filter((c) => c.status === 'FAIL' || c.status === 'WARN')
        .map((c) => ({ id: c.id, status: c.status, detail: c.detail })),
      checks: run.checks.map((c) => ({ id: c.id, status: c.status })),
    });
  }
  return rows;
}

export function renderDemoTable(rows: DemoRow[], t: Translate): string {
  const head = [t('demo.col_preset'), t('demo.col_verdict'), t('demo.col_findings')];
  const body = rows.map((r) => [
    r.preset,
    `${t(`verdict.label.${r.verdict}`)} (${r.exitCode})`,
    r.findings.length === 0 ? t('demo.all_pass') : r.findings.map((f) => `${f.id} ${f.status}`).join(', '),
  ]);
  const widths = [0, 1].map((i) => Math.max(...[head, ...body].map((cells) => displayWidth(cells[i] ?? ''))));
  const line = (cells: string[]): string =>
    `  ${padDisplay(cells[0] ?? '', widths[0] ?? 0)}  ${padDisplay(cells[1] ?? '', widths[1] ?? 0)}  ${cells[2] ?? ''}`;
  const out = [t('demo.banner'), '', line(head), line(head.map((h) => '-'.repeat(displayWidth(h))))];
  for (const cells of body) out.push(line(cells));
  const ok = rows.filter((r) => r.matchesExpected).length;
  out.push('');
  for (const r of rows) {
    if (!r.matchesExpected) out.push(`  ${r.preset}: ${t('demo.expected_bad', { expected: r.expectedVerdict })}`);
  }
  out.push(t('demo.summary', { ok, total: rows.length }));
  return out.join('\n');
}
