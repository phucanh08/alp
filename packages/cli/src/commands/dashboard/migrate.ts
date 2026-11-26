import { lstat, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { migrateDashboardSettings } from '@anhlp/alp-core/user-settings';
import { LEGACY_WEB, refusal, serviceOwner, stopService } from '../../dashboard-service.js';

/**
 * The move from `alp web` (0.0.1-beta.8 and earlier) to `alp dashboard` (t-81b0.5), run by every
 * `alp dashboard` command before it reads or starts anything. An install keeps its credential store,
 * its port and its enabled/disabled setting (not its token: every start of alp dashboard mints a new
 * one, t-cee3):
 *
 *   1. alp web still running under `integrations/web.lock` (or the Paseo integration from before its
 *      own rename, which held the same lock) is stopped, with the same proofs `alp dashboard --stop`
 *      uses; a holder that cannot be proven is left running and nothing below is moved, since it
 *      may still write the old files.
 *   2. `<home>/web/` (alp web's credential store) becomes `<home>/dashboard/`.
 *   3. `<home>/web.json` written by alp web (`app: 'alp-web'`) is removed: its pid, port and URL died
 *      with alp web, and its token is revoked by the next start of alp dashboard, which keeps tokens
 *      in no file (t-cee3). One without `app` is the Paseo integration's identity and is left for the
 *      service to carry into paseo.json, as before.
 *   4. `logs/integrations/alp-web.log` becomes `alp-dashboard.log`.
 *   5. settings.json: `web.enabled`, `web.port` and `web.permissions` move to `dashboard.*`
 *      (`web.relay`, Paseo's, stays); see migrateDashboardSettings.
 *
 * Every other step only moves an old name onto a missing new one, so a second run does nothing and a
 * home that has both keeps the new one untouched (the old one is reported, never merged or deleted).
 * Steps that race another `alp dashboard` lose cleanly: a rename that finds its source gone
 * or its target present is skipped.
 */

/** What migrateDashboard did; `held`: a legacy holder alp would not stop still runs (only without strict). */
export type DashboardMigration = { stopped?: number; held?: boolean; moved: string[]; kept: string[]; warnings: string[] };
/** What a home still has under the names from before the rename (see legacyLeftovers). */
export type LegacyLeftovers = { legacy?: { pid?: number; reason?: string }; pending: string[]; kept: string[] };

const exists = (file: string) => lstat(file).then(() => true, () => false);
/** A file's JSON, or undefined when it is missing or not JSON. */
const readJson = (file: string) => readFile(file, 'utf8').then(text => { try { return JSON.parse(text); } catch { return undefined; } }, () => undefined);
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/**
 * @param options strict: a legacy holder alp cannot stop is an error (a start
 *   would otherwise lose its port to it); without it, it is reported and the files are left alone.
 * @returns held: a legacy holder alp would not stop is still running (only without strict).
 */
export async function migrateDashboard(home: string, { strict = false }: { strict?: boolean } = {}): Promise<DashboardMigration> {
  const report: DashboardMigration = { moved: [], kept: [], warnings: [] };

  // 1. The service from before the rename.
  const owner = await serviceOwner(home, LEGACY_WEB);
  if ('pid' in owner || (owner.alive && owner.kind === 'transient')) {
    try { report.stopped = await stopService(home, 30_000, LEGACY_WEB); }
    catch (error) {
      if (strict) throw error;
      report.warnings.push((error as Error | undefined)?.message ?? String(error));
      report.held = true;
      return report;
    }
  } else if (owner.alive) {
    const message = `${refusal(home, LEGACY_WEB)} (${owner.reason}); stop it, then run the command again`;
    if (strict) throw new Error(message);
    report.warnings.push(message);
    report.held = true;
    return report;
  }

  // 2. The credential store.
  const oldStore = path.join(home, 'web');
  const newStore = path.join(home, 'dashboard');
  if (await exists(path.join(oldStore, 'credentials.json'))) {
    if (await exists(newStore)) report.kept.push(oldStore);
    else {
      try { await rename(oldStore, newStore); report.moved.push(`${oldStore} -> ${newStore}`); }
      catch (error) { if (!(['ENOENT', 'EEXIST', 'ENOTEMPTY'] as Array<string | undefined>).includes(code(error))) throw error; }
    }
  }

  // 3. What the service published: nothing of it is used again, and it holds a token.
  const oldInfo = path.join(home, LEGACY_WEB.info);
  const published = await readJson(oldInfo);
  if (published?.app === LEGACY_WEB.app) {
    await unlink(oldInfo).then(() => report.moved.push(`${oldInfo} removed (alp dashboard mints a new token on its next start)`), error => { if (code(error) !== 'ENOENT') throw error; });
  }

  // 4. The service's log.
  const logs = path.join(home, 'logs', 'integrations');
  const oldLog = path.join(logs, 'alp-web.log');
  const newLog = path.join(logs, 'alp-dashboard.log');
  if (await exists(oldLog) && !(await exists(newLog))) {
    await rename(oldLog, newLog).then(() => report.moved.push(`${oldLog} -> ${newLog}`), error => { if (code(error) !== 'ENOENT') throw error; });
  }

  // 5. Settings. A file alp cannot rewrite (invalid, read-only) is still obeyed: dashboardSettings
  // reads `web.*` where `dashboard.*` is not set.
  try {
    const settings = await migrateDashboardSettings(home);
    for (const key of settings.moved) report.moved.push(`settings.json web.${key} -> dashboard.${key}`);
    for (const key of settings.conflicts) report.kept.push(`settings.json web.${key} (dashboard.${key} is set and wins)`);
  } catch (error) {
    report.warnings.push(`settings.json was not migrated (web.* is still read): ${(error as Error | undefined)?.message ?? error}`);
  }
  return report;
}

/**
 * What a home still has under the names from before the rename, without changing anything (for
 * `alp dashboard --status`): `pending` the next `alp dashboard` moves, `kept` it leaves because the
 * new name exists, and the legacy service if one runs.
 */
export async function legacyLeftovers(home: string): Promise<LegacyLeftovers> {
  const result: LegacyLeftovers = { pending: [], kept: [] };
  const owner = await serviceOwner(home, LEGACY_WEB);
  if ('pid' in owner) result.legacy = { pid: owner.pid };
  else if (owner.alive) result.legacy = { reason: owner.reason };
  const place = async (old: string, current: string) => (await exists(current) ? result.kept : result.pending).push(old);
  if (await exists(path.join(home, 'web', 'credentials.json'))) await place(path.join(home, 'web'), path.join(home, 'dashboard'));
  const published = await readJson(path.join(home, LEGACY_WEB.info));
  if (published?.app === LEGACY_WEB.app) result.pending.push(path.join(home, LEGACY_WEB.info));
  const logs = path.join(home, 'logs', 'integrations');
  if (await exists(path.join(logs, 'alp-web.log'))) await place(path.join(logs, 'alp-web.log'), path.join(logs, 'alp-dashboard.log'));
  const settings = await readJson(path.join(home, 'settings.json'));
  for (const key of ['enabled', 'port', 'permissions']) {
    if (settings?.web?.[key] === undefined) continue;
    if (settings?.dashboard?.[key] !== undefined) result.kept.push(`settings.json web.${key} (dashboard.${key} is set and wins)`);
    else result.pending.push(`settings.json web.${key}`);
  }
  return result;
}
