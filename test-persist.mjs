// PROTOTYPE — config persistence self-test.
//   1. mount with a temp config file, POST a config patch via /config
//   2. verify the file was written
//   3. re-mount (simulating a plugin reload / update) and verify the patched
//      values survived (loaded from the file)
// Run: node test-persist.mjs  (after `npm run build`)
process.env.DSH_VOICE_MINI_CONFIG_FILE = '/tmp/dsh-vm-persist-test.json';
import { unlinkSync, existsSync, readFileSync } from 'node:fs';
import { apply } from './lib/index.js';

try { unlinkSync(process.env.DSH_VOICE_MINI_CONFIG_FILE); } catch { /* */ }

const mkCtx = () => {
  const services = new Map();
  const routes = [];
  const ctx = {
    tools: { register: () => {} },
    on: () => {},
    get: (n) => services.get(n),
    inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
    logger: { warn: () => {} },
  };
  const cfg = { backend: 'fake', audioDir: '/tmp/vmt', chimeEnabled: false };
  apply(ctx, cfg);
  services.set('webServer', { host: '127.0.0.1', port: 43120, register: (r) => { routes.push(r); return () => {}; } });
  services.set('systemPrompt', { section: () => {} });
  services.set('settings', { installSection: (_o, _n, _s, e, h) => { h.setSource(() => e); h.onChange(); } });
  apply(ctx, cfg);
  return { routes };
};
const stateOf = async (route) => {
  const res = { body: '', writeHead() {}, end(b) { this.body = b ?? ''; } };
  await route.handler({ url: '/voice-mini/state', method: 'GET', socket: { remoteAddress: '127.0.0.1' }, headers: {} }, res);
  return JSON.parse(res.body);
};
const postConfig = async (route, patch) => {
  const res = { body: '', writeHead() {}, end(b) { this.body = b ?? ''; } };
  const req = { url: '/voice-mini/config', method: 'POST', socket: { remoteAddress: '127.0.0.1' }, headers: {},
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(patch)); } };
  await route.handler(req, res);
};

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`); } };

// 1. Mount + POST a patch.
const { routes } = mkCtx();
const route = routes.at(-1);
await postConfig(route, { preset: 'quiet', locale: 'en' });

// 2. File written.
const file = JSON.parse(readFileSync(process.env.DSH_VOICE_MINI_CONFIG_FILE, 'utf8'));
ok('config file written', existsSync(process.env.DSH_VOICE_MINI_CONFIG_FILE));
ok('file has preset=quiet', file.preset === 'quiet');
ok('file has locale=en', file.locale === 'en');

// 3. Re-mount (simulate update/restart) → values survived.
const { routes: routes2 } = mkCtx();
const s = await stateOf(routes2.at(-1));
ok('preset survived remount (quiet)', s.preset === 'quiet');
ok('locale survived remount (en)', s.locale === 'en');

// 4. Reset clears the persisted values.
await postConfig(routes2.at(-1), { reset: true });
const { routes: routes3 } = mkCtx();
const s3 = await stateOf(routes3.at(-1));
ok('reset reverts preset to default', s3.preset === 'default');
ok('reset reverts locale to default', s3.locale === 'zh');

console.log(`\n[done] ${pass} passed, ${fail} failed`);
try { unlinkSync(process.env.DSH_VOICE_MINI_CONFIG_FILE); } catch { /* */ }
process.exit(fail === 0 ? 0 : 1);
