// Verifies the subagent default-OFF policy: a session whose object references a
// DIFFERENT already-seen session id is a subagent → voice OFF by default
// (regardless of the parent's state). Top-level sessions (no parent ref) stay ON.
// Recursive: catches nested refs (parent: {id: ...}) too.
process.env.DSH_VOICE_MINI_NO_PERSIST = '1';
import { apply } from './lib/index.js';
import { rmSync } from 'node:fs';

const audioDir = '/tmp/dsh-voice-mini-inherit-test';
rmSync(audioDir, { recursive: true, force: true });
const services = new Map();
const registered = { tools: [], routes: [], events: {}, settings: null };
const ctx = {
  tools: { register: (t) => registered.tools.push(t) },
  on: (e, fn) => { registered.events[e] = fn; },
  get: (n) => services.get(n),
  inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
  logger: { info: () => {}, warn: () => {}, error: console.error },
};
services.set('webServer', { host: '127.0.0.1', port: 43120, register: (r) => { registered.routes.push(r); return () => {}; } });
services.set('systemPrompt', { section: () => {} });
services.set('settings', { installSection: (_o, ns, _s, e, h) => { registered.settings = { ns, entry: e }; h.setSource(() => e); h.onChange(); } });
apply(ctx, { backend: 'fake', voice: 'zh-CN-XiaoxiaoNeural', audioDir, readReplies: true });
const route = registered.routes.at(-1);
const onEvent = registered.events['session/event'];
const mkRes = () => ({ status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } });
const mkReq = (p, o) => ({ url: `/voice-mini${p}`, method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(o)); } });
const mkGet = (p) => ({ url: `/voice-mini${p}`, method: 'GET' });
const state = async () => { const r = mkRes(); await route.handler(mkGet('/state'), r); return JSON.parse(r.body); };
const msg = (text) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } });
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓ ' + m); } else { fail++; console.log('  ✗ ' + m); } };

// ── 1. top-level session (no parent ref) → stays ON (not disabled)
onEvent({ id: 'main-1', title: '工作区' }, msg('主会话。'));
ok(!(await state()).disabledSessions.includes('main-1'), 'main-1 (top-level, no ref) stays ON');

// ── 2. subagent referencing the main → default OFF (parent ON, child still OFF)
onEvent({ id: 'child-a', parentId: 'main-1' }, msg('子代理报告。'));
ok((await state()).disabledSessions.includes('child-a'), 'child-a → subagent default-OFF (even with parent ON)');

// ── 3. nested ref (parent: {id: ...}) → detected via recursion → OFF
onEvent({ id: 'child-b', parent: { id: 'main-1' }, title: 'sub' }, msg('嵌套引用。'));
ok((await state()).disabledSessions.includes('child-b'), 'child-b → nested parent ref detected → OFF');

// ── 4. a DIFFERENT field name also works (robustness)
onEvent({ id: 'child-c', rootSessionId: 'main-1' }, msg('另一种字段名。'));
ok((await state()).disabledSessions.includes('child-c'), 'child-c → rootSessionId ref detected → OFF');

// ── 5. inheritance still holds: disable the main → a fresh child goes OFF too
const tg = mkRes(); await route.handler(mkReq('/session-toggle', { sessionId: 'main-1', enabled: false }), tg);
ok(JSON.parse(tg.body).enabled === false, 'main-1 toggled OFF');
onEvent({ id: 'child-d', parentId: 'main-1' }, msg('父已关。'));
ok((await state()).disabledSessions.includes('child-d'), 'child-d → inherited OFF (parent disabled)');

// ── 6. another fresh top-level session (no ref) still stays ON
onEvent({ id: 'solo-2', title: '另一个工作区' }, msg('独立顶层会话。'));
ok(!(await state()).disabledSessions.includes('solo-2'), 'solo-2 (top-level, no ref) stays ON');

console.log(`\n[done] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
