// 여러 모듈이 함께 쓰는 자료형. 검사 결과는 "메시지 키 + 변수"로만 담고,
// 실제 문장은 보고서를 그릴 때 언어(en/ko)에 맞춰 만든다.

export type Status = 'PASS' | 'WARN' | 'FAIL' | 'SKIP';

export const CHECK_IDS = [
  'C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08',
  'C09', 'C10', 'C11', 'C12', 'C13', 'C14', 'C15',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export type Vars = Record<string, string | number>;

export interface CheckResult {
  id: CheckId;
  status: Status;
  /** 결과 설명 메시지 키(messages/*.ts 의 키) */
  detail: string;
  vars?: Vars;
  /** 고칠 설정 힌트 메시지 키 */
  hint?: string;
  /** 원시 근거(상태 코드·오류 코드 등). 토큰 원문은 넣지 않는다. */
  evidence?: Record<string, unknown>;
}

/** 발견·등록·로그인 단계에서 더 진행하지 못한 경우 */
export type BlockedStage = 'discovery' | 'registration' | 'login';
export interface Blocked {
  stage: BlockedStage;
  detail: string;
  vars?: Vars;
}

export interface RunResult {
  target: string;
  startedAt: string;
  durationMs: number;
  checks: CheckResult[];
  blocked?: Blocked;
}

export type Verdict = 'server' | 'client' | 'inconclusive';

export interface VerdictResult {
  verdict: Verdict;
  exitCode: 0 | 1 | 2;
  /** 판정 근거가 된 검사 ID(FAIL 등) */
  reasons: CheckId[];
  /** 고칠 설정 힌트 메시지 키(중복 없이, 검사 순서대로) */
  fixes: string[];
}

/** package.json 의 version 과 같아야 한다(test/cli.test.ts 가 확인) */
export const TOOL_VERSION = '0.1.0';
