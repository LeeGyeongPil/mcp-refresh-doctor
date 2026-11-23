# Changelog

## 0.1.0

- `check <mcp-url>`: runs 15 checks (C01 to C15) of the OAuth 2.1 token lifecycle against a remote MCP server and returns a verdict (server-side, client-side, inconclusive) with exit codes 1, 0, 2.
- `serve --preset <name>`: practice mock auth + MCP server with six fault presets.
- `demo`: checks all presets offline.
- English and Korean output (`--lang`, `MCP_REFRESH_DOCTOR_LANG`).
