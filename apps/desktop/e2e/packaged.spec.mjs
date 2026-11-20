/**
 * The packaged app (t-81b0.3, docs/alp/desktop.md §6): ALP.app taken out of a DMG built by
 * `bun run dist`, installed into a scratch Applications directory and run against the same
 * disposable alp dashboard host and fake `alp` as shell.spec.mjs (./support.mjs). Never the user's
 * ~/.alp, ~/Applications or /Applications.
 *
 *   ALP_DESKTOP_DMG=release/ALP-0.0.0-arm64.dmg bun run e2e:packaged
 *
 * Playwright's `_electron` cannot drive the packaged app: it needs the Node inspector, which the
 * EnableNodeCliInspectArguments fuse turns off. The test reads the window over Chromium's DevTools
 * protocol instead (--remote-debugging-port, a Chromium switch no fuse covers).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { appEnv, fakeAlp, freePort, host, scratch, TEST_SWITCHES, waitFor } from './support.mjs';
import { hermeticEnv } from '../../../scripts/test-lib.mjs';
import { DESKTOP_BUNDLE_ID, readBundleId } from '../../../packages/cli/src/desktop.js';

const run = promisify(execFile);
const limit = { timeout: 180_000 };
const DMG = process.env.ALP_DESKTOP_DMG ? path.resolve(process.env.ALP_DESKTOP_DMG) : undefined;
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'cli.js');
/** The development Electron of apps/desktop's install: the control for the RunAsNode check. */
const DEV_ELECTRON = path.join(import.meta.dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');

/** Copies ALP.app out of the DMG into <dir>/home/Applications, as a user would; returns its path. */
async function install({ dir, defer }) {
  if (!DMG) throw new Error('set ALP_DESKTOP_DMG to the DMG built by `bun run dist`');
  const mount = path.join(dir, 'mnt');
  await mkdir(mount);
  await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, DMG]);
  let attached = true;
  const detach = async () => { if (attached) { attached = false; await run('hdiutil', ['detach', mount, '-force']); } };
  defer(detach);
  const applications = path.join(dir, 'home', 'Applications');
  await mkdir(applications, { recursive: true });
  const app = path.join(applications, 'ALP.app');
  await run('ditto', [path.join(mount, 'ALP.app'), app]);
  await detach();
  return app;
}

/**
 * The on-screen windows (owner pid and name only: no title or pixels, which need the Screen
 * Recording permission). A keychain or Gatekeeper prompt is a window of the app itself or of one of
 * the system agents below.
 */
async function screenWindows() {
  const script = `ObjC.import('CoreGraphics');
function run() {
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)));
  return JSON.stringify(list.map(w => ({ pid: w.kCGWindowOwnerPID, owner: w.kCGWindowOwnerName, layer: w.kCGWindowLayer })));
}`;
  return JSON.parse((await run('osascript', ['-l', 'JavaScript', '-e', script])).stdout);
}
const PROMPT_OWNERS = new Set(['SecurityAgent', 'UserNotificationCenter', 'CoreServicesUIAgent', 'coreautha']);
const windowKey = w => `${w.pid}/${w.owner}/${w.layer}`;
/** Windows not in `baseline` that look like a prompt: a system agent's, or the app's above its normal layer. */
function newPrompts(windows, baseline, pid) {
  const found = windows.filter(w => !baseline.has(windowKey(w)) && (PROMPT_OWNERS.has(w.owner) || (w.pid === pid && w.layer !== 0)));
  // The app's own alert may sit on the normal layer: a second normal window is one too.
  const own = windows.filter(w => w.pid === pid && w.layer === 0);
  return own.length > 1 ? [...found, ...own] : found;
}

/**
 * Starts the packaged app's executable with a DevTools port; it is ended (SIGTERM, then SIGKILL)
 * before the host stops and the directory goes. Returns its output so far and the DevTools port.
 */
async function start(context, app, alp, extraEnv = {}, args = []) {
  await mkdir(path.join(context.dir, 'app-home'), { recursive: true });
  const port = await freePort();
  const baseline = new Set((await screenWindows()).map(windowKey));
  const child = spawn(path.join(app, 'Contents', 'MacOS', 'ALP'), [...TEST_SWITCHES, `--remote-debugging-port=${port}`, ...args], {
    env: { ...appEnv(context, alp), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const keep = chunk => { output = (output + chunk).slice(-20_000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  // A watchdog: should a prompt appear anyway, the app is killed at once and the test fails, so a
  // dialog never waits on the user's screen. It fails closed: when the windows cannot be read three
  // times in a row, the app is killed too, since a prompt could no longer be seen.
  let prompted;
  let watching = true;
  const watchdog = (async () => {
    let failures = 0;
    while (watching && child.exitCode === null && child.signalCode === null) {
      let found;
      try { found = newPrompts(await screenWindows(), baseline, child.pid); failures = 0; } catch (error) {
        if (++failures >= 3) { prompted = `the on-screen windows could not be read: ${error.message}`; child.kill('SIGKILL'); return; }
        found = [];
      }
      if (found.length) { prompted = found; child.kill('SIGKILL'); return; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  })();
  context.defer(async () => { watching = false; await watchdog; if (prompted) throw new Error(`the watchdog killed the app: ${typeof prompted === 'string' ? prompted : `a prompt appeared ${JSON.stringify(prompted)}`}`); });
  context.defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try { await exited; } finally { clearTimeout(timer); }
  });
  return { child, port, baseline, output: () => output.replace(/alpgw1\.[A-Za-z0-9_.-]+/g, 'alpgw1.<masked>') };
}

/** Connects to the app over DevTools and waits for its window on `origin` with the token taken out. */
async function connectedPage(context, started, origin) {
  const browser = await waitFor(() => chromium.connectOverCDP(`http://127.0.0.1:${started.port}`), 'the DevTools endpoint', 60_000);
  // connectOverCDP's close() only disconnects; the app itself is ended by start()'s step.
  context.defer(() => browser.close());
  return waitFor(async () => {
    if (started.child.exitCode !== null || started.child.signalCode !== null) throw new Error(`the app exited (${started.child.exitCode ?? started.child.signalCode}):\n${started.output()}`);
    for (const page of browser.contexts().flatMap(c => c.pages())) {
      const url = new URL(page.url());
      if (url.origin !== origin || url.hash) continue;
      if (await page.evaluate(() => sessionStorage.getItem('alp-web:link-token') !== null)) return page;
    }
    return undefined;
  }, `the window on ${origin} with the token taken out of the address`, 60_000);
}

async function connectedSetup(t) {
  const context = await scratch(t);
  const web = await host(t, context);
  await web.start(await freePort());
  const alp = await fakeAlp(context);
  await alp.prints(web.address);
  const app = await install(context);
  return { context, web, alp, app };
}

test('the DMG holds ALP.app, ad-hoc signed with hardened runtime, and its fuses are set', limit, async t => {
  const app = await install(await scratch(t));
  const plist = JSON.parse((await run('plutil', ['-convert', 'json', '-o', '-', path.join(app, 'Contents', 'Info.plist')])).stdout);
  assert.equal(plist.CFBundleName, 'ALP');
  assert.equal(plist.CFBundleIdentifier, DESKTOP_BUNDLE_ID, 'the bundle id `alp desktop` looks for');
  const { stderr } = await run('codesign', ['-dv', '--verbose=2', app]);
  assert.match(stderr, /^Signature=adhoc$/m);
  assert.match(stderr, /flags=0x[0-9a-f]+\(adhoc,runtime\)/);
  await run('codesign', ['--verify', '--deep', '--strict', app]);
  const { getCurrentFuseWire, FuseV1Options, FuseState } = await import('@electron/fuses');
  const wire = await getCurrentFuseWire(path.join(app, 'Contents', 'MacOS', 'ALP'));
  const expected = {
    RunAsNode: FuseState.DISABLE,
    EnableCookieEncryption: FuseState.ENABLE,
    EnableNodeOptionsEnvironmentVariable: FuseState.DISABLE,
    EnableNodeCliInspectArguments: FuseState.DISABLE,
    EnableEmbeddedAsarIntegrityValidation: FuseState.ENABLE,
    OnlyLoadAppFromAsar: FuseState.ENABLE,
  };
  for (const [name, state] of Object.entries(expected)) assert.equal(wire[FuseV1Options[name]], state, `fuse ${name}`);
});

test('the installed app connects to alp dashboard, and apps/web takes the token out of the address', limit, async t => {
  const { context, web, alp, app } = await connectedSetup(t);
  const started = await start(context, app, alp.file);
  const page = await connectedPage(context, started, web.origin);
  // No keychain prompt (--use-mock-keychain, TEST_SWITCHES) nor any other dialog: the app shows only
  // its window (start()'s watchdog would have killed it on a prompt).
  await new Promise(resolve => setTimeout(resolve, 3_000));
  assert.deepEqual(newPrompts(await screenWindows(), started.baseline, started.child.pid), [], 'no prompt appeared');
  assert.equal((await screenWindows()).filter(w => w.pid === started.child.pid && w.layer === 0).length, 1, 'the app shows one window');
  assert.equal(await page.evaluate(() => location.hash), '');
  assert.equal(await page.evaluate(() => sessionStorage.getItem('alp-web:link-token')) === web.web.token, true, 'apps/web kept the link token in the tab only');
});

test('ELECTRON_RUN_AS_NODE=1 does not make the packaged app run as Node (RunAsNode fuse off)', limit, async t => {
  const { context, web, alp, app } = await connectedSetup(t);
  const script = "process.stdout.write('ran-as-node\\n'); process.exit(0)";
  // The control: the development Electron, which has no fuses, does run the script as Node.
  const control = await run(DEV_ELECTRON, ['-e', script], { env: { ...hermeticEnv(process.env), ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(control.stdout, 'ran-as-node\n');
  const started = await start(context, app, alp.file, { ELECTRON_RUN_AS_NODE: '1' }, ['-e', script]);
  await connectedPage(context, started, web.origin);
  assert.equal(started.child.exitCode, null, 'the app is still running');
  assert.doesNotMatch(started.output(), /ran-as-node/);
});

test('`alp desktop` finds ALP.app by its documented lookup', limit, async t => {
  const context = await scratch(t);
  const app = await install(context);
  const home = path.join(context.dir, 'home');
  // A fake `open` that records what it was asked to open; the lookup, not LaunchServices, is tested.
  const bin = path.join(context.dir, 'open-bin');
  const record = path.join(context.dir, 'opened');
  await mkdir(bin);
  await writeFile(path.join(bin, 'open'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`);
  await chmod(path.join(bin, 'open'), 0o755);
  // /Applications comes first; this test never writes there. Where it already holds ALP's app, that
  // one is the documented answer; another app named ALP.app there is skipped with one line.
  const system = '/Applications/ALP.app';
  const present = await stat(system).then(info => info.isDirectory(), () => false);
  const ours = present && (await readBundleId(system)) === DESKTOP_BUNDLE_ID;
  const expected = ours ? system : app;
  t.diagnostic(`${system}: ${present ? (ours ? 'ALP' : `another app (${await readBundleId(system)})`) : 'absent'}; expected: ${expected}`);
  const env = { ...hermeticEnv(process.env), HOME: home, PATH: `${bin}:${process.env.PATH}` };
  delete env.ALP_DESKTOP_CHECKOUT;
  const { stdout, stderr } = await run(process.execPath, [CLI, 'desktop'], { env });
  assert.equal(stdout.trim(), `Opened ${expected}.`);
  // `alp desktop` returns once `open` has started, not finished.
  assert.equal(await waitFor(() => readFile(record, 'utf8').then(text => text.trim() || undefined), 'the fake open to record its argument'), expected);
  if (present && !ours) assert.match(stderr, new RegExp(`^Skipped ${system}: its bundle id is `, 'm'));
  else assert.equal(stderr, '');
});
