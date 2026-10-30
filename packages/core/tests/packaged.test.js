import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { assetDir, entryCommand, executablePath, isPackaged, registerPackaged, scriptCommand, selfCommand, selfEntry } from '../src/packaged.js';
import { bridgeCommand, isBridgeArgs, ACP_BRIDGE, ANTIGRAVITY_BRIDGE } from '../src/bridges.js';
import { shippedTemplateRoot } from '../src/template-path.js';

const KEY = Symbol.for('alp.packaged');
const unregister = () => { delete globalThis[KEY]; };
const execFileP = promisify(execFile);
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
  // Only alp/alp.exe is the executable: a TypeScript or extensionless entry still runs under execPath.
  assert.deepEqual(entryCommand('/src/alp/alpd.ts', 'daemon', ['--detach'], '/opt/node'), { command: '/opt/node', args: ['/src/alp/alpd.ts', '--detach'] });
  assert.deepEqual(entryCommand('/opt/alp/bin/alpd', 'daemon', [], '/opt/node'), { command: '/opt/node', args: ['/opt/alp/bin/alpd'] });
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
  // Renamed (a release asset name): its own executable is still native, and its bridge entry still ALP's.
  assert.deepEqual(entryCommand(process.execPath, 'daemon', ['--detach']), { command: process.execPath, args: ['daemon', 'run', '--detach'] });
  assert.equal(isBridgeArgs('antigravity', bridgeCommand('antigravity').args, process.execPath), true);
  assert.deepEqual(entryCommand('/elsewhere/alp-darwin-arm64', 'daemon', [], '/opt/node'), { command: '/opt/node', args: ['/elsewhere/alp-darwin-arm64'] }, 'another renamed file is not this executable');
  // The packaged CLI cannot run an npm alpd.js itself: it needs a real node.
  assert.deepEqual(entryCommand('/opt/alp/dist/alpd.js', 'daemon', ['--detach']), { command: 'node', args: ['/opt/alp/dist/alpd.js', '--detach'] });
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

test('isSelf follows symlinks and, on macOS and Windows, ignores case', async t => {
  t.after(unregister);
  const { isSelf, samePath } = await import('../src/packaged.js');
  assert.equal(isSelf(process.execPath), false, 'not packaged: nothing is self');
  registerPackaged({ version: '1.2.3', assets: {} });
  const work = await mkdtemp(path.join(os.tmpdir(), 'alp-self-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  if (process.platform !== 'win32') {
    const link = path.join(work, 'alp');
    await symlink(process.execPath, link);
    assert.equal(isSelf(link), true, 'a symlink to the executable (~/.alp/bin/alp) is self');
    assert.deepEqual(entryCommand(link, 'daemon'), { command: link, args: ['daemon', 'run'] });
  }
  const upper = process.execPath.toUpperCase();
  if (upper !== process.execPath) assert.equal(isSelf(upper), process.platform === 'darwin' || process.platform === 'win32');
  assert.equal(isSelf(path.join(work, 'other')), false);
  assert.equal(samePath(work, `${work}/.`), true);
});

test('assetDir re-extracts a cache whose file was altered in place with the same size', async t => {
  const { assets, env } = await fixture(t);
  const info = { version: '1.4.0', assets };
  const directory = assetDir({ env, info });
  const file = path.join(directory, 'templates/ALP.md');
  await writeFile(file, '# XLP\n');
  // A fresh process (no per-process memo) checks every file's sha256, not only its size.
  const { stdout } = await execFileP(process.execPath, ['--input-type=module', '-e', `
    import { assetDir } from ${JSON.stringify(new URL('../src/packaged.js', import.meta.url).href)};
    console.log(assetDir({ env: ${JSON.stringify(env)}, info: ${JSON.stringify(info)} }));`]);
  assert.equal(stdout.trim(), directory);
  assert.equal(await readFile(file, 'utf8'), '# ALP\n');
});

test('assetDir refuses a group-writable cache parent and sweeps stale staging directories', async t => {
  if (process.platform === 'win32') return t.skip('POSIX modes');
  const { home, assets, env } = await fixture(t);
  const parent = path.join(home, 'cache');
  await mkdir(parent, { mode: 0o700 });
  // A dead process's staging directory and a live one's recent one.
  const dead = path.join(parent, `1.5.0.tmp-999999-${Date.now() - 11 * 60 * 1000}`);
  const fresh = path.join(parent, `1.5.0.tmp-999998-${Date.now()}`);
  const live = path.join(parent, `1.5.0.tmp-${process.ppid}-${Date.now()}`);
  const old = path.join(parent, `1.5.0.tmp-${process.ppid}-${Date.now() - 2 * 60 * 60 * 1000}`);
  for (const directory of [dead, fresh, live, old]) await mkdir(directory);
  assetDir({ env, info: { version: '1.5.0', assets } });
  const { existsSync } = await import('node:fs');
  assert.equal(existsSync(dead), false, 'a dead process\'s staging is removed');
  assert.equal(existsSync(old), false, 'an hour-old staging is removed even when its pid is alive');
  assert.equal(existsSync(live), true, 'a running extraction is left alone');
  assert.equal(existsSync(fresh), true, 'a recent staging is kept even when its pid looks dead (another pid namespace)');
  await chmod(parent, 0o770);
  assert.throws(() => assetDir({ env, info: { version: '1.6.0', assets } }), /parent must belong to the current user/);
});

test('concurrent processes extracting the same version all get one complete cache', async t => {
  const { home, assets, env } = await fixture(t);
  const info = { version: '1.7.0', assets };
  const script = `
    import { assetDir } from ${JSON.stringify(new URL('../src/packaged.js', import.meta.url).href)};
    console.log(assetDir({ env: ${JSON.stringify(env)}, info: ${JSON.stringify(info)} }));`;
  const results = await Promise.all(Array.from({ length: 8 }, () => execFileP(process.execPath, ['--input-type=module', '-e', script])));
  const directory = path.join(home, 'cache', '1.7.0');
  for (const { stdout } of results) assert.equal(stdout.trim(), directory);
  for (const [name, asset] of Object.entries(assets)) assert.equal(sha(await readFile(path.join(directory, name))), asset.sha256);
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual((await readdir(path.join(home, 'cache'))).filter(name => name.includes('.tmp-')), [], 'no staging directory is left');
});
