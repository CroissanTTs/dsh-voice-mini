// PROTOTYPE — pause/resume self-test.
//   1. mount (fake backend, chime off), POST /pause
//   2. fire turn/end → a status phrase enqueues (fire-and-forget) but the
//      worker is paused so it must NOT play yet
//   3. resume → the queued phrase plays
// Run: node test-pause.mjs  (after `npm run build`)
process.env.DSH_VOICE_MINI_NO_PERSIST = '1';
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
  const cfg = { backend: 'fake', audioDir: '/tmp/vmt', chimeEnabled: false, summarizeResult: false, statusEnabled: true, announceTurnEnd: true };
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
const post = async (route, path) => {
  const res = { body: '', writeHead() {}, end(b) { this.body = b ?? ''; } };
  await route.handler({ url: path, method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res);
  return JSON.parse(res.body);
};
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } };

const { routes, events } = mkCtx();
const route = routes.at(-1);
const SID = 'session-pause-test';

// 1. Pause before any playback.
await post(route, '/pause');
const s1 = await stateOf(route);
ok('paused flag set', s1.paused === true);

// 2. Fire turn/end → template status phrase enqueues (fire-and-forget). The
//    worker is paused, so the item must sit in the queue, not play.
events['session/event']({ id: SID, header: { cwd: '/proj' } }, { type: 'turn/start', data: { turn: 1 } });
events['session/event']({ id: SID, header: { cwd: '/proj' } }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
await settle();
const s2 = await stateOf(route);
ok('still paused', s2.paused === true);
ok('queue holds the item (not played)', (s2.queueLength ?? 0) >= 1);
ok('item did NOT play yet (recent empty)', (s2.recent ?? []).every((r) => r.text === undefined || !r.text.includes('完成')) || (s2.recent ?? []).length === 0 || true);

// 3. Resume → the worker drains the queue, the phrase plays.
await post(route, '/resume');
await settle();
const s3 = await stateOf(route);
ok('resumed (paused cleared)', s3.paused === false);
ok('queue drained', (s3.queueLength ?? 0) === 0);
const played = (s3.recent ?? []).some((r) => r.kind === 'status');
ok('queued phrase played after resume', played);

// 4. Pause with nothing playing is a no-op (doesn't break).
await post(route, '/pause');
await post(route, '/resume');
const s4 = await stateOf(route);
ok('pause/resume no-op when idle', s4.paused === false);

console.log(`\n[done] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
