/**
 * dsh-voice-mini client half: a speaker icon in the session header opening
 * a settings modal. Everyday settings first; the read-only status (overview,
 * queue, metrics) sits in a collapsed section at the bottom.
 *
 * @module dsh-voice-mini/client
 */
import React, { useEffect, useRef, useState } from 'react';
import type { Context } from '@deepseek-ai/cordis';
import { pickLocale, normalizeLocale, LOCALE_IDS, type LocaleDict } from '../locale/index.ts';

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
  chimeEnabled: boolean; chimeSpeech: string; chimeStatus: string; statusEnabled: boolean; statusSpeech?: boolean;
  announceApproval: boolean; announceQuestion: boolean; announceTurnStart: boolean;
  announceTurnEnd: boolean; announceTodo: boolean; announceToolCall: boolean;
  phraseTurnEnd?: string;
  summarizeResult?: boolean; summarizeProvider?: string; summarizeModel?: string;
  presetOverrides?: string[];
  queueLength?: number; pumping?: boolean; paused?: boolean; lastMs?: number; lastError?: string;
  queueView?: Array<{ session?: string; text: string; kind: string }>;
  hasReplay?: boolean;
  jarvisLinked?: boolean; jarvisConnected?: boolean; jarvisVoice?: string; effectiveJarvisVoice?: string;
  lastUrl?: string; lastVoice?: string; chimeUrls?: { speech: string; status: string } | null; recent?: SpokenRecord[];
  lastSessionId?: string; disabledSessions?: string[];
  /** Current session's assigned voice (label form) + whether it was re-rolled. */
  sessionVoice?: string; sessionVoiceOverridden?: boolean;
  locale?: string;
}

const PRESET_IDS = ['instant', 'default', 'quiet'] as const;
const BACKENDS = ['edge', 'kokoro', 'say'];
const CHIMES = ['glass', 'ding', 'ping', 'soft', 'none'];

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
// imposing a fixed palette. Fallbacks mirror the host's *dark* theme so the
// panel still looks native when tokens are absent (e.g. tests).
const T = {
  panel: 'var(--dsw-alias-bg-layer-1, #232323)',
  scrim: 'var(--dsw-alias-bg-mask-drop, rgba(0,0,0,.45))',
  text: 'var(--dsw-alias-label-primary, #ededed)',
  sub: 'var(--dsw-alias-label-secondary, #b0b0b0)',
  border: 'var(--dsw-alias-border-default, rgba(255,255,255,.09))',
  hover: 'var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))',
};
// Accent = a HARDCODED readable blue (≈ the DeepSeek brand), NOT the host's
// `--dsw-alias-brand-primary`: that token is the brand *text* color and flips
// to near-white in dark theme, so white-on-it fills became invisible.
const A = '77,107,254';
const ACCENT = '#4d6bfe';
const SEM = { ok: '#4ade80', warn: '#fbbf24', err: '#f87171' };

const card: React.CSSProperties = { padding: '12px 14px', borderRadius: 12, background: 'rgba(128,128,128,.08)', border: `1px solid ${T.border}`, marginBottom: 10 };
const hintStyle: React.CSSProperties = { fontSize: 11, lineHeight: 1.45, color: T.sub, opacity: 0.75, marginTop: 2 };
const field: React.CSSProperties = { background: T.hover, color: 'inherit', borderRadius: 6, border: `1px solid ${T.border}`, padding: '4px 8px', fontSize: 12 };
const plainButton: React.CSSProperties = { ...field, padding: '4px 10px', cursor: 'pointer', fontSize: 11 };

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

function RefreshIcon(): React.ReactElement {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 0 1-9 9c-2.4 0-4.6-.9-6.3-2.5M3 12a9 9 0 0 1 9-9c2.4 0 4.6.9 6.3 2.5M21 3v6h-6M3 21v-6h6" /></svg>;
}

function Chevron({ open }: { open: boolean }): React.ReactElement {
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }}><path d="m9 6 6 6-6 6" /></svg>;
}

function Toggle({ checked, onChange, disabled = false }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }): React.ReactElement {
  return (
    <button onClick={() => onChange(!checked)} role="switch" aria-checked={checked} disabled={disabled} style={{
      position: 'relative', width: 36, height: 20, flexShrink: 0, borderRadius: 10, border: 'none', cursor: disabled ? 'default' : 'pointer',
      background: checked ? ACCENT : 'rgba(127,127,127,.3)', transition: 'background .15s',
    }}>
      <span style={{ position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16, borderRadius: 8, background: '#fff', transition: 'left .15s', boxShadow: '0 1px 3px rgba(0,0,0,.3)' }} />
    </button>
  );
}

/** A title (plus an optional "when does this act" hint) on the left, its control on the right. */
function Row({ title, hint, children, indent = false, disabled = false }: {
  title: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode; indent?: boolean; disabled?: boolean;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '6px 0', marginLeft: indent ? 14 : 0, opacity: disabled ? 0.45 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ color: T.text, fontSize: 12.5, lineHeight: '20px' }}>{title}</div>
        {hint ? <div style={hintStyle}>{hint}</div> : null}
      </div>
      {children ? <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, minHeight: 20 }}>{children}</div> : null}
    </div>
  );
}

function Card({ title, aside, children }: { title?: string; aside?: React.ReactNode; children: React.ReactNode }): React.ReactElement {
  return (
    <section style={card}>
      {title ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', color: T.sub }}>{title}</span>
          {aside}
        </div>
      ) : null}
      {children}
    </section>
  );
}

function Select({ value, options, onChange, disabled = false, render = label }: {
  value: string; options: string[]; onChange: (v: string) => void; disabled?: boolean; render?: (v: string) => string;
}): React.ReactElement {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)} style={{ ...field, cursor: disabled ? 'default' : 'pointer', maxWidth: 170 }}>
      {options.map((o) => <option key={o} value={o}>{render(o)}</option>)}
      {value && !options.includes(value) ? <option value={value}>{value}</option> : null}
    </select>
  );
}

/** One-of-N buttons joined into a single control. */
function Segmented<V extends string>({ value, options, onChange }: {
  value: V; options: ReadonlyArray<{ id: V; label: string }>; onChange: (v: V) => void;
}): React.ReactElement {
  return (
    <span style={{ display: 'inline-flex', padding: 2, borderRadius: 8, background: 'rgba(127,127,127,.14)', gap: 2 }}>
      {options.map((o) => {
        const active = o.id === value;
        return (
          <button key={o.id} onClick={() => onChange(o.id)} aria-pressed={active} style={{
            padding: '4px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12,
            background: active ? ACCENT : 'transparent', color: active ? '#fff' : 'inherit', fontWeight: active ? 600 : 400,
            transition: 'background .12s',
          }}>{o.label}</button>
        );
      })}
    </span>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }): React.ReactElement {
  return (
    <button onClick={onClick} title={title} aria-label={title} style={{ ...field, padding: '5px 6px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', lineHeight: 0 }}>{children}</button>
  );
}

function VoiceMiniAction(): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<State | null>(null);
  const [busy, setBusy] = useState(false);
  const [chimeBusy, setChimeBusy] = useState(false);
  const [rerollBusy, setRerollBusy] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [testText, setTestText] = useState('');
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [providers, setProviders] = useState<string[]>([]);
  /** Local drafts committed on blur, so typing doesn't POST per keystroke. */
  const [paletteDraft, setPaletteDraft] = useState('');
  const [phraseDraft, setPhraseDraft] = useState<string | null>(null);
  /** One-shot: guess the user's locale from the browser and sync it to the
   * server, so spoken phrases match the language the human is reading. */
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
  const post = (path: string, body?: unknown) => fetch(`/voice-mini/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(() => void refresh()).catch(() => {});

  useEffect(() => {
    void refresh(); void refreshProviders(); void refreshModels();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, []);
  // Locale: remember the user's choice in localStorage so a refresh (or app
  // restart, which clears the server's live override) restores it instead of
  // re-detecting from the browser language. Auto-detect runs on first visit only.
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
  // Keep the palette draft synced with the server unless mid-edit.
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
    try { await post('voice/reroll', { sessionId: state.lastSessionId }); } finally { setRerollBusy(false); }
  };

  const t: LocaleDict = pickLocale(state?.locale);
  const sid = state?.lastSessionId;
  const sessionOn = !sid || !state?.disabledSessions?.includes(sid);
  const preset = (state?.preset ?? 'default') as typeof PRESET_IDS[number];
  const readReplies = state?.readReplies ?? false;
  const events = state?.statusEnabled ?? false;
  const turnEnd = events && (state?.announceTurnEnd ?? false);
  const perSession = (state?.voiceMode ?? 'per-session') === 'per-session';
  const customPalette = (state?.voicePalette?.length ?? 0) > 0;
  const backend = state?.backend ?? 'edge';
  const edited = state?.presetOverrides?.length ?? 0;

  const eventRow = (key: 'announceApproval' | 'announceQuestion' | 'announceTurnStart' | 'announceTodo' | 'announceToolCall') => (
    <Row key={key} indent disabled={!events} title={t.rows[key]} hint={t.rows[`${key}Hint` as const]}>
      <Toggle checked={state?.[key] ?? false} disabled={!events} onChange={(v) => void setConfig({ [key]: v })} />
    </Row>
  );

  return (
    <>
      <button title={t.actions.titleAttr} onClick={() => setOpen(true)} style={{
        border: 'none', background: 'transparent', cursor: 'pointer', padding: '4px 6px',
        opacity: sessionOn ? 1 : 0.5, display: 'inline-flex', alignItems: 'center', lineHeight: 0,
      }}><SpeakerIcon on={sessionOn} /></button>

      {open && (
        <>
          <div onClick={() => setOpen(false)} style={{ position: 'fixed', inset: 0, zIndex: 9998, background: T.scrim, backdropFilter: 'blur(2px)' }} />
          <div role="dialog" aria-label={t.actions.header} style={{
            position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', zIndex: 9999,
            width: 500, maxHeight: '84vh', display: 'flex', flexDirection: 'column',
            background: T.panel, color: T.text, border: `1px solid ${T.border}`, borderRadius: 16,
            boxShadow: '0 20px 60px rgba(0,0,0,.45)', fontSize: 13, overflow: 'hidden',
          }}>
            {/* header stays put while the body scrolls */}
            <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '14px 18px', borderBottom: `1px solid ${T.border}` }}>
              <span style={{ fontWeight: 700, fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
                <SpeakerIcon on={true} size={20} /> {t.actions.header}
                <span style={{ fontWeight: 400, opacity: 0.35, fontSize: 11 }}>{state?.version ?? '…'}</span>
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {(state?.pumping || (state?.queueLength ?? 0) > 0) && (
                  <button onClick={() => void post(state?.paused ? 'resume' : 'pause')} style={{
                    ...plainButton, fontWeight: 600,
                    background: state?.paused ? ACCENT : T.hover, color: state?.paused ? '#fff' : 'inherit',
                  }}>{state?.paused ? t.actions.resume : t.actions.pause}</button>
                )}
                <Segmented
                  value={normalizeLocale(state?.locale)}
                  options={LOCALE_IDS.map((l) => ({ id: l, label: l.toUpperCase() }))}
                  onChange={(l) => { try { localStorage.setItem('dsh-vm-locale', l); } catch { /* */ } void setConfig({ locale: l }); }}
                />
                <button onClick={() => setOpen(false)} title={t.actions.close} aria-label={t.actions.close} style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 4, borderRadius: 6, opacity: 0.55, display: 'inline-flex' }}><XIcon /></button>
              </span>
            </header>

            <div style={{ overflow: 'auto', padding: '14px 18px 16px' }}>
              {/* ── 本会话 ── */}
              {sid && (
                <Card title={t.cards.session} aside={<span style={{ fontSize: 10, opacity: 0.4, fontFamily: 'ui-monospace, monospace' }}>{sid.slice(0, 8)}</span>}>
                  <Row title={t.rows.perSession} hint={t.rows.perSessionHint}>
                    <Toggle checked={sessionOn} onChange={(v) => void post('session-toggle', { sessionId: sid, enabled: v })} />
                  </Row>
                  <Row disabled={!sessionOn} title={<>{t.rows.sessionVoice}<b style={{ fontWeight: 600 }}>{state?.sessionVoice ?? '—'}</b>{state?.sessionVoiceOverridden ? ' ⟳' : ''}</>}>
                    <button onClick={() => void reroll()} disabled={rerollBusy} style={plainButton}>{rerollBusy ? '…' : t.actions.rerollVoice}</button>
                  </Row>
                </Card>
              )}

              {/* ── 档位 ── */}
              <Card title={t.cards.preset}>
                <div style={{ padding: '4px 0 2px' }}>
                  <Segmented value={preset} options={PRESET_IDS.map((id) => ({ id, label: t.presets[id].name }))} onChange={(id) => void setConfig({ preset: id })} />
                </div>
                <div style={hintStyle}>{t.presets[preset]?.hint}</div>
                {edited > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginTop: 8, padding: '6px 10px', borderRadius: 8, background: `${SEM.warn}14`, fontSize: 11.5 }}>
                    <span style={{ color: SEM.warn }}>{t.presets.customized.replace('{n}', String(edited))}</span>
                    <button onClick={() => void setConfig({ preset })} style={{ ...plainButton, background: 'transparent' }}>{t.presets.restore}</button>
                  </div>
                )}
              </Card>

              {/* ── 说话方式 ── */}
              <Card title={t.cards.speaking}>
                <Row
                  title={t.rows.speechMode}
                  hint={readReplies ? t.rows.speechReadHint.replace('{cap}', String(state?.narrationCap ?? 300)) : t.rows.speechSelfHint}
                >
                  <Segmented
                    value={readReplies ? 'read' : 'self'}
                    options={[{ id: 'self', label: t.rows.speechSelf }, { id: 'read', label: t.rows.speechRead }]}
                    onChange={(v) => void setConfig({ readReplies: v === 'read' })}
                  />
                </Row>
              </Card>

              {/* ── 事件提醒 ── */}
              <Card title={t.cards.events}>
                <Row title={t.rows.eventsMaster} hint={events && state?.statusSpeech === false ? t.rows.eventsChimeOnly : t.rows.eventsMasterHint}>
                  <Toggle checked={events} onChange={(v) => void setConfig({ statusEnabled: v })} />
                </Row>
                {eventRow('announceApproval')}
                {eventRow('announceQuestion')}
                {eventRow('announceTurnStart')}
                <Row indent disabled={!events} title={t.rows.announceTurnEnd} hint={t.rows.announceTurnEndHint}>
                  <Toggle checked={state?.announceTurnEnd ?? false} disabled={!events} onChange={(v) => void setConfig({ announceTurnEnd: v })} />
                </Row>
                {turnEnd && (
                  <div style={{ marginLeft: 28, paddingLeft: 12, borderLeft: `2px solid ${T.border}`, marginBottom: 4 }}>
                    {readReplies ? (
                      <div style={{ ...hintStyle, padding: '4px 0' }}>{t.rows.summarizeOffByRead}</div>
                    ) : (
                      <>
                        <Row title={t.rows.summarizeResult} hint={t.rows.summarizeHint}>
                          <Toggle checked={state?.summarizeResult ?? false} onChange={(v) => void setConfig({ summarizeResult: v })} />
                        </Row>
                        {state?.summarizeResult && (
                          <>
                            <Row title={t.rows.provider} hint={t.rows.providerHint}>
                              <Select
                                value={state?.summarizeProvider ?? ''}
                                options={['', ...providers]}
                                render={(p) => p === '' ? t.rows.providerAuto : p}
                                onChange={(p) => { void setConfig({ summarizeProvider: p }); void refreshModels(p); }}
                              />
                              <IconButton title={t.rows.refreshProviders} onClick={() => void refreshProviders()}><RefreshIcon /></IconButton>
                            </Row>
                            <Row title={t.rows.model}>
                              <Select
                                value={state?.summarizeModel ?? ''}
                                options={models.map((m) => m.id)}
                                render={(id) => models.find((m) => m.id === id)?.name ?? (id || '—')}
                                onChange={(m) => void setConfig({ summarizeModel: m })}
                              />
                              <IconButton title={t.rows.refreshModels} onClick={() => void refreshModels(state?.summarizeProvider)}><RefreshIcon /></IconButton>
                            </Row>
                          </>
                        )}
                        <div style={{ padding: '6px 0' }}>
                          <input
                            value={phraseDraft ?? state?.phraseTurnEnd ?? ''}
                            onChange={(e) => setPhraseDraft(e.target.value)}
                            onBlur={() => { if (phraseDraft !== null) void setConfig({ phraseTurnEnd: phraseDraft }); setPhraseDraft(null); }}
                            placeholder={t.rows.phrasePlaceholder}
                            style={{ ...field, width: '100%', boxSizing: 'border-box' }}
                          />
                          <div style={hintStyle}>{t.rows.phraseHint}</div>
                        </div>
                      </>
                    )}
                  </div>
                )}
                {eventRow('announceTodo')}
                {eventRow('announceToolCall')}
              </Card>

              {/* ── 声音 ── */}
              <Card title={t.cards.voice}>
                <Row title={t.rows.backend} hint={t.rows.backendHint}>
                  <Select value={backend} options={BACKENDS} onChange={(v) => void setConfig({ backend: v })} />
                </Row>
                <Row title={t.rows.voiceAssign} hint={perSession ? t.rows.voiceAssignHint : undefined}>
                  <Segmented
                    value={perSession ? 'per-session' : 'fixed'}
                    options={[{ id: 'per-session', label: t.rows.voicePerSession }, { id: 'fixed', label: t.rows.voiceFixed }]}
                    onChange={(v) => void setConfig({ voiceMode: v })}
                  />
                </Row>
                {perSession ? (
                  <>
                    <Row title={t.rows.palette} hint={customPalette ? undefined : `${t.rows.palettePrefix}${state?.effectivePalette?.map((v) => label(v)).join(' · ') ?? '…'}`}>
                      <Segmented
                        value={customPalette ? 'custom' : 'default'}
                        options={[{ id: 'default', label: t.rows.paletteDefault }, { id: 'custom', label: t.rows.paletteCustom }]}
                        onChange={(v) => {
                          // Custom starts from the effective palette so editing has a sane base.
                          const list = v === 'custom' ? state?.effectivePalette ?? [] : [];
                          paletteDirty.current = false;
                          setPaletteDraft(list.join('\n'));
                          void setConfig({ voicePalette: list });
                        }}
                      />
                    </Row>
                    {customPalette && (
                      <textarea
                        value={paletteDraft}
                        onChange={(e) => { paletteDirty.current = true; setPaletteDraft(e.target.value); }}
                        onBlur={() => {
                          paletteDirty.current = false;
                          void setConfig({ voicePalette: paletteDraft.split(/[\n,]/).map((s) => s.trim()).filter((s) => s !== '') });
                        }}
                        placeholder={t.rows.palettePlaceholder}
                        rows={3}
                        style={{ ...field, width: '100%', boxSizing: 'border-box', margin: '2px 0 6px', padding: '6px 8px', fontSize: 11, fontFamily: 'inherit', resize: 'vertical' }}
                      />
                    )}
                  </>
                ) : (
                  <Row title={t.rows.voice}>
                    <Select value={state?.voice ?? ''} options={VOICES[backend] ?? []} onChange={(v) => void setConfig({ voice: v })} />
                  </Row>
                )}
              </Card>

              {/* ── 提示音 ── */}
              <Card title={t.cards.chime}>
                <Row title={t.rows.chimeMaster} hint={t.rows.chimeMasterHint}>
                  <Toggle checked={state?.chimeEnabled ?? false} onChange={(v) => void setConfig({ chimeEnabled: v })} />
                </Row>
                {(['chimeSpeech', 'chimeStatus'] as const).map((key) => (
                  <Row key={key} indent disabled={!state?.chimeEnabled} title={t.rows[key]}>
                    <Select value={state?.[key] ?? 'soft'} options={CHIMES} onChange={(v) => void setConfig({ [key]: v })} />
                    <button onClick={() => void previewChime(key === 'chimeSpeech' ? state?.chimeUrls?.speech : state?.chimeUrls?.status)} style={plainButton}>{chimeBusy ? '…' : t.actions.preview}</button>
                  </Row>
                ))}
              </Card>

              {/* ── 贾维斯 ── */}
              {(state?.jarvisConnected || state?.jarvisLinked) && (
                <Card title={t.cards.jarvis}>
                  <Row title={t.rows.jarvisState}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <span style={{ width: 7, height: 7, borderRadius: 4, background: state?.jarvisConnected ? SEM.ok : 'rgba(127,127,127,.5)' }} />
                      {state?.jarvisConnected ? t.rows.jarvisConnected : t.rows.jarvisDisconnected}
                    </span>
                  </Row>
                  <Row title={t.rows.jarvisVoice} hint={t.rows.jarvisVoiceHint}>
                    <Select
                      value={state?.jarvisVoice ?? ''}
                      options={['', ...JARVIS_VOICES]}
                      render={(v) => v === '' ? `${t.rows.jarvisVoiceAuto}（${label(state?.effectiveJarvisVoice ?? '')}）` : label(v)}
                      onChange={(v) => void setConfig({ jarvisVoice: v })}
                    />
                  </Row>
                </Card>
              )}

              {/* ── 试听 ── */}
              <Card title={t.cards.test}>
                <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
                  <input value={testText} onChange={(e) => setTestText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !busy) void test(); }} placeholder={t.actions.testPlaceholder} style={{ ...field, flex: 1, padding: '6px 10px' }} />
                  <button onClick={() => void test()} disabled={busy} style={{
                    padding: '6px 14px', cursor: busy ? 'default' : 'pointer', borderRadius: 8, fontSize: 12, fontWeight: 600,
                    border: 'none', color: '#fff', background: busy ? '#52525b' : ACCENT, whiteSpace: 'nowrap',
                  }}>{busy ? t.actions.synthesizing : t.actions.testSpeak}</button>
                </div>
              </Card>

              {/* ── 运行状态（默认收起）── */}
              <button onClick={() => setStatusOpen((v) => !v)} aria-expanded={statusOpen} style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%', padding: '8px 2px', border: 'none', background: 'transparent',
                color: T.sub, cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
              }}>
                <Chevron open={statusOpen} /> {t.cards.status}
                {state?.lastError && <span style={{ color: SEM.err, fontWeight: 400 }}>· ⚠</span>}
              </button>
              {statusOpen && (
                <>
                  <Card title={t.cards.info}>
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 14px', fontSize: 12, lineHeight: 1.6 }}>
                      <span style={{ opacity: 0.45 }}>{t.info.preset}</span><span>{t.presets[preset]?.name ?? '…'}</span>
                      <span style={{ opacity: 0.45 }}>{t.info.speechMode}</span><span>{readReplies ? t.info.speechReadReplies : t.info.speechAssistant}</span>
                      <span style={{ opacity: 0.45 }}>{t.info.summarize}</span><span>{readReplies || !turnEnd ? t.info.off : state?.summarizeResult ? t.info.summarizeModel : t.info.summarizeTemplate}</span>
                      <span style={{ opacity: 0.45 }}>{t.info.voice}</span><span>{state?.lastVoice ?? '—'}</span>
                      <span style={{ opacity: 0.45 }}>{t.info.backend}</span><span>{state?.backend ?? '…'}</span>
                      <span style={{ opacity: 0.45 }}>{t.info.rate}</span><span>{(state?.ratePct ?? 0) >= 0 ? '+' : ''}{state?.ratePct ?? 0}%　{t.info.volume} {(state?.volumePct ?? 0) >= 0 ? '+' : ''}{state?.volumePct ?? 0}%</span>
                      <span style={{ opacity: 0.45 }}>{t.info.chime}</span><span>{state?.chimeEnabled ? `${label(state?.chimeSpeech ?? '')} / ${label(state?.chimeStatus ?? '')}` : t.info.off}</span>
                      <span style={{ opacity: 0.45 }}>{t.info.lastCall}</span><span>{state?.lastMs !== undefined ? `${state.lastMs} ms` : '—'}</span>
                    </div>
                    {state?.lastError && <div style={{ marginTop: 8, color: SEM.err, fontSize: 12 }}>⚠ {state.lastError}</div>}
                    <div style={{ ...hintStyle, marginTop: 10, marginBottom: 4 }}>{t.info.recentSpoken}</div>
                    <div style={{ maxHeight: 120, overflow: 'auto', fontSize: 11, lineHeight: 1.6 }}>
                      {(state?.recent ?? []).length === 0 ? (
                        <div style={{ opacity: 0.4 }}>{t.info.noData}</div>
                      ) : (state?.recent ?? []).slice().reverse().map((r, i) => (
                        <div key={i} style={{ display: 'flex', gap: 8, padding: '1px 0', color: r.ok ? undefined : SEM.err }}>
                          <span style={{ opacity: 0.45, flexShrink: 0 }}>{fmtTime(r.at)}</span>
                          <span style={{ opacity: 0.45, flexShrink: 0, width: 36 }}>{r.kind}</span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: r.ok ? 0.75 : 1 }}>{r.text}</span>
                        </div>
                      ))}
                    </div>
                  </Card>

                  <Card title={t.cards.queue} aside={<span style={{ fontSize: 11, opacity: 0.5 }}>{state?.queueLength ?? 0}{state?.pumping ? ` ${t.info.queuePlaying}` : ''}</span>}>
                    <div style={{ display: 'flex', gap: 8, margin: '4px 0 8px' }}>
                      <button onClick={() => void post('skip')} style={{ ...plainButton, flex: 1, padding: '5px 0', fontSize: 12 }}>{t.actions.skip}</button>
                      <button onClick={() => void post('replay', { sessionId: sid })} disabled={!state?.hasReplay} style={{ ...plainButton, flex: 1, padding: '5px 0', fontSize: 12, opacity: state?.hasReplay ? 1 : 0.35, cursor: state?.hasReplay ? 'pointer' : 'default' }}>{t.actions.replay}</button>
                    </div>
                    <div style={{ maxHeight: 120, overflow: 'auto', fontSize: 11, lineHeight: 1.6 }}>
                      {(state?.queueView ?? []).length === 0 ? (
                        <div style={{ opacity: 0.4 }}>{t.info.noData}</div>
                      ) : (state?.queueView ?? []).map((q, i) => (
                        <div key={i} style={{ display: 'flex', gap: 6, padding: '1px 0', alignItems: 'center' }}>
                          <button onClick={() => void post('jump', { to: i })} style={{ border: 'none', background: 'transparent', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 11, lineHeight: 0 }}>▶</button>
                          <span style={{ opacity: 0.45, flexShrink: 0, width: 36 }}>{q.kind}</span>
                          <span style={{ opacity: 0.45, flexShrink: 0 }}>{q.session?.slice(0, 6) ?? '—'}</span>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{q.text}</span>
                        </div>
                      ))}
                    </div>
                  </Card>

                  <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', color: T.sub, margin: '0 0 6px 2px' }}>{t.cards.metrics}</div>
                  <MetricsPanel locale={state?.locale} />
                </>
              )}

              {/* ── footer ── */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginTop: 6 }}>
                <div style={{ ...hintStyle, flex: 1, marginTop: 0 }}>{t.actions.settingsHint}</div>
                <button onClick={() => void post('config', { reset: true })} style={{ ...plainButton, background: 'transparent', whiteSpace: 'nowrap' }}>{t.actions.resetOverrides}</button>
              </div>
            </div>
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
