// t-ffe4.5: one place knows how to start tar and how to describe a failed spawnSync. The Windows
// tar workaround (the system's bsdtar, never Git Bash's GNU tar that comes first on PATH under
// `shell: bash`) used to be hand-written per script; a third script missed it and turned the Windows
// release-acceptance row red, and check-paseo-compat.mjs still ran bare `tar`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { exitDescription, spawnCommand, windowsTar } from '../../scripts/spawn-command.mjs';

const root = path.resolve(import.meta.dirname, '../..');

function onPlatform(t, platform) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { ...descriptor, value: platform });
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}

test('tar is the system bsdtar on Windows, from SystemRoot, whatever PATH says', t => {
  onPlatform(t, 'win32');
  const saved = process.env.SystemRoot;
  process.env.SystemRoot = 'E:\\Win';
  t.after(() => { if (saved === undefined) delete process.env.SystemRoot; else process.env.SystemRoot = saved; });
  assert.deepEqual(spawnCommand('tar', ['-xzf', 'D:\\a\\x.tgz']), ['E:\\Win\\System32\\tar.exe', ['-xzf', 'D:\\a\\x.tgz']]);
  assert.equal(windowsTar({}), 'C:\\Windows\\System32\\tar.exe');
});

test('tar and other commands are unchanged on macOS and Linux', t => {
  for (const platform of ['darwin', 'linux']) {
    onPlatform(t, platform);
    assert.deepEqual(spawnCommand('tar', ['-xzf', '/tmp/x.tgz']), ['tar', ['-xzf', '/tmp/x.tgz']]);
    assert.deepEqual(spawnCommand('npm', ['ci']), ['npm', ['ci']]);
    assert.deepEqual(spawnCommand('git', ['status']), ['git', ['status']]);
  }
});

test('exitDescription names the start error, then the signal, then the exit status', () => {
  assert.equal(exitDescription({ error: new Error('spawn tar ENOENT'), status: null }), 'could not run to completion: spawn tar ENOENT');
  assert.equal(exitDescription({ status: null, signal: 'SIGKILL' }), 'was killed by SIGKILL');
  assert.equal(exitDescription({ status: 2, signal: null }), 'exited 2');
});

test('no script starts tar or describes a spawn failure except through spawn-command.mjs', () => {
  const scripts = readdirSync(path.join(root, 'scripts')).filter(name => name.endsWith('.mjs') && name !== 'spawn-command.mjs');
  const problems = [];
  for (const name of scripts) {
    const source = readFileSync(path.join(root, 'scripts', name), 'utf8');
    // Its own copy of the Windows tar path, or a direct spawn of tar that skips spawnCommand.
    if (/System32['"]?\s*,\s*['"]tar\.exe|System32\\\\tar\.exe/.test(source)) problems.push(`${name}: its own copy of the Windows tar path`);
    if (/\bspawn(?:Sync)?\(\s*['"]tar['"]/.test(source)) problems.push(`${name}: spawns bare tar`);
    if (/\b(?:function|const)\s+exitDescription\b/.test(source)) problems.push(`${name}: its own exitDescription`);
  }
  assert.deepEqual(problems, []);
});
