// in-process 전송: 목 서버의 handle(Request) 를 소켓 없이 직접 부르는 fetch, 수동 시계, 고장 주입.
//
// 왜: demo 와 단위 시험이 실제 포트·자식 프로세스·실시간 대기에 기대면, 붐비는 CI 러너에서
// 시작 지연·로그 읽기 경쟁·토큰 만료 여유 같은 "환경 탓" 실패가 섞인다. 여기서는
//  - 요청은 등록된 origin 의 handler 로 바로 들어가고(네트워크 없음),
//  - 시각은 수동 시계라 sleep(ms) 는 시계만 ms 만큼 돌리고 즉시 끝나며(만료 시험이 실제로 기다리지 않음),
//  - 응답 없음·본문 끊김·시간 초과는 faults 로 정해진 요청에만 결정적으로 일어난다.
// OAuth 처리(DCR·PKCE·회전·재사용·만료)는 serve 와 같은 handler 코드가 실제로 수행한다.
import type { Transport } from '../transport.js';

export type Route = (req: Request) => Promise<Response>;
export type Fault = 'drop' | 'cut-body' | 'timeout';

/** faults 콜백이 받는 요청 정보. n 은 같은 "메서드 경로" 요청의 순번(1부터) */
export interface FaultRequest {
  method: string;
  path: string;
  url: string;
  n: number;
}

export interface ManualClock {
  now(): number;
  /** 시계를 ms 만큼 앞으로 돌리고 바로 끝난다 */
  sleep(ms: number): Promise<void>;
  /** 지금까지 sleep 으로 돌린 시간 합(ms) — 시험이 "실제로 기다리지 않았다"를 확인할 때 쓴다 */
  readonly slept: number;
}

export function createManualClock(start = Date.now()): ManualClock {
  let current = start;
  let slept = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      const step = Math.max(0, ms);
      current += step;
      slept += step;
    },
    get slept() {
      return slept;
    },
  };
}

export interface InProcessOptions {
  /** origin(예: http://127.0.0.1:1) → 그 주소의 요청을 처리할 함수 */
  routes: Record<string, Route>;
  /** 기본: 지금 시각에서 시작하는 수동 시계 */
  clock?: ManualClock;
  /** 고장 주입: 고장을 돌려준 요청은 그 방식으로 실패한다 */
  faults?: (req: FaultRequest) => Fault | undefined;
}

export interface InProcessTransport extends Transport {
  clock: ManualClock;
}

export function createInProcessTransport(opts: InProcessOptions): InProcessTransport {
  const clock = opts.clock ?? createManualClock();
  const routes = new Map(Object.entries(opts.routes).map(([origin, route]) => [new URL(origin).origin, route]));
  // 고장 주입의 순번 세기용. 키는 "메서드 경로" 라서 시험 한 번에 몇 개뿐이다.
  const counts = new Map<string, number>();

  return {
    clock,
    now: () => clock.now(),
    sleep: (ms) => clock.sleep(ms),
    callback: 'capture',
    async fetch(input, init) {
      const url = new URL(input);
      if (init.signal?.aborted) throw init.signal.reason;
      const route = routes.get(url.origin);
      if (!route) {
        // 등록되지 않은 주소는 절대 실제 네트워크로 나가지 않는다 — 실제 fetch 의 연결 거부와 같은 모양으로 실패.
        throw new TypeError('fetch failed', { cause: connectionError('ECONNREFUSED', `connect ECONNREFUSED ${url.host}`) });
      }
      const method = (init.method ?? 'GET').toUpperCase();
      const key = `${method} ${url.pathname}`;
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      const fault = opts.faults?.({ method, path: url.pathname, url: url.toString(), n });

      if (fault === 'drop') {
        // 서버가 응답 없이 연결을 끊은 경우(undici 의 SocketError 와 같은 모양)
        throw new TypeError('fetch failed', { cause: connectionError('UND_ERR_SOCKET', 'other side closed') });
      }
      if (fault === 'timeout') {
        // AbortSignal.timeout 이 끝났을 때와 같은 오류 — 실제로 기다리지 않는다
        throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
      }

      const request = new Request(url, {
        method,
        ...(init.headers ? { headers: init.headers } : {}),
        ...(init.body !== undefined && init.body !== null && method !== 'GET' && method !== 'HEAD' ? { body: init.body } : {}),
      });
      const response = await route(request);
      if (fault === 'cut-body') return cutBody(response);
      return response;
    },
  };
}

/** 상태 줄·헤더는 그대로, 본문은 앞 일부만 보낸 뒤 스트림 오류(연결 끊김)로 끝나는 응답 */
async function cutBody(response: Response): Promise<Response> {
  const full = new Uint8Array(await response.arrayBuffer());
  const part = full.slice(0, Math.max(1, Math.floor(full.byteLength / 2)));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(part);
      controller.error(new TypeError('terminated', { cause: connectionError('UND_ERR_SOCKET', 'other side closed') }));
    },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function connectionError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
