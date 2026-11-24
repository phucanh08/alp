// t-1a70 (issue #236): on Windows an npm-installed Codex is a codex.cmd launcher, which a spawn without
// a shell neither finds nor may run. ALP reads the launcher and starts what it runs; it never starts a
// shell. The first half runs everywhere against a made-up Windows file system; the second half runs on
// Windows only (the windows-daemon lane), where real npm writes the launcher and a real process starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CODEX_COMMAND, providerLaunch, readNpmShim } from '@anhlp/alp-runtime/provider-command';
import { CodexTransport } from '@anhlp/alp-runtime/transport';
import { createTransport } from '@anhlp/alp-runtime/providers';
import { teardown } from '../../../test/support/teardown.js';

const windows = process.platform === 'win32';

// npm's launcher, written out from cmd-shim's writeShim_ (lib/index.js; the same text in 4.1.0 to 8.0.0).
// The Windows half below checks that the npm of the runner still writes exactly this.
const HEAD = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n';
const progShim = (prog, target, args = '', variables = '') => `${HEAD}${variables}\r\nIF EXIST "%dp0%\\${prog}.exe" (\r\n  SET "_prog=%dp0%\\${prog}.exe"\r\n) ELSE (\r\n  SET "_prog=${prog}"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" ${args} "%dp0%\\${target}" %*\r\n`;
const nodeShim = (target, args = '') => progShim('node', target, args);
const nativeShim = target => `${HEAD}"%dp0%\\${target}"   %*\r\n`;

const SCRIPT = 'node_modules\\@openai\\codex\\bin\\codex.js';
const NODE = 'C:\\alp\\node\\node.exe';

/** A Windows host over `files` (path → text); names compare without case, as on NTFS. */
function host(files, parentEnv = {}) {
  const entries = new Map(Object.entries(files).map(([file, text]) => [file.toLowerCase(), text]));
  const asked = [];
  return {
    platform: 'win32', parentEnv, asked,
    isFile: file => { asked.push(file); return entries.has(file.toLowerCase()); },
    read: file => { if (!entries.has(file.toLowerCase())) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return entries.get(file.toLowerCase()); },
    script: file => ({ command: NODE, args: [file] }),
  };
}
const NPM = 'C:\\Users\\me\\AppData\\Roaming\\npm';
const installed = { [`${NPM}\\codex.cmd`]: nodeShim(SCRIPT), [`${NPM}\\codex`]: '#!/bin/sh\n', [`${NPM}\\codex.ps1`]: '#!/usr/bin/env pwsh\n', [`${NPM}\\${SCRIPT}`]: '' };
const launch = (command, env, files, parentEnv) => providerLaunch(command, env, CODEX_COMMAND, host(files, parentEnv));
const viaNode = { command: NODE, args: [`${NPM}\\${SCRIPT}`] };

test('outside Windows a command is started as it is, and a launcher name is refused as before', () => {
  const posix = { platform: 'linux', parentEnv: {}, isFile: () => { throw new Error('no lookup outside Windows'); }, read: () => { throw new Error('no read outside Windows'); }, script: () => { throw new Error('no Node wrapper outside Windows'); } };
  for (const command of ['codex', '/opt/bin/codex', './fake-codex.js', 'codex.exe']) assert.deepEqual(providerLaunch(command, { PATH: '/usr/bin' }, CODEX_COMMAND, posix), { command, args: [] });
  for (const command of ['codex.cmd', '/x/codex.BAT', 'codex.ps1']) assert.throws(() => providerLaunch(command, {}, CODEX_COMMAND, posix), { message: 'Codex executable must be a native binary, not a shell launcher' });
});

test("npm's launcher is read as the script or executable it runs", () => {
  assert.deepEqual(readNpmShim(nodeShim(SCRIPT)), { kind: 'script', flags: [], target: SCRIPT });
  assert.deepEqual(readNpmShim(nodeShim('node_modules\\pkg\\bin\\cli', '--disable-warning=DEP0040 --no-deprecation')), { kind: 'script', flags: ['--disable-warning=DEP0040', '--no-deprecation'], target: 'node_modules\\pkg\\bin\\cli' });
  assert.deepEqual(readNpmShim(nativeShim('node_modules\\pkg\\bin\\tool.exe')), { kind: 'native', target: 'node_modules\\pkg\\bin\\tool.exe' });
  // A checkout or an editor may have turned CRLF into LF, or added a byte-order mark.
  assert.deepEqual(readNpmShim(`\uFEFF${nodeShim(SCRIPT).replace(/\r\n/g, '\n')}`), { kind: 'script', flags: [], target: SCRIPT });
});

test('anything that is not exactly that launcher is refused, never partly read', () => {
  const good = nodeShim(SCRIPT);
  const refused = {
    'a hand-written batch file': `@echo off\r\nnode "%~dp0\\${SCRIPT}" %*\r\n`,
    'a batch file that ends like the launcher': `@echo off\r\ndel /q C:\\work\r\n"%_prog%"  "%dp0%\\${SCRIPT}" %*\r\n`,
    'the launcher with a command after it': `${good}calc.exe\r\n`,
    'the launcher with a command before the last line': good.replace('endLocal &', 'calc.exe\r\nendLocal &'),
    'the launcher with a command inside its head': good.replace('SETLOCAL\r\n', 'SETLOCAL\r\ncalc.exe\r\n'),
    'the launcher with more on the last line': good.replace(' %*\r\n', ' %* & calc.exe\r\n'),
    'the launcher with a redirection on the last line': good.replace(' %*\r\n', ' %* > C:\\x\r\n'),
    'a launcher that sets variables first': progShim('node', SCRIPT, '', '@SET NODE_OPTIONS=--require=x\r\n'),
    'a launcher for another interpreter': progShim('python', 'node_modules\\pkg\\tool.py'),
    'a target above the launcher': nodeShim('..\\..\\evil\\codex.js'),
    'a target that climbs out of node_modules': nodeShim('node_modules\\..\\..\\evil.js'),
    'a target outside node_modules': nodeShim('codex.js'),
    'a target on another drive': nodeShim('node_modules\\D:\\evil.js'),
    'a target with a variable': nodeShim('node_modules\\%TEMP%\\evil.js'),
    'a target with forward slashes': nodeShim('node_modules/../../evil.js'),
    'a Node argument that is not a flag': nodeShim(SCRIPT, 'C:\\evil.js'),
    'a Node flag with a path': nodeShim(SCRIPT, '--require=./evil.js'),
    'a Node flag with a quote': nodeShim(SCRIPT, '--title="a'),
    'a native target above the launcher': nativeShim('..\\evil.exe'),
    'a file started by its association': nativeShim('node_modules\\pkg\\bin\\cli.js'),
    "pnpm's launcher": `@SETLOCAL\r\n@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe"  "%~dp0\\${SCRIPT}" %*\r\n) ELSE (\r\n  @SET PATHEXT=%PATHEXT:;.JS;=;%\r\n  node  "%~dp0\\${SCRIPT}" %*\r\n)\r\n`,
    'an empty file': '',
    'only the head': HEAD,
  };
  for (const [name, text] of Object.entries(refused)) {
    const read = readNpmShim(text);
    assert.equal(typeof read.refused, 'string', `${name}: ${JSON.stringify(read)}`);
    assert.deepEqual(Object.keys(read), ['refused'], name);
    // The same through the lookup: an error that names the file, the reason and both ways out; nothing to start.
    assert.throws(() => launch('codex', { Path: NPM }, { ...installed, [`${NPM}\\codex.cmd`]: text }), error => {
      assert.ok(error.message.startsWith(`Codex: ${NPM}\\codex.cmd ${read.refused}. `), `${name}: ${error.message}`);
      assert.match(error.message, /without a shell/);
      assert.match(error.message, /npm install -g @openai\/codex/);
      assert.match(error.message, /ALP_CODEX_BIN/);
      return true;
    });
  }
});

test('a bare name is found on PATH: an executable as it is, the npm launcher as its script under Node', () => {
  assert.deepEqual(launch('codex', { Path: `C:\\Windows;${NPM}` }, installed), viaNode);
  // Whatever the variable is called, and with a quoted or padded entry.
  assert.deepEqual(launch('codex', { PATH: `"${NPM}"` }, installed), viaNode);
  assert.deepEqual(launch('codex', { path: `; ${NPM} ;` }, installed), viaNode);
  // Of two spellings the first in sort order is the child's, as child_process has it.
  assert.deepEqual(launch('codex', { Path: 'C:\\nothing', PATH: NPM }, installed), viaNode);
  // No PATH in the child's environment: this process's, as spawn does.
  assert.deepEqual(launch('codex', { OTHER: '1' }, installed, { Path: NPM }), viaNode);
  // Node flags of the launcher come first; the caller's arguments are appended after the script.
  assert.deepEqual(launch('codex', { Path: NPM }, { ...installed, [`${NPM}\\codex.cmd`]: nodeShim(SCRIPT, '--no-deprecation') }), { command: NODE, args: ['--no-deprecation', `${NPM}\\${SCRIPT}`] });
  // A native executable: its full path, from the earlier directory, and .com before .exe as spawn tries them.
  const native = { ...installed, 'C:\\tools\\codex.exe': 'MZ' };
  assert.deepEqual(launch('codex', { Path: `C:\\tools;${NPM}` }, native), { command: 'C:\\tools\\codex.exe', args: [] });
  assert.deepEqual(launch('codex', { Path: `${NPM};C:\\tools` }, native), viaNode);
  assert.deepEqual(launch('codex', { Path: NPM }, { ...installed, [`${NPM}\\codex.exe`]: 'MZ' }), { command: `${NPM}\\codex.exe`, args: [] });
  assert.deepEqual(launch('codex', { Path: 'C:\\tools' }, { ...native, 'C:\\tools\\codex.com': 'MZ' }), { command: 'C:\\tools\\codex.com', args: [] });
  // A launcher npm wrote for a native file.
  assert.deepEqual(launch('tool', { Path: NPM }, { [`${NPM}\\tool.cmd`]: nativeShim('node_modules\\pkg\\tool.exe'), [`${NPM}\\node_modules\\pkg\\tool.exe`]: 'MZ' }), { command: `${NPM}\\node_modules\\pkg\\tool.exe`, args: [] });
  // A bare name with its extension is that file on PATH.
  assert.deepEqual(launch('codex.exe', { Path: `${NPM};C:\\tools` }, native), { command: 'C:\\tools\\codex.exe', args: [] });
});

test('the working directory and relative PATH entries never supply the provider', () => {
  // What a project could plant: launchers and executables reachable only through a relative name.
  const planted = { 'codex.exe': 'MZ', 'codex.cmd': nodeShim(SCRIPT), '.\\codex.exe': 'MZ', '.\\codex.cmd': nodeShim(SCRIPT), 'bin\\codex.exe': 'MZ', 'bin\\codex.cmd': nodeShim(SCRIPT), [SCRIPT]: '', [`bin\\${SCRIPT}`]: '' };
  const probe = host({ ...planted, ...installed });
  assert.deepEqual(providerLaunch('codex', { Path: `.;bin;;${NPM}` }, CODEX_COMMAND, probe), viaNode);
  assert.ok(probe.asked.length > 0 && probe.asked.every(file => path.win32.isAbsolute(file)), `only absolute paths are examined: ${probe.asked.join(', ')}`);
  assert.throws(() => launch('codex', { Path: '.;bin' }, planted), /^Error: Codex was not found: no codex\.exe and no npm launcher codex\.cmd in any directory of PATH\. Install Codex with `npm install -g @openai\/codex`, or set ALP_CODEX_BIN to the full path of the native codex\.exe\.$/);
  assert.throws(() => launch('codex', {}, planted), /Codex was not found/);
  assert.throws(() => launch('codex.exe', { Path: '.' }, planted), /Codex was not found: no codex\.exe in any directory of PATH/);
  // A launcher named by a relative path is refused; it is not looked up anywhere else either.
  for (const command of ['.\\codex.cmd', 'bin\\codex.cmd', 'bin/codex.cmd', 'C:codex.cmd']) {
    assert.throws(() => launch(command, { Path: NPM }, { ...planted, ...installed }), error => error.message.startsWith(`Codex: ${command} is a launcher named by a relative path`), command);
  }
});

test('the first PATH directory that has the name decides: a refused launcher is an error, not a reason to look further', () => {
  const files = { ...installed, 'C:\\first\\codex.cmd': '@echo off\r\nstart something %*\r\n' };
  assert.throws(() => launch('codex', { Path: `C:\\first;${NPM}` }, files), /^Error: Codex: C:\\first\\codex\.cmd is not the launcher npm writes\. /);
  assert.deepEqual(launch('codex', { Path: `${NPM};C:\\first` }, files), viaNode);
  // A launcher whose script is gone (a half-removed install) names the missing file.
  const broken = { [`${NPM}\\codex.cmd`]: nodeShim(SCRIPT), 'C:\\tools\\codex.exe': 'MZ' };
  assert.throws(() => launch('codex', { Path: `${NPM};C:\\tools` }, broken), error => error.message.startsWith(`Codex: ${NPM}\\codex.cmd runs ${NPM}\\${SCRIPT}, which does not exist`));
});

test('a configured launcher is followed or refused by name: never a shell, never another file', () => {
  const env = { Path: `C:\\tools;${NPM}` };
  const files = { ...installed, 'C:\\tools\\codex.exe': 'MZ' };
  // ALP_CODEX_BIN as the user finds it: the .cmd, the name `where codex` prints first, or the script itself.
  assert.deepEqual(launch(`${NPM}\\codex.cmd`, env, files), viaNode);
  assert.deepEqual(launch(`${NPM}\\codex.CMD`, env, files), viaNode);
  assert.deepEqual(launch(`${NPM}\\codex`, env, files), viaNode);
  assert.deepEqual(launch('codex.cmd', { Path: NPM }, files), viaNode);
  assert.deepEqual(launch(`${NPM}\\${SCRIPT}`, env, files), viaNode);
  // A native path stays as it is, also when a launcher lies beside it.
  assert.deepEqual(launch('C:\\tools\\codex.exe', env, files), { command: 'C:\\tools\\codex.exe', args: [] });
  assert.deepEqual(launch('C:\\tools\\codex', env, { ...files, 'C:\\tools\\codex.cmd': nodeShim(SCRIPT) }), { command: 'C:\\tools\\codex', args: [] });
  assert.deepEqual(launch('C:\\missing\\codex', env, files), { command: 'C:\\missing\\codex', args: [] });
  // What cannot be followed fails with the file's own name, though a working codex.exe is on PATH.
  const fails = [
    [`${NPM}\\codex.ps1`, `Codex: ${NPM}\\codex.ps1 is a PowerShell script. `],
    ['codex.ps1', 'Codex: codex.ps1 is a PowerShell script. '],
    ['C:\\gone\\codex.cmd', 'Codex: C:\\gone\\codex.cmd does not exist. '],
    ['other.cmd', 'Codex: other.cmd is not in any directory of PATH. '],
    ['C:\\hand\\codex.cmd', 'Codex: C:\\hand\\codex.cmd is not the launcher npm writes. '],
    ['C:\\hand\\codex.bat', 'Codex: C:\\hand\\codex.bat is not the launcher npm writes. '],
    ['C:\\hand\\codex', 'Codex: C:\\hand\\codex.cmd is not the launcher npm writes. '],
  ];
  const hand = { ...files, 'C:\\hand\\codex.cmd': '@node "%~dp0\\codex.js" %*\r\n', 'C:\\hand\\codex.bat': '@node "%~dp0\\codex.js" %*\r\n', 'C:\\hand\\codex.js': '' };
  for (const [command, start] of fails) {
    assert.throws(() => launch(command, env, hand), error => {
      assert.ok(error.message.startsWith(start), `${command}: ${error.message}`);
      assert.match(error.message, /Install Codex with `npm install -g @openai\/codex`, or set ALP_CODEX_BIN to the full path of the native codex\.exe or of the JavaScript file the launcher runs\.$/);
      return true;
    });
  }
});

// ---- Windows only: real npm, real files, real processes. ----

const skip = !windows && 'npm writes .cmd launchers on Windows only';
const NPM_CLI = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');

// What stands in for Codex: it answers every request with the arguments and the entry it was started with.
const FAKE = `#!/usr/bin/env node
import { createInterface } from 'node:readline';
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id !== undefined) process.stdout.write(JSON.stringify({ id: message.id, result: { argv: process.argv.slice(2), entry: process.argv[1], execArgv: process.execArgv } }) + '\\n');
});
`;

/** A throwaway npm prefix with `@openai/codex` (the stand-in) installed globally by the runner's own npm. */
async function npmCodex(t) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-codex-npm-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const source = path.join(directory, 'source');
  await mkdir(path.join(source, 'bin'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.0.0-alp-test', type: 'module', bin: { codex: 'bin/codex.js' } }));
  await writeFile(path.join(source, 'bin', 'codex.js'), FAKE);
  const prefix = path.join(directory, 'prefix');
  const project = path.join(directory, 'project');
  await mkdir(project);
  assert.ok(existsSync(NPM_CLI), `npm is expected beside Node at ${NPM_CLI}`);
  const packed = spawnSync(process.execPath, [NPM_CLI, 'pack', source, '--pack-destination', directory, '--ignore-scripts', '--json'], { cwd: directory, encoding: 'utf8', timeout: 120_000, env: npmEnv(directory) });
  assert.equal(packed.status, 0, `npm pack: ${packed.stdout}${packed.stderr}${packed.error ?? ''}`);
  const tarball = path.join(directory, JSON.parse(packed.stdout.slice(packed.stdout.indexOf('[')))[0].filename);
  // --offline: the stand-in has no dependencies, so nothing may come from the registry.
  const installedGlobally = spawnSync(process.execPath, [NPM_CLI, 'install', '-g', '--prefix', prefix, '--offline', '--no-audit', '--no-fund', '--ignore-scripts', tarball], { cwd: directory, encoding: 'utf8', timeout: 240_000, env: npmEnv(directory) });
  assert.equal(installedGlobally.status, 0, `npm install -g: ${installedGlobally.stdout}${installedGlobally.stderr}${installedGlobally.error ?? ''}`);
  // The child's environment: this one's, with PATH holding only the npm prefix and Windows itself.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'PATH'));
  env.Path = `${prefix};${path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')}`;
  return { directory, prefix, project, env, script: path.join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), defer };
}
const npmEnv = directory => ({ ...process.env, npm_config_cache: path.join(directory, 'npm-cache'), npm_config_userconfig: path.join(directory, 'npmrc'), npm_config_update_notifier: 'false' });
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

test("Windows: npm's own codex.cmd is the launcher ALP reads, and a spawn without a shell does not find it", { skip }, async t => {
  const { prefix, project, env } = await npmCodex(t);
  // What `npm install -g @openai/codex` leaves in the prefix: three launchers, no executable.
  for (const name of ['codex', 'codex.cmd', 'codex.ps1']) assert.ok(existsSync(path.join(prefix, name)), `npm wrote ${name}`);
  assert.ok(!existsSync(path.join(prefix, 'codex.exe')));
  assert.equal(readFileSync(path.join(prefix, 'codex.cmd'), 'utf8'), nodeShim(SCRIPT), "the runner's npm writes the template this file tests against");
  // The defect of issue #236: the bare name, as ALP spawned it.
  const failure = await new Promise(resolve => {
    const child = spawn('codex', ['--version'], { cwd: project, env, windowsHide: true, stdio: 'ignore' });
    child.once('error', resolve);
    child.once('close', code => resolve(new Error(`codex started and exited ${code}`)));
  });
  assert.equal(failure.code, 'ENOENT', String(failure));
  assert.match(failure.message, /spawn codex ENOENT/);
});

test('Windows: a Codex installed with npm starts, without a shell, and its arguments arrive unchanged', { skip }, async t => {
  const { prefix, project, env, script, defer } = await npmCodex(t);
  assert.deepEqual(providerLaunch('codex', env, CODEX_COMMAND), { command: process.execPath, args: [script] });
  const started = async (transport, expected) => {
    defer(() => transport.close());
    const answer = await transport.request('initialize', {}, 30_000);
    assert.deepEqual(answer.argv, expected);
    assert.ok(same(answer.entry, script), `${answer.entry} is the script of the npm package`);
    assert.deepEqual(answer.execArgv, []);
  };
  // As alpd starts it: the provider registry, the bare name, the session's working directory.
  await started(createTransport({ codexCommand: 'codex' }, 'codex', project, env), ['app-server', '--listen', 'stdio://']);
  // Every character cmd.exe would act on, had a shell been involved; and what Windows quoting gets wrong when done by hand.
  const hostile = ['two words', 'a&b', '&calc.exe', 'a|b', 'a^b', '^', '%PATH%', '%*', '%%', '!PATH!', 'say "hi"', '"', '\\"', 'ends with backslash\\', 'C:\\Program Files\\x\\', 'line one\nline two', 'cr\r\nlf', 'tab\there', '(a)', '<in >out', 'a;b,c=d', '*?', '', ' ', "'single'", '`tick`', '$env:PATH', '@file', 'ünïcödé ✓'];
  await started(new CodexTransport('codex', project, env, hostile), hostile);
  // ALP_CODEX_BIN set to the launcher, or to the name `where codex` prints first.
  await started(new CodexTransport(path.join(prefix, 'codex.cmd'), project, env, hostile), hostile);
  await started(new CodexTransport(path.join(prefix, 'codex'), project, {}, ['app-server']), ['app-server']);
});

test('Windows: a launcher ALP cannot follow, and a Codex that is not installed, fail with what to do; the project directory is not searched', { skip }, async t => {
  const { directory, prefix, project, env } = await npmCodex(t);
  // A project that ships its own codex: none of it may start.
  await writeFile(path.join(project, 'codex.cmd'), readFileSync(path.join(prefix, 'codex.cmd')));
  await writeFile(path.join(project, 'codex.exe'), 'not a program');
  const empty = path.join(directory, 'empty');
  await mkdir(empty);
  const none = { ...env, Path: `${empty};.` };
  assert.throws(() => new CodexTransport('codex', project, none), /^Error: Codex was not found: no codex\.exe and no npm launcher codex\.cmd in any directory of PATH\. Install Codex with `npm install -g @openai\/codex`/);
  assert.throws(() => createTransport({ codexCommand: 'codex' }, 'codex', project, none), /Codex was not found/);
  // A hand-written launcher, on PATH or configured: refused by name.
  const hand = path.join(directory, 'hand');
  await mkdir(hand);
  await writeFile(path.join(hand, 'codex.cmd'), `@node "%~dp0\\..\\prefix\\${SCRIPT}" %*\r\n`);
  const refusedCmd = new RegExp(`^Error: Codex: ${path.join(hand, 'codex.cmd').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')} is not the launcher npm writes\\. ALP starts Codex without a shell`);
  assert.throws(() => new CodexTransport('codex', project, { ...env, Path: `${hand};${prefix}` }), refusedCmd);
  assert.throws(() => new CodexTransport(path.join(hand, 'codex.cmd'), project, env), refusedCmd);
  assert.throws(() => new CodexTransport(path.join(prefix, 'codex.ps1'), project, env), /codex\.ps1 is a PowerShell script\. .*ALP_CODEX_BIN/);
});
