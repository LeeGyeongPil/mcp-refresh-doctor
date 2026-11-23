// AC-6: MCP 핸드셰이크가 JSON 응답과 SSE(text/event-stream) 응답을 모두 처리하고 Mcp-Session-Id 를 이어 보낸다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startFakeServer } from '../src/fake/server.js';
import { mcpHandshake, readSseUntil, rpc } from '../src/mcp.js';
import { obtainAccessToken } from './helpers.js';

test('json and sse responses', async (t) => {
  for (const mode of ['json', 'sse'] as const) {
    await t.test(mode, async () => {
      const lines: string[] = [];
      const server = await startFakeServer({ preset: 'good', mcpResponseMode: mode, log: (l) => lines.push(l) });
      try {
        const token = await obtainAccessToken(server.base);
        const h = await mcpHandshake(server.mcpUrl, token, 5000);
        assert.equal(h.ok, true, JSON.stringify(h));
        assert.equal(h.toolCount, 1);
        assert.equal(h.sessionId, true);
        assert.equal(h.protocolVersion, '2025-11-25');
        // 서버는 세션 ID 가 없으면 400 을 주므로, tools/list 성공 = 세션 ID 를 이어 보냈다는 뜻.
        assert.ok(lines.some((l) => l.includes('tools/list -> 200')));
        assert.ok(lines.some((l) => l.includes('session closed')), 'session is closed with DELETE');
      } finally {
        await server.close();
      }
    });
  }
});

test('the practice server really enforces Mcp-Session-Id (so the test above means something)', async () => {
  const server = await startFakeServer({ preset: 'good' });
  try {
    const token = await obtainAccessToken(server.base);
    const r = await rpc({ url: server.mcpUrl, token, timeoutMs: 5000, body: { jsonrpc: '2.0', id: 5, method: 'tools/list' } });
    assert.equal(r.status, 400);
  } finally {
    await server.close();
  }
});

test('SSE reader returns as soon as the matching response arrives, even if the stream stays open', async () => {
  const enc = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(': comment\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n'));
      controller.enqueue(enc.encode('data: {"jsonrpc":"2.0",\ndata: "id":7,"result":{"ok":true}}\n\n'));
      // close() 를 부르지 않는다 — 열린 채로 남는 스트림
    },
    cancel() {
      cancelled = true;
    },
  });
  const msg = await readSseUntil(stream, 7);
  assert.deepEqual(msg?.result, { ok: true });
  assert.equal(cancelled, true, 'reader cancels the stream after use');
});

test('handshake reports the failing step and status for a rejected token', async () => {
  const server = await startFakeServer({ preset: 'good' });
  try {
    const h = await mcpHandshake(server.mcpUrl, 'not-a-real-token', 5000);
    assert.equal(h.ok, false);
    assert.equal(h.step, 'initialize');
    assert.equal(h.status, 401);
    assert.match(h.wwwAuthenticate ?? '', /invalid_token/);
  } finally {
    await server.close();
  }
});
