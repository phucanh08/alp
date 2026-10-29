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
test('isolated native prototype loads a prebuilt without a runtime compiler or node-pty', { skip }, async () => {
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
