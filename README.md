# dsh-voice-mini

> A voice-feedback plugin for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) Desktop. The assistant speaks — in its own voice — about outcomes, decision points, and heads-ups, so you can follow along by ear instead of watching the screen.

[中文文档](./README.zh-CN.md)

## What it does

- **`speak` tool** — the model decides, on its own, what to say aloud (a short line in its own voice, never a read-out of its written reply).
- **readReplies** — narrate assistant messages verbatim (mutually exclusive with `speak`).
- **Verbalizer** — after a turn, a lightweight LLM rewrites the reply into one spoken line with emotional framing ("好消息，测试全过了"); falls back to a template on failure. **Streaming**: spoken sentence-by-sentence as the LLM generates.
- **Status broadcasts** — short spoken notices for `approval/asked`, `ask_user_question`, `turn/start`, `turn/end`, `todo/write`, with **specific phrases for abnormal ends** (aborted / blocked / error / max-tokens / interrupted).
- **Per-session voices** — each session gets a distinct-but-subtle voice (FNV-1a hash → palette index + ±6% rate jitter), so you can tell conversations apart by ear without picking voices by hand.
- **Chimes** — a system-notification-style earcon (the macOS Glass sound, or synthesized ding/ping/soft/none) rings **once per burst, before speech content only**. Quiet mode = chime-only, no speech.
- **Three presets** — 即时 / 默认 / 少量 — bundle the granular toggles into one gear; any single field still overrides.
- **i18n** — full **zh / en** switch for all UI text, spoken phrases, and the verbalizer prompt; auto-detected from the browser locale, overridable from the panel.
- **Monitoring panel** — token / latency / system stats with SVG sparklines and per-kind breakdown.
- **Native floating pet** (macOS) — a Swift `NSPanel` widget that hovers across all Spaces, reads live state from the plugin's loopback-gated `/pet/*` routes, and expands on hover to show the current utterance + pending attention.

## Architecture

```
                          ┌── edge-tts   (default · cloud · zh+en, great)
model ── speak tool ──    ├── kokoro     (local 82M · English only)
                  ├─ synth ┤── say      (macOS offline · Tingting zh)
assistant msg ─ readReplies ┘  └── fake  (wiring tests)
                          │
approval/question/turn/todo events ──┴─► speech queue (single worker) ─► ① chime ② speech
                                   │
session-header SVG icon ──► centered settings modal ─┤
                                   └─► /voice-mini/*  (host routes) + runtime.json (origin+token)
native pet window pet/ ──► /voice-mini/pet/* ──
```

### Who speaks: the assistant vs. a template (core design)

The same event can be handled two ways, kept deliberately separate:

| | Who composes the line | Nature | Used for |
|---|---|---|---|
| **Assistant voice** (default) | the **model itself**, via `speak` in-band, full context | humanized: "the thing you'd say to the person you're working for" | results, progress, milestones |
| **Template broadcast** | host fixed string | mechanical but reliable | **blocking**: approval pending, new question |
| **Verbatim read** (opt-in, default off) | host reads the reply text aloud | script | when you'd rather hear than read |

Principle: **what has the model in the loop (results, progress) → let the model speak; what doesn't (approval, question) → use the template** — the model is waiting on you then, and a mechanical alert fits better.

Three anti-double-speak rules (all tested): model already spoke this turn → the "turn done" template stays silent; model stayed silent → template backs it up; verbatim read on → the reply *is* the speech and the persona tells the model not to also call `speak`.

## Communication presets

| Preset | Speech rate | What it announces |
|---|---|---|
| **即时 Instant** | +18% | every step: start / done / progress / tools |
| **默认 Default** | 0 | one line after delivering a result; alerts on blockers |
| **少量 Quiet** | −5%, −30 vol | only approvals/questions; assistant stays silent (chime-only) |

## TTS backends

| id | Source | Chinese | Notes |
|---|---|---|---|
| `edge` (default) | Microsoft neural voices, cloud | ✅ excellent | free; rate works, volume applied at playback (`afplay -v`) |
| `kokoro` | Kokoro-82M, local | ❌ EN only | child-process isolation sidesteps onnxruntime's abort-trap on Node 26 |
| `say` | macOS `say` | ✅ (Tingting) | offline |
| `fake` | — | — | wiring tests |

## Install (DSH Desktop)

1. Build: `npm run build` (tsc → `lib/`, then esbuild bundles `lib/client.js`).
2. Build the pet (macOS, optional):
   ```
   DEVELOPER_DIR=/Library/Developer/CommandLineTools swift build --package-path pet -c release
   ```
3. Link into a DSH profile via `package.json` (`link:` dependency + bundle entry pointing at `./cordis.patch.yml`), then restart DSH Desktop.

The bundle layer (`cordis.patch.yml`) ships neutral defaults; per-profile overrides go in the profile's own `cordis.patch.yml` (address this row **by id**).

## Configuration

Key fields (all overridable from the settings modal or `POST /voice-mini/config`):

| Field | Default | Purpose |
|---|---|---|
| `preset` | `default` | instant / default / quiet |
| `backend` | `edge` | edge / kokoro / say / fake |
| `voiceMode` | `per-session` | per-session auto-assign or fixed |
| `voicePalette` | `[]` | custom voice pool; empty = engine default (8 zh 4F4M + 2 en) |
| `readReplies` | `false` | narrate messages verbatim |
| `chimeEnabled` / `chimeSpeech` / `chimeStatus` | true / glass / soft | earcon system |
| `statusSpeech` | `true` | quiet preset: chime-only (false) vs. spoken (true) |
| `phraseTurnEnd` | `""` | custom completion phrase; `{title}` = workspace dir name; empty = locale default |
| `locale` | `zh` | zh / en — switches UI, spoken phrases, verbalizer prompt |
| `summarizeResult` / `summarizeProvider` / `summarizeModel` | true / "" / "" | verbalizer pass (empty provider = auto-detect first adapter; empty model = stays on the template phrase until you pick one in the panel) |

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/voice-mini/state` | live snapshot (config + queue + recent + `locale`) |
| GET/POST | `/voice-mini/config` | read / patch config (whitelist + coerce) |
| POST | `/voice-mini/session-toggle` | enable/disable voice for a session |
| POST | `/voice-mini/test` | synthesize + play a test line |
| GET | `/voice-mini/providers` · `/models` | LLM adapter + model enumeration |
| GET | `/voice-mini/metrics` | call ring buffer + system stats |
| GET | `/voice-mini/audio/*` | chime files |
| GET | `/voice-mini/pet/*` | native pet (loopback + bearer token gated) |

## Tests

```
npm test            # smoke: deferred injection, routes, pet auth
npm run test:summarize   # 8 verbalizer paths
npm run test:presets     # 6 preset-resolution cases
npm run test:agency      # 4 "who speaks" rules
npm run test:voices      # per-session determinism + spread
npm run test:i18n        # 21 cases: dict parity + locale switch of spoken phrases
npm run test:pet         # real plugin routes + real native binary
```

## License

MIT — see [LICENSE](./LICENSE).
