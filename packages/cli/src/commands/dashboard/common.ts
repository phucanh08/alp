import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { dashboardSettings } from '@anhlp/alp-core/user-settings';
import type { DashboardMigration } from './migrate.js';
import { DASHBOARD, LEGACY_WEB } from '../../dashboard-service.js';

/** Whether settings.json turns alp dashboard off (`dashboard.enabled`, else `web.enabled` from before the rename). */
export async function dashboardDisabled(home: string) {
  const settings = await readJsonFile(path.join(home, 'settings.json'));
  return dashboardSettings(settings).enabled === false;
}

export const DISABLED = 'alp dashboard is disabled by settings ("dashboard.enabled": false).';

/**
 * The contract of `alp dashboard --print --json` (docs/alp/dashboard.md §3.3). Each failure class
 * has a name (`error.code` in the JSON) and its own exit code; both are stable. `failed` (1) is
 * everything not classified, and what an alp from before the contract exits with.
 */
export const PRINT_SCHEMA = 'alp.dashboard.print';
export const PRINT_VERSION = 1;
export const PRINT_EXIT = { failed: 1, usage: 2, disabled: 3, agent: 4, not_built: 5, conflict: 6, service: 7, daemon: 8 };

/**
 * An Error of failure class `kind` (a key of PRINT_EXIT). Without --json the class changes nothing:
 * the message is printed and alp exits 1 as before.
 */
export const failure = (kind: keyof typeof PRINT_EXIT, message: string, options?: ErrorOptions) => Object.assign(new Error(message, options), { kind });

/**
 * Runs `work`; an error it throws without a class gets `kind`. The error itself is rethrown.
 */
export async function classed<T>(kind: keyof typeof PRINT_EXIT, work: () => T | Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) { throw classify(error, kind); }
}

/** `error`, given the class `kind` unless it has one. */
export function classify(error: unknown, kind: keyof typeof PRINT_EXIT) {
  if (error instanceof Error && !('kind' in error)) Object.assign(error, { kind });
  return error;
}

/** A file's JSON, or undefined when it is missing or not JSON (as before: a broken file counts as none). */
const readJsonFile = (file: string) => readFile(file, 'utf8').then(text => { try { return JSON.parse(text); } catch { return undefined; } }, () => undefined);
export const readPublished = (home: string) => readJsonFile(path.join(home, DASHBOARD.info));
export const readServiceLock = (home: string) => readJsonFile(path.join(home, 'integrations', `${DASHBOARD.lock}.lock`));

/** The address to open: the token rides in the fragment, which a browser never sends to a server. */
export const addressOf = (served: { base: string; token: string }) => `${served.base}#token=${served.token}`;

/** Reports what the migration from `alp web` did, on stderr (stdout carries only the address). */
export function reportMigration(report: DashboardMigration) {
  if (report.stopped) console.error(`Stopped ${LEGACY_WEB.what} (pid ${report.stopped}).`);
  if (report.moved.length) console.error(`Moved alp web's files to alp dashboard's names: ${report.moved.join('; ')}`);
  for (const warning of report.warnings) console.error(warning);
}
