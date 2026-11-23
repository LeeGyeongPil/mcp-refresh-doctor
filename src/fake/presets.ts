// 연습용 목(mock) 서버의 고장 프리셋 6종.
// 특정 회사 서버가 아니라, 보고된 사례에서 확인된 "증상"을 재현한다(research.md 5·7절).
import type { CheckId, Status, Verdict } from '../types.js';

export interface PresetBehavior {
  /** 코드 교환·갱신 때 갱신 토큰을 주는가(인가 서버 메타데이터 광고도 이에 맞춘다) */
  issueRefreshToken: boolean;
  /** 갱신할 때마다 새 갱신 토큰을 주고 이전 것을 무효화하는가 */
  rotate: boolean;
  /** 이미 쓴 갱신 토큰이 다시 오면 가족 전체를 폐기하는가 */
  detectReuse: boolean;
  /** 코드 교환은 공개 클라이언트로 받아 주면서 갱신에서만 클라이언트 인증을 요구하는가 */
  refreshRequiresSecret: boolean;
  /** 갱신 요청에 resource 가 없으면 invalid_target 으로 거부하는가 */
  requireResourceOnRefresh: boolean;
  /** 무효·만료 토큰에 돌려주는 상태 코드 */
  invalidTokenStatus: 401 | 403;
}

export interface PresetExpectation {
  verdict: Verdict;
  /** 반드시 이 상태여야 하는 검사 */
  statuses: Partial<Record<CheckId, Status>>;
}

export interface Preset {
  behavior: PresetBehavior;
  expected: PresetExpectation;
}

const GOOD: PresetBehavior = {
  issueRefreshToken: true,
  rotate: true,
  detectReuse: true,
  refreshRequiresSecret: false,
  requireResourceOnRefresh: false,
  invalidTokenStatus: 401,
};

export const PRESETS = {
  // 표준대로 동작 — 반복 재로그인이 보이면 클라이언트 쪽 원인
  good: {
    behavior: GOOD,
    expected: {
      verdict: 'client',
      statuses: {
        C01: 'PASS', C02: 'PASS', C03: 'PASS', C04: 'PASS', C05: 'PASS', C06: 'PASS', C07: 'PASS',
        C08: 'PASS', C09: 'PASS', C10: 'PASS', C11: 'PASS', C12: 'PASS', C13: 'PASS', C14: 'PASS',
      },
    },
  },
  // 갱신 토큰을 아예 주지 않음(보고 사례: 8시간마다 전체 재인증)
  'no-refresh': {
    behavior: { ...GOOD, issueRefreshToken: false },
    expected: { verdict: 'server', statuses: { C03: 'FAIL', C06: 'FAIL', C09: 'SKIP' } },
  },
  // 만료 토큰에 403(WWW-Authenticate 없음) — 클라이언트가 갱신을 시작할 신호가 없다
  'expired-403': {
    behavior: { ...GOOD, invalidTokenStatus: 403 },
    expected: { verdict: 'server', statuses: { C09: 'PASS', C13: 'FAIL' } },
  },
  // 회전 없음 + 재사용 허용 — OAuth 2.1 위반 소지(경고)지만 재로그인 원인은 아님
  'no-rotation': {
    behavior: { ...GOOD, rotate: false, detectReuse: false },
    expected: { verdict: 'client', statuses: { C09: 'PASS', C11: 'WARN', C14: 'SKIP' } },
  },
  // 갱신 grant 에서만 클라이언트 비밀 요구(invalid_client)
  'refresh-needs-secret': {
    behavior: { ...GOOD, refreshRequiresSecret: true },
    expected: { verdict: 'server', statuses: { C06: 'PASS', C09: 'FAIL' } },
  },
  // 갱신 요청에 resource(RFC 8707)가 꼭 있어야 함 — 빠뜨리는 클라이언트만 실패
  'resource-required': {
    behavior: { ...GOOD, requireResourceOnRefresh: true },
    expected: { verdict: 'client', statuses: { C09: 'PASS', C10: 'WARN' } },
  },
} satisfies Record<string, Preset>;

export type PresetName = keyof typeof PRESETS;
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

export function isPresetName(name: string): name is PresetName {
  return Object.hasOwn(PRESETS, name);
}
