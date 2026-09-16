# voice-pet — floating voice widget for dsh-voice-mini

A throwaway prototype: a small always-on-top "pet" that floats on the right edge
of the screen, shows whether the assistant is speaking, and offers quick toggles
for the `dsh-voice-mini` plugin. AppKit + SwiftUI only, no external dependencies.

Window mechanics are copied from [`dsh-notch`](https://github.com/aa2246740/dsh-notch)
(`macos/Sources/Panel.swift`, `main.swift`, `Client.swift`): accessory activation
policy, borderless nonactivating `NSPanel` at `.statusBar` level, HUD blur content
view, and an anchored resize that pins the top-right corner.

## Build

```sh
export DEVELOPER_DIR=/Library/Developer/CommandLineTools
swift build --package-path "/Users/zane/Vibe coding/dsh-plugin-discovery/dsh-voice-mini/pet" -c release
```

Binary: `pet/.build/release/voice-pet`

> Inside a sandboxed DSH session, add `--disable-sandbox` and point the compiler
> caches somewhere writable, because SwiftPM cannot nest its own `sandbox-exec`
> manifest sandbox and `~/Library/Caches` is read-only:
>
> ```sh
> export CLANG_MODULE_CACHE_PATH="$PWD/.clang-cache"
> swift build --package-path "..." -c release --disable-sandbox
> ```
>
> In a normal shell the plain command above works.

## Run

```sh
pet/.build/release/voice-pet
```

No Dock icon, no window in the app switcher. Hover the orb to expand, move away
and it collapses after 0.4s. Quit with `kill`/Ctrl-C (prototype: no menu bar item).

## Headless selftest

```sh
pet/.build/release/voice-pet --selftest
```

Opens no window and never touches `NSApplication`. It resolves the runtime file,
prints whether it exists, then `GET /voice-mini/pet/state` with the bearer token
and pretty-prints the raw JSON.

Exit codes: `0` success · `1` request/decode failure · `2` runtime file missing.

## Runtime file discovery

Default: `~/.dsh/voice-mini/runtime.json`

```json
{ "origin": "http://127.0.0.1:43120", "token": "<hex>", "pid": 12345, "writtenAt": 1789000000000 }
```

Point the pet at a different file (different host, port, or a test fixture):

```sh
DSH_VOICE_PET_RUNTIME_FILE=/tmp/other-runtime.json pet/.build/release/voice-pet
DSH_VOICE_PET_RUNTIME_FILE=/tmp/other-runtime.json pet/.build/release/voice-pet --selftest
```

The file is re-read on every request, so a host restart (new port or token) is
picked up without relaunching the pet. Missing file or failed request ⇒ the orb
turns grey with a `!`, the card shows 未连接 / not connected, and polling keeps
retrying every 0.5s.

## Host contract used

Every request sends `Authorization: Bearer <token>`.

| Method | Path | Body |
| --- | --- | --- |
| GET | `/voice-mini/pet/state` | — (polled every 0.5s) |
| POST | `/voice-mini/pet/config` | `{"readReplies":true}` — any subset |
| POST | `/voice-mini/pet/test` | `{}` |
| POST | `/voice-mini/pet/attention/clear` | `{}` |

Unknown/missing JSON keys decode to "unknown" rather than to "not connected", so
the pet survives a host that grows the payload.

## Files

| File | Role |
| --- | --- |
| `Sources/voice-pet/main.swift` | entry point, `PetAppDelegate` (placement, hover, anchored resize) |
| `Sources/voice-pet/Panel.swift` | `PetPanel` / `PetHostingView` — window mechanics from dsh-notch |
| `Sources/voice-pet/PetModel.swift` | observable state, 0.5s poll, config toggles, actions |
| `Sources/voice-pet/PetView.swift` | orb + expanded card, all drawn with SwiftUI shapes |
| `Sources/voice-pet/Client.swift` | runtime discovery + the four endpoints |
| `Sources/voice-pet/Selftest.swift` | `--selftest` (headless) |

## Visual states

| State | Orb |
| --- | --- |
| idle | blue orb, breathing 1.0↔1.04 over 2.4s, blinks every ~3.4s for 0.12s |
| speaking | brighter cyan, pulsing glow, live 5-bar waveform |
| attention (`attention` set) | amber, small bounce, "o" mouth, `attentionText` in the card |
| not connected / error | grey, dimmed eyes, `!` |

Expanded card (300×260): title `语音宠物 (原型)`, one-line status, last spoken text
(2 lines), the three switches, 试听, and 清空提醒 (only while attention is set).
Collapsed window is 72×72 with a 62pt orb (the extra ring is glow room).

## Deviations from the brief

- Collapsed window is 72×72 (orb 62pt) instead of exactly 64×64, so the glow is
  not clipped by the window bounds.
- Window mask radius is animated between 36 (circle) and 20 (card) via
  `PetPanel.setCornerRadius`; the brief only asked for a rounded mask.
- `resizeAnchored` uses the reference's 60fps timer path only (the macOS 15
  `NSAnimationContext.animate` shortcut was dropped for simplicity).
- `NSHostingView.sizingOptions = []` is set (same as the reference) so Auto Layout
  does not fight the manual frame sizing.