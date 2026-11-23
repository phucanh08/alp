/**
 * The desktop e2e's fixtures (docs/alp/desktop.md §5): a disposable alp dashboard host and a fake `alp`.
 *
 * - The host is the built service, packages/cli/dist/alp-dashboard.js, run under a scratch ALP_HOME (and
 *   HOME) with its own dashboard.port and ALP_SUPERVISE=0: the real listener, built app and link token,
 *   with no alpd. Never the user's ~/.alp.
 * - The fake `alp` is a shell script the test rewrites at will: it prints the host's address, fails,
 *   or waits first. The app finds it through ALP_DESKTOP_ALP.
 * - Every resource is undone through test/support/teardown.js's `defer`, in reverse order: Electron
 *   closes and the host stops before their directory is removed.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { _electron } from 'playwright-core';
import { fixtureProcesses } from '../../../test/support/fixture-processes.js';
import { readToken } from '../../../packages/cli/src/dashboard-service.js';
import { teardown } from '../../../test/support/teardown.js';
import { hermeticEnv } from '../../../scripts/test-lib.mjs';
import { spawnCommand } from '../../../scripts/spawn-command.mjs';

export const APP = path.resolve(import.meta.dirname, '..');
const ROOT = path.resolve(APP, '..', '..');
export const SERVICE = process.env.ALP_DESKTOP_E2E_SERVICE || path.join(ROOT, 'packages/cli/dist/alp-dashboard.js');
/** The Electron binary of apps/desktop's own install (require('electron') gives its path). */
const ELECTRON = createRequire(path.join(APP, 'package.json'))('electron');

/**
 * `promise`, or a rejection naming `what` after `timeoutMs`: a step that never settles (an evaluate in
 * a page that never answers, an executeJavaScript queued behind a load that never ends) fails fast and
 * says which step it was, instead of running into the test's own timeout with no message.
 */
export async function bounded(what, promise, timeoutMs = 30_000) {
  let timer;
  const late = new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`step did not settle within ${timeoutMs} ms: ${what}`)), timeoutMs); });
  try { return await Promise.race([promise, late]); } finally { clearTimeout(timer); }
}

/**
 * Polls `probe` until it answers something truthy; fails after `timeoutMs`. Each probe is itself
 * bounded by the time left, so a probe that hangs cannot hold the wait past its deadline.
 */
export async function waitFor(probe, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try { const value = await bounded(`a probe of ${what}`, Promise.resolve().then(probe), Math.max(1_000, deadline - Date.now())); if (value) return value; last = value; } catch (error) { last = error; }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await sleep(100);
  }
}

/** A loopback port that is free right now (alp dashboard tries it and the next nine), other than `not`. */
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
export function cleanEnv() {
  const env = hermeticEnv(process.env);
  for (const name of ['ELECTRON_RUN_AS_NODE', 'ALP_HOME', 'NODE_OPTIONS', 'ALP_DESKTOP_ALP', 'ALP_DESKTOP_USER_DATA', 'ALP_DESKTOP_INSTALL_MIRROR', 'ALP_INSTALL_BASE_URL', 'ALP_INSTALL_REPO', 'TMPDIR']) delete env[name];
  return env;
}

/**
 * A disposable alp dashboard host. `start(port)` runs the service on that dashboard.port and resolves once
 * dashboard.json names it, with the token it hands over its token socket (no file holds it, t-cee3);
 * `stop()` ends it (SIGTERM, its graceful exit); `rotate()` revokes every credential the way
 * `alp dashboard rotate` does (the service must be stopped; the next `start()` mints a new token, as
 * every start does).
 */
export async function host(t, { dir, defer }) {
  const home = path.join(dir, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const processes = await fixtureProcesses(home);
  // Registered after the directory: stops every process the fixture admitted before it is removed.
  defer(() => processes.stop());
  const env = { ...cleanEnv(), ...processes.env, HOME: dir, ALP_SUPERVISE: '0' };
  let child;
  const log = () => readFile(path.join(home, 'logs', 'integrations', 'alp-dashboard.log'), 'utf8').catch(() => '(no log)');
  const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
  const self = {
    home,
    web: undefined,
    get address() { return `${self.web.url}#token=${self.web.token}`; },
    get origin() { return `http://127.0.0.1:${self.web.port}`; },
    async start(port) {
      await writeFile(path.join(home, 'settings.json'), JSON.stringify({ dashboard: { port } }));
      const started = spawn(process.execPath, [SERVICE, '--service'], { env, stdio: 'ignore' });
      child = started;
      self.web = await waitFor(async () => {
        if (started.exitCode !== null) throw new Error(`alp-dashboard exited ${started.exitCode}:\n${await log()}`);
        const lock = await readJson(path.join(home, 'integrations', 'dashboard.lock')).catch(() => undefined);
        const info = await readJson(path.join(home, 'dashboard.json')).catch(() => undefined);
        if (!(lock?.ready && lock.pid === started.pid && info?.pid === started.pid)) return undefined;
        const answer = await readToken(home);
        return answer.pid === started.pid ? { ...info, token: answer.token } : undefined;
      }, 'alp-dashboard to become ready');
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
      if (code !== 0) throw new Error(`alp-dashboard --rotate exited ${code}:\n${await log()}`);
    },
  };
  defer(() => self.stop());
  return self;
}

/**
 * A fake `alp` at <dir>/bin/alp. `set(script)` replaces what `alp dashboard --print` does (a /bin/sh
 * body); anything other than `dashboard --print` exits 64.
 */
export async function fakeAlp({ dir }) {
  const file = path.join(dir, 'bin', 'alp');
  await mkdir(path.dirname(file), { recursive: true });
  let version = '';
  let current = '';
  const write = async () => {
    const answer = version ? `[ "$1" = --version ] && { printf '%s\\n' '${version}'; exit 0; }\n` : '';
    await writeFile(file, `#!/bin/sh\n${answer}[ "$1 $2" = "dashboard --print" ] || exit 64\n${current}\n`);
    await chmod(file, 0o755);
  };
  const set = async body => { current = body; await write(); };
  /** Makes `alp --version` print `value` (by default it exits 64, as anything else does). */
  const setVersion = async value => { version = value; await write(); };
  /** Prints `address` after `delay` seconds. */
  const prints = (address, delay = 0) => set(`${delay ? `sleep ${delay}\n` : ''}printf '%s\\n' '${address}'`);
  /**
   * A stale first run: the first `alp dashboard --print` blocks until the test calls `release()`, then
   * prints `late` and writes <dir>/bin/first-done; every later run prints `address` at once. The
   * test releases it only after the newer connect has finished, so the late answer always arrives
   * after it, however slow the machine (a fixed sleep could answer first and test nothing).
   * `firstStarted()` and `firstDone()` say where the first run is.
   */
  const firstGated = async (late, address) => {
    const count = path.join(dir, 'bin', 'count');
    const gate = path.join(dir, 'bin', 'gate');
    const done = path.join(dir, 'bin', 'first-done');
    await set([
      `n=$(cat '${count}' 2>/dev/null || echo 0); n=$((n + 1)); echo $n > '${count}'`,
      // Bounded (60 s), so a test that fails before release() leaves no shell polling behind.
      `if [ "$n" = 1 ]; then i=0; while [ ! -f '${gate}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i + 1)); done`,
      `  printf '%s\\n' '${late}'; : > '${done}'; exit 0; fi`,
      `printf '%s\\n' '${address}'`,
    ].join('\n'));
    const exists = file => access(file).then(() => true, () => false);
    // The order of runs is the order they read the count: wait for `firstStarted` before starting a
    // second connect, or the newer connect's run could be the blocked one.
    return { firstStarted: () => exists(count), release: () => writeFile(gate, ''), firstDone: () => exists(done) };
  };
  await set('exit 70');
  return { file, set, setVersion, prints, firstGated };
}

/** A copy of the built app (package.json and dist) that a test may break. */
export async function appCopy({ dir }) {
  const copy = path.join(dir, 'app');
  await mkdir(copy, { recursive: true });
  await cp(path.join(APP, 'package.json'), path.join(copy, 'package.json'));
  await cp(path.join(APP, 'dist'), path.join(copy, 'dist'), { recursive: true });
  return copy;
}

/**
 * The environment the app runs with: the fake alp (none when `alp` is undefined), a scratch HOME,
 * ALP_HOME and TMPDIR (t-81b0.8: whatever the app installs or starts stays under `dir`), a scratch
 * profile, no ELECTRON_RUN_AS_NODE; `extra` last.
 */
export function appEnv({ dir }, alp, extra = {}) {
  // A scratch HOME too: nothing Electron writes under ~ (logs, caches) lands in the user's.
  const home = path.join(dir, 'app-home');
  const env = { ...cleanEnv(), HOME: home, ALP_HOME: path.join(home, '.alp'), TMPDIR: path.join(dir, 'tmp'), ALP_DESKTOP_USER_DATA: path.join(dir, 'user-data'), ...extra };
  if (alp !== undefined) env.ALP_DESKTOP_ALP = alp;
  return env;
}

/**
 * Chromium switches of every automated launch. --use-mock-keychain: with a scratch HOME there is no
 * login keychain, and an app that asks for its cookie key (the packaged app's EnableCookieEncryption
 * fuse) would put a "Keychain Not Found" dialog on the user's screen; the mock keychain never asks.
 */
export const TEST_SWITCHES = ['--use-mock-keychain'];

/** Launches the app; it is closed before the host stops and the directory goes. */
export async function launch(t, context, alp, { app = APP, env = {} } = {}) {
  await mkdir(path.join(context.dir, 'app-home'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(context.dir, 'tmp'), { recursive: true });
  const electronApp = await _electron.launch({ executablePath: ELECTRON, args: [...TEST_SWITCHES, app], env: appEnv(context, alp, env), timeout: 30_000 });
  // The app's own output, reported with the test if the app died, so a crash on CI says why. A link token is masked
  // (the app never prints one, but Chromium could).
  let output = '';
  const keep = chunk => { output = (output + chunk).slice(-20_000); };
  electronApp.process().stdout?.on('data', keep);
  electronApp.process().stderr?.on('data', keep);
  // Reported only when the app ended before teardown closed it (a crash or an unexpected quit).
  let ended = false;
  let closing = false;
  electronApp.process().once('exit', (code, signal) => { if (!closing) ended = true; keep(`\n[app exited: code ${code}, signal ${signal}]\n`); });
  const masked = () => output.replace(/alpgw1\.[A-Za-z0-9_.-]+/g, 'alpgw1.<masked>');
  context.defer(() => { if (ended) t.diagnostic(`app output:\n${masked()}`); });
  // Bounded: a close that hangs is ended with SIGKILL, so the steps after it still run.
  context.defer(async () => {
    closing = true;
    let timer;
    const closed = electronApp.close().then(() => true, () => false);
    const late = new Promise(resolve => { timer = setTimeout(() => resolve(false), 15_000); });
    const ok = await Promise.race([closed, late]);
    clearTimeout(timer);
    if (!ok) electronApp.process().kill('SIGKILL');
  });
  /** The app's recent output (token masked), for a test to report when a step fails. */
  electronApp.alpOutput = masked;
  return electronApp;
}

/** Starts a second instance of the app with the same profile; resolves with its exit code. */
export function secondInstance(context, alp, { app = APP } = {}) {
  const child = spawn(ELECTRON, [...TEST_SWITCHES, app], { env: appEnv(context, alp), stdio: 'ignore' });
  context.defer(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return once(child, 'exit').then(([code]) => code);
}

/**
 * The app's windows as the main process sees them: what each shows, never the address itself (it
 * may still carry the token). `page` is the bundled page's file name, or undefined on alp dashboard.
 */
export function windows(electronApp) {
  return electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => {
    const raw = window.webContents.getURL();
    let url;
    try { url = new URL(raw); } catch { return { visible: window.isVisible(), origin: '', page: undefined, token: false }; }
    return {
      visible: window.isVisible(),
      origin: url.protocol === 'alp-page:' ? 'alp-page://app' : url.origin,
      page: url.protocol === 'alp-page:' ? url.pathname.split('/').pop() : undefined,
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

/** Waits until the single window shows alp dashboard at `origin` with the token taken out by apps/web. */
export function connectedTo(electronApp, origin, timeoutMs = 30_000) {
  return waitFor(async () => {
    const state = await only(electronApp);
    if (!state || state.origin !== origin || state.token || !state.visible) return false;
    return inPage(electronApp, "sessionStorage.getItem('alp-web:link-token') !== null");
  }, `the window on ${origin} with the token taken out of the address`, timeoutMs);
}

const exec = promisify(execFile);

/**
 * No `alp` anywhere the app looks (t-81b0.8): the scratch HOME has none, and SHELL is a fake login shell
 * that finds none, so neither the user's shell nor its PATH can hand the app the user's real alp. The
 * fixed directories outside HOME (/opt/homebrew/bin, /usr/local/bin) must not hold one either.
 */
export async function noAlpEnv({ dir }) {
  for (const fixed of ['/opt/homebrew/bin/alp', '/usr/local/bin/alp']) {
    if (await access(fixed).then(() => true, () => false)) throw new Error(`${fixed} exists: the app would find it, so this test cannot run here`);
  }
  const shell = path.join(dir, 'login-shell');
  await writeFile(shell, `#!/bin/sh\nprintf '__ALP_DESKTOP__\\n\\n%s\\n' "$PATH"\n`);
  await chmod(shell, 0o755);
  return { SHELL: shell };
}

/**
 * A local release mirror at <dir>/mirror in install.sh's layout (SHA256SUMS and one archive per macOS
 * architecture), read through file:// (ALP_DESKTOP_INSTALL_MIRROR, honoured only by an unpackaged app).
 * Each archive is a fake ALP bundle whose `alp --version` prints `version` and whose
 * `alp dashboard --print` prints `address`.
 */
export async function releaseMirror({ dir }, { version = '9.8.7', address }) {
  const mirror = path.join(dir, 'mirror');
  const work = path.join(dir, 'bundles');
  await mkdir(mirror, { recursive: true });
  const archives = [];
  const lines = [];
  for (const arch of ['arm64', 'x64']) {
    const name = `alp-${version}-darwin-${arch}`;
    const root = path.join(work, name);
    await mkdir(path.join(root, 'bin'), { recursive: true });
    await writeFile(path.join(root, 'alp-bundle.json'), JSON.stringify({ version }));
    await writeFile(path.join(root, 'bin', 'alp'), [
      '#!/bin/sh',
      `[ "$1" = --version ] && { printf '%s\\n' '${version}'; exit 0; }`,
      `[ "$1 $2" = "dashboard --print" ] && { printf '%s\\n' '${address}'; exit 0; }`,
      'exit 64',
    ].join('\n') + '\n');
    await chmod(path.join(root, 'bin', 'alp'), 0o755);
    const archive = path.join(mirror, `${name}.tar.gz`);
    // Through spawnCommand (t-ffe4.6): the system tar on macOS, which is all this e2e runs on.
    await exec(...spawnCommand('tar', ['-czf', archive, '-C', work, name]));
    archives.push(archive);
    lines.push(`${createHash('sha256').update(await readFile(archive)).digest('hex')}  ${name}.tar.gz`);
  }
  await writeFile(path.join(mirror, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  return {
    dir: mirror,
    version,
    /** Changes every archive after SHA256SUMS was written (a tampered or corrupted download). */
    tamper: async () => { for (const archive of archives) await writeFile(archive, Buffer.concat([await readFile(archive), Buffer.from('tampered')])); },
    /** Removes every archive (the download fails). */
    dropArchives: async () => { for (const archive of archives) await rm(archive); },
    dropSums: () => rm(path.join(mirror, 'SHA256SUMS')),
  };
}
