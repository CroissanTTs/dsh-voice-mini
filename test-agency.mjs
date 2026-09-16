process.env.DSH_VOICE_MINI_NO_PERSIST = '1'; // tests: don't touch the real config file
// PROTOTYPE — "who speaks" test. The design rule: the model composes the
// spoken line itself, and the mechanical templates must NOT repeat the same
// turn. Run: node test-agency.mjs  (after `npm run build`)
import { apply } from './lib/index.js';

const services = new Map();
const registered = { routes: [], events: {}, tools: [] };

function mount(rawConfig = {}) {
  const ctx = {
    tools: { register: (t) => registered.tools.push(t) },
    on: (e, fn) => { registered.events[e] = fn; },
    get: (n) => services.get(n),
    inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
    logger: { warn: () => {} },
  };
  registered.routes.length = 0;
  registered.tools.length = 0;
  for (const k of Object.keys(registered.events)) delete registered.events[k];
  apply(ctx, { backend: 'fake', voice: 'zh-CN-XiaoxiaoNeural', audioDir: '/tmp/dsh-voice-mini-test', ...rawConfig });
  services.set('webServer', {
    host: '127.0.0.1', port: 43120,
    register: (r) => { registered.routes.push(r); return () => {}; },
  });
  services.set('systemPrompt', { section: (s) => { registered.persona = s; } });
  apply(ctx, { backend: 'fake', voice: 'zh-CN-XiaoxiaoNeural', audioDir: '/tmp/dsh-voice-mini-test', ...rawConfig });
  return registered.routes.at(-1);
}

const state = async (route) => {
  const res = { status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } };
  await route.handler({ url: '/voice-mini/state', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res);
  return JSON.parse(res.body);
};
const fire = (type, data) => registered.events['session/event']({}, { type, data });
const settle = () => new Promise((r) => setTimeout(r, 2500));
const kinds = (s) => (s.recent ?? []).map((r) => `${r.kind}:${r.text}`);

// ── A. the model speaks for itself → turn/end template stays quiet ─────────
{
  const route = mount();
  fire('turn/start', { turn: 1 });
  // The mock applies twice (services race), so pick the tool from the SAME
  // apply whose session/event handler `fire()` reaches — the last one.
  const speak = registered.tools.filter((t) => t.name === 'speak').at(-1);
  await speak.execute({ text: '三个文件改完了，我先跑一遍测试。' }, {});
  fire('turn/end', { turn: 1, reason: 'complete' });
  await settle();
  const s = await state(route);
  const list = kinds(s);
  const doubled = list.some((k) => k.includes('本轮完成'));
  console.log('[A] model spoke + turn/end →', JSON.stringify(list));
  console.log(`    template suppressed: ${doubled ? 'NO (bug)' : 'YES ✓'}`);
}

// ── B. the model stayed quiet → the template still gives a completion cue ──
{
  const route = mount();
  fire('turn/start', { turn: 1 });
  fire('turn/end', { turn: 1, reason: 'complete' });
  await settle();
  const s = await state(route);
  const list = kinds(s);
  console.log('[B] silent model + turn/end →', JSON.stringify(list));
  console.log(`    template fired: ${list.some((k) => k.includes('本轮完成')) ? 'YES ✓' : 'NO (bug)'}`);
}

// ─ C. 逐字朗读 mode: the reply is the speech, so no template repeat ───────
{
  const route = mount({ readReplies: true });
  fire('turn/start', { turn: 1 });
  fire('assistant/message', { message: { content: [{ type: 'text', text: '两个测试都过了，剩下一个待确认。' }] } });
  fire('turn/end', { turn: 1, reason: 'complete' });
  await settle();
  const s = await state(route);
  const list = kinds(s);
  console.log('[C] 逐字朗读 + turn/end →', JSON.stringify(list));
  console.log(`    reply read, template silent: ${list.some((k) => k.startsWith('result:')) && !list.some((k) => k.includes('本轮完成')) ? 'YES ✓' : 'NO (bug)'}`);
}

// ─ D. the persona actually switches with the gear / narration mode ────────
{
  for (const cfg of [{ preset: 'default' }, { preset: 'instant' }, { preset: 'quiet' }, { readReplies: true }]) {
    mount(cfg);
    const text = registered.persona.text();
    const head = text.split('\n')[0];
    const forbids = text.includes('Do NOT also call the `speak` tool');
    console.log(`[D] ${JSON.stringify(cfg).padEnd(24)} → ${head}${forbids ? '  [forbids double-speak]' : ''}`);
  }
}

console.log('[done]');