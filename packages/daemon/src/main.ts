import { spawn } from 'node:child_process';
import { fstatSync, openSync, writeSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import templates from 'alp:templates';
import { alpHome, daemonPaths, assertPrivateDirectory, PROTOCOL_VERSION, withDaemonLifecycle } from '@anhlp/alp-client/index';
import { attachmentStageDir, createAlpRuntime, liveProbes, ModelCatalog, reclaimCopies, reclaimWorktrees, setActiveCatalog } from '@anhlp/alp-runtime/index';
import { createDaemonServer } from './server.js';
import { acquireLock, heartbeat, releaseLock, updateLock } from './lock.js';
import { createStore } from './store.js';
import { createDiskGuard, guardOutput, isDiskError } from './disk.js';
import { readAttachmentConfig } from './attachments.js';
import { validateUserSettings } from '@anhlp/alp-core/validation';
import { clearRestoredMarker, readRestoredMarker, recoverInterruptedRestore } from '@anhlp/alp-core/backup';
import { migrateState } from '@anhlp/alp-core/migrations';
import { createLogger } from '@anhlp/alp-core/log';

declare const __ALP_VERSION__: string;
const VERSION = typeof __ALP_VERSION__ === 'string' ? __ALP_VERSION__ : '0.0.0-dev';
const LOG_BYTES = 10 * 1024 * 1024;
const LOG_FILES = 3;
const log = createLogger({ component: 'alpd' });

async function rotate(log: string) {
  const size = await stat(log).then(info => info.size, () => 0);
  if (size < LOG_BYTES) return;
  for (let index = LOG_FILES - 1; index >= 1; index--) {
    await rename(index === 1 ? log : `${log}.${index - 1}`, `${log}.${index}`).catch(() => {});
  }
}

/** The launcher owns its detached child until that child acknowledges readiness or exits.
 * A ready lock belonging to some other process cannot settle this launch.
 */
async function detach(home: string) {
  await assertPrivateDirectory(home, { create: true });
  const { log } = daemonPaths(home);
  await assertPrivateDirectory(path.dirname(log), { create: true });
  await rotate(log);
  const output = await open(log, 'a', 0o600);
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    stdio: ['ignore', output.fd, output.fd, 'ipc'],
    env: process.env,
    windowsHide: true,
  });
  await output.close();
  await new Promise<void>((resolve, reject) => {
    const requested = Number(process.argv.find(arg => arg.startsWith('--startup-timeout='))?.split('=')[1]);
    const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : 15_000;
    let timedOut = false;
    let force: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      force = setTimeout(() => child.kill('SIGKILL'), 1_000);
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); clearTimeout(force); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(force);
      reject(new Error(timedOut ? `alpd startup timed out after ${timeoutMs} ms` : `alpd exited during startup (${code ?? signal})`));
    });
    child.once('message', message => {
      if (message !== 'alpd.ready' || timedOut) return;
      clearTimeout(timer);
      child.disconnect();
      child.unref();
      resolve();
    });
  });
}

/**
 * Under a service manager (ALPD §37), which holds alpd's stdout open: alpd rotates its
 * log at start as the detached launcher does, then writes its output there itself. The
 * manager's own file keeps only what Node prints when it dies.
 */
async function serviceLog(home: string) {
  await assertPrivateDirectory(home, { create: true });
  const { log } = daemonPaths(home);
  await assertPrivateDirectory(path.dirname(log), { create: true });
  await rotate(log);
  const fd = openSync(log, 'a', 0o600);
  for (const stream of [process.stdout, process.stderr]) {
    stream.write = ((chunk: string | Uint8Array, encoding?: unknown, callback?: unknown) => {
      try { if (typeof chunk === 'string') writeSync(fd, chunk); else writeSync(fd, chunk); } catch {}
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') done();
      return true;
    }) as typeof stream.write;
  }
}

/**
 * The user's alpd settings in $ALP_HOME/settings.json; none when it is missing.
 * Invalid settings are logged and alpd starts with the defaults, so a typo never
 * keeps it from running; alp doctor reports them too.
 */
async function userSettings(home: string): Promise<any> {
  const file = path.join(home, 'settings.json');
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch { return {}; }
  try { return validateUserSettings(JSON.parse(text), file); }
  catch (error: any) {
    log.warn(`ignoring ${file}: ${error?.message ?? error}`, { code: 'ALP_SETTINGS_INVALID' });
    return {};
  }
}

/**
 * How the previous alpd ended (ALPD §31). A running alpd keeps a marker file and
 * touches it with its heartbeat; a clean stop removes it last. A marker found at
 * start means the previous alpd crashed, around the marker's last touch.
 */
async function previousExit(marker: string): Promise<{ kind: 'clean' | 'crash'; at?: string }> {
  const info = await stat(marker).catch(() => undefined);
  return info ? { kind: 'crash', at: info.mtime.toISOString() } : { kind: 'clean' };
}

/** Whether a process group `id` exists; on POSIX a pid is never reused while its group lives. */
function groupAlive(id: number) {
  try { process.kill(-id, 0); return true; } catch (error: any) { return error?.code === 'EPERM'; }
}

/** alpd leads its own process group when started detached or by a service manager. */
const leadsGroup = () => process.platform !== 'win32' && groupAlive(process.pid);

/**
 * Stops what a crashed alpd left running (ALPD §66): its provider processes normally exit
 * when their stdin closes, but a stuck one, or a command an agent started, can outlive it.
 * They stay in the crashed alpd's process group, so alpd ends that group when the crashed
 * one led its group and this one leads its own (so it is not a member). Not on Windows.
 */
async function stopLeftovers(previous: { pid?: number; groupLeader?: boolean } | undefined) {
  const pid = previous?.pid;
  if (!previous?.groupLeader || !Number.isSafeInteger(pid) || pid === process.pid || !leadsGroup() || !groupAlive(pid!)) return;
  log.warn(`stopping processes the previous alpd (pid ${pid}) left running`, { code: 'ALP_LEFTOVER_PROCESSES', previousPid: pid });
  const signal = (name: NodeJS.Signals) => { try { process.kill(-pid!, name); } catch {} };
  signal('SIGTERM');
  for (let waited = 0; waited < 3000 && groupAlive(pid!); waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
  if (groupAlive(pid!)) signal('SIGKILL');
}

/** Where start-up stands, so a failure says which step it stopped at. */
type Phase = 'home' | 'lock' | 'state' | 'recovery' | 'listen' | 'ready';
let phase: Phase = 'home';
const STARTUP_CODES = { home: 'ALP_HOME_UNUSABLE', lock: 'ALP_LOCK_FAILED', state: 'ALP_STATE_UNUSABLE', recovery: 'ALP_STARTUP_FAILED', listen: 'ALP_IPC_LISTEN_FAILED', ready: 'ALP_STARTUP_FAILED' } as const;

/**
 * Before anything reads or writes the state (ALPD §68): a restore cut short is settled, a
 * state of a newer schema is refused untouched, an older one is migrated forward, and a
 * restore's marker says to continue no work by itself this time; it is cleared once alpd is
 * ready, so a start that fails keeps it for the next.
 */
async function openState(home: string) {
  const settled = await recoverInterruptedRestore(home);
  if (settled) log.warn(`a restore from ${settled.file} was cut short and has been ${settled.outcome}`, { code: 'ALP_RESTORE_SETTLED', outcome: settled.outcome });
  const migrated = await migrateState(home, { by: `alpd ${VERSION}`, log });
  for (const step of migrated.steps) log.info(`state migrated from schema ${step.from} to ${step.to} (${step.name}); the state before it is in ${step.backup}`, { code: 'ALP_STATE_MIGRATED', from: step.from, to: step.to, migration: step.name });
  const restored = await readRestoredMarker(home);
  if (restored) log.info(`state restored${restored.from ? ` from ${restored.from}` : ''}; sessions that were working wait for the user`, { code: 'ALP_STATE_RESTORED' });
  return { restored: !!restored };
}

async function run(home: string) {
  await assertPrivateDirectory(home, { create: true });
  phase = 'lock';
  const { socket } = daemonPaths(home);
  let lock;
  try {
    lock = await acquireLock(home, { version: VERSION, protocolVersion: PROTOCOL_VERSION, socket });
  } catch (error: any) {
    // Under a service manager, another alpd serving this home is no failure to retry.
    if (process.argv.includes('--service') && /already running|ALP is busy/.test(error?.message ?? '')) {
      log.info(`${error.message}; this one exits`, { code: 'ALP_LOCK_HELD' });
      process.exit(0);
    }
    throw error;
  }
  phase = 'state';
  let opened;
  try {
    opened = await openState(home);
  } catch (error) {
    await releaseLock(home);
    throw error;
  }
  phase = 'recovery';
  // First: nothing a crashed alpd left running may still write while this one recovers.
  const marker = path.join(home, 'state', 'alpd.running');
  const exit = await previousExit(marker);
  if (exit.kind === 'crash') {
    log.warn(`the previous alpd stopped unexpectedly around ${exit.at}`, { code: 'ALP_PREVIOUS_CRASH', at: exit.at });
    await stopLeftovers(await readFile(marker, 'utf8').then(JSON.parse).catch(() => undefined));
  }
  await mkdir(path.dirname(marker), { recursive: true, mode: 0o700 });
  await writeFile(marker, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), groupLeader: leadsGroup() }), { mode: 0o600 });
  const runLogDir = process.env.ALP_RUN_LOG_DIR || path.join(home, 'runs');
  const worktreeDir = path.join(home, 'worktrees');
  // Worktrees of assignments a crash interrupted: their work goes to their branches.
  for (const branch of await reclaimWorktrees(worktreeDir).catch(() => [] as string[])) log.info(`kept interrupted work on branch ${branch}`, { event: 'worktree.kept', branch });
  // Review copies of interrupted assignments hold nothing to keep.
  const copyDir = path.join(home, 'copies');
  await reclaimCopies(copyDir).catch(() => 0);
  // Requested starts lift the existing hold before launching. Never erase a stop
  // published while this daemon was starting.
  const settings = await userSettings(home);
  const runtime = createAlpRuntime({
    templates, runLogDir, worktreeDir, copyDir, boardDir: path.join(home, 'boards'), libraryDir: home,
    // Read-only copies of attached files for the sessions' tools (§12.6); not on Windows, as the store.
    ...(process.platform !== 'win32' ? { attachmentStageDir: attachmentStageDir(home) } : {}),
    assignmentResultFile: path.join(home, 'state', 'assignment-results.json'), recallFile: path.join(home, 'state', 'recall.json'), pauseFile: path.join(home, 'state', 'pause.json'), liveFile: path.join(home, 'state', 'live.json'),
    autoResume: settings?.limits?.autoResume !== false, recoveryResume: settings?.recovery?.autoResume !== false && !opened.restored, previousExit: exit,
  });
  // A full disk pauses ALP's work instead of stopping alpd (t-2831).
  const disk = createDiskGuard({ home, runtime, log });
  diskReport = error => { disk.report(error); };
  const store = createStore(path.join(home, 'state'), { onWriteError: error => { disk.report(error); } });
  let stopping: Promise<void> | undefined;
  const shutdown = (code = 0) => {
    stopping ??= (async () => {
      const force = setTimeout(() => process.exit(code), 10_000);
      force.unref();
      clearInterval(beat);
      disk.stop();
      modelCatalog?.stop();
      await server.close().catch(() => {});
      await runtime.shutdown().catch(() => {});
      await store.flush();
      // Last: what remains is a clean stop.
      await unlink(marker).catch(() => {});
      await releaseLock(home);
      log.info('alpd stopped', { event: 'stopped', exitCode: code });
      process.exit(code);
    })();
    return stopping;
  };
  // The operator may lower the attachment limits (never raise them): <ALP_HOME>/attachments.json.
  const attachmentConfig = await readAttachmentConfig(home);
  for (const problem of attachmentConfig.problems) log.warn(problem, { code: 'ALP_ATTACHMENT_CONFIG' });
  // The live model catalog (t-e5ee): static rows at once, provider lists in the background, every 6 h.
  // ALP_MODEL_CATALOG=static keeps the static rows only (tests, offline hosts).
  const modelCatalog = process.env.ALP_MODEL_CATALOG === 'static' ? undefined : new ModelCatalog({ home, probes: liveProbes() });
  setActiveCatalog(modelCatalog);
  void modelCatalog?.start().catch(() => {});
  const server = createDaemonServer({ runtime, socketPath: socket, version: VERSION, store, runLogDir, previousExit: exit, home, templates, attachmentOptions: { limits: attachmentConfig.limits }, modelCatalog, onShutdown: () => void shutdown() });
  const beat = setInterval(() => {
    void heartbeat(home).then(owned => { if (!owned) void shutdown(1); });
    const now = new Date();
    void utimes(marker, now, now).catch(() => {});
  }, 30_000);
  beat.unref();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => void shutdown());
  // A write the disk refused is no reason to stop: the disk guard pauses work until it takes writes again.
  process.on('uncaughtException', error => { if (disk.report(error)) return; log.error('uncaught exception; alpd stops', { code: 'ALP_FATAL', error }); void shutdown(1); });
  process.on('unhandledRejection', error => { if (disk.report(error)) return; log.error('unhandled rejection; alpd stops', { code: 'ALP_FATAL', error }); void shutdown(1); });
  phase = 'listen';
  try {
    await server.listen();
  } catch (error) {
    await releaseLock(home);
    throw error;
  }
  phase = 'ready';
  // Web app and relay are owned by the optional Paseo integration process.
  await updateLock(home, { ...lock, ready: true });
  // Clients that cannot locate alpd themselves (the Paseo plugin) start it from here next time.
  const { install } = daemonPaths(home);
  await writeFile(`${install}.tmp`, JSON.stringify({ entry: fileURLToPath(import.meta.url), version: VERSION }), { mode: 0o600 })
    .then(() => rename(`${install}.tmp`, install))
    .catch(error => log.warn('could not record alpd\'s location', { code: 'ALP_INSTALL_RECORD_FAILED', error }));
  if (opened.restored) await clearRestoredMarker(home).catch(error => log.warn('could not clear the restore marker', { code: 'ALP_STATE_RESTORED', error }));
  disk.start();
  if (process.connected) process.send?.('alpd.ready');
  log.info(`alpd ${VERSION} ready on ${socket} (pid ${process.pid})`, { event: 'ready', version: VERSION, pid: process.pid });
}

const home = alpHome();
/** Where a failed write to alpd's own output goes once the disk guard exists. */
let diskReport = (_error: unknown) => {};
// Before anything logs: a log write the full disk refused must not end alpd (t-2831).
guardOutput(error => { if (isDiskError(error)) diskReport(error); }, { fstatSync, writeSync });
try {
  if (process.argv.includes('--detach')) await detach(home);
  else {
    // A direct foreground/login invocation is an explicit start. Do this before
    // admission registration, so a stop published during startup is preserved.
    if (!process.connected) await unlink(path.join(home, 'state', 'alpd.held')).catch(() => {});
    if (process.argv.includes('--service')) await serviceLog(home);
    if (process.connected) await run(home);
    else {
      // Retain admission through readiness even if the requesting service client
      // times out. An invocation without a requester (including login) is explicit.
      await withDaemonLifecycle(home, 'start', async () => {
        await run(home);
      }, { joinStart: true });
    }
  }
} catch (error: any) {
  // The log says where start-up stopped; alp doctor reads it from there.
  const stoppedIn = phase as Phase;
  // Opening the state fails with the state's own code (a newer schema, a failed migration).
  const code = /already running|ALP is busy/.test(error?.message ?? '') ? 'ALP_LOCK_HELD'
    : stoppedIn === 'state' && typeof error?.code === 'string' && /^[A-Z_]+$/.test(error.code) ? `ALP_${error.code}` : STARTUP_CODES[stoppedIn];
  log.error(`alpd failed to start while ${{ home: 'preparing its home', lock: 'taking its lock', state: 'opening its state', recovery: 'recovering earlier work', listen: 'opening its IPC endpoint', ready: 'finishing start-up' }[stoppedIn]}${stoppedIn === 'state' ? `: ${error?.message ?? error}` : ''}`, { code, phase: stoppedIn, error });
  process.exit(1);
}
