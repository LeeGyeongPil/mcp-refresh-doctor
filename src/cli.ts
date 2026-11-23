#!/usr/bin/env node
// mcp-refresh-doctor 명령줄 입구: check / serve / demo
// 종료 코드: 0 = 서버 갱신 준비 완료(클라이언트 원인), 1 = 서버 원인, 2 = 판정 불가·사용법 오류
import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runChecks } from './checks.js';
import { renderDemoTable, runDemo } from './demo.js';
import { PRESET_NAMES, isPresetName } from './fake/presets.js';
import { startFakeServer } from './fake/server.js';
import { isLoopbackHost, urlPolicyError } from './http.js';
import { isLang, resolveLang, translator, type Translate } from './i18n.js';
import { Redactor } from './mask.js';
import { buildJsonReport, renderText } from './report.js';
import type { Transport } from './transport.js';
import { TOOL_VERSION } from './types.js';
import { decideVerdict } from './verdict.js';

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
}

/**
 * 시험용 주입점. 기본(빈 객체)은 실제 네트워크다.
 * 단위 시험은 in-process 전송을 넣어 `check` 명령 전체(출력·--out·종료 코드)를 소켓 없이 돌린다.
 */
export interface MainDeps {
  transport?: Transport;
}

const defaultIo: Io = {
  out: (text) => process.stdout.write(text + '\n'),
  err: (text) => process.stderr.write(text + '\n'),
};

/** --lang 값을 파싱 전에 먼저 찾는다(파싱 오류 문구도 고른 언어로 내기 위해) */
function findLangArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--lang') return argv[i + 1] ?? '';
    if (a.startsWith('--lang=')) return a.slice('--lang='.length);
  }
  return undefined;
}

function parseNumber(value: string | undefined, fallback: number): number | undefined {
  if (value === undefined) return fallback;
  if (!/^\d+(\.\d+)?$/.test(value)) return undefined;
  return Number(value);
}

/** 값을 받는 숫자 옵션과 각각의 허용 범위 */
type NumberRule = 'non_negative' | 'positive' | 'port';
const NUMBER_OPTIONS: Record<string, NumberRule> = {
  '--max-wait': 'non_negative',
  '--timeout': 'positive', // 0 이면 모든 요청이 즉시 시간 초과로 끝나 판정을 낼 수 없다
  '--redirect-port': 'port',
  '--port': 'port',
  '--ttl': 'non_negative',
};

/** 규칙을 어기면 사용자에게 보일 메시지 키를, 맞으면 undefined 를 돌려준다 */
function numberRuleError(rule: NumberRule, value: number | undefined): string | undefined {
  if (value === undefined) return rule === 'port' ? 'error.bad_port' : 'error.bad_number';
  if (rule === 'positive' && value <= 0) return 'error.positive_number';
  // 포트는 정수 0~65535 — 넘기면 Node 의 영어 원문 오류 대신 고른 언어의 안내를 낸다.
  if (rule === 'port' && (!Number.isInteger(value) || value > 65535)) return 'error.bad_port';
  return undefined;
}

/** 명령마다 받는 위치 인자 개수(명령 이름 포함): check <url> 은 2, serve·demo 는 1 */
const MAX_POSITIONALS: Record<string, number> = { check: 2, serve: 1, demo: 1 };

export async function main(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  io: Io = defaultIo,
  deps: MainDeps = {},
): Promise<number> {
  const langArg = findLangArg(argv);
  const lang = resolveLang(langArg, env);
  const t = translator(lang);
  if (langArg !== undefined && !isLang(langArg)) {
    io.err(t('error.bad_lang'));
    return 2;
  }

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        lang: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
        'client-id': { type: 'string' },
        'redirect-port': { type: 'string' },
        scope: { type: 'string' },
        'wait-expiry': { type: 'boolean' },
        'max-wait': { type: 'string' },
        timeout: { type: 'string' },
        'allow-http': { type: 'boolean' },
        'auto-consent': { type: 'boolean' },
        json: { type: 'boolean' },
        out: { type: 'string' },
        preset: { type: 'string' },
        port: { type: 'string' },
        ttl: { type: 'string' },
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: string }).code;
    const name = /'(--?[\w-]+)/.exec(message)?.[1] ?? '';
    // "--ttl -1" 은 parseArgs 가 -1 을 옵션으로 읽어 "값이 없다"고 한다. 진짜 문제는 음수이므로 그렇게 알려 준다.
    const next = argv[argv.indexOf(name) + 1] ?? '';
    const rule = NUMBER_OPTIONS[name];
    if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') io.err(t('error.unknown_option', { name }));
    else if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && rule && /^-\d/.test(next)) {
      io.err(t(rule === 'port' ? 'error.bad_port' : 'error.bad_number', { opt: name }));
    } else if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') io.err(t('error.option_value', { name }));
    else io.err(t('error.args', { message }));
    return 2;
  }
  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.version) {
    io.out(TOOL_VERSION);
    return 0;
  }
  if (values.help) {
    io.out(t('help'));
    return 0;
  }
  if (!command) {
    io.err(t('help'));
    return 2;
  }

  // 숫자 옵션 공통 확인
  const numbers: Record<string, number | undefined> = {
    '--max-wait': parseNumber(values['max-wait'], 3700),
    '--timeout': parseNumber(values.timeout, 15),
    '--redirect-port': parseNumber(values['redirect-port'], 0),
    '--port': parseNumber(values.port, 8787),
    '--ttl': parseNumber(values.ttl, 3600),
  };
  for (const [opt, value] of Object.entries(numbers)) {
    const problem = numberRuleError(NUMBER_OPTIONS[opt] ?? 'non_negative', value);
    if (problem) {
      io.err(t(problem, { opt }));
      return 2;
    }
  }

  // 남는 위치 인자는 조용히 버리지 않고 사용법 오류로 알린다(예: check <url> extra).
  const maxPositionals = MAX_POSITIONALS[command];
  if (maxPositionals !== undefined && positionals.length > maxPositionals) {
    io.err(t('error.extra_args', { cmd: command, arg: positionals[maxPositionals] ?? '' }));
    return 2;
  }

  if (command === 'check') {
    return check(positionals[1], values, numbers as Record<string, number>, lang, t, io, deps);
  }
  if (command === 'serve') {
    return serve(values.preset ?? 'good', numbers['--port'] ?? 8787, numbers['--ttl'] ?? 3600, t, io);
  }
  if (command === 'demo') {
    const rows = await runDemo();
    if (values.json) io.out(JSON.stringify(rows, null, 2));
    else io.out(renderDemoTable(rows, t));
    return rows.every((r) => r.matchesExpected) ? 0 : 1;
  }
  io.err(t('error.unknown_command', { cmd: command }));
  return 2;
}

async function check(
  url: string | undefined,
  values: Record<string, string | boolean | undefined>,
  numbers: Record<string, number>,
  lang: 'en' | 'ko',
  t: Translate,
  io: Io,
  deps: MainDeps,
): Promise<number> {
  if (!url) {
    io.err(t('error.missing_url'));
    return 2;
  }
  // 안전장치 1: 루프백이 아닌 호스트로 평문 http 를 보내지 않는다(토큰이 그대로 노출된다).
  const policy = urlPolicyError(url, values['allow-http'] === true);
  if (policy === 'invalid_url') {
    io.err(t('error.invalid_url', { url }));
    return 2;
  }
  if (policy === 'plain_http') {
    io.err(t('error.plain_http'));
    return 2;
  }
  // 안전장치 2: 자동 동의는 내 컴퓨터에 띄운 시험 서버에서만.
  const autoConsent = values['auto-consent'] === true;
  if (autoConsent && !isLoopbackHost(new URL(url).hostname)) {
    io.err(t('error.auto_consent_remote'));
    return 2;
  }

  if (typeof values['client-id'] === 'string' && values['redirect-port'] === undefined) {
    io.err(t('error.client_id_needs_port'));
    return 2;
  }

  const red = new Redactor();
  const clientId = typeof values['client-id'] === 'string' ? values['client-id'] : undefined;
  const scope = typeof values.scope === 'string' ? values.scope : undefined;
  const run = await runChecks({
    url,
    ...(clientId ? { clientId } : {}),
    ...(scope !== undefined ? { scope } : {}),
    redirectPort: numbers['--redirect-port'] ?? 0,
    waitExpiry: values['wait-expiry'] === true,
    maxWaitSec: numbers['--max-wait'] ?? 3700,
    timeoutSec: numbers['--timeout'] ?? 15,
    allowHttp: values['allow-http'] === true,
    autoConsent,
    callbackPageText: t('callback.page'),
    redactor: red,
    ...(deps.transport ? { transport: deps.transport } : {}),
    progress: (event) => {
      // 진행 표시는 표준 오류로 — 표준 출력(JSON 보고서)을 더럽히지 않는다.
      if (event.type === 'login_url') {
        io.err(t('progress.login_url'));
        io.err(`  ${event.url}`);
        io.err(t('progress.waiting_login'));
      } else if (event.type === 'waiting_expiry') {
        io.err(t('progress.waiting_expiry', { seconds: event.seconds }));
      }
    },
  });
  const verdict = decideVerdict(run);
  const json = buildJsonReport(run, verdict, lang, t, red);
  if (values.json === true) io.out(JSON.stringify(json, null, 2));
  else io.out(renderText(run, verdict, t, red));
  if (typeof values.out === 'string') {
    try {
      await writeFile(values.out, JSON.stringify(json, null, 2) + '\n', 'utf8');
      io.err(t('report.wrote', { file: values.out }));
    } catch (err) {
      // 파일 저장 실패가 판정 종료 코드를 가리지 않게 경고만 남긴다.
      const reason = (err as { code?: string }).code ?? 'error';
      io.err(t('report.write_failed', { file: values.out, reason }));
    }
  }
  return verdict.exitCode;
}

async function serve(presetName: string, port: number, ttl: number, t: Translate, io: Io): Promise<number> {
  if (!isPresetName(presetName)) {
    io.err(t('error.unknown_preset', { name: presetName, list: PRESET_NAMES.join(', ') }));
    return 2;
  }
  const time = (): string => new Date().toISOString().slice(11, 19);
  const server = await startFakeServer({
    preset: presetName,
    port,
    ttlSec: ttl,
    log: (line) => io.out(`${time()}  ${line}`), // 로그 줄의 토큰은 서버가 이미 가려서 넘긴다
  });
  io.out(t('serve.banner', { preset: presetName }));
  io.out(t('serve.listening', { url: server.mcpUrl }));
  io.out(t('serve.ttl', { ttl }));
  // Ctrl+C·종료 신호가 오면 소켓을 모두 닫고 끝낸다.
  await new Promise<void>((resolve) => {
    process.once('SIGINT', () => resolve());
    process.once('SIGTERM', () => resolve());
  });
  await server.close();
  return 0;
}

// 직접 실행(npx·node dist/cli.js·npm bin 심볼릭 링크)일 때만 main 을 돈다. 테스트는 main 을 import 한다.
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 2;
    },
  );
}
