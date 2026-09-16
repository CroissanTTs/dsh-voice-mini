process.env.DSH_VOICE_MINI_NO_PERSIST = '1'; // tests: don't touch the real config file
// PROTOTYPE — i18n self-test. Verifies:
//   1. both locale dictionaries expose the same key structure (no drift)
//   2. pickLocale resolves the right dict for zh / en / unknown
//   3. the verbalizer prompt is in the right language per locale
//   4. switching config.locale flips the *spoken* turn-end phrase (integration)
// Run: node test-i18n.mjs  (after `npm run build`)
import { zh, en, pickLocale, normalizeLocale, LOCALE_IDS } from './lib/locale/index.js';
import { apply } from './lib/index.js';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } };

// ── 1. structural parity: every key path in zh exists in en and vice-versa ──
function keypaths(obj, prefix = '') {
  const out = [];
  for (const k of Object.keys(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (obj[k] !== null && typeof obj[k] === 'object' && !Array.isArray(obj[k])) out.push(...keypaths(obj[k], p));
    else out.push(p);
  }
  return out;
}
const zhPaths = keypaths(zh);
const enPaths = keypaths(en);
ok(`zh dict has ${zhPaths.length} leaf keys`, zhPaths.length > 30);
ok(`en dict has same leaf-key count (${enPaths.length})`, zhPaths.length === enPaths.length);
ok('every zh key exists in en', zhPaths.every((p) => enPaths.includes(p)));
ok('every en key exists in zh', enPaths.every((p) => zhPaths.includes(p)));

// ── 2. pickLocale resolution ────────────────────────────────────────────────
ok(`pickLocale('zh') → zh`, pickLocale('zh') === zh);
ok(`pickLocale('en') → en`, pickLocale('en') === en);
ok(`pickLocale(undefined) → zh (fallback)`, pickLocale(undefined) === zh);
ok(`pickLocale('fr') → zh (unknown → fallback)`, pickLocale('fr') === zh);
ok(`normalizeLocale('en') → 'en'`, normalizeLocale('en') === 'en');
ok(`normalizeLocale('zh') → 'zh'`, normalizeLocale('zh') === 'zh');
ok(`normalizeLocale(null) → 'zh'`, normalizeLocale(null) === 'zh');
ok(`LOCALE_IDS = ['zh','en']`, LOCALE_IDS.join(',') === 'zh,en');

// ── 3. verbalizer prompt language ───────────────────────────────────────────
ok(`zh prompt is Chinese (第一人称)`, zh.summarizePrompt.includes('第一人称'));
ok(`en prompt is English (first person)`, en.summarizePrompt.includes('first person'));
ok(`zh/en prompts are not identical`, zh.summarizePrompt !== en.summarizePrompt);
ok(`both prompts carry {reply} slot`, zh.summarizePrompt.includes('{reply}') && en.summarizePrompt.includes('{reply}'));

// ── 4. integration: config.locale flips spoken turn-end phrase ─────────────
const mkCtx = (cfg) => {
  const services = new Map();
  const routes = []; const events = {};
  const ctx = {
    tools: { register: () => {} },
    on: (e, fn) => { events[e] = fn; },
    get: (n) => services.get(n),
    inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
    logger: { warn: () => {} },
  };
  const c = { backend: 'fake', audioDir: '/tmp/vmt', chimeEnabled: false, summarizeResult: false, ...cfg };
  apply(ctx, c);
  services.set('webServer', { host: '127.0.0.1', port: 43120, register: (r) => { routes.push(r); return () => {}; } });
  services.set('systemPrompt', { section: () => {} });
  services.set('settings', { installSection: (_o, _n, _s, e, h) => { h.setSource(() => e); h.onChange(); } });
  apply(ctx, c);
  return { routes, events };
};
const stateOf = async (route) => {
  const res = { body: '', writeHead() {}, end(b) { this.body = b ?? ''; } };
  await route.handler({ url: '/voice-mini/state', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res);
  return JSON.parse(res.body);
};
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

// zh: turn/end with no reply → Chinese template
{
  const { routes, events } = mkCtx({ locale: 'zh' });
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/Users/zane/proj' } }, { type: 'turn/start', data: { turn: 1 } });
  ev({ id: 's1', header: { cwd: '/Users/zane/proj' } }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
  await settle();
  const s = await stateOf(routes.at(-1));
  const last = s.recent?.at(-1);
  ok(`zh turn-end spoken in Chinese`, last?.text === '工作区 proj 下的会话已完成');
}
// en: same flow → English template
{
  const { routes, events } = mkCtx({ locale: 'en' });
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/Users/zane/proj' } }, { type: 'turn/start', data: { turn: 1 } });
  ev({ id: 's1', header: { cwd: '/Users/zane/proj' } }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
  await settle();
  const s = await stateOf(routes.at(-1));
  const last = s.recent?.at(-1);
  ok(`en turn-end spoken in English`, last?.text === 'Session in workspace proj is complete');
}
// en: abnormal reason → English phrase
{
  const { routes, events } = mkCtx({ locale: 'en' });
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/Users/zane/proj' } }, { type: 'turn/start', data: { turn: 1 } });
  ev({ id: 's1', header: { cwd: '/Users/zane/proj' } }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'aborted' } } });
  await settle();
  const s = await stateOf(routes.at(-1));
  const last = s.recent?.at(-1);
  ok(`en abnormal reason (aborted) → English`, last?.text === 'proj：Session aborted');
}
// zh: approval/asked → Chinese
{
  const { routes, events } = mkCtx({ locale: 'zh', announceApproval: true, statusSpeech: true, chimeEnabled: false });
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/Users/zane/proj' } }, { type: 'approval/asked', data: { toolName: 'bash', reason: 'rm -rf' } });
  await settle();
  const s = await stateOf(routes.at(-1));
  const last = s.recent?.at(-1);
  ok(`zh approval spoken in Chinese`, last?.text === '有操作需要你批准');
}
// en: approval/asked → English
{
  const { routes, events } = mkCtx({ locale: 'en', announceApproval: true, statusSpeech: true, chimeEnabled: false });
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/Users/zane/proj' } }, { type: 'approval/asked', data: { toolName: 'bash', reason: 'rm -rf' } });
  await settle();
  const s = await stateOf(routes.at(-1));
  const last = s.recent?.at(-1);
  ok(`en approval spoken in English`, last?.text === 'An action needs your approval');
}

console.log(`\n[done] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
