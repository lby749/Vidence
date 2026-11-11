import type { Settings } from '@/shared/types';
import english from './locales/en.json';
import traditional from './locales/zh-TW.json';

export type UiLocale = 'zh-CN' | 'zh-TW' | 'en';
export type UiLanguage = NonNullable<Settings['uiLanguage']>;
export const UI_LANGUAGES = { auto: '跟随系统', 'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English' } as const;
export function resolveUiLocale(preference: unknown, system = typeof navigator === 'undefined' ? 'zh-CN' : navigator.language): UiLocale {
  if (preference === 'zh-CN' || preference === 'zh-TW' || preference === 'en') return preference;
  return /^zh-(TW|HK|MO|Hant)/i.test(system) ? 'zh-TW' : /^zh/i.test(system) ? 'zh-CN' : 'en';
}
const dictionaries: Record<string, Record<string, string>> = { en: english, 'zh-TW': traditional };
const fragmentKeys = Object.keys(english).sort((a,b) => b.length-a.length);
export function translateUi(value: string, locale: UiLocale): string {
  const dictionary = dictionaries[locale];
  if (!dictionary) return value;
  const trimmed = value.trim();
  if (dictionary[trimmed]) return value.replace(trimmed, dictionary[trimmed]);
  if (!/[\u3400-\u9fff]/.test(value)) return value;
  // 数字、时间和服务名保留；模板中的固定片段仍可翻译。
  let translated = value;
  for (const key of fragmentKeys) if (key.length > 1 && translated.includes(key)) translated = translated.replaceAll(key, dictionary[key] ?? key);
  return translated;
}

