// Settings-panel server logic: picking a gear clears the gear-owned hand
// edits, the snapshot reports them (presetOverrides) and whether Jarvis is
// loaded right now (jarvisConnected).
// Run: node --test test-settings-panel.mjs  (after `npm run build`)
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import { apply, withoutPresetEdits, presetEdits } from './lib/index.js';

const CONFIG_FILE = '/tmp/dsh-vm-settings-panel-test.json';

function mount({ jarvis = false, persist = false } = {}) {
  if (persist) {
    delete process.env.DSH_VOICE_MINI_NO_PERSIST;
    process.env.DSH_VOICE_MINI_CONFIG_FILE = CONFIG_FILE;
  } else {
    process.env.DSH_VOICE_MINI_NO_PERSIST = '1';
    delete process.env.DSH_VOICE_MINI_CONFIG_FILE;
  }
  const services = new Map();
  const routes = [];
  const ctx = {
    tools: { register: () => {} },
    on: () => {},
    get: (n) => services.get(n),
    inject: (names, cb) => { if (names.every((n) => services.has(n))) cb(ctx); },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  };
  services.set('webServer', { host: '127.0.0.1', port: 43120, register: (r) => { routes.push(r); return () => {}; } });
  services.set('systemPrompt', { section: () => {} });
  services.set('settings', { installSection: (_o, _n, _s, e, h) => { h.setSource(() => e); h.onChange(); } });
  if (jarvis) services.set('jarvis', { claimsTurnEnd: () => false });
  apply(ctx, { backend: 'fake', audioDir: '/tmp/dsh-vm-settings-panel-audio', chimeEnabled: false });
  const route = routes.at(-1);
  const call = async (method, path, raw) => {
    const res = { status: 0, body: '', writeHead(c) { this.status = c; }, end(b) { this.body = b ?? ''; } };
    const req = { url: `/voice-mini/${path}`, method, socket: { remoteAddress: '127.0.0.1' }, headers: {},
      async *[Symbol.asyncIterator]() { if (raw !== undefined) yield Buffer.from(raw); } };
    await route.handler(req, res);
    return { status: res.status, json: res.body ? JSON.parse(res.body) : undefined };
  };
  return {
    state: async () => (await call('GET', 'state')).json,
    config: (patch) => call('POST', 'config', JSON.stringify(patch)),
    raw: (text) => call('POST', 'config', text),
  };
}

beforeEach(() => rmSync(CONFIG_FILE, { force: true }));

describe('等价类', () => {
  it('withoutPresetEdits 只清档位字段，保留非档位字段', () => {
    const saved = { preset: 'default', announceTodo: true, chimeStatus: 'ding', locale: 'en', voicePalette: ['a'], jarvisVoice: 'x' };
    assert.deepEqual(withoutPresetEdits(saved), { preset: 'default', locale: 'en', voicePalette: ['a'], jarvisVoice: 'x' });
  });

  it('presetEdits 只列出和当前档位不同的档位字段', () => {
    assert.deepEqual(presetEdits({ announceTodo: true, announceApproval: true, locale: 'en' }, 'default'), ['announceTodo']);
  });

  it('单独改开关后快照报告 presetOverrides', async () => {
    const vm = mount();
    await vm.config({ announceTodo: true, chimeStatus: 'ding' });
    assert.deepEqual((await vm.state()).presetOverrides.sort(), ['announceTodo', 'chimeStatus']);
  });

  it('选档位会清掉档位字段的单独改动，档位值重新生效', async () => {
    const vm = mount();
    await vm.config({ announceTodo: true, summarizeResult: false });
    await vm.config({ preset: 'default' });
    const s = await vm.state();
    assert.deepEqual(s.presetOverrides, []);
    assert.equal(s.announceTodo, false);
    assert.equal(s.summarizeResult, true);
  });

  it('选档位保留非档位设置（语言、音色池、贾维斯音色）', async () => {
    const vm = mount();
    await vm.config({ locale: 'en', voicePalette: ['en-US-AriaNeural'], jarvisVoice: 'en-GB-RyanNeural' });
    await vm.config({ preset: 'quiet' });
    const s = await vm.state();
    assert.equal(s.preset, 'quiet');
    assert.equal(s.locale, 'en');
    assert.equal(s.jarvisVoice, 'en-GB-RyanNeural');
    assert.deepEqual(s.voicePalette, ['en-US-AriaNeural']);
  });

  it('说话方式独立于档位：切档位不改逐字朗读，也不计入单独调整', async () => {
    const vm = mount();
    await vm.config({ readReplies: true });
    assert.deepEqual((await vm.state()).presetOverrides, []);
    await vm.config({ preset: 'instant' });
    assert.equal((await vm.state()).readReplies, true);
  });

  it('贾维斯已加载时 jarvisConnected=true，否则 false', async () => {
    assert.equal((await mount().state()).jarvisConnected, false);
    assert.equal((await mount({ jarvis: true }).state()).jarvisConnected, true);
  });

  it('选档位的结果写进配置文件，重新加载后仍无单独改动', async () => {
    const vm = mount({ persist: true });
    await vm.config({ announceTodo: true, locale: 'en' });
    await vm.config({ preset: 'instant' });
    const file = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'));
    assert.deepEqual(file, { locale: 'en', preset: 'instant' });
    const s = await mount({ persist: true }).state();
    assert.equal(s.preset, 'instant');
    assert.deepEqual(s.presetOverrides, []);
  });
});

describe('边界值', () => {
  it('改动的值恰好等于档位值时不算单独调整', async () => {
    const vm = mount();
    await vm.config({ announceApproval: true, announceTurnStart: false });
    assert.deepEqual((await vm.state()).presetOverrides, []);
  });

  it('同一个补丁里同时带档位和档位字段：补丁里的字段保留', async () => {
    const vm = mount();
    await vm.config({ announceTodo: true, announceToolCall: true });
    await vm.config({ preset: 'quiet', announceToolCall: true });
    const s = await vm.state();
    assert.equal(s.announceTodo, false);
    assert.equal(s.announceToolCall, true);
    assert.deepEqual(s.presetOverrides, ['announceToolCall']);
  });

  it('重选当前档位也会清掉单独改动（恢复档位设置）', async () => {
    const vm = mount();
    await vm.config({ ratePct: 40 });
    assert.deepEqual((await vm.state()).presetOverrides, ['ratePct']);
    await vm.config({ preset: 'default' });
    const s = await vm.state();
    assert.equal(s.ratePct, 0);
    assert.deepEqual(s.presetOverrides, []);
  });

  it('旧配置文件里残留的单独改动在加载时就能被报告出来', async () => {
    writeFileSync(CONFIG_FILE, JSON.stringify({ preset: 'quiet', announceTurnEnd: true, volumePct: -30 }));
    const s = await mount({ persist: true }).state();
    assert.deepEqual(s.presetOverrides, ['announceTurnEnd']);
  });

  it('presetEdits 遇到未知档位按默认档比较', () => {
    assert.deepEqual(presetEdits({ announceTodo: true }, 'nope'), ['announceTodo']);
    assert.deepEqual(presetEdits({}, 'nope'), []);
  });

  it('withoutPresetEdits 空输入返回空对象且不改原对象', () => {
    assert.deepEqual(withoutPresetEdits({}), {});
    const saved = { announceTodo: true };
    withoutPresetEdits(saved);
    assert.deepEqual(saved, { announceTodo: true });
  });
});

describe('异常路径', () => {
  it('未知档位名被忽略，不清掉单独改动', async () => {
    const vm = mount();
    await vm.config({ announceTodo: true });
    await vm.config({ preset: 'loud' });
    const s = await vm.state();
    assert.equal(s.preset, 'default');
    assert.deepEqual(s.presetOverrides, ['announceTodo']);
  });

  it('档位字段类型不对时被忽略', async () => {
    const vm = mount();
    await vm.config({ preset: 42, announceTodo: 'yes', chimeStatus: 'boom' });
    assert.deepEqual((await vm.state()).presetOverrides, []);
  });

  it('格式错误的 JSON 返回 500，状态不变', async () => {
    const vm = mount();
    await vm.config({ announceTodo: true });
    const r = await vm.raw('{not json');
    assert.equal(r.status, 500);
    assert.deepEqual((await vm.state()).presetOverrides, ['announceTodo']);
  });

  it('请求体为 null 或空时按空补丁处理', async () => {
    const vm = mount();
    await vm.config({ announceTodo: true });
    assert.equal((await vm.raw('null')).status, 200);
    assert.equal((await vm.raw('')).status, 200);
    assert.deepEqual((await vm.state()).presetOverrides, ['announceTodo']);
  });

  it('全部恢复默认清掉所有改动', async () => {
    const vm = mount();
    await vm.config({ preset: 'quiet', announceTodo: true, locale: 'en' });
    await vm.config({ reset: true });
    const s = await vm.state();
    assert.equal(s.preset, 'default');
    assert.equal(s.locale, 'zh');
    assert.deepEqual(s.presetOverrides, []);
  });
});
