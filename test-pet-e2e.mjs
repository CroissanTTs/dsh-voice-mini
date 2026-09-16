process.env.DSH_VOICE_MINI_NO_PERSIST = '1'; // tests: don't touch the real config file
// PROTOTYPE — end-to-end: the REAL plugin route handler + the REAL native pet
// binary. Proves the discovery seam (runtime.json + bearer token) and the
// /pet/* contract work together, without needing the DSH app.
//
// Run: DSH_VOICE_MINI_RUNTIME=/tmp/voice-pet-e2e.json node test-pet-e2e.mjs
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const RUNTIME = process.env.DSH_VOICE_MINI_RUNTIME;
if (!RUNTIME) throw new Error('set DSH_VOICE_MINI_RUNTIME first');

const { apply } = await import('./lib/index.js');

const services = new Map();
const registered = { routes: [], events: {} };
const ctx = {
  tools: { register: () => {} },
  on: (event, fn) => { registered.events[event] = fn; },
  get: (n) => services.get(n),
  inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
  logger: { warn: () => {} },
};

const config = { backend: 'fake', voice: 'zh-CN-XiaoxiaoNeural', audioDir: '/tmp/dsh-voice-mini-test' };
apply(ctx, config); // phase 1: no services (race)
services.set('webServer', {
  host: '127.0.0.1', port: 0,
  register: (r) => { registered.routes.push(r); return () => {}; },
});
services.set('settings', { installSection: (_o, _n, _s, e, h) => { h.setSource(() => e); h.onChange(); } });
apply(ctx, config); // phase 2: routes mount

const route = registered.routes.at(-1);
if (!route) throw new Error('FAIL: no route registered');

// Real HTTP server delegating to the plugin's own handler, wrapped in a
// replica of the Desktop shell's gate: every plugin route is refused with
// 403 "forbidden" unless the request carries the renderer capability.
// (decideDesktopBrowserAccess, lib/desktop-browser-access-*.js)
const RENDERER_HEADER = 'x-dsh-desktop-renderer';
const RENDERER_VALUE = 'e2e-renderer-capability-0123456789abcdefghijk';
const gate = (req) => req.headers[RENDERER_HEADER] === RENDERER_VALUE;
const server = createServer((req, res) => {
  if (!gate(req)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  void route.handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// The plugin wrote runtime.json with port 0 (the mock had no port yet) — the
// token is the plugin's own; repoint the origin and attach the capability the
// way the Desktop shell would (ctx.get('desktopBrowserAccess')).
const rt = JSON.parse(readFileSync(RUNTIME, 'utf8'));
writeFileSync(RUNTIME, `${JSON.stringify({
  ...rt,
  origin: `http://127.0.0.1:${port}`,
  rendererHeader: { name: RENDERER_HEADER, value: RENDERER_VALUE },
}, null, 2)}\n`);
console.log(`[e2e] real plugin behind a shell-like gate on ${port}, token len ${rt.token.length}`);

// Prove the gate actually bites without the capability.
const denied = await fetch(`http://127.0.0.1:${port}/voice-mini/pet/state`, {
  headers: { authorization: `Bearer ${rt.token}` },
});
console.log(`[e2e] without capability -> HTTP ${denied.status} ${JSON.stringify((await denied.text()).slice(0, 20))}`);

// Put the pet into an interesting state: an approval is pending.
registered.events['session/event']({}, { type: 'approval/asked', data: { toolName: 'bash', reason: '写入工作区' } });
console.log('[e2e] fired approval/asked');

// Run the real native binary's headless selftest against it.
const bin = 'pet/.build/release/voice-pet';
const child = spawn(bin, ['--selftest'], {
  env: { ...process.env, DSH_VOICE_PET_RUNTIME_FILE: RUNTIME },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => (out += d));
child.stderr.on('data', (d) => (out += d));
const code = await new Promise((r) => child.on('close', r));
console.log(`[e2e] ${bin} --selftest exit=${code}`);
console.log(out.split('\n').map((l) => `  | ${l}`).join('\n'));

server.close();
process.exit(code === 0 ? 0 : 1);