// demo: 연습용 목(mock) 서버를 프리셋마다 실제로 띄우고, check 와 똑같은 엔진으로 점검한다.
// 키·계정·네트워크가 필요 없고, 결과는 고정 출력이 아니라 실제 HTTP 왕복에서 나온다.
import { runChecks } from './checks.js';
import { startFakeServer } from './fake/server.js';
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

export async function runPreset(preset: PresetName, redactor = new Redactor()): Promise<{ run: RunResult; verdict: VerdictResult }> {
  const server = await startFakeServer({ preset });
  try {
    const run = await runChecks({
      url: server.mcpUrl,
      autoConsent: true,
      openBrowser: false,
      timeoutSec: 10,
      loginTimeoutSec: 10,
      redactor,
    });
    return { run, verdict: decideVerdict(run) };
  } finally {
    await server.close(); // 프리셋마다 서버를 닫아 포트·소켓을 남기지 않는다
  }
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
