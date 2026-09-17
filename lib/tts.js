/**
 * PROTOTYPE — TTS backends + earcons for dsh-voice-mini.
 *
 * Backends:
 * - `edge`:   node-edge-tts, free Microsoft neural voices, great zh. Cloud.
 * - `kokoro`: Kokoro-82M (0.08B) via kokoro-js in a CHILD PROCESS — English
 *             only (kokoro-js 1.2.1 has no zh G2P), and the child isolation
 *             sidesteps onnxruntime's abort-trap on process exit (Node 26).
 * - `say`:    macOS `say` command (offline, zh voice e.g. Tingting).
 * - `fake`:   no audio, for wiring tests.
 *
 * Earcons (`writeChimeFile`) are synthesized to WAV in-process — no asset
 * files ship with the prototype. Playback is awaited (`playAndWait`) so the
 * utterance queue can guarantee chime-then-speech ordering.
 *
 * @module dsh-voice-mini/tts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { copyFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
export const DEFAULT_DELIVERY = { ratePct: 0, volumePct: 0 };
/** SSML prosody form edge-tts wants: "+18%" / "-30%" / "+0%". */
function pct(n) {
    return `${n >= 0 ? '+' : ''}${Math.round(n)}%`;
}
/**
 * Convert ASCII digits to Chinese for a zh voice. edge-tts auto-switches to an
 * English voice the moment it hits digits in a Chinese sentence — a version
 * like "0.7.1" reads as "zero seven one" in a different voice, then snaps
 * back to zh, audibly flipping mid-utterance. Spelling the digits in Chinese
 * ("零点七点一") keeps the whole line in one voice.
 *
 * Version/decimal patterns get 点 between the digit groups; standalone digits
 * become 零–九. English words (e.g. "Bug") are left alone — zh voices read
 * those with an accent but don't auto-switch, so no need to touch them.
 */
const ZH_DIGIT = (d) => '零一二三四五六七八九'[Number(d)] ?? d;
export function digitsToZh(text) {
    return text
        .replace(/\d+(?:\.\d+)+/g, (m) => m.split('.').map((part) => part.split('').map(ZH_DIGIT).join('')).join(' 点 '))
        .replace(/\d/g, ZH_DIGIT);
}
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
// ── per-session voices ─────────────────────────────────────────────────────
//
// Each session gets its own voice so the human can tell conversations apart by
// ear, without ever picking a voice by hand. Two properties matter:
//   1. deterministic — same session ⇒ same voice, across restarts
//   2. subtle — stay inside one "assistant" family; vary timbre a little, not
//      a cast of characters
/** Voices that work today, per backend. (zh-CN-YunxiNeural is gone upstream.) */
// Per-session variety comes from the PALETTE, not pitch-shifting — shifting a
// voice's pitch makes it sound off, so each voice stays at its natural tone
// and sessions spread across a cast of distinct voices (female + male).
const DEFAULT_PALETTES = {
    // ONLY voices verified to synthesize via the free edge-tts endpoint. Many
    // zh voices Microsoft doesn't serve (Xiaohan/Xiaomeng/Xiaorui/Xiaomo and
    // Yunfeng/Yunhao all time out) — including them means ~40% of sessions
    // land on a dead voice and get garble + a fallback mismatch. Re-tested:
    // zh: Xiaoxiao/Xiaoyi/Yunjian/Yunyang · en: Aria/Christopher/Jenny/Guy.
    // The palette is locale-FILTERED (see defaultPalette) so a zh session never
    // lands on an en voice (and vice-versa) — edge-tts auto-switches voices
    // when the voice's language doesn't match the text, which reads as a jarring
    // mid-line voice flip ("1.3.1" → "one three" in a different voice).
    edge: [
        'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural',
        'zh-CN-YunjianNeural', 'zh-CN-YunyangNeural',
        'en-US-AriaNeural', 'en-US-ChristopherNeural',
        'en-US-JennyNeural', 'en-US-GuyNeural',
    ],
    kokoro: ['af_heart', 'af_bella', 'af_nicole', 'af_sarah', 'am_michael', 'am_puck'],
    say: ['Tingting', 'Meijia', 'Sinji'],
    fake: [],
};
/**
 * The default voice pool for a backend, optionally filtered to the user's
 * locale. A zh session pulls only zh-CN voices; an en session only en-US —
 * so the per-session voice always matches the spoken text's language and
 * edge-tts never auto-switches voices mid-line. If the filtered set is empty
 * (e.g. kokoro is en-only but locale is zh, or say is zh-only but locale is
 * en), fall back to the whole pool rather than silence. */
export function defaultPalette(backend, locale) {
    const all = DEFAULT_PALETTES[backend] ?? DEFAULT_PALETTES.edge;
    if (locale === 'zh') {
        const zh = all.filter((v) => v.startsWith('zh'));
        return zh.length > 0 ? zh : all;
    }
    if (locale === 'en') {
        const en = all.filter((v) => v.startsWith('en'));
        return en.length > 0 ? en : all;
    }
    return all;
}
/** FNV-1a — stable, dependency-free, plenty for spreading ids over a palette. */
export function hashId(id) {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i += 1) {
        h ^= id.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}
/**
 * Deterministic voice for a session.
 *
 * Palette position is the difference the ear actually notices: each session
 * lands on one natural voice — never pitch-shifted, since shifting a voice's
 * pitch makes it sound off (we vary the voice, not its tone). A small rate
 * offset is the only other jitter, catching the ear without distorting timbre.
 * With `fixed` mode (or no session) the configured voice is used untouched.
 *
 * @param palette - effective palette; empty falls back to the backend default.
 */
export function sessionVoiceFor(sessionId, options) {
    const palette = (options.palette && options.palette.length > 0
        ? options.palette
        : defaultPalette(options.backend, options.locale)).filter((v) => typeof v === 'string' && v !== '');
    if (options.mode === 'fixed' || palette.length === 0 || !sessionId) {
        return { voice: options.voice, rateJitter: 0 };
    }
    const h = hashId(sessionId);
    return {
        voice: palette[h % palette.length],
        // 5 steps across ±6%: the only non-voice jitter — nudges speed a touch so
        // two sessions sharing a voice rarely share a tempo. Widening the palette
        // (not pitch) is the lever for stronger separation.
        rateJitter: -6 + ((h >>> 13) % 5) * 3,
    };
}
const here = dirname(fileURLToPath(import.meta.url));
/** package root (lib/.. at runtime, src/.. in dev) */
const pkgRoot = resolve(here, '..');
function run(cmd, args) {
    return new Promise((res, rej) => {
        // ELECTRON_RUN_AS_NODE: harmless under plain Node, required if the host
        // plane is Electron (process.execPath would otherwise boot an Electron app).
        const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
        const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
        let err = '';
        p.stderr.on('data', (d) => (err += d));
        p.on('error', rej);
        p.on('close', (code) => (err && process.env.DSH_VOICE_MINI_DEBUG ? console.error(err) : undefined, res(code ?? -1)));
    });
}
/** edge-tts: cloud, free, excellent zh+en.
 *
 * Runs in a CHILD PROCESS (scripts/synth-edge.mjs) with ELECTRON_RUN_AS_NODE=1
 * so it's plain Node, not Electron. edge-tts's WebSocket is 100% reliable in
 * plain Node but flakes ~50% (10s timeout, 0-byte file) in the Electron main
 * process; the child restores the reliability. The parent judges success by
 * the output file, so a child abort-trap on exit doesn't cause a false failure. */
export class EdgeBackend {
    id = 'edge';
    async synthesize(text, outFile, voice = 'zh-CN-XiaoxiaoNeural', delivery = DEFAULT_DELIVERY) {
        const t0 = Date.now();
        const script = join(pkgRoot, 'scripts', 'synth-edge.mjs');
        // NOTE: rate works well, but edge's SSML `volume` is normalised server-side
        // (-100% is a no-op, +100% buys ~6%). Loudness is applied at PLAYBACK time
        // instead — see playAndWait().
        // For zh voices, spell digits in Chinese first — otherwise edge-tts
        // auto-switches to an English voice for any digits ("0.7.1" → "zero
        // seven one" in a different voice, then back), flipping mid-line.
        const spoken = voice.startsWith('zh') ? digitsToZh(text) : text;
        await run(process.execPath, [script, spoken, outFile, voice, pct(delivery.ratePct)]);
        return { path: outFile, mime: 'audio/mpeg', ms: Date.now() - t0 };
    }
}
/** Kokoro-82M in a child process: local, 0.08B, ENGLISH ONLY (kokoro-js has no zh G2P). */
export class KokoroBackend {
    id = 'kokoro';
    async synthesize(text, outFile, voice = 'af_heart', delivery = DEFAULT_DELIVERY) {
        const t0 = Date.now();
        const script = join(pkgRoot, 'scripts', 'synth-kokoro.mjs');
        // kokoro-js takes a speed multiplier rather than a percentage.
        const speed = clamp(1 + delivery.ratePct / 100, 0.5, 2);
        // The child abort-traps on exit (onnxruntime+Node26 teardown) even on
        // success — judge by the output FILE, not the exit code.
        await run(process.execPath, [script, text, outFile, voice, String(speed)]);
        if (!existsSync(outFile))
            throw new Error('kokoro: child produced no audio (see DSH_VOICE_MINI_DEBUG)');
        return { path: outFile, mime: 'audio/wav', ms: Date.now() - t0 };
    }
}
/** macOS `say` — offline, has zh voices (Tingting). */
export class SayBackend {
    id = 'say';
    async synthesize(text, outFile, voice = 'Tingting', delivery = DEFAULT_DELIVERY) {
        const t0 = Date.now();
        // `say -r` is words per minute; ~180 is a neutral Chinese pace. Volume has
        // no CLI knob here, so the quiet preset leans on rate only.
        const wpm = clamp(Math.round(180 * (1 + delivery.ratePct / 100)), 90, 400);
        const code = await run('/usr/bin/say', ['-v', voice, '-r', String(wpm), '-o', outFile, text]);
        if (code !== 0 || !existsSync(outFile))
            throw new Error(`say exited ${code}`);
        return { path: outFile, mime: 'audio/aiff', ms: Date.now() - t0 };
    }
}
/** fake — writes a marker file, no audio. For wiring tests. */
export class FakeBackend {
    id = 'fake';
    async synthesize(text, outFile) {
        await writeFile(outFile, `FAKE TTS: ${text}\n`, 'utf8');
        return { path: outFile, mime: 'text/plain', ms: 0 };
    }
}
export function makeBackend(id) {
    switch (id) {
        case 'kokoro': return new KokoroBackend();
        case 'say': return new SayBackend();
        case 'fake': return new FakeBackend();
        case 'edge':
        default: return new EdgeBackend();
    }
}
/** Best-effort local playback; never throws, never waits. */
export function play(file) {
    if (process.platform !== 'darwin')
        return; // prototype: macOS only
    const p = spawn('afplay', [file], { stdio: 'ignore', detached: true });
    p.on('error', () => { });
    p.unref();
}
/**
 * Play a file and resolve when playback finishes (macOS `afplay` exits with
 * the sound). On other platforms this resolves immediately. A hard timeout
 * keeps a wedged player from stalling the utterance queue.
 *
 * Loudness is a playback concern: `afplay -v` is fully under our control and
 * works for every backend, unlike edge's server-side prosody volume.
 *
 * @param options.timeoutMs - upper bound; default 30s (enough for a capped utterance).
 * @param options.volumePct - 0 = normal, -30 = quieter (clamped to 0..1.5).
 */
export function playAndWait(file, options = {}) {
    if (process.platform !== 'darwin')
        return Promise.resolve();
    const timeoutMs = options.timeoutMs ?? 30_000;
    const factor = clamp(1 + (options.volumePct ?? 0) / 100, 0, 1.5);
    const args = factor === 1 ? [file] : ['-v', factor.toFixed(2), file];
    return new Promise((resolvePromise) => {
        let settled = false;
        const done = () => { if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolvePromise();
        } };
        const timer = setTimeout(() => {
            // Playback outran the cap — leave it running, free the queue.
            done();
        }, timeoutMs);
        const p = spawn('afplay', args, { stdio: 'ignore' });
        p.on('error', done);
        p.on('close', done);
    });
}
// ── earcons ────────────────────────────────────────────────────────────────
const SAMPLE_RATE = 44_100;
/** Encode mono float samples as a 16-bit PCM WAV. */
function encodeWav(samples) {
    const bytes = Buffer.alloc(44 + samples.length * 2);
    bytes.write('RIFF', 0);
    bytes.writeUInt32LE(36 + samples.length * 2, 4);
    bytes.write('WAVE', 8);
    bytes.write('fmt ', 12);
    bytes.writeUInt32LE(16, 16);
    bytes.writeUInt16LE(1, 20); // PCM
    bytes.writeUInt16LE(1, 22); // mono
    bytes.writeUInt32LE(SAMPLE_RATE, 24);
    bytes.writeUInt32LE(SAMPLE_RATE * 2, 28); // byte rate
    bytes.writeUInt16LE(2, 32); // block align
    bytes.writeUInt16LE(16, 34); // bits per sample
    bytes.write('data', 36);
    bytes.writeUInt32LE(samples.length * 2, 40);
    for (let i = 0; i < samples.length; i += 1) {
        const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
        bytes.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
    }
    return bytes;
}
/** One decaying sine tone. */
function tone(freq, seconds, decay = 4, attack = 0.004) {
    const n = Math.floor(SAMPLE_RATE * seconds);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
        const t = i / SAMPLE_RATE;
        const env = Math.min(1, t / attack) * Math.exp(-decay * t);
        out[i] = Math.sin(2 * Math.PI * freq * t) * env * 0.45;
    }
    return out;
}
function silence(seconds) {
    return new Float32Array(Math.floor(SAMPLE_RATE * seconds));
}
function concat(...parts) {
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const p of parts) {
        out.set(p, offset);
        offset += p.length;
    }
    return out;
}
/** Build the earcon waveform for a preset. `none` yields null. */
function chimeWave(sound) {
    switch (sound) {
        case 'ding': {
            // A crisp bell "叮": inharmonic partials, sharp attack, fast decay.
            // Higher partials die first, so it brightens on strike then settles.
            const dur = 0.32;
            const n = Math.floor(SAMPLE_RATE * dur);
            const out = new Float32Array(n);
            const partials = [
                { f: 1568, d: 5.0, g: 0.50 }, // body (G6)
                { f: 2349, d: 10.0, g: 0.28 }, // ≈1.5× inharmonic — the "ring"
                { f: 3136, d: 15.0, g: 0.16 }, // ≈2× sparkle, dies fast
            ];
            for (let i = 0; i < n; i += 1) {
                const t = i / SAMPLE_RATE;
                const env = Math.min(1, t / 0.0012) * Math.exp(-3.5 * t);
                let s = 0;
                for (const p of partials) {
                    s += Math.sin(2 * Math.PI * p.f * t) * Math.exp(-p.d * t) * p.g;
                }
                out[i] = s * env * 0.55;
            }
            return out;
        }
        case 'ping': return concat(tone(880, 0.11, 5), silence(0.015), tone(1318.5, 0.17, 4));
        case 'soft': return concat(tone(587.3, 0.3, 3.2, 0.03));
        case 'none': return null;
        default: return null;
    }
}
/** File extension for a chime preset — `.aiff` for the copied system sound. */
export function chimeFileExt(sound) {
    return sound === 'glass' ? 'aiff' : 'wav';
}
/**
 * Materialize an earcon inside the audio dir (idempotent).
 * - `glass` copies the macOS system notification sound (Glass.aiff) — the
 *   exact chime DSH Desktop itself uses for native notifications.
 * - synthesized presets (`ding`/`ping`/`soft`) are generated to WAV.
 * @returns the file path, or null for the `none` preset.
 */
export async function writeChimeFile(sound, audioDir) {
    if (sound === 'glass') {
        const src = '/System/Library/Sounds/Glass.aiff';
        if (!existsSync(src))
            return null; // non-macOS or missing
        await mkdir(audioDir, { recursive: true });
        const file = join(audioDir, 'chime-glass.aiff');
        if (!existsSync(file))
            copyFileSync(src, file);
        return file;
    }
    const wave = chimeWave(sound);
    if (wave === null)
        return null;
    await mkdir(audioDir, { recursive: true });
    const file = join(audioDir, `chime-${sound}.wav`);
    if (!existsSync(file))
        await writeFile(file, encodeWav(wave));
    return file;
}
export function resolveAudioDir(dir) {
    return resolve(dir.replace(/^~/, homedir()));
}
export async function freshAudioFile(dir, ext) {
    await mkdir(dir, { recursive: true });
    return join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`);
}
/**
 * Best-effort audio duration in seconds (macOS `afinfo`). Returns 0 if the
 * file can't be probed (non-macOS, missing tool, or a corrupt file afinfo
 * refuses to parse). Non-blocking — spawns afinfo and resolves on close.
 *
 * Used to catch PARTIAL synthesis: edge-tts sometimes drops its WebSocket
 * mid-stream and leaves a non-zero but truncated mp3. The `size === 0` guard
 * misses those, so the corrupt clip plays as a garbled blip. Comparing the
 * real duration against a per-char floor flags them as failures → the
 * fallback voice retry runs instead.
 */
export function audioDurationSec(file) {
    return new Promise((resolve) => {
        if (process.platform !== 'darwin')
            return resolve(0);
        const p = spawn('afinfo', [file], { stdio: ['ignore', 'pipe', 'ignore'] });
        let out = '';
        p.stdout.on('data', (d) => { out += d; });
        p.on('error', () => resolve(0));
        p.on('close', () => {
            const m = out.match(/estimated duration:\s*([0-9.]+)/i);
            resolve(m ? parseFloat(m[1]) : 0);
        });
    });
}
