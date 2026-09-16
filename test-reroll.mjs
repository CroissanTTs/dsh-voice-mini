process.env.DSH_VOICE_MINI_NO_PERSIST = '1'; // tests: don't touch the real config file
// PROTOTYPE — per-session voice re-roll self-test.
//   1. mount with a fake backend (no real audio, chime off)
//   2. establish a session, read its assigned voice
//   3. POST /voice/reroll → server picks a ≠ voice, stores override, enqueues a sample
//   4. verify: new voice differs, override flagged, a 'test' utterance played
// Run: node test-reroll.mjs  (after `npm run build`)
import { apply } from './lib/index.js';

const mkCtx = () => {
  const services = new Map();
  const routes = []; const events = {};
  const ctx = {
    tools: { register: () => {} },
    on: (e, fn) => { events[e] = fn; },
    get: (n) => services.get(n),
    inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
    logger: { warn: () => {} },
  };
  // voicePalette override so the palette is non-empty even under the fake
  // backend (whose default palette is []); the real app uses edge and gets the
  // 6-voice default automatically.
  const cfg = { backend: 'fake', audioDir: '/tmp/vmt', chimeEnabled: false, summarizeResult: false,
    voicePalette: ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunjianNeural', 'zh-CN-YunyangNeural'] };
  apply(ctx, cfg);
  services.set('webServer', { host: '127.0.0.1', port: 43120, register: (r) => { routes.push(r); return () => {}; } });
  services.set('systemPrompt', { section: () => {} });
  services.set('settings', { installSection: (_o, _n, _s, e, h) => { h.setSource(() => e); h.onChange(); } });
  apply(ctx, cfg);
  return { routes, events };
};

const stateOf = async (route) => {
  const res = { body: '', writeHead() {}, end(b) { this.body = b ?? ''; } };
  await route.handler({ url: '/voice-mini/state', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res);
  return JSON.parse(res.body);
};
const reroll = async (route, sessionId) => {
  const res = { body: '', writeHead() {}, end(b) { this.body = b ?? ''; } };
  const req = { url: '/voice-mini/voice/reroll', method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ sessionId })); } };
  await route.handler(req, res);
  return JSON.parse(res.body);
};
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } };

const { routes, events } = mkCtx();
const route = routes.at(-1);
const SID = 'session-reroll-test-aaaa-bbbb-cccc';

// Establish the session via a turn/start event (sets lastSessionId).
events['session/event']({ id: SID, header: { cwd: '/proj' } }, { type: 'turn/start', data: { turn: 1 } });

const before = await stateOf(route);
const voiceBefore = before.sessionVoice;
ok(`session has an assigned voice (${voiceBefore})`, typeof voiceBefore === 'string' && voiceBefore !== '');
ok(`not overridden initially`, before.sessionVoiceOverridden === false);

const r = await reroll(route, SID);
ok(`reroll returns ok`, r.ok === true);
ok(`reroll returns a voice label (${r.voiceLabel})`, typeof r.voiceLabel === 'string' && r.voiceLabel !== '');
ok(`reroll picked a DIFFERENT voice (${voiceBefore} → ${r.voice})`, r.voice !== voiceBefore);

await settle();
const after = await stateOf(route);
ok(`override now flagged`, after.sessionVoiceOverridden === true);
ok(`state's sessionVoice matches the re-rolled one`, after.sessionVoice === r.voiceLabel);
// A 'test' utterance was enqueued + played (fake backend → instant).
const hadTest = (after.recent ?? []).some((x) => x.kind === 'test');
ok(`a sample utterance played after reroll`, hadTest);

// Re-roll again — should change again (or at least re-jitter), and stay overridden.
const r2 = await reroll(route, SID);
await settle();
const after2 = await stateOf(route);
ok(`second reroll stays overridden`, after2.sessionVoiceOverridden === true);

console.log(`\n[done] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
