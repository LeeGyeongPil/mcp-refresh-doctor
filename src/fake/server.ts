// 연습용 목(mock) 서버를 실제 HTTP 로 연다(serve 명령·e2e 시험용).
// 처리 로직은 전부 fake/handler.ts 에 있고, 여기서는 node:http 요청 ↔ Web 표준 Request/Response 만 바꾼다.
// (demo 와 단위 시험은 이 파일을 거치지 않고 handler 를 in-process 로 직접 부른다)
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { PresetName } from './presets.js';
import { MAX_REQUEST_BODY, createFakeHandler, type FakeHandler } from './handler.js';

export interface FakeServerOptions {
  preset: PresetName;
  port?: number;
  /** 액세스 토큰 수명(초) */
  ttlSec?: number;
  /** MCP 응답 형식: JSON(기본) 또는 SSE 스트림 */
  mcpResponseMode?: 'json' | 'sse';
  /** 요청 로그 한 줄씩(토큰은 가린 형태로만 전달된다) */
  log?: (line: string) => void;
  /** 시험용: 발급한 비밀 값 원문을 모아 둔다(가림 검사용). 기본 꺼짐 */
  trackSecrets?: boolean;
}

export interface FakeServer {
  base: string;
  mcpUrl: string;
  /** trackSecrets 일 때 발급한 client_id·code·토큰 원문 */
  issuedSecrets: ReadonlySet<string>;
  close(): Promise<void>;
}

export async function startFakeServer(opts: FakeServerOptions): Promise<FakeServer> {
  const log = opts.log ?? ((): void => undefined);
  // 주소(포트)는 listen 뒤에야 알 수 있으므로 handler 는 그때 만든다.
  let handler: FakeHandler | undefined;

  const server = createServer((req, res) => {
    serveOne(req, res).catch((err: unknown) => {
      log(`${req.method ?? '?'} ${req.url?.split('?')[0] ?? ''} -> 500 (${String(err)})`);
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"server_error"}');
      else res.end();
    });
  });

  async function serveOne(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!handler) {
      res.writeHead(503).end();
      return;
    }
    // node:http 요청 → Request
    const method = req.method ?? 'GET';
    const body = await readBody(req);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value);
      else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    }
    const request = new Request(new URL(req.url ?? '/', handler.base), {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
    });

    // Response → node:http 응답(본문은 스트림 그대로 흘려 보낸다)
    const response = await handler.handle(request);
    const outHeaders: Record<string, string> = {};
    response.headers.forEach((value, name) => {
      outHeaders[name] = value;
    });
    res.writeHead(response.status, outHeaders);
    if (!response.body) {
      res.end();
      return;
    }
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } finally {
      reader.releaseLock();
    }
    res.end();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  handler = createFakeHandler({
    preset: opts.preset,
    base: `http://127.0.0.1:${port}`,
    ...(opts.ttlSec !== undefined ? { ttlSec: opts.ttlSec } : {}),
    ...(opts.mcpResponseMode ? { mcpResponseMode: opts.mcpResponseMode } : {}),
    log,
    ...(opts.trackSecrets ? { trackSecrets: true } : {}),
  });

  return {
    base: handler.base,
    mcpUrl: handler.mcpUrl,
    issuedSecrets: handler.issuedSecrets,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

// 요청 본문을 상한까지만 읽는다(넘으면 연결을 끊는다).
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => {
      data += chunk;
      if (data.length > MAX_REQUEST_BODY) req.destroy(new Error('body too large'));
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}
