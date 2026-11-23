// C05 — 동적 클라이언트 등록(RFC 7591).
// 사용자의 실제 클라이언트와 섞이지 않도록 "시험용 공개 클라이언트"를 따로 등록한다.
import { asObject, request, stringArray } from './http.js';
import type { Transport } from './transport.js';
import type { CheckResult } from './types.js';

export interface Registration {
  result: CheckResult;
  clientId?: string;
}

export async function registerClient(
  meta: Record<string, unknown>,
  redirectUri: string,
  scope: string | undefined,
  timeoutMs: number,
  transport?: Transport,
): Promise<Registration> {
  const endpoint = typeof meta.registration_endpoint === 'string' ? meta.registration_endpoint : undefined;
  if (!endpoint) {
    return { result: { id: 'C05', status: 'FAIL', detail: 'c05.unsupported', hint: 'hint.c05_use_client_id' } };
  }
  const body = {
    client_name: 'mcp-refresh-doctor (test client)',
    redirect_uris: [redirectUri],
    // SEP-2207: 갱신 토큰을 받을 의사를 grant_types 로 알린다.
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(scope ? { scope } : {}),
  };
  const res = await request(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    timeoutMs,
    ...(transport ? { transport } : {}),
  });
  const doc = asObject(res.json);
  const clientId = typeof doc?.client_id === 'string' ? doc.client_id : undefined;
  if (!res.reached || res.status < 200 || res.status >= 300 || !clientId) {
    const error = res.error ?? (typeof doc?.error === 'string' ? doc.error : `http_${res.status}`);
    return {
      result: {
        id: 'C05', status: 'FAIL', detail: 'c05.failed', vars: { status: res.status, error },
        hint: 'hint.c05_use_client_id', evidence: { status: res.status, error },
      },
    };
  }
  const authMethod = typeof doc?.token_endpoint_auth_method === 'string' ? doc.token_endpoint_auth_method : 'none';
  const grants = stringArray(doc?.grant_types);
  const evidence = { status: res.status, grant_types: grants ?? null, token_endpoint_auth_method: authMethod };
  if (authMethod !== 'none') {
    // 기밀 클라이언트로 바뀌어 버리면 이 도구(M1, 공개 클라이언트만)로는 공정하게 시험할 수 없다.
    return {
      clientId,
      result: { id: 'C05', status: 'WARN', detail: 'c05.confidential', vars: { method: authMethod }, evidence },
    };
  }
  if (!grants) {
    return { clientId, result: { id: 'C05', status: 'WARN', detail: 'c05.no_grant_types', hint: 'hint.c05_keep_refresh', evidence } };
  }
  if (!grants.includes('refresh_token')) {
    return {
      clientId,
      result: { id: 'C05', status: 'WARN', detail: 'c05.dropped_refresh', vars: { grants: grants.join(' ') }, hint: 'hint.c05_keep_refresh', evidence },
    };
  }
  return { clientId, result: { id: 'C05', status: 'PASS', detail: 'c05.ok', evidence } };
}
