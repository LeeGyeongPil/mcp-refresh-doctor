// English messages. Every user-facing string lives here (and in ko.ts with the same keys).
// Placeholders look like {name}.

export const en = {
  // ── help ────────────────────────────────────────────────────────────
  help: `mcp-refresh-doctor — why does my remote MCP server keep asking users to log in again?

Usage:
  mcp-refresh-doctor check <mcp-url> [options]   run the token lifecycle against a server
  mcp-refresh-doctor serve --preset <name>        start a practice mock server (fault presets)
  mcp-refresh-doctor demo [--json]                check all presets offline and show verdicts

check options:
  --client-id <id>       use a pre-registered public client instead of dynamic registration
  --redirect-port <n>    loopback callback port (needed with --client-id)
  --scope <scopes>       override the requested scope
  --wait-expiry          wait until the access token really expires, then check the response (C15)
  --max-wait <sec>       upper bound for --wait-expiry (default 3700)
  --timeout <sec>        per-request timeout (default 15)
  --allow-http           allow plain http to non-loopback hosts (not recommended)
  --auto-consent         follow the authorize redirect without a browser (loopback test servers only)
  --json                 print the JSON report to stdout
  --out <file>           also write the JSON report to a file

serve options:
  --preset <name>        good | no-refresh | expired-403 | no-rotation | refresh-needs-secret | resource-required
  --port <n>             listen port on 127.0.0.1 (default 8787, 0 = random)
  --ttl <sec>            access token lifetime (default 3600)

common:
  --lang en|ko           output language (or MCP_REFRESH_DOCTOR_LANG, then LC_ALL/LC_MESSAGES/LANG)
  -h, --help             show this help
  -v, --version          show the version

Exit codes: 0 = server is refresh-ready (client-side cause), 1 = server-side cause found,
            2 = inconclusive or usage error.`,

  // ── check titles ────────────────────────────────────────────────────
  'title.C01': 'Unauthenticated request returns 401 + WWW-Authenticate',
  'title.C02': 'Protected resource metadata (RFC 9728)',
  'title.C03': 'Auth server advertises refresh_token grant (RFC 8414)',
  'title.C04': 'offline_access advertised by the auth server',
  'title.C05': 'Dynamic client registration keeps refresh_token (RFC 7591)',
  'title.C06': 'Code exchange issues a refresh token (PKCE S256)',
  'title.C07': 'Access token has expires_in',
  'title.C08': 'MCP initialize with the first access token',
  'title.C09': 'Refresh grant with resource (RFC 8707)',
  'title.C10': 'Refresh grant without resource',
  'title.C11': 'Refresh token rotation',
  'title.C12': 'MCP initialize with the refreshed access token',
  'title.C13': 'Invalid token gets 401 invalid_token (RFC 6750)',
  'title.C14': 'Reusing the pre-rotation refresh token is rejected',
  'title.C15': 'Really expired token gets 401 invalid_token',

  // ── check details ───────────────────────────────────────────────────
  'c01.ok': '401 with resource_metadata={url}',
  'c01.not_401': 'got HTTP {status} instead of 401 — the endpoint does not ask for OAuth',
  'c01.no_resource_metadata': '401 but no resource_metadata in WWW-Authenticate (fell back to well-known lookup)',
  'c02.unreadable': 'could not read protected resource metadata from any well-known location',
  'c02.incomplete': 'metadata lacks "resource" or "authorization_servers"',
  'c02.offline_access_in_prm': 'offline_access is listed in the resource metadata scopes (SEP-2207 says auth server only)',
  'c02.ok': 'resource={resource}',
  'c03.unreadable': 'could not read auth server metadata (RFC 8414 / OIDC discovery)',
  'c03.missing': 'grant_types_supported is missing — refresh support is not advertised',
  'c03.no_refresh': 'grant_types_supported is "{grants}" — no refresh_token',
  'c03.ok': 'refresh_token is listed in grant_types_supported',
  'c04.advertised': 'offline_access is in scopes_supported — added to the requested scope',
  'c04.not_advertised': 'offline_access is not advertised (fine unless the server requires it for refresh tokens)',
  'c05.unsupported': 'no registration_endpoint — pass --client-id with a pre-registered public client',
  'c05.failed': 'registration failed (HTTP {status}, {error})',
  'c05.confidential': 'server registered a confidential client ({method}); public-client testing is not possible',
  'c05.no_grant_types': 'registered, but the response has no grant_types (RFC 7591 asks servers to echo it)',
  'c05.dropped_refresh': 'registered, but grant_types became "{grants}" — refresh_token was dropped',
  'c05.ok': 'test client registered with authorization_code + refresh_token',
  'c05.client_id_given': 'using the client id given with --client-id',
  'c06.exchange_failed': 'code exchange failed (HTTP {status}, {error})',
  'c06.ok': 'access token and refresh token issued',
  'c06.no_refresh_token': 'access token issued but NO refresh token — users must log in again when it expires',
  'c07.missing': 'no expires_in — clients cannot refresh ahead of expiry',
  'c07.short': 'expires_in={seconds}s (under 5 minutes)',
  'c07.ok': 'expires_in={seconds}s',
  'c08.ok': 'initialize + tools/list succeeded (tools: {tools})',
  'c08.failed': '{step} failed (HTTP {status}, {error})',
  'c09.ok': 'new access token issued',
  'c09.failed': 'refresh failed (HTTP {status}, {error})',
  'c10.ok': 'refresh without resource also works',
  'c10.invalid_target': 'invalid_target — clients that omit resource on refresh will fail',
  'c10.failed': 'refresh without resource failed (HTTP {status}, {error})',
  'c11.rotated': 'a new refresh token was issued and differs from the old one',
  'c11.same_token': 'the same refresh token was returned (no rotation)',
  'c11.not_returned': 'no new refresh token returned (no rotation)',
  'c12.ok': 'initialize + tools/list succeeded (tools: {tools})',
  'c12.failed': '{step} failed with the refreshed token (HTTP {status}, {error})',
  'c13.ok': '401 + Bearer error="invalid_token"',
  'c13.no_error': '401 but WWW-Authenticate has no error="invalid_token" (error={error})',
  'c13.wrong_status': 'got {status} — clients only start a refresh on 401',
  'c14.ok': 'rejected with invalid_grant (reuse detection works)',
  'c14.reuse_accepted': 'the old refresh token still works (no reuse detection)',
  'c14.other_rejection': 'rejected, but with HTTP {status} {error} instead of invalid_grant',
  'c15.ok': 'expired token: 401 + Bearer error="invalid_token"',
  'c15.no_error': 'expired token: 401 but no error="invalid_token" (error={error})',
  'c15.wrong_status': 'expired token: got {status} — clients only start a refresh on 401',

  // ── skip reasons ────────────────────────────────────────────────────
  'skip.not_reached': 'not reached (stopped earlier)',
  'skip.no_refresh_token': 'skipped: no refresh token was issued',
  'skip.refresh_failed': 'skipped: refresh failed',
  'skip.no_rotation': 'skipped: no rotation to test',
  'skip.c15_not_requested': 'skipped: use --wait-expiry to wait for real expiry',
  'skip.c15_no_expires_in': 'skipped: no expires_in to wait for',
  'skip.c15_too_long': 'skipped: expiry is {seconds}s away (over --max-wait)',

  // ── blocked (inconclusive) reasons ──────────────────────────────────
  'blocked.network': 'could not reach {url} ({error})',
  'blocked.not_protected': 'the MCP endpoint answered HTTP {status} without a token, so there is no OAuth flow to test',
  'blocked.no_prm': 'no usable protected resource metadata, so the auth server is unknown',
  'blocked.insecure_url': 'refusing plain http endpoint {url} (use --allow-http)',
  'blocked.no_as_metadata': 'could not read auth server metadata for {issuer}',
  'blocked.as_incomplete': 'auth server metadata lacks authorization_endpoint or token_endpoint',
  'blocked.registration': 'dynamic client registration did not produce a client id',
  'blocked.confidential': 'the server only registers confidential clients (not supported yet)',
  'blocked.auto_consent_remote': '--auto-consent only works with loopback auth servers',
  'blocked.auto_consent_failed': 'auto-consent did not reach the callback ({error})',
  'blocked.login_timeout': 'login timed out — no callback arrived',
  'blocked.login_denied': 'the auth server returned an error to the callback ({error})',
  'blocked.login_state_mismatch': 'the callback state did not match (possible stale browser tab)',
  'blocked.login_no_code': 'the callback had no authorization code',
  'blocked.callback_port': 'could not open the loopback callback on port {port} ({error})',

  // ── fix hints ───────────────────────────────────────────────────────
  'hint.c01_return_401': 'Protect the MCP endpoint: answer requests without a token with 401 and a Bearer WWW-Authenticate challenge.',
  'hint.c01_resource_metadata': 'Add resource_metadata="<PRM URL>" to the 401 WWW-Authenticate header (RFC 9728 §5.1).',
  'hint.c02_publish_prm': 'Serve /.well-known/oauth-protected-resource[/path] with "resource" and "authorization_servers".',
  'hint.c02_offline_access': 'Remove offline_access from the resource metadata scopes_supported; advertise it in the auth server metadata instead (SEP-2207).',
  'hint.c03_advertise': 'Add "grant_types_supported": ["authorization_code", "refresh_token"] to the auth server metadata.',
  'hint.c03_enable_refresh': 'Enable the refresh_token grant for public clients and list it in grant_types_supported.',
  'hint.c04_offline_access': 'If your auth server only issues refresh tokens for offline_access, list offline_access in its scopes_supported so clients request it.',
  'hint.c05_use_client_id': 'Register a public client (token_endpoint_auth_method "none", grant types authorization_code + refresh_token) and pass --client-id and --redirect-port.',
  'hint.c05_keep_refresh': 'Keep the requested grant_types (including refresh_token) for dynamically registered clients and echo them in the response.',
  'hint.c06_issue_refresh': 'Issue refresh tokens to public clients registered with the refresh_token grant (and to requests with offline_access if you gate on it).',
  'hint.c07_expires_in': 'Return expires_in with every access token, and keep access tokens alive long enough (minutes to hours).',
  'hint.c08_accept_token': 'The MCP server must accept access tokens issued for its resource (check audience/resource validation).',
  'hint.c11_rotate': 'For public clients, rotate refresh tokens on every use (OAuth 2.1 §4.3.1) or bind them to the sender.',
  'hint.c12_accept_refreshed': 'Refreshed tokens must carry the same audience/resource as the original — check how the refresh grant sets the audience.',
  'hint.invalid_token_header': 'Add error="invalid_token" to the WWW-Authenticate header on 401 so clients know to refresh.',
  'hint.expired_must_be_401': 'Answer expired or invalid tokens with 401 + WWW-Authenticate: Bearer error="invalid_token", not 403 or 5xx (RFC 6750 §3.1).',
  'hint.c14_reuse_detection': 'Detect refresh token reuse: when an already-used refresh token comes back, reject it with invalid_grant and revoke every refresh token issued from that grant.',
  'hint.c14_invalid_grant': 'Reject reused refresh tokens with 400 invalid_grant (RFC 6749 §5.2).',
  'hint.token.invalid_client': 'The refresh grant demands client authentication although the code exchange accepted a public client — allow token_endpoint_auth_method "none" for refresh too.',
  'hint.token.invalid_grant': 'The auth server rejected a fresh, unused refresh token — check refresh token lifetime, revocation and binding policies.',
  'hint.token.invalid_scope': 'The refresh grant rejects the scope — accept a refresh without scope (meaning the original scope) or the same scope as granted.',
  'hint.token.invalid_target': 'Accept refresh requests with the resource parameter (RFC 8707); if it must be present, that is fine for compliant clients, but clients that omit it will fail.',
  'hint.token.unsupported_grant_type': 'Enable the refresh_token grant on the token endpoint.',
  'hint.token.server_error': 'The token endpoint returned 5xx on refresh — many clients treat this as "log in again". Check auth server logs.',
  'hint.token.non_json': 'The token endpoint must answer with a JSON body (application/json), also for errors (RFC 6749 §5.1–5.2).',
  'hint.token.network': 'The token endpoint could not be reached — check network, TLS and timeouts (--timeout).',
  'hint.token.other': 'The token endpoint rejected the request with an unexpected error — see the evidence in the JSON report.',
  'hint.blocked.discovery': 'Discovery did not finish, so nothing was proven about refresh. Check the URL, network and the server metadata documents.',
  'hint.blocked.registration': 'Registration did not finish. Re-run with --client-id <public client id> --redirect-port <port>.',
  'hint.blocked.login': 'Login did not finish. Open the printed URL in a browser and complete the login within 5 minutes.',
  'hint.client_side': 'The server side looks refresh-ready. If users still re-login, check the client: does it store the rotated refresh token, send resource on refresh, and use the new access token on the transport? Attach this JSON report to the client issue.',

  // ── verdict & report ────────────────────────────────────────────────
  'verdict.label.server': 'SERVER-SIDE',
  'verdict.label.client': 'CLIENT-SIDE',
  'verdict.label.inconclusive': 'INCONCLUSIVE',
  'verdict.server': 'The server cannot support silent token refresh — users will be asked to log in again.',
  'verdict.client': 'Server is refresh-ready. Repeated re-login is most likely a client-side issue.',
  'verdict.inconclusive': 'Could not finish the checks, so no cause can be named yet.',
  'report.title': 'mcp-refresh-doctor — {target}',
  'report.verdict': 'Verdict',
  'report.reasons': 'Based on',
  'report.fixes': 'How to fix',
  'report.blocked': 'Stopped at {stage}',
  'report.duration': 'took {seconds}s',
  'stage.discovery': 'discovery',
  'stage.registration': 'registration',
  'stage.login': 'login',
  'report.wrote': 'JSON report written to {file}',

  // ── progress (stderr) ───────────────────────────────────────────────
  'progress.login_url': 'Opening the browser for a one-time login. If it does not open, visit this URL:',
  'progress.waiting_login': 'Waiting for the login callback (up to 5 minutes)...',
  'progress.waiting_expiry': 'Waiting {seconds}s for the access token to really expire (--wait-expiry)...',
  'callback.page': 'Login received by mcp-refresh-doctor. You can close this tab and return to the terminal.',

  // ── demo ────────────────────────────────────────────────────────────
  'demo.banner': 'Practice mock servers (local, offline) — they reproduce reported failure modes, not any vendor\'s real server.',
  'demo.col_preset': 'Preset',
  'demo.col_verdict': 'Verdict',
  'demo.col_findings': 'Findings',
  'demo.all_pass': 'all PASS',
  'demo.expected_ok': 'matches expectation',
  'demo.expected_bad': 'UNEXPECTED (expected {expected})',
  'demo.summary': '{ok}/{total} presets matched the expected verdict.',

  // ── serve ───────────────────────────────────────────────────────────
  'serve.banner': 'Practice mock MCP server + auth server (preset "{preset}") — a local stand-in for testing refresh handling, not any vendor\'s real server.',
  'serve.listening': 'MCP endpoint: {url}',
  'serve.ttl': 'Access tokens live {ttl}s. Login is auto-approved. Press Ctrl+C to stop.',

  // ── errors ──────────────────────────────────────────────────────────
  'error.plain_http': 'error: refusing plain http for non-loopback host (use --allow-http)',
  'error.invalid_url': 'error: not a valid http(s) URL: {url}',
  'error.auto_consent_remote': 'error: --auto-consent is only allowed for loopback hosts (127.0.0.1, localhost, ::1)',
  'error.unknown_command': 'error: unknown command "{cmd}" (see --help)',
  'error.missing_url': 'error: check needs an MCP server URL (see --help)',
  'error.unknown_preset': 'error: unknown preset "{name}" (choose one of: {list})',
  'error.bad_number': 'error: {opt} needs a non-negative number',
  'error.bad_lang': 'error: --lang must be en or ko',
  'error.args': 'error: {message}',
  'error.unknown_option': 'error: unknown option {name}. Run with --help to see the supported options.',
  'error.option_value': 'error: option {name} needs a value. Put the value right after it, e.g. {name} <value>.',
  'error.client_id_needs_port': 'error: --client-id needs --redirect-port <port> (the port of the pre-registered loopback redirect URI).',
  'report.write_failed': 'warning: could not write the report to {file} ({reason}). Create the directory or pick another --out path. The verdict exit code is unchanged.',
} satisfies Record<string, string>;

export type MessageKey = keyof typeof en;
