# Changelog

## 0.1.2

- Fix: a request after login that gets no response (connection dropped or timeout) no longer counts as a server FAIL. Before, it could produce a false `SERVER-SIDE` verdict (exit 1); now the check is SKIP and the run ends `INCONCLUSIVE` (exit 2) at "token checks", with a hint to run again.
- Fix: every request now uses a fresh connection (`Connection: close`), so reusing a keep-alive connection that the server already closed cannot fail a check.
- Fix: closing the login callback reports "stopped" instead of "login timed out".
- Tests: end-to-end assertions print the blocked stage, failed checks with evidence and the `serve` log, so a CI failure explains itself; more generous time limits for busy runners.

## 0.1.1

- Fix: `login` no longer leaves a timer running after it finishes, so the process exits promptly.
- Tests: timing-sensitive tests made robust, test timeout added, CI job timeout set.

## 0.1.0

- `check <mcp-url>`: runs 15 checks (C01 to C15) of the OAuth 2.1 token lifecycle against a remote MCP server and returns a verdict (server-side, client-side, inconclusive) with exit codes 1, 0, 2.
- `serve --preset <name>`: practice mock auth + MCP server with six fault presets.
- `demo`: checks all presets offline.
- English and Korean output (`--lang`, `MCP_REFRESH_DOCTOR_LANG`).
