// 진단용 HTTP 래퍼: 예외를 던지지 않고 상태·헤더·본문을 그대로 기록해 돌려준다.
// (라이브러리처럼 오류를 예외로 감싸면 "서버가 실제로 무엇을 돌려줬는지"가 사라진다)
import { realTransport, type Transport } from './transport.js';

export interface HttpResult {
  /** 네트워크 수준에서 응답을 받았는가(상태 코드와 무관) */
  reached: boolean;
  status: number;
  headers: Headers;
  contentType: string;
  text: string;
  /** 본문이 JSON 으로 해석되면 그 값 */
  json?: unknown;
  /** 네트워크 오류·시간 초과 메시지 */
  error?: string;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  redirect?: 'manual' | 'follow';
  /** 요청을 보낼 전송(기본: 실제 네트워크) */
  transport?: Transport;
}

// 본문은 진단에 필요한 만큼만 읽는다(악의적·고장 서버가 끝없이 보내도 메모리가 터지지 않게).
export const MAX_BODY_BYTES = 1_000_000;

/**
 * 요청마다 새 연결을 쓴다(`connection: close`).
 * 유휴 keep-alive 연결을 다시 쓰면, 서버가 막 닫은 연결에 요청을 실어 "other side closed" 같은
 * 연결 오류가 날 수 있다. 진단 도구는 토큰 동작만 보아야 하므로 연결 재사용 문제를 판정에 섞지 않는다.
 */
export const FRESH_CONNECTION = { connection: 'close' } as const;

export async function request(url: string, opts: RequestOptions): Promise<HttpResult> {
  const empty = new Headers();
  const transport = opts.transport ?? realTransport;
  let res: Response;
  try {
    res = await transport.fetch(url, {
      method: opts.method ?? 'GET',
      headers: { ...opts.headers, ...FRESH_CONNECTION },
      body: opts.body,
      redirect: opts.redirect ?? 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    return { reached: false, status: 0, headers: empty, contentType: '', text: '', error: describeError(err) };
  }
  let text = '';
  try {
    text = await readLimited(res, MAX_BODY_BYTES);
  } catch (err) {
    return {
      reached: true, status: res.status, headers: res.headers,
      contentType: res.headers.get('content-type') ?? '', text: '', error: describeError(err),
    };
  }
  const contentType = res.headers.get('content-type') ?? '';
  return { reached: true, status: res.status, headers: res.headers, contentType, text, json: tryJson(text) };
}

export async function readLimited(res: Response, limit: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let out = '';
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      out += decoder.decode(value, { stream: true });
      if (size >= limit) break;
    }
    out += decoder.decode();
  } finally {
    // 다 읽었든 중간에 멈췄든 스트림을 놓아 연결이 남지 않게 한다.
    await reader.cancel().catch(() => undefined);
  }
  return out;
}

/**
 * 응답을 끝까지 받지 못했는가 — 연결 실패·시간 초과(reached=false)이거나, 상태 줄은 왔지만 본문을 받는 도중 끊김(error).
 * 이런 결과는 서버 동작의 증거가 아니므로 검사 FAIL 로 쓰지 않는다(checks.ts 의 stopNoResponse).
 */
export function noResponse(r: Pick<HttpResult, 'reached' | 'error'>): boolean {
  return !r.reached || r.error !== undefined;
}

export function tryJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return 'timeout';
    if (cause instanceof Error && cause.message) return `${err.message}: ${cause.message}`;
    return err.message;
  }
  return String(err);
}

/** JSON 객체(배열 아님)면 그대로, 아니면 undefined */
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : undefined;
}

/** 루프백 호스트인가(127.0.0.0/8, localhost, ::1) */
export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * 평문 http 허용 규칙: https 는 항상, http 는 루프백 호스트이거나 --allow-http 일 때만.
 * 허용되지 않으면 이유 키를 돌려준다.
 */
export function urlPolicyError(raw: string, allowHttp: boolean): 'invalid_url' | 'plain_http' | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return 'invalid_url';
  }
  if (u.protocol === 'https:') return undefined;
  if (u.protocol !== 'http:') return 'invalid_url';
  if (isLoopbackHost(u.hostname) || allowHttp) return undefined;
  return 'plain_http';
}
