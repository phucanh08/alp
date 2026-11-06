// t-1807: install.ps1 against a local mirror on Windows: the windows-x64 .zip of the bundle, the
// SHA256SUMS check with Get-FileHash, Unblock-File, app\<version> with the app\current junction,
// alp.cmd (a running 0.0.1-beta.5/6 alp.exe is renamed aside), the user PATH entry added once, and
// its refusals. The archive's node.exe is a copy of this Node. Windows only; POSIX uses install.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
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
async function mirror(t, versions = ['9.8.7'], tweak = async () => {}) {
  const out = await temp(t, 'alp-ps-mirror-');
  for (const version of versions) {
    const bundle = await fakeBundle(await temp(t, 'alp-ps-bundle-'), version, 'windows-x64');
    await tweak(bundle, version);
    await pack({ bundle, out });
  }
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

const installEnv = (localAppData, extraEnv) => ({ ...process.env, LOCALAPPDATA: localAppData, ALP_INSTALL_BASE_URL: '', ALP_INSTALL_VERSION: '', ALP_INSTALL_DIR: '', ALP_INSTALL_ROOT: '', ALP_INSTALL_NO_MODIFY_PATH: '', ALP_INSTALL_MODIFY_PATH: '', ...extraEnv });
// t-5294.5: how often, and how long, a version stays held after it ran shows in the lane's log.
const noteWaits = stdout => { for (const line of stdout.match(/^alp-install: .*(is in use; waiting|was released after \d+ ms).*$/gm) ?? []) process.stderr.write(`[install.ps1 waited] ${line}\n`); };

/** Runs install.ps1 with Windows PowerShell 5.1 (as a file), with a private LOCALAPPDATA. */
function install(args, { localAppData, extraEnv = {} }) {
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALL, ...args], {
    env: installEnv(localAppData, extraEnv), timeout: 120_000,
  }, (error, stdout, stderr) => { noteWaits(stdout); resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr }); }));
}

/** install(), calling onLine with each line install.ps1 prints as it prints it. */
function installWatching(args, { localAppData, extraEnv = {} }, onLine) {
  return new Promise(resolve => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALL, ...args], { env: installEnv(localAppData, extraEnv), windowsHide: true });
    let stdout = '', stderr = '', pending = '';
    const timer = setTimeout(() => child.kill(), 120_000);
    child.stdout.setEncoding('utf8').on('data', chunk => {
      stdout += chunk; pending += chunk;
      const lines = pending.split(/\r?\n/); pending = lines.pop();
      for (const line of lines) onLine(line);
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('close', code => { clearTimeout(timer); noteWaits(stdout); resolve({ code: code ?? 1, stdout, stderr }); });
  });
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

test('install.ps1 -Root alone is self-contained (<Root>\\bin, no PATH edit); -ModifyPath adds <Root>\\bin once; both switches conflict (t-bf7f)', { skip: !windows }, async t => {
  const saved = readUserPath();
  t.after(() => restoreUserPath(saved));
  const releases = await mirror(t);
  const localAppData = await temp(t, 'alp-ps-lad-');
  const root = path.join(localAppData, 'alp-root');
  const bin = path.join(root, 'bin');
  const onPath = () => userPath().split(';').filter(entry => entry.toLowerCase() === bin.toLowerCase()).length;
  const alone = await install(['-Root', root, '-BaseUrl', releases], { localAppData });
  assert.equal(alone.code, 0, alone.stderr);
  assert.ok(existsSync(path.join(bin, 'alp.cmd')), 'the command goes to <Root>\\bin');
  assert.ok(existsSync(path.join(root, 'app', '9.8.7', 'alp-bundle.json')), 'the bundle goes to <Root>\\app');
  assert.equal(existsSync(path.join(localAppData, 'Programs', 'alp')), false, 'nothing in the default directory');
  assert.equal(execFileSync(path.join(bin, 'alp.cmd'), ['--version'], { encoding: 'utf8', shell: true }).trim(), '9.8.7');
  assert.equal(userPath(), saved.value, '-Root alone edits no PATH');
  assert.match(alone.stdout, /is not on your user PATH/);
  const modify = await install(['-Root', root, '-ModifyPath', '-BaseUrl', releases], { localAppData });
  assert.equal(modify.code, 0, modify.stderr);
  assert.equal(onPath(), 1, `${bin} in ${userPath()}\n${modify.stdout}`);
  const again = await install(['-Root', root, '-BaseUrl', releases], { localAppData, extraEnv: { ALP_INSTALL_MODIFY_PATH: '1' } });
  assert.equal(again.code, 0, again.stderr);
  assert.match(again.stdout, /already on your user PATH/);
  assert.equal(onPath(), 1, 'ALP_INSTALL_MODIFY_PATH=1 adds no second entry');
  const conflict = await install(['-Root', root, '-ModifyPath', '-NoModifyPath', '-BaseUrl', releases], { localAppData });
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.stderr, /-NoModifyPath and -ModifyPath conflict/);
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
  // t-5ac5: -Root with -Dir is checked too: alp.cmd names <Root>\\app\\current, and cmd.exe expands a '%'.
  const root = await install(['-Dir', `${localAppData}\\bin`, '-Root', `${localAppData}\\r%TEMP%x`, '-NoModifyPath', '-BaseUrl', releases], { localAppData });
  assert.notEqual(root.code, 0);
  assert.match(root.stderr, /-Root cannot contain '%'/);
  assert.equal(existsSync(path.join(localAppData, 'bin', 'alp.cmd')), false, 'nothing installed');
});

// t-5ac5: the header says each option has an environment variable that also works with `| iex` (which
// passes no parameters). Static: runs everywhere.
test('install.ps1 documents an environment variable for every option, and reads each one it documents', () => {
  const source = readFileSync(INSTALL, 'utf8');
  const header = source.slice(0, source.indexOf('[CmdletBinding()]'));
  assert.match(header, /environment variables in brackets, which also work with `\| iex`/);
  const documented = new Map([...header.matchAll(/^#\s+-(\w+)\b.*\[(ALP_INSTALL_\w+)(=1)?\]\s*$/gm)].map(match => [match[1], match[2]]));
  const params = source.slice(source.indexOf('param('), source.indexOf('\n)\n') + 3);
  const declared = [...params.matchAll(/\[(string|switch)\]\$(\w+)(?:\s*=\s*\$env:(\w+))?/g)].map(match => ({ kind: match[1], name: match[2], env: match[3] }));
  assert.ok(declared.length >= 7, 'the param block was read');
  for (const { kind, name, env } of declared) {
    if (name === 'Help') { assert.equal(documented.has(name), false); continue; }
    assert.ok(documented.has(name), `-${name} names its environment variable`);
    const variable = documented.get(name);
    // A string defaults to its variable; a switch is set when its variable is 1.
    if (kind === 'string') assert.equal(env, variable, `-${name} defaults to $env:${variable}`);
    else assert.match(source, new RegExp(`\\$env:${variable} -eq '1'\\) \\{ \\$${name} = \\$true \\}`), `-${name} is set by ${variable}=1`);
  }
  assert.equal(documented.size, declared.length - 1, 'every documented option is a parameter');
});

const CLI = path.join('lib', 'node_modules', '@anhlp', 'alp-cli', 'dist', 'cli.js');
const resolvedCurrent = dir => realpathSync.native(path.join(dir, 'app', 'current')).toLowerCase();
const version = command => execFileSync(command, ['--version'], { encoding: 'utf8', shell: true }).trim();

test('install.ps1: an upgrade refused before any move leaves the previous version current and the alp command running it (t-598d)', { skip: !windows }, async t => {
  const localAppData = await temp(t, 'alp-ps-lad-');
  const dir = path.join(localAppData, 'alp');
  const command = path.join(dir, 'alp.cmd');
  const first = await install(['-Dir', dir, '-NoModifyPath', '-BaseUrl', await mirror(t, ['1.0.0'])], { localAppData });
  assert.equal(first.code, 0, first.stderr);
  // 2.0.0 is a valid archive whose ALP reports another version: refused after it is unpacked.
  const broken = await mirror(t, ['2.0.0'], bundle => writeFile(path.join(bundle, CLI), "console.log('6.6.6');\n"));
  const failed = await install(['-Dir', dir, '-NoModifyPath', '-BaseUrl', broken], { localAppData });
  assert.notEqual(failed.code, 0);
  assert.match(failed.stderr, /the downloaded ALP reports version '6\.6\.6', not 2\.0\.0/);
  assert.equal(resolvedCurrent(dir), path.join(dir, 'app', '1.0.0').toLowerCase(), 'app\\current still points at 1.0.0');
  assert.equal(version(command), '1.0.0');
  assert.deepEqual((await readdir(path.join(dir, 'app'))).sort(), ['1.0.0', 'current'], 'no 2.0.0 and no .alp-update-* staging left');
});

test('install.ps1: reinstalling the current version puts the running copy back when the new one cannot be moved in (t-598d, t-1f14)', { skip: !windows }, async t => {
  const localAppData = await temp(t, 'alp-ps-lad-');
  const dir = path.join(localAppData, 'alp');
  const command = path.join(dir, 'alp.cmd');
  const first = await install(['-Dir', dir, '-NoModifyPath', '-BaseUrl', await mirror(t)], { localAppData });
  assert.equal(first.code, 0, first.stderr);
  const marker = path.join(dir, 'app', '9.8.7', 'installed-first');
  await writeFile(marker, 'the running copy\n');
  // The reinstalled 9.8.7 passes its --version check but leaves a process running from (and with
  // its working directory in) the unpacked copy, so Windows refuses to move that copy into
  // app\9.8.7 after the running copy was moved aside. install.ps1 must move the running copy back.
  const holder = path.join(await temp(t, 'alp-ps-hold-'), 'pid');
  // Start-Process creates it without inheriting handles: a child of node holding install.ps1's
  // `--version` pipe would make install.ps1 wait for it to exit.
  const holding = await mirror(t, ['9.8.7'], bundle => writeFile(path.join(bundle, CLI), [
    "const { execFileSync } = require('node:child_process');",
    "const start = \"Start-Process -FilePath $env:ALP_TEST_NODE -ArgumentList '-e','setTimeout(()=>{},60000)' -WorkingDirectory $env:ALP_TEST_CWD -WindowStyle Hidden -PassThru | ForEach-Object { $_.Id }\";",
    "const pid = execFileSync('powershell.exe', ['-NoProfile', '-Command', start], { encoding: 'utf8', env: { ...process.env, ALP_TEST_NODE: process.execPath, ALP_TEST_CWD: require('node:path').dirname(process.execPath) } }).trim();",
    `require('node:fs').writeFileSync(${JSON.stringify(holder)}, pid);`,
    "console.log('9.8.7');",
    '',
  ].join('\n')));
  let failed;
  const started = Date.now();
  try {
    failed = await install(['-Dir', dir, '-NoModifyPath', '-BaseUrl', holding], { localAppData });
    assert.match(readFileSync(holder, 'utf8'), /^[0-9]+$/, 'the holding process started');
    assert.ok(Date.now() - started < 45_000, `install.ps1 returned while the holder still runs (${Date.now() - started} ms)`);
  } finally {
    // Before the temporary directories go: the holder's working directory is in one of them.
    try { process.kill(Number(readFileSync(holder, 'utf8'))); } catch {}
  }
  assert.notEqual(failed.code, 0, failed.stdout);
  assert.match(failed.stderr, /could not install .*9\.8\.7/, failed.stdout + failed.stderr);
  assert.equal(existsSync(marker), true, 'app\\9.8.7 is the running copy again');
  assert.equal(resolvedCurrent(dir), path.join(dir, 'app', '9.8.7').toLowerCase());
  assert.equal(version(command), '9.8.7');
  assert.deepEqual((await readdir(path.join(dir, 'app'))).filter(name => name.startsWith('.alp-old-')), [], 'no copy left aside');
});

// t-5294.5: `alp --version` and then a reinstall failed once on CI with "ALP 9.8.7 is in use": the version
// that just ran was still held when install.ps1 moved it aside, and a rerun passed. A user doing the same
// met the same refusal. A process run from app\9.8.7 with its working directory there stands in for that
// hold, deterministically. Windows lets a directory holding a running executable be renamed (seen on the
// lane), not one that is a process's working directory (t-598d). The install ends the holder once
// install.ps1 says it waits (a short hold), or never (a version really in use).
test('install.ps1: a reinstall waits out a short hold on the current version, and names what still runs from it after the wait (t-5294.5)', { skip: !windows }, async t => {
  const releases = await mirror(t);
  const localAppData = await temp(t, 'alp-ps-lad-');
  const dir = path.join(localAppData, 'alp');
  const first = await install(['-Dir', dir, '-NoModifyPath', '-BaseUrl', releases], { localAppData });
  assert.equal(first.code, 0, first.stderr);
  const node = path.join(dir, 'app', '9.8.7', 'node', 'node.exe');
  const hold = () => {
    const holder = spawn(node, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', cwd: path.dirname(node) });
    t.after(() => holder.kill());
    return holder;
  };

  // A short hold: released while install.ps1 waits, and the reinstall goes through.
  const brief = hold();
  let released = false;
  const waited = await installWatching(['-Dir', dir, '-NoModifyPath', '-BaseUrl', releases], { localAppData }, line => {
    if (!released && /is in use; waiting up to 10 s/.test(line)) { released = true; brief.kill(); }
  });
  assert.equal(waited.code, 0, waited.stdout + waited.stderr);
  assert.ok(released, `install.ps1 said it waits: ${waited.stdout}`);
  assert.match(waited.stdout, /was released after \d+ ms/);
  assert.equal(version(path.join(dir, 'alp.cmd')), '9.8.7');

  // A version still running when the wait ends: refused, naming the process.
  const running = hold();
  await new Promise(resolve => setTimeout(resolve, 500));
  const refused = await install(['-Dir', dir, '-NoModifyPath', '-BaseUrl', releases], { localAppData });
  assert.notEqual(refused.code, 0, refused.stdout);
  // Windows PowerShell may wrap a long error record: compare with runs of whitespace collapsed.
  const refusal = refused.stderr.replace(/\s+/g, ' ');
  assert.match(refusal, /ALP 9\.8\.7 is in use \(Windows cannot move a running version\)/, refused.stderr);
  assert.ok(refusal.includes(`node.exe (pid ${running.pid})`), refused.stderr);
  running.kill();
  assert.equal(version(path.join(dir, 'alp.cmd')), '9.8.7', 'the refused reinstall left the current version running');
});
