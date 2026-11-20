import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { desktopCommand, resolveDesktop } from '../src/desktop.js';

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

test('ALP.app in /Applications, then ~/Applications, wins over a checkout', async t => {
  const directory = await scratch(t);
  const system = path.join(directory, 'Applications');
  const user = path.join(directory, 'home', 'Applications');
  const env = { ALP_DESKTOP_CHECKOUT: path.join(directory, 'repo') };
  await checkout(env.ALP_DESKTOP_CHECKOUT);
  await mkdir(path.join(user, 'ALP.app'), { recursive: true });
  assert.deepEqual(await resolveDesktop({ platform: 'darwin', env, applications: [system, user] }),
    { kind: 'app', app: path.join(user, 'ALP.app'), command: 'open', args: [path.join(user, 'ALP.app')] });
  await mkdir(path.join(system, 'ALP.app'), { recursive: true });
  assert.equal((await resolveDesktop({ platform: 'darwin', env, applications: [system, user] })).app, path.join(system, 'ALP.app'));
  // The default places are /Applications and ~/Applications.
  const found = await resolveDesktop({ platform: 'darwin', home: path.join(directory, 'home'), env: {} });
  assert.ok(found.kind === 'missing' || found.app === '/Applications/ALP.app', JSON.stringify(found));
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

  const launched = [];
  process.env.ELECTRON_RUN_AS_NODE = '1';
  t.after(() => { delete process.env.ELECTRON_RUN_AS_NODE; });
  await desktopCommand([], { resolve: async () => ({ kind: 'app', app: '/Applications/ALP.app', command: 'open', args: ['/Applications/ALP.app'] }), launch: async (command, args, env) => { launched.push({ command, args, electron: env.ELECTRON_RUN_AS_NODE }); } });
  assert.deepEqual(launched, [{ command: 'open', args: ['/Applications/ALP.app'], electron: undefined }]);
  assert.deepEqual(logs, ['Opened /Applications/ALP.app.']);
  await assert.rejects(desktopCommand(['--now']), error => error?.constructor?.name === 'UsageError');
});
