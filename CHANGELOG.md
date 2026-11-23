# Changelog

## 0.2.0

- `demo` now runs the practice mock in-process: the same auth-server and MCP code that `serve` uses is called directly, with no sockets or ports, and a manual clock. The output is unchanged.
- Tests: `npm test` (what CI runs) uses only the in-process mock, fault injection (dropped connection, cut body, timeout) and the manual clock. A guard fails any unit test that opens a socket or a child process. Real-socket tests (`serve` and `check` as separate processes, fresh TCP connections, the loopback login callback) moved to `npm run test:e2e`, which runs locally and not in CI.
- CI: a single Node 22 job with a time limit on every step. On failure, the failed tests from the TAP output are posted as annotations and in the run summary. The weekly schedule, the Node 20/24/26 matrix and the custom annotation reporter were removed.
- BREAKING: `engines` is now Node.js `>=22` (Node 20 reached end of life on 2026-04-30).
- Internal: the engine takes an injectable transport (fetch, clock, sleep). The real `check` path still uses the global `fetch`, real timers and the loopback callback.

## 0.1.3

- CI: tests now run on Node 20, 22, 24 and 26. The job is split into named steps (install, build, tests, demo), so the step name shows where a run stopped. A failed test is also posted as a GitHub annotation, so the run summary shows the cause without downloading logs. The npm cache step was dropped (there are only three dev dependencies). The tool itself is unchanged.

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
