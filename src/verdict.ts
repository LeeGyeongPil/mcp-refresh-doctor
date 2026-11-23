// 결정적 판정 규칙표. 같은 검사 결과 → 언제나 같은 판정.
//
//   1) 아래 "서버 원인 검사" 중 FAIL 이 하나라도 있으면  → server       (종료 1)
//   2) 그렇지 않고 발견·등록·로그인 단계에서 멈췄거나
//      로그인 뒤 요청이 응답을 받지 못했으면(네트워크)     → inconclusive (종료 2)
//   3) 그 밖(WARN 은 표시만)                              → client       (종료 0)
//
// 서버 FAIL 을 먼저 보는 이유: 중간에 멈췄더라도 이미 확인된 서버 결함은 사실이기 때문이다.
import type { CheckId, RunResult, VerdictResult } from './types.js';

/** FAIL 이면 "서버가 조용한 갱신을 받아 줄 수 없다"는 직접 증거가 되는 검사 */
export const SERVER_DECISIVE: readonly CheckId[] = ['C03', 'C06', 'C08', 'C09', 'C12', 'C13', 'C15'];

export function decideVerdict(run: Pick<RunResult, 'checks' | 'blocked'>): VerdictResult {
  const serverFails = run.checks
    .filter((c) => c.status === 'FAIL' && SERVER_DECISIVE.includes(c.id))
    .map((c) => c.id);

  // 고칠 설정: FAIL·WARN 검사의 힌트를 검사 순서대로, 중복 없이
  const fixes: string[] = [];
  for (const c of run.checks) {
    if ((c.status === 'FAIL' || c.status === 'WARN') && c.hint && !fixes.includes(c.hint)) fixes.push(c.hint);
  }

  if (serverFails.length > 0) {
    return { verdict: 'server', exitCode: 1, reasons: serverFails, fixes };
  }
  if (run.blocked) {
    const hint = `hint.blocked.${run.blocked.stage}`;
    if (!fixes.includes(hint)) fixes.push(hint);
    return { verdict: 'inconclusive', exitCode: 2, reasons: [], fixes };
  }
  fixes.push('hint.client_side');
  const warned = run.checks.filter((c) => c.status === 'WARN').map((c) => c.id);
  return { verdict: 'client', exitCode: 0, reasons: warned, fixes };
}
