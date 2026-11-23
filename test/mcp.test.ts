// MCP 핸드셰이크가 JSON 응답과 SSE(text/event-stream) 응답을 모두 처리하고 Mcp-Session-Id 를 이어 보낸다.
// 모두 in-process — 목 handler 가 돌려주는 Response 는 fetch 가 받는 것과 같은 Web 표준 객체다.
// (소켓 고유 동작 — 요청마다 새 TCP 연결 — 은 test/e2e/network.test.ts)
import './support/no-network.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInProcessTransport } from '../src/fake/inprocess.js';
import { FRESH_CONNECTION, noResponse, request } from '../src/http.js';
import { mcpHandshake, readSseUntil, rpc, rpcNoResponse } from '../src/mcp.js';
import { inProcess, obtainAccessToken } from './helpers.js';

test('json and sse responses (in-process)', async (t) => {
  for (const mode of ['json', 'sse'] as const) {
    await t.test(mode, async () => {
      const { fake, transport, log } = inProcess('good', { mcpResponseMode: mode });
      const token = await obtainAccessToken(transport, fake.base);
      const h = await mcpHandshake(fake.mcpUrl, token, 5000, transport);
      assert.equal(h.ok, true, JSON.stringify(h));
      assert.equal(h.toolCount, 1);
      assert.equal(h.sessionId, true);
      assert.equal(h.protocolVersion, '2025-11-25');
      // 서버는 세션 ID 가 없으면 400 을 주므로, tools/list 성공 = 세션 ID 를 이어 보냈다는 뜻.
      assert.ok(log.some((l) => l.includes('tools/list -> 200')), log.join('\n'));
      assert.ok(log.some((l) => l.includes('notifications/initialized -> 202')));
      assert.ok(log.some((l) => l.includes('session closed')), 'session is closed with DELETE');
    });
  }
});

test('SSE: a notification before the reply and a stream that never closes', async () => {
  const enc = new TextEncoder();
  let cancelled = false;
  let seenSession: string | null = null;
  const transport = createInProcessTransport({
    routes: {
      'http://127.0.0.1:1': async (req) => {
        seenSession = req.headers.get('mcp-session-id');
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'));
            controller.enqueue(enc.encode('event: message\ndata: {"jsonrpc":"2.0","id":3,"result":{"tools":[]}}\n\n'));
            // close() 를 부르지 않는다 — 서버가 스트림을 열어 둔 상황
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      },
    },
  });
  const reply = await rpc({
    url: 'http://127.0.0.1:1/mcp', token: 't', timeoutMs: 5000, transport, sessionId: 'sess-1',
    body: { jsonrpc: '2.0', id: 3, method: 'tools/list' },
  });
  assert.deepEqual(reply.message?.result, { tools: [] });
  assert.equal(cancelled, true, 'the open stream is cancelled after the matching reply');
  assert.equal(seenSession, 'sess-1', 'Mcp-Session-Id is forwarded');
});

test('the practice server really enforces Mcp-Session-Id (so the tests above mean something)', async () => {
  const { fake, transport } = inProcess('good');
  const token = await obtainAccessToken(transport, fake.base);
  const r = await rpc({ url: fake.mcpUrl, token, timeoutMs: 5000, transport, body: { jsonrpc: '2.0', id: 5, method: 'tools/list' } });
  assert.equal(r.status, 400);
});

test('SSE reader returns as soon as the matching response arrives, even if the stream stays open', async () => {
  const enc = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(enc.encode(': comment\r\nevent: message\r\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\r\n\r\n'));
      controller.enqueue(enc.encode('data: {"jsonrpc":"2.0",\ndata: "id":7,"result":{"ok":true}}\n\n'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const msg = await readSseUntil(stream, 7);
  assert.deepEqual(msg?.result, { ok: true });
  assert.equal(cancelled, true, 'reader cancels the stream after use');
});

test('every request asks for a fresh connection (Connection: close)', async () => {
  const seen: (string | null)[] = [];
  const transport = createInProcessTransport({
    routes: {
      'http://127.0.0.1:1': async (req) => {
        seen.push(req.headers.get('connection'));
        return Response.json({ jsonrpc: '2.0', id: 1, result: {} });
      },
    },
  });
  await request('http://127.0.0.1:1/a', { timeoutMs: 5000, transport });
  await request('http://127.0.0.1:1/b', { method: 'POST', body: 'a=1', timeoutMs: 5000, transport });
  await rpc({ url: 'http://127.0.0.1:1/mcp', token: 't', timeoutMs: 5000, transport, body: { jsonrpc: '2.0', id: 1, method: 'ping' } });
  assert.deepEqual(seen, [FRESH_CONNECTION.connection, FRESH_CONNECTION.connection, FRESH_CONNECTION.connection]);
});

test('a body cut off mid-stream counts as "no response"; a complete non-JSON body does not', async () => {
  const transport = createInProcessTransport({
    routes: {
      'http://127.0.0.1:1': async (req) =>
        new URL(req.url).pathname === '/junk'
          ? new Response('this is not json', { status: 200, headers: { 'content-type': 'application/json' } })
          : Response.json({ jsonrpc: '2.0', id: 1, result: { padding: 'x'.repeat(200) } }),
    },
    faults: (r) => (r.path === '/cut' ? 'cut-body' : undefined),
  });
  const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
  const cutHttp = await request('http://127.0.0.1:1/cut', { method: 'POST', body: 'a=1', timeoutMs: 5000, transport });
  assert.equal(cutHttp.status, 200);
  assert.equal(noResponse(cutHttp), true, JSON.stringify(cutHttp.error));
  const cutRpc = await rpc({ url: 'http://127.0.0.1:1/cut', token: 't', timeoutMs: 5000, transport, body });
  assert.equal(rpcNoResponse(cutRpc), true, JSON.stringify(cutRpc));

  const junkHttp = await request('http://127.0.0.1:1/junk', { method: 'POST', body: 'a=1', timeoutMs: 5000, transport });
  assert.equal(noResponse(junkHttp), false);
  const junkRpc = await rpc({ url: 'http://127.0.0.1:1/junk', token: 't', timeoutMs: 5000, transport, body });
  assert.equal(rpcNoResponse(junkRpc), false, 'the server really answered — that is evidence');
  assert.ok(junkRpc.error);
});

test('handshake reports the failing step and status for a rejected token', async () => {
  const { fake, transport } = inProcess('good');
  const h = await mcpHandshake(fake.mcpUrl, 'not-a-real-token', 5000, transport);
  assert.equal(h.ok, false);
  assert.equal(h.step, 'initialize');
  assert.equal(h.status, 401);
  assert.match(h.wwwAuthenticate ?? '', /invalid_token/);
});

test('an expired token is rejected with 401 invalid_token once the manual clock passes its lifetime', async () => {
  const { fake, transport, log } = inProcess('good', { ttlSec: 60 });
  const token = await obtainAccessToken(transport, fake.base);
  assert.equal((await mcpHandshake(fake.mcpUrl, token, 5000, transport)).ok, true);
  await transport.sleep(61_000); // 실제로는 기다리지 않는다
  const h = await mcpHandshake(fake.mcpUrl, token, 5000, transport);
  assert.equal(h.status, 401);
  assert.match(h.wwwAuthenticate ?? '', /error="invalid_token"/);
  assert.ok(log.some((l) => l.includes('(token expired) -> 401')));
});
