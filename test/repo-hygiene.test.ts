// 공개 레포 위생: 소스·시험·문서의 주석과 글이 레포에 없는 작업 파일이나 내부 번호를 가리키지 않는다.
// 읽는 사람이 따라갈 수 없는 참조(예: 작업 노트 파일 이름, 계획서의 항목 번호)는 그 자리에서 이유를 직접 쓴다.
import './support/no-network.js';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { test } from 'node:test';

// 시험은 dist-test/test/ 에서 돈다 → 레포 루트는 두 단계 위
const root = new URL('../../', import.meta.url);
const SELF = 'repo-hygiene.test.ts';

/** dir 아래의 글 파일(.ts·.mjs·.yml·.md)을 모두 모은다 */
function collect(dir: URL, out: URL[] = []): URL[] {
  for (const name of readdirSync(dir)) {
    const url = new URL(name, dir);
    if (statSync(url).isDirectory()) collect(new URL(name + '/', dir), out);
    else if (/\.(ts|mjs|yml|md)$/.test(name) && name !== SELF) out.push(url);
  }
  return out;
}

test('no references to internal working files or plan item numbers', () => {
  const files = [
    ...collect(new URL('src/', root)),
    ...collect(new URL('test/', root)),
    ...collect(new URL('.github/', root)),
    ...['README.md', 'README.ko.md', 'CHANGELOG.md', 'SECURITY.md'].map((f) => new URL(f, root)),
  ];
  assert.ok(files.length > 20, `scanned ${files.length} files`);
  const forbidden = [/build-notes/i, /\bplan\.(md|json)\b/, /\bqa(-fresh)?\.json\b/, /\bAC-\d+\b/, /\bRound \d+/];
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const re of forbidden) if (re.test(line)) hits.push(`${file.pathname.replace(root.pathname, '')}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, []);
});
