/**
 * Locale dictionary contract — shared by the host (server) and the client.
 *
 * `zh.ts` and `en.ts` are the two concrete dictionaries; `index.ts` exports
 * `pickLocale()` so a single call returns the right one for `config.locale`.
 *
 * Placeholders like `{title}`, `{tool}`, `{done}/{total}` stay as literal
 * text — the caller replaces them. The verbalizer prompt keeps `{reply}`.
 *
 * @module dsh-voice-mini/locale
 */
export {};
