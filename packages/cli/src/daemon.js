import { access } from 'node:fs/promises';
import path from 'node:path';
import { installedProgram, installService, serviceFor, uninstallService } from '@anhlp/alp-client/service';
import { holdDaemon, startDaemon } from '@anhlp/alp-client/supervise';
import { alpHome, connect, daemonStartTimeoutMs, lockAlive, readLock, withDaemonLifecycle } from '@anhlp/alp-client/index';
import { scrubText } from '@anhlp/alp-core/log';
import { UsageError } from './usage.js';
import { DAEMON_ENTRY } from './paths.js';
import { runRole } from './roles.js';

async function built() {
  try {
    await access(DAEMON_ENTRY);
  } catch {
    throw new Error(`alpd is not built (${DAEMON_ENTRY}); run npm run build`);
  }
}

/** Waits until an alpd for this home is ready; returns its socket. Default wait: ALP_DAEMON_START_TIMEOUT_MS, else 60 s. */

async function ready(timeoutMs = daemonStartTimeoutMs()) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = await readLock(alpHome());
    if (lockAlive(lock) && lock.ready) return lock.socket;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`alpd did not become ready within ${timeoutMs / 1000} s; see ${path.join(alpHome(), 'logs')}`);
}

/** The installed service for this ALP_HOME, if any. */

async function installed() {
  const service = serviceFor({ home: alpHome() });
  return service && await installedProgram(service) ? service : undefined;
}

/** Starts alpd: through its service when installed, so the service keeps it running; else detached. */

async function start() {
  await built();
  return startDaemon({ home: alpHome(), entry: DAEMON_ENTRY });
}

/** Connects to a running daemon without starting one. */

async function running() {
  const lock = await readLock(alpHome());
  if (!lockAlive(lock) || !lock.ready) throw new Error('alpd is not running; start it with: alp daemon start');
  return connect(lock.socket, { name: 'alp-cli', version: '1' });
}

async function stop() {
  const home = alpHome();
  const lock = await readLock(home);
  if (!lockAlive(lock)) return false;
  const client = await connect(lock.socket, { name: 'alp-cli', version: '1' });
  await client.request('daemon.shutdown').finally(() => client.close());
  for (let i = 0; i < 150 && lockAlive(await readLock(home)); i++) await new Promise(resolve => setTimeout(resolve, 100));
  return true;
}

async function daemon([action, ...rest]) {
  // alpd itself in this process; its own options (--detach, --service, --startup-timeout=MS) follow.
  if (action === 'run') { await built(); return runRole('daemon', DAEMON_ENTRY, rest); }
  if (rest.length && !(action === 'status' && rest.length === 1 && rest[0] === '--json')) throw new UsageError();
  if (action === 'start') {
    const socket = await start();
    const lock = await readLock(alpHome());
    console.log(`alpd ${lock.version} running (pid ${lock.pid}) on ${socket}`);
  } else if (action === 'stop') {
    // Publish intent before waiting for a launch, then drain that launch before
    // reading its lock. No detached child can arrive after this stop resolves.
    await holdDaemon(alpHome());
    const stopped = await withDaemonLifecycle(alpHome(), 'stop', async () => {
      const stopped = await stop();
      await holdDaemon(alpHome());
      return stopped;
    });
    console.log(stopped ? `alpd stopped; it stays stopped until alp daemon start, a prompt in Paseo, or ${await installed() ? 'the next login' : 'Paseo starting again'}` : 'alpd is not running');
  } else if (action === 'restart') {
    const client = await running().catch(() => undefined);
    const status = client && await client.request('daemon.status').finally(() => client.close());
    await stop();
    await daemon(['start']);
    // Running work is kept on stop and continued at start (ALPD §31).
    if (status?.sessions) console.log(`${status.sessions} live sessions were open; alpd reopens what was still working`);
  } else if (action === 'install') {
    await built();
    const service = serviceFor({ home: alpHome() });
    if (!service) throw new Error(`alp daemon install supports macOS (launchd) and Linux (systemd), not ${process.platform}`);
    // The service's alpd takes over; running work continues in it (ALPD §31).
    const replaced = await stop();
    await installService(service, { home: alpHome(), entry: DAEMON_ENTRY });
    await ready();
    const lock = await readLock(alpHome());
    console.log(`alpd installed as ${service.kind === 'launchd' ? 'a LaunchAgent' : 'a systemd user service'} (${service.name}, ${service.file})`);
    console.log(`alpd ${lock.version} running (pid ${lock.pid}); it starts at login and again after a crash${replaced ? '; the alpd that ran before handed its work over' : ''}`);
  } else if (action === 'uninstall') {
    const service = serviceFor({ home: alpHome() });
    if (!service || !await uninstallService(service)) {
      console.log('alpd is not installed as a service');
      return;
    }
    // Unloading stops alpd cleanly; wait for it to let go of its lock.
    for (let i = 0; i < 150 && lockAlive(await readLock(alpHome())); i++) await new Promise(resolve => setTimeout(resolve, 100));
    console.log(`alpd service ${service.name} removed and alpd stopped; alp daemon start runs it without a service`);
  } else if (action === 'status') {
    // Exit codes: 0 ready, 3 not running, 4 alive but not ready (or not answering).
    const json = rest[0] === '--json';
    const lock = await readLock(alpHome());
    if (!lockAlive(lock) || lock.maintenance) {
      // A backup or a restore holds alpd's lock while alpd is stopped (ALPD §68).
      const busy = lockAlive(lock) ? { maintenance: lock.maintenance, pid: lock.pid } : {};
      if (json) console.log(JSON.stringify({ running: false, live: false, ready: false, ...busy }));
      else console.log(busy.maintenance ? `alpd is not running: alp ${busy.maintenance} runs (pid ${busy.pid})` : 'alpd is not running');
      process.exitCode = 3;
      return;
    }
    const client = await connect(lock.socket, { name: 'alp-cli', version: '1' }).catch(error => {
      if (json) console.log(JSON.stringify({ running: true, live: true, ready: false, pid: lock.pid, checks: [{ id: 'ipc', ok: false, code: 'ALP_IPC_FAILED', message: scrubText(error.message) }] }));
      else console.log(`alpd (pid ${lock.pid}) is running but not answering on ${lock.socket}: ${scrubText(error.message)}; alp doctor says more`);
      process.exitCode = 4;
    });
    if (!client) return;
    const status = await client.request('daemon.status').finally(() => client.close());
    const health = status.health ?? { live: true, ready: lock.ready === true, checks: [] };
    if (json) {
      console.log(JSON.stringify({ running: true, ...status, health }));
    } else {
      console.log(`alpd ${status.version} running (pid ${status.pid}) since ${status.startedAt}; ${status.sessions} live sessions; socket ${lock.socket}`);
      console.log(health.ready ? 'ready' : `not ready: ${health.checks.filter(check => !check.ok).map(check => `${check.code ?? check.id} (${scrubText(check.message ?? 'failed')})`).join(', ') || 'starting'}`);
      if (status.previousExit?.kind === 'crash') console.log(`the alpd before it stopped unexpectedly${status.previousExit.at ? ` around ${status.previousExit.at}` : ''}`);
      const service = await installed();
      if (service) console.log(`managed by ${service.kind} as ${service.name}`);
    }
    if (!health.ready) process.exitCode = 4;
  } else {
    throw new UsageError();
  }
}

/** Human-readable event stream; one line per finished item, indented by tree depth. */

export { built, ready, installed, start, running, stop, daemon };
