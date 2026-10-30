import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assetDir, entryCommand, executablePath, isPackaged, registerPackaged, scriptCommand, selfCommand, selfEntry } from '../src/packaged.js';
import { bridgeCommand, isBridgeArgs, ACP_BRIDGE, ANTIGRAVITY_BRIDGE } from '../src/bridges.js';
import { shippedTemplateRoot } from '../src/template-path.js';

const KEY = Symbol.for('alp.packaged');
const unregister = () => { delete globalThis[KEY]; };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('under Node, ALP starts its roles exactly as before: scripts under process.execPath, bridges as -e', () => {
  unregister();
  assert.equal(isPackaged(), false);
  assert.equal(executablePath(), undefined);
  assert.deepEqual(selfCommand('daemon', { script: '/opt/alp/alpd.js', args: ['--detach'] }), { command: process.execPath, args: ['/opt/alp/alpd.js', '--detach'] });
  assert.equal(selfEntry('/opt/alp/alpd.js'), '/opt/alp/alpd.js');
  assert.deepEqual(scriptCommand('/x/fake.js', ['a']), { command: process.execPath, args: ['/x/fake.js', 'a'] });
  assert.deepEqual(bridgeCommand('acp'), { command: process.execPath, args: ['-e', ACP_BRIDGE] });
  assert.deepEqual(bridgeCommand('antigravity'), { command: process.execPath, args: ['-e', ANTIGRAVITY_BRIDGE] });
  assert.equal(assetDir(), undefined);
});

test('an entry found on disk runs by its kind: a script under execPath, the ALP executable through its role subcommand', () => {
  unregister();
  assert.deepEqual(entryCommand('/opt/alp/dist/alpd.js', 'daemon', ['--service'], '/opt/node'), { command: '/opt/node', args: ['/opt/alp/dist/alpd.js', '--service'] });
  assert.deepEqual(entryCommand('/home/u/.alp/bin/alp', 'daemon', ['--service'], '/opt/node'), { command: '/home/u/.alp/bin/alp', args: ['daemon', 'run', '--service'] });
  assert.deepEqual(entryCommand('C:\\alp\\alp.exe', 'web', ['--rotate']), { command: 'C:\\alp\\alp.exe', args: ['web', 'serve', '--rotate'] });
  // A third-party integration entry is always a script, whatever its name.
  assert.deepEqual(entryCommand('/usr/bin/alp-x-integration', 'web', ['--service'], '/opt/node', { scriptOnly: true }), { command: '/opt/node', args: ['/usr/bin/alp-x-integration', '--service'] });
  assert.throws(() => entryCommand('/bin/alp', /** @type {any} */ ('nope')), /Unknown ALP role/);
});

test('packaged, ALP starts itself through subcommands and never passes a script or -e to its own executable', t => {
  t.after(unregister);
  registerPackaged({ version: '1.2.3', assets: {} });
  assert.equal(isPackaged(), true);
  assert.equal(executablePath(), process.execPath);
  assert.deepEqual(selfCommand('daemon', { script: '/$bunfs/root/alp', args: ['--detach'] }), { command: process.execPath, args: ['daemon', 'run', '--detach'] });
  assert.deepEqual(selfCommand('web', { script: 'x', args: ['--service'] }), { command: process.execPath, args: ['web', 'serve', '--service'] });
  assert.equal(selfEntry('/$bunfs/root/alpd.js'), process.execPath);
  assert.deepEqual(bridgeCommand('acp'), { command: process.execPath, args: ['bridge', 'acp'] });
  assert.deepEqual(bridgeCommand('antigravity'), { command: process.execPath, args: ['bridge', 'antigravity'] });
  // A user's JavaScript runs with the executable acting as its Bun runtime.
  assert.deepEqual(scriptCommand('/x/fake.js'), { command: process.execPath, args: ['/x/fake.js'], env: { BUN_BE_BUN: '1' } });
  // The packaged CLI cannot run an npm alpd.js itself: it needs a real node.
  assert.deepEqual(entryCommand('/opt/alp/dist/alpd.js', 'daemon', ['--detach']), { command: 'node', args: ['/opt/alp/dist/alpd.js', '--detach'] });
});

test('an Antigravity MCP entry is recognised as ALP\'s in both launcher forms, and nothing else is', () => {
  assert.equal(isBridgeArgs('antigravity', ['-e', ANTIGRAVITY_BRIDGE]), true);
  assert.equal(isBridgeArgs('antigravity', ['bridge', 'antigravity']), true);
  assert.equal(isBridgeArgs('antigravity', ['bridge', 'acp']), false);
  assert.equal(isBridgeArgs('antigravity', ['server.js']), false);
  assert.equal(isBridgeArgs('antigravity', undefined), false);
});

async function fixture(t) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'alp-packaged-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const sources = path.join(work, 'embedded');
  await mkdir(sources);
  const files = { 'templates/ALP.md': '# ALP\n', 'alp-web/index.html': '<html></html>', 'terminal-native/prebuilt/x/terminal-owner': '\x7fELFhelper' };
  const assets = {};
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(sources, name.replaceAll('/', '_'));
    await writeFile(file, text);
    assets[name] = { path: file, sha256: sha(Buffer.from(text)), size: Buffer.byteLength(text) };
  }
  const home = path.join(work, 'home');
  await mkdir(home, { mode: 0o700 });
  return { work, home, assets, env: { ALP_HOME: home } };
}

test('assetDir extracts the embedded assets once per version into a private cache, checked against the manifest', async t => {
  const { home, assets, env } = await fixture(t);
  const info = { version: '1.2.3', assets };
  const directory = assetDir({ env, info });
  assert.equal(directory, path.join(home, 'cache', '1.2.3'));
  assert.equal(await readFile(path.join(directory, 'templates/ALP.md'), 'utf8'), '# ALP\n');
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, 'terminal-native/prebuilt/x/terminal-owner'))).mode & 0o777, 0o700, 'the helper is executable');
    assert.equal((await stat(path.join(directory, 'templates/ALP.md'))).mode & 0o777, 0o600);
  }
  // Reused while intact; re-extracted when the cache was cleared or the build changed.
  const marker = await readFile(path.join(directory, '.alp-assets.json'), 'utf8');
  assert.equal(assetDir({ env, info }), directory);
  await rm(path.join(directory, 'alp-web/index.html'));
  await rm(path.join(directory, '.alp-assets.json'));
  assert.equal(assetDir({ env, info }), directory);
  assert.equal(await readFile(path.join(directory, 'alp-web/index.html'), 'utf8'), '<html></html>');
  const changed = { ...assets, 'templates/ALP.md': { ...assets['templates/ALP.md'] } };
  await writeFile(changed['templates/ALP.md'].path, '# ALP 2\n');
  changed['templates/ALP.md'].sha256 = sha(Buffer.from('# ALP 2\n'));
  changed['templates/ALP.md'].size = 8;
  assetDir({ env, info: { version: '1.2.3', assets: changed } });
  assert.equal(await readFile(path.join(directory, 'templates/ALP.md'), 'utf8'), '# ALP 2\n');
  assert.notEqual(await readFile(path.join(directory, '.alp-assets.json'), 'utf8'), marker);
});

test('assetDir refuses a tampered embedded file, a path that escapes the cache, a bad version and a shared cache', async t => {
  const { home, assets, env } = await fixture(t);
  const tampered = { ...assets, 'templates/ALP.md': { ...assets['templates/ALP.md'], sha256: '0'.repeat(64) } };
  assert.throws(() => assetDir({ env, info: { version: '1.0.0', assets: tampered } }), /does not match its manifest/);
  assert.equal((await import('node:fs')).existsSync(path.join(home, 'cache', '1.0.0')), false, 'nothing half-extracted is left');
  assert.throws(() => assetDir({ env, info: { version: '1.0.1', assets: { '../escape': assets['templates/ALP.md'] } } }), /Invalid packaged asset name/);
  assert.throws(() => assetDir({ env, info: { version: '../x', assets } }), /Invalid ALP version/);
  if (process.platform !== 'win32') {
    const shared = path.join(home, 'cache', '2.0.0');
    await mkdir(shared, { recursive: true });
    await chmod(shared, 0o777);
    assert.throws(() => assetDir({ env, info: { version: '2.0.0', assets } }), /private/);
  }
});

test('packaged, the templates come from the extracted cache', async t => {
  const { home, assets } = await fixture(t);
  const previous = process.env.ALP_HOME;
  process.env.ALP_HOME = home;
  t.after(() => { unregister(); if (previous === undefined) delete process.env.ALP_HOME; else process.env.ALP_HOME = previous; });
  registerPackaged({ version: '3.0.0', assets });
  const root = shippedTemplateRoot();
  assert.equal(await readFile(new URL('ALP.md', root), 'utf8'), '# ALP\n');
  assert.ok(root.pathname.includes('/cache/3.0.0/templates/'));
});
