process.env.DSH_VOICE_MINI_NO_PERSIST = '1'; // tests: don't touch the real config file
// PROTOTYPE — preset resolution test. The layering is the subtle part:
//   PRESETS[preset]  <  composition config  <  settings deltas  <  live override
// Run: node test-presets.mjs  (after `npm run build`)
import { apply } from './lib/index.js';

const services = new Map();
const registered = { routes: [] };

function mount(rawConfig) {
  const ctx = {
    tools: { register: () => {} },
    on: () => {},
    get: (n) => services.get(n),
    inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
    logger: { warn: () => {} },
  };
  registered.routes.length = 0;
  apply(ctx, rawConfig);
  services.set('webServer', {
    host: '127.0.0.1', port: 43120,
    register: (r) => { registered.routes.push(r); return () => {}; },
  });
  apply(ctx, rawConfig);
  return registered.routes.at(-1);
}

const get = async (route) => {
  const res = { status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } };
  await route.handler({ url: '/voice-mini/state', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res);
  return JSON.parse(res.body);
};
const post = async (route, body) => {
  const res = { status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } };
  const req = {
    url: '/voice-mini/config', method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)); },
  };
  await route.handler(req, res);
  return JSON.parse(res.body);
};

const show = (label, s) => console.log(
  `${label.padEnd(34)} preset=${String(s.preset).padEnd(8)} readReplies=${s.readReplies ? 'Y' : 'n'}`
  + ` cap=${String(s.narrationCap).padStart(3)} turnStart=${s.announceTurnStart ? 'Y' : 'n'}`
  + ` turnEnd=${s.announceTurnEnd ? 'Y' : 'n'} todo=${s.announceTodo ? 'Y' : 'n'} tool=${s.announceToolCall ? 'Y' : 'n'}`
  + ` chime=${s.chimeSpeech}/${s.chimeStatus} rate=${s.ratePct >= 0 ? '+' : ''}${s.ratePct}% vol=${s.volumePct >= 0 ? '+' : ''}${s.volumePct}%`,
);

// 1. Bare defaults → 默认沟通 gear.
const route = mount({});
show('1. no config (default gear)', await get(route));

// 2. Switching gear changes the whole bundle at once.
show('2. switch → quiet', await post(route, { preset: 'quiet' }));
show('3. switch → instant', await post(route, { preset: 'instant' }));

// 4. Live override beats the gear (single-field tweak).
await post(route, { announceTurnEnd: false });
show('4. instant + override turnEnd=off', await get(route));

// 5. Composition config beats the gear (hand-written key survives).
const route2 = mount({ preset: 'quiet', announceTurnEnd: true, voice: 'zh-CN-YunxiNeural' });
show('5. quiet + composition turnEnd=on', await get(route2));

// 6. Reset returns to the gear's bundle.
await post(route, { reset: true });
show('6. after reset (gear → config default)', await get(route));

console.log('[done]');