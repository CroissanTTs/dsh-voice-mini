import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { basename, dirname, extname, join } from 'node:path';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { freshAudioFile, makeBackend, playAndWait, resolveAudioDir, sessionVoiceFor, writeChimeFile, chimeFileExt, defaultPalette, audioDurationSec, cancelPlayback, } from "./tts.js";
import { authorized, isLoopback, loadOrCreateToken, writeRuntime } from "./pet.js";
import { pickLocale, normalizeLocale } from "./locale/index.js";
export const name = 'dsh-voice-mini';
/** Services required before mount; systemPrompt/webServer/settings stay optional (ctx.inject). */
export const inject = ['tools'];
export const Config = z.object({
    // ── 档位 (communication preset): 说话的频率 / 内容范围 / 声音 ──────────────
    preset: z.union(['instant', 'default', 'quiet']).default('default'),
    backend: z.union(['edge', 'kokoro', 'say', 'fake']).default('edge'),
    // 声音分配：按会话自动（默认）还是固定一个音色
    voiceMode: z.union(['per-session', 'fixed']).default('per-session'),
    /** Empty ⇒ the backend's built-in palette (see tts.ts). */
    voicePalette: z.array(z.string()).default([]),
    /** Used as-is in `fixed` mode, and as the fallback when no session is known. */
    voice: z.string().default('zh-CN-XiaoxiaoNeural'),
    audioDir: z.string().default('~/.dsh/voice-mini'),
    // 结果回复 (result narration)
    readReplies: z.boolean().default(false),
    narrationCap: z.number().default(300),
    // earcon before every utterance
    chimeEnabled: z.boolean().default(true),
    chimeSpeech: z.union(['glass', 'ding', 'ping', 'soft', 'none']).default('glass'),
    chimeStatus: z.union(['glass', 'ding', 'ping', 'soft', 'none']).default('soft'),
    // 进行中回复 (status announcements)
    statusEnabled: z.boolean().default(true),
    announceApproval: z.boolean().default(true),
    announceQuestion: z.boolean().default(true),
    announceTurnStart: z.boolean().default(false),
    announceTurnEnd: z.boolean().default(true),
    announceTodo: z.boolean().default(false),
    announceToolCall: z.boolean().default(false),
    // 少量档：状态项只响提示音不说话
    statusSpeech: z.boolean().default(true),
    // 自定义完成提示词，{title} = 工作区目录名。空字符串 ⇒ 用当前 locale 的默认
    phraseTurnEnd: z.string().default(''),
    // 语言（中/英）：口播短语、verbalizer prompt、客户端文案都按它切换
    locale: z.union(['zh', 'en']).default('zh'),
    // 情绪化总结：结果出来后用模型生成一句带情绪引导的口播
    summarizeResult: z.boolean().default(true),
    summarizeProvider: z.string().default(''),
    summarizeModel: z.string().default(''),
    summarizeMaxTokens: z.number().default(200),
    summarizeTimeoutMs: z.number().default(8000),
    // 声音 delivery (mapped per backend)
    ratePct: z.number().default(0),
    volumePct: z.number().default(0),
    // ── Jarvis 联动 ──────────────────────────────────────────────────────────
    // When true, a "Jarvis" panel section appears with dedicated voice/speech
    // controls for the cross-session assistant. Auto-set if the 'jarvis' service
    // is injected (dsh-harness-jarvis present); can also be toggled manually.
    jarvisLinked: z.boolean().default(false),
    // A dedicated voice for Jarvis's OWN announcements (separate from per-session
    // voices). Empty = use the configured default voice.
    jarvisVoice: z.string().default(''),
    // How eagerly Jarvis speaks: 'always' (every cross-session event),
    // 'normal' (milestones + blockers), 'quiet' (only blockers).
    jarvisSpeechMode: z.union(['always', 'normal', 'quiet']).default('normal'),
    // Voicemail mode: queued utterances park in an inbox (unread badge) instead
    // of playing immediately.
    jarvisVoicemail: z.boolean().default(false),
    // The Jarvis persona prompt — a unified personality across all sessions.
    jarvisPersona: z.string().default(''),
});
/**
 * The three communication gears. Each is a bundle over the granular config —
 * the host does not special-case them, it just resolves them as the base
 * layer (see `resolve()`), so any single field can still be overridden.
 *
 * "频率" comes from two places at once: these event filters AND the persona
 * text (PERSONA_BY_PRESET), because the agent decides on its own whether to
 * reach for the `speak` tool.
 */
const PRESETS = {
    // 即时沟通 — you are away from the screen and want to follow along.
    // readReplies stays OFF: the model speaks in its own voice, and 逐字朗读 is a
    // separate, mutually-exclusive mode rather than a gear.
    instant: {
        readReplies: false,
        narrationCap: 600,
        statusEnabled: true,
        announceApproval: true,
        announceQuestion: true,
        announceTurnStart: true,
        announceTurnEnd: true,
        announceTodo: true,
        announceToolCall: true,
        statusSpeech: true,
        chimeEnabled: true,
        chimeSpeech: 'glass',
        chimeStatus: 'glass',
        summarizeResult: true,
        ratePct: 18,
        volumePct: 0,
    },
    // 默认沟通 — balanced: results narrated on demand, only blocking notices spoken.
    default: {
        readReplies: false,
        narrationCap: 300,
        statusEnabled: true,
        announceApproval: true,
        announceQuestion: true,
        announceTurnStart: false,
        announceTurnEnd: true,
        announceTodo: false,
        announceToolCall: false,
        statusSpeech: true,
        chimeEnabled: true,
        chimeSpeech: 'glass',
        chimeStatus: 'soft',
        summarizeResult: true,
        ratePct: 0,
        volumePct: 0,
    },
    // 少量沟通 — only what the human must act on; quieter and slower.
    quiet: {
        readReplies: false,
        narrationCap: 120,
        statusEnabled: true,
        announceApproval: true,
        announceQuestion: true,
        announceTurnStart: false,
        announceTurnEnd: false,
        announceTodo: false,
        announceToolCall: false,
        statusSpeech: false,
        chimeEnabled: true,
        chimeSpeech: 'soft',
        chimeStatus: 'soft',
        summarizeResult: false,
        ratePct: -5,
        volumePct: -30,
    },
};
const PRESET_KEYS = ['instant', 'default', 'quiet'];
/** Tools worth naming aloud in 即时 mode (action-shaped, not lookups). */
const NOTABLE_TOOLS = new Set(['bash', 'write', 'edit', 'task', 'subagent', 'web_search', 'web_fetch']);
const STATUS_KEYS = [
    'statusEnabled', 'announceApproval', 'announceQuestion', 'announceTurnStart', 'announceTurnEnd', 'announceTodo',
];
/**
 * The agent decides on its own whether to reach for `speak`, so the gear has
 * to be stated in the prompt too — event filters alone cannot make an agent
 * more or less talkative. One persona per preset.
 */
const PERSONA_BY_PRESET = {
    instant: [
        '## Your voice (即时沟通 mode)',
        'You have a voice via the `speak` tool, and the human is following along by ear rather than reading the screen.',
        '- Speak as yourself, not as a transcript: say what you would actually tell the person you are working for, not a restatement of your reply.',
        '- Speak at each meaningful step: something landed, a decision point, or the start of a long wait.',
        '- One or two short sentences of plain prose. Never read out code, paths, diffs, or markdown.',
        '- Err on the side of speaking, but do not narrate every trivial action.',
    ].join('\n'),
    default: [
        '## Your voice',
        'You have a voice via the `speak` tool.',
        '- When you deliver a result, say ONE short line in your own voice about it: what you did and what it means for the human. Do not read your reply out — say the thing you would actually say.',
        '- One or two sentences of plain prose. Never read out code, paths, diffs, or markdown.',
        '- Stay silent during routine in-between work.',
    ].join('\n'),
    quiet: [
        '## Your voice (少量沟通 mode)',
        'You have a voice via the `speak` tool, but the human asked for minimal talk.',
        '- Speak only when the human must act or is otherwise blocked: an approval is pending, or you need an answer.',
        '- Do not narrate progress, results, or routine work.',
        '- When you do speak: one short sentence.',
    ].join('\n'),
};
/**
 * 逐字朗读模式. Reading the reply aloud and having the model compose its own
 * line are two answers to the same question, so they exclude each other: while
 * this is on, the reply itself is the speech and `speak` would double it.
 */
const PERSONA_NARRATION = [
    '## Your voice (逐字朗读 mode)',
    'Your text replies are read aloud verbatim, so writing *is* speaking here.',
    '- Do NOT also call the `speak` tool — the same words would be heard twice.',
    '- Anything you want heard should read as a plain sentence; code blocks and paths are stripped before speaking.',
].join('\n');
/** Crude markdown scrub before narration (prototype-grade).
 * `codeOmitted` is localized — passed in by the caller from pickLocale(). */
function scrubForSpeech(text, codeOmitted = '（代码略）') {
    return text
        .replaceAll(/```[\s\S]*?```/g, codeOmitted)
        .replaceAll(/`[^`]*`/g, '')
        .replaceAll(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replaceAll(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replaceAll(/^#{1,6}\s*/gm, '')
        .replaceAll(/[*_>|~-]{1,3}/g, '')
        .replaceAll(/\s+/g, ' ')
        .trim();
}
function extForBackend(backend) {
    return backend === 'edge' ? 'mp3' : backend === 'kokoro' ? 'wav' : backend === 'say' ? 'aiff' : 'txt';
}
function mimeOf(file) {
    switch (extname(file)) {
        case '.mp3': return 'audio/mpeg';
        case '.wav': return 'audio/wav';
        case '.aiff': return 'audio/aiff';
        default: return 'text/plain';
    }
}
/** Truncate to n chars with a localized ellipsis suffix. */
function cap(text, n = 300, suffix = '…（后略）') {
    return text.length > n ? `${text.slice(0, n)}${suffix}` : text;
}
async function readBody(req) {
    let data = '';
    for await (const chunk of req)
        data += chunk;
    return data;
}
/**
 * Read the Desktop shell's renderer capability, when this composition has one.
 *
 * The shell's webserver wraps every plugin route in `permits(req)` and answers
 * 403 "forbidden" unless the request carries `x-dsh-desktop-renderer` (while
 * `ordinaryBrowserEnabled` is false — the default). A plugin may read the
 * capability from its own `desktopBrowserAccess` service, which is how the
 * native pet is admitted like the Electron renderer.
 *
 * @returns the header to replay, or undefined outside the Desktop shell.
 */
function desktopRendererHeader(ctx) {
    const access = ctx.get('desktopBrowserAccess');
    const name = access?.rendererHeader?.name;
    const value = access?.rendererHeader?.value;
    if (typeof name !== 'string' || typeof value !== 'string' || name === '' || value === '')
        return undefined;
    return { name, value };
}
function sendJson(res, code, body) {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}
/**
 * Wire this plugin's namespace into the standard settings panel.
 *
 * 0.1.5-rc.1 ships `installSettingsSection(ctx, ns, schema, entry, hooks)`
 * which internally defers through `ctx.inject(['settings'], …)`; we reach the
 * service structurally and degrade to "no panel section" if absent — the
 * composition entry then stays the effective config.
 */
function installSettingsSection(ctx, ns, schema, entry, hooks) {
    ctx.inject(['settings'], async (settingsCtx) => {
        const settings = settingsCtx.get('settings');
        if (settings?.installSection === undefined)
            return;
        try {
            settings.installSection(ctx, ns, schema, entry, hooks);
            ctx.logger.warn(`dsh-voice-mini: settings section "${ns}" installed`);
        }
        catch (error) {
            ctx.logger.warn('dsh-voice-mini: settings section install failed', error);
        }
    });
}
export function apply(ctx, rawConfig) {
    const entry = { ...Config(rawConfig ?? {}), ...rawConfig };
    const state = { readReplies: entry.readReplies };
    const recent = []; // ring buffer, cap 30
    const metrics = []; // ring buffer, cap 100
    // Aggregates computed on demand from `metrics`.
    const pushMetric = (m) => {
        metrics.push(m);
        if (metrics.length > 100)
            metrics.splice(0, metrics.length - 100);
    };
    // System stats sampled periodically.
    let sysStats = {
        cpuUser: 0, cpuSystem: 0, rssMb: 0, heapMb: 0, audioMb: 0,
    };
    let lastCpu = process.cpuUsage();
    let lastCpuTime = Date.now();
    const sampleSystem = async () => {
        const now = Date.now();
        const cpu = process.cpuUsage(lastCpu);
        const elapsed = now - lastCpuTime;
        lastCpu = cpu;
        lastCpuTime = now;
        const mem = process.memoryUsage();
        // Disk: sum audio file sizes
        let audioBytes = 0;
        try {
            const dir = resolveAudioDir(current().audioDir);
            const { readdirSync, statSync } = await import('node:fs');
            for (const f of readdirSync(dir)) {
                try {
                    audioBytes += statSync(join(dir, f)).size;
                }
                catch { /* */ }
            }
        }
        catch { /* dir missing */ }
        sysStats = {
            cpuUser: (cpu.user / 1000) / elapsed * 100, // ms → % of elapsed
            cpuSystem: (cpu.system / 1000) / elapsed * 100,
            rssMb: Math.round(mem.rss / 1048576 * 10) / 10,
            heapMb: Math.round(mem.heapUsed / 1048576 * 10) / 10,
            audioMb: Math.round(audioBytes / 1048576 * 10) / 10,
        };
    };
    // Sample system stats every 30s.
    const sysTimer = setInterval(() => { void sampleSystem(); }, 30_000);
    sysTimer.unref();
    // ── pet state (native floating widget, see pet/ + src/pet.ts) ────────────
    /** Non-null only while an utterance is playing — drives the pet's animation. */
    let speaking = null;
    /** Something the human should act on (approval / question) — pet looks alert. */
    let attention = null;
    /** Tool names already named aloud this turn (即时 mode dedup). */
    const announcedTools = new Set();
    /**
     * Did the model speak for itself this turn? If it did, the mechanical
     * 「本轮完成」 template must stay quiet — otherwise the same turn is
     * announced twice, once in the assistant's voice and once as a beep-boop.
     */
    let spokeThisTurn = false;
    /** The text of the last assistant message — consumed by the verbalizer at turn/end. */
    let lastReplyText = '';
    /** Per-session voice control: sessions in this set have ALL voice disabled. */
    const disabledSessions = new Set();
    /** Per-session voice OVERRIDE — when a session re-rolls its voice, the chosen
     * {voice, rateJitter} lives here and beats the deterministic hash. In-memory
     * only (resets on restart, falling back to the hash). */
    const voiceOverride = new Map();
    /** The most recent session that triggered an event — for the UI's "本会话" toggle. */
    let lastSessionId;
    // The LLM service — used by the verbalizer to generate an emotionally-aware
    // spoken summary of the reply after a turn ends.
    let llmService;
    ctx.inject(['llm'], (llmCtx) => {
        llmService = llmCtx.get('llm');
        ctx.logger.warn('dsh-voice-mini: llm service attached (verbalizer ready)');
    });
    // The sessionTitle service — attached when the host provides it. Used to
    // include the conversation's name in the turn/end announcement so the human
    // can tell WHICH session finished when several run at once.
    let titleService;
    ctx.inject(['sessionTitle'], (titleCtx) => {
        titleService = titleCtx.get('sessionTitle');
        ctx.logger.warn('dsh-voice-mini: sessionTitle service attached');
    });
    const titleFor = (session) => {
        try {
            const s = session;
            // 1. Workspace directory basename — always available, unique per project,
            //    short enough to speak. More distinctive than a truncated message.
            const cwd = s?.header?.cwd ?? s?.cwd;
            if (typeof cwd === 'string' && cwd.trim() !== '') {
                const base = cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
                if (base.length > 0)
                    return base;
            }
            // 2. Title service (LLM-generated or first-message fallback) — only when
            //    the cwd is somehow missing.
            const title = titleService?.get(session)?.title?.trim();
            return title && title.length > 0 ? title : undefined;
        }
        catch {
            return undefined;
        }
    };
    /**
     * Verbalizer pass: ask a lightweight model to turn the assistant's reply into
     * one spoken sentence with emotional framing ("好消息…" / "需注意…").
     *
     * Returns null on timeout, error, or empty output — the caller falls back to
     * the template phrase.
     *
     * @param replyText - the scrubbed text of the last assistant message.
     */
    async function summarizeReply(replyText, sid) {
        if (llmService === undefined || replyText.trim() === '')
            return null;
        const config = current();
        const prompt = pickLocale(config.locale).summarizePrompt.replace('{reply}', replyText.slice(0, 2000));
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), config.summarizeTimeoutMs);
        const startedAt = Date.now();
        let assembler;
        try {
            // Provider + model detection (same as before).
            let provider = config.summarizeProvider;
            if (!provider) {
                const adapters = llmService.adapters;
                if (adapters instanceof Map && adapters.size > 0)
                    provider = [...adapters.keys()][0];
            }
            if (!provider) {
                ctx.logger.warn('dsh-voice-mini: no LLM provider, verbalizer disabled');
                return null;
            }
            let model = config.summarizeModel;
            if (model === '') {
                try {
                    const models = await llmService.listModels?.(provider);
                    if (Array.isArray(models) && models.length > 0) {
                        model = models[0].id;
                        ctx.logger.warn(`dsh-voice-mini: auto-detected provider=${provider} model=${model}`);
                    }
                }
                catch { /* */ }
            }
            if (!model) {
                ctx.logger.warn(`dsh-voice-mini: no model for provider ${provider}`);
                return null;
            }
            // Build message with proper id (dynamic import, fallback to manual).
            let messages;
            try {
                const dshLlm = await import('@deepseek-ai/dsh-llm');
                messages = [dshLlm.createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-voice-mini' } })];
            }
            catch {
                const { randomUUID } = await import('node:crypto');
                messages = [{ id: `dsh-msg-${randomUUID()}`, role: 'user', content: [{ type: 'text', text: prompt }], source: { kind: 'plugin', plugin: 'dsh-voice-mini' } }];
            }
            const buildOpts = (withEffort) => ({
                provider, model, messages,
                system: 'You are a voice assistant summarizer. Keep it to one or two spoken sentences with emotional framing. No code, paths, or markdown.',
                maxTokens: config.summarizeMaxTokens,
                ...(withEffort ? { reasoningEffort: 'off' } : {}),
                purpose: 'voice-mini-summarize',
                signal: controller.signal,
            });
            // ── streaming: enqueue sentences as they arrive, with a 5-char buffer ──
            // Sentence is the cache unit: flush the moment a sentence boundary
            // (。！？.!? or newline) is hit — do NOT hold it for a trailing-char
            // buffer. Waiting for "5 more chars" only delays enqueue, which delays
            // prefetch, which widens the gap between spoken segments. One complete
            // sentence in the cache ⇒ synthesize and play it right away.
            let accumulated = '';
            let fullSpoken = '';
            let firstSent = false;
            const flushSentences = (force) => {
                const re = /[。！？\.\!\?\n]/g;
                let lastCut = 0;
                let match;
                while ((match = re.exec(accumulated)) !== null) {
                    const end = match.index + match[0].length;
                    const sentence = accumulated.slice(lastCut, end);
                    const clean = scrubForSpeech(sentence, pickLocale(config.locale).misc.codeOmitted).trim();
                    if (clean) {
                        if (!firstSent) {
                            firstSent = true;
                            spokeThisTurn = true;
                        }
                        void enqueue('result', clean, sid);
                        fullSpoken += clean + ' ';
                    }
                    lastCut = end;
                }
                accumulated = accumulated.slice(lastCut);
                // End of stream: flush any trailing text that had no terminal boundary.
                if (force && accumulated.trim() !== '') {
                    const clean = scrubForSpeech(accumulated, pickLocale(config.locale).misc.codeOmitted).trim();
                    if (clean) {
                        if (!firstSent) {
                            firstSent = true;
                            spokeThisTurn = true;
                        }
                        void enqueue('result', clean, sid);
                        fullSpoken += clean + ' ';
                    }
                    accumulated = '';
                }
            };
            const streamOnce = async (opts) => {
                let sawText = false;
                let finishReason;
                try {
                    const dshLlm = await import('@deepseek-ai/dsh-llm');
                    assembler = new dshLlm.BlockAssembler();
                    for await (const chunk of llmService.stream(opts)) {
                        const ct = String(chunk.type);
                        if (ct === 'text-delta') {
                            sawText = true;
                            accumulated += String(chunk.text ?? '');
                            flushSentences(false);
                        }
                        else if (ct === 'finish') {
                            finishReason = chunk.reason;
                            ctx.logger.warn(`dsh-voice-mini: verbalizer finish reason=${JSON.stringify(finishReason)}`);
                        }
                        assembler.push(chunk);
                    }
                }
                catch {
                    for await (const chunk of llmService.stream(opts)) {
                        const ct = String(chunk.type);
                        if (ct === 'text-delta') {
                            sawText = true;
                            accumulated += String(chunk.text ?? '');
                            flushSentences(false);
                        }
                        if (ct === 'finish')
                            finishReason = chunk.reason;
                    }
                }
                // Return false if the model rejected reasoningEffort=off (needs retry).
                const msg = typeof finishReason?.failure?.message === 'string' ? finishReason.failure.message : '';
                if (!sawText && msg.includes('does not support reasoning effort'))
                    return false;
                return true;
            };
            // Try with reasoningEffort: 'off' first; retry without if unsupported.
            let ok = await streamOnce(buildOpts(true));
            if (!ok) {
                ctx.logger.warn('dsh-voice-mini: reasoningEffort=off unsupported, retrying without');
                ok = await streamOnce(buildOpts(false));
            }
            // Flush remaining text (stream ended).
            flushSentences(true);
            // Token usage.
            const usage = assembler?._usage;
            const inputTokens = typeof usage?.promptTokens === 'number' ? usage.promptTokens : typeof usage?.inputTokens === 'number' ? usage.inputTokens : undefined;
            const outputTokens = typeof usage?.completionTokens === 'number' ? usage.completionTokens : typeof usage?.outputTokens === 'number' ? usage.outputTokens : undefined;
            ctx.logger.warn(`dsh-voice-mini: verbalizer done textLen=${fullSpoken.length} tokens=${inputTokens ?? '?'}/${outputTokens ?? '?'}`);
            pushMetric({ at: Date.now(), kind: 'verbalizer', success: fullSpoken !== '', llmMs: Date.now() - startedAt, inputTokens, outputTokens, textLen: fullSpoken.length });
            return fullSpoken.trim() || null;
        }
        catch (error) {
            if (controller.signal.aborted)
                ctx.logger.warn('dsh-voice-mini: verbalizer timed out, fallback to template');
            else
                ctx.logger.warn('dsh-voice-mini: verbalizer failed', error);
            return null;
        }
        finally {
            clearTimeout(timer);
        }
    }
    const petToken = loadOrCreateToken();
    // ── live config view ──────────────────────────────────────────────────────
    // Resolution order (low → high):
    //   1. PRESETS[preset]            the gear's bundle
    //   2. composition config         keys the user wrote in cordis.patch.yml
    //   3. settings-panel deltas      panel values that differ from `entry`
    //   4. live override              modal / pet edits (highest)
    //   3 works because the settings layer always returns a FULL object; a value
    //   counts as an edit only when it differs from the composition entry, so an
    //   untouched panel never masks the gear.
    const compositionKeys = Object.keys((rawConfig ?? {}));
    let current = () => entry;
    let settingsSource;
    // Modal/panel edits persist to a plugin-owned JSON file so they survive
    // plugin UPDATES and restarts. The settings-service layer is read-only from
    // the plugin's side (setSource/onChange, no write hook), so the modal can't
    // persist through it — without this file, every `npm update` would wipe the
    // user's palette/locale/preset/chime choices back to the bundle defaults.
    // Tests override the path so they don't clobber the user's real config file.
    const persistedConfigPath = process.env.DSH_VOICE_MINI_CONFIG_FILE ?? join(resolveAudioDir('~/.dsh/voice-mini'), 'config.json');
    const persistedConfigDir = dirname(persistedConfigPath);
    const NO_PERSIST = !!process.env.DSH_VOICE_MINI_NO_PERSIST; // tests: skip file I/O
    const loadPersistedConfig = () => {
        if (NO_PERSIST)
            return {};
        try {
            const obj = JSON.parse(readFileSync(persistedConfigPath, 'utf8'));
            return typeof obj === 'object' && obj !== null ? obj : {};
        }
        catch {
            return {};
        }
    };
    const savePersistedConfig = (cfg) => {
        if (NO_PERSIST)
            return;
        try {
            mkdirSync(persistedConfigDir, { recursive: true });
            writeFileSync(persistedConfigPath, JSON.stringify(cfg, null, 2));
        }
        catch (e) {
            ctx.logger.warn('dsh-voice-mini: failed to persist config', e);
        }
    };
    let persistedConfig = loadPersistedConfig();
    const settingsDelta = () => {
        if (settingsSource === undefined)
            return {};
        const values = settingsSource();
        const delta = {};
        for (const [k, v] of Object.entries(values)) {
            if (v !== entry[k])
                delta[k] = v;
        }
        return delta;
    };
    const resolve = () => {
        const delta = settingsDelta();
        const preset = String(persistedConfig.preset ?? delta.preset ?? entry.preset);
        const base = { ...entry, ...(PRESETS[preset] ?? {}) };
        // Composition-explicit keys outrank the gear, so a hand-written
        // `announceTurnEnd: true` survives a switch to 少量沟通.
        for (const k of compositionKeys)
            base[k] = rawConfig[k];
        return { ...base, ...delta, ...persistedConfig };
    };
    current = resolve;
    installSettingsSection(ctx, 'dsh-voice-mini', Config, entry, {
        setSource: (source) => {
            settingsSource = () => ({ ...entry, ...source() });
            current = resolve;
        },
        onChange: () => {
            current = resolve;
            state.readReplies = current().readReplies;
        },
    });
    /** Apply a modal/panel patch AND persist it to the plugin config file, so
     * the change survives plugin updates and restarts. */
    const applyOverride = (patch) => {
        persistedConfig = { ...persistedConfig, ...patch };
        savePersistedConfig(persistedConfig);
        state.readReplies = current().readReplies;
    };
    const resetOverride = () => {
        persistedConfig = {};
        savePersistedConfig({});
        state.readReplies = current().readReplies;
    };
    /** Whitelist-and-coerce a config patch body; shared by the modal and the pet. */
    const parseConfigPatch = (body) => {
        const patch = {};
        if (typeof body?.preset === 'string' && PRESET_KEYS.includes(body.preset))
            patch.preset = body.preset;
        if (typeof body?.backend === 'string' && ['edge', 'kokoro', 'say', 'fake'].includes(body.backend))
            patch.backend = body.backend;
        if (typeof body?.voiceMode === 'string' && ['per-session', 'fixed'].includes(body.voiceMode))
            patch.voiceMode = body.voiceMode;
        if (Array.isArray(body?.voicePalette)) {
            patch.voicePalette = body.voicePalette.filter((v) => typeof v === 'string' && v.trim() !== '').map((v) => v.trim());
        }
        if (typeof body?.voice === 'string' && body.voice.trim() !== '')
            patch.voice = body.voice.trim();
        if (typeof body?.readReplies === 'boolean')
            patch.readReplies = body.readReplies;
        if (typeof body?.narrationCap === 'number' && Number.isFinite(body.narrationCap)) {
            patch.narrationCap = Math.max(40, Math.min(2000, Math.round(body.narrationCap)));
        }
        if (typeof body?.chimeEnabled === 'boolean')
            patch.chimeEnabled = body.chimeEnabled;
        if (typeof body?.chimeSpeech === 'string' && ['glass', 'ding', 'ping', 'soft', 'none'].includes(body.chimeSpeech))
            patch.chimeSpeech = body.chimeSpeech;
        if (typeof body?.chimeStatus === 'string' && ['glass', 'ding', 'ping', 'soft', 'none'].includes(body.chimeStatus))
            patch.chimeStatus = body.chimeStatus;
        if (typeof body?.ratePct === 'number' && Number.isFinite(body.ratePct)) {
            patch.ratePct = Math.max(-50, Math.min(100, Math.round(body.ratePct)));
        }
        if (typeof body?.volumePct === 'number' && Number.isFinite(body.volumePct)) {
            patch.volumePct = Math.max(-100, Math.min(100, Math.round(body.volumePct)));
        }
        for (const k of [...STATUS_KEYS, 'announceToolCall']) {
            if (typeof body?.[k] === 'boolean')
                patch[k] = body[k];
        }
        if (typeof body?.phraseTurnEnd === 'string') {
            // Empty string is valid — it means "use the locale default".
            patch.phraseTurnEnd = body.phraseTurnEnd.slice(0, 200);
        }
        if (typeof body?.locale === 'string') {
            patch.locale = normalizeLocale(body.locale);
        }
        if (typeof body?.summarizeResult === 'boolean')
            patch.summarizeResult = body.summarizeResult;
        if (typeof body?.summarizeProvider === 'string')
            patch.summarizeProvider = body.summarizeProvider.slice(0, 100);
        if (typeof body?.summarizeModel === 'string')
            patch.summarizeModel = body.summarizeModel.slice(0, 100);
        if (typeof body?.summarizeMaxTokens === 'number' && Number.isFinite(body.summarizeMaxTokens)) {
            patch.summarizeMaxTokens = Math.max(10, Math.min(500, Math.round(body.summarizeMaxTokens)));
        }
        if (typeof body?.summarizeTimeoutMs === 'number' && Number.isFinite(body.summarizeTimeoutMs)) {
            patch.summarizeTimeoutMs = Math.max(1000, Math.min(60000, Math.round(body.summarizeTimeoutMs)));
        }
        // ── Jarvis 联动 config patch ──────────────────────────────────────────
        if (typeof body?.jarvisLinked === 'boolean')
            patch.jarvisLinked = body.jarvisLinked;
        if (typeof body?.jarvisVoice === 'string')
            patch.jarvisVoice = body.jarvisVoice.slice(0, 100);
        if (typeof body?.jarvisSpeechMode === 'string' && ['always', 'normal', 'quiet'].includes(body.jarvisSpeechMode))
            patch.jarvisSpeechMode = body.jarvisSpeechMode;
        if (typeof body?.jarvisVoicemail === 'boolean')
            patch.jarvisVoicemail = body.jarvisVoicemail;
        if (typeof body?.jarvisPersona === 'string')
            patch.jarvisPersona = body.jarvisPersona.slice(0, 2000);
        return patch;
    };
    /** The single JSON shape both the modal and the native pet consume. */
    const snapshot = () => {
        const config = current();
        return {
            version: '0.3.0-prototype',
            ...state,
            ...config,
            queueLength: queue.length,
            pumping,
            paused,
            recent: recent.slice(-15),
            /** The queue visible to the panel (session label + text + kind), so the
             * user can see what's queued + jump to any item. */
            queueView: queue.map((it) => ({ session: it.sessionId, text: it.text, kind: it.kind })),
            /** Whether a cached replay is available for the current session. */
            hasReplay: lastSessionId ? lastBySession.has(lastSessionId) : false,
            /** What a session actually gets: the configured palette or the backend's. */
            effectivePalette: config.voicePalette.length > 0 ? config.voicePalette : [...defaultPalette(config.backend, config.locale)],
            lastSessionId,
            /** The current session's assigned voice (override if re-rolled, else the
             * deterministic hash) — label form, for the "本会话" card. */
            sessionVoice: lastSessionId ? (voiceOverride.has(lastSessionId)
                ? voiceOverride.get(lastSessionId).voice
                : sessionVoiceFor(lastSessionId, { mode: config.voiceMode, voice: config.voice, palette: config.voicePalette, backend: config.backend, locale: config.locale }).voice).replace(/^zh-CN-|Neural$/g, '') : undefined,
            sessionVoiceOverridden: lastSessionId ? voiceOverride.has(lastSessionId) : false,
            disabledSessions: [...disabledSessions],
            chimeUrls: config.chimeEnabled ? {
                speech: `/voice-mini/audio/chime-${config.chimeSpeech}.${chimeFileExt(config.chimeSpeech)}`,
                status: `/voice-mini/audio/chime-${config.chimeStatus}.${chimeFileExt(config.chimeStatus)}`,
            } : null,
        };
    };
    // ── utterance queue (single worker → chime then speech, no overlaps) ──────
    const queue = [];
    let pumping = false;
    /** Paused: the current afplay is killed, the interrupted item is pushed back
     * to the head of the queue, and the worker stops until resume() — so the
     * human can step away to listen to something else, then continue hearing
     * the current line + the rest of the queue. */
    let paused = false;
    /** The item currently being played (or null). Tracked so skip/jump/replay
     * can decide what to do with the interrupted playback. */
    let currentItem = null;
    /** Signal the active utter() that playback was interrupted — 'pause' pushes
     * the item back to the HEAD (replay on resume), 'skip' drops it, 'jump'
     * pushes it to the TAIL (plays later). Set by the routes, read in utter. */
    let interrupt = null;
    /** Per-session cache of the last fully-played utterance (audio path + text +
     * voice). "Replay current session" plays this without re-synthesizing. */
    const lastBySession = new Map();
    /** Synthesis lane: at most one clip is synthesized at a time, but it runs
     * concurrently with the PLAYBACK worker. So while clip N plays, clip N+1 is
     * already synthesizing — the gap between spoken sentences drops from ~1.3s
     * (serial synth) to ~0 (already prefetched). */
    let synthInFlight = 0;
    /** Synthesize one item's text (voice chosen per session, with a fallback to
     * the configured default voice if the chosen one fails — e.g. a voice
     * Microsoft no longer serves via the free endpoint). Returns the clip path
     * plus the voice that actually produced it. */
    async function prefetchSynth(item) {
        const config = current();
        const backend = makeBackend(config.backend);
        const audioDir = resolveAudioDir(config.audioDir);
        // A re-rolled voice (per-session override) beats the deterministic hash;
        // otherwise the hash keeps the same session sounding the same across restarts.
        const choice = (item.sessionId && voiceOverride.has(item.sessionId)
            ? voiceOverride.get(item.sessionId)
            : sessionVoiceFor(item.sessionId, {
                mode: config.voiceMode, voice: config.voice, palette: config.voicePalette, backend: config.backend, locale: config.locale,
            }));
        const attempt = async (voice) => {
            const file = await freshAudioFile(audioDir, extForBackend(backend.id));
            const result = await backend.synthesize(item.text, file, voice, {
                ratePct: config.ratePct + choice.rateJitter,
                volumePct: config.volumePct,
            });
            const size = existsSync(result.path) ? statSync(result.path).size : 0;
            if (size === 0)
                throw new Error(`${backend.id}: synthesis produced an empty file`);
            // Partial-file guard: edge-tts sometimes drops its WebSocket mid-stream
            // and leaves a non-zero but truncated mp3 (sounds like a garbled blip).
            // The size check above misses it, so compare the real duration to a
            // per-char floor calibrated to the voice's language — zh reads ≈4
            // chars/sec, en ≈11 chars/sec (≈2.7× faster). A too-strict zh floor
            // would false-positive on legit English reads (and vice versa). The floor
            // is half the expected duration, so only egregious truncations (<50%)
            // get flagged; legit reads (≈1× the floor) pass.
            const textLen = item.text.replace(/\s/g, '').length;
            const charsPerSec = voice.startsWith('zh') ? 4 : 11;
            const minDur = Math.max(0.4, textLen / (charsPerSec * 2));
            const dur = await audioDurationSec(result.path);
            if (dur > 0 && dur < minDur)
                throw new Error(`${backend.id}: synthesis too short (${dur.toFixed(1)}s for ${textLen} chars — partial file)`);
            return result;
        };
        try {
            const r = await attempt(choice.voice);
            return { path: r.path, ms: r.ms, usedVoice: choice.voice };
        }
        catch (first) {
            // A partial file / timeout is usually a transient WebSocket drop, NOT a
            // broken voice — retry the SAME voice first so the per-session voice is
            // preserved (no mid-turn voice flip). Only if the same voice fails twice
            // do we fall back to the configured default (a voice Microsoft no longer
            // serves). The second failure propagates to pump()'s catch.
            try {
                ctx.logger.warn(`dsh-voice-mini: synth retry (same voice) after "${first instanceof Error ? first.message : String(first)}"`);
                const r = await attempt(choice.voice);
                return { path: r.path, ms: r.ms, usedVoice: choice.voice };
            }
            catch (second) {
                ctx.logger.warn(`dsh-voice-mini: synth fallback ${choice.voice} → ${config.voice} after "${second instanceof Error ? second.message : String(second)}"`);
                const r = await attempt(config.voice);
                return { path: r.path, ms: r.ms, usedVoice: config.voice };
            }
        }
    }
    /** Kick off prefetch for the next not-yet-started speech item, if the synth
     * lane is free. Called on enqueue and on each synth completion so the lane
     * stays busy (pipelining) without fanning out concurrent requests. */
    function maybeSynth() {
        if (paused || synthInFlight >= 1)
            return;
        const item = queue.find((it) => it.kind !== 'chime' && !it.synthStarted);
        if (!item)
            return;
        synthInFlight += 1;
        item.synthStarted = true;
        const p = prefetchSynth(item);
        item.synthPromise = p;
        // Suppress unhandled-rejection if the item is dropped (queue overflow)
        // before the play worker ever awaits it; utter() still re-throws on await.
        p.catch(() => { });
        p.finally(() => { synthInFlight -= 1; maybeSynth(); });
    }
    function enqueue(kind, text, sessionId) {
        return new Promise((resolve) => {
            // Earcon rings once per burst: only when the queue was idle (empty AND
            // not pumping) does this item start a new burst and carry the chime.
            const startsBurst = queue.length === 0 && !pumping;
            // Keep the queue shallow: if > 8 pending, drop the oldest STATUS items
            // (results/tools are awaited by callers; status is fire-and-forget).
            while (queue.length > 8) {
                const idx = queue.findIndex((it) => it.kind === 'status');
                if (idx === -1)
                    break;
                queue.splice(idx, 1)[0].resolve(false);
            }
            queue.push({ kind, text, chime: startsBurst, sessionId, resolve });
            if (kind !== 'chime')
                maybeSynth(); // start synthesis ahead of playback
            void pump();
        });
    }
    async function pump() {
        if (pumping)
            return;
        pumping = true;
        try {
            while (queue.length > 0 && !paused) {
                const item = queue.shift();
                let ok = true;
                try {
                    await utter(item);
                }
                catch (error) {
                    ok = false;
                    state.lastError = error instanceof Error ? error.message : String(error);
                    ctx.logger.warn('dsh-voice-mini: utter failed', error);
                }
                // If utter paused mid-playback it already pushed the item back onto the
                // queue head; don't resolve it (it'll replay on resume) and stop the loop.
                if (paused)
                    break;
                item.resolve(ok);
            }
        }
        finally {
            pumping = false;
        }
    }
    /** Pause: kill the current afplay; the worker re-queues the interrupted
     * item and stops. The queue (incl. the current line) is preserved for resume. */
    function pausePlayback() {
        if (paused)
            return;
        paused = true;
        cancelPlayback(); // resolves the active playAndWait early → utter re-queues
    }
    /** Resume: clear the flag and let the worker replay the interrupted item +
     * drain the rest of the queue. */
    function resumePlayback() {
        if (!paused)
            return;
        paused = false;
        void pump();
    }
    /** Check if the current playback was interrupted (pause/skip/jump). Returns
     * true if utter should bail out — the item is re-queued or dropped depending
     * on the interrupt type. Called after each playAndWait in utter(). */
    const interrupted = (item) => {
        if (interrupt === 'skip') {
            interrupt = null;
            return true;
        } // drop — don't re-queue
        if (interrupt === 'jump') {
            interrupt = null;
            queue.push(item);
            return true;
        } // push to tail — plays later
        if (paused) {
            queue.unshift(item);
            return true;
        } // pause — push to front, pump stops
        return false;
    };
    /** Skip the current item: kill afplay, signal utter to drop it, pump → next. */
    function skipCurrent() { interrupt = 'skip'; cancelPlayback(); void pump(); }
    /** Jump to queue[to]: kill afplay, push the current to tail, move [to] to front. */
    function jumpTo(to) {
        if (to < 0 || to >= queue.length)
            return;
        interrupt = 'jump';
        const target = queue.splice(to, 1)[0];
        queue.unshift(target);
        cancelPlayback();
        void pump();
    }
    /** Replay a session's last fully-played utterance from the cache (one-off,
     * doesn't touch the queue). If something's playing, it's killed first. */
    async function replaySession(sid) {
        if (!sid)
            sid = lastSessionId;
        if (!sid || !lastBySession.has(sid))
            return false;
        cancelPlayback(); // kill current afplay if any
        const cached = lastBySession.get(sid);
        speaking = { kind: 'replay', text: cached.text, startedAt: Date.now(), voice: cached.voice };
        try {
            const config = current();
            const backend = makeBackend(config.backend);
            if (backend.id !== 'fake')
                await playAndWait(cached.path, { volumePct: config.volumePct });
        }
        finally {
            speaking = null;
        }
        return true;
    }
    /** Await the (already-prefetched) clip → earcon → speech. Synthesis runs
     * ahead in the synth lane (see maybeSynth), so by the time playback of clip
     * N finishes, clip N+1 is usually already synthesized — no audible gap. */
    async function utter(item) {
        const config = current();
        currentItem = item;
        // Chime-only items (少量 mode status notices): play the chime, skip
        // synthesis entirely. The chime IS the notification — no speech.
        if (item.kind === 'chime') {
            const chimeSound = config.chimeStatus;
            if (config.chimeEnabled && chimeSound !== 'none') {
                const chime = await writeChimeFile(chimeSound, resolveAudioDir(config.audioDir));
                if (chime !== null)
                    await playAndWait(chime, { timeoutMs: 2_000, volumePct: config.volumePct });
            }
            if (interrupted(item)) {
                currentItem = null;
                return;
            }
            recent.push({ at: Date.now(), kind: 'chime', text: '(提示音)', ms: 0, ok: true });
            if (recent.length > 30)
                recent.splice(0, recent.length - 30);
            ctx.logger.warn('dsh-voice-mini: spoke [chime] (no speech)');
            currentItem = null;
            return;
        }
        const audioDir = resolveAudioDir(config.audioDir);
        const started = Date.now();
        const synth = await (item.synthPromise ?? prefetchSynth(item));
        const voiceLabel = synth.usedVoice.replace(/^zh-CN-|Neural$/g, '');
        state.lastVoice = voiceLabel;
        state.lastMs = synth.ms;
        state.lastError = undefined;
        state.lastUrl = `/voice-mini/audio/${basename(synth.path)}`;
        speaking = { kind: item.kind, text: item.text, startedAt: started, voice: voiceLabel };
        try {
            // ① earcon BEFORE speech — only for speech content (result/tool/test).
            if (item.chime && config.chimeEnabled && config.chimeSpeech !== 'none' && item.kind !== 'status') {
                const chime = await writeChimeFile(config.chimeSpeech, audioDir);
                if (chime !== null)
                    await playAndWait(chime, { timeoutMs: 2_000, volumePct: config.volumePct });
            }
            if (interrupted(item))
                return;
            // ② speech playback (loudness applied here — see playAndWait)
            const backend = makeBackend(config.backend);
            if (backend.id !== 'fake')
                await playAndWait(synth.path, { volumePct: config.volumePct });
            if (interrupted(item))
                return;
            recent.push({ at: started, kind: item.kind, text: item.text, ms: synth.ms, ok: true });
            if (recent.length > 30)
                recent.splice(0, recent.length - 30);
            pushMetric({ at: started, kind: item.kind, sessionId: item.sessionId, ttsMs: synth.ms, totalMs: Date.now() - started, textLen: item.text.length, success: true });
            // Per-session cache: store the last fully-played utterance for replay.
            if (item.sessionId)
                lastBySession.set(item.sessionId, { path: synth.path, text: item.text, voice: voiceLabel, at: Date.now() });
            ctx.logger.warn(`dsh-voice-mini: spoke [${item.kind}] ${cap(item.text, 200)}`);
        }
        finally {
            currentItem = null;
            speaking = null;
        }
    }
    // ── Jarvis auto-detect ────────────────────────────────────────────────────
    // If dsh-harness-jarvis is installed and provides a 'jarvis' service, auto-
    // link: flip jarvisLinked so the Jarvis panel section appears. The user can
    // also toggle it manually (for previewing before jarvis is built).
    ctx.inject(['jarvis'], () => {
        applyOverride({ jarvisLinked: true });
        ctx.logger.warn('dsh-voice-mini: Jarvis service detected — Jarvis panel activated');
    });
    // ── persona (deferred — same race as webServer) ────────────────────────────
    ctx.inject(['systemPrompt'], (promptCtx) => {
        const systemPrompt = promptCtx.get('systemPrompt');
        systemPrompt?.section?.({
            name: 'voice-mini:persona',
            order: 50,
            // Reads through the live config: switching gear re-words the persona
            // without a remount, and turning on 逐字朗读 swaps to the narration
            // persona (which tells the model not to double up with `speak`).
            // When the verbalizer is on, the persona also tells the model that the
            // system handles routine completion summaries — save `speak` for
            // proactive milestones and heads-ups.
            text: () => {
                if (current().readReplies)
                    return PERSONA_NARRATION;
                const base = PERSONA_BY_PRESET[current().preset] ?? PERSONA_BY_PRESET.default;
                return current().summarizeResult
                    ? `${base}\n- The system will summarize your results for the human in its own voice after each turn — you do NOT need to call \`speak\` for routine completion. Save \`speak\` for proactive milestones, decision points, and heads-ups.`
                    : base;
            },
        });
    });
    // ── the speak tool (结果回复, agent-decided) ───────────────────────────────
    ctx.tools.register(defineTool({
        name: 'speak',
        description: 'Speak a short message aloud on the user\'s speaker (a 提示音 plays first). ' +
            'Use it to say — in your own voice — what you would actually tell the person you are working for: ' +
            'the outcome of a step, a decision point, a heads-up worth hearing while they are away from the screen. ' +
            'Say the thing you would say; do NOT read your written reply out. ' +
            'One or two plain sentences, no code/paths/markdown. ' +
            'Returns IMMEDIATELY once the line is queued — playback runs in the background, ' +
            'so your written reply and the speech happen concurrently; do not wait for it.',
        parameters: {
            text: { type: 'string', required: true, description: 'Short plain-prose text to speak.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    status: { type: 'string', required: true },
                    ms: { type: 'number', required: true },
                    url: { type: 'string', required: true },
                    error: { type: 'string', required: true },
                },
            },
            render: (_args, value) => {
                const v = value;
                const line = v.status === 'queued' ? 'Queued for speech (plays in the background).'
                    : v.status === 'spoken' ? `Spoken (${v.ms} ms).`
                        : v.status === 'skipped' ? 'Skipped (voice off for this session).'
                            : `Speak failed: ${v.error ?? ''}`;
                return [{ type: 'text', text: line }];
            },
        },
        isConcurrencySafe: () => true,
        async execute(args, exec) {
            const text = String(args.text ?? '').trim();
            if (text === '')
                throw new Error('speak: text must not be empty');
            const speakSid = exec?.agent?.session?.id;
            // Per-session control: if this session is disabled, the speak tool is a no-op.
            if (speakSid && disabledSessions.has(speakSid)) {
                return { status: 'skipped', ms: 0, url: '', error: 'voice disabled for this session' };
            }
            // BYPASS / fire-and-forget: queue the line for the synth+play pipeline and
            // return IMMEDIATELY. The model's written reply and the speech therefore
            // run concurrently — the reply isn't held hostage behind ~6s of playback.
            // The content is fully in hand the moment the tool is called (args.text),
            // so "content received + review passed + can broadcast" = "enqueued"; that
            // is the success node. Synthesis, the duration/partial-file guard, and the
            // fallback-voice retry all run in the background; the queue still serializes
            // playback (no overlaps). spokeThisTurn is set now so turn/end's template
            // stays quiet (the model did speak this turn, just not yet audibly).
            void enqueue('tool', text, speakSid);
            spokeThisTurn = true;
            return { status: 'queued', ms: 0, url: '', error: '' };
        },
        presentCall(args) {
            const t = String(args?.text ?? '').replaceAll(/\s+/g, ' ').trim();
            return { card: 'generic', title: `Speak: ${t.length > 40 ? `${t.slice(0, 39)}…` : t}`, kind: 'other' };
        },
    }));
    // ── lifecycle listeners: result + status announcements ─────────────────────
    ctx.on('session/event', (session, event) => {
        const config = current();
        const t = pickLocale(config.locale);
        const sid = typeof session?.id === 'string' ? session.id : undefined;
        if (sid)
            lastSessionId = sid;
        // Per-session control: if this session is disabled, skip everything.
        if (sid && disabledSessions.has(sid))
            return;
        const type = event?.type;
        const data = event?.data ?? {};
        switch (type) {
            // 结果回复: full narration of an assistant message (existing logic).
            case 'assistant/message': {
                const content = data?.message?.content;
                if (!Array.isArray(content))
                    return;
                const text = scrubForSpeech(content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text).join(' '), t.misc.codeOmitted);
                // Store for the verbalizer — needed even when readReplies is off.
                if (text !== '')
                    lastReplyText = text;
                if (!config.readReplies && !state.readReplies)
                    return;
                if (text === '')
                    return;
                void enqueue('result', cap(text, config.narrationCap, t.misc.truncatedSuffix), sid);
                return;
            }
            // 进行中回复: status notices.
            case 'approval/asked': {
                const toolName = typeof data?.toolName === 'string' ? data.toolName : t.spoken.fallbackTool;
                // Full detail (tool name + reason) goes to the pet/attention flag so
                // the human can READ it; the spoken line is generic, because command
                // text is unintelligible by ear.
                const detail = `${t.spoken.approvalNeeded}：${toolName}${typeof data?.reason === 'string' && data.reason.trim() !== '' ? `：${cap(data.reason, 80, t.misc.truncatedSuffix)}` : ''}`;
                attention = { kind: 'approval', text: detail };
                if (!config.statusEnabled || !config.announceApproval)
                    return;
                if (!config.statusSpeech) {
                    void enqueue('chime', '', sid);
                    return;
                }
                void enqueue('status', t.spoken.approvalNeeded, sid);
                return;
            }
            case 'approval/decided': {
                // Resolutions ("已批准/已拒绝") are not worth a spoken line — the
                // human just made the decision, they know. Only clear the pet's alert.
                attention = null;
                return;
            }
            case 'tool/call': {
                // New question surfaces as the ask_user_question tool call.
                if (data?.name === 'ask_user_question') {
                    // Don't speak the question text — it's often long and nuanced, hard
                    // to parse by ear. The pet's attention card carries the full text;
                    // the spoken line just says "you have a question".
                    attention = { kind: 'question', text: t.spoken.newQuestion };
                    if (!config.statusEnabled || !config.announceQuestion)
                        return;
                    if (!config.statusSpeech) {
                        void enqueue('chime', '', sid);
                        return;
                    }
                    void enqueue('status', t.spoken.questionPending, sid);
                    return;
                }
                // 即时沟通 also names action-shaped tools — deduped per turn so a long
                // run of the same tool is announced once, not fifty times.
                if (!config.statusEnabled || !config.announceToolCall)
                    return;
                const toolName = typeof data?.name === 'string' ? data.name : '';
                if (!NOTABLE_TOOLS.has(toolName) || announcedTools.has(toolName))
                    return;
                announcedTools.add(toolName);
                if (!config.statusSpeech) {
                    void enqueue('chime', '', sid);
                    return;
                }
                void enqueue('status', t.spoken.executingTool.replace('{tool}', toolName), sid);
                return;
            }
            case 'turn/start': {
                announcedTools.clear();
                spokeThisTurn = false;
                if (!config.statusEnabled || !config.announceTurnStart)
                    return;
                if (!config.statusSpeech) {
                    void enqueue('chime', '', sid);
                    return;
                }
                void enqueue('status', t.spoken.startHandling, sid);
                return;
            }
            case 'turn/end': {
                // Already heard this turn: either the model spoke in its own voice, or
                // 逐字朗读 read the reply out. The template would just repeat it.
                if (spokeThisTurn || config.readReplies)
                    return;
                if (!config.statusEnabled || !config.announceTurnEnd)
                    return;
                // Abnormal end reasons get a specific phrase instead of "已完成".
                // TurnEndReason kinds: completed, aborted, blocked, error, max-tokens, interrupted.
                const reasonKind = typeof data?.reason?.kind === 'string' ? data.reason.kind : 'completed';
                const ABNORMAL = {
                    aborted: t.spoken.aborted,
                    blocked: t.spoken.blocked,
                    error: t.spoken.error,
                    'max-tokens': t.spoken.maxTokens,
                    interrupted: t.spoken.interrupted,
                };
                const abnormal = ABNORMAL[reasonKind];
                if (abnormal) {
                    const title = titleFor(session);
                    if (!config.statusSpeech) {
                        void enqueue('chime', '', sid);
                        return;
                    }
                    void enqueue('status', title ? `${title}：${abnormal}` : abnormal, sid);
                    return;
                }
                // Normal completion — verbalizer pass or template.
                // Verbalizer pass: ask a model to turn the reply into one spoken
                // sentence with emotional framing. Falls back to the template on
                // timeout/error/empty. Runs async so it never blocks the event loop.
                if (config.summarizeResult && lastReplyText) {
                    void (async () => {
                        const spoken = await summarizeReply(lastReplyText, sid);
                        if (spoken)
                            return; // spokeThisTurn set inside, sentences already enqueued
                        // Fallback to template — empty phraseTurnEnd ⇒ locale default
                        const title = titleFor(session);
                        const phrase = (config.phraseTurnEnd !== '' ? config.phraseTurnEnd : t.spoken.phraseTurnEnd)
                            .replace('{title}', title ?? '')
                            .replace(/\s+/g, ' ')
                            .trim();
                        void enqueue('status', phrase || t.spoken.turnCompleted, sid);
                    })();
                    return;
                }
                // Template fallback (summarizeResult off, or no reply text)
                const title = titleFor(session);
                const phrase = (config.phraseTurnEnd !== '' ? config.phraseTurnEnd : t.spoken.phraseTurnEnd)
                    .replace('{title}', title ?? '')
                    .replace(/\s+/g, ' ')
                    .trim();
                void enqueue('status', phrase || t.spoken.turnCompleted, sid);
                return;
            }
            case 'todo/write': {
                if (!config.statusEnabled || !config.announceTodo)
                    return;
                if (!config.statusSpeech) {
                    void enqueue('chime', '', sid);
                    return;
                }
                const todos = Array.isArray(data?.todos) ? data.todos : [];
                const done = todos.filter((it) => it?.status === 'completed').length;
                void enqueue('status', t.spoken.todoProgress.replace('{done}', String(done)).replace('{total}', String(todos.length)), sid);
                return;
            }
            default: return;
        }
    });
    // ── web routes (state / config / toggle / test / chime / audio) ────────────
    // ctx.inject, NOT ctx.get: the webserver fiber boots in parallel with this
    // plugin, so a bare ctx.get('webServer') in apply() races and registers
    // nothing (the popover then 404s and every control looks dead).
    ctx.inject(['webServer'], (serverCtx) => {
        const webServer = serverCtx.get('webServer');
        if (webServer === undefined)
            return;
        // Discovery for the native pet: origin + token in a 0600 file under
        // ~/.dsh/voice-mini (same seam dsh-notch uses). Best-effort — a headless
        // composition without a port still mounts, the pet just can't connect.
        const writePetRuntime = () => {
            try {
                const origin = `http://${webServer.host ?? '127.0.0.1'}:${String(webServer.port ?? '')}`;
                // The Desktop shell 403s every route lacking this capability while
                // ordinary-browser access is off (the user's default), so pass it
                // through to the widget — see src/pet.ts.
                const header = desktopRendererHeader(ctx);
                writeRuntime({
                    origin, token: petToken, pid: process.pid, writtenAt: Date.now(),
                    ...(header ? { rendererHeader: header } : {}),
                });
                ctx.logger.warn(`dsh-voice-mini: pet runtime written (${origin}${header ? ', renderer capability attached' : ', no renderer capability'})`);
            }
            catch (error) {
                ctx.logger.warn('dsh-voice-mini: could not write pet runtime file', error);
            }
        };
        writePetRuntime();
        // The capability may attach after the webserver does (or never, outside
        // the Desktop shell) — rewrite the file when it shows up.
        ctx.inject(['desktopBrowserAccess'], () => writePetRuntime());
        webServer.register({
            kind: 'prefix',
            path: '/voice-mini',
            handler: async (req, res) => {
                const url = (req.url ?? '').replace(/^\/voice-mini/, '').split('?')[0] ?? '/';
                try {
                    if (url === '/state' && req.method === 'GET') {
                        return sendJson(res, 200, snapshot());
                    }
                    // ── provider list: enumerate all registered LLM adapters ──────────────
                    if (url === '/providers' && req.method === 'GET') {
                        try {
                            const adapters = llmService?.adapters;
                            const providers = adapters instanceof Map ? [...adapters.keys()] : [];
                            return sendJson(res, 200, { providers });
                        }
                        catch (e) {
                            return sendJson(res, 200, { providers: [], error: e instanceof Error ? e.message : String(e) });
                        }
                    }
                    // ── model list: fetch available models for a given provider ──────────
                    if (url === '/models' && req.method === 'GET') {
                        try {
                            // Use ?provider= query param, or auto-detect the first adapter.
                            const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams;
                            let provider = query.get('provider') ?? '';
                            if (!provider) {
                                const adapters = llmService?.adapters;
                                if (adapters instanceof Map && adapters.size > 0) {
                                    provider = [...adapters.keys()][0] ?? '';
                                }
                            }
                            if (!provider || !llmService?.listModels) {
                                return sendJson(res, 200, { provider: null, models: [] });
                            }
                            const models = await llmService.listModels(provider);
                            return sendJson(res, 200, { provider, models: models.map((m) => ({ id: m.id, name: m.name ?? m.id })) });
                        }
                        catch (e) {
                            return sendJson(res, 200, { provider: null, models: [], error: e instanceof Error ? e.message : String(e) });
                        }
                    }
                    // ── pet routes: loopback + bearer token (see src/pet.ts) ─────────
                    if (url.startsWith('/pet/')) {
                        if (!isLoopback(req) || !authorized(req, petToken)) {
                            return sendJson(res, 403, { ok: false, error: 'forbidden' });
                        }
                        if (url === '/pet/state' && req.method === 'GET') {
                            const config = current();
                            const last = recent.at(-1) ?? null;
                            return sendJson(res, 200, {
                                ok: true,
                                version: '0.3.0-prototype',
                                speaking: speaking !== null,
                                current: speaking,
                                queued: queue.length,
                                attention: attention?.kind ?? null,
                                attentionText: attention?.text ?? '',
                                last,
                                recent: recent.slice(-15),
                                config: {
                                    readReplies: config.readReplies,
                                    chimeEnabled: config.chimeEnabled,
                                    chimeSpeech: config.chimeSpeech,
                                    chimeStatus: config.chimeStatus,
                                    statusEnabled: config.statusEnabled,
                                    summarizeResult: config.summarizeResult,
                                    backend: config.backend,
                                    voice: config.voice,
                                },
                                lastError: state.lastError ?? null,
                            });
                        }
                        if (url === '/pet/config' && req.method === 'POST') {
                            applyOverride(parseConfigPatch(JSON.parse((await readBody(req)) || '{}')));
                            const config = current();
                            return sendJson(res, 200, {
                                ok: true,
                                config: {
                                    readReplies: config.readReplies,
                                    chimeEnabled: config.chimeEnabled,
                                    chimeSpeech: config.chimeSpeech,
                                    chimeStatus: config.chimeStatus,
                                    statusEnabled: config.statusEnabled,
                                    summarizeResult: config.summarizeResult,
                                    backend: config.backend,
                                    voice: config.voice,
                                },
                            });
                        }
                        if (url === '/pet/test' && req.method === 'POST') {
                            void enqueue('test', pickLocale(current().locale).spoken.testDefault);
                            return sendJson(res, 200, { ok: true });
                        }
                        if (url === '/pet/attention/clear' && req.method === 'POST') {
                            attention = null;
                            return sendJson(res, 200, { ok: true });
                        }
                        return sendJson(res, 404, { ok: false, error: 'not found' });
                    }
                    if (url === '/config' && req.method === 'POST') {
                        const body = JSON.parse((await readBody(req)) || '{}');
                        if (body.reset === true)
                            resetOverride();
                        else
                            applyOverride(parseConfigPatch(body));
                        return sendJson(res, 200, current());
                    }
                    if (url === '/toggle' && req.method === 'POST') {
                        const body = JSON.parse((await readBody(req)) || '{}');
                        const enabled = Boolean(body.enabled);
                        applyOverride({ readReplies: enabled });
                        return sendJson(res, 200, { readReplies: enabled });
                    }
                    // ── per-session voice control ──────────────────────────────────────
                    if (url === '/session-toggle' && req.method === 'POST') {
                        const body = JSON.parse((await readBody(req)) || '{}');
                        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : lastSessionId;
                        if (!sessionId)
                            return sendJson(res, 400, { error: 'no session id' });
                        if (body.enabled === true) {
                            disabledSessions.delete(sessionId);
                        }
                        else if (body.enabled === false) {
                            disabledSessions.add(sessionId);
                        }
                        return sendJson(res, 200, { sessionId, enabled: !disabledSessions.has(sessionId) });
                    }
                    if (url === '/test' && req.method === 'POST') {
                        const body = JSON.parse((await readBody(req)) || '{}');
                        const text = typeof body.text === 'string' && body.text.trim() !== '' ? body.text : pickLocale(current().locale).spoken.testDefault;
                        const ok = await enqueue('test', text);
                        if (!ok)
                            return sendJson(res, 500, { error: state.lastError ?? 'synthesis failed' });
                        return sendJson(res, 200, { ok: true, ms: state.lastMs, url: state.lastUrl });
                    }
                    // ── re-roll this session's voice ──────────────────────────────────────
                    // Pick a fresh random voice (≠ the current one) from the effective
                    // palette, store it as a per-session override (beats the deterministic
                    // hash), then play a sample so the human hears the new voice right away.
                    if (url === '/voice/reroll' && req.method === 'POST') {
                        const body = JSON.parse((await readBody(req)) || '{}');
                        const sessionId = typeof body.sessionId === 'string' ? body.sessionId : lastSessionId;
                        if (!sessionId)
                            return sendJson(res, 400, { ok: false, error: 'no session id' });
                        const config = current();
                        const palette = (config.voicePalette.length > 0 ? config.voicePalette : defaultPalette(config.backend, config.locale))
                            .filter((v) => typeof v === 'string' && v !== '');
                        if (palette.length === 0)
                            return sendJson(res, 200, { ok: false, error: 'empty palette' });
                        const cur = voiceOverride.has(sessionId)
                            ? voiceOverride.get(sessionId).voice
                            : sessionVoiceFor(sessionId, { mode: config.voiceMode, voice: config.voice, palette: config.voicePalette, backend: config.backend, locale: config.locale }).voice;
                        // Anything but the current voice — if the palette has only one, it
                        // can't change, so just re-jitter the rate instead.
                        const others = palette.filter((v) => v !== cur);
                        const newVoice = others.length > 0 ? others[Math.floor(Math.random() * others.length)] : cur;
                        // Same ±6% / 5-step jitter range as sessionVoiceFor, re-randomized.
                        const newJitter = -6 + Math.floor(Math.random() * 5) * 3;
                        voiceOverride.set(sessionId, { voice: newVoice, rateJitter: newJitter });
                        // 试听: enqueue a sample line scoped to this session so it uses the
                        // just-overridden voice.
                        const sample = pickLocale(config.locale).spoken.testDefault;
                        void enqueue('test', sample, sessionId);
                        return sendJson(res, 200, { ok: true, voice: newVoice, voiceLabel: newVoice.replace(/^zh-CN-|Neural$/g, '') });
                    }
                    if (url === '/clear' && req.method === 'POST') {
                        recent.length = 0;
                        metrics.length = 0;
                        return sendJson(res, 200, { ok: true });
                    }
                    // ── pause/resume the playback worker ──────────────────────────────────
                    // Pause kills the current afplay + parks the worker (the interrupted
                    // item is re-queued for replay); resume drains the queue again. The
                    // queue is never cleared, so nothing in it is lost across a pause.
                    if (url === '/pause' && req.method === 'POST') {
                        pausePlayback();
                        return sendJson(res, 200, { ok: true, paused });
                    }
                    if (url === '/resume' && req.method === 'POST') {
                        resumePlayback();
                        return sendJson(res, 200, { ok: true, paused });
                    }
                    // ── skip/jump/replay (queue navigation) ───────────────────────────────
                    if (url === '/skip' && req.method === 'POST') {
                        skipCurrent();
                        return sendJson(res, 200, { ok: true });
                    }
                    if (url === '/jump' && req.method === 'POST') {
                        const body = JSON.parse((await readBody(req)) || '{}');
                        const to = typeof body.to === 'number' ? body.to : Number(body.to);
                        if (Number.isFinite(to)) {
                            jumpTo(Math.max(0, Math.floor(to)));
                            return sendJson(res, 200, { ok: true });
                        }
                        return sendJson(res, 400, { ok: false, error: 'to must be a number' });
                    }
                    if (url === '/replay' && req.method === 'POST') {
                        const body = JSON.parse((await readBody(req)) || '{}');
                        const sid = typeof body.sessionId === 'string' ? body.sessionId : lastSessionId;
                        const ok = await replaySession(sid);
                        return sendJson(res, 200, { ok });
                    }
                    // ── metrics: per-call performance + token + system stats ────────────
                    if (url === '/metrics' && req.method === 'GET') {
                        void sampleSystem(); // refresh system stats
                        const calls = metrics.slice(-50);
                        const totalInput = calls.reduce((s, m) => s + (m.inputTokens ?? 0), 0);
                        const totalOutput = calls.reduce((s, m) => s + (m.outputTokens ?? 0), 0);
                        const verbalizerCalls = calls.filter((m) => m.kind === 'verbalizer');
                        const verbalizerOk = verbalizerCalls.filter((m) => m.success).length;
                        const ttsCalls = calls.filter((m) => m.kind !== 'verbalizer' && m.kind !== 'chime');
                        const ttsFail = ttsCalls.filter((m) => !m.success).length;
                        const byKind = {};
                        for (const m of calls)
                            byKind[m.kind] = (byKind[m.kind] ?? 0) + 1;
                        return sendJson(res, 200, {
                            calls,
                            sys: sysStats,
                            summary: {
                                totalCalls: calls.length,
                                totalInputTokens: totalInput,
                                totalOutputTokens: totalOutput,
                                totalTokens: totalInput + totalOutput,
                                verbalizerCalls: verbalizerCalls.length,
                                verbalizerSuccessRate: verbalizerCalls.length > 0 ? Math.round(verbalizerOk / verbalizerCalls.length * 100) : 100,
                                ttsCalls: ttsCalls.length,
                                ttsFailRate: ttsCalls.length > 0 ? Math.round(ttsFail / ttsCalls.length * 100) : 0,
                                avgTtsMs: ttsCalls.length > 0 ? Math.round(ttsCalls.reduce((s, m) => s + (m.ttsMs ?? 0), 0) / ttsCalls.length) : 0,
                                avgLlmMs: verbalizerCalls.length > 0 ? Math.round(verbalizerCalls.reduce((s, m) => s + (m.llmMs ?? 0), 0) / verbalizerCalls.length) : 0,
                                avgTextLen: calls.length > 0 ? Math.round(calls.reduce((s, m) => s + (m.textLen ?? 0), 0) / calls.length) : 0,
                                byKind,
                            },
                        });
                    }
                    if (url.startsWith('/audio/') && req.method === 'GET') {
                        const audioDir = resolveAudioDir(current().audioDir);
                        const file = join(audioDir, basename(url));
                        if (!file.startsWith(audioDir) || !existsSync(file) || !statSync(file).isFile()) {
                            res.writeHead(404);
                            res.end();
                            return;
                        }
                        res.writeHead(200, { 'content-type': mimeOf(file) });
                        createReadStream(file).pipe(res);
                        return;
                    }
                    res.writeHead(404);
                    res.end();
                }
                catch (error) {
                    sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
                }
            },
        });
        ctx.logger.warn(`dsh-voice-mini: routes mounted at /voice-mini (backend=${current().backend}, voice=${current().voice})`);
    });
    ctx.logger.warn(`dsh-voice-mini: mounted (backend=${entry.backend}, chime=${entry.chimeEnabled ? `${entry.chimeSpeech}/${entry.chimeStatus}` : 'off'}, status=${entry.statusEnabled})`);
}
