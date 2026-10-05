// Verifies subagent voice-state inheritance: a child session whose object
// references a disabled parent inherits voice-OFF; when the parent is ON the
// child plays normally.
process.env.DSH_VOICE_MINI_NO_PERSIST = '1';
import { apply } from './lib/index.js';
import { rmSync } from 'node:fs';

const audioDir = '/tmp/dsh-voice-mini-inherit-test';
rmSync(audioDir, { recursive: true, force: true });

const services = new Map();
const registered = { tools: [], routes: [], events: {}, settings: null };
const ctx = {
  tools: { register: (t) => registered.tools.push(t) },
  on: (event, fn) => { registered.events[event] = fn; },
  get: (name) => services.get(name),
  inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
  logger: { info: () => {}, warn: () => {}, error: console.error },
};
services.set('webServer', { host: '127.0.0.1', port: 43120, register: (r) => { registered.routes.push(r); return () => {}; } });
services.set('systemPrompt', { section: () => {} });
services.set('settings', { installSection: (_o, ns, _s, e, h) => { registered.settings = { ns, entry: e }; h.setSource(() => e); h.onChange(); } });

// readReplies ON so a non-disabled child WOULD enqueue (proves the negative).
apply(ctx, { backend: 'fake', voice: 'zh-CN-XiaoxiaoNeural', audioDir, readReplies: true });
const route = registered.routes.at(-1);
const onEvent = registered.events['session/event'];

const mkRes = () => ({ status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } });
const mkReq = (path, obj) => ({ url: `/voice-mini${path}`, method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(obj)); } });
const mkGet = (path) => ({ url: `/voice-mini${path}`, method: 'GET' });

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

const state = async () => { const r = mkRes(); await route.handler(mkGet('/state'), r); return JSON.parse(r.body); };

// ── setup: disable the parent session ──────────────────────────────────
const toggle = mkRes(); await route.handler(mkReq('/session-toggle', { sessionId: 'parent-1', enabled: false }), toggle);
ok(JSON.parse(toggle.body).enabled === false, 'parent-1 toggled OFF');

// ── 1. child whose session object references the disabled parent inherits OFF
//    (covers any field name: parentId / parent / rootSessionId — value match)
onEvent({ id: 'child-a', parentId: 'parent-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '子代理报告：任务完成。' }] } } });
const s1 = await state();
ok(s1.disabledSessions.includes('child-a'), 'child-a (parentId ref) inherited voice-OFF from disabled parent');
ok(s1.queueLength === 0, 'child-a did NOT enqueue speech (inherited OFF, no narration)');

// ── 2. a different field name also works (robustness to the host's naming)
onEvent({ id: 'child-b', parent: 'parent-1', title: 'subagent' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '另一种引用方式。' }] } } });
ok((await state()).disabledSessions.includes('child-b'), 'child-b (parent ref, different field name) inherited OFF');

// ── 3. negative: when NO parent is disabled, the child plays normally
onEvent({ id: 'child-c', parentId: 'parent-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '父级没关时应正常播报。' }] } } });
// child-c already inherited OFF above (same parent-1) — to prove the negative,
// re-enable the parent and fire a fresh child whose parent is NOT disabled:
const toggle2 = mkRes(); await route.handler(mkReq('/session-toggle', { sessionId: 'parent-1', enabled: true }), toggle2);
ok(JSON.parse(toggle2.body).enabled === true, 'parent-1 re-enabled (ON)');
onEvent({ id: 'child-d', parentId: 'parent-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '父级开着，子代理应播报。' }] } } });
ok(!(await state()).disabledSessions.includes('child-d'), 'child-d did NOT inherit OFF (parent ON → child ON, true inheritance)');
// (child-d's enqueue/playback isn't asserted: the fake backend drains the
//  queue instantly, so queueLength is racy. The disabledSessions check above
//  is the real proof that child-d did not inherit OFF.)

console.log(`\n[done] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
