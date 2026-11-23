// 검사 C01~C15 를 순서대로 실행한다. 위에서 아래로 읽히도록 한 함수에 단계를 나열했다.
//
// 순서의 이유
//  - 재사용 시험(C14)은 정상 서버에서 토큰 "가족" 전체를 폐기하므로 맨 마지막.
//  - 실제 만료 시험(C15)은 가족이 폐기되기 전, 살아 있는 토큰으로 해야 의미가 있다.
//  - 토큰 원문은 메모리에만 두고, 보고서에는 Redactor 로 가린 값만 남긴다.
import { setTimeout as sleep } from 'node:timers/promises';
import {
  chooseScope, evaluateAsMetadata, evaluateOfflineAccess, evaluatePrm, evaluateUnauthenticated,
  asMetadataCandidates, bearerChallenge, fetchFirstJson, prmCandidates, probeUnauthenticated,
} from './discovery.js';
import { isLoopbackHost, stringArray, urlPolicyError } from './http.js';
import {
  buildAuthorizeUrl, followAutoConsent, openBrowser, startCallbackServer, type CallbackServer,
} from './login.js';
import { Redactor } from './mask.js';
import { evaluateHandshake, evaluateRejection, mcpHandshake, probeRejectedToken } from './mcp.js';
import { challengeS256, createState, createVerifier, randomToken } from './pkce.js';
import { registerClient } from './register.js';
import { tokenEvidence, tokenRequest, type TokenResponse } from './token.js';
import { CHECK_IDS, type Blocked, type CheckId, type CheckResult, type RunResult } from './types.js';

export interface RunOptions {
  url: string;
  clientId?: string;
  redirectPort?: number;
  scope?: string;
  waitExpiry?: boolean;
  maxWaitSec?: number;
  timeoutSec?: number;
  loginTimeoutSec?: number;
  allowHttp?: boolean;
  autoConsent?: boolean;
  /** 브라우저를 자동으로 열지(기본: autoConsent 가 아니면 연다) */
  openBrowser?: boolean;
  /** 로그인 완료 후 콜백 페이지에 보여 줄 문구 */
  callbackPageText?: string;
  progress?: (event: ProgressEvent) => void;
  redactor?: Redactor;
}

export type ProgressEvent =
  | { type: 'check'; result: CheckResult }
  | { type: 'login_url'; url: string }
  | { type: 'waiting_expiry'; seconds: number };

export async function runChecks(opts: RunOptions): Promise<RunResult> {
  const startedAt = new Date();
  const timeoutMs = (opts.timeoutSec ?? 15) * 1000;
  const allowHttp = opts.allowHttp ?? false;
  const red = opts.redactor ?? new Redactor();
  const results = new Map<CheckId, CheckResult>();
  let blocked: Blocked | undefined;
  let callback: CallbackServer | undefined;

  const record = (r: CheckResult): void => {
    results.set(r.id, r);
    opts.progress?.({ type: 'check', result: r });
  };
  const skip = (id: CheckId, detail: string): void => record({ id, status: 'SKIP', detail });
  const finish = (): RunResult => ({
    target: opts.url,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    // 실행되지 못한 검사는 SKIP(진행 중단)으로 채워 항상 15줄을 낸다.
    checks: CHECK_IDS.map((id) => results.get(id) ?? { id, status: 'SKIP', detail: 'skip.not_reached' }),
    ...(blocked ? { blocked } : {}),
  });

  try {
    // ── C01: 토큰 없이 요청 → 401 + WWW-Authenticate ──────────────────────
    const unauth = await probeUnauthenticated(opts.url, timeoutMs);
    if (!unauth.reached) {
      blocked = { stage: 'discovery', detail: 'blocked.network', vars: { url: opts.url, error: unauth.error ?? '' } };
      return finish();
    }
    record(evaluateUnauthenticated(unauth));
    if (unauth.status !== 401) {
      blocked = { stage: 'discovery', detail: 'blocked.not_protected', vars: { status: unauth.status } };
      return finish();
    }
    const challenge = bearerChallenge(unauth.headers.get('www-authenticate'));

    // ── C02: 보호 자원 메타데이터(RFC 9728) ─────────────────────────────
    const prmFetched = await fetchFirstJson(prmCandidates(opts.url, challenge?.params.resource_metadata), timeoutMs);
    record(evaluatePrm(prmFetched));
    const prm = prmFetched.doc;
    const issuer = stringArray(prm?.authorization_servers)?.[0];
    if (!prm || !issuer) {
      blocked = { stage: 'discovery', detail: 'blocked.no_prm' };
      return finish();
    }
    if (urlPolicyError(issuer, allowHttp)) {
      blocked = { stage: 'discovery', detail: 'blocked.insecure_url', vars: { url: issuer } };
      return finish();
    }
    // MCP 명세: resource 매개변수는 PRM 의 resource 값(없으면 MCP 주소)
    const resource = typeof prm.resource === 'string' ? prm.resource : opts.url;

    // ── C03: 인가 서버 메타데이터의 grant_types_supported ────────────────
    const asFetched = await fetchFirstJson(asMetadataCandidates(issuer), timeoutMs);
    record(evaluateAsMetadata(asFetched));
    const meta = asFetched.doc;
    if (!meta) {
      blocked = { stage: 'discovery', detail: 'blocked.no_as_metadata', vars: { issuer } };
      return finish();
    }
    const authorizeEndpoint = typeof meta.authorization_endpoint === 'string' ? meta.authorization_endpoint : undefined;
    const tokenEndpoint = typeof meta.token_endpoint === 'string' ? meta.token_endpoint : undefined;
    if (!authorizeEndpoint || !tokenEndpoint) {
      blocked = { stage: 'discovery', detail: 'blocked.as_incomplete' };
      return finish();
    }
    for (const endpoint of [authorizeEndpoint, tokenEndpoint]) {
      if (urlPolicyError(endpoint, allowHttp)) {
        blocked = { stage: 'discovery', detail: 'blocked.insecure_url', vars: { url: endpoint } };
        return finish();
      }
    }

    // ── C04: offline_access 광고 → 요청 스코프 결정 ──────────────────────
    record(evaluateOfflineAccess(meta));
    const scope = chooseScope({
      ...(opts.scope !== undefined ? { override: opts.scope } : {}),
      ...(challenge?.params.scope ? { challengeScope: challenge.params.scope } : {}),
      prmScopes: stringArray(prm.scopes_supported) ?? [],
      asScopes: stringArray(meta.scopes_supported) ?? [],
    });

    // ── C05: 시험용 클라이언트 등록(DCR) 또는 --client-id ────────────────
    try {
      callback = await startCallbackServer(opts.redirectPort ?? 0, opts.callbackPageText ?? 'OK');
    } catch (err) {
      // 예: --redirect-port 가 이미 쓰이는 중(EADDRINUSE)
      blocked = { stage: 'login', detail: 'blocked.callback_port', vars: { port: opts.redirectPort ?? 0, error: String((err as Error).message ?? err) } };
      return finish();
    }
    let clientId = opts.clientId;
    if (clientId) {
      record({ id: 'C05', status: 'SKIP', detail: 'c05.client_id_given' });
    } else {
      const reg = await registerClient(meta, callback.redirectUri, scope, timeoutMs);
      record(reg.result);
      clientId = reg.clientId;
      if (!clientId) {
        blocked = { stage: 'registration', detail: 'blocked.registration' };
        return finish();
      }
      if (reg.result.detail === 'c05.confidential') {
        blocked = { stage: 'registration', detail: 'blocked.confidential' };
        return finish();
      }
    }
    red.add(clientId);

    // ── 로그인(브라우저 1회 또는 --auto-consent) ───────────────────────
    const verifier = createVerifier();
    const state = createState();
    red.add(verifier);
    red.add(state);
    const authorizeUrl = buildAuthorizeUrl(authorizeEndpoint, {
      clientId, redirectUri: callback.redirectUri, challenge: challengeS256(verifier), state, resource,
      ...(scope ? { scope } : {}),
    });
    const loginTimeoutMs = (opts.loginTimeoutSec ?? 300) * 1000;
    const waiting = callback.waitForCode(state, loginTimeoutMs);
    if (opts.autoConsent) {
      if (!isLoopbackHost(new URL(authorizeEndpoint).hostname)) {
        blocked = { stage: 'login', detail: 'blocked.auto_consent_remote' };
        return finish();
      }
      const followed = await followAutoConsent(authorizeUrl, callback.redirectUri, timeoutMs);
      if (!followed.ok) {
        blocked = { stage: 'login', detail: 'blocked.auto_consent_failed', vars: { error: followed.error } };
        return finish();
      }
    } else {
      opts.progress?.({ type: 'login_url', url: authorizeUrl });
      if (opts.openBrowser ?? true) openBrowser(authorizeUrl);
    }
    const login = await waiting;
    if (!login.ok) {
      blocked = { stage: 'login', detail: `blocked.login_${login.reason}`, vars: { error: login.error ?? '' } };
      return finish();
    }
    red.add(login.code);

    // ── C06·C07: 코드 교환 → 갱신 토큰·expires_in ───────────────────────
    const exchange = await tokenRequest(tokenEndpoint, {
      grant_type: 'authorization_code',
      code: login.code,
      redirect_uri: callback.redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource,
    }, timeoutMs);
    remember(red, exchange);
    // 콜백 서버는 이제 필요 없다 — 바로 닫아 포트를 돌려준다.
    await callback.close();
    callback = undefined;
    if (!exchange.ok || !exchange.accessToken) {
      record({
        id: 'C06', status: 'FAIL', detail: 'c06.exchange_failed',
        vars: { status: exchange.http.status, error: exchange.error?.code ?? '' },
        hint: exchange.error?.hint ?? 'hint.token.other', evidence: tokenEvidence(exchange),
      });
      return finish();
    }
    const rt0 = exchange.refreshToken;
    record(rt0
      ? { id: 'C06', status: 'PASS', detail: 'c06.ok', evidence: tokenEvidence(exchange) }
      : { id: 'C06', status: 'FAIL', detail: 'c06.no_refresh_token', hint: 'hint.c06_issue_refresh', evidence: tokenEvidence(exchange) });
    record(evaluateExpiresIn(exchange.expiresIn));

    // 현재 살아 있는 액세스 토큰(만료 시험에 쓴다)
    let current = { token: exchange.accessToken, issuedAt: Date.now(), expiresIn: exchange.expiresIn };

    // ── C08: 첫 액세스 토큰으로 MCP 핸드셰이크 ───────────────────────────
    record(evaluateHandshake('C08', await mcpHandshake(opts.url, current.token, timeoutMs)));

    // ── C09~C12: 갱신 체인 ─────────────────────────────────────────────
    let rotated = false;
    if (!rt0) {
      for (const id of ['C09', 'C10', 'C11', 'C12', 'C14'] as const) skip(id, 'skip.no_refresh_token');
    } else {
      // C09: resource 를 실은 refresh grant(MCP 명세가 요구하는 형태)
      const r1 = await tokenRequest(tokenEndpoint, {
        grant_type: 'refresh_token', refresh_token: rt0, client_id: clientId, resource,
      }, timeoutMs);
      remember(red, r1);
      let latestRefresh = rt0;
      if (r1.ok && r1.accessToken) {
        record({ id: 'C09', status: 'PASS', detail: 'c09.ok', evidence: tokenEvidence(r1) });
        current = { token: r1.accessToken, issuedAt: Date.now(), expiresIn: r1.expiresIn };
        // C11: 회전 — 새 갱신 토큰이 왔고 이전 것과 다른가
        if (r1.refreshToken && r1.refreshToken !== rt0) {
          rotated = true;
          latestRefresh = r1.refreshToken;
          record({ id: 'C11', status: 'PASS', detail: 'c11.rotated' });
        } else {
          record({
            id: 'C11', status: 'WARN', detail: r1.refreshToken ? 'c11.same_token' : 'c11.not_returned',
            hint: 'hint.c11_rotate',
          });
        }
        // C12: 갱신된 토큰으로 MCP 핸드셰이크
        record(evaluateHandshake('C12', await mcpHandshake(opts.url, current.token, timeoutMs)));
      } else {
        record({
          id: 'C09', status: 'FAIL', detail: 'c09.failed',
          vars: { status: r1.http.status, error: r1.error?.code ?? '' },
          hint: r1.error?.hint ?? 'hint.token.other', evidence: tokenEvidence(r1),
        });
        skip('C11', 'skip.refresh_failed');
        skip('C12', 'skip.refresh_failed');
        skip('C14', 'skip.refresh_failed');
      }

      // C10: resource 없이 refresh grant(resource 를 빠뜨리는 클라이언트가 있는지 대비)
      const r2 = await tokenRequest(tokenEndpoint, {
        grant_type: 'refresh_token', refresh_token: latestRefresh, client_id: clientId,
      }, timeoutMs);
      remember(red, r2);
      if (r2.ok && r2.accessToken) {
        record({ id: 'C10', status: 'PASS', detail: 'c10.ok', evidence: tokenEvidence(r2) });
        current = { token: r2.accessToken, issuedAt: Date.now(), expiresIn: r2.expiresIn };
      } else if (r2.error?.code === 'invalid_target') {
        record({ id: 'C10', status: 'WARN', detail: 'c10.invalid_target', hint: 'hint.token.invalid_target', evidence: tokenEvidence(r2) });
      } else {
        record({
          id: 'C10', status: 'FAIL', detail: 'c10.failed',
          vars: { status: r2.http.status, error: r2.error?.code ?? '' },
          hint: r2.error?.hint ?? 'hint.token.other', evidence: tokenEvidence(r2),
        });
      }
    }

    // ── C13: 위조 토큰 → 401 invalid_token 이어야 한다 ──────────────────
    const forged = `mrd-forged-${randomToken(18)}`;
    record(evaluateRejection('C13', await probeRejectedToken(opts.url, forged, timeoutMs)));

    // ── C15: (--wait-expiry) 실제로 만료될 때까지 기다린 뒤 같은 확인 ──────
    if (!opts.waitExpiry) {
      skip('C15', 'skip.c15_not_requested');
    } else if (current.expiresIn === undefined) {
      skip('C15', 'skip.c15_no_expires_in');
    } else {
      // 시계 오차를 감안해 만료 시각 + 1.5초까지 기다린다.
      const waitMs = current.issuedAt + current.expiresIn * 1000 + 1500 - Date.now();
      const maxWaitMs = (opts.maxWaitSec ?? 3700) * 1000;
      if (waitMs > maxWaitMs) {
        record({ id: 'C15', status: 'SKIP', detail: 'skip.c15_too_long', vars: { seconds: Math.ceil(waitMs / 1000) } });
      } else {
        if (waitMs > 0) {
          opts.progress?.({ type: 'waiting_expiry', seconds: Math.ceil(waitMs / 1000) });
          await sleep(waitMs);
        }
        record(evaluateRejection('C15', await probeRejectedToken(opts.url, current.token, timeoutMs)));
      }
    }

    // ── C14: 회전 전 갱신 토큰 재사용 — 항상 마지막 ──────────────────────
    if (rt0 && !results.has('C14')) {
      if (!rotated) {
        skip('C14', 'skip.no_rotation');
      } else {
        const reuse = await tokenRequest(tokenEndpoint, {
          grant_type: 'refresh_token', refresh_token: rt0, client_id: clientId, resource,
        }, timeoutMs);
        remember(red, reuse);
        if (reuse.ok) {
          record({ id: 'C14', status: 'WARN', detail: 'c14.reuse_accepted', hint: 'hint.c14_reuse_detection', evidence: tokenEvidence(reuse) });
        } else if (reuse.error?.code === 'invalid_grant') {
          record({ id: 'C14', status: 'PASS', detail: 'c14.ok', evidence: tokenEvidence(reuse) });
        } else {
          // 거부는 했지만 invalid_grant 가 아님 — 재사용은 막혔으므로 판정에는 영향 없는 경고
          record({
            id: 'C14', status: 'WARN', detail: 'c14.other_rejection',
            vars: { status: reuse.http.status, error: reuse.error?.code ?? '' },
            hint: 'hint.c14_invalid_grant', evidence: tokenEvidence(reuse),
          });
        }
      }
    }
    return finish();
  } finally {
    await callback?.close();
  }
}

/** 응답에 들어 있던 토큰 원문을 가림 목록에 넣는다 */
function remember(red: Redactor, r: TokenResponse): void {
  red.add(r.accessToken);
  red.add(r.refreshToken);
}

export function evaluateExpiresIn(expiresIn: number | undefined): CheckResult {
  if (expiresIn === undefined) {
    return { id: 'C07', status: 'WARN', detail: 'c07.missing', hint: 'hint.c07_expires_in' };
  }
  if (expiresIn < 300) {
    return { id: 'C07', status: 'WARN', detail: 'c07.short', vars: { seconds: expiresIn }, hint: 'hint.c07_expires_in' };
  }
  return { id: 'C07', status: 'PASS', detail: 'c07.ok', vars: { seconds: expiresIn } };
}
