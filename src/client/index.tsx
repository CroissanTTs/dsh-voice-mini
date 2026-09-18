/**
 * PROTOTYPE — dsh-voice-mini client half: a speaker icon in the session
 * header opening a settings modal. 设置 on top, 信息 below.
 *
 * @module dsh-voice-mini/client
 */
import React, { useEffect, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { pickLocale, normalizeLocale, LOCALE_IDS, type LocaleDict, type LocaleId } from '../locale/index.ts';

export const inject = ['slots'] as const;

interface SlotRegistry {
  register(meta: { name: string; id: string; order?: number; locale?: string }, component: unknown): void;
  inject(name: string, contributor: () => void): () => void;
}

interface SpokenRecord { at: number; kind: string; text: string; ms: number; ok: boolean; error?: string }
interface State {
  version?: string; preset: string; backend: string; voiceMode: string; voicePalette: string[];
  effectivePalette?: string[]; voice: string; readReplies: boolean; narrationCap?: number;
  ratePct?: number; volumePct?: number; audioDir?: string;
  chimeEnabled: boolean; chimeSpeech: string; chimeStatus: string; statusEnabled: boolean;
  announceApproval: boolean; announceQuestion: boolean; announceTurnStart: boolean;
  announceTurnEnd: boolean; announceTodo: boolean; announceToolCall: boolean;
  phraseTurnEnd?: string;
  summarizeResult?: boolean; summarizeProvider?: string; summarizeModel?: string;
  queueLength?: number; pumping?: boolean; paused?: boolean; lastMs?: number; lastError?: string;
  queueView?: Array<{ session?: string; text: string; kind: string }>;
  hasReplay?: boolean;
  // Jarvis 联动
  jarvisLinked?: boolean; jarvisVoice?: string; jarvisSpeechMode?: string;
  jarvisVoicemail?: boolean; jarvisPersona?: string;
  effectiveJarvisVoice?: string;
  lastUrl?: string; lastVoice?: string; chimeUrls?: { speech: string; status: string } | null; recent?: SpokenRecord[];
  lastSessionId?: string; disabledSessions?: string[];
  /** Current session's assigned voice (label form) + whether it was re-rolled. */
  sessionVoice?: string; sessionVoiceOverridden?: boolean;
  locale?: string;
}

const PRESET_IDS = ['instant', 'default', 'quiet'] as const;

/** Build the preset pill list from the live locale dictionary. */
const presets = (t: LocaleDict) => PRESET_IDS.map((id) => ({
  id,
  name: t.presets[id].name,
  hint: t.presets[id].hint,
}));

const VOICES: Record<string, string[]> = {
  edge: ['zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunyangNeural', 'zh-CN-YunjianNeural', 'en-US-AriaNeural', 'en-US-ChristopherNeural'],
  kokoro: ['af_heart', 'af_alloy', 'bm_fable', 'am_adam'],
  say: ['Tingting', 'Sinji', 'Meijia', 'Samantha'],
  fake: [],
};

/** Verified distinctive voices for the Jarvis assistant — British male (formal,
 * Jarvis-like) for English, deep male for Chinese. All tested to synthesize
 * correctly and handle version numbers (3.0.8 → "three point…" / "三 点 零 点 八"). */
const JARVIS_VOICES = ['en-GB-ThomasNeural', 'en-GB-RyanNeural', 'zh-CN-YunjianNeural'];

const fmtTime = (ms: number): string => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
};

const label = (s: string): string => {
  const m: Record<string, string> = {
    'zh-CN-XiaoxiaoNeural': '晓晓', 'zh-CN-YunyangNeural': '云扬', 'zh-CN-YunjianNeural': '云健',
    'zh-CN-XiaoyiNeural': '晓伊', 'en-US-AriaNeural': 'Aria', 'en-US-AnneNeural': 'Anne', 'en-US-ChristopherNeural': 'Christopher', 'en-US-BrandonNeural': 'Brandon',
    'en-GB-ThomasNeural': 'Thomas (英式)', 'en-GB-RyanNeural': 'Ryan (英式)',
    af_heart: 'Heart', af_alloy: 'Alloy', bm_fable: 'Fable', am_adam: 'Adam',
    Tingting: '婷婷', Sinji: 'Sinji', Meijia: '美佳', Samantha: 'Samantha',
    glass: 'Glass', ding: '叮', ping: 'Ping', soft: '柔', none: '无',
  };
  return m[s] ?? s;
};

// ── style tokens ────────────────────────────────────────────────────────────
// The panel reads the host app's own design tokens (`--dsw-alias-*`, the DSH
// Desktop "dsw" system) so it matches the host's light/dark theme instead of
// imposing a fixed palette. The host never defined `--dsh-bg/--dsh-fg`, which
// is why an older version fell back to a deep-navy `#1a1a2e` that read as
// "off". Fallbacks below mirror the host's *dark* theme (neutral gray, not
// navy) so the panel still looks native when tokens are absent (e.g. tests).
const T = {
  /** Modal surface — an elevated layer above the page base. */
  panel: 'var(--dsw-alias-bg-layer-1, #232323)',
  /** Dim scrim behind the modal. */
  scrim: 'var(--dsw-alias-bg-mask-drop, rgba(0,0,0,.45))',
  /** Primary text. */
  text: 'var(--dsw-alias-label-primary, #ededed)',
  /** Secondary text (row titles). */
  sub: 'var(--dsw-alias-label-secondary, #b0b0b0)',
  /** Hairline border. */
  border: 'var(--dsw-alias-border-default, rgba(255,255,255,.09))',
  /** Hover wash for interactive surfaces. */
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))',
};
// Accent = a HARDCODED readable blue (≈ the DeepSeek brand), NOT the host's
// `--dsw-alias-brand-primary`. That host token is ambiguous: it's the brand
// *text* color, which flips to near-white in dark theme and near-black in
// light — using it as a button FILL made white-on-near-white (invisible).
// A fixed blue guarantees white text is always legible on it.
const A = '77,107,254';     // #4d6bfe as RGB, for rgba() tints
const ACCENT = '#4d6bfe';  // solid brand fill for buttons / active pills
// Semantic status colors (mainstream Tailwind-ish, readable on any surface).
const SEM = { ok: '#4ade80', warn: '#fbbf24', err: '#f87171' };

// A theme-neutral card: a faint neutral overlay (visible on both light and
// dark panels) + the host hairline border, so each section reads as a distinct
// container instead of blending into the panel.
const card: React.CSSProperties = { padding: 14, borderRadius: 12, background: 'rgba(128,128,128,.08)', border: `1px solid ${T.border}`, marginBottom: 10 };
const cardLabel: React.CSSProperties = { fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: T.sub, margin: '0 0 8px 2px' };

function SpeakerIcon({ on, size = 18 }: { on: boolean; size?: number }): React.ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor" stroke="none" />
      <path d="M11 5 6 9H3v6h3l5 4z" />
      {on ? (<><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 5.5a9 9 0 0 1 0 14" /></>) : null}
    </svg>
  );
}

function XIcon(): React.ReactElement {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m18 6-12 12M6 6l12 12" /></svg>;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }): React.ReactElement {
  return (
    <button onClick={() => onChange(!checked)} role="switch" aria-checked={checked} style={{
      position: 'relative', width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
      background: checked ? ACCENT : 'rgba(127,127,127,.3)', transition: 'background .15s',
    }}>
      <span style={{ position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: 8, background: '#fff', transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.3)' }} />
    </button>
  );
}

function Row({ title, children, indent = false }: { title: string; children: React.ReactNode; indent?: boolean }): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 7, marginLeft: indent ? 16 : 0 }}>
      <span style={{ color: T.text, fontSize: 12 }}>{title}</span>
      {children}
    </div>
  );
}

function Select({ value, options, onChange }: { value: string; options: string[]; onChange: (v: string) => void }): React.ReactElement {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} style={{ background: T.hover, color: 'inherit', borderRadius: 6, border: `1px solid ${T.border}`, padding: '4px 8px', fontSize: 12, cursor: 'pointer' }}>
      {options.map((o) => <option key={o} value={o}>{label(o)}</option>)}
      {value && !options.includes(value) ? <option value={value}>{value}</option> : null}
    </select>
  );
}

function Pill({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }): React.ReactElement {
  return (
    <button onClick={onClick} style={{
      padding: '5px 12px', cursor: 'pointer', borderRadius: 6, fontSize: 12, transition: 'all .12s',
      border: active ? `1px solid ${ACCENT}` : `1px solid ${T.border}`,
      background: active ? `rgba(${A},.16)` : 'transparent',
      color: 'inherit', fontWeight: active ? 600 : 400,
    }}>{children}</button>
  );
}

function VoiceMiniAction(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [chimeBusy, setChimeBusy] = useState(false);
  const [rerollBusy, setRerollBusy] = useState(false);
  const [testText, setTestText] = useState('');
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [providers, setProviders] = useState<string[]>([]);
  /** Local draft for the custom-voice-palette textarea; committed on blur so
   * typing a voice ID doesn't fire a config POST per keystroke. */
  const [paletteDraft, setPaletteDraft] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  /** One-shot: guess the user's locale from the browser and sync it to the
   * server, so the server-side verbalizer prompt + spoken phrases match the
   * language the human is actually reading. Skipped if already matching. */
  const localeSynced = useRef(false);

  const refresh = async () => {
    try { const r = await fetch('/voice-mini/state'); if (r.ok) setState(await r.json()); } catch { /* */ }
  };
  const refreshProviders = async () => {
    try { const r = await fetch('/voice-mini/providers'); if (r.ok) { const d = await r.json(); setProviders(d.providers ?? []); } } catch { /* */ }
  };
  const refreshModels = async (provider?: string) => {
    try {
      const url = provider ? `/voice-mini/models?provider=${encodeURIComponent(provider)}` : '/voice-mini/models';
      const r = await fetch(url);
      if (r.ok) { const d = await r.json(); setModels(d.models ?? []); }
    } catch { /* */ }
  };
  const onProviderChange = (p: string) => {
    void setConfig({ summarizeProvider: p });
    void refreshModels(p);
  };

  useEffect(() => {
    void refresh(); void refreshProviders(); void refreshModels();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);
  // Locale: remember the user's choice in localStorage so a refresh (or app
  // restart, which clears the server's live override) RESTores it instead of
  // re-detecting from the browser language and clobbering an explicit pick.
  // Auto-detect from navigator.language runs only on the very first visit.
  useEffect(() => {
    if (localeSynced.current || !state) return;
    localeSynced.current = true;
    const KEY = 'dsh-vm-locale';
    let stored: string | null = null;
    try { stored = localStorage.getItem(KEY); } catch { /* private mode etc. */ }
    if (stored === 'zh' || stored === 'en') {
      if (stored !== normalizeLocale(state.locale)) void setConfig({ locale: stored });
    } else if (typeof navigator !== 'undefined') {
      const detected = normalizeLocale(navigator.language?.startsWith('en') ? 'en' : 'zh');
      try { localStorage.setItem(KEY, detected); } catch { /* */ }
      if (detected !== normalizeLocale(state.locale)) void setConfig({ locale: detected });
    }
  }, [state]);
  // Keep the palette-textarea draft synced with the server's voicePalette,
  // but only when we're not mid-edit (committed on blur). External changes
  // (preset switch, reset) land here and refresh the textarea.
  const paletteDirty = useRef(false);
  useEffect(() => {
    if (paletteDirty.current) return;
    setPaletteDraft((state?.voicePalette ?? []).join('\n'));
  }, [state?.voicePalette]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const setConfig = async (patch: Partial<State>) => {
    setState((s) => s ? { ...s, ...patch } as State : s);
    await fetch('/voice-mini/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) }).catch(() => {});
    void refresh();
  };

  const test = async () => {
    setBusy(true);
    try {
      const r = await fetch('/voice-mini/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(testText ? { text: testText } : {}) });
      const data = await r.json();
      if (r.ok && data.url) new Audio(data.url).play().catch(() => {});
      await refresh();
    } finally { setBusy(false); }
  };

  const previewChime = async (url: string | undefined) => {
    if (!url) return;
    setChimeBusy(true);
    try { await new Audio(url).play().catch(() => {}); } finally { setChimeBusy(false); }
  };
  /** Re-roll this session's voice: the server picks a fresh voice (≠ current),
   * stores it as an override, and enqueues a sample so it auto-plays. */
  const reroll = async () => {
    if (!state?.lastSessionId) return;
    setRerollBusy(true);
    try {
      await fetch('/voice-mini/voice/reroll', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: state.lastSessionId }),
      }).catch(() => {});
      await refresh();
    } finally { setRerollBusy(false); }
  };

  const on = state?.readReplies ?? false;
  const backend = state?.backend ?? 'edge';
  const t = pickLocale(state?.locale);
  const ps = presets(t);

  return (
    <>
      <button title={t.actions.titleAttr} onClick={() => setOpen(true)} style={{
        border: 'none', background: 'transparent', cursor: 'pointer', padding: '4px 6px',
        opacity: on ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', lineHeight: 0,
      }}><SpeakerIcon on={on} /></button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9998, background: T.scrim, backdropFilter: 'blur(2px)' }} />
          <div ref={panelRef} style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 9999,
            width: 480, maxHeight: '80vh', overflow: 'auto',
            background: T.panel, color: T.text,
            border: `1px solid ${T.border}`, borderRadius: 16,
            boxShadow: '0 20px 60px rgba(0,0,0,.45)', padding: 20, fontSize: 13,
          }}>
            {/* header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <span style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
                <SpeakerIcon on={true} size={20} /> {t.actions.header}
                <span style={{ fontWeight: 400, opacity: 0.35, fontSize: 11 }}>{state?.version ?? '…'}</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {(state?.pumping || (state?.queueLength ?? 0) > 0) && (
                  <button onClick={() => void fetch(`/voice-mini/${state?.paused ? 'resume' : 'pause'}`, { method: 'POST' }).then(() => void refresh()).catch(() => {})} style={{
                    padding: '4px 10px', cursor: 'pointer', borderRadius: 6, fontSize: 11, fontWeight: 600,
                    border: `1px solid ${T.border}`, background: state?.paused ? ACCENT : T.hover, color: state?.paused ? '#fff' : 'inherit',
                  }}>{state?.paused ? t.actions.resume : t.actions.pause}</button>
                )}
                {LOCALE_IDS.map((l) => (
                  <Pill key={l} active={normalizeLocale(state?.locale) === l} onClick={() => { try { localStorage.setItem('dsh-vm-locale', l); } catch { /* */ } void setConfig({ locale: l }); }}>{l.toUpperCase()}</Pill>
                ))}
                <button onClick={() => setOpen(false)} style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 4, borderRadius: 6, opacity: 0.5, display: 'inline-flex' }}><XIcon /></button>
              </span>
            </div>

            {/* ── 本会话 ────────────────────────────────────────── */}
            {state?.lastSessionId && (
              <div style={card}>
                <Row title={`${t.rows.perSession}（${state.lastSessionId.slice(0, 8)}…）`}>
                  <Toggle
                    checked={!state.disabledSessions?.includes(state.lastSessionId!)}
                    onChange={(v) => void fetch('/voice-mini/session-toggle', {
                      method: 'POST', headers: { 'content-type': 'application/json' },
                      body: JSON.stringify({ sessionId: state.lastSessionId, enabled: v }),
                    }).then(() => void refresh()).catch(() => {})}
                  />
                </Row>
                <div style={{ fontSize: 10, opacity: 0.35 }}>{t.rows.perSessionHint}</div>
                <Row title={`${t.rows.voice}：${state.sessionVoice ?? '—'}${state.sessionVoiceOverridden ? ' ⟳' : ''}`}>
                  <button onClick={() => void reroll()} disabled={rerollBusy} style={{
                    padding: '4px 10px', cursor: 'pointer', borderRadius: 6, fontSize: 11,
                    border: `1px solid ${T.border}`, background: T.hover, color: 'inherit',
                  }}>{rerollBusy ? '…' : t.actions.rerollVoice}</button>
                </Row>
              </div>
            )}

            {/* ── 档位 ─────────────────────────────────────────── */}
            <div style={card}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                {ps.map((p) => <Pill key={p.id} active={(state?.preset ?? 'default') === p.id} onClick={() => void setConfig({ preset: p.id })}>{p.name}</Pill>)}
              </div>
              <div style={{ fontSize: 11, opacity: 0.45, minHeight: 15 }}>
                {ps.find((p) => p.id === (state?.preset ?? 'default'))?.hint}
              </div>
            </div>

            {/* ── 播报内容 ────────────────────────────────────── */}
            <div style={card}>
              <div style={cardLabel}>{t.cards.broadcast}</div>
              <Row title={t.rows.readReplies}><Toggle checked={on} onChange={(v) => void setConfig({ readReplies: v })} /></Row>
              <Row title={t.rows.statusBroadcast}><Toggle checked={state?.statusEnabled ?? false} onChange={(v) => void setConfig({ statusEnabled: v })} /></Row>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', marginTop: 4 }}>
                <Row title={t.rows.announceApproval}><Toggle checked={state?.announceApproval ?? false} onChange={(v) => void setConfig({ announceApproval: v })} /></Row>
                <Row title={t.rows.announceQuestion}><Toggle checked={state?.announceQuestion ?? false} onChange={(v) => void setConfig({ announceQuestion: v })} /></Row>
                <Row title={t.rows.announceTurnStart}><Toggle checked={state?.announceTurnStart ?? false} onChange={(v) => void setConfig({ announceTurnStart: v })} /></Row>
                <Row title={t.rows.announceTurnEnd}><Toggle checked={state?.announceTurnEnd ?? false} onChange={(v) => void setConfig({ announceTurnEnd: v })} /></Row>
                <div style={{ marginBottom: 4 }}>
                  <input
                    value={state?.phraseTurnEnd ?? ''}
                    onChange={(e) => void setConfig({ phraseTurnEnd: e.target.value })}
                    placeholder={t.rows.phrasePlaceholder}
                    style={{ width: '100%', boxSizing: 'border-box', background: T.hover, color: 'inherit', borderRadius: 5, border: `1px solid ${T.border}`, padding: '4px 8px', fontSize: 11 }}
                  />
                  <div style={{ fontSize: 10, opacity: 0.35, marginTop: 2 }}>{t.rows.phraseHint}</div>
                </div>
                <Row title={t.rows.announceTodo}><Toggle checked={state?.announceTodo ?? false} onChange={(v) => void setConfig({ announceTodo: v })} /></Row>
                <Row title={t.rows.announceToolCall}><Toggle checked={state?.announceToolCall ?? false} onChange={(v) => void setConfig({ announceToolCall: v })} /></Row>
                <div style={{ height: 10 }} />
                <Row title={t.rows.summarizeResult}><Toggle checked={state?.summarizeResult ?? false} onChange={(v) => void setConfig({ summarizeResult: v })} /></Row>
                <div style={{ fontSize: 11, opacity: 0.35, marginBottom: 4 }}>
                  {t.rows.summarizeHint}
                </div>
                {(state?.summarizeResult) && (
                  <>
                    <Row title={t.rows.provider}>
                      <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <select
                          value={state?.summarizeProvider ?? ''}
                          onChange={(e) => void onProviderChange(e.target.value)}
                          style={{ background: T.hover, color: 'inherit', borderRadius: 6, border: `1px solid ${T.border}`, padding: '4px 8px', fontSize: 12, cursor: 'pointer', minWidth: 120 }}
                        >
                          <option value="">{t.rows.providerAuto}</option>
                          {providers.map((p) => <option key={p} value={p}>{p}</option>)}
                          {state?.summarizeProvider && !providers.includes(state.summarizeProvider) && (
                            <option value={state.summarizeProvider}>{state.summarizeProvider}</option>
                          )}
                        </select>
                        <button
                          onClick={() => void refreshProviders()}
                          title={t.rows.refreshProviders}
                          style={{ border: `1px solid ${T.border}`, background: T.hover, color: 'inherit', cursor: 'pointer', borderRadius: 5, padding: '4px 6px', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0 }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-9 9c-2.4 0-4.6-.9-6.3-2.5M3 12a9 9 0 0 1 9-9c2.4 0 4.6.9 6.3 2.5M21 3v6h-6M3 21v-6h6" /></svg>
                        </button>
                      </span>
                    </Row>
                    <div style={{ fontSize: 10, opacity: 0.35, marginBottom: 4 }}>{t.rows.providerHint}</div>
                    <Row title={t.rows.model}>
                      <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                        <select
                          value={state?.summarizeModel ?? ''}
                          onChange={(e) => void setConfig({ summarizeModel: e.target.value })}
                          style={{ background: T.hover, color: 'inherit', borderRadius: 6, border: `1px solid ${T.border}`, padding: '4px 8px', fontSize: 12, cursor: 'pointer', minWidth: 120 }}
                        >
                          {models.length === 0 && <option value={state?.summarizeModel ?? ''}>{state?.summarizeModel ?? '—'}</option>}
                          {models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                          {state?.summarizeModel && !models.some((m) => m.id === state.summarizeModel) && (
                            <option value={state.summarizeModel}>{state.summarizeModel}</option>
                          )}
                        </select>
                        <button
                          onClick={() => void refreshModels(state?.summarizeProvider)}
                          title={t.rows.refreshModels}
                          style={{ border: `1px solid ${T.border}`, background: T.hover, color: 'inherit', cursor: 'pointer', borderRadius: 5, padding: '4px 6px', fontSize: 11, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', lineHeight: 0 }}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-9 9c-2.4 0-4.6-.9-6.3-2.5M3 12a9 9 0 0 1 9-9c2.4 0 4.6.9 6.3 2.5M21 3v6h-6M3 21v-6h6" /></svg>
                        </button>
                      </span>
                    </Row>
                  </>
                )}
              </div>
            </div>

            {/* ── 声音 ────────────────────────────────────────── */}
            <div style={card}>
              <div style={cardLabel}>{t.cards.voice}</div>
              <Row title={t.rows.voiceAssign}>
                <span style={{ display: 'flex', gap: 4 }}>
                  <Pill active={(state?.voiceMode ?? 'per-session') === 'per-session'} onClick={() => void setConfig({ voiceMode: 'per-session' })}>{t.rows.voicePerSession}</Pill>
                  <Pill active={(state?.voiceMode ?? 'per-session') === 'fixed'} onClick={() => void setConfig({ voiceMode: 'fixed' })}>{t.rows.voiceFixed}</Pill>
                </span>
              </Row>
              {(state?.voiceMode ?? 'per-session') === 'per-session' ? (
                <div style={{ marginBottom: 4 }}>
                  <Row title={t.rows.paletteCustom}>
                    <span style={{ display: 'flex', gap: 4 }}>
                      <Pill active={(state?.voicePalette?.length ?? 0) === 0} onClick={() => { paletteDirty.current = false; setPaletteDraft(''); void setConfig({ voicePalette: [] }); }}>{t.rows.paletteDefault}</Pill>
                      <Pill active={(state?.voicePalette?.length ?? 0) > 0} onClick={() => {
                        // Prefill from the effective palette so editing starts from a sane base.
                        const base = state?.effectivePalette ?? [];
                        paletteDirty.current = false;
                        setPaletteDraft(base.join('\n'));
                        void setConfig({ voicePalette: base });
                      }}>{t.rows.paletteCustom}</Pill>
                    </span>
                  </Row>
                  {(state?.voicePalette?.length ?? 0) > 0 ? (
                    <>
                      <textarea
                        value={paletteDraft}
                        onChange={(e) => { paletteDirty.current = true; setPaletteDraft(e.target.value); }}
                        onBlur={() => {
                          paletteDirty.current = false;
                          const list = paletteDraft.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== '');
                          void setConfig({ voicePalette: list });
                        }}
                        placeholder={t.rows.palettePlaceholder}
                        rows={3}
                        style={{ width: '100%', boxSizing: 'border-box', marginTop: 4, background: T.hover, color: 'inherit', borderRadius: 6, border: `1px solid ${T.border}`, padding: '6px 8px', fontSize: 11, fontFamily: 'inherit', resize: 'vertical' }}
                      />
                      <button onClick={() => { paletteDirty.current = false; setPaletteDraft(''); void setConfig({ voicePalette: [] }); }} style={{ marginTop: 4, padding: '3px 8px', cursor: 'pointer', borderRadius: 5, border: `1px solid ${T.border}`, background: 'transparent', color: 'inherit', fontSize: 11 }}>{t.actions.resetPalette}</button>
                    </>
                  ) : (
                    <div style={{ fontSize: 11, opacity: 0.4 }}>
                      {t.rows.palettePrefix}{state?.effectivePalette?.map((v) => label(v)).join(' · ') ?? '…'}
                    </div>
                  )}
                  <div style={{ fontSize: 10, opacity: 0.35, marginTop: 2 }}>{t.rows.paletteHint}</div>
                </div>
              ) : (
                <Row title={t.rows.voice}><Select value={state?.voice ?? ''} options={VOICES[backend] ?? []} onChange={(v) => void setConfig({ voice: v })} /></Row>
              )}
              <Row title={t.rows.backend}><Select value={backend} options={['edge', 'kokoro', 'say', 'fake']} onChange={(v) => void setConfig({ backend: v })} /></Row>
            </div>

            {/* ── 提示音 ──────────────────────────────────────── */}
            <div style={card}>
              <div style={cardLabel}>{t.cards.chime}</div>
              <Row title={t.rows.chimeMaster}><Toggle checked={state?.chimeEnabled ?? false} onChange={(v) => void setConfig({ chimeEnabled: v })} /></Row>
              <Row title={t.rows.chimeSpeech}>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Select value={state?.chimeSpeech ?? 'glass'} options={['glass', 'ding', 'ping', 'soft', 'none']} onChange={(v) => void setConfig({ chimeSpeech: v })} />
                  <Pill active={false} onClick={() => void previewChime(state?.chimeUrls?.speech)}>{chimeBusy ? '…' : t.actions.preview}</Pill>
                </span>
              </Row>
              <Row title={t.rows.chimeStatus}>
                <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Select value={state?.chimeStatus ?? 'soft'} options={['glass', 'ding', 'ping', 'soft', 'none']} onChange={(v) => void setConfig({ chimeStatus: v })} />
                  <Pill active={false} onClick={() => void previewChime(state?.chimeUrls?.status)}>{chimeBusy ? '…' : t.actions.preview}</Pill>
                </span>
              </Row>
            </div>

            {/* ── 试听 ────────────────────────────────────────── */}
            <div style={card}>
              <div style={cardLabel}>{t.cards.test}</div>
              <input value={testText} onChange={(e) => setTestText(e.target.value)} placeholder={t.actions.testPlaceholder} style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8, background: T.hover, color: 'inherit', borderRadius: 6, border: `1px solid ${T.border}`, padding: '6px 10px', fontSize: 12 }} />
              <button onClick={() => void test()} disabled={busy} style={{
                width: '100%', padding: '8px 0', cursor: busy ? 'default' : 'pointer', borderRadius: 8, fontSize: 12, fontWeight: 600,
                border: 'none', color: '#fff', background: busy ? '#52525b' : ACCENT,
              }}>{busy ? t.actions.synthesizing : t.actions.testSpeak}</button>
            </div>

            {/* ── 信息 ──────────────────────────────────────────── */}
            <div style={cardLabel}>{t.cards.info}</div>
            <div style={{ ...card, lineHeight: 1.8 }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', fontSize: 12 }}>
                <span style={{ opacity: 0.4 }}>{t.info.preset}</span><span style={{ opacity: 0.7 }}>{ps.find((p) => p.id === (state?.preset ?? 'default'))?.name ?? '…'}</span>
                <span style={{ opacity: 0.4 }}>{t.info.speechMode}</span><span style={{ opacity: 0.7 }}>{on ? t.info.speechReadReplies : t.info.speechAssistant}</span>
                <span style={{ opacity: 0.4 }}>{t.info.voice}</span><span style={{ opacity: 0.7 }}>{state?.lastVoice ?? '—'}</span>
                <span style={{ opacity: 0.4 }}>{t.info.backend}</span><span style={{ opacity: 0.7 }}>{state?.backend ?? '…'}</span>
                <span style={{ opacity: 0.4 }}>{t.info.rate}</span><span style={{ opacity: 0.7 }}>{(state?.ratePct ?? 0) >= 0 ? '+' : ''}{state?.ratePct ?? 0}%　{t.info.volume} {(state?.volumePct ?? 0) >= 0 ? '+' : ''}{state?.volumePct ?? 0}%</span>
                <span style={{ opacity: 0.4 }}>{t.info.chime}</span><span style={{ opacity: 0.7 }}>{state?.chimeEnabled ? `${label(state?.chimeSpeech ?? '')}/${label(state?.chimeStatus ?? '')}` : t.info.chimeOff}</span>
                <span style={{ opacity: 0.4 }}>{t.info.queue}</span><span style={{ opacity: 0.7 }}>{state?.pumping ? `${state.queueLength ?? 0} ${t.info.queuePlaying}` : `${state?.queueLength ?? 0}`}</span>
                <span style={{ opacity: 0.4 }}>{t.info.lastCall}</span><span style={{ opacity: 0.7 }}>{state?.lastMs !== undefined ? `${state.lastMs} ms` : '—'}</span>
                <span style={{ opacity: 0.4 }}>{t.info.summarize}</span><span style={{ opacity: 0.7 }}>{state?.summarizeResult ? t.info.summarizeModel : t.info.summarizeTemplate}</span>
              </div>
              {state?.lastError && <div style={{ marginTop: 8, color: SEM.err, fontSize: 12 }}>⚠ {state.lastError}</div>}

              <div style={{ marginTop: 10, marginBottom: 4, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', opacity: 0.35 }}>{t.info.recentSpoken}</div>
              <div style={{ maxHeight: 120, overflow: 'auto', fontSize: 11, lineHeight: 1.6 }}>
                {(state?.recent ?? []).length === 0 ? (
                  <div style={{ opacity: 0.3 }}>{t.info.noData}</div>
                ) : (state?.recent ?? []).slice().reverse().map((r, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, padding: '1px 0', opacity: r.ok ? 0.65 : 1 }}>
                    <span style={{ opacity: 0.4, flexShrink: 0 }}>{fmtTime(r.at)}</span>
                    <span style={{ opacity: 0.4, flexShrink: 0, width: 28 }}>{r.kind}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.text}</span>
                  </div>
                ))}
              </div>

              <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
                <button onClick={() => void refresh()} style={{ flex: 1, padding: '6px 0', cursor: 'pointer', borderRadius: 7, border: `1px solid ${T.border}`, background: 'transparent', color: 'inherit', fontSize: 12 }}>{t.actions.refresh}</button>
                <button onClick={async () => { await fetch('/voice-mini/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"reset":true}' }).catch(() => {}); void refresh(); }} style={{ flex: 1, padding: '6px 0', cursor: 'pointer', borderRadius: 7, border: `1px solid ${T.border}`, background: 'transparent', color: 'inherit', fontSize: 12 }}>{t.actions.resetOverrides}</button>
              </div>
            </div>

            <div style={{ opacity: 0.3, fontSize: 11, marginTop: 4 }}>{t.actions.settingsHint}</div>

            {/* ── 队列（可见 + 跳转 + 跳过 + 重播）──────────────────────── */}
            <div style={cardLabel}>{t.cards.queue}</div>
            <div style={card}>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <button onClick={() => void fetch('/voice-mini/skip', { method: 'POST' }).then(() => void refresh()).catch(() => {})} style={{ flex: 1, padding: '5px 0', cursor: 'pointer', borderRadius: 7, border: `1px solid ${T.border}`, background: T.hover, color: 'inherit', fontSize: 12 }}>{t.actions.skip}</button>
                <button onClick={() => void fetch('/voice-mini/replay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: state?.lastSessionId }) }).then(() => void refresh()).catch(() => {})} disabled={!state?.hasReplay} style={{ flex: 1, padding: '5px 0', cursor: state?.hasReplay ? 'pointer' : 'default', borderRadius: 7, border: `1px solid ${T.border}`, background: state?.hasReplay ? T.hover : 'transparent', color: 'inherit', fontSize: 12, opacity: state?.hasReplay ? 1 : 0.3 }}>{t.actions.replay}</button>
              </div>
              <div style={{ maxHeight: 120, overflow: 'auto', fontSize: 11, lineHeight: 1.6 }}>
                {(state?.queueView ?? []).length === 0 ? (
                  <div style={{ opacity: 0.3 }}>{t.info.noData}</div>
                ) : (state?.queueView ?? []).map((q, i) => (
                  <div key={i} style={{ display: 'flex', gap: 6, padding: '1px 0', alignItems: 'center' }}>
                    <button onClick={() => void fetch('/voice-mini/jump', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ to: i }) }).then(() => void refresh()).catch(() => {})} style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 11, lineHeight: 0 }}>▶</button>
                    <span style={{ opacity: 0.4, flexShrink: 0, width: 28 }}>{q.kind}</span>
                    <span style={{ opacity: 0.4, flexShrink: 0 }}>{q.session?.slice(0, 6) ?? '—'}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.text}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Jarvis 助理（联动检测后激活）────────────────────────── */}
            <div style={cardLabel}>{t.cards.jarvis}</div>
            <div style={card}>
              <Row title={t.rows.jarvisLinked}>
                <Toggle checked={state?.jarvisLinked ?? false} onChange={(v) => void setConfig({ jarvisLinked: v })} />
              </Row>
              <div style={{ fontSize: 10, opacity: 0.35 }}>{t.rows.jarvisLinkedHint}</div>
              {state?.jarvisLinked && (
                <>
                  <div style={{ height: 10 }} />
                  <Row title={t.rows.jarvisVoice}>
                    <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      <select value={state?.jarvisVoice ?? ''} onChange={(e) => void setConfig({ jarvisVoice: e.target.value })} style={{ background: T.hover, color: 'inherit', borderRadius: 6, border: `1px solid ${T.border}`, padding: '4px 8px', fontSize: 12, cursor: 'pointer', minWidth: 120 }}>
                        <option value="">{t.rows.providerAuto}</option>
                        {JARVIS_VOICES.map((v) => <option key={v} value={v}>{label(v)}</option>)}
                      </select>
                      <span style={{ fontSize: 10, opacity: 0.4 }}>{label(state?.effectiveJarvisVoice ?? '')}</span>
                    </span>
                  </Row>
                  <div style={{ fontSize: 10, opacity: 0.35, marginBottom: 4 }}>{t.rows.jarvisVoiceHint}</div>
                  <Row title={t.rows.jarvisSpeechMode}>
                    <span style={{ display: 'flex', gap: 4 }}>
                      <Pill active={(state?.jarvisSpeechMode ?? 'normal') === 'always'} onClick={() => void setConfig({ jarvisSpeechMode: 'always' })}>{t.actions.jarvisAlways}</Pill>
                      <Pill active={(state?.jarvisSpeechMode ?? 'normal') === 'normal'} onClick={() => void setConfig({ jarvisSpeechMode: 'normal' })}>{t.actions.jarvisNormal}</Pill>
                      <Pill active={(state?.jarvisSpeechMode ?? 'normal') === 'quiet'} onClick={() => void setConfig({ jarvisSpeechMode: 'quiet' })}>{t.actions.jarvisQuiet}</Pill>
                    </span>
                  </Row>
                  <Row title={t.rows.jarvisVoicemail}><Toggle checked={state?.jarvisVoicemail ?? false} onChange={(v) => void setConfig({ jarvisVoicemail: v })} /></Row>
                  <div style={{ fontSize: 10, opacity: 0.35 }}>{t.rows.jarvisVoicemailHint}</div>
                  <div style={{ height: 6 }} />
                  <div style={cardLabel}>{t.rows.jarvisPersona}</div>
                  <textarea value={state?.jarvisPersona ?? ''} onChange={(e) => void setConfig({ jarvisPersona: e.target.value })} placeholder={t.rows.jarvisPersonaPlaceholder} rows={3} style={{ width: '100%', boxSizing: 'border-box', background: T.hover, color: 'inherit', borderRadius: 6, border: `1px solid ${T.border}`, padding: '6px 8px', fontSize: 11, fontFamily: 'inherit', resize: 'vertical' }} />
                </>
              )}
            </div>

            {/* ── 监控 ────────────────────────────────────────── */}
            <div style={cardLabel}>{t.cards.metrics}</div>
            <MetricsPanel locale={state?.locale} />
          </div>
        </>
      )}
    </>
  );
}

// ── Sparkline: tiny SVG line chart for token/latency trends ────────────────
function Sparkline({ data, max, color, height = 28, noDataLabel }: { data: number[]; max: number; color: string; height?: number; noDataLabel: string }): React.ReactElement {
  if (data.length < 2) return <div style={{ fontSize: 11, opacity: 0.3 }}>{noDataLabel}</div>;
  const w = 200, h = height;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - (Math.min(v, max) / max) * h}`).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <line x1="0" y1={h} x2={w} y2={h} stroke="rgba(127,127,127,.2)" strokeWidth="0.5" />
    </svg>
  );
}

// ── MetricsPanel: token + latency + system monitoring ───────────────────────
interface MetricData {
  calls: Array<{ at: number; kind: string; llmMs?: number; ttsMs?: number; totalMs?: number; inputTokens?: number; outputTokens?: number; textLen?: number; success: boolean }>;
  sys: { cpuUser: number; cpuSystem: number; rssMb: number; heapMb: number; audioMb: number };
  summary: { totalCalls: number; totalInputTokens: number; totalOutputTokens: number; totalTokens: number; verbalizerSuccessRate: number; ttsFailRate: number; avgTtsMs: number; avgLlmMs: number; avgTextLen: number; byKind: Record<string, number> };
}

function MetricsPanel({ locale }: { locale?: string }): React.ReactElement {
  const t = pickLocale(locale);
  const [data, setData] = useState<MetricData | null>(null);
  const refresh = async () => { try { const r = await fetch('/voice-mini/metrics'); if (r.ok) setData(await r.json()); } catch { /* */ } };
  useEffect(() => { void refresh(); const iv = setInterval(refresh, 5000); return () => clearInterval(iv); }, []);

  if (!data) return <div style={{ fontSize: 11, opacity: 0.3 }}>{t.metrics.loading}</div>;
  const s = data.summary;
  const recent = data.calls.slice(-20);
  const tokenData = recent.map((c) => (c.inputTokens ?? 0) + (c.outputTokens ?? 0));
  const llmData = recent.map((c) => c.llmMs ?? 0);
  const maxTokens = Math.max(1, ...tokenData);
  const maxLlm = Math.max(1, ...llmData);

  return (
    <div style={{ ...card, lineHeight: 1.6 }}>
      {/* summary numbers */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, marginBottom: 10, fontSize: 11 }}>
        <div><span style={{ opacity: 0.4 }}>{t.metrics.totalTokens}</span><br /><span style={{ fontWeight: 600 }}>{s.totalTokens}</span></div>
        <div><span style={{ opacity: 0.4 }}>{t.metrics.llmSuccessRate}</span><br /><span style={{ fontWeight: 600, color: s.verbalizerSuccessRate >= 90 ? SEM.ok : SEM.warn }}>{s.verbalizerSuccessRate}%</span></div>
        <div><span style={{ opacity: 0.4 }}>{t.metrics.ttsFailRate}</span><br /><span style={{ fontWeight: 600, color: s.ttsFailRate === 0 ? SEM.ok : SEM.err }}>{s.ttsFailRate}%</span></div>
        <div><span style={{ opacity: 0.4 }}>{t.metrics.avgLlm}</span><br /><span style={{ fontWeight: 600 }}>{s.avgLlmMs}ms</span></div>
        <div><span style={{ opacity: 0.4 }}>{t.metrics.avgTts}</span><br /><span style={{ fontWeight: 600 }}>{s.avgTtsMs}ms</span></div>
        <div><span style={{ opacity: 0.4 }}>{t.metrics.avgTextLen}</span><br /><span style={{ fontWeight: 600 }}>{s.avgTextLen}</span></div>
      </div>

      {/* token sparkline */}
      <div style={{ fontSize: 10, opacity: 0.4, marginBottom: 2 }}>{t.metrics.tokenTrend.replace('{n}', String(tokenData.length))}</div>
      <Sparkline data={tokenData} max={maxTokens} color={`rgba(${A},.85)`} noDataLabel={t.metrics.noSparkData} />
      <div style={{ fontSize: 10, opacity: 0.3, marginTop: 1 }}>in={s.totalInputTokens} / out={s.totalOutputTokens}</div>

      {/* LLM latency sparkline */}
      <div style={{ fontSize: 10, opacity: 0.4, marginTop: 8, marginBottom: 2 }}>{t.metrics.latencyTrend}</div>
      <Sparkline data={llmData} max={maxLlm} color={`${SEM.ok}cc`} height={24} noDataLabel={t.metrics.noSparkData} />

      {/* by-kind breakdown */}
      <div style={{ fontSize: 10, opacity: 0.4, marginTop: 8, marginBottom: 2 }}>{t.metrics.kindDist}</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 11 }}>
        {Object.entries(s.byKind).map(([k, v]) => (
          <span key={k} style={{ opacity: 0.7, background: T.hover, padding: '2px 6px', borderRadius: 4 }}>{k}: {v}</span>
        ))}
      </div>

      {/* system stats */}
      <div style={{ fontSize: 10, opacity: 0.4, marginTop: 8, marginBottom: 2 }}>{t.metrics.sysResource}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6, fontSize: 11 }}>
        <div><span style={{ opacity: 0.4 }}>{t.metrics.cpu}</span><br />{data.sys.cpuUser.toFixed(1)}% / {data.sys.cpuSystem.toFixed(1)}%</div>
        <div><span style={{ opacity: 0.4 }}>{t.metrics.memory}</span><br />{data.sys.rssMb} MB</div>
        <div><span style={{ opacity: 0.4 }}>{t.metrics.audioDisk}</span><br />{data.sys.audioMb} MB</div>
      </div>

      <button onClick={() => void refresh()} style={{ marginTop: 8, width: '100%', padding: '5px 0', cursor: 'pointer', borderRadius: 7, border: `1px solid ${T.border}`, background: 'transparent', color: 'inherit', fontSize: 12 }}>{t.actions.refreshMetrics}</button>
    </div>
  );
}

export function apply(ctx: Context): void {
  const slots = ctx.get('slots') as SlotRegistry | undefined;
  if (slots === undefined) return;
  slots.inject('conversation.session.header.actions', () => {
    slots.register(
      { name: 'conversation.session.header.actions', id: 'voice-mini', order: 30 },
      VoiceMiniAction,
    );
  });
}