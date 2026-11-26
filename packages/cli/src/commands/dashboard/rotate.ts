import { execFile } from 'node:child_process';
import { alpHome } from '@anhlp/alp-client/index';
import { entryCommand } from '@anhlp/alp-core/packaged';
import { UsageError } from '../_shared/usage.js';
import { start } from '../daemon/index.js';
import { DISABLED, addressOf, dashboardDisabled, reportMigration } from './common.js';
import { migrateDashboard } from './migrate.js';
import { projectArgs, serveDashboard } from './start.js';
import { dashboardEntry, stopService } from '../../dashboard-service.js';

/**
 * alp dashboard rotate: alp dashboard's token is replaced and the old one revoked, so every open
 * page loses access. Only the process holding the dashboard lock writes its credentials, so the
 * service is stopped first; `alp-dashboard.js --rotate` then takes the lock, revokes every credential
 * and releases the lock, and the service starts again with a new one (every start mints one, t-cee3).
 */
export async function rotateCommand(args: string[]) {
  if (args.length) throw new UsageError();
  const entry = dashboardEntry();
  const home = alpHome();
  reportMigration(await migrateDashboard(home, { strict: true }));
  await start();
  const project = await projectArgs();
  for (let attempt = 1; ; attempt++) {
    await stopService(home);
    const rotated = await new Promise<{ code: number; output: string }>(resolve => {
      const rotate = entryCommand(entry, 'dashboard', ['--rotate', ...project]);
      execFile(rotate.command, rotate.args, { env: { ...process.env, ALP_HOME: home }, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGTERM' },
        (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stderr}${stdout}`.trim() }));
    });
    if (rotated.code === 0) break;
    // Exit 3: alp dashboard started again between the stop and the rotation; stop it once more.
    if (rotated.code !== 3 || attempt >= 3) throw new Error(`alp dashboard could not rotate its token${rotated.output ? `:\n${rotated.output.slice(-2000)}` : ''}`);
  }
  if (await dashboardDisabled(home)) {
    console.log(`alp dashboard's token is revoked; the old one no longer works and the next start mints a new token. ${DISABLED.replace(/\.$/, '')}, so it was not started.`);
    return;
  }
  console.log(addressOf(await serveDashboard(home, entry)));
}
