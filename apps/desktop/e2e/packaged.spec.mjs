/**
 * The packaged app (t-81b0.3, docs/alp/desktop.md §6): ALP.app taken out of a DMG built by
 * `bun run dist`, installed into a scratch Applications directory and run against the same
 * disposable alp dashboard host and fake `alp` as shell.spec.mjs (./support.mjs). Never the user's
 * ~/.alp, ~/Applications or /Applications.
 *
 *   ALP_DESKTOP_DMG=release/ALP-<version>-arm64.dmg bun run e2e:packaged
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
import { appEnv, fakeAlp, freePort, host, noAlpEnv, releaseMirror, scratch, TEST_SWITCHES, waitFor } from './support.mjs';
import { hermeticEnv } from '../../../scripts/test-lib.ts';
import { DESKTOP_BUNDLE_ID, readBundleId } from '../../../packages/cli/dist/commands/desktop/index.js';

const run = promisify(execFile);
const limit = { timeout: 420_000 };
const DMG = process.env.ALP_DESKTOP_DMG ? path.resolve(process.env.ALP_DESKTOP_DMG) : undefined;
const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const CLI = path.join(ROOT, 'packages', 'cli', 'dist', 'cli.js');
/** The development Electron of apps/desktop's install: the control for the RunAsNode check. */
const DEV_ELECTRON = path.join(import.meta.dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron');

/** hdiutil's "Resource busy" (exit 16): something (Spotlight, fseventsd) still holds the volume briefly. */
const busy = error => error?.code === 16 || /Resource busy/i.test(`${error?.stderr ?? ''}${error?.message ?? ''}`);

/**
 * Detaches the image mounted at `mount` (t-81b0.10). A volume that was just read can stay busy for a
 * moment (CI run 44885075659: "couldn't eject disk7 - Resource busy" right after ditto), so a busy
 * detach is retried with a short backoff, then forced; any other error, or a volume still busy after
 * the forced attempts, fails the test with every attempt's message.
 */
async function detachImage(mount) {
  const attempts = [[0, false], [1_000, false], [2_000, false], [4_000, false], [4_000, true], [8_000, true]];
  const failures = [];
  for (const [delay, force] of attempts) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      await run('hdiutil', ['detach', mount, ...(force ? ['-force'] : [])], { timeout: 60_000 });
      return;
    } catch (error) {
      failures.push(`${force ? 'detach -force' : 'detach'}: ${String(error?.stderr || error?.message).trim()}`);
      if (!busy(error)) break;
    }
  }
  throw new Error(`hdiutil could not detach ${mount}:\n${failures.join('\n')}`);
}

/** Copies ALP.app out of the DMG into <dir>/home/Applications, as a user would; returns its path. */
async function install({ dir, defer }) {
  if (!DMG) throw new Error('set ALP_DESKTOP_DMG to the DMG built by `bun run dist`');
  const mount = path.join(dir, 'mnt');
  await mkdir(mount);
  await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, DMG], { timeout: 120_000 });
  let attached = true;
  const detach = async () => { if (attached) { attached = false; await detachImage(mount); } };
  defer(detach);
  const applications = path.join(dir, 'home', 'Applications');
  await mkdir(applications, { recursive: true });
  const app = path.join(applications, 'ALP.app');
  await run('ditto', [path.join(mount, 'ALP.app'), app], { timeout: 120_000 });
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
  // Bounded, so a hung read counts as a failed one for the watchdog.
  return JSON.parse((await run('osascript', ['-l', 'JavaScript', '-e', script], { timeout: 5_000 })).stdout);
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
  await mkdir(path.join(context.dir, 'app-home'), { recursive: true, mode: 0o700 });
  await mkdir(path.join(context.dir, 'tmp'), { recursive: true });
  const port = await freePort();
  const binary = path.join(app, 'Contents', 'MacOS', 'ALP');
  const rosetta = process.arch === 'arm64' && (await run('lipo', ['-archs', binary])).stdout.trim() === 'x86_64';
  const baseline = new Set((await screenWindows()).map(windowKey));
  const child = spawn(binary, [...TEST_SWITCHES, `--remote-debugging-port=${port}`, ...args], {
    env: { ...appEnv(context, alp), ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  // The raw tail is kept and masked when read: a token split across chunks is whole by then, and
  // the possibly cut first line is dropped, so no half token is shown either.
  let output = '';
  let cut = false;
  const keep = chunk => { output += chunk; if (output.length > 20_000) { output = output.slice(-20_000); cut = true; } };
  const masked = () => (cut ? output.slice(output.indexOf('\n') + 1) : output).replace(/alpgw1\.[A-Za-z0-9_.-]+/g, 'alpgw1.<masked>');
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  // A spawn failure (ENOENT, EACCES) is an 'exit'-less 'error': recorded, and the waits see `failed`.
  let failed;
  child.once('error', error => { failed = error; keep(`\n[spawn error: ${error.message}]\n`); });
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
    if (failed || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 15_000);
    try { await exited; } finally { clearTimeout(timer); }
  });
  const ended = () => failed !== undefined || child.exitCode !== null || child.signalCode !== null;
  return { child, port, baseline, rosetta, ended, output: masked };
}

/** `promise`, or a rejection naming `what` after `ms`. */
function bounded(promise, ms, what) {
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} took over ${ms / 1000} s`)), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Polls `probe` until it answers something truthy, the app ends (at once, with its state) or
 * `deadline` passes. Unlike support.mjs's waitFor, it stops as soon as the app is gone.
 */
async function whileRunning(started, probe, what, deadline) {
  let last;
  for (;;) {
    if (started.ended()) throw new Error(`the app ended while waiting for ${what}`);
    try { const value = await probe(); if (value) return value; last = value; } catch (error) { last = error; }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

/**
 * Connects to the app over DevTools and waits for its window on `origin` with the token taken out.
 * Both waits share one deadline, kept below the per-test limit, so a slow start fails with the
 * app's state and output rather than with node:test's bare timeout.
 */
async function connectedPage(context, started, origin) {
  // Under Rosetta (an x64 app on an arm64 Mac) the first start translates Electron and is much
  // slower, above all on a CI VM.
  const deadline = Date.now() + (started.rosetta ? 300_000 : 60_000);
  const state = () => {
    const { exitCode, signalCode } = started.child;
    const how = started.ended() ? `ended (${exitCode ?? signalCode ?? 'spawn error'})` : 'running';
    return `app ${how}${started.rosetta ? ', under Rosetta' : ''}; its output:\n${started.output()}`;
  };
  try {
    const browser = await whileRunning(started, () => chromium.connectOverCDP(`http://127.0.0.1:${started.port}`, { timeout: 10_000 }), 'the DevTools endpoint', deadline);
    // connectOverCDP's close() only disconnects; the app itself is ended by start()'s step.
    context.defer(() => browser.close());
    return await whileRunning(started, async () => {
      for (const page of browser.contexts().flatMap(c => c.pages())) {
        const url = new URL(page.url());
        if (url.origin !== origin || url.hash) continue;
        if (await bounded(page.evaluate(() => sessionStorage.getItem('alp-web:link-token') !== null), 10_000, 'reading the page')) return page;
      }
      return undefined;
    }, `the window on ${origin} with the token taken out of the address`, deadline);
  } catch (error) {
    throw new Error(`${error.message}\n${state()}`);
  }
}

/**
 * Waits over DevTools for the window to show a bundled page other than `skip` (or Chromium's error
 * page in its place: a page that failed to load is chrome-error://), parsed and with its heading, and
 * returns its URL, heading and text (read together, from one evaluate).
 */
async function bundledPage(context, started, skip) {
  const deadline = Date.now() + (started.rosetta ? 300_000 : 60_000);
  try {
    const browser = await whileRunning(started, () => chromium.connectOverCDP(`http://127.0.0.1:${started.port}`, { timeout: 10_000 }), 'the DevTools endpoint', deadline);
    context.defer(() => browser.close());
    return await whileRunning(started, async () => {
      for (const page of browser.contexts().flatMap(c => c.pages())) {
        const url = page.url();
        if (!url.startsWith('alp-page:') && !url.startsWith('file:') && !url.startsWith('chrome-error:')) continue;
        if (skip && url.split('?')[0].endsWith(`/${skip}`)) continue;
        const read = script => bounded(page.evaluate(script), 10_000, 'reading the page');
        // The URL changes before the document is parsed (CI run 45017772537 read an empty heading): a
        // bundled page counts once it is past loading and its heading has text; Chromium's error page
        // (or a file: page, which is a failure here) once it is past loading.
        const shown = await read(() => ({ ready: document.readyState, h1: document.querySelector('h1')?.textContent ?? null, text: document.body?.innerText ?? '' }));
        if (shown.ready === 'loading') continue;
        if (url.startsWith('alp-page:') && !shown.h1?.trim()) continue;
        return { url, h1: shown.h1, text: shown.text };
      }
      return undefined;
    }, `a bundled page${skip ? ` other than ${skip}` : ''}`, deadline);
  } catch (error) {
    throw new Error(`${error.message}\napp output:\n${started.output()}`);
  }
}

/** Asserts that `url` is bundled page `name` (alp-page://app/<name>, served from the app's own asar). */
function assertBundled(url, name) {
  assert.equal(url.split('?')[0], `alp-page://app/${name}`, `${name} loaded`);
}

// t-81b0.7: the packaged app showed a blank window instead of any of its pages on the user's Mac. Its
// bundle looked for them in the tree it was built in (found here only because CI runs where that tree
// exists), and file:// cannot read inside app.asar once GrantFileProtocolExtraPrivileges is off. Each
// page must load from the app itself, with its heading.
test('the installed app shows Connecting, from the app itself', limit, async t => {
  const context = await scratch(t);
  const app = await install(context);
  const alp = await fakeAlp(context);
  // alp answers only once the page has been read (bounded, so no shell is left behind).
  const gate = path.join(context.dir, 'gate');
  await alp.set(`i=0; while [ ! -f '${gate}' ] && [ $i -lt 6000 ]; do sleep 0.05; i=$((i + 1)); done; exit 1`);
  context.defer(() => writeFile(gate, ''));
  const shown = await bundledPage(context, await start(context, app, alp.file));
  assertBundled(shown.url, 'connecting.html');
  assert.equal(shown.h1, 'Starting ALP…');
});

test('an alp without `alp dashboard` (0.0.1-beta.8): the error page, from the app itself, says so', limit, async t => {
  const context = await scratch(t);
  const app = await install(context);
  const alp = await fakeAlp(context);
  // What 0.0.1-beta.8 answers: its usage on stderr and exit 1.
  await alp.set("printf 'Usage:\\n  alp web [--print]\\n' >&2; exit 1");
  await alp.setVersion('0.0.1-beta.8');
  const shown = await bundledPage(context, await start(context, app, alp.file), 'connecting.html');
  assertBundled(shown.url, 'error.html');
  assert.equal(shown.h1, 'ALP could not open');
  assert.ok(shown.text.includes(`Your alp 0.0.1-beta.8 (${alp.file}) has no \`alp dashboard\``), shown.text);
  assert.ok(!shown.text.includes('Usage:'), shown.text);
});

test('no alp: the install page, from the app itself', limit, async t => {
  const context = await scratch(t);
  const app = await install(context);
  const shown = await bundledPage(context, await start(context, app, path.join(context.dir, 'nowhere', 'alp')), 'connecting.html');
  assertBundled(shown.url, 'missing-alp.html');
  assert.match(shown.text, /npm install -g/);
});

// t-81b0.8: the test mirror (ALP_DESKTOP_INSTALL_MIRROR) is for an unpackaged app only. ALP.app with no alp
// reads the latest release from GitHub whatever that variable says. A proxy that refuses every connection
// keeps the test off the network: the lookup fails, and its message names the URL the app asked for.
test('no alp: ALP.app ignores the test mirror and looks up GitHub Releases only', limit, async t => {
  const context = await scratch(t);
  const app = await install(context);
  const mirror = await releaseMirror(context, { address: 'http://127.0.0.1:9/#token=unused' });
  const started = await start(context, app, undefined, { ...(await noAlpEnv(context)), ALP_DESKTOP_INSTALL_MIRROR: mirror.dir }, ['--proxy-server=127.0.0.1:9']);
  let shown;
  for (let i = 0; i < 60; i++) {
    shown = await bundledPage(context, started, 'connecting.html');
    if (/Could not read the latest ALP release/.test(shown.text)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assertBundled(shown.url, 'missing-alp.html');
  assert.ok(shown.text.includes('https://github.com/phucanh08/alp/releases/latest/download/SHA256SUMS'), shown.text);
  assert.ok(!shown.text.includes(mirror.dir), shown.text);
  assert.equal(await stat(path.join(context.dir, 'app-home', '.alp')).then(() => true, () => false), false);
});

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
  const control = await run(DEV_ELECTRON, ['-e', script], { env: { ...hermeticEnv(process.env), ELECTRON_RUN_AS_NODE: '1' }, timeout: 60_000 });
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
