import { randomBytes } from 'node:crypto';
import { chmod, link, lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { migrateDashboardSettings } from '@anhlp/alp-core/user-settings';
import { DASHBOARD, LEGACY_WEB, refusal, serviceOwner, stopService } from './dashboard-service.js';

/**
 * The move from `alp web` (0.0.1-beta.8 and earlier) to `alp dashboard` (t-81b0.5), run by every
 * `alp dashboard` command before it reads or starts anything. An install keeps its token, its port
 * and its enabled/disabled setting:
 *
 *   1. alp web still running under `integrations/web.lock` (or the Paseo integration from before its
 *      own rename, which held the same lock) is stopped, with the same proofs `alp dashboard --stop`
 *      uses; a holder that cannot be proven is left running and nothing below is moved, since it
 *      may still write the old files.
 *   2. `<home>/web/` (alp web's credential store) becomes `<home>/dashboard/`.
 *   3. `<home>/web.json` written by alp web (`app: 'alp-web'`) becomes `<home>/dashboard.json`, keeping
 *      its token and credential id; one without `app` is the Paseo integration's identity and is left
 *      for the service to carry into paseo.json, as before.
 *   4. `logs/integrations/alp-web.log` becomes `alp-dashboard.log`.
 *   5. settings.json: `web.enabled`, `web.port` and `web.permissions` move to `dashboard.*`
 *      (`web.relay`, Paseo's, stays); see migrateDashboardSettings.
 *
 * Every step only moves an old name onto a missing new one, so a second run does nothing and a home
 * that has both keeps the new one untouched (the old one is reported, never merged or deleted).
 * Steps that race another `alp dashboard` lose cleanly: a rename or link that finds its source gone
 * or its target present is skipped.
 */

/** @param {string} file */
const exists = file => lstat(file).then(() => true, () => false);
/** @param {unknown} error */
const code = error => /** @type {any} */ (error)?.code;

/**
 * @param {string} home
 * @param {{ strict?: boolean }} [options] strict: a legacy holder alp cannot stop is an error (a start
 *   would otherwise lose its port to it); without it, it is reported and the files are left alone.
 * @returns {Promise<{ stopped?: number, moved: string[], kept: string[], warnings: string[] }>}
 */
export async function migrateDashboard(home, { strict = false } = {}) {
  /** @type {{ stopped?: number, moved: string[], kept: string[], warnings: string[] }} */
  const report = { moved: [], kept: [], warnings: [] };

  // 1. The service from before the rename.
  const owner = await serviceOwner(home, LEGACY_WEB);
  if ('pid' in owner || (owner.alive && owner.kind === 'transient')) {
    try { report.stopped = await stopService(home, 30_000, LEGACY_WEB); }
    catch (error) {
      if (strict) throw error;
      report.warnings.push(/** @type {any} */ (error)?.message ?? String(error));
      return report;
    }
  } else if (owner.alive) {
    const message = `${refusal(home, LEGACY_WEB)} (${owner.reason}); stop it, then run the command again`;
    if (strict) throw new Error(message);
    report.warnings.push(message);
    return report;
  }

  // 2. The credential store.
  const oldStore = path.join(home, 'web');
  const newStore = path.join(home, 'dashboard');
  if (await exists(path.join(oldStore, 'credentials.json'))) {
    if (await exists(newStore)) report.kept.push(oldStore);
    else {
      try { await rename(oldStore, newStore); report.moved.push(`${oldStore} -> ${newStore}`); }
      catch (error) { if (!['ENOENT', 'EEXIST', 'ENOTEMPTY'].includes(code(error))) throw error; }
    }
  }

  // 3. What the service published.
  const oldInfo = path.join(home, LEGACY_WEB.info);
  const newInfo = path.join(home, DASHBOARD.info);
  const published = await readFile(oldInfo, 'utf8').then(text => JSON.parse(text), () => undefined);
  if (published?.app === LEGACY_WEB.app) {
    if (await exists(newInfo)) report.kept.push(oldInfo);
    else {
      // Only what the next start reuses; the old pid, port and URL died with the old service.
      const carried = { version: published.version, app: DASHBOARD.app, token: published.token, credentialId: published.credentialId };
      const temporary = `${newInfo}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(carried)}\n`, { mode: 0o600, flag: 'wx' });
        await chmod(temporary, 0o600);
        // A link never replaces: a dashboard.json written meanwhile wins.
        await link(temporary, newInfo).then(() => report.moved.push(`${oldInfo} -> ${newInfo}`), error => { if (code(error) !== 'EEXIST') throw error; });
      } finally { await unlink(temporary).catch(() => {}); }
      await unlink(oldInfo).catch(error => { if (code(error) !== 'ENOENT') throw error; });
    }
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
    report.warnings.push(`settings.json was not migrated (web.* is still read): ${/** @type {any} */ (error)?.message ?? error}`);
  }
  return report;
}
