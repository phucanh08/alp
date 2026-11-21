// The host owner's connection for e2e specs (t-a95b; docs/alp/remote-gateway.md §5.19): `alp
// dashboard --print` on a disposable host from startWorld, as local.spec.js runs it. Its gateway is
// created with the owner option, and the printed link's token is the dashboard's own credential on
// a direct loopback socket, so the page it opens is the host owner (state.owner). The standalone
// alp-gateway of the same world (startWorld's gateway) has no owner: its tokens are the non-owners.
// One helper for every owner spec (settings-host.spec.js, settings-library.spec.js).
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { WEB, freePort } from './world.js';

const run = promisify(execFile);
const LINK = /^http:\/\/127\.0\.0\.1:(\d+)\/#token=(alpgw1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43})$/m;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The dashboard settings a world needs for startDashboard: its port, no relay. Pass as startWorld's `settings`. */
export async function dashboardSettings(extra = {}) {
  return { dashboard: { port: await freePort(), ...extra }, web: { relay: { enabled: false } } };
}

/**
 * Starts alp-dashboard for `world` (started with dashboardSettings()) serving this checkout's built
 * app (apps/web/dist), and answers its link: `url` (with the token fragment), `origin`, `token`.
 * `stop()` ends the service; call it before world.close().
 * @param {Awaited<ReturnType<typeof import('./world.js').startWorld>>} world
 * @param {{ env?: Record<string, string> }} [options]
 */
export async function startDashboard(world, { env: extra = {} } = {}) {
  // This world's alpd (no supervision of its own), the freshly built app, and a fast registry refresh
  // so a project registered or removed reaches the grant (and the page) quickly. `env` adds to the
  // dashboard process's environment (sidebar-facts.spec.js puts a fake gh first on its PATH).
  const env = { ...world.env, ...extra, ALP_SUPERVISE: '0', ALP_DASHBOARD_APP: path.join(WEB, 'dist'), ALP_DASHBOARD_GRANT_REFRESH_MS: '200' };
  const printed = (await run(process.execPath, [world.cli, 'dashboard', '--print'], { env, cwd: world.projects.main, timeout: 120_000 })).stdout.trim();
  const link = LINK.exec(printed);
  if (!link) throw new Error(`alp dashboard --print printed no link:\n${printed}`);
  const [url, , token] = link;
  return {
    url, token, origin: new URL(url).origin,
    async stop() {
      const info = await readFile(path.join(world.home, 'dashboard.json'), 'utf8').then(JSON.parse, () => undefined);
      if (!info?.pid) return;
      try { process.kill(info.pid, 'SIGTERM'); } catch { return; }
      for (let i = 0; i < 300; i++) { try { process.kill(info.pid, 0); } catch { return; } await sleep(50); }
      try { process.kill(info.pid, 'SIGKILL'); } catch {}
    },
  };
}
