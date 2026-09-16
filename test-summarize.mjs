process.env.DSH_VOICE_MINI_NO_PERSIST = '1'; // tests: don't touch the real config file
// PROTOTYPE — verbalizer (情绪化总结) self-test. Covers all paths:
//   1. mock LLM returns text → spoken as 'result'
//   2. LLM stream throws → fallback to template
//   3. LLM never yields (timeout) → fallback to template
//   4. model already spoke (spokeThisTurn) → verbalizer not triggered
//   5. readReplies on → verbalizer not triggered
//   6. no LLM service → fallback to template
//   7. empty reply text → fallback to template
//   8. summarizeResult off → template only
// Run: node test-summarize.mjs
import { apply } from './lib/index.js';

const mkCtx = (overrides = {}) => {
  const services = new Map();
  const routes = []; const events = {}; const tools = [];
  if (overrides.services instanceof Map) {
    for (const [k, v] of overrides.services) services.set(k, v);
  }
  const ctx = {
    tools: { register: (t) => tools.push(t) },
    on: (e, fn) => { events[e] = fn; },
    get: (n) => services.get(n),
    inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
    logger: { warn: (...a) => { /* swallow */ } },
  };
  // chimeEnabled:false avoids ~2.5s Glass playback blocking the queue in tests.
  // summarizeModel left at the default ('') so the auto-detect path (pick the
  // first model from listModels) is exercised — the mock LLM serves one.
  const cfg = { backend: 'fake', audioDir: '/tmp/vmt', chimeEnabled: false, ...overrides.config };
  apply(ctx, cfg);
  services.set('webServer', { host: '127.0.0.1', port: 43120, register: (r) => { routes.push(r); return () => {}; } });
  services.set('systemPrompt', { section: () => {} });
  services.set('settings', { installSection: (_o, _n, _s, e, h) => { h.setSource(() => e); h.onChange(); } });
  apply(ctx, cfg);
  return { ctx, routes, events, tools };
};

const state = async (route) => {
  const res = { status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } };
  await route.handler({ url: '/voice-mini/state', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res);
  return JSON.parse(res.body);
};

const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

// ── 1. mock LLM returns text → spoken as 'result' ────────────────────────────
{
  const mockLlm = { adapters: new Map([['deepseek-official', {}]]), listModels: async () => [{ id: 'deepseek-chat', name: 'Chat' }], stream: async function* () { yield { type: 'text-delta', text: '好消息，三个测试全过了，有个小警告我先标出来了。' }; } };
  const { routes, events } = mkCtx({ services: new Map([['llm', mockLlm]]) });
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/Users/zane/project-foo' } }, { type: 'turn/start', data: { turn: 1 } });
  ev({ id: 's1', header: { cwd: '/Users/zane/project-foo' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '所有测试通过了，但有个文件格式警告。' }] } } });
  ev({ id: 's1', header: { cwd: '/Users/zane/project-foo' } }, { type: 'turn/end', data: { turn: 1, reason: 'complete' } });
  await settle(800);
  const s = await state(routes.at(-1));
  const kinds = (s.recent || []).map((r) => `${r.kind}:${r.text.slice(0, 30)}`);
  const hasSummary = kinds.some((k) => k.includes('好消息'));
  console.log(`[1] mock LLM success → ${hasSummary ? 'YES ✓' : 'NO (bug)'} | ${JSON.stringify(kinds)}`);
}

// ── 2. LLM stream throws → fallback to template ─────────────────────────────
{
  const mockLlm = { adapters: new Map([['deepseek-official', {}]]), listModels: async () => [{ id: 'deepseek-chat', name: 'Chat' }], stream: async function* () { throw new Error('LLM provider unavailable'); } };
  const { routes, events } = mkCtx({ services: new Map([['llm', mockLlm]]) });
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/Users/zane/project-bar' } }, { type: 'turn/start', data: { turn: 1 } });
  ev({ id: 's1', header: { cwd: '/Users/zane/project-bar' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成了一些工作。' }] } } });
  ev({ id: 's1', header: { cwd: '/Users/zane/project-bar' } }, { type: 'turn/end', data: { turn: 1, reason: 'complete' } });
  await settle(800);
  const s = await state(routes.at(-1));
  const kinds = (s.recent || []).map((r) => `${r.kind}:${r.text.slice(0, 30)}`);
  const hasTemplate = kinds.some((k) => k.includes('project-bar'));
  console.log(`[2] LLM throws → template fallback ${hasTemplate ? 'YES ✓' : 'NO (bug)'} | ${JSON.stringify(kinds)}`);
}

// ── 3. LLM never yields → timeout fallback ───────────────────────────────────
// (skip real timeout; the summarizeReply catches abort — we mock it by yielding nothing)
{
  const mockLlm = { adapters: new Map([['deepseek-official', {}]]), listModels: async () => [{ id: 'deepseek-chat', name: 'Chat' }], stream: async function* () { /* never yields */ } };
  const { routes, events } = mkCtx({ services: new Map([['llm', mockLlm]]), config: { summarizeTimeoutMs: 300 } });
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/Users/zane/project-baz' } }, { type: 'turn/start', data: { turn: 1 } });
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '做完了。' }] } } });
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'turn/end', data: { turn: 1, reason: 'complete' } });
  await settle(1500);
  const s = await state(routes.at(-1));
  const kinds = (s.recent || []).map((r) => `${r.kind}:${r.text.slice(0, 30)}`);
  const hasTemplate = kinds.some((k) => k.includes('proj'));
  console.log(`[3] LLM timeout → template fallback ${hasTemplate ? 'YES ✓' : 'NO (bug)'} | ${JSON.stringify(kinds)}`);
}

// ── 4. model already spoke → verbalizer not triggered ──────────────────────
{
  const mockLlm = { adapters: new Map([['deepseek-official', {}]]), listModels: async () => [{ id: 'deepseek-chat', name: 'Chat' }], stream: async function* () { yield { type: 'text-delta', text: '不应该出现' }; } };
  const { routes, events, tools } = mkCtx({ services: new Map([['llm', mockLlm]]) });
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'turn/start', data: { turn: 1 } });
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '结果。' }] } } });
  // model speaks
  const speak = tools.filter((t) => t.name === 'speak').at(-1);
  await speak.execute({ text: '我自己说了' }, { agent: { session: { id: 's1' } } });
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'turn/end', data: { turn: 1, reason: 'complete' } });
  await settle(800);
  const s = await state(routes.at(-1));
  const kinds = (s.recent || []).map((r) => `${r.kind}:${r.text.slice(0, 20)}`);
  const noVerbalizer = !kinds.some((k) => k.includes('不应该'));
  console.log(`[4] model spoke → verbalizer suppressed ${noVerbalizer ? 'YES ✓' : 'NO (bug)'} | ${JSON.stringify(kinds)}`);
}

// ── 5. readReplies on → verbalizer not triggered ─────────────────────────────
{
  const mockLlm = { adapters: new Map([['deepseek-official', {}]]), listModels: async () => [{ id: 'deepseek-chat', name: 'Chat' }], stream: async function* () { yield { type: 'text-delta', text: '不应该出现' }; } };
  const { routes, events } = mkCtx({ services: new Map([['llm', mockLlm]]), config: { readReplies: true } });
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'turn/start', data: { turn: 1 } });
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '逐字念出来的内容。' }] } } });
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'turn/end', data: { turn: 1, reason: 'complete' } });
  await settle(800);
  const s = await state(routes.at(-1));
  const kinds = (s.recent || []).map((r) => `${r.kind}:${r.text.slice(0, 20)}`);
  const noVerbalizer = !kinds.some((k) => k.includes('不应该'));
  console.log(`[5] readReplies → verbalizer suppressed ${noVerbalizer ? 'YES ✓' : 'NO (bug)'} | ${JSON.stringify(kinds)}`);
}

// ── 6. no LLM service → fallback to template ────────────────────────────────
{
  const { routes, events } = mkCtx({});
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/Users/zane/no-llm-proj' } }, { type: 'turn/start', data: { turn: 1 } });
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '完成。' }] } } });
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'turn/end', data: { turn: 1, reason: 'complete' } });
  await settle(800);
  const s = await state(routes.at(-1));
  const kinds = (s.recent || []).map((r) => `${r.kind}:${r.text.slice(0, 30)}`);
  const hasTemplate = kinds.some((k) => k.includes('proj'));
  console.log(`[6] no LLM → template fallback ${hasTemplate ? 'YES ✓' : 'NO (bug)'} | ${JSON.stringify(kinds)}`);
}

// ── 7. empty reply text → fallback to template ───────────────────────────────
{
  const mockLlm = { adapters: new Map([['deepseek-official', {}]]), listModels: async () => [{ id: 'deepseek-chat', name: 'Chat' }], stream: async function* () { yield { type: 'text-delta', text: '不应该出现' }; } };
  const { routes, events } = mkCtx({ services: new Map([['llm', mockLlm]]) });
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/empty-reply' } }, { type: 'turn/start', data: { turn: 1 } });
  // no assistant/message → lastReplyText stays ''
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'turn/end', data: { turn: 1, reason: 'complete' } });
  await settle(800);
  const s = await state(routes.at(-1));
  const kinds = (s.recent || []).map((r) => `${r.kind}:${r.text.slice(0, 30)}`);
  const hasTemplate = kinds.some((k) => k.includes('proj'));
  console.log(`[7] empty reply → template fallback ${hasTemplate ? 'YES ✓' : 'NO (bug)'} | ${JSON.stringify(kinds)}`);
}

// ── 8. summarizeResult off → template only ──────────────────────────────────
{
  const mockLlm = { adapters: new Map([['deepseek-official', {}]]), listModels: async () => [{ id: 'deepseek-chat', name: 'Chat' }], stream: async function* () { yield { type: 'text-delta', text: '不应该出现' }; } };
  const { routes, events } = mkCtx({ services: new Map([['llm', mockLlm]]), config: { summarizeResult: false } });
  const ev = events['session/event'];
  ev({ id: 's1', header: { cwd: '/no-summarize' } }, { type: 'turn/start', data: { turn: 1 } });
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '内容。' }] } } });
  ev({ id: 's1', header: { cwd: '/proj' } }, { type: 'turn/end', data: { turn: 1, reason: 'complete' } });
  await settle(800);
  const s = await state(routes.at(-1));
  const kinds = (s.recent || []).map((r) => `${r.kind}:${r.text.slice(0, 30)}`);
  const hasTemplate = kinds.some((k) => k.includes('proj'));
  const noVerbalizer = !kinds.some((k) => k.includes('不应该'));
  console.log(`[8] summarizeResult off → template ${hasTemplate && noVerbalizer ? 'YES ✓' : 'NO (bug)'} | ${JSON.stringify(kinds)}`);
}

console.log('[done]');