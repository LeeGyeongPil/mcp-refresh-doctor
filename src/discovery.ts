// C01~C04: 토큰 없는 요청 → 401 도전(challenge) → 보호 자원 메타데이터(PRM, RFC 9728)
// → 인가 서버 메타데이터(RFC 8414, OIDC well-known 대체) → offline_access 광고 확인.
import { asObject, request, stringArray, type HttpResult } from './http.js';
import { TOOL_VERSION, type CheckResult } from './types.js';

// ---------------------------------------------------------------------------
// WWW-Authenticate 파서 (RFC 9110 §11.6.1)
//   Bearer realm="x", error="invalid_token", error_description="a, \"b\"", Basic realm=y
// 같은 헤더에 도전이 여러 개 올 수 있고, 값은 따옴표 문자열 또는 토큰이다.
// ---------------------------------------------------------------------------
export interface Challenge {
  scheme: string; // 소문자
  params: Record<string, string>; // 이름은 소문자
  token68?: string;
}

const TOKEN_CHAR = /[!#$%&'*+\-.^_`|~0-9A-Za-z]/;

export function parseWwwAuthenticate(header: string | null | undefined): Challenge[] {
  const out: Challenge[] = [];
  if (!header) return out;
  const s = header;
  let i = 0;
  let current: Challenge | undefined;

  const skipSpaces = (): void => {
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  };
  const readToken = (): string => {
    const start = i;
    while (i < s.length && TOKEN_CHAR.test(s[i] as string)) i++;
    return s.slice(start, i);
  };
  const readQuoted = (): string => {
    // 여는 따옴표 위치에서 호출. 역슬래시 이스케이프를 푼다.
    i++;
    let value = '';
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\' && i + 1 < s.length) i++;
      value += s[i];
      i++;
    }
    i++; // 닫는 따옴표
    return value;
  };

  while (i < s.length) {
    skipSpaces();
    if (s[i] === ',') {
      i++;
      continue;
    }
    const name = readToken();
    if (!name) {
      i++; // 알 수 없는 문자는 건너뛴다(파서는 절대 멈추지 않는다)
      continue;
    }
    skipSpaces();
    if (s[i] === '=') {
      // 매개변수(name=value) — 또는 token68 의 '=' 패딩
      i++;
      skipSpaces();
      if (s[i] === '=' || i >= s.length || s[i] === ',') {
        // "abc==" 같은 token68
        let pad = '=';
        while (s[i] === '=') {
          pad += '=';
          i++;
        }
        if (current && !current.token68 && Object.keys(current.params).length === 0) current.token68 = name + pad;
        continue;
      }
      const value = s[i] === '"' ? readQuoted() : readToken();
      if (current) current.params[name.toLowerCase()] = value;
      continue;
    }
    // '=' 가 따라오지 않는 토큰은 새 도전의 스킴이다.
    current = { scheme: name.toLowerCase(), params: {} };
    out.push(current);
  }
  return out;
}

export function bearerChallenge(header: string | null | undefined): Challenge | undefined {
  return parseWwwAuthenticate(header).find((c) => c.scheme === 'bearer');
}

// ---------------------------------------------------------------------------
// C01 — 토큰 없이 MCP initialize 를 보내 401 과 resource_metadata 를 확인
// ---------------------------------------------------------------------------
export const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 0,
  method: 'initialize',
  params: {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'mcp-refresh-doctor', version: TOOL_VERSION },
  },
});

export async function probeUnauthenticated(mcpUrl: string, timeoutMs: number): Promise<HttpResult> {
  return request(mcpUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: INITIALIZE_BODY,
    timeoutMs,
  });
}

export function evaluateUnauthenticated(res: HttpResult): CheckResult {
  const www = res.headers.get('www-authenticate');
  const bearer = bearerChallenge(www);
  const evidence = { status: res.status, wwwAuthenticate: www ?? null };
  if (res.status !== 401) {
    return { id: 'C01', status: 'FAIL', detail: 'c01.not_401', vars: { status: res.status }, hint: 'hint.c01_return_401', evidence };
  }
  if (bearer?.params.resource_metadata) {
    return { id: 'C01', status: 'PASS', detail: 'c01.ok', vars: { url: bearer.params.resource_metadata }, evidence };
  }
  return { id: 'C01', status: 'WARN', detail: 'c01.no_resource_metadata', hint: 'hint.c01_resource_metadata', evidence };
}

// ---------------------------------------------------------------------------
// C02 — 보호 자원 메타데이터(RFC 9728)
// ---------------------------------------------------------------------------
export interface FetchedDoc {
  url?: string; // 읽기에 성공한 주소
  doc?: Record<string, unknown>;
  tried: { url: string; status: number; error?: string }[];
}

/** RFC 9728 §3.1: 호스트와 경로 사이에 well-known 경로를 끼운 주소, 그다음 루트 주소 */
export function prmCandidates(mcpUrl: string, fromHeader?: string): string[] {
  const u = new URL(mcpUrl);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  const list = [];
  if (fromHeader) list.push(fromHeader);
  if (path) list.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  list.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return [...new Set(list)];
}

/** RFC 8414 §3.1 주소 → OIDC Discovery 주소 두 가지(경로 삽입형·경로 뒤 붙임형) */
export function asMetadataCandidates(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    ...(path ? [`${u.origin}${path}/.well-known/openid-configuration`] : []),
  ];
}

export async function fetchFirstJson(urls: string[], timeoutMs: number): Promise<FetchedDoc> {
  const tried: FetchedDoc['tried'] = [];
  for (const url of urls) {
    const res = await request(url, { headers: { accept: 'application/json' }, timeoutMs });
    tried.push({ url, status: res.status, ...(res.error ? { error: res.error } : {}) });
    const doc = asObject(res.json);
    if (res.status === 200 && doc) return { url, doc, tried };
  }
  return { tried };
}

export function evaluatePrm(fetched: FetchedDoc): CheckResult {
  const prm = fetched.doc;
  const evidence = { url: fetched.url ?? null, tried: fetched.tried.map((t) => `${t.url} -> ${t.error ?? t.status}`) };
  if (!prm) {
    return { id: 'C02', status: 'FAIL', detail: 'c02.unreadable', hint: 'hint.c02_publish_prm', evidence };
  }
  const servers = stringArray(prm.authorization_servers) ?? [];
  if (typeof prm.resource !== 'string' || servers.length === 0) {
    return { id: 'C02', status: 'FAIL', detail: 'c02.incomplete', hint: 'hint.c02_publish_prm', evidence };
  }
  const scopes = stringArray(prm.scopes_supported) ?? [];
  if (scopes.includes('offline_access')) {
    // SEP-2207: offline_access 는 자원 서버가 아니라 인가 서버 메타데이터에만 광고한다.
    return { id: 'C02', status: 'WARN', detail: 'c02.offline_access_in_prm', hint: 'hint.c02_offline_access', evidence };
  }
  return { id: 'C02', status: 'PASS', detail: 'c02.ok', vars: { resource: prm.resource }, evidence };
}

// ---------------------------------------------------------------------------
// C03 — 인가 서버가 refresh_token grant 를 광고하는가
// ---------------------------------------------------------------------------
export function evaluateAsMetadata(fetched: FetchedDoc): CheckResult {
  const meta = fetched.doc;
  const evidence: Record<string, unknown> = {
    url: fetched.url ?? null,
    tried: fetched.tried.map((t) => `${t.url} -> ${t.error ?? t.status}`),
  };
  if (!meta) {
    // 읽지 못한 것은 "서버가 갱신을 거부한다"는 증거가 아니므로 FAIL 이 아니라 SKIP + 진행 불가로 둔다.
    return { id: 'C03', status: 'SKIP', detail: 'c03.unreadable', evidence };
  }
  const grants = stringArray(meta.grant_types_supported);
  evidence.grant_types_supported = grants ?? null;
  if (!grants) {
    return { id: 'C03', status: 'WARN', detail: 'c03.missing', hint: 'hint.c03_advertise', evidence };
  }
  if (!grants.includes('refresh_token')) {
    return { id: 'C03', status: 'FAIL', detail: 'c03.no_refresh', vars: { grants: grants.join(' ') }, hint: 'hint.c03_enable_refresh', evidence };
  }
  return { id: 'C03', status: 'PASS', detail: 'c03.ok', evidence };
}

// ---------------------------------------------------------------------------
// C04 — offline_access 가 인가 서버 scopes_supported 에 있는가(있으면 요청에 덧붙인다)
// ---------------------------------------------------------------------------
export function evaluateOfflineAccess(meta: Record<string, unknown>): CheckResult {
  const scopes = stringArray(meta.scopes_supported) ?? [];
  if (scopes.includes('offline_access')) {
    return { id: 'C04', status: 'PASS', detail: 'c04.advertised' };
  }
  return { id: 'C04', status: 'WARN', detail: 'c04.not_advertised', hint: 'hint.c04_offline_access' };
}

/**
 * 요청할 스코프 고르기(MCP 인가 명세의 스코프 선택 + SEP-2207):
 * 사용자가 --scope 로 주면 그대로, 아니면 401 도전의 scope → PRM scopes_supported 순서.
 * 인가 서버가 offline_access 를 광고하면 덧붙인다.
 */
export function chooseScope(input: {
  override?: string;
  challengeScope?: string;
  prmScopes?: string[];
  asScopes?: string[];
}): string | undefined {
  if (input.override !== undefined) return input.override || undefined;
  const base = (input.challengeScope ? input.challengeScope.split(/\s+/) : input.prmScopes ?? [])
    .filter((s) => s && s !== 'offline_access');
  if (input.asScopes?.includes('offline_access')) base.push('offline_access');
  return base.length > 0 ? [...new Set(base)].join(' ') : undefined;
}
