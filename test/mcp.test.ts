// AC-6: MCP 핸드셰이크가 JSON 응답과 SSE(text/event-stream) 응답을 모두 처리하고 Mcp-Session-Id 를 이어 보낸다.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { startFakeServer } from '../src/fake/server.js';
import { noResponse, request } from '../src/http.js';
import { mcpHandshake, readSseUntil, rpc, rpcNoResponse } from '../src/mcp.js';
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

test('every request opens a fresh connection (an idle keep-alive socket the server closed is never reused)', async () => {
  const headers: (string | undefined)[] = [];
  let connections = 0;
  const s = createServer((req, res) => {
    headers.push(req.headers.connection);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }));
    });
  });
  s.on('connection', () => connections++);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(s.address() as { port: number }).port}/mcp`;
  try {
    await request(url, { timeoutMs: 5000 });
    await request(url, { method: 'POST', body: 'a=1', timeoutMs: 5000 });
    const reply = await rpc({ url, token: 't', timeoutMs: 5000, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
    assert.equal(reply.status, 200);
    assert.deepEqual(headers, ['close', 'close', 'close']);
    assert.equal(connections, 3, 'three requests = three TCP connections');
  } finally {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

test('a body cut off mid-stream counts as "no response"; a complete non-JSON body does not', async () => {
  const s = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (req.url === '/cut') {
        // 상태 줄과 본문 일부만 보내고 연결을 끊는다(본문 도중 끊김)
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': '500' });
        res.write('{"jsonrpc":"2.0","id":1,', () => res.socket?.destroy());
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('this is not json');
    });
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(s.address() as { port: number }).port}`;
  const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
  try {
    const cutHttp = await request(`${base}/cut`, { method: 'POST', body: 'a=1', timeoutMs: 5000 });
    assert.equal(cutHttp.status, 200);
    assert.equal(noResponse(cutHttp), true, JSON.stringify(cutHttp.error));
    const cutRpc = await rpc({ url: `${base}/cut`, token: 't', timeoutMs: 5000, body });
    assert.equal(rpcNoResponse(cutRpc), true, JSON.stringify(cutRpc));

    const junkHttp = await request(`${base}/junk`, { method: 'POST', body: 'a=1', timeoutMs: 5000 });
    assert.equal(noResponse(junkHttp), false);
    const junkRpc = await rpc({ url: `${base}/junk`, token: 't', timeoutMs: 5000, body });
    assert.equal(rpcNoResponse(junkRpc), false, 'the server really answered — that is evidence');
    assert.ok(junkRpc.error);
  } finally {
    s.closeAllConnections();
    await new Promise<void>((r) => s.close(() => r()));
  }
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
