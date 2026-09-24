// Jarvis speech signals and optional ownership of turn-end announcements.
// Run: npm run build && node test-jarvis-speech.mjs
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'voice-mini-jarvis-speech-'));
process.env.DSH_VOICE_MINI_NO_PERSIST = '1';
process.env.DSH_VOICE_MINI_RUNTIME = join(tempDir, 'runtime.json');
// pet.ts reads the runtime path at import time, so import after isolation.
const { apply } = await import('./lib/index.js');
after(() => rmSync(tempDir, { recursive: true, force: true }));

const JARVIS_SID = 'session-jarvis';
const WORKER_SID = 'session-worker';
const TEMPLATE = '普通终态播报';
let contextId = 0;
const mkCtx = ({ jarvis = { sessionId: JARVIS_SID }, config = {}, llm } = {}) => {
  const services = new Map();
  const routes = [], tools = [], cleanups = [], signals = [];
  const events = {};
  const ctx = {
    tools: { register: (tool) => tools.push(tool) },
    on: (e, fn) => { events[e] = fn; },
    get: (n) => services.get(n),
    inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
    effect: (fn) => { cleanups.push(fn()); },
    logger: { warn: () => {} },
  };
  const cfg = {
    backend: 'fake', audioDir: join(tempDir, `audio-${++contextId}`),
    chimeEnabled: false, summarizeResult: false, statusEnabled: true,
    announceTurnStart: false, announceTurnEnd: true, phraseTurnEnd: TEMPLATE,
    ...config,
  };
  services.set('webServer', { host: '127.0.0.1', port: 43120, register: (r) => { routes.push(r); return () => {}; } });
  services.set('systemPrompt', { section: () => {} });
  services.set('settings', { installSection: (_o, _n, _s, e, h) => { h.setSource(() => e); h.onChange(); } });
  if (jarvis) {
    jarvis.speech ??= (signal) => signals.push(signal);
    services.set('jarvis', jarvis);
  }
  if (llm) services.set('llm', llm);
  apply(ctx, cfg);
  const route = routes.at(-1);
  return {
    signals, tools, route,
    fire: (type, data = {}, sid = WORKER_SID) => events['session/event'](
      sid === null ? undefined : { id: sid, header: { cwd: '/proj' } }, { type, data }),
    state: () => request(route, '/voice-mini/state'),
    unloadJarvis: () => { for (const cleanup of cleanups) cleanup?.(); services.delete('jarvis'); },
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
const drained = async (ctx) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    await settle();
    const state = await ctx.state();
    if (!state.pumping && state.queueLength === 0) return state;
  }
  assert.fail('fake speech queue did not drain');
};
const finishTurn = (ctx, sid = WORKER_SID) => {
  ctx.fire('turn/start', {}, sid);
  ctx.fire('turn/end', { reason: { kind: 'completed' } }, sid);
};
const reply = (ctx, sid = WORKER_SID) => ctx.fire('assistant/message', {
  message: { content: [{ type: 'text', text: '所有测试已经通过。' }] },
}, sid);
const assertTemplate = async (ctx) => {
  const state = await drained(ctx);
  assert.deepEqual(state.recent.map(({ kind, text }) => ({ kind, text })), [{ kind: 'status', text: TEMPLATE }]);
};
const assertSilent = async (ctx) => {
  const state = await drained(ctx);
  assert.deepEqual(state.recent, []);
  assert.deepEqual(state.queueView, []);
  assert.deepEqual(ctx.signals, []);
};

// Preserve the original six speech-signal checks alongside ownership coverage.
describe('等价类', () => {
  it('Jarvis line reports start then end', async () => {
    const ctx = mkCtx();
    await request(ctx.route, '/voice-mini/test', { text: '晚上好，先生。', jarvis: true });
    await drained(ctx);
    assert.deepEqual(ctx.signals.map(({ phase, source }) => ({ phase, source })), [
      { phase: 'start', source: 'jarvis' }, { phase: 'end', source: 'jarvis' },
    ]);
  });
  it('start/end share one id', async () => {
    const ctx = mkCtx();
    await request(ctx.route, '/voice-mini/test', { text: '晚上好，先生。', jarvis: true });
    await drained(ctx);
    assert.equal(ctx.signals.length, 2);
    assert.equal(ctx.signals[0].id, ctx.signals[1].id);
  });
  for (const [sid, source] of [[JARVIS_SID, 'jarvis'], [WORKER_SID, 'session']]) {
    it(`${source} session narration keeps its speech source`, async () => {
      const ctx = mkCtx();
      finishTurn(ctx, sid);
      await drained(ctx);
      assert.equal(ctx.signals.length, 2);
      assert.ok(ctx.signals.every((s) => s.source === source && s.sessionId === sid));
    });
  }
  it('every start has exactly one matching end in order', async () => {
    const ctx = mkCtx();
    finishTurn(ctx);
    await drained(ctx);
    const byId = new Map();
    for (const signal of ctx.signals) byId.set(signal.id, [...(byId.get(signal.id) ?? []), signal.phase]);
    assert.equal(byId.size, 1);
    for (const phases of byId.values()) assert.deepEqual(phases, ['start', 'end']);
  });
  it('true skips both summary LLM calls and terminal queue entries', async () => {
    let llmCalls = 0;
    const llm = {
      adapters: new Map([['fake', {}]]),
      listModels: async () => { llmCalls++; return [{ id: 'fake-model' }]; },
      stream: async function* () { llmCalls++; yield { type: 'text-delta', text: '总结。' }; },
    };
    const claimed = [];
    const ctx = mkCtx({ jarvis: { claimsTurnEnd(sid) { claimed.push(sid); return true; } }, llm, config: { summarizeResult: true } });
    ctx.fire('turn/start');
    reply(ctx);
    ctx.fire('turn/end');
    await assertSilent(ctx);
    assert.deepEqual(claimed, [WORKER_SID]);
    assert.equal(llmCalls, 0);
  });
  for (const reason of ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted']) {
    it(`true skips the ${reason} terminal template`, async () => {
      const ctx = mkCtx({ jarvis: { claimsTurnEnd: () => true } });
      ctx.fire('turn/end', { reason: { kind: reason } });
      await assertSilent(ctx);
    });
  }
  for (const [label, jarvis] of [['false', { claimsTurnEnd: () => false }], ['missing Jarvis', null], ['missing method', {}]]) {
    it(`${label} keeps the usual template`, async () => {
      const ctx = mkCtx({ jarvis });
      finishTurn(ctx);
      await assertTemplate(ctx);
    });
  }
  for (const [type, data] of [
    ['turn/start', {}], ['approval/asked', { toolName: 'bash' }],
    ['tool/call', { name: 'ask_user_question' }], ['tool/call', { name: 'bash' }],
    ['todo/write', { todos: [{ status: 'completed' }] }],
  ]) {
    it(`claim does not suppress ${type} ${data.name ?? ''}`, async () => {
      let claimCalls = 0;
      const ctx = mkCtx({ jarvis: { claimsTurnEnd() { claimCalls++; return true; } }, config: {
        announceTurnStart: true, announceApproval: true, announceQuestion: true, announceToolCall: true, announceTodo: true,
      } });
      ctx.fire(type, data);
      const state = await drained(ctx);
      assert.equal(state.recent.length, 1);
      assert.equal(state.recent[0].kind, 'status');
      assert.equal(claimCalls, 0);
    });
  }
  it('claim does not suppress the speak tool', async () => {
    let claimCalls = 0;
    const ctx = mkCtx({ jarvis: { claimsTurnEnd() { claimCalls++; return true; } } });
    const result = await ctx.tools.find((tool) => tool.name === 'speak').execute({ text: '主动播报。' }, { agent: { session: { id: WORKER_SID } } });
    assert.equal(result.status, 'queued');
    const state = await drained(ctx);
    assert.equal(state.recent[0].kind, 'tool');
    assert.equal(claimCalls, 0);
  });
  for (const type of ['turn/start', 'approval/asked']) {
    it(`claim does not suppress chime-only ${type}`, async () => {
      let claimCalls = 0;
      const ctx = mkCtx({ jarvis: { claimsTurnEnd() { claimCalls++; return true; } }, config: {
        statusSpeech: false, announceTurnStart: true, announceApproval: true,
      } });
      ctx.fire(type);
      const state = await drained(ctx);
      assert.equal(state.recent.length, 1);
      assert.equal(state.recent[0].kind, 'chime');
      assert.equal(claimCalls, 0);
    });
  }
  it('claim does not suppress readReplies', async () => {
    let claimCalls = 0;
    const ctx = mkCtx({ jarvis: { claimsTurnEnd() { claimCalls++; return true; } }, config: { readReplies: true } });
    reply(ctx);
    const state = await drained(ctx);
    assert.equal(state.recent[0].kind, 'result');
    assert.equal(claimCalls, 0);
  });
  it('reads current service claim state on every turn and preserves this', async () => {
    const jarvis = { active: true, calls: [], claimsTurnEnd(sid) { this.calls.push(sid); return this.active; } };
    const ctx = mkCtx({ jarvis });
    finishTurn(ctx);
    await assertSilent(ctx);
    jarvis.active = false;
    finishTurn(ctx);
    await assertTemplate(ctx);
    assert.deepEqual(jarvis.calls, [WORKER_SID, WORKER_SID]);
  });
  it('service unload restores the usual template', async () => {
    const ctx = mkCtx({ jarvis: { claimsTurnEnd: () => true } });
    finishTurn(ctx);
    await assertSilent(ctx);
    ctx.unloadJarvis();
    finishTurn(ctx);
    await assertTemplate(ctx);
  });
});

describe('边界值', () => {
  for (const value of [undefined, null, 0, 1, '', 'true', {}, Promise.resolve(true)]) {
    it(`only exact true claims a turn: ${String(value)}`, async () => {
      const ctx = mkCtx({ jarvis: { claimsTurnEnd: () => value } });
      finishTurn(ctx);
      await assertTemplate(ctx);
    });
  }
  for (const [label, sid] of [['empty', ''], ['missing session', null], ['invalid ID', 42]]) {
    it(`${label} never calls claimsTurnEnd`, async () => {
      let claimCalls = 0;
      const ctx = mkCtx({ jarvis: { claimsTurnEnd() { claimCalls++; return true; } } });
      finishTurn(ctx, sid);
      await assertTemplate(ctx);
      assert.equal(claimCalls, 0);
    });
  }
});

describe('异常路径', () => {
  it('throwing speech callback does not stall the queue', async () => {
    const ctx = mkCtx({ jarvis: { speech() { throw new Error('jarvis down'); } } });
    finishTurn(ctx);
    await assertTemplate(ctx);
  });
  for (const [label, jarvis] of [
    ['throwing callback', { claimsTurnEnd() { throw new Error('claim unavailable'); } }],
    ['throwing getter', { get claimsTurnEnd() { throw new Error('claim getter unavailable'); } }],
    ['non-callable method', { claimsTurnEnd: true }],
  ]) {
    it(`${label} falls back to the usual template`, async () => {
      const ctx = mkCtx({ jarvis });
      assert.doesNotThrow(() => finishTurn(ctx));
      await assertTemplate(ctx);
    });
  }
});
