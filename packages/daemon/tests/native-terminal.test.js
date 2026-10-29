// Actual native-owner tests, never a mocked platform or permission widening.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
const skip = !['darwin', 'linux'].includes(process.platform);
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check) { const end = Date.now() + 8000; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 20)); } assert.fail('native condition timed out'); }
async function open(t, command = []) {
  const { nativePtySpawn } = await import('../dist/native-terminal.js');
  const pty = await nativePtySpawn('/bin/sh', command, { cwd: tmpdir(), env: { PATH: process.env.PATH, TERM: 'xterm-256color', PS1: 'NATIVE$ ' }, name: 'xterm-256color', cols: 80, rows: 24, killGraceMs: 100 });
  let output = ''; pty.onData(data => { output += data; });
  t.after(() => pty.cleanup());
  return { pty, text: () => output };
}
test('native owner loads a prebuilt without a runtime compiler or node-pty', { skip }, async () => {
  const { nativeTerminalCapability } = await import('../dist/native-terminal.js');
  assert.equal(nativeTerminalCapability().available, true);
});
test('native owner cleans exec shell and observed same-session orphan', { skip }, async t => {
  const { pty, text } = await open(t);
  await until(() => text().includes('NATIVE$ '));
  pty.write("sleep 4 & (sleep 4 &) ; echo OWNED; exec /bin/sh\r");
  await until(() => /\r?\nOWNED\r?\n/.test(text()));
  await new Promise(r => setTimeout(r, 100));
  const result = await pty.cleanup();
  assert.equal(result.live, 0, JSON.stringify(result));
  assert.equal(result.uncertain, 0, JSON.stringify(result));
  assert.ok(result.observed >= 3, JSON.stringify(result));
  assert.equal(alive(pty.pid), false);
});
test('unrelated process with spoofed terminal marker is never adopted or signaled', { skip }, async t => {
  const stranger = spawn('/bin/sleep', ['60'], { env: { ...process.env, ALP_TERMINAL_ID: 'atm_' + '1'.repeat(32) } });
  await new Promise((r, j) => { stranger.once('spawn', r); stranger.once('error', j); });
  // Test owns this child and remains its exclusive reaper; cleanup does not target services.
  t.after(() => { stranger.kill(); });
  const { pty } = await open(t);
  const result = await pty.cleanup();
  assert.equal(result.live, 0);
  assert.equal(alive(stranger.pid), true);
});
test('natural root exit and cleanup completion are delivered separately', { skip }, async t => {
  const { pty } = await open(t, ['-c', 'exit 7']);
  let event; pty.onExit(value => { event = value; });
  await until(() => event);
  assert.equal(event.exitCode, 7);
  const result = await pty.cleanup();
  assert.equal(result.live, 0);
  assert.equal(alive(pty.pid), false);
});
test('default service owns a real terminal without node-pty injection', { skip }, async t => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const home = await mkdtemp(path.join(tmpdir(), 'alpd-native-default-'));
  await writeFile(path.join(home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o600 });
  const { createTerminalService } = await import('../dist/terminals.js');
  const service = createTerminalService({ home, resolveWorkspace: async () => home, log: { info() {}, warn() {} }, killGraceMs: 100 });
  t.after(async () => { await service.shutdown(); await rm(home, { recursive: true, force: true }); });
  const owner = { id: 'owner', epoch: 'e' }, sink = { send() {} };
  const { terminal } = await service.create(owner, { workspaceId: 'w', cols: 80, rows: 24, requestId: 'real' });
  await service.attach(owner, sink, { terminalId: terminal.terminalId });
  await service.input(owner, sink, { terminalId: terminal.terminalId, data: "printf '\\nDEFAULT_NATIVE_OK\\n'\r" });
  await until(async () => (await service.capture(owner, { terminalId: terminal.terminalId })).lines.some(line => line === 'DEFAULT_NATIVE_OK'));
  await service.close(owner, { terminalId: terminal.terminalId });
  assert.deepEqual(service.pids(), []);
});
test('isolated shipped adapter runs with no compiler PATH and rejects a corrupted manifest', { skip }, async t => {
  const { cp, mkdtemp, readFile, writeFile, rm } = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { execFile } = await import('node:child_process');
  const root = await mkdtemp(path.join(tmpdir(), 'alpd-native-consumer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL('../dist/native-terminal.js', import.meta.url)), path.join(root, 'owner.mjs'));
  await cp(fileURLToPath(new URL('../dist/terminal-native', import.meta.url)), path.join(root, 'terminal-native'), { recursive: true });
  const run = source => new Promise((resolve, reject) => execFile(process.execPath, ['--input-type=module', '-e', source], { cwd: root, env: { PATH: '' }, timeout: 10000 }, (error, stdout, stderr) => error ? reject(new Error(`${error}\n${stderr}`)) : resolve(stdout)));
  const source = `import { nativeTerminalCapability, nativePtySpawn } from './owner.mjs'; if (!nativeTerminalCapability().available) throw Error('unavailable'); const p=await nativePtySpawn('/bin/sh',['-c','printf SHIPPED_OK'],{name:'xterm',cols:80,rows:24,cwd:${JSON.stringify(root)},env:{},killGraceMs:100}); let text='';p.onData(v=>text+=v);await new Promise(resolve=>p.onExit(resolve));const r=await p.cleanup();if(r.live||r.uncertain)throw Error(JSON.stringify(r)); console.log(text);`;
  assert.match(await run(source), /SHIPPED_OK/);
  const manifest = path.join(root, 'terminal-native/prebuilt', `${process.platform}-${process.arch}${process.platform === 'linux' ? (process.report.getReport().header.glibcVersionRuntime ? '-glibc' : '-musl') : ''}`, 'manifest.json');
  const value = JSON.parse(await readFile(manifest, 'utf8')); value.sha256 = '0'.repeat(64); await writeFile(manifest, JSON.stringify(value));
  assert.match(await run("import {nativeTerminalCapability} from './owner.mjs'; console.log(JSON.stringify(nativeTerminalCapability()));"), /"available":false/);
});
test('post-ready adapter output overflow cannot be overwritten by a clean native completion', { skip }, async () => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { nativePtySpawn } = await import('../dist/native-terminal.js');
  const fake = new EventEmitter();
  fake.stdin = new PassThrough(); fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
  fake.stdio = [fake.stdin, fake.stdout, fake.stderr, new PassThrough(), new PassThrough()];
  const original = childProcess.spawn;
  childProcess.spawn = () => { queueMicrotask(() => fake.stdio[3].write('{"ready":80000,"protocol":1}\n')); return fake; };
  syncBuiltinESMExports();
  let pty;
  try { pty = await nativePtySpawn('/bin/sh', [], { cwd: tmpdir(), env: {}, name: 'xterm', cols: 80, rows: 24 }); }
  finally { childProcess.spawn = original; syncBuiltinESMExports(); }
  // The real production window: owner ready, async host config check, no output listener yet.
  fake.stdout.write('a'.repeat(1024 * 1024)); fake.stdout.write('LOST');
  let delivered = 0; pty.onData(value => { delivered += Buffer.byteLength(value); });
  fake.stdio[3].write('{"exitCode":0,"signal":0}\n{"cleanup":true,"observed":1,"live":0,"uncertain":0}\n');
  fake.emit('close', 0);
  const result = await pty.cleanup();
  assert.equal(delivered, 1024 * 1024, 'bounded startup buffer is retained');
  assert.ok(result.uncertain > 0, 'adapter loss must survive a subsequent clean native record');
});

test('pre-spawn mode change delivers acknowledgment challenge without inventing a cleanup fault', async () => {
  const childProcess = (await import('node:child_process')).default;
  const { syncBuiltinESMExports } = await import('node:module');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const { nativePtySpawn } = await import('../dist/native-terminal.js');
  const fake = new EventEmitter();
  fake.stdin = new PassThrough(); fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
  fake.stdio = [fake.stdin, fake.stdout, fake.stderr, new PassThrough(), new PassThrough()];
  const original = childProcess.spawn;
  childProcess.spawn = () => { queueMicrotask(() => { fake.stdio[3].write('{"refused":"terminal_protection_ack_required"}\n{"cleanup":true,"observed":0,"live":0,"uncertain":0}\n'); fake.emit('close', 78); }); return fake; };
  syncBuiltinESMExports();
  try {
    await assert.rejects(nativePtySpawn('/bin/sh', [], { cwd: tmpdir(), env: {}, name: 'xterm', cols: 80, rows: 24 }), error => error.terminalReason === 'terminal_protection_ack_required' && error.cleanupResult.uncertain === 0 && error.cleanupResult.observed === 0);
  } finally { childProcess.spawn = original; syncBuiltinESMExports(); }
});

test('capability records never interpret generic errors, policy denials or malformed records as compatibility', async () => {
  const { nativeCapabilityOf } = await import('../dist/native-terminal.js');
  assert.deepEqual(nativeCapabilityOf({ status: 0, stdout: 'alp-terminal-owner:1:root-only\n' }, 'linux'), { available: true, protection: 'root-only', reason: 'bound_signal_unavailable' });
  for (const platform of ['darwin', 'win32']) assert.equal(nativeCapabilityOf({ status: 0, stdout: 'alp-terminal-owner:1:root-only' }, platform).available, false);
  for (const probe of [{ status: 78, stdout: 'EPERM' }, { status: 78, stdout: 'ENOSYS' }, { status: null, stdout: '' }, { status: 0, stdout: 'alp-terminal-owner:1:root-only\nextra' }, { status: 1, stdout: 'alp-terminal-owner:1:root-only' }]) assert.equal(nativeCapabilityOf(probe, 'linux').available, false);
  assert.deepEqual(nativeCapabilityOf({ status: 0, stdout: 'alp-terminal-owner:1' }, 'linux'), { available: true });
});
