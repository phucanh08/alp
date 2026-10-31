// t-1807: install.ps1 against a local mirror on Windows: the windows-x64 .zip of the bundle, the
// SHA256SUMS check with Get-FileHash, Unblock-File, app\<version> with the app\current junction,
// alp.cmd (a running 0.0.1-beta.5/6 alp.exe is renamed aside), the user PATH entry added once, and
// its refusals. The archive's node.exe is a copy of this Node. Windows only; POSIX uses install.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { archiveName, pack, sums } from '../../scripts/package-binary.mjs';
import { fakeBundle } from '../support/fake-bundle.mjs';

const ROOT = path.resolve(import.meta.dirname, '../..');
const INSTALL = path.join(ROOT, 'install.ps1');
const windows = process.platform === 'win32';

async function temp(t, prefix) {
  // The long form: the runner's TEMP is an 8.3 short path (RUNNER~1), and the installer writes the long one.
  const directory = realpathSync.native(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  return directory;
}

/** A mirror with alp-<version>-windows-x64.zip (the fake bundle), SHA256SUMS and install.ps1. */
async function mirror(t, versions = ['9.8.7']) {
  const out = await temp(t, 'alp-ps-mirror-');
  for (const version of versions) await pack({ bundle: await fakeBundle(await temp(t, 'alp-ps-bundle-'), version, 'windows-x64'), out });
  await copyFile(INSTALL, path.join(out, 'install.ps1'));
  await sums(out);
  return out;
}

// HKCU\Environment Path, unexpanded, with its registry kind, so a restore puts back exactly what was there.
const ps = script => execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).trim();
const readUserPath = () => JSON.parse(ps("$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); $has = $k.GetValueNames() -contains 'Path'; @{ has = $has; value = [string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames'); kind = $(if ($has) { [string]$k.GetValueKind('Path') } else { '' }) } | ConvertTo-Json -Compress"));
const userPath = () => readUserPath().value;
const restoreUserPath = saved => execFileSync('powershell.exe', ['-NoProfile', '-Command',
  "$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment'); if ($env:ALP_TEST_HAS -eq '1') { $k.SetValue('Path', $env:ALP_TEST_PATH, $env:ALP_TEST_KIND) } else { $k.DeleteValue('Path', $false) }; $k.Close()"],
  { env: { ...process.env, ALP_TEST_HAS: saved.has ? '1' : '0', ALP_TEST_PATH: saved.value, ALP_TEST_KIND: saved.kind || 'ExpandString' } });

/** Runs install.ps1 with Windows PowerShell 5.1 (as a file), with a private LOCALAPPDATA. */
function install(args, { localAppData, extraEnv = {} }) {
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALL, ...args], {
    env: { ...process.env, LOCALAPPDATA: localAppData, ALP_INSTALL_BASE_URL: '', ALP_INSTALL_VERSION: '', ALP_INSTALL_DIR: '', ALP_INSTALL_ROOT: '', ALP_INSTALL_NO_MODIFY_PATH: '', ALP_INSTALL_MODIFY_PATH: '', ...extraEnv }, timeout: 120_000,
  }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));
}

test('the Windows release archive is alp-<version>-windows-x64.zip holding the bundle', { skip: !windows }, async t => {
  const releases = await mirror(t, ['1.2.3']);
  assert.equal(archiveName('1.2.3', 'windows-x64'), 'alp-1.2.3-windows-x64');
  const listing = (await readdir(releases)).sort();
  assert.deepEqual(listing, ['SHA256SUMS', 'alp-1.2.3-windows-x64.zip', 'install.ps1']);
  const sumsText = await readFile(path.join(releases, 'SHA256SUMS'), 'utf8');
  assert.match(sumsText, /^[0-9a-f]{64} {2}alp-1\.2\.3-windows-x64\.zip$/m);
  assert.match(sumsText, /^[0-9a-f]{64} {2}install\.ps1$/m);
  const x = await temp(t, 'alp-ps-x-');
  execFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', path.join(releases, 'alp-1.2.3-windows-x64.zip'), '-C', x]);
  for (const file of ['bin\\alp.cmd', 'node\\node.exe', 'alp-bundle.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) assert.ok(existsSync(path.join(x, 'alp-1.2.3-windows-x64', file)), file);
});

test('install.ps1 installs to %LOCALAPPDATA%\\Programs\\alp after checking SHA256SUMS, unblocks it, and adds the user PATH once', { skip: !windows }, async t => {
  const saved = readUserPath();
  t.after(() => restoreUserPath(saved));
  const releases = await mirror(t);
  // The downloaded zip carries the Mark of the Web, as a browser or Invoke-WebRequest leaves it.
  await writeFile(path.join(releases, 'alp-9.8.7-windows-x64.zip:Zone.Identifier'), '[ZoneTransfer]\r\nZoneId=3\r\n');
  const localAppData = await temp(t, 'alp-ps-lad-');
  const dir = path.join(localAppData, 'Programs', 'alp');
  // An ALP 0.0.1-beta.5/6 single-file install, still running: install.ps1 moves its alp.exe aside.
  await mkdir(dir, { recursive: true });
  const exe = path.join(dir, 'alp.exe');
  await copyFile(process.execPath, exe);
  const running = spawn(exe, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  t.after(() => running.kill());
  const first = await install(['-BaseUrl', pathToFileURL(releases).href], { localAppData });
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /checksum verified/);
  assert.ok(first.stdout.trim().endsWith('9.8.7'), first.stdout);
  assert.equal(existsSync(exe), false, 'the old alp.exe no longer shadows alp.cmd');
  assert.ok((await readdir(dir)).some(name => name.startsWith('alp.exe.old-')), 'the running alp.exe was moved aside');
  const command = path.join(dir, 'alp.cmd');
  assert.equal(execFileSync(command, ['--version'], { encoding: 'utf8', shell: true }).trim(), '9.8.7');
  assert.ok(existsSync(path.join(dir, 'app', '9.8.7', 'alp-bundle.json')));
  assert.equal(realpathSync.native(path.join(dir, 'app', 'current')).toLowerCase(), path.join(dir, 'app', '9.8.7').toLowerCase(), 'app\\current is a junction to the version');
  assert.equal(existsSync(path.join(dir, 'app', '9.8.7', 'node', 'node.exe:Zone.Identifier')), false, 'no Mark of the Web');
  assert.equal(userPath().split(';').filter(entry => entry.toLowerCase() === dir.toLowerCase()).length, 1, `${dir} in ${userPath()}\n${first.stdout}`);
  assert.equal(readUserPath().kind, saved.has ? saved.kind : 'ExpandString', 'the user Path keeps its registry kind');
  // Reinstall: PATH gains no second entry, and current still runs.
  const again = await install([], { localAppData, extraEnv: { ALP_INSTALL_BASE_URL: releases } });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already on your user PATH/);
  assert.equal(userPath().split(';').filter(entry => entry.toLowerCase() === dir.toLowerCase()).length, 1);
  assert.equal(execFileSync(command, ['--version'], { encoding: 'utf8', shell: true }).trim(), '9.8.7');
});

test('install.ps1 -Version picks that release, -Dir installs elsewhere, -NoModifyPath leaves PATH alone', { skip: !windows }, async t => {
  const saved = readUserPath();
  t.after(() => restoreUserPath(saved));
  const releases = await mirror(t, ['1.0.0', '1.1.0-beta.2']);
  const localAppData = await temp(t, 'alp-ps-lad-');
  const dir = path.join(localAppData, 'tools', 'bin');
  const result = await install(['-Version', 'v1.1.0-beta.2', '-Dir', dir, '-NoModifyPath', '-BaseUrl', releases], { localAppData });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(existsSync(path.join(dir, 'alp.cmd')));
  assert.ok(existsSync(path.join(dir, 'app', '1.1.0-beta.2')), 'the bundle goes beside -Dir by default');
  assert.match(result.stdout, /is not on your user PATH; add it in Settings/);
  assert.equal(userPath(), saved.value, '-NoModifyPath edits no PATH');
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
  const exe = path.join(localAppData, 'Programs', 'alp', 'alp.cmd');
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

test('install.ps1 piped to Invoke-Expression leaves the session usable: no exit, no leaked preferences', { skip: !windows }, async t => {
  const releases = await mirror(t);
  const localAppData = await temp(t, 'alp-ps-lad-');
  const shells = ['powershell.exe'];
  try { execFileSync('pwsh.exe', ['-NoProfile', '-Command', '1'], { stdio: 'ignore' }); shells.push('pwsh.exe'); } catch {}
  for (const shell of shells) {
    // A failing install (no such version) throws into the caller, which keeps running.
    const script = `$ErrorActionPreference = 'Continue'; try { Get-Content -Raw -LiteralPath $env:ALP_TEST_SCRIPT | Invoke-Expression } catch { 'caught: ' + $_ }; 'still here'; 'preference ' + $ErrorActionPreference; 'leaked ' + [bool](Get-Variable -Name entries -Scope Global -ErrorAction SilentlyContinue)`;
    const out = execFileSync(shell, ['-NoProfile', '-Command', script], { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: localAppData, ALP_TEST_SCRIPT: INSTALL, ALP_INSTALL_BASE_URL: releases, ALP_INSTALL_VERSION: '7.7.7', ALP_INSTALL_NO_MODIFY_PATH: '1', ALP_INSTALL_DIR: '' } });
    assert.match(out, /caught: alp-install: error: this release has no build for windows-x64/, `${shell}: ${out}`);
    assert.match(out, /still here/, shell);
    assert.match(out, /preference Continue/, shell);
    assert.match(out, /leaked False/, shell);
    // And a successful one through Invoke-Expression installs.
    const ok = execFileSync(shell, ['-NoProfile', '-Command', 'Get-Content -Raw -LiteralPath $env:ALP_TEST_SCRIPT | Invoke-Expression'], { encoding: 'utf8', env: { ...process.env, LOCALAPPDATA: localAppData, ALP_TEST_SCRIPT: INSTALL, ALP_INSTALL_BASE_URL: releases, ALP_INSTALL_VERSION: '', ALP_INSTALL_NO_MODIFY_PATH: '1', ALP_INSTALL_DIR: path.join(localAppData, shell) } });
    assert.ok(ok.trim().endsWith('9.8.7'), `${shell}: ${ok}`);
  }
});

test('install.ps1 refuses a -Dir with a PATH separator or a %', { skip: !windows }, async t => {
  const releases = await mirror(t);
  const localAppData = await temp(t, 'alp-ps-lad-');
  const result = await install(['-Dir', `${localAppData}\\a;b`, '-BaseUrl', releases], { localAppData });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /cannot contain ';'/);
  // t-598d: the user Path is REG_EXPAND_SZ, so a '%' would be expanded.
  const percent = await install(['-Dir', `${localAppData}\\a%TEMP%b`, '-BaseUrl', releases], { localAppData });
  assert.notEqual(percent.code, 0);
  assert.match(percent.stderr, /cannot contain '%'/);
});
