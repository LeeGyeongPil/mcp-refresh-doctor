// 전송(transport): 점검 엔진이 바깥 세계와 만나는 세 지점 — HTTP 요청, 현재 시각, 기다리기.
//
// 실제 check 는 realTransport(전역 fetch·Date.now·실제 타이머·루프백 콜백 서버)를 쓴다.
// demo 와 단위 시험은 fake/inprocess.ts 의 전송을 넣어, 같은 엔진을 소켓·자식 프로세스·실제 대기 없이 돌린다.
// (엔진 코드는 어느 전송인지 모른다 — 그래서 demo 가 보여 주는 판정이 실제 check 와 같은 코드에서 나온다)
import { setTimeout as delay } from 'node:timers/promises';

export interface Transport {
  /** WHATWG fetch 와 같은 모양 */
  fetch(input: string, init: RequestInit): Promise<Response>;
  /** 현재 시각(ms). 토큰 발급 시각·만료 대기 계산에 쓴다 */
  now(): number;
  /** ms 만큼 기다린다(C15 만료 대기, 로그인 대기) */
  sleep(ms: number): Promise<void>;
  /**
   * 로그인 콜백을 받는 방법.
   * - 'loopback': 127.0.0.1 에 콜백 서버를 실제로 열고 브라우저(또는 --auto-consent)가 두드리기를 기다린다.
   * - 'capture' : 콜백 서버를 열지 않는다. --auto-consent 리다이렉트의 Location 에서 code·state 를 바로 읽는다.
   */
  callback: 'loopback' | 'capture';
}

export const realTransport: Transport = {
  // 호출할 때마다 globalThis.fetch 를 찾는다(import 시점에 붙잡지 않는다) —
  // 단위 시험의 소켓 차단 가드(test/support/no-network.ts)가 실수로 쓰인 실제 전송을 바로 잡아내게 하기 위함.
  fetch: (input, init) => globalThis.fetch(input, init),
  now: () => Date.now(),
  sleep: async (ms) => {
    await delay(ms);
  },
  callback: 'loopback',
};
