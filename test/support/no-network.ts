// 단위 시험 가드: 이 파일을 맨 위에서 import 한 시험 파일 안에서는
// 소켓(전역 fetch, net.Server.listen, net.Socket.connect)과 자식 프로세스(spawn·exec·execFile·fork)를 쓸 수 없다.
//
// 왜: CI 에서 실패를 만든 것은 전부 실 소켓·자식 프로세스·실시간 대기였다.
// `npm test` 는 in-process 목만 쓰기로 했으므로, 실수로 실제 전송이 섞이면 "조용히 느려지거나 가끔 실패"하는 대신
// 바로 "unit tests must not open sockets: <무엇을>" 으로 실패하게 한다.
//  - 호출하는 순간 오류를 던지고(fetch 는 거부된 Promise),
//  - 진단 코드가 그 오류를 삼켜도(예: http.ts 는 fetch 실패를 '연결 실패'로 기록한다) 파일 끝의 after 훅이
//    막힌 호출 목록을 들고 실패한다 — 원인이 로그에 그대로 남는다.
// 실 소켓 시험은 test/e2e/ 에 두고 `npm run test:e2e` 로 따로 돌린다(이 가드를 import 하지 않는다).
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { after } from 'node:test';

export const GUARD_MESSAGE = 'unit tests must not open sockets';

const violations: string[] = [];

const original = {
  fetch: globalThis.fetch,
  listen: net.Server.prototype.listen,
  connect: net.Socket.prototype.connect,
  spawn: childProcess.spawn,
  exec: childProcess.exec,
  execFile: childProcess.execFile,
  fork: childProcess.fork,
};

function refuse(what: string): Error {
  const message = `${GUARD_MESSAGE}: ${what}`;
  violations.push(message);
  return new Error(message);
}

globalThis.fetch = ((input: unknown) => Promise.reject(refuse(`fetch ${String(input)}`))) as typeof fetch;
net.Server.prototype.listen = function listen(): never {
  throw refuse('net.Server.listen');
} as typeof net.Server.prototype.listen;
net.Socket.prototype.connect = function connect(): never {
  throw refuse('net.Socket.connect');
} as typeof net.Socket.prototype.connect;
childProcess.spawn = (() => {
  throw refuse('child_process.spawn');
}) as unknown as typeof childProcess.spawn;
childProcess.exec = (() => {
  throw refuse('child_process.exec');
}) as unknown as typeof childProcess.exec;
childProcess.execFile = (() => {
  throw refuse('child_process.execFile');
}) as unknown as typeof childProcess.execFile;
childProcess.fork = (() => {
  throw refuse('child_process.fork');
}) as unknown as typeof childProcess.fork;
// `import { spawn } from 'node:child_process'` 같은 이름 import 에도 바뀐 함수가 보이게 한다.
syncBuiltinESMExports();

/** 지금까지 막힌 호출을 돌려주고 비운다(가드 자체를 시험할 때만 쓴다) */
export function takeViolations(): string[] {
  return violations.splice(0);
}

/** 원래 함수로 되돌린다 */
export function restoreNetwork(): void {
  globalThis.fetch = original.fetch;
  net.Server.prototype.listen = original.listen;
  net.Socket.prototype.connect = original.connect;
  childProcess.spawn = original.spawn;
  childProcess.exec = original.exec;
  childProcess.execFile = original.execFile;
  childProcess.fork = original.fork;
  syncBuiltinESMExports();
}

after(() => {
  restoreNetwork();
  const blocked = takeViolations();
  if (blocked.length > 0) {
    throw new Error(`${GUARD_MESSAGE} — ${blocked.length} blocked call(s):\n  ${blocked.join('\n  ')}`);
  }
});
