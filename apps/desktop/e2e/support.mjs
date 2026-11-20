/**
 * The desktop e2e's fixtures (docs/alp/desktop.md §5): a disposable alp web host and a fake `alp`.
 *
 * - The host is the built service, packages/cli/dist/alp-web.js, run under a scratch ALP_HOME (and
 *   HOME) with its own web.port and ALP_SUPERVISE=0: the real listener, built app and link token,
 *   with no alpd. Never the user's ~/.alp.
 * - The fake `alp` is a shell script the test rewrites at will: it prints the host's address, fails,
 *   or waits first. The app finds it through ALP_DESKTOP_ALP.
 * - Every resource is undone through test/support/teardown.js's `defer`, in reverse order: Electron
 *   closes and the host stops before their directory is removed.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { _electron } from 'playwright-core';
import { fixtureProcesses } from '../../../test/support/fixture-processes.js';
import { teardown } from '../../../test/support/teardown.js';
import { hermeticEnv } from '../../../scripts/test-lib.mjs';

export const APP = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(APP, '..', '..');
export const SERVICE = process.env.ALP_DESKTOP_E2E_SERVICE || path.join(ROOT, 'packages/cli/dist/alp-web.js');
/** The Electron binary of apps/desktop's own install (require('electron') gives its path). */
const ELECTRON = createRequire(path.join(APP, 'package.json'))('electron');

/** Polls `probe` until it answers something truthy; fails after `timeoutMs`. */
export async function waitFor(probe, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { const value = await probe(); if (value) return value; last = value; } catch (error) { last = error; }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await sleep(100);
  }
}

/** A loopback port that is free right now (alp web tries it and the next nine), other than `not`. */
export async function freePort(...not) {
  for (;;) {
    const port = await anyFreePort();
    if (!not.some(other => Math.abs(other - port) < 10)) return port;
  }
}

async function anyFreePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** One scratch directory for a test, removed last. */
export async function scratch(t) {
  const defer = teardown(t);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'alp-desktop-e2e-'));
  defer(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return { dir, defer };
}

/**
 * The environment without anything that would change how Electron or alp run: the caller's ALP
 * session variables go (hermeticEnv, as the root test runner does, t-bf7f), so a run from an
 * agent's shell behaves as the user's. The host still only ever sees a scratch ALP_HOME and HOME.
 */
function cleanEnv() {
  const env = hermeticEnv(process.env);
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ALP_HOME', 'NODE_OPTIONS', 'ALP_DESKTOP_ALP', 'ALP_DESKTOP_USER_DATA']) delete env[name];
  return env;
}

/**
 * A disposable alp web host. `start(port)` runs the service on that web.port and resolves once
 * web.json names it; `stop()` ends it (SIGTERM, its graceful exit); `rotate()` replaces the token
 * the way `alp web rotate` does (the service must be stopped).
 */
export async function host(t, { dir, defer }) {
  const home = path.join(dir, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const processes = await fixtureProcesses(home);
  // Registered after the directory: stops every process the fixture admitted before it is removed.
  defer(() => processes.stop());
  const env = { ...cleanEnv(), ...processes.env, HOME: dir, ALP_SUPERVISE: '0' };
  let child;
  const log = () => readFile(path.join(home, 'logs', 'integrations', 'alp-web.log'), 'utf8').catch(() => '(no log)');
  const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
  const self = {
    home,
    web: undefined,
    get address() { return `${self.web.url}#token=${self.web.token}`; },
    get origin() { return `http://127.0.0.1:${self.web.port}`; },
    async start(port) {
      await writeFile(path.join(home, 'settings.json'), JSON.stringify({ web: { port } }));
      const started = spawn(process.execPath, [SERVICE, '--service'], { env, stdio: 'ignore' });
      child = started;
      self.web = await waitFor(async () => {
        if (started.exitCode !== null) throw new Error(`alp-web exited ${started.exitCode}:\n${await log()}`);
        const lock = await readJson(path.join(home, 'integrations', 'web.lock')).catch(() => undefined);
        const info = await readJson(path.join(home, 'web.json')).catch(() => undefined);
        return lock?.ready && lock.pid === started.pid && info?.pid === started.pid ? info : undefined;
      }, 'alp-web to become ready');
      return self;
    },
    async stop() {
      const running = child;
      child = undefined;
      if (!running || running.exitCode !== null || running.signalCode !== null) return;
      const exited = once(running, 'exit');
      running.kill('SIGTERM');
      const timer = setTimeout(() => running.kill('SIGKILL'), 15_000);
      try { await exited; } finally { clearTimeout(timer); }
    },
    async rotate() {
      const rotating = spawn(process.execPath, [SERVICE, '--rotate'], { env, stdio: 'ignore' });
      const [code] = await once(rotating, 'exit');
      if (code !== 0) throw new Error(`alp-web --rotate exited ${code}:\n${await log()}`);
      self.web = await readJson(path.join(home, 'web.json'));
    },
  };
  defer(() => self.stop());
  return self;
}

/**
 * A fake `alp` at <dir>/bin/alp. `set(script)` replaces what `alp web --print` does (a /bin/sh
 * body); anything other than `web --print` exits 64.
 */
export async function fakeAlp({ dir }) {
  const file = path.join(dir, 'bin', 'alp');
  await mkdir(path.dirname(file), { recursive: true });
  const set = async body => {
    await writeFile(file, `#!/bin/sh\n[ "$1 $2" = "web --print" ] || exit 64\n${body}\n`);
    await chmod(file, 0o755);
  };
  /** Prints `address` after `delay` seconds. */
  const prints = (address, delay = 0) => set(`${delay ? `sleep ${delay}\n` : ''}printf '%s\\n' '${address}'`);
  /**
   * The first run waits `delay` seconds, prints `late`, then writes <dir>/bin/first-done; every later
   * run prints `address` at once. `firstStarted()` and `firstDone()` say where the first run is.
   */
  const firstSlow = async (late, delay, address) => {
    const count = path.join(dir, 'bin', 'count');
    const done = path.join(dir, 'bin', 'first-done');
    await set([
      `n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n + 1)); echo $n > '${count}'`,
      `if [ "$n" = 1 ]; then sleep ${delay}; printf '%s\\n' '${late}'; : > '${done}'; exit 0; fi`,
      `printf '%s\\n' '${address}'`,
    ].join('\n'));
    const exists = file => access(file).then(() => true, () => false);
    // The order of runs is the order they read the count: wait for `firstStarted` before starting a
    // second connect, or the newer connect's run could be the slow one.
    return { firstStarted: () => exists(count), firstDone: () => exists(done) };
  };
  await set('exit 70');
  return { file, set, prints, firstSlow };
}

/** A copy of the built app (package.json and dist) that a test may break. */
export async function appCopy({ dir }) {
  const copy = path.join(dir, 'app');
  await mkdir(copy, { recursive: true });
  await cp(path.join(APP, 'package.json'), path.join(copy, 'package.json'));
  await cp(path.join(APP, 'dist'), path.join(copy, 'dist'), { recursive: true });
  return copy;
}

/** The environment the app runs with: the fake alp, a scratch profile, no ELECTRON_RUN_AS_NODE. */
export function appEnv({ dir }, alp) {
  // A scratch HOME too: nothing Electron writes under ~ (logs, caches) lands in the user's.
  return { ...cleanEnv(), HOME: path.join(dir, 'app-home'), ALP_DESKTOP_ALP: alp, ALP_DESKTOP_USER_DATA: path.join(dir, 'user-data') };
}

/** Launches the app; it is closed before the host stops and the directory goes. */
export async function launch(t, context, alp, { app = APP } = {}) {
  await mkdir(path.join(context.dir, 'app-home'), { recursive: true });
  const electronApp = await _electron.launch({ executablePath: ELECTRON, args: [app], env: appEnv(context, alp), timeout: 30_000 });
  // Bounded: a close that hangs is ended with SIGKILL, so the steps after it still run.
  context.defer(async () => {
    let timer;
    const closed = electronApp.close().then(() => true, () => false);
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(false), 15_000); });
    const ok = await Promise.race([closed, late]);
    clearTimeout(timer);
    if (!ok) electronApp.process().kill('SIGKILL');
  });
  return electronApp;
}

/** Starts a second instance of the app with the same profile; resolves with its exit code. */
export function secondInstance(context, alp, { app = APP } = {}) {
  const child = spawn(ELECTRON, [app], { env: appEnv(context, alp), stdio: 'ignore' });
  context.defer(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return once(child, 'exit').then(([code]) => code);
}

/**
 * The app's windows as the main process sees them: what each shows, never the address itself (it
 * may still carry the token). `page` is the bundled page's file name, or undefined on alp web.
 */
export function windows(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => {
    const raw = window.webContents.getURL();
    let url;
    try { url = new URL(raw); } catch { return { visible: window.isVisible(), origin: '', page: undefined, token: false }; }
    return {
      visible: window.isVisible(),
      origin: url.protocol === 'file:' ? 'file://' : url.origin,
      page: url.protocol === 'file:' ? url.pathname.split('/').pop() : undefined,
      token: url.hash.includes('token='),
    };
  }));
}

/** The single window's state, or undefined while there is not exactly one. */
export async function only(electronApp) {
  const list = await windows(electronApp);
  return list.length === 1 ? list[0] : undefined;
}

/** Runs `script` in the page of the app's single window. */
export function inPage(electronApp, script) {
  return electronApp.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0]?.webContents.executeJavaScript(code), script);
}

/** Clicks File › Connect again. */
export function connectAgain(electronApp) {
  return electronApp.evaluate(({ Menu }) => {
    const file = Menu.getApplicationMenu()?.items.find(item => item.label === 'File');
    const item = file?.submenu?.items.find(entry => entry.label === 'Connect again');
    if (!item) throw new Error('no File › Connect again');
    item.click();
  });
}

/** Closes every window (the app keeps running, as on macOS). */
export function closeWindows(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => { for (const window of BrowserWindow.getAllWindows()) window.close(); });
}

/** Waits until the single window shows alp web at `origin` with the token taken out by apps/web. */
export function connectedTo(electronApp, origin, timeoutMs = 30_000) {
  return waitFor(async () => {
    const state = await only(electronApp);
    if (!state || state.origin !== origin || state.token || !state.visible) return false;
    return inPage(electronApp, "sessionStorage.getItem('alp-web:link-token') !== null");
  }, `the window on ${origin} with the token taken out of the address`, timeoutMs);
}
