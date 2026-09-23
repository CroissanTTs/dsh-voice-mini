// PROTOTYPE — queue clear self-test (the signal dsh-harness-jarvis sends).
//   1. pause, then enqueue several phrases → they sit in the queue
//   2. POST /queue/clear → queue empty, paused cleared, nothing plays
//   3. a new phrase after clear plays normally
//   4. clear on an empty queue is a no-op
// Run: node test-queue-clear.mjs  (after `npm run build`)
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
const call = async (route, method, path) => {
  const res = { body: '', writeHead() {}, end(b) { this.body = b ?? ''; } };
  await route.handler({ url: path, method, socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res);
  return JSON.parse(res.body);
};
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } };

const { routes, events } = mkCtx();
const route = routes.at(-1);
const finishTurn = (sid) => {
  events['session/event']({ id: sid, header: { cwd: '/proj' } }, { type: 'turn/start', data: { turn: 1 } });
  events['session/event']({ id: sid, header: { cwd: '/proj' } }, { type: 'turn/end', data: { turn: 1, reason: 'completed' } });
};

// 1. Paused worker collects phrases.
await call(route, 'POST', '/voice-mini/pause');
finishTurn('session-a');
finishTurn('session-b');
await settle();
const s1 = await call(route, 'GET', '/voice-mini/state');
ok('queue holds items while paused', (s1.queueLength ?? 0) >= 1);
const recentBefore = (s1.recent ?? []).length;

// 2. Clear drops them all and unparks the worker.
const cleared = await call(route, 'POST', '/voice-mini/queue/clear');
ok('clear reports dropped count', cleared.ok === true && cleared.dropped === s1.queueLength);
await settle();
const s2 = await call(route, 'GET', '/voice-mini/state');
ok('queue empty after clear', (s2.queueLength ?? 0) === 0);
ok('paused cleared by clear', s2.paused === false);
ok('dropped items never played', (s2.recent ?? []).length === recentBefore);

// 3. New speech after clear plays normally.
finishTurn('session-c');
await settle();
const s3 = await call(route, 'GET', '/voice-mini/state');
ok('new phrase plays after clear', (s3.recent ?? []).length > recentBefore && (s3.queueLength ?? 0) === 0);

// 4. Clearing an empty queue is harmless.
const again = await call(route, 'POST', '/voice-mini/queue/clear');
ok('clear on empty queue is a no-op', again.ok === true && again.dropped === 0);

console.log(`\n[done] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
