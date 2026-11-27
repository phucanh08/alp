import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { moveFile } from '../_shared/atomic.ts';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AlpError } from '../_shared/errors.ts';
import { DASHBOARD_SETTINGS, validateUserSettings } from './validation.ts';

/**
 * The user's own settings in $ALP_HOME/settings.json that ALP and its screens edit
 * (ALPD §54). The language is the one everything the user reads is written in:
 * agents' messages and questions, approvals, and ALP's own notices.
 */

/** The language ALP and its agents write in for the user when none is set. */
export const DEFAULT_LANGUAGE: string = 'Vietnamese';
export const LANGUAGE_CHARS: number = 40;

// any: the user's settings.json, checked by validateUserSettings; callers read and copy its keys as they are
async function readSettings(home: string): Promise<{ file: string, settings: Record<string, any> }> {
  const file = path.join(home, 'settings.json');
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { file, settings: {} }; throw error; }
  let settings;
  try { settings = JSON.parse(text); }
  catch (cause) { throw new AlpError('INVALID_SETTINGS', `${file}: ${(cause as Error).message}`, { cause }); }
  return { file, settings: validateUserSettings(settings, file) };
}

/** The user's language: their setting, else Vietnamese. A broken settings file falls back too. */
export async function userLanguage(home?: string): Promise<string> {
  if (!home) return DEFAULT_LANGUAGE;
  try { return (await readSettings(home)).settings.language ?? DEFAULT_LANGUAGE; }
  catch { return DEFAULT_LANGUAGE; }
}

/** What the settings screen shows: the language set, if any, and the one that applies. */
export async function languageSetting(home: string): Promise<{ language: string | null; applies: string; default: string }> {
  const { settings } = await readSettings(home);
  return { language: settings.language ?? null, applies: settings.language ?? DEFAULT_LANGUAGE, default: DEFAULT_LANGUAGE };
}

/**
 * Sets the user's language, or clears it with null so the default applies. Other keys
 * of settings.json are kept as they are.
 */
export async function setLanguage(home: string | undefined, language: string | null): Promise<{ language: string | null; applies: string; default: string }> {
  if (!home) throw new AlpError('INVALID_SCOPE', 'No library: ALP_HOME is not set');
  if (language !== null && (typeof language !== 'string' || !language.trim() || language.trim().length > LANGUAGE_CHARS)) {
    throw new AlpError('INVALID_SETTINGS', `A language is a name of at most ${LANGUAGE_CHARS} characters, such as Vietnamese or English`);
  }
  const { file, settings } = await readSettings(home);
  const next = { ...settings };
  if (language === null) delete next.language; else next.language = language.trim();
  validateUserSettings(next, file);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n');
  await moveFile(temporary, file);
  return languageSetting(home);
}

/**
 * Changes the relay setting under web (ALPD §64), keeping everything else in settings.json.
 * @param {string} home
 * @param {{ enabled?: boolean, endpoint?: string, useTls?: boolean }} patch
 */
export async function setWebRelay(home: string, patch: { enabled?: boolean; endpoint?: string; useTls?: boolean }): Promise<{ enabled?: boolean; endpoint?: string; useTls?: boolean }> {
  const { file, settings } = await readSettings(home);
  const next = { ...settings, web: { ...settings.web, relay: { ...settings.web?.relay, ...patch } } };
  validateUserSettings(next, file);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n');
  await moveFile(temporary, file);
  return next.web.relay;
}

/**
 * alp dashboard's settings (enabled, port, permissions): `dashboard.*` first, then the `web.*` they
 * had before the rename (t-81b0.5), so a file not yet migrated is still obeyed rather than ignored.
 * @param {any} settings
 * @returns {{ enabled?: boolean, port?: number, permissions?: string[] }}
 */
export function dashboardSettings(settings: any): { enabled?: boolean; port?: number; permissions?: string[] } { // any: any settings object, migrated or not; only its dashboard and web keys are read
  const now = settings?.dashboard ?? {};
  const before = settings?.web ?? {};
  const result: any = {}; // any: filled key by key from DASHBOARD_SETTINGS
  for (const key of DASHBOARD_SETTINGS) {
    const value = now[key] !== undefined ? now[key] : before[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

/**
 * Moves alp dashboard's settings from `web` (before the rename, t-81b0.5) to `dashboard` in
 * settings.json, keeping everything else, `web.relay` (Paseo's) included. A key `dashboard` already
 * sets wins: the `web` one is left in place and reported, never merged over it. Idempotent: a file
 * with nothing to move is not written. Returns what it moved and what it left.
 * @param {string} home
 * @returns {Promise<{ moved: string[], conflicts: string[] }>}
 */
export async function migrateDashboardSettings(home: string): Promise<{ moved: string[]; conflicts: string[] }> {
  const { file, settings } = await readSettings(home);
  const web = settings.web;
  if (!web || typeof web !== 'object') return { moved: [], conflicts: [] };
  const moved: string[] = [], conflicts: string[] = [];
  const dashboard = { ...settings.dashboard };
  const rest = { ...web };
  for (const key of DASHBOARD_SETTINGS) {
    if (web[key] === undefined) continue;
    if (dashboard[key] !== undefined) { conflicts.push(key); continue; }
    dashboard[key] = web[key];
    delete rest[key];
    moved.push(key);
  }
  if (!moved.length) return { moved, conflicts };
  const next: Record<string, any> = { ...settings, dashboard }; // any: settings.json as read, with the moved keys
  if (Object.keys(rest).length) next.web = rest; else delete next.web;
  validateUserSettings(next, file);
  const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
  await moveFile(temporary, file);
  return { moved, conflicts };
}
