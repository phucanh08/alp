// launchCommand: an ACP provider installed with npm on Windows is a .cmd shim spawn will not
// run without a shell; its target runs instead. Elsewhere every command is left as it is.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { launchCommand } from '../src/providers.js';

const windows = process.platform === 'win32';
const shim = target => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n${target}\r\n`;

test('a command is started as it is outside Windows, and when it is a path or names its extension', () => {
  assert.deepEqual(launchCommand('/opt/bin/opencode', ['acp']), { command: '/opt/bin/opencode', args: ['acp'] });
  assert.deepEqual(launchCommand('gemini.exe', ['--acp']), { command: 'gemini.exe', args: ['--acp'] });
  if (!windows) assert.deepEqual(launchCommand('opencode', ['acp']), { command: 'opencode', args: ['acp'] });
});

test('on Windows an npm shim starts its native target or its Node script, and an .exe on PATH wins', { skip: !windows && 'npm shims are Windows launchers' }, async t => {
  const bin = await mkdtemp(path.join(os.tmpdir(), 'alp-launch-'));
  t.after(() => rm(bin, { recursive: true, force: true }));
  await mkdir(path.join(bin, 'empty'));
  await writeFile(path.join(bin, 'native.cmd'), shim('"%dp0%\\node_modules\\native\\bin\\native.exe"   %*'));
  await writeFile(path.join(bin, 'script.cmd'), shim('"%_prog%"  "%dp0%\\node_modules\\script\\bin\\script.js" %*'));
  await writeFile(path.join(bin, 'flagged.cmd'), shim('"%_prog%" --disable-warning=DEP0040 "%dp0%\\node_modules\\flagged\\bin\\flagged" %*'));
  await writeFile(path.join(bin, 'both.cmd'), shim('"%dp0%\\other.exe" %*'));
  await writeFile(path.join(bin, 'both.exe'), '');
  await writeFile(path.join(bin, 'batch.cmd'), '@echo off\r\nstart something %*\r\n');
  const env = { Path: `${path.join(bin, 'empty')};${bin}` };
  assert.deepEqual(launchCommand('native', ['acp'], env), { command: path.join(bin, 'node_modules', 'native', 'bin', 'native.exe'), args: ['acp'] });
  assert.deepEqual(launchCommand('script', ['acp'], env), { command: process.execPath, args: [path.join(bin, 'node_modules', 'script', 'bin', 'script.js'), 'acp'] });
  assert.deepEqual(launchCommand('flagged', ['x'], env), { command: process.execPath, args: ['--disable-warning=DEP0040', path.join(bin, 'node_modules', 'flagged', 'bin', 'flagged'), 'x'] });
  assert.deepEqual(launchCommand('both', [], env), { command: 'both', args: [] });
  assert.deepEqual(launchCommand('batch', [], env), { command: 'batch', args: [] });
  assert.deepEqual(launchCommand('missing', [], env), { command: 'missing', args: [] });
});
