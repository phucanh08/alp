// The npm launcher @anhlp/alp (npm/alp, t-cd7f): which platform package it picks, what it says when
// none is installed, and that the executable's arguments, stdio, exit code and signal pass through.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { INSTALL_SH, PLATFORM_PACKAGES, RELEASES_URL, findBinary, forwards, isGlibc, onTerminal, missingMessage, platformPackage, run } from '../../npm/alp/lib/launcher.js';
import { PLATFORMS, archiveFile, platformManifest } from '../../scripts/npm-platform.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const WRAPPER = path.join(ROOT, 'npm/alp');

test('every platform maps to its package; Linux needs glibc; others are refused by name', () => {
  const glibc = () => true;
  assert.deepEqual(platformPackage({ platform: 'darwin', arch: 'arm64', glibc }), { name: '@anhlp/alp-darwin-arm64', executable: 'alp' });
  assert.deepEqual(platformPackage({ platform: 'darwin', arch: 'x64', glibc }), { name: '@anhlp/alp-darwin-x64', executable: 'alp' });
  assert.deepEqual(platformPackage({ platform: 'linux', arch: 'x64', glibc }), { name: '@anhlp/alp-linux-x64', executable: 'alp' });
  assert.deepEqual(platformPackage({ platform: 'linux', arch: 'arm64', glibc }), { name: '@anhlp/alp-linux-arm64', executable: 'alp' });
  assert.deepEqual(platformPackage({ platform: 'win32', arch: 'x64', glibc }), { name: '@anhlp/alp-win32-x64', executable: 'alp.exe' });
  assert.match(platformPackage({ platform: 'linux', arch: 'x64', glibc: () => false }).error, /glibc.*musl/);
  for (const [platform, arch] of [['freebsd', 'x64'], ['win32', 'arm64'], ['linux', 'ia32']]) {
    assert.match(platformPackage({ platform, arch, glibc }).error, new RegExp(`no build for ${platform}-${arch}`));
  }
  assert.equal(isGlibc(() => ({ header: { glibcVersionRuntime: '2.39' } })), true);
  assert.equal(isGlibc(() => ({ header: {} })), false);
  assert.equal(isGlibc(() => { throw new Error('no report'); }), false);
});

test('the launcher and the release agree on the five platform packages, and the wrapper pins them exactly', async () => {
  assert.deepEqual(Object.values(PLATFORM_PACKAGES), PLATFORMS.map(platform => platform.name));
  const wrapper = JSON.parse(await readFile(path.join(WRAPPER, 'package.json'), 'utf8'));
  assert.equal(wrapper.name, '@anhlp/alp');
  assert.deepEqual(wrapper.bin, { alp: 'bin/alp.js' });
  assert.equal(wrapper.dependencies, undefined, 'the launcher has no dependencies');
  assert.equal(wrapper.scripts, undefined, 'no install scripts: nothing is downloaded after install');
  assert.deepEqual(wrapper.optionalDependencies, Object.fromEntries(PLATFORMS.map(platform => [platform.name, wrapper.version])));
  for (const platform of PLATFORMS) {
    const pkg = platformManifest(platform, '1.2.3');
    assert.deepEqual([pkg.os, pkg.cpu], [[platform.os], [platform.cpu]]);
    assert.deepEqual(pkg.libc, platform.os === 'linux' ? ['glibc'] : undefined);
    assert.equal(pkg.bin, undefined, 'only the launcher provides `alp`');
    assert.deepEqual(pkg.files.filter(file => file.startsWith('bin/')), [`bin/${platform.executable}`]);
  }
  assert.equal(archiveFile(PLATFORMS[4], '1.2.3'), 'alp-1.2.3-windows-x64.zip');
  assert.equal(archiveFile(PLATFORMS[2], '1.2.3'), 'alp-1.2.3-linux-x64.tar.gz');
});

test('a missing platform package or executable names the fix: optional dependencies, install.sh, the releases', () => {
  const machine = { platform: 'darwin', arch: 'arm64', glibc: () => true };
  const missing = findBinary({ ...machine, resolve: () => { throw Object.assign(new Error('nope'), { code: 'MODULE_NOT_FOUND' }); } });
  assert.match(missing.error, /@anhlp\/alp-darwin-arm64, the ALP executable for this machine, is not installed/);
  assert.match(missing.error, /--include=optional/);
  assert.ok(missing.error.includes(INSTALL_SH) && missing.error.includes(RELEASES_URL));
  const noFile = findBinary({ ...machine, resolve: () => '/g/node_modules/@anhlp/alp-darwin-arm64/package.json', exists: () => false });
  assert.match(noFile.error, /has no bin.alp; reinstall it/);
  const found = findBinary({ ...machine, resolve: () => '/g/node_modules/@anhlp/alp-darwin-arm64/package.json', exists: () => true });
  assert.deepEqual(found, { binary: path.join('/g/node_modules/@anhlp/alp-darwin-arm64', 'bin', 'alp'), name: '@anhlp/alp-darwin-arm64' });
  assert.match(findBinary({ platform: 'sunos', arch: 'x64' }).error, /no build for sunos-x64[\s\S]*npm install -g @anhlp\/alp-cli@beta/);
  assert.match(findBinary({ platform: 'linux', arch: 'x64', glibc: () => false }).error, /musl[\s\S]*npm uninstall -g @anhlp\/alp && npm install -g @anhlp\/alp-cli@beta/);
  assert.match(missingMessage('x'), /^alp: x\n/);
});

/** A child process stand-in: `run` forwards signals to it and reports how it ended. */
function fakeChild() {
  const child = new EventEmitter();
  child.killed = [];
  child.kill = signal => { child.killed.push(signal); return true; };
  return child;
}

test('a terminal on any of stdin, stdout or stderr counts as a terminal', () => {
  assert.equal(onTerminal({ stdin: {}, stdout: {}, stderr: {} }), false);
  for (const stream of ['stdin', 'stdout', 'stderr']) assert.equal(onTerminal({ stdin: {}, stdout: {}, stderr: {}, [stream]: { isTTY: true } }), true, stream);
});

test('keyboard signals from a terminal already reached the executable and are not sent twice; Windows sends none', () => {
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGUSR2']) assert.equal(forwards(signal, { platform: 'darwin', tty: true }), true, signal);
  for (const signal of ['SIGINT', 'SIGQUIT']) {
    assert.equal(forwards(signal, { platform: 'linux', tty: true }), false, `${signal} from a terminal`);
    assert.equal(forwards(signal, { platform: 'linux', tty: false }), true, `${signal} sent to the launcher alone`);
  }
  for (const signal of ['SIGINT', 'SIGBREAK', 'SIGTERM']) assert.equal(forwards(signal, { platform: 'win32', tty: false }), false, signal);
  const proc = Object.assign(new EventEmitter(), { stderr: { write() {} } });
  const child = fakeChild();
  run('/x/alp', [], { platform: 'linux', tty: true, process: /** @type {any} */ (proc), spawn: /** @type {any} */ (() => child) });
  proc.emit('SIGINT');
  proc.emit('SIGTERM');
  assert.deepEqual(child.killed, ['SIGTERM'], 'the launcher outlives Ctrl-C without sending it again');
  child.emit('exit', 130, null);
});

test('run forwards signals to the executable and reports its exit code or signal; listeners are released', async () => {
  const proc = Object.assign(new EventEmitter(), { stderr: { write() {} } });
  let spawned;
  const child = fakeChild();
  const ended = run('/x/alp', ['a', '--b'], { platform: 'linux', tty: false, process: /** @type {any} */ (proc), spawn: /** @type {any} */ ((command, args, options) => { spawned = { command, args, options }; return child; }) });
  assert.deepEqual(spawned, { command: '/x/alp', args: ['a', '--b'], options: { stdio: 'inherit', windowsHide: false } });
  proc.emit('SIGINT');
  proc.emit('SIGTERM');
  assert.deepEqual(child.killed, ['SIGINT', 'SIGTERM']);
  child.emit('exit', 7, null);
  assert.deepEqual(await ended, { code: 7 });
  assert.equal(proc.listenerCount('SIGINT'), 0);

  const killed = fakeChild();
  const byTerm = run('/x/alp', [], { platform: 'linux', tty: false, process: /** @type {any} */ (proc), spawn: /** @type {any} */ (() => killed) });
  killed.emit('exit', null, 'SIGTERM');
  assert.deepEqual(await byTerm, { signal: 'SIGTERM' });

  const errors = [];
  const broken = fakeChild();
  const failed = run('/x/alp', [], { process: /** @type {any} */ (Object.assign(proc, { stderr: { write: text => errors.push(text) } })), spawn: /** @type {any} */ (() => broken) });
  broken.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
  assert.deepEqual(await failed, { code: 1 });
  assert.match(errors.join(''), /could not run \/x\/alp: spawn EACCES/);
});

/**
 * A real install layout: the launcher as npm/alp ships it, and a platform package for this host
 * whose executable is a shell script (POSIX only) standing in for ALP.
 */
async function installed(t, script, { node = false } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-npm-wrapper-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scope = path.join(directory, 'lib', 'node_modules', '@anhlp');
  const wrapper = path.join(scope, 'alp');
  await mkdir(path.join(wrapper, 'bin'), { recursive: true });
  await mkdir(path.join(wrapper, 'lib'));
  for (const file of ['package.json', 'bin/alp.js', 'lib/launcher.js']) await copyFile(path.join(WRAPPER, file), path.join(wrapper, file));
  const platform = path.join(scope, `alp-${process.platform}-${process.arch}`);
  if (script !== undefined) {
    await mkdir(path.join(platform, 'bin'), { recursive: true });
    await writeFile(path.join(platform, 'package.json'), JSON.stringify({ name: `@anhlp/alp-${process.platform}-${process.arch}`, version: '0.0.0' }));
    await writeFile(path.join(platform, 'bin', 'alp'), `#!${node ? process.execPath : '/bin/sh'}\n${script}\n`, { mode: 0o755 });
  }
  return path.join(wrapper, 'bin', 'alp.js');
}

// Real processes: a hang must fail the test, never stall the run.
const posix = { skip: process.platform === 'win32' && 'the stand-in executable is a script with a #! line', timeout: 30_000 };

test('the installed launcher passes arguments, stdin, stdout, stderr and the exit code through', posix, async t => {
  const launcher = await installed(t, 'printf "args:%s|" "$@"; cat; echo err >&2; exit 7');
  const result = spawnSync(process.execPath, [launcher, 'init', 'two words', '--flag'], { input: 'from-stdin', encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'args:init|args:two words|args:--flag|from-stdin');
  assert.equal(result.stderr, 'err\n');
});

test('the installed launcher ends by the signal that ended the executable', posix, async t => {
  const launcher = await installed(t, 'kill -TERM $$');
  const result = spawnSync(process.execPath, [launcher], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.signal, 'SIGTERM');
});

test('a signal sent to the launcher reaches the executable, whose exit code the launcher keeps', posix, async t => {
  // A Node stand-in: its SIGTERM handler is in place before it says ready (no shell trap timing).
  const launcher = await installed(t, `process.on('SIGTERM', () => { process.stdout.write('got-term pid ' + process.pid + '\\n'); process.exit(42); });
setInterval(() => {}, 1000);
process.stdout.write('ready pid ' + process.pid + '\\n');`, { node: true });
  const child = spawn(process.execPath, [launcher], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stderr.on('data', chunk => { err += chunk; });
  t.after(() => {
    // Never leave the launcher or the stand-in behind, whatever happened.
    try { child.kill('SIGKILL'); } catch {}
    const pid = /ready pid (\d+)/.exec(out)?.[1];
    if (pid) try { process.kill(Number(pid), 'SIGKILL'); } catch {}
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { out += chunk; if (out.includes('ready')) resolve(); });
    child.once('exit', (code, signal) => reject(new Error(`launcher ended before the stand-in was ready: ${code ?? signal}\n${out}${err}`)));
  });
  child.kill('SIGTERM');
  // 'close', not 'exit': stdout is drained before the assertions read it.
  const [code, signal] = await new Promise(resolve => child.once('close', (...end) => resolve(end)));
  assert.equal(signal, null);
  assert.equal(code, 42);
  assert.match(out, /got-term/);
});

test('without the platform package the installed launcher exits 1 with the install hints', { timeout: 30_000 }, async t => {
  const launcher = await installed(t, undefined);
  const result = spawnSync(process.execPath, [launcher, '--version'], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^alp: /);
  assert.ok(result.stderr.includes(INSTALL_SH), result.stderr);
});

test('the platform packages are staged from the release archives, which must match their SHA256SUMS', posix, async t => {
  const { checkArchiveSums, stagePlatform } = await import('../../scripts/npm-platform.mjs');
  const work = await mkdtemp(path.join(os.tmpdir(), 'alp-npm-stage-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  const version = '9.9.9-test';
  const platform = PLATFORMS[2];
  const name = `alp-${version}-${platform.release}`;
  await mkdir(path.join(work, 'src', name), { recursive: true });
  for (const [file, body] of [['alp', '#!/bin/sh\necho stand-in\n'], ['LICENSE', 'L\n'], ['NOTICE', 'N\n'], ['THIRD-PARTY-NOTICES.txt', 'T\n']]) await writeFile(path.join(work, 'src', name, file), body, { mode: file === 'alp' ? 0o755 : 0o644 });
  const binaries = path.join(work, 'binaries');
  await mkdir(binaries);
  const archive = path.join(binaries, archiveFile(platform, version));
  assert.equal(spawnSync('tar', ['-czf', archive, '-C', path.join(work, 'src'), name]).status, 0);
  const staged = await stagePlatform({ platform, version, binaries, work: path.join(work, 'stage') });
  assert.equal(await readFile(path.join(staged.directory, 'bin/alp'), 'utf8'), '#!/bin/sh\necho stand-in\n');
  assert.equal(staged.archive, archiveFile(platform, version));
  assert.deepEqual(JSON.parse(await readFile(path.join(staged.directory, 'package.json'), 'utf8')).libc, ['glibc']);
  const { createHash } = await import('node:crypto');
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  await assert.rejects(checkArchiveSums(binaries, version, [platform]), /SHA256SUMS is missing/);
  await writeFile(path.join(binaries, 'SHA256SUMS'), `${'0'.repeat(64)}  ${archiveFile(platform, version)}\n`);
  await assert.rejects(checkArchiveSums(binaries, version, [platform]), /does not match SHA256SUMS/);
  await writeFile(path.join(binaries, 'SHA256SUMS'), `${digest}  ${archiveFile(platform, version)}\n`);
  assert.match(await checkArchiveSums(binaries, version, [platform]), /^[0-9a-f]{64}$/);
  await assert.rejects(checkArchiveSums(binaries, version, [PLATFORMS[0]]), /does not list alp-9\.9\.9-test-darwin-arm64\.tar\.gz/);
  await writeFile(path.join(binaries, 'SHA256SUMS'), `${digest}  ${archiveFile(platform, version)}\n${'0'.repeat(64)}  ${archiveFile(platform, version)}\n`);
  await assert.rejects(checkArchiveSums(binaries, version, [platform]), /listed twice/);
});
