import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bundleInfo, entryCommand, scriptCommand, selfCommand, selfEntry, stablePath } from '../src/packaged.js';
import { bridgeCommand, isBridgeArgs, ACP_BRIDGE, ANTIGRAVITY_BRIDGE } from '../src/bridges.js';

test('ALP starts its roles as scripts under process.execPath, and bridges as -e', () => {
  assert.deepEqual(selfCommand('daemon', { script: '/opt/alp/alpd.js', args: ['--detach'] }), { command: process.execPath, args: ['/opt/alp/alpd.js', '--detach'] });
  assert.throws(() => selfCommand(/** @type {any} */ ('nope'), { script: 'x' }), /Unknown ALP role/);
  assert.equal(selfEntry('/opt/alp/alpd.js'), '/opt/alp/alpd.js');
  assert.deepEqual(scriptCommand('/x/fake.js', ['a']), { command: process.execPath, args: ['/x/fake.js', 'a'] });
  assert.deepEqual(bridgeCommand('acp'), { command: process.execPath, args: ['-e', ACP_BRIDGE] });
  assert.deepEqual(bridgeCommand('antigravity'), { command: process.execPath, args: ['-e', ANTIGRAVITY_BRIDGE] });
  assert.equal(bundleInfo(), undefined, 'the test runner\'s Node is not an ALP bundle');
});

test('an entry found on disk runs by its kind: a script under execPath, an `alp` command through its role subcommand', () => {
  assert.deepEqual(entryCommand('/opt/alp/dist/alpd.js', 'daemon', ['--service'], '/opt/node'), { command: '/opt/node', args: ['/opt/alp/dist/alpd.js', '--service'] });
  // What a 0.0.1-beta.5/6 single-file install recorded, and the bundle's launcher.
  assert.deepEqual(entryCommand('/home/u/.alp/bin/alp', 'daemon', ['--service'], '/opt/node'), { command: '/home/u/.alp/bin/alp', args: ['daemon', 'run', '--service'] });
  assert.deepEqual(entryCommand('C:\\alp\\alp.exe', 'web', ['--rotate']), { command: 'C:\\alp\\alp.exe', args: ['web', 'serve', '--rotate'] });
  // A third-party integration entry is always a script, whatever its name.
  assert.deepEqual(entryCommand('/usr/bin/alp-x-integration', 'web', ['--service'], '/opt/node', { scriptOnly: true }), { command: '/opt/node', args: ['/usr/bin/alp-x-integration', '--service'] });
  assert.throws(() => entryCommand('/bin/alp', /** @type {any} */ ('nope')), /Unknown ALP role/);
  // Only alp/alp.exe/alp.cmd is a command: a TypeScript or extensionless entry still runs under execPath.
  assert.deepEqual(entryCommand('/src/alp/alpd.ts', 'daemon', ['--detach'], '/opt/node'), { command: '/opt/node', args: ['/src/alp/alpd.ts', '--detach'] });
  assert.deepEqual(entryCommand('/opt/alp/bin/alpd', 'daemon', [], '/opt/node'), { command: '/opt/node', args: ['/opt/alp/bin/alpd'] });
});

test('an Antigravity MCP entry is recognised as ALP\'s in both launcher forms, and nothing else is', () => {
  assert.equal(isBridgeArgs('antigravity', ['-e', ANTIGRAVITY_BRIDGE]), true);
  assert.equal(isBridgeArgs('antigravity', ['bridge', 'antigravity'], '/Users/u/.alp/bin/alp'), true);
  assert.equal(isBridgeArgs('antigravity', ['bridge', 'antigravity'], 'C:\\Users\\u\\.alp\\bin\\alp.exe'), true);
  // Another server that happens to take the same arguments is not ALP's.
  assert.equal(isBridgeArgs('antigravity', ['bridge', 'antigravity'], '/usr/bin/other'), false);
  assert.equal(isBridgeArgs('antigravity', ['bridge', 'antigravity']), false);
  assert.equal(isBridgeArgs('antigravity', ['bridge', 'acp'], '/bin/alp'), false);
  assert.equal(isBridgeArgs('antigravity', ['server.js']), false);
  assert.equal(isBridgeArgs('antigravity', undefined), false);
});

/** <work>/app/<version>/{node/bin/node, lib/…/alpd.js, alp-bundle.json}, and app/current → version when `current`. */
async function fakeBundle(t, { version = '1.2.3', current = true } = {}) {
  const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-bundle-test-')));
  t.after(() => rm(work, { recursive: true, force: true }));
  const app = path.join(work, 'app');
  const root = path.join(app, version);
  const windows = process.platform === 'win32';
  const node = windows ? path.join(root, 'node', 'node.exe') : path.join(root, 'node', 'bin', 'node');
  const alpd = path.join(root, 'lib', 'node_modules', '@anhlp', 'alp-cli', 'dist', 'alpd.js');
  await mkdir(path.dirname(node), { recursive: true });
  await mkdir(path.dirname(alpd), { recursive: true });
  await writeFile(node, '');
  await writeFile(alpd, '');
  await writeFile(path.join(root, 'alp-bundle.json'), JSON.stringify({ name: 'alp', version, platform: 'test-x' }));
  if (current) await symlink(windows ? root : version, path.join(app, 'current'), windows ? 'junction' : 'dir');
  return { work, app, root, node, alpd };
}

test('bundleInfo recognises the bundle\'s Node, and stablePath names its files through app/current', async t => {
  const b = await fakeBundle(t);
  const info = bundleInfo(b.node);
  assert.deepEqual(info, { root: b.root, version: '1.2.3', platform: 'test-x', app: b.app, current: path.join(b.app, 'current') });
  assert.equal(bundleInfo(path.join(b.app, 'current', 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node'))?.root, b.root, 'reached through current, the same bundle');
  assert.equal(stablePath(b.alpd, { bundle: info }), path.join(b.app, 'current', 'lib', 'node_modules', '@anhlp', 'alp-cli', 'dist', 'alpd.js'));
  assert.equal(stablePath(b.node, { bundle: info }), path.join(b.app, 'current', path.relative(b.root, b.node)));
  // Outside the bundle, missing, or no bundle: unchanged.
  assert.equal(stablePath(path.join(b.work, 'elsewhere.js'), { bundle: info }), path.join(b.work, 'elsewhere.js'));
  assert.equal(stablePath(b.alpd, { bundle: undefined }), b.alpd);
});

test('a bundle that current does not point at keeps its own paths', async t => {
  const b = await fakeBundle(t, { current: false });
  const info = bundleInfo(b.node);
  assert.equal(info?.current, undefined);
  assert.equal(stablePath(b.alpd, { bundle: info }), b.alpd);
  // A Node that is not in a bundle (no alp-bundle.json).
  const plain = path.join(b.work, 'node', 'bin', 'node');
  await mkdir(path.dirname(plain), { recursive: true });
  await writeFile(plain, '');
  assert.equal(bundleInfo(plain), undefined);
});
