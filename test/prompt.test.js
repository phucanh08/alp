import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Cancelled, select } from '../packages/client/src/prompt.js';

const terminal = () => {
  const input = Object.assign(new PassThrough(), { isTTY: true, isRaw: false, setRawMode(mode) { this.isRaw = mode; } });
  const output = new PassThrough();
  let shown = '';
  output.on('data', chunk => { shown += chunk; });
  return { input, output, shown: () => shown.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '') };
};
const choices = [{ label: 'Mix', value: 'mix' }, { label: 'Codex only', value: 'codex' }, { label: 'Claude only', value: 'claude' }];

test('select starts on the initial choice, moves with arrows and j/k, wraps, and picks with Enter', async () => {
  const io = terminal();
  const picked = select({ message: 'Runtime', choices, initial: 'codex' }, io);
  io.input.write('\x1b[B');
  io.input.write('j');
  io.input.write('\x1b[A');
  io.input.write('\x1b[A');
  io.input.write('\r');
  assert.equal(await picked, 'codex');
  assert.equal(io.input.isRaw, false, 'raw mode is restored');
  assert.match(io.shown(), /✔ Runtime Codex only/);
});

test('select cancels on Ctrl-C and Esc', async () => {
  for (const key of ['\x03', '\x1b']) {
    const io = terminal();
    const picked = select({ message: 'Runtime', choices }, io);
    io.input.write(key);
    await assert.rejects(picked, Cancelled);
    assert.equal(io.input.isRaw, false);
  }
});
