// The host owner in a disposable world (t-a95b.1 group B): `alp dashboard --print` on the world's
// own home and alpd, the alp-dashboard service being the one gateway created with the owner option,
// so the page that opens its link is the host owner (docs/alp/remote-gateway.md §5.19). The world's
// standalone alp-gateway, if started, stays a plain gateway: its credentials are never the owner.
// The world needs `settings: { dashboard: { port }, web: { relay: { enabled: false } } }`.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const run = promisify(execFile);
const LINK = /^http:\/\/127\.0\.0\.1:(\d+)\/#token=(alpgw1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43})$/m;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/**
 * Starts alp-dashboard for `world` and answers its link: { url, token, stop }. `stop` ends the
 * service (SIGTERM, then SIGKILL); closeWorldAfter (cleanup.js) also kills it if a test fails first.
 * @param {{ cli: string, env: Record<string, string | undefined>, home: string, projects: { main: string } }} world
 */
export async function startOwnerDashboard(world) {
  // This world's alpd (no supervision of its own) and a fast registry refresh, as local.spec.js.
  const env = { ...world.env, ALP_SUPERVISE: '0', ALP_DASHBOARD_GRANT_REFRESH_MS: '200' };
  delete env.ALP_DASHBOARD_APP;
  const { stdout } = await run(process.execPath, [world.cli, 'dashboard', '--print'], { env, cwd: world.projects.main, timeout: 120_000 });
  const link = LINK.exec(stdout.trim());
  if (!link) throw new Error(`alp dashboard --print gave no link:\n${stdout}`);
  const [url, , token] = link;
  return {
    url, token,
    async stop() {
      const info = await readFile(path.join(world.home, 'dashboard.json'), 'utf8').then(JSON.parse, () => undefined);
      if (!info?.pid || !alive(info.pid)) return;
      try { process.kill(info.pid, 'SIGTERM'); } catch {}
      for (let i = 0; i < 600 && alive(info.pid); i++) await delay(25);
      if (alive(info.pid)) { try { process.kill(info.pid, 'SIGKILL'); } catch {} }
    },
  };
}
