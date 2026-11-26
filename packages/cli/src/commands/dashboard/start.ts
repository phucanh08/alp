import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { connect, daemonPaths, startIntegration } from '@anhlp/alp-client/index';
import type { AlpClient } from '@anhlp/alp-client/index';
import { classify, dashboardDisabled, failure, readPublished, readServiceLock } from './common.js';
import { DASHBOARD, isDashboardReady, isServiceClaimed, readToken, refusal, serviceOwner } from '../../dashboard-service.js';

/** Whether the current working directory is an ALP project: its grant then covers it. */
async function currentProject() {
  const cwd = process.cwd();
  return await stat(path.join(cwd, '.alp')).then(info => info.isDirectory(), () => false) ? cwd : undefined;
}

/** `--project <cwd>` when the directory `alp dashboard` runs in is an ALP project: its grant then covers it. */
export async function projectArgs() {
  const project = await currentProject();
  return project ? ['--project', project] : [];
}

/**
 * Registers `directory` as a project in alpd via IPC (`project.register`).
 * If alpd cannot be reached or the call fails, this is best-effort.
 */
export async function registerProject(home: string, directory: string, { timeoutMs = 5_000, connectClient = connect }: { timeoutMs?: number; connectClient?: typeof connect } = {}): Promise<void> {
  const socket = daemonPaths(home).socket;
  let client: AlpClient | undefined;
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work = (async () => {
    const connected = await connectClient(socket, { name: 'alp-cli', version: '1' }, { timeoutMs });
    if (expired) { connected.close(); return; }
    client = connected;
    for (let attempt = 0; attempt < 5 && !expired; attempt++) {
      const list = await client.request('project.list', { limit: 1 }, { timeoutMs }).catch(() => undefined);
      if (expired) return;
      const revision = typeof list?.revision === 'number' ? list.revision : 0;
      try {
        await client.request('project.register', { directory, ifRevision: revision, requestId: randomUUID() }, { timeoutMs });
        break;
      } catch (error) {
        if ((error as { data?: { reason?: string } } | undefined)?.data?.reason === 'stale_revision' && attempt < 4) continue;
        break;
      }
    }
  })();
  try {
    // One deadline covers connection/hello and every retry; a late connection is closed above.
    await Promise.race([work.catch(() => {}), new Promise(resolve => {
      timer = setTimeout(() => {
        expired = true;
        try { client?.close(); } catch {}
        resolve(undefined);
      }, timeoutMs);
    })]);
  } finally {
    expired = true;
    clearTimeout(timer);
    try { client?.close(); } catch {}
  }
}

/**
 * Waits until the credential in `<home>/dashboard/credentials.json` contains `project`.
 * Polls for up to `timeoutMs` (default 5,000 ms).
 */
async function waitForGrant(home: string, credentialId: string | undefined, project: string, { timeoutMs = 5_000 }: { timeoutMs?: number } = {}) {
  const credentialsFile = path.join(home, 'dashboard', 'credentials.json');
  const canonical = await realpath(project).catch(() => project);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const raw = JSON.parse(await readFile(credentialsFile, 'utf8'));
      const credential = raw?.credentials?.find((c: { id: string; revokedAt?: string }) => c.id === credentialId && !c.revokedAt);
      if (credential?.workspaces?.some((w: { canonical?: string; path?: string }) => w.canonical === canonical || w.path === project || w.path === canonical)) {
        return true;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return false;
}

/**
 * Starts alp-dashboard unless it runs and returns the address to open, the token in its fragment
 * (which the browser never sends to a server). The token comes from the running service over its
 * private token socket (t-cee3); no file holds it.
 *
 * @returns `base` is dashboard.json's url (`http://127.0.0.1:<port>/`)
 */
export async function serveDashboard(home: string, entry: string, { port }: { port?: number } = {}): Promise<{ base: string; token: string; pid: number; port: number }> {
  // A lock held by a process proven not to be alp dashboard: say so now rather than wait for it. A
  // running alp-dashboard (its dashboard.json names the lock's pid and is answering) is left to startIntegration.
  const held = await serviceOwner(home);
  const published = await readPublished(home);
  const lockPid = (await readServiceLock(home))?.pid;
  const claimed = await isServiceClaimed(published, lockPid, held);
  if ('reason' in held && held.alive && held.kind === 'foreign' && !claimed) throw failure('conflict', `${refusal(home)} (${held.reason}). Stop it, then run alp dashboard again.`);
  // `--port` asks for a port; a service already running elsewhere is not silently reused.
  if (port !== undefined && claimed && published.port !== port) {
    throw failure('conflict', `alp dashboard already runs on port ${published.port} (pid ${published.pid}); you asked for port ${port}. Stop it with \`alp dashboard --stop\`, or drop --port to use the running one.`);
  }
  const project = await currentProject();
  let lock: Awaited<ReturnType<typeof startIntegration>>;
  try { lock = await startIntegration({ name: DASHBOARD.lock, entry, home, args: [...(project ? ['--project', project] : []), ...(port !== undefined ? ['--port', String(port)] : [])] }); }
  catch (error) {
    // Still held by a live process alp cannot prove: name it, as the wait may have been for it.
    const owner = await serviceOwner(home);
    if ('reason' in owner && owner.alive) throw failure('conflict', `${(error as Error | undefined)?.message ?? error}\n${refusal(home)} (${owner.reason}). If it is not alp dashboard, stop it, then run alp dashboard again.`, { cause: error });
    // startIntegration reads settings.json itself: turned off between this command's check and the start.
    throw classify(error, await dashboardDisabled(home) ? 'disabled' : 'service');
  }
  const info = await readPublished(home);
  if (info?.app !== DASHBOARD.app || info.pid !== lock.pid) {
    const owner = await serviceOwner(home);
    throw failure('conflict', `${refusal(home)}${'reason' in owner ? ` (${owner.reason})` : ''}. Stop pid ${lock.pid}, then run alp dashboard again.`);
  }
  if (typeof info.url !== 'string' || !(await isDashboardReady(info.url))) {
    throw failure('service', `alp dashboard published no address; see ${path.join(home, 'logs', 'integrations', 'alp-dashboard.log')}`);
  }
  let answer: Awaited<ReturnType<typeof readToken>>;
  try { answer = await readToken(home); }
  catch (error) { throw failure('service', `alp dashboard did not hand over its token: ${(error as Error | undefined)?.message ?? error}; see ${path.join(home, 'logs', 'integrations', 'alp-dashboard.log')}. A service started by an older alp keeps no token socket: run \`alp dashboard --stop\`, then \`alp dashboard\` again`, { cause: error }); }
  // The socket's answer must come from the process the lock and dashboard.json name.
  if (answer.pid !== lock.pid) throw failure('conflict', `the token socket of alp dashboard is held by pid ${answer.pid}, not by the service (pid ${lock.pid}); stop it, then run alp dashboard again`);
  if (port !== undefined && info.port !== port) {
    throw failure('conflict', `alp dashboard is running on port ${info.port}, not ${port} (port ${port} was busy or alp dashboard was starting already); it was left running there. Stop it with \`alp dashboard --stop\` and free port ${port}, or drop --port`);
  }
  if (project) {
    await registerProject(home, project);
    await waitForGrant(home, answer.credentialId ?? info.credentialId, project);
  }
  return { base: info.url, token: answer.token, pid: lock.pid, port: info.port };
}
