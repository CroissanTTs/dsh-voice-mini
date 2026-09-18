// Verifies the Jarvis-voice wiring in /test + prefetchSynth.
//   POST /test {jarvis:true}  → state.lastVoice == effectiveJarvisVoice label
//   POST /test {jarvis:false} → state.lastVoice == a per-session palette voice
// Run: node test-jarvis-voice.mjs  (after `npm run build`)
process.env.DSH_VOICE_MINI_NO_PERSIST = '1';
import { apply, Config } from './lib/index.js';

const audioDir = '/tmp/dsh-voice-mini-jarvis-test';
import { rmSync } from 'node:fs';
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

// Mirror the host's own label transform (index.ts ~1042): strips only the
// zh-CN- prefix + Neural suffix, leaving en-GB-/en-US- prefixes in place.
// So zh-CN-YunjianNeural → "Yunjian", en-GB-ThomasNeural → "en-GB-Thomas".
const label = (voice) => voice.replace(/^zh-CN-|Neural$/g, '');

async function run(locale, expectJarvisRaw) {
  apply(ctx, { backend: 'fake', voice: locale === 'zh' ? 'zh-CN-XiaoxiaoNeural' : 'en-US-AriaNeural', audioDir, locale });
  const route = registered.routes.at(-1);

  const mkRes = () => ({ status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } });
  const mkReq = (path, obj) => ({ url: `/voice-mini${path}`, method: 'POST', async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(obj)); } });
  const mkGet = (path) => ({ url: `/voice-mini${path}`, method: 'GET' });

  // 1. Jarvis test → expect effectiveJarvisVoice
  const r1 = mkRes();
  await route.handler(mkReq('/test', { text: locale === 'zh' ? '欢迎回来。' : 'Welcome back.', jarvis: true }), r1);
  const j1 = JSON.parse(r1.body);
  const s1 = mkRes(); await route.handler(mkGet('/state'), s1);
  const st1 = JSON.parse(s1.body);
  const gotJarvis = st1.lastVoice;
  const expectJarvis = label(expectJarvisRaw);
  console.log(`[${locale}] jarvis=true  lastVoice="${gotJarvis}" (expect "${expectJarvis}") effVoice="${st1.effectiveJarvisVoice}" resp.jarvis=${j1.jarvis}`);
  if (gotJarvis !== expectJarvis) throw new Error(`jarvis voice mismatch (${locale}): got "${gotJarvis}", expect "${expectJarvis}"`);
  if (j1.jarvis !== true) throw new Error(`/test response did not echo jarvis=true`);

  // 2. Non-jarvis test → expect a palette voice (NOT the jarvis voice)
  const r2 = mkRes();
  await route.handler(mkReq('/test', { text: locale === 'zh' ? '普通播报。' : 'Normal speech.', jarvis: false }), r2);
  const s2 = mkRes(); await route.handler(mkGet('/state'), s2);
  const st2 = JSON.parse(s2.body);
  const gotNormal = st2.lastVoice;
  console.log(`[${locale}] jarvis=false lastVoice="${gotNormal}" (palette voice, must ≠ "${expectJarvis}")`);
  if (gotNormal === expectJarvis) throw new Error(`non-jarvis test used the jarvis voice (${locale}): "${gotNormal}"`);

  // 3. Omitted jarvis behaves like false (no male-voice leak)
  const r3 = mkRes();
  await route.handler(mkReq('/test', { text: locale === 'zh' ? '省略。' : 'Omitted.' }), r3);
  const j3 = JSON.parse(r3.body);
  if (j3.jarvis !== false) throw new Error(`omitted jarvis should default to false, got ${j3.jarvis}`);
  console.log(`[${locale}] jarvis omitted → resp.jarvis=${j3.jarvis} ✓`);
}

let pass = 0;
await run('zh', 'zh-CN-YunjianNeural'); pass++;
await run('en', 'en-GB-ThomasNeural'); pass++;
console.log(`\n[done] ${pass} locales passed, 0 failed`);
