// PROTOTYPE — per-session voice assignment. Two properties must hold:
//   1. deterministic: a session keeps its voice forever (across restarts)
//   2. well-spread: conversations do not collide into the same voice+colour
// Run: node test-voices.mjs
import { sessionVoiceFor, hashId, defaultPalette } from './lib/tts.js';

const opts = { mode: 'per-session', voice: 'zh-CN-XiaoxiaoNeural', palette: [], backend: 'edge' };
const label = (c) => `${c.voice.replace(/^zh-CN-|Neural$/g, '')}/${c.rateJitter > 0 ? '+' : ''}${c.rateJitter}%`;

// 1. determinism — same id, same answer, repeatedly.
const a1 = sessionVoiceFor('session-abc', opts);
const a2 = sessionVoiceFor('session-abc', opts);
console.log('[determinism]', label(a1), '===', label(a2), a1.voice === a2.voice && a1.rateJitter === a2.rateJitter ? '✓' : '✗');

// 2. realistic session ids (uuid-shaped, as DSH mints them) spread out.
const ids = Array.from({ length: 40 }, (_, i) => `session-${(i + 1).toString(16).padStart(4, '0')}-4f2a-9c1e-${(i * 7919).toString(16)}`);
const seen = new Map();
for (const id of ids) {
  const key = label(sessionVoiceFor(id, opts));
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
const distinct = seen.size;
const sorted = [...seen.entries()].sort((x, y) => y[1] - x[1]);
console.log(`[spread] 40 sessions → ${distinct} distinct voice+colour combos`);
console.log('[distribution]', sorted.map(([k, n]) => `${k}×${n}`).join('  '));

// 3. collision rate for the first N sessions — what a human actually notices.
let worst = 0;
for (let n = 2; n <= 12; n += 1) {
  const set = new Set(ids.slice(0, n).map((id) => label(sessionVoiceFor(id, opts))));
  if (set.size < n) worst = n;
}
console.log(`[collision] first 12 sessions: ${new Set(ids.slice(0, 12).map((id) => label(sessionVoiceFor(id, opts)))).size}/12 distinct`);

// 4. fixed mode ignores the session entirely.
const fixed = sessionVoiceFor('session-abc', { ...opts, mode: 'fixed' });
console.log('[fixed mode]', label(fixed), fixed.voice === opts.voice && fixed.rateJitter === 0 ? '✓ (config voice, no jitter)' : '✗');

// 5. no session (e.g. the 试听 button) degrades to the configured voice.
const none = sessionVoiceFor(undefined, opts);
console.log('[no session]', label(none), none.voice === opts.voice ? '✓' : '✗');

// 6. palette override wins over the backend default.
const custom = sessionVoiceFor('session-abc', { ...opts, palette: ['zh-CN-YunjianNeural', 'zh-CN-YunyangNeural'] });
console.log('[custom palette]', label(custom), ['zh-CN-YunjianNeural', 'zh-CN-YunyangNeural'].includes(custom.voice) ? '✓' : '✗');

// 7. hash sanity — no clustering on sequential ids.
const buckets = new Array(10).fill(0);
for (let i = 0; i < 1000; i += 1) buckets[hashId(`session-${i}`) % 10] += 1;
console.log('[hash uniformity] per-decile counts:', buckets.join(','), `(min ${Math.min(...buckets)}, max ${Math.max(...buckets)})`);
console.log('[palette] backend default =', defaultPalette('edge').join(', '));
console.log('[done]');