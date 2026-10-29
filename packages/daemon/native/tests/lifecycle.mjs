// Explicit developer-only C regression tests; never part of end-user startup/install.
import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const native = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const baseline = process.env.ALP_NATIVE_BASELINE;
const skip = process.platform !== 'darwin'; // Actual Darwin only; Linux is NOT_CHECKED.
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-native-regression-'));
  t.after(() => rm(root, { recursive: true }));
  return root;
}
function compile(source, binary, extra = []) {
  const result = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-O2', ...extra, source, '-o', binary], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
function sourceAt(file) {
  if (!baseline) return readFile(file, 'utf8');
  const relative = path.relative(path.resolve(native, '../../..'), file);
  const result = spawnSync('git', ['show', `${baseline}:${relative}`], { cwd: path.resolve(native, '../../..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return Promise.resolve(result.stdout);
}
test('stalled pre-handshake child cannot hold owner past native startup deadline', { skip }, async t => {
  const root = await fixture(t), source = path.join(root, 'delayed.c'), binary = path.join(root, 'owner');
  const text = (await sourceAt(path.join(native, 'terminal-owner.c'))).replace("    char ready=getsid(0)==getpid()?'S':'E';", "    usleep(2000000); /* controlled pre-handshake stall */\n    char ready=getsid(0)==getpid()?'S':'E';");
  assert.ok(text.includes('controlled pre-handshake stall'));
  await writeFile(source, text); compile(source, binary, ['-DSTART_TIMEOUT_MS=250']);
  const start = performance.now();
  const child = childProcess.spawn(binary, ['80', '24', '100', tmpdir(), '/bin/sh'], { stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe'] });
  let events = '';
  child.stdout.resume(); child.stderr.resume(); child.stdio[4].on('error', () => {}); child.stdin.on('error', () => {});
  child.stdio[3].on('data', value => { events += value; if (events.includes('"ready"')) { child.stdio[4].end('C\n'); child.stdin.end(); } });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.ok(performance.now() - start < 1200, `startup took ${performance.now()-start}ms; ${events}`);
  assert.ok(events.includes('native_identity_unavailable'), events);
});
test('stalled control reader bounds resize queue and cleanup bypasses pending resizes', { skip }, async t => {
  const root = await fixture(t), slot = 'darwin-' + process.arch;
  const dir = path.join(root, 'native/prebuilt', slot); await mkdir(dir, { recursive: true }); await mkdir(path.join(root, 'dist'));
  const source = path.join(root, 'native/terminal-owner.c'), binary = path.join(dir, 'terminal-owner');
  await writeFile(source, '#include <stdio.h>\n#include <unistd.h>\nint main(void){dprintf(3,"{\\\"ready\\\":%d,\\\"protocol\\\":1}\\n",getpid());usleep(1000000);return 0;}\n');
  compile(source, binary);
  const sha = value => createHash('sha256').update(value).digest('hex');
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ protocol: 1, slot, source: sha(await readFile(source)), sha256: sha(await readFile(binary)) }));
  const module = path.join(root, 'dist/native-terminal.mjs');
  const adapter = path.resolve(native, '../dist/native-terminal.js');
  if (baseline) {
    // Build the baseline adapter in scratch with the installed compiler; do not alter dist.
    const ts = await sourceAt(path.resolve(native, '../src/native-terminal.ts'));
    const typescript = await import(pathToFileURL(path.resolve(native, '../../../node_modules/typescript/lib/typescript.js')).href);
    await writeFile(module, typescript.default.transpile(ts, { module: typescript.default.ModuleKind.ES2022, target: typescript.default.ScriptTarget.ES2022 }));
  } else await copyFile(adapter, module);
  const original = childProcess.spawn; let owner;
  childProcess.spawn = (...args) => { owner = original(...args); return owner; }; syncBuiltinESMExports();
  let pty;
  try { const api = await import(pathToFileURL(module).href); pty = await api.nativePtySpawn('/bin/sh', [], { cols: 80, rows: 24, cwd: tmpdir(), env: process.env, name: 'xterm' }); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
  // Ensure assertion failures still await the bounded fake owner's natural exit.
  t.after(() => pty.cleanup());
  for (let i = 0; i < 100000; i++) pty.resize(1 + i % 1000, 24);
  assert.ok(owner.stdio[4].writableLength <= owner.stdio[4].writableHighWaterMark + 32, `queued ${owner.stdio[4].writableLength} bytes`);
  let exit; pty.onExit(value => { exit = value; });
  const cleanup = pty.cleanup(); assert.equal(owner.stdio[4].destroyed, true);
  assert.equal((await cleanup).uncertain, 1); // Fake owner deliberately lacks cleanup result.
  if (!baseline) assert.equal(exit?.exitCode, null, 'unexpected owner death must notify service with unknown root exit');
});
