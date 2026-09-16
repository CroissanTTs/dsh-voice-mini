import type { LocaleDict, LocaleId } from './types.ts';
import { zh } from './zh.ts';
import { en } from './en.ts';

export type { LocaleDict, LocaleId };
export { zh, en };

const DICTS: Record<LocaleId, LocaleDict> = { zh, en };

/**
 * Resolve the dictionary for a locale id. Unknown / empty values fall back to
 * `zh` (the shipping default) so a missing or malformed config never crashes.
 */
export function pickLocale(locale: unknown): LocaleDict {
  return locale === 'en' ? en : zh;
}

/** Coerce an arbitrary value into a valid `LocaleId` (default `zh`). */
export function normalizeLocale(value: unknown): LocaleId {
  return value === 'en' ? 'en' : 'zh';
}

export const LOCALE_IDS: readonly LocaleId[] = ['zh', 'en'];
