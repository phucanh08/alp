import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { entryCommand } from '@anhlp/alp-core/packaged';
import { DISABLED, dashboardDisabled, readPublished, readServiceLock, reportMigration } from './common.js';
import { legacyLeftovers, migrateDashboard } from './migrate.js';
import { DASHBOARD, LEGACY_WEB, dashboardEntry, isDashboardReady, refusal, serviceOwner, stopService } from '../../dashboard-service.js';

/**
 * The running service as its files and its listener show it, without ps (so also on Windows): the
 * lock names a live pid, dashboard.json names the same pid and is alp-dashboard's, and its address
 * answers. `held` is a live lock owner that is not (yet) that.
 */
async function runningDashboard(home: string): Promise<{ pid: number; port: number; url: string } | { held: number } | undefined> {
  const lock = await readServiceLock(home);
  if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0) return undefined;
  try { process.kill(lock.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EPERM') return undefined; }
  const info = await readPublished(home);
  if (info?.app === DASHBOARD.app && info.pid === lock.pid && typeof info.url === 'string' && await isDashboardReady(info.url)) return { pid: info.pid, port: info.port, url: info.url };
  return { held: lock.pid };
}

/**
 * alp dashboard --status, after Hermes' `hermes dashboard --status` (hermes_cli/main_dashboard.py
 * _report_dashboard_status): what runs, or that nothing does; always exit 0, and nothing is changed
 * (the move from `alp web` waits for a command that starts or stops). The address is printed
 * without its token.
 */
export async function statusCommand(home: string) {
  try {
    const running = await runningDashboard(home);
    if (running && 'url' in running) {
      console.log('1 alp dashboard process running:');
      console.log(`    PID ${running.pid} [dashboard]: ${running.url} (port ${running.port})`);
    } else if (running) {
      const owner = await serviceOwner(home);
      console.log(`No alp dashboard running. pid ${running.held} holds ${path.join(home, 'integrations', `${DASHBOARD.lock}.lock`)}${'reason' in owner ? ` (${owner.reason})` : ''}.`);
    } else console.log('No alp dashboard running.');
    if (await dashboardDisabled(home)) console.log(DISABLED);
    const left = await legacyLeftovers(home);
    if (left.legacy?.pid) console.log(`${LEGACY_WEB.what} still runs (pid ${left.legacy.pid}); \`alp dashboard\` or \`alp dashboard --stop\` stops it.`);
    else if (left.legacy) console.log(`${refusal(home, LEGACY_WEB)} (${left.legacy.reason}).`);
    for (const item of left.pending) console.log(`From before the rename to alp dashboard, moved by the next \`alp dashboard\`: ${item}`);
    for (const item of left.kept) console.log(`Left from before the rename to alp dashboard, not used: ${item}`);
  } catch (error) {
    console.log(`alp dashboard could not tell everything: ${(error as Error | undefined)?.message ?? error}`);
  }
}

/**
 * alp dashboard --stop, after Hermes' `hermes dashboard --stop` (hermes_cli/main.py
 * _dashboard_lifecycle_flags): only this ALP home's service (and alp web from before the rename,
 * which the move stops); nothing running is not an error; a process alp cannot prove is the service
 * is left running and the command fails.
 */
export async function stopCommand(home: string) {
  const report = await migrateDashboard(home);
  reportMigration(report);
  // alp web from before the rename still holds its lock: not stopped, so not a success.
  if (report.held) process.exitCode = 1;
  const owner = await serviceOwner(home);
  if (!(owner as { alive?: boolean }).alive && !('pid' in owner)) {
    if (!report.stopped) console.log('No alp dashboard running for this ALP home.');
  } else {
    const pid = await stopService(home);
    if (pid) console.log(`Stopped alp dashboard (pid ${pid}).`);
    else console.log('No alp dashboard running for this ALP home.');
  }
  await dropLeftToken(home);
}

/**
 * A token an older alp dashboard (before t-cee3) wrote into dashboard.json stays readable there, and
 * its credential live, until the service starts again. --stop clears it too: the service's own
 * `--rotate` revokes every credential and strips the token, under the dashboard lock.
 */
async function dropLeftToken(home: string) {
  let published;
  try { published = JSON.parse(await readFile(path.join(home, DASHBOARD.info), 'utf8')); } catch { return; }
  if (!published || typeof published !== 'object' || !('token' in published)) return;
  const rotate = entryCommand(dashboardEntry(), 'dashboard', ['--rotate']);
  const code = await new Promise<number>(resolve => {
    execFile(rotate.command, rotate.args, { env: { ...process.env, ALP_HOME: home }, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGTERM' },
      error => resolve(error ? (typeof error.code === 'number' ? error.code : 1) : 0));
  });
  if (code === 0) console.log(`Removed the token an older alp dashboard left in ${DASHBOARD.info} and revoked it.`);
  else { console.log(`${DASHBOARD.info} still holds a token from an older alp dashboard; run \`alp dashboard rotate\` to revoke it.`); process.exitCode = 1; }
}
