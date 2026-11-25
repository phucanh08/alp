import test from 'node:test';
import { execFile } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DESKTOP_BUNDLE_ID, desktopCommand, readBundleId, resolveDesktop } from '../dist/desktop.js';

async function scratch(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-desktop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

/** A checkout whose apps/desktop is built (or not). */
async function checkout(root, { built = true } = {}) {
  const desktop = path.join(root, 'apps', 'desktop');
  await mkdir(path.join(desktop, 'node_modules', '.bin'), { recursive: true });
  await writeFile(path.join(desktop, 'package.json'), JSON.stringify({ name: 'alp-desktop' }));
  if (built) {
    await mkdir(path.join(desktop, 'dist'), { recursive: true });
    await writeFile(path.join(desktop, 'dist', 'main.cjs'), '');
    await writeFile(path.join(desktop, 'node_modules', '.bin', 'electron'), '#!/bin/sh\n', { mode: 0o755 });
  }
  return desktop;
}

/** An app bundle at `app` whose Info.plist (XML, as electron-builder writes it) names `id`; no plist when `id` is null. */
async function bundle(app, id = DESKTOP_BUNDLE_ID) {
  await mkdir(path.join(app, 'Contents'), { recursive: true });
  if (id === null) return app;
  await writeFile(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDisplayName</key>
  <string>ALP</string>
  <key>CFBundleIdentifier</key>
  <string>${id}</string>
</dict>
</plist>
`);
  return app;
}

test('ALP.app in /Applications, then ~/Applications, wins over a checkout', async t => {
  const directory = await scratch(t);
  const system = path.join(directory, 'Applications');
  const user = path.join(directory, 'home', 'Applications');
  const env = { ALP_DESKTOP_CHECKOUT: path.join(directory, 'repo') };
  await checkout(env.ALP_DESKTOP_CHECKOUT);
  await bundle(path.join(user, 'ALP.app'));
  assert.deepEqual(await resolveDesktop({ platform: 'darwin', env, applications: [system, user] }),
    { kind: 'app', app: path.join(user, 'ALP.app'), command: 'open', args: [path.join(user, 'ALP.app')] });
  await bundle(path.join(system, 'ALP.app'));
  assert.equal((await resolveDesktop({ platform: 'darwin', env, applications: [system, user] })).app, path.join(system, 'ALP.app'));
  // The default places are /Applications and ~/Applications.
  const found = await resolveDesktop({ platform: 'darwin', home: path.join(directory, 'empty-home'), env: {} });
  assert.ok(found.kind === 'missing' || found.app === '/Applications/ALP.app', JSON.stringify(found));
});

test('an ALP.app with another bundle id is skipped with one line naming it, and the lookup goes on', async t => {
  const directory = await scratch(t);
  const system = path.join(directory, 'Applications');
  const user = path.join(directory, 'home', 'Applications');
  const env = { ALP_DESKTOP_CHECKOUT: path.join(directory, 'repo') };
  const desktop = await checkout(env.ALP_DESKTOP_CHECKOUT);
  const old = await bundle(path.join(system, 'ALP.app'), 'com.anhlp.alp.desktop');
  const ours = await bundle(path.join(user, 'ALP.app'));
  let skipped = [];
  const onSkip = message => skipped.push(message);
  // /Applications holds another app: it is passed over for the one in ~/Applications.
  assert.equal((await resolveDesktop({ platform: 'darwin', env, applications: [system, user], onSkip })).app, ours);
  assert.deepEqual(skipped, [`Skipped ${old}: its bundle id is "com.anhlp.alp.desktop", not ${DESKTOP_BUNDLE_ID} (ALP's desktop app).`]);
  // Neither is ours (one without an Info.plist): the checkout is next.
  skipped = [];
  await rm(ours, { recursive: true });
  await bundle(ours, null);
  const found = await resolveDesktop({ platform: 'darwin', env, applications: [system, user], onSkip });
  assert.equal(found.kind, 'checkout');
  assert.equal(found.dir, desktop);
  assert.equal(skipped.length, 2);
  assert.equal(skipped[1], `Skipped ${ours}: its bundle id is unreadable, not ${DESKTOP_BUNDLE_ID} (ALP's desktop app).`);
  // No checkout either: missing.
  assert.deepEqual(await resolveDesktop({ platform: 'darwin', env: {}, applications: [system, user] }), { kind: 'missing' });
});

test('readBundleId reads an XML Info.plist, and a binary one through plutil on macOS', { skip: process.platform !== 'darwin' && 'plutil is macOS only' }, async t => {
  const directory = await scratch(t);
  const app = await bundle(path.join(directory, 'ALP.app'));
  assert.equal(await readBundleId(app), DESKTOP_BUNDLE_ID);
  await new Promise((resolve, reject) => execFile('/usr/bin/plutil', ['-convert', 'binary1', path.join(app, 'Contents', 'Info.plist')], error => (error ? reject(error) : resolve())));
  assert.equal(await readBundleId(app), DESKTOP_BUNDLE_ID);
  assert.equal(await readBundleId(path.join(directory, 'nothing.app')), undefined);
});

test('without ALP.app, ALP_DESKTOP_CHECKOUT (the root or its apps/desktop) runs the built app with its Electron', async t => {
  const directory = await scratch(t);
  const root = path.join(directory, 'repo');
  const desktop = await checkout(root);
  const electron = path.join(desktop, 'node_modules', '.bin', 'electron');
  for (const named of [root, desktop]) {
    assert.deepEqual(await resolveDesktop({ platform: 'darwin', env: { ALP_DESKTOP_CHECKOUT: named }, applications: [] }),
      { kind: 'checkout', dir: desktop, command: electron, args: [desktop] });
  }
  const unbuilt = path.join(directory, 'unbuilt');
  await checkout(unbuilt, { built: false });
  assert.match((await resolveDesktop({ platform: 'darwin', env: { ALP_DESKTOP_CHECKOUT: unbuilt }, applications: [] })).reason, /is not built: run `bun install && bun run build`/);
  assert.match((await resolveDesktop({ platform: 'darwin', env: { ALP_DESKTOP_CHECKOUT: directory }, applications: [] })).reason, /is not an ALP checkout/);
});

test('neither: alp desktop says how to get the app and exits 1; a found app is launched without ELECTRON_RUN_AS_NODE', async t => {
  const errors = [], logs = [];
  const { error, log } = console;
  console.error = message => errors.push(message);
  console.log = message => logs.push(message);
  const exitCode = process.exitCode;
  t.after(() => { console.error = error; console.log = log; process.exitCode = exitCode; });

  await desktopCommand([], { resolve: async () => ({ kind: 'missing' }), launch: async () => assert.fail('nothing to launch') });
  assert.equal(process.exitCode, 1);
  assert.match(errors.join('\n'), /not installed[\s\S]*\/Applications[\s\S]*ALP_DESKTOP_CHECKOUT[\s\S]*alp dashboard/);
  process.exitCode = exitCode;

  // The lookup's skip lines go to stderr.
  errors.length = 0;
  await desktopCommand([], { resolve: async ({ onSkip }) => { onSkip('Skipped /Applications/ALP.app: …'); return { kind: 'missing' }; }, launch: async () => assert.fail('nothing to launch') });
  assert.equal(errors[0], 'Skipped /Applications/ALP.app: …');
  process.exitCode = exitCode;

  const launched = [];
  process.env.ELECTRON_RUN_AS_NODE = '1';
  t.after(() => { delete process.env.ELECTRON_RUN_AS_NODE; });
  await desktopCommand([], { resolve: async () => ({ kind: 'app', app: '/Applications/ALP.app', command: 'open', args: ['/Applications/ALP.app'] }), launch: async (command, args, env) => { launched.push({ command, args, electron: env.ELECTRON_RUN_AS_NODE }); } });
  assert.deepEqual(launched, [{ command: 'open', args: ['/Applications/ALP.app'], electron: undefined }]);
  assert.deepEqual(logs, ['Opened /Applications/ALP.app.']);
  await assert.rejects(desktopCommand(['--now']), error => error?.constructor?.name === 'UsageError');
});
