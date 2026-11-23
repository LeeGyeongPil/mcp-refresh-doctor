// node --test 용 reporter(CI 전용): 실패한 테스트마다 GitHub Actions 주석(::error::) 한 줄을 낸다.
// 주석은 로그를 내려받지 않아도 실행 요약 화면과 `gh run view` 에 보이므로, CI 가 왜 실패했는지 바로 읽힌다.
// 사용: node --test --test-reporter=spec --test-reporter-destination=stdout \
//         --test-reporter=./.github/test-annotations.mjs --test-reporter-destination=stdout <files>
//
// 이 reporter 는 어떤 입력에도 예외를 던지지 않는다 — reporter 가 깨져 테스트 단계가 실패하면
// 진단 도구가 오히려 새 실패 원인이 되기 때문이다. 통과·실패 판정(종료 코드)은 러너가 그대로 낸다.

import { resolve } from 'node:path';

// 주석 하나의 본문 상한(e2e 단언 메시지는 serve 로그까지 담아 길다)
const MAX_MESSAGE = 3000;
// 테스트 파일마다 기억해 둘 표준 오류의 끝부분(파일이 통째로 죽었을 때 원인이 여기에만 있다)
const MAX_STDERR = 1500;

// GitHub 워크플로 명령 이스케이프 규칙(@actions/core command.ts 와 같다)
export function escapeData(text) {
  return String(text).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function escapeProperty(text) {
  return escapeData(text).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

/**
 * 실패 이벤트 하나 → 주석 한 줄. 주석을 낼 필요가 없으면 undefined.
 * stderrTail: 그 테스트 파일이 표준 오류에 쓴 마지막 부분(없으면 빈 문자열)
 */
export function annotationFor(data, stderrTail = '') {
  const error = data?.details?.error;
  // 하위 테스트가 실패해서 같이 실패한 부모는 건너뛴다(자식 주석이 원인을 담는다)
  if (error?.failureType === 'subtestsFailed') return undefined;
  // 테스트 파일에서 난 실패는 ERR_TEST_FAILURE 로 감싸이고, 원래 오류(단언 메시지)는 cause 에 있다
  const cause = error?.cause ?? error;
  let reason = cause?.message ?? (cause === undefined ? '' : String(cause));
  // 파일이 불러오는 도중 죽으면 이유가 "test failed" 뿐이다 — 진짜 원인은 그 파일의 표준 오류에 있다
  if (reason.trim() === 'test failed' && stderrTail) reason = `test file failed; last stderr:\n${stderrTail}`;
  const file = typeof data?.file === 'string' ? data.file.split(/[\\/]/).pop() : '';
  const name = String(data?.name ?? 'unnamed test');
  const title = `test failed: ${file ? `${file} > ` : ''}${name}`;
  const message = `${name}\n${reason}`.slice(0, MAX_MESSAGE);
  // 앞의 줄바꿈: 다른 reporter 출력과 섞여도 명령이 줄 맨 앞에서 시작하게 한다
  return `\n::error title=${escapeProperty(title)}::${escapeData(message)}\n`;
}

/** 이벤트의 file 을 같은 키로 맞춘다(Node 22+ 는 표준 오류 이벤트에 상대 경로, 실패 이벤트에 절대 경로를 싣는다) */
function fileKey(file) {
  return typeof file === 'string' && file ? resolve(file) : '';
}

export default async function* githubAnnotations(source) {
  const stderrByFile = new Map(); // 테스트 파일 수만큼만 생긴다
  for await (const event of source) {
    try {
      if (event?.type === 'test:stderr') {
        const key = fileKey(event.data?.file);
        const text = (stderrByFile.get(key) ?? '') + String(event.data?.message ?? '');
        stderrByFile.set(key, text.slice(-MAX_STDERR));
        continue;
      }
      if (event?.type !== 'test:fail') continue;
      const line = annotationFor(event.data, stderrByFile.get(fileKey(event.data?.file)) ?? '');
      if (line) yield line;
    } catch {
      // 주석을 못 만들어도 테스트 결과는 spec reporter 와 종료 코드로 남는다
    }
  }
}
