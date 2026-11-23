// AC-4(일부): 메타데이터 검사(SEP-2207)와 WWW-Authenticate 파서.
import './support/no-network.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  asMetadataCandidates, bearerChallenge, chooseScope, evaluateAsMetadata, evaluateOfflineAccess, evaluatePrm,
  evaluateUnauthenticated, fetchFirstJson, parseWwwAuthenticate, prmCandidates, probeUnauthenticated,
} from '../src/discovery.js';
import type { HttpResult } from '../src/http.js';
import { inProcess } from './helpers.js';

const doc = (d: Record<string, unknown>) => ({ url: 'https://as.example/x', doc: d, tried: [] });

test('C02: protected resource metadata', () => {
  const ok = evaluatePrm(doc({ resource: 'https://mcp.example/mcp', authorization_servers: ['https://as.example'], scopes_supported: ['mcp'] }));
  assert.equal(ok.status, 'PASS');
  const offline = evaluatePrm(doc({ resource: 'https://mcp.example/mcp', authorization_servers: ['https://as.example'], scopes_supported: ['mcp', 'offline_access'] }));
  assert.equal(offline.status, 'WARN');
  assert.equal(offline.detail, 'c02.offline_access_in_prm');
  assert.equal(evaluatePrm(doc({ resource: 'https://mcp.example/mcp' })).status, 'FAIL');
  assert.equal(evaluatePrm({ tried: [{ url: 'u', status: 404 }] }).status, 'FAIL');
});

test('C03: grant_types_supported', () => {
  assert.equal(evaluateAsMetadata(doc({ grant_types_supported: ['authorization_code', 'refresh_token'] })).status, 'PASS');
  const missing = evaluateAsMetadata(doc({ issuer: 'https://as.example' }));
  assert.equal(missing.status, 'WARN');
  assert.equal(missing.hint, 'hint.c03_advertise');
  const noRefresh = evaluateAsMetadata(doc({ grant_types_supported: ['authorization_code'] }));
  assert.equal(noRefresh.status, 'FAIL');
  assert.equal(noRefresh.hint, 'hint.c03_enable_refresh');
  // 읽지 못한 것은 서버 결함 증거가 아니다 → FAIL 이 아니라 SKIP
  assert.equal(evaluateAsMetadata({ tried: [] }).status, 'SKIP');
});

test('C04: offline_access advertised by the auth server', () => {
  assert.equal(evaluateOfflineAccess({ scopes_supported: ['openid', 'offline_access'] }).status, 'PASS');
  assert.equal(evaluateOfflineAccess({ scopes_supported: ['openid'] }).status, 'WARN');
  assert.equal(evaluateOfflineAccess({}).status, 'WARN');
});

test('C01: 401 challenge evaluation', () => {
  const r = (status: number, www?: string): HttpResult => ({
    reached: true, status, headers: new Headers(www ? { 'www-authenticate': www } : {}), contentType: '', text: '',
  });
  assert.equal(evaluateUnauthenticated(r(401, 'Bearer resource_metadata="https://m/.well-known/oauth-protected-resource"')).status, 'PASS');
  assert.equal(evaluateUnauthenticated(r(401, 'Bearer realm="m"')).status, 'WARN');
  assert.equal(evaluateUnauthenticated(r(200)).status, 'FAIL');
});

test('WWW-Authenticate parser handles quotes, commas and several params', () => {
  const [c] = parseWwwAuthenticate(
    'Bearer realm="mcp", error="invalid_token", error_description="expired, please \\"refresh\\"", resource_metadata="https://m.example/.well-known/oauth-protected-resource/mcp", scope=read',
  );
  assert.equal(c?.scheme, 'bearer');
  assert.equal(c?.params.realm, 'mcp');
  assert.equal(c?.params.error, 'invalid_token');
  assert.equal(c?.params.error_description, 'expired, please "refresh"');
  assert.equal(c?.params.resource_metadata, 'https://m.example/.well-known/oauth-protected-resource/mcp');
  assert.equal(c?.params.scope, 'read');

  // 여러 도전, 대소문자, 공백 변형, token68
  const many = parseWwwAuthenticate('Basic realm="x" , BEARER  Error = "invalid_token" ,scope="a b", Negotiate abc123==');
  assert.deepEqual(many.map((x) => x.scheme), ['basic', 'bearer', 'negotiate']);
  assert.equal(many[1]?.params.error, 'invalid_token');
  assert.equal(many[1]?.params.scope, 'a b');
  assert.equal(many[2]?.token68, 'abc123==');

  assert.deepEqual(parseWwwAuthenticate(''), []);
  assert.deepEqual(parseWwwAuthenticate(null), []);
  // 깨진 입력에도 멈추지 않는다
  assert.ok(Array.isArray(parseWwwAuthenticate('Bearer error="unterminated')));
});

test('well-known locations (RFC 9728 §3.1, RFC 8414 §3.1, OIDC)', () => {
  assert.deepEqual(prmCandidates('https://m.example/v1/mcp'), [
    'https://m.example/.well-known/oauth-protected-resource/v1/mcp',
    'https://m.example/.well-known/oauth-protected-resource',
  ]);
  assert.deepEqual(asMetadataCandidates('https://as.example/tenant1'), [
    'https://as.example/.well-known/oauth-authorization-server/tenant1',
    'https://as.example/.well-known/openid-configuration/tenant1',
    'https://as.example/tenant1/.well-known/openid-configuration',
  ]);
  assert.deepEqual(asMetadataCandidates('https://as.example'), [
    'https://as.example/.well-known/oauth-authorization-server',
    'https://as.example/.well-known/openid-configuration',
  ]);
});

test('scope choice adds offline_access only when the auth server advertises it (SEP-2207)', () => {
  assert.equal(chooseScope({ prmScopes: ['mcp'], asScopes: ['mcp', 'offline_access'] }), 'mcp offline_access');
  assert.equal(chooseScope({ prmScopes: ['mcp'], asScopes: ['mcp'] }), 'mcp');
  assert.equal(chooseScope({ challengeScope: 'read write', prmScopes: ['mcp'], asScopes: ['offline_access'] }), 'read write offline_access');
  assert.equal(chooseScope({ override: 'custom', asScopes: ['offline_access'] }), 'custom');
  assert.equal(chooseScope({}), undefined);
});

test('discovery against the in-process mock: 401 challenge → PRM → AS metadata (SEP-2207)', async () => {
  for (const [preset, c03] of [['good', 'PASS'], ['no-refresh', 'FAIL']] as const) {
    const { fake, transport } = inProcess(preset);
    const unauth = await probeUnauthenticated(fake.mcpUrl, 5000, transport);
    assert.equal(evaluateUnauthenticated(unauth).status, 'PASS');
    const challenge = bearerChallenge(unauth.headers.get('www-authenticate'));
    const prm = await fetchFirstJson(prmCandidates(fake.mcpUrl, challenge?.params.resource_metadata), 5000, transport);
    assert.equal(evaluatePrm(prm).status, 'PASS', 'offline_access is not in the PRM');
    const as = await fetchFirstJson(asMetadataCandidates(fake.base), 5000, transport);
    assert.equal(evaluateAsMetadata(as).status, c03, preset);
    assert.equal(evaluateOfflineAccess(as.doc ?? {}).status, 'PASS');
  }
});
