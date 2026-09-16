/**
 * PROTOTYPE — the "pet" seam for dsh-voice-mini.
 *
 * A native floating widget (see `pet/`) cannot be created by a plugin, so —
 * exactly like aa2246740/dsh-notch — the host writes a small runtime file the
 * widget discovers on disk, and guards its routes with loopback + a bearer
 * token. The token is persisted so a widget restart keeps working.
 *
 * @module dsh-voice-mini/pet
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

const DIR = join(homedir(), '.dsh', 'voice-mini');
/**
 * Runtime file location. Overridable so tests (whose sandbox cannot write
 * outside the workspace) and side-by-side debug runs can redirect it —
 * mirrors dsh-notch's DSH_NOTCH_RUNTIME_FILE escape hatch.
 */
export const RUNTIME_FILE = process.env.DSH_VOICE_MINI_RUNTIME ?? join(DIR, 'runtime.json');

export interface RuntimeFile {
  origin: string;
  token: string;
  pid: number;
  writtenAt: number;
  /**
   * The DSH Desktop shell's per-generation renderer capability. The shell
   * wraps EVERY plugin route with `permits(req)` and answers 403 "forbidden"
   * unless the request carries this header (or ordinary-browser access is on).
   * The plugin reads it from its own `desktopBrowserAccess` service so the
   * native widget is admitted exactly like the Electron renderer.
   */
  rendererHeader?: { name: string; value: string };
}

/** Reuse the token from a previous run when it looks sane; else mint one. */
export function loadOrCreateToken(): string {
  try {
    const parsed = JSON.parse(readFileSync(RUNTIME_FILE, 'utf8')) as RuntimeFile;
    if (typeof parsed?.token === 'string' && parsed.token.length >= 16) return parsed.token;
  } catch {
    // First run, or a corrupt file — fall through and mint a fresh token.
  }
  return randomBytes(24).toString('hex');
}

export function writeRuntime(file: RuntimeFile): void {
  mkdirSync(dirname(RUNTIME_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(RUNTIME_FILE, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function isLoopback(req: IncomingMessage): boolean {
  const ip = req.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** Bearer header or `?token=` — the two forms dsh-notch accepts. */
export function authorized(req: IncomingMessage, token: string): boolean {
  if (req.headers.authorization === `Bearer ${token}`) return true;
  try {
    return new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('token') === token;
  } catch {
    return false;
  }
}