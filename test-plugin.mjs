process.env.DSH_VOICE_MINI_NO_PERSIST = '1'; // tests: don't touch the real config file
// PROTOTYPE — smoke test v0.2: queue, chime, status announcements, routes.
// Mock ctx fires ctx.inject only when the named service exists (the real race).
// Run: node test-plugin.mjs  (after `npm run build`)
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { apply, Config } from './lib/index.js';

const audioDir = '/tmp/dsh-voice-mini-test';
rmSync(audioDir, { recursive: true, force: true });
const services = new Map();
const registered = { tools: [], routes: [], events: {}, settings: null };

const ctx = {
  tools: { register: (t) => registered.tools.push(t) },
  on: (event, fn) => { registered.events[event] = fn; },
  get: (name) => services.get(name),
  inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
  logger: { info: console.log, warn: console.warn, error: console.error },
};

console.log('[config defaults]', JSON.stringify(Config({})));

// Phase 1: services NOT present (the race that broke routes before).
apply(ctx, { backend: 'fake', voice: 'zh-CN-XiaoxiaoNeural', audioDir });
console.log('[phase1 no-svc] routes =', registered.routes.length);

// Phase 2: bring services up, re-apply.
services.set('webServer', { host: '127.0.0.1', port: 43120, register: (r) => { registered.routes.push(r); return () => {}; } });
services.set('systemPrompt', { section: (s) => { console.log('[persona] section =', s.name); } });
services.set('settings', {
  installSection: (_o, ns, _s, e, h) => {
    registered.settings = { ns, entry: e };
    h.setSource(() => e); h.onChange();
  },
});
apply(ctx, { backend: 'fake', voice: 'zh-CN-XiaoxiaoNeural', audioDir });
console.log('[phase2 with-svc] routes =', registered.routes.length, '| settings =', registered.settings?.ns);

// chime file is materialized lazily inside utter() — checked AFTER speak below.
const route = registered.routes.at(-1);

// GET /state — should now carry v0.2 + chime/status fields.
const stateRes = { status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } };
await route.handler({ url: '/voice-mini/state', method: 'GET' }, stateRes);
const st = JSON.parse(stateRes.body || '{}');
console.log('[state]', stateRes.status, '| chime=' + st.chimeEnabled + '/' + st.chimeSound, 'status=' + st.statusEnabled, 'queue=' + st.queueLength, 'recent=' + st.recent?.length);

// POST /config — toggle status off + chimeSound soft.
const cfgRes = { status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } };
const cfgReq = { url: '/voice-mini/config', method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ statusEnabled: false, chimeSound: 'soft' })); } };
await route.handler(cfgReq, cfgRes);
console.log('[config]', cfgRes.status, '| status=' + JSON.parse(cfgRes.body).statusEnabled, 'chime=' + JSON.parse(cfgRes.body).chimeSound);

// POST /config reset.
const resetRes = { status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } };
const resetReq = { url: '/voice-mini/config', method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from('{"reset":true}'); } };
await route.handler(resetReq, resetRes);
console.log('[reset]', resetRes.status, '| status=' + JSON.parse(resetRes.body).statusEnabled);

// Fire the speak tool (fake backend → no real audio, but queue + chime path runs).
// BYPASS: the tool returns 'queued' immediately (fire-and-forget), NOT after
// playback — so the model's reply and speech run concurrently. ms≈0 proves it
// didn't wait for the synth+play pipeline.
const speak = registered.tools.find((t) => t.name === 'speak');
const t0 = Date.now();
const out = await speak.execute({ text: '自检：工具调用' }, {});
const speakMs = Date.now() - t0;
console.log('[speak tool]', JSON.stringify(out), `returned in ${speakMs}ms`);
console.log('[speak bypass]', out.status === 'queued' && speakMs < 50 ? '✓ queued, non-blocking' : `✗ status=${out.status} took ${speakMs}ms`);
console.log('[chime exists after speak]', existsSync(`${audioDir}/chime-ping.wav`));

// Fire lifecycle events → status utterances enqueued.
const ev = registered.events['session/event'];
ev({}, { type: 'approval/asked', data: { toolName: 'bash', reason: '写入工作区' } });
ev({}, { type: 'tool/call', data: { name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ question: '选哪种方案？' }] }) } });
ev({}, { type: 'turn/end', data: { reason: 'complete' } });
ev({}, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成。```code```' }] } } });

// ── pet routes (native widget contract): loopback + bearer token ───────────
const runtimePath = process.env.DSH_VOICE_MINI_RUNTIME ?? `${process.env.HOME}/.dsh/voice-mini/runtime.json`;
let token = '';
try { token = JSON.parse(readFileSync(runtimePath, 'utf8')).token; } catch { /* not written */ }
console.log('[pet runtime]', existsSync(runtimePath), '| token len =', token.length);

const pet = (url, method = 'GET', body, auth = true) => ({
  url, method,
  socket: { remoteAddress: '127.0.0.1' },
  headers: auth && token ? { authorization: `Bearer ${token}` } : {},
  async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body); },
});
const call = async (req) => {
  const r = { status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } };
  await route.handler(req, r);
  return r;
};

console.log('[pet no-token]', JSON.stringify(await call(pet('/voice-mini/pet/state', 'GET', undefined, false))));
const petState = await call(pet('/voice-mini/pet/state'));
const ps = JSON.parse(petState.body || '{}');
console.log('[pet state]', petState.status, '| speaking=' + ps.speaking, 'attention=' + ps.attention, 'queued=' + ps.queued, 'config.readReplies=' + ps.config?.readReplies);

// attention is set by an approval event (before the queue drains)
ev({}, { type: 'approval/asked', data: { toolName: 'bash' } });
const att = JSON.parse((await call(pet('/voice-mini/pet/state'))).body || '{}');
console.log('[pet attention after approval]', att.attention, '|', att.attentionText);
console.log('[pet clear]', (await call(pet('/voice-mini/pet/attention/clear', 'POST', '{}'))).body);
console.log('[pet config]', (await call(pet('/voice-mini/pet/config', 'POST', JSON.stringify({ readReplies: true })))).body);

// Give the (fake, instant synth) queue time to drain — each utter plays the
// ~0.3s chime via afplay on macOS (plus fork overhead), so 3 items ≈ 2-3s.
await new Promise((r) => setTimeout(r, 5000));

// GET /state again → recent should now have entries.
const afterRes = { status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } };
await route.handler({ url: '/voice-mini/state', method: 'GET' }, afterRes);
const after = JSON.parse(afterRes.body || '{}');
console.log('[after events] recent =', after.recent?.length, '| kinds:', after.recent?.map((r) => r.kind).join(','));
console.log('[done]');
