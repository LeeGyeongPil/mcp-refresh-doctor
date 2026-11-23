// 보고서 그리기: 사람이 읽는 텍스트 표와 이슈에 붙이는 JSON.
// 마지막에 Redactor.scrub 을 한 번 더 거쳐 토큰·코드·client_id 원문이 절대 남지 않게 한다.
import type { Lang, Translate } from './i18n.js';
import type { Redactor } from './mask.js';
import type { CheckResult, RunResult, VerdictResult } from './types.js';

import { TOOL_VERSION } from './types.js';
export { TOOL_VERSION };

export function checkTitle(t: Translate, c: CheckResult): string {
  return t(`title.${c.id}`);
}

export function checkDetail(t: Translate, c: CheckResult): string {
  return t(c.detail, c.vars);
}

export function renderText(run: RunResult, verdict: VerdictResult, t: Translate, red: Redactor): string {
  const lines: string[] = [];
  lines.push(t('report.title', { target: run.target }), '');
  for (const c of run.checks) {
    lines.push(`  ${c.id}  ${c.status.padEnd(4)}  ${checkTitle(t, c)}`);
    lines.push(`             ${checkDetail(t, c)}`);
  }
  lines.push('');
  if (run.blocked) {
    const stage = t(`stage.${run.blocked.stage}`);
    lines.push(`${t('report.blocked', { stage })}: ${t(run.blocked.detail, run.blocked.vars)}`);
  }
  lines.push(`${t('report.verdict')}: ${t(`verdict.label.${verdict.verdict}`)} (exit ${verdict.exitCode})`);
  lines.push(`  ${t(`verdict.${verdict.verdict}`)}`);
  if (verdict.reasons.length > 0) {
    lines.push(`${t('report.reasons')}:`);
    for (const id of verdict.reasons) {
      const c = run.checks.find((x) => x.id === id);
      if (c) lines.push(`  ${c.id} ${c.status} — ${checkDetail(t, c)}`);
    }
  }
  if (verdict.fixes.length > 0) {
    lines.push(`${t('report.fixes')}:`);
    for (const key of verdict.fixes) lines.push(`  - ${t(key)}`);
  }
  lines.push(t('report.duration', { seconds: (run.durationMs / 1000).toFixed(1) }));
  return red.scrub(lines.join('\n'));
}

export interface JsonReport {
  tool: string;
  version: string;
  lang: Lang;
  target: string;
  startedAt: string;
  durationMs: number;
  verdict: {
    verdict: VerdictResult['verdict'];
    exitCode: number;
    label: string;
    summary: string;
    reasons: string[];
    fixes: { key: string; text: string }[];
  };
  blocked?: { stage: string; detail: string };
  checks: { id: string; status: string; title: string; detail: string; evidence?: Record<string, unknown> }[];
}

export function buildJsonReport(run: RunResult, verdict: VerdictResult, lang: Lang, t: Translate, red: Redactor): JsonReport {
  const report: JsonReport = {
    tool: 'mcp-refresh-doctor',
    version: TOOL_VERSION,
    lang,
    target: run.target,
    startedAt: run.startedAt,
    durationMs: run.durationMs,
    verdict: {
      verdict: verdict.verdict,
      exitCode: verdict.exitCode,
      label: t(`verdict.label.${verdict.verdict}`),
      summary: t(`verdict.${verdict.verdict}`),
      reasons: verdict.reasons,
      fixes: verdict.fixes.map((key) => ({ key, text: t(key) })),
    },
    ...(run.blocked ? { blocked: { stage: run.blocked.stage, detail: t(run.blocked.detail, run.blocked.vars) } } : {}),
    checks: run.checks.map((c) => ({
      id: c.id,
      status: c.status,
      title: checkTitle(t, c),
      detail: checkDetail(t, c),
      ...(c.evidence ? { evidence: c.evidence } : {}),
    })),
  };
  // 직렬화 → 가림 → 다시 해석: 어느 필드에 섞여 들어온 원문이든 한 번에 지운다.
  return JSON.parse(red.scrub(JSON.stringify(report))) as JsonReport;
}

// ── 표 정렬(한글은 화면에서 두 칸) ───────────────────────────────────
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    width += wide ? 2 : 1;
  }
  return width;
}

export function padDisplay(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}
