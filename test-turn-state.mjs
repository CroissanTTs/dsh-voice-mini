// Turn state is per session: concurrent sessions (Jarvis plus the sessions it
// drives) must not silence or re-word each other's turn-end announcements.
// Run: npm run build && node test-turn-state.mjs
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'voice-mini-turn-state-'));
process.env.DSH_VOICE_MINI_NO_PERSIST = '1';
process.env.DSH_VOICE_MINI_RUNTIME = join(tempDir, 'runtime.json');
const { apply } = await import('./lib/index.js');
after(() => rmSync(tempDir, { recursive: true, force: true }));

const JARVIS = 'session-jarvis';
const A = 'session-a';
const B = 'session-b';
const TEMPLATE = '普通终态播报';
let contextId = 0;

/** Summaries name the reply they were given, so a mixed-up reply is visible. */
const summarizer = () => {
  const prompts = [];
  return {
    prompts,
    adapters: new Map([['fake', {}]]),
    listModels: async () => [{ id: 'fake-model' }],
    stream: async function* (opts) {
      const prompt = JSON.stringify(opts.messages);
      prompts.push(prompt);
      const who = ['甲', '乙', '贾维斯'].find((name) => prompt.includes(`${name}的回复`)) ?? '未知';
      yield { type: 'text-delta', text: `${who}的总结。` };
    },
  };
};

const mkCtx = ({ config = {}, llm } = {}) => {
  const services = new Map();
  const routes = [], tools = [], signals = [];
  const events = {};
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    on: (e, fn) => { events[e] = fn; },
    get: (n) => services.get(n),
    inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
    effect: () => {},
    logger: { warn: () => {} },
  };
  services.set('webServer', { host: '127.0.0.1', port: 43120, register: (r) => { routes.push(r); return () => {}; } });
  services.set('systemPrompt', { section: () => {} });
  services.set('settings', { installSection: (_o, _n, _s, e, h) => { h.setSource(() => e); h.onChange(); } });
  services.set('jarvis', { sessionId: JARVIS, speech: (signal) => signals.push(signal) });
  if (llm) services.set('llm', llm);
  apply(ctx, {
    backend: 'fake', audioDir: join(tempDir, `audio-${++contextId}`),
    chimeEnabled: false, summarizeResult: false, statusEnabled: true,
    announceTurnStart: false, announceTurnEnd: true, phraseTurnEnd: TEMPLATE,
    ...config,
  });
  const route = routes.at(-1);
  const fire = (type, data = {}, sid) => events['session/event'](
    sid === null ? undefined : { id: sid, header: { cwd: '/proj' } }, { type, data });
  return {
    route,
    start: (sid) => fire('turn/start', {}, sid),
    end: (sid, kind = 'completed') => fire('turn/end', { reason: { kind } }, sid),
    reply: (sid, text) => fire('assistant/message', { message: { content: [{ type: 'text', text }] } }, sid),
    tool: (sid, name) => fire('tool/call', { name }, sid),
    speak: (sid, text = '我自己说一句。') => tools.find((t) => t.name === 'speak')
      .execute({ text }, sid === null ? {} : { agent: { session: { id: sid } } }),
    toggle: (sid, enabled) => request(route, '/voice-mini/session-toggle', { sessionId: sid, enabled }),
    /** Spoken lines as `sessionId: text`, in playback order. */
    spoken: async () => {
      await drained(route);
      return signals.filter((s) => s.phase === 'start').map((s) => `${s.sessionId ?? '-'}: ${s.text}`);
    },
  };
};

const request = async (route, path, body) => {
  const res = { body: '', writeHead() {}, end(b) { this.body = b ?? ''; } };
  const req = { url: path, method: body === undefined ? 'GET' : 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body)); };
  req.on = (ev, fn) => { if (ev === 'data') fn(Buffer.from(JSON.stringify(body))); if (ev === 'end') fn(); return req; };
  await route.handler(req, res);
  return JSON.parse(res.body || '{}');
};
const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
const drained = async (route) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    await settle();
    const state = await request(route, '/voice-mini/state');
    if (!state.pumping && state.queueLength === 0) return state;
  }
  assert.fail('fake speech queue did not drain');
};

describe('等价类', () => {
  it('another session speaking does not silence this session', async () => {
    const ctx = mkCtx();
    ctx.start(A); ctx.start(B);
    await ctx.speak(B);
    ctx.end(A); ctx.end(B);
    assert.deepEqual(await ctx.spoken(), [`${B}: 我自己说一句。`, `${A}: ${TEMPLATE}`]);
  });

  it('a managed session is still summarized after Jarvis summarized its own turn first', async () => {
    const llm = summarizer();
    const ctx = mkCtx({ llm, config: { summarizeResult: true } });
    ctx.start(JARVIS); ctx.start(A);
    ctx.reply(JARVIS, '贾维斯的回复：已经转告。');
    ctx.end(JARVIS);
    await ctx.spoken();
    ctx.reply(A, '甲的回复：提纲写好了。');
    ctx.end(A);
    assert.deepEqual(await ctx.spoken(), [`${JARVIS}: 贾维斯的总结。`, `${A}: 甲的总结。`]);
  });

  it('each turn end is summarized from its own session reply', async () => {
    const llm = summarizer();
    const ctx = mkCtx({ llm, config: { summarizeResult: true } });
    ctx.start(A); ctx.start(B);
    ctx.reply(A, '甲的回复：测试通过。');
    ctx.reply(B, '乙的回复：文档更新了。');
    ctx.end(A);
    await ctx.spoken();
    ctx.end(B);
    assert.deepEqual(await ctx.spoken(), [`${A}: 甲的总结。`, `${B}: 乙的总结。`]);
  });

  it('tool announcements are deduplicated per session, not across sessions', async () => {
    const ctx = mkCtx({ config: { announceToolCall: true, announceTurnEnd: false } });
    ctx.start(A); ctx.start(B);
    ctx.tool(A, 'bash'); ctx.tool(A, 'bash'); ctx.tool(B, 'bash');
    const lines = await ctx.spoken();
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map((l) => l.split(':')[0]), [A, B]);
  });
});

describe('边界值', () => {
  it('a session that spoke for itself still skips its own template', async () => {
    const ctx = mkCtx();
    ctx.start(A);
    await ctx.speak(A);
    ctx.end(A);
    assert.deepEqual(await ctx.spoken(), [`${A}: 我自己说一句。`]);
  });

  it('a new turn forgets that the previous turn spoke', async () => {
    const ctx = mkCtx();
    ctx.start(A);
    await ctx.speak(A);
    ctx.end(A);
    ctx.start(A);
    ctx.end(A);
    assert.deepEqual(await ctx.spoken(), [`${A}: 我自己说一句。`, `${A}: ${TEMPLATE}`]);
  });

  it('turn end clears the state even when no new turn starts', async () => {
    const ctx = mkCtx();
    await ctx.speak(A);
    ctx.end(A);
    ctx.end(A);
    assert.deepEqual(await ctx.spoken(), [`${A}: 我自己说一句。`, `${A}: ${TEMPLATE}`]);
  });

  it('a reply from a finished turn is not summarized again next turn', async () => {
    const llm = summarizer();
    const ctx = mkCtx({ llm, config: { summarizeResult: true } });
    ctx.start(A);
    ctx.reply(A, '甲的回复：第一轮。');
    ctx.end(A);
    await ctx.spoken();
    ctx.start(A);
    ctx.end(A);
    assert.deepEqual(await ctx.spoken(), [`${A}: 甲的总结。`, `${A}: ${TEMPLATE}`]);
    assert.equal(llm.prompts.length, 1);
  });
});

describe('异常路径', () => {
  it('turn end with no start and no reply falls back to the template', async () => {
    const ctx = mkCtx({ llm: summarizer(), config: { summarizeResult: true } });
    ctx.end(A);
    assert.deepEqual(await ctx.spoken(), [`${A}: ${TEMPLATE}`]);
  });

  it('speak without a session does not silence a real session', async () => {
    const ctx = mkCtx();
    ctx.start(A);
    await ctx.speak(null);
    ctx.end(A);
    assert.deepEqual(await ctx.spoken(), [`-: 我自己说一句。`, `${A}: ${TEMPLATE}`]);
  });

  it('a disabled session neither speaks nor affects an enabled one', async () => {
    const ctx = mkCtx();
    await ctx.toggle(B, false);
    ctx.start(A); ctx.start(B);
    ctx.reply(B, '乙的回复：不该出声。');
    ctx.end(B); ctx.end(A);
    assert.deepEqual(await ctx.spoken(), [`${A}: ${TEMPLATE}`]);
  });

  it('an abnormal end in one session does not consume another session state', async () => {
    const ctx = mkCtx();
    ctx.start(A); ctx.start(B);
    await ctx.speak(A);
    ctx.end(B, 'error');
    ctx.end(A);
    const lines = await ctx.spoken();
    assert.equal(lines.length, 2);
    assert.equal(lines[0], `${A}: 我自己说一句。`);
    assert.ok(lines[1].startsWith(`${B}: `));
  });
});
