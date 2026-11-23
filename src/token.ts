// 토큰 엔드포인트 호출(코드 교환·refresh grant)과 오류 분류.
// 진단 도구라서 응답을 예외로 바꾸지 않고 상태 코드·오류 코드를 그대로 보존한다.
import { asObject, request, type HttpResult } from './http.js';
import type { Transport } from './transport.js';

export type TokenErrorCode =
  | 'invalid_client'
  | 'invalid_grant'
  | 'invalid_scope'
  | 'invalid_target'
  | 'unsupported_grant_type'
  | 'server_error'
  | 'non_json'
  | 'network'
  | 'other';

export interface TokenError {
  code: TokenErrorCode;
  /** 고칠 설정 힌트 메시지 키 */
  hint: string;
  status: number;
  /** 서버가 보낸 error 값(있으면) */
  serverError?: string;
}

export interface TokenResponse {
  http: HttpResult;
  ok: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresIn?: number;
  error?: TokenError;
}

const KNOWN_ERRORS: TokenErrorCode[] = [
  'invalid_client', 'invalid_grant', 'invalid_scope', 'invalid_target', 'unsupported_grant_type',
];

/**
 * 토큰 엔드포인트 실패를 고유 코드로 분류한다. 우선순위:
 * 네트워크 실패 → 5xx → 본문이 JSON 이 아님 → OAuth error 값(RFC 6749 §5.2, RFC 8707) → 그 밖.
 */
export function classifyTokenError(res: Pick<HttpResult, 'reached' | 'status' | 'json'>): TokenError {
  if (!res.reached) return { code: 'network', hint: 'hint.token.network', status: 0 };
  const body = asObject(res.json);
  const serverError = typeof body?.error === 'string' ? body.error : undefined;
  const base = { status: res.status, ...(serverError ? { serverError } : {}) };
  if (res.status >= 500) return { code: 'server_error', hint: 'hint.token.server_error', ...base };
  if (!body) return { code: 'non_json', hint: 'hint.token.non_json', ...base };
  const known = KNOWN_ERRORS.find((e) => e === serverError);
  if (known) return { code: known, hint: `hint.token.${known}`, ...base };
  return { code: 'other', hint: 'hint.token.other', ...base };
}

export async function tokenRequest(
  endpoint: string,
  params: Record<string, string | undefined>,
  timeoutMs: number,
  transport?: Transport,
): Promise<TokenResponse> {
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) form.set(k, v);
  const http = await request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: form.toString(),
    timeoutMs,
    ...(transport ? { transport } : {}),
  });
  const body = asObject(http.json);
  const accessToken = typeof body?.access_token === 'string' ? body.access_token : undefined;
  if (http.status !== 200 || !accessToken) {
    return { http, ok: false, error: classifyTokenError(http) };
  }
  const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : undefined;
  const rawExpires = body?.expires_in;
  // 일부 서버는 숫자를 문자열로 준다 — 받아 주되 숫자로 바꾼다.
  const expiresIn = typeof rawExpires === 'number' ? rawExpires
    : typeof rawExpires === 'string' && /^\d+$/.test(rawExpires) ? Number(rawExpires) : undefined;
  return {
    http,
    ok: true,
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    ...(expiresIn !== undefined ? { expiresIn } : {}),
  };
}

/** 보고서용 근거: 토큰 원문 없이 상태·오류 코드만 */
export function tokenEvidence(r: TokenResponse): Record<string, unknown> {
  return {
    status: r.http.status,
    ...(r.error ? { classified: r.error.code, error: r.error.serverError ?? null } : {}),
    ...(r.ok ? { refresh_token_returned: Boolean(r.refreshToken), expires_in: r.expiresIn ?? null } : {}),
    ...(r.http.error ? { network: r.http.error } : {}),
  };
}
