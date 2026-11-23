// 언어 결정과 메시지 조회.
// 우선순위: --lang > MCP_REFRESH_DOCTOR_LANG > LC_ALL > LC_MESSAGES > LANG. 한국어(ko…)가 아니면 영어.
import { en, type MessageKey } from './messages/en.js';
import { ko } from './messages/ko.js';
import type { Vars } from './types.js';

export type Lang = 'en' | 'ko';
export const LANGS: readonly Lang[] = ['en', 'ko'];
export const LANG_ENV = 'MCP_REFRESH_DOCTOR_LANG';

export const MESSAGES: Record<Lang, Record<MessageKey, string>> = { en, ko };

export function isLang(value: string | undefined): value is Lang {
  return value === 'en' || value === 'ko';
}

/** "ko_KR.UTF-8", "ko", "en_US" 같은 값을 en/ko 로 줄인다. 비어 있으면 undefined */
function fromLocale(value: string | undefined): Lang | undefined {
  if (!value) return undefined;
  return value.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export function resolveLang(argLang: string | undefined, env: NodeJS.ProcessEnv): Lang {
  if (isLang(argLang)) return argLang;
  const own = env[LANG_ENV]?.trim().toLowerCase();
  if (own) {
    if (own.startsWith('ko')) return 'ko';
    if (own.startsWith('en')) return 'en';
    // 알 수 없는 값은 무시하고 시스템 로캘로 넘어간다.
  }
  // POSIX 규칙: LC_ALL 이 있으면 그것, 없으면 LC_MESSAGES, 없으면 LANG
  return fromLocale(env.LC_ALL) ?? fromLocale(env.LC_MESSAGES) ?? fromLocale(env.LANG) ?? 'en';
}

export type Translate = (key: string, vars?: Vars) => string;

export function translator(lang: Lang): Translate {
  const table = MESSAGES[lang] as Record<string, string>;
  return (key, vars) => {
    // 없는 키는 키 그대로 보여 준다(테스트가 두 언어 키 집합이 같은지 확인한다).
    const template = table[key] ?? (en as Record<string, string>)[key] ?? key;
    return template.replace(/\{(\w+)\}/g, (whole, name: string) => (vars && name in vars ? String(vars[name]) : whole));
  };
}
