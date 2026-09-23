// PROTOTYPE — speech signals to dsh-harness-jarvis.
//   1. Jarvis's own line (/test jarvis:true) → start/end with source 'jarvis'
//   2. Jarvis session's reply → source 'jarvis' (same session id as the service)
//   3. another session's line → source 'session' + its sessionId
//   4. every start has exactly one matching end, in order
//   5. a throwing Jarvis callback never breaks playback
// Run: node test-jarvis-speech.mjs  (after `npm run build`)
process.env.DSH_VOICE_MINI_NO_PERSIST = '1';
import { apply } from './lib/index.js';

const JARVIS_SID = 'session-jarvis';

const mkCtx = (speech) => {
  const services = new Map();
  const routes = []; const events = {};
  const ctx = {
    tools: { register: () => {} },
    on: (e, fn) => { events[e] = fn; },
    get: (n) => services.get(n),
    inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
    logger: { warn: () => {} },
  };
  const cfg = { backend: 'fake', audioDir: '/tmp/vmt', chimeEnabled: false, summarizeResult: false, statusEnabled: true, announceTurnEnd: true };
  services.set('webServer', { host: '127.0.0.1', port: 43120, register: (r) => { routes.push(r); return () => {}; } });
  services.set('systemPrompt', { section: () => {} });
  services.set('settings', { installSection: (_o, _n, _s, e, h) => { h.setSource(() => e); h.onChange(); } });
  services.set('jarvis', { sessionId: JARVIS_SID, speech });
  apply(ctx, cfg);
  return { routes, events };
};
const post = async (route, path, body) => {
  const res = { body: '', writeHead() {}, end(b) { this.body = b ?? ''; } };
  const req = { url: path, method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body ?? {})); };
  req.on = (ev, fn) => { if (ev === 'data') fn(Buffer.from(JSON.stringify(body ?? {}))); if (ev === 'end') fn(); return req; };
  await route.handler(req, res);
  return res.body;
};
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const finishTurn = (events, sid) => {
  events['session/event']({ id: sid, header: { cwd: '/proj' } }, { type: 'turn/start', data: { turn: 1 } });
  events['session/event']({ id: sid, header: { cwd: '/proj' } }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
};

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } };

// ── normal callback ───────────────────────────────────────────────────────
const signals = [];
const { routes, events } = mkCtx((s) => signals.push(s));
const route = routes.at(-1);

await post(route, '/voice-mini/test', { text: '晚上好，先生。', jarvis: true });
await settle();
const own = signals.filter((s) => s.source === 'jarvis');
ok('Jarvis line reports start then end', own.length === 2 && own[0].phase === 'start' && own[1].phase === 'end');
ok('start/end share one id', own[0]?.id === own[1]?.id);

signals.length = 0;
finishTurn(events, JARVIS_SID);
await settle();
ok('Jarvis session narration is sourced as jarvis',
  signals.length >= 2 && signals.every((s) => s.source === 'jarvis' && s.sessionId === JARVIS_SID));

signals.length = 0;
finishTurn(events, 'session-worker');
await settle();
ok('other session narration is sourced as session',
  signals.length >= 2 && signals.every((s) => s.source === 'session' && s.sessionId === 'session-worker'));

const byId = new Map();
for (const s of signals) byId.set(s.id, [...(byId.get(s.id) ?? []), s.phase]);
ok('every start has exactly one end', [...byId.values()].every((p) => p.length === 2 && p[0] === 'start' && p[1] === 'end'));

// ── throwing callback ─────────────────────────────────────────────────────
const bad = mkCtx(() => { throw new Error('jarvis down'); });
const badRoute = bad.routes.at(-1);
finishTurn(bad.events, 'session-x');
await settle();
const state = JSON.parse(await new Promise((resolve) => {
  const res = { writeHead() {}, end(b) { resolve(b ?? '{}'); } };
  void badRoute.handler({ url: '/voice-mini/state', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res);
}));
ok('throwing Jarvis callback does not stall the queue', (state.queueLength ?? 0) === 0 && (state.recent ?? []).length > 0);

console.log(`\n[done] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
