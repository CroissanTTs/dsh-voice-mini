import { zh } from "./zh.js";
import { en } from "./en.js";
export { zh, en };
const DICTS = { zh, en };
/**
 * Resolve the dictionary for a locale id. Unknown / empty values fall back to
 * `zh` (the shipping default) so a missing or malformed config never crashes.
 */
export function pickLocale(locale) {
    return locale === 'en' ? en : zh;
}
/** Coerce an arbitrary value into a valid `LocaleId` (default `zh`). */
export function normalizeLocale(value) {
    return value === 'en' ? 'en' : 'zh';
}
export const LOCALE_IDS = ['zh', 'en'];
