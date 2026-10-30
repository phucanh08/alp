// t-1e02 P2: install.ps1 against a local mirror on Windows: the windows-x64 .zip, the SHA256SUMS check
// with Get-FileHash, Unblock-File, the atomic install (a running alp.exe is renamed aside), the user
// PATH entry added once, and its refusals. The archive's alp.exe is a copy of this Node, so the
// installer's closing `alp --version` prints process.version. Windows only; POSIX uses install.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveName, pack, sums } from '../../scripts/package-binary.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALL = path.join(ROOT, 'install.ps1');
const windows = process.platform === 'win32';

async function temp(t, prefix) {
  // The long form: the runner's TEMP is an 8.3 short path (RUNNER~1), and the installer writes the long one.
  const directory = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return directory;
}

/** A mirror with alp-<version>-windows-x64.zip (alp.exe = this Node), SHA256SUMS and install.ps1. */
async function mirror(t, versions = ['9.8.7']) {
  const out = await temp(t, 'alp-ps-mirror-');
  for (const version of versions) {
    const root = await temp(t, 'alp-ps-root-');
    await writeFile(path.join(root, 'LICENSE'), 'Apache License\n');
    await writeFile(path.join(root, 'NOTICE'), 'ALP NOTICE\n');
    for (const file of ['dist/THIRD-PARTY-NOTICES.txt', 'packages/cli/dist/THIRD-PARTY-NOTICES.txt', 'packages/cli/dist/alp-web/THIRD-PARTY-NOTICES.txt']) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), `notices of ${file}\n`);
    }
    await pack({ binary: process.execPath, target: 'bun-windows-x64', out, version, root });
  }
  await copyFile(INSTALL, path.join(out, 'install.ps1'));
  await sums(out);
  return out;
}

const userPath = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: 'utf8' }).trim();
const setUserPath = value => execFileSync('powershell.exe', ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable('Path', $env:ALP_TEST_PATH, 'User')`], { env: { ...process.env, ALP_TEST_PATH: value } });

/** Runs install.ps1 with Windows PowerShell 5.1 (as a file), with a private LOCALAPPDATA. */
function install(args, { localAppData, extraEnv = {} }) {
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALL, ...args], {
    env: { ...process.env, LOCALAPPDATA: localAppData, ALP_INSTALL_BASE_URL: '', ALP_INSTALL_VERSION: '', ALP_INSTALL_DIR: '', ALP_INSTALL_NO_MODIFY_PATH: '', ...extraEnv }, timeout: 120_000,
  }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
}

test('the Windows release archive is alp-<version>-windows-x64.zip holding alp.exe and the licences', { skip: !windows }, async t => {
  const releases = await mirror(t, ['1.2.3']);
  assert.equal(archiveName('1.2.3', 'bun-windows-x64'), 'alp-1.2.3-windows-x64');
  const listing = (await readdir(releases)).sort();
  assert.deepEqual(listing, ['SHA256SUMS', 'alp-1.2.3-windows-x64.zip', 'install.ps1']);
  const sumsText = await readFile(path.join(releases, 'SHA256SUMS'), 'utf8');
  assert.match(sumsText, /^[0-9a-f]{64} {2}alp-1\.2\.3-windows-x64\.zip$/m);
  assert.match(sumsText, /^[0-9a-f]{64} {2}install\.ps1$/m);
  const x = await temp(t, 'alp-ps-x-');
  execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', path.join(releases, 'alp-1.2.3-windows-x64.zip'), '-C', x]);
  for (const file of ['alp.exe', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) assert.ok(existsSync(path.join(x, 'alp-1.2.3-windows-x64', file)), file);
});

test('install.ps1 installs to %LOCALAPPDATA%\\Programs\\alp after checking SHA256SUMS, unblocks it, and adds the user PATH once', { skip: !windows }, async t => {
  const saved = userPath();
  t.after(() => setUserPath(saved));
  const releases = await mirror(t);
  const localAppData = await temp(t, 'alp-ps-lad-');
  const dir = path.join(localAppData, 'Programs', 'alp');
  const first = await install(['-BaseUrl', pathToFileURL(releases).href], { localAppData });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /checksum verified/);
  assert.ok(first.stdout.trim().endsWith(process.version), first.stdout);
  const exe = path.join(dir, 'alp.exe');
  assert.deepEqual(await readFile(exe), await readFile(process.execPath));
  for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) assert.ok(existsSync(path.join(dir, file)), file);
  assert.equal(existsSync(`${exe}:Zone.Identifier`), false, 'no Mark of the Web');
  assert.equal(userPath().split(';').filter(entry => entry.toLowerCase() === dir.toLowerCase()).length, 1, `${dir} in ${userPath()}\n${first.stdout}`);
  // Reinstall while the old alp.exe is running: it is renamed aside, and PATH gains no second entry.
  const running = spawn(exe, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => running.kill());
  const again = await install([], { localAppData, extraEnv: { ALP_INSTALL_BASE_URL: releases } });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already on your user PATH/);
  assert.equal(userPath().split(';').filter(entry => entry.toLowerCase() === dir.toLowerCase()).length, 1);
  assert.ok((await readdir(dir)).some(name => name.startsWith('alp.exe.old-')), 'the running alp.exe was moved aside');
});

test('install.ps1 -Version picks that release, -Dir installs elsewhere, -NoModifyPath leaves PATH alone', { skip: !windows }, async t => {
  const saved = userPath();
  t.after(() => setUserPath(saved));
  const releases = await mirror(t, ['1.0.0', '1.1.0-beta.2']);
  const localAppData = await temp(t, 'alp-ps-lad-');
  const dir = path.join(localAppData, 'tools', 'bin');
  const result = await install(['-Version', 'v1.1.0-beta.2', '-Dir', dir, '-NoModifyPath', '-BaseUrl', releases], { localAppData });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(path.join(dir, 'alp.exe')));
  assert.match(result.stdout, /is not on your user PATH; add it with:/);
  assert.equal(userPath(), saved, '-NoModifyPath edits no PATH');
  const ambiguous = await install(['-NoModifyPath', '-BaseUrl', releases], { localAppData });
  assert.notEqual(ambiguous.code, 0);
  assert.match(ambiguous.stderr, /more than one/);
  const missing = await install(['-Version', '2.0.0', '-BaseUrl', releases], { localAppData });
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /no build for windows-x64/);
});

test('install.ps1 refuses a corrupted archive, a malformed SHA256SUMS, bad versions and mirrors, and installs nothing', { skip: !windows }, async t => {
  const releases = await mirror(t);
  const localAppData = await temp(t, 'alp-ps-lad-');
  const exe = path.join(localAppData, 'Programs', 'alp', 'alp.exe');
  await writeFile(path.join(releases, 'alp-9.8.7-windows-x64.zip'), 'corrupted');
  const corrupted = await install(['-NoModifyPath', '-BaseUrl', releases], { localAppData });
  assert.notEqual(corrupted.code, 0);
  assert.match(corrupted.stderr, /checksum mismatch/);
  assert.equal(existsSync(exe), false);
  await writeFile(path.join(releases, 'SHA256SUMS'), (await readFile(path.join(releases, 'SHA256SUMS'), 'utf8')).replace(/^[0-9a-f]{64}/gm, 'xyz'));
  const malformed = await install(['-NoModifyPath', '-BaseUrl', releases], { localAppData });
  assert.match(malformed.stderr, /malformed checksum/);
  const version = await install(['-Version', '1.0;rm'], { localAppData });
  assert.match(version.stderr, /invalid version/);
  const absent = await install(['-BaseUrl', path.join(releases, 'none')], { localAppData });
  assert.match(absent.stderr, /could not download/);
  const http = await install(['-BaseUrl', 'http://example.invalid/r'], { localAppData });
  assert.match(http.stderr, /must be https:\/\/, file:\/\/ or an absolute directory/);
  const help = await install(['-Help'], { localAppData });
  assert.equal(help.code, 0);
  assert.match(help.stdout, /^Usage: install\.ps1/);
  assert.equal(existsSync(exe), false);
});
