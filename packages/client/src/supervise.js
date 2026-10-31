import { mkdir, unlink, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { daemonStartTimeoutMs, ensureDaemon, lockAlive, readLock, withDaemonLifecycle } from './index.js';
import { installedProgram, serviceFor, startService } from './service.js';

/**
 * Keeping alpd up (ALPD §40). Whoever starts alpd goes through its login service when
 * one is installed, so the service keeps managing it; otherwise alpd starts detached.
 * A deliberate `alp daemon stop` leaves a hold, which watchers respect: they start
 * alpd again only when someone asks for it.
 */

const holdFile = home => path.join(home, 'state', 'alpd.held');

/** Records that the user stopped alpd on purpose. */
export async function holdDaemon(home, by = 'alp daemon stop') {
  await mkdir(path.dirname(holdFile(home)), { recursive: true, mode: 0o700 });
  await writeFile(holdFile(home), JSON.stringify({ by, at: new Date().toISOString() }) + '\n', { mode: 0o600 });
}

export async function releaseHold(home) {
  await unlink(holdFile(home)).catch(() => {});
}

export async function daemonHeld(home) {
  return stat(holdFile(home)).then(() => true, () => false);
}

/** Polls until an alpd for `home` is ready; returns its socket. */
async function whenReady(home, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const lock = await readLock(home);
    if (lockAlive(lock) && lock.ready) return lock.socket;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`alpd did not become ready within ${timeoutMs / 1000} s; see ${path.join(home, 'logs')}`);
}

/**
 * Starts alpd for `home` unless it runs, and lifts a hold: someone asked for it.
 * Returns its socket. Waits up to `timeoutMs`, by default daemonStartTimeoutMs(env)
 * (ALP_DAEMON_START_TIMEOUT_MS, else 60 s).
 */
export async function startDaemon({ home, entry, env = process.env, timeoutMs = daemonStartTimeoutMs(env), automatic = false, signal }) {
  return withDaemonLifecycle(home, 'start', async () => {
    signal?.throwIfAborted();
    if (automatic) {
      if (await daemonHeld(home)) return;
    } else await releaseHold(home);
    const lock = await readLock(home);
    signal?.throwIfAborted();
    if (lockAlive(lock)) return lock.ready ? lock.socket : whenReady(home, timeoutMs, signal);
    const service = serviceFor({ home, env });
    if (service && await installedProgram(service)) {
      signal?.throwIfAborted();
      await startService(service);
      return whenReady(home, timeoutMs, signal);
    }
    return ensureDaemon({ home, entry, env, timeoutMs, lifecycleLocked: true, signal });
  }, { signal });
}

/**
 * Starts alpd now and starts it again whenever it is found down on `misses` checks in a
 * row, `intervalMs` apart, unless the user holds it. Two misses let `alp daemon restart`
 * and `install` finish their own stop and start first. Returns a function that stops
 * watching, and resolves once a start it began has settled; alpd keeps running. `by` names the
 * caller in the log line of the first start ("alpd started with <by>").
 */
export function superviseDaemon({ home, entry, env = process.env, intervalMs = 5_000, misses = 2, log = () => {}, by }) {
  let stopped = false;
  let missed = 0;
  let starting;
  // The first start is the caller's own request (it lifts a hold); later ones are automatic.
  const start = (reason, automatic = true) => {
    starting ??= startDaemon({ home, entry: typeof entry === 'function' ? entry() : entry, env, automatic })
      .then(socket => { if (socket) log(`alpd ${reason}`); }, error => log(`could not start alpd: ${error?.message ?? error}`))
      .finally(() => { starting = undefined; missed = 0; });
    return starting;
  };
  const check = async () => {
    if (stopped || starting) return;
    if (lockAlive(await readLock(home))) { missed = 0; return; }
    if (await daemonHeld(home)) { missed = 0; return; }
    // Stopped while this check looked: start nothing.
    if (++missed >= misses && !stopped) await start('was down; started it again');
  };
  // `by` names the supervising service in the log, for example `Paseo` or `alp web`.
  const initial = start(by ? `started with ${by}` : 'started', false);
  const timer = setInterval(() => { void check(); }, intervalMs);
  timer.unref?.();
  const stop = () => { stopped = true; clearInterval(timer); return starting ?? Promise.resolve(); };
  stop.started = initial;
  return stop;
}
