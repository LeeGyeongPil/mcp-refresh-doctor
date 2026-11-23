// e2e(실 소켓, `npm run test:e2e` 전용): in-process 시험이 볼 수 없는 소켓 고유 동작과 node:http 어댑터를 확인한다.
//  - 요청마다 새 TCP 연결(Connection: close) — 서버가 닫은 keep-alive 연결을 다시 쓰지 않는다
//  - 본문 도중 끊긴 응답은 "응답 없음", 끝까지 온 비JSON 본문은 서버가 실제로 보낸 증거
//  - serve 와 같은 어댑터(fake/server.ts)로 연 목에서 JSON·SSE 핸드셰이크
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { startFakeServer } from '../../src/fake/server.js';
import { noResponse, request } from '../../src/http.js';
import { mcpHandshake, rpc, rpcNoResponse } from '../../src/mcp.js';
import { obtainAccessTokenHttp } from './helpers.js';

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

test('a body cut off mid-stream over a real socket counts as "no response"; a complete non-JSON body does not', async () => {
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

test('the node:http adapter serves the same mock: json and sse handshakes over real HTTP', async (t) => {
  for (const mode of ['json', 'sse'] as const) {
    await t.test(mode, async () => {
      const lines: string[] = [];
      const server = await startFakeServer({ preset: 'good', mcpResponseMode: mode, log: (l) => lines.push(l) });
      try {
        const token = await obtainAccessTokenHttp(server.base);
        const h = await mcpHandshake(server.mcpUrl, token, 5000);
        assert.equal(h.ok, true, JSON.stringify(h));
        assert.equal(h.toolCount, 1);
        assert.equal(h.sessionId, true);
        assert.ok(lines.some((l) => l.includes('tools/list -> 200')));
        assert.ok(lines.some((l) => l.includes('session closed')), 'session is closed with DELETE');
        // (토큰을 얻는 과정에서 302 Location 도 어댑터를 거쳐 그대로 전달됐다) 오류 상태·본문도 그대로 전달된다
        const rejected = await fetch(`${server.base}/authorize?client_id=nope&redirect_uri=x`, { redirect: 'manual' });
        assert.equal(rejected.status, 400);
        assert.equal(await rejected.text(), 'invalid client_id or redirect_uri');
      } finally {
        await server.close();
      }
    });
  }
});
