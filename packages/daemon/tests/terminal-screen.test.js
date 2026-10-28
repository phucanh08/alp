import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalScreen, SCREEN_LIMITS } from '../dist/terminal-screen.js';

test('capture parses overwrite, erase, ANSI, alternate buffer and inclusive negative ranges', async t => {
  const screen = new TerminalScreen(20, 3);
  t.after(() => screen.dispose());
  screen.write('old\r\x1b[2K\x1b[31mnew\x1b[0m\r\nsecond');
  assert.deepEqual(await screen.capture({ start: 0, end: 1 }), { lines: ['new', 'second'], totalLines: 3 });
  assert.deepEqual(await screen.capture({ start: -2, end: -1, stripAnsi: false }), { lines: ['second', ''], totalLines: 3 });
  assert.deepEqual(await screen.capture({ start: 2, end: 0 }), { lines: [], totalLines: 3 });
  screen.write('\x1b[?1049h\x1b[Halt');
  assert.equal((await screen.capture()).lines[0], 'alt');
  screen.write('\x1b[?1049l');
  assert.equal((await screen.capture()).lines[0], 'new');
  screen.resize(20, 4);
  assert.equal((await screen.capture()).totalLines, 4);
});

test('pending parse, hidden OSC and combining input have hard lifetime bounds and explicit refusal', async t => {
  const pending = new TerminalScreen(20, 3);
  t.after(() => pending.dispose());
  pending.write('x'.repeat(SCREEN_LIMITS.pendingBytes + 1));
  assert.equal(pending.available, false);
  await assert.rejects(pending.capture(), error => error.data?.reason === 'terminal_capture_unavailable');
  for (const prefix of ['x', '\x1b]0;']) {
    const screen = new TerminalScreen(20, 3);
    t.after(() => screen.dispose());
    screen.write(prefix);
    for (let i = 0; i <= SCREEN_LIMITS.inputBytes / 65536; i++) {
      screen.write('\u0301'.repeat(32768));
      if (!screen.available) break;
      await screen.capture({ start: 1, end: 0 });
    }
    assert.equal(screen.available, false, 'even invisible or combined text cannot grow without bound');
    await assert.rejects(screen.capture(), error => error.data?.reason === 'terminal_capture_unavailable');
  }
});

test('disposal releases pending capture barriers instead of hanging requests', async () => {
  const screen = new TerminalScreen(80, 24);
  screen.write('pending');
  const capture = screen.capture();
  screen.dispose();
  await assert.rejects(capture, error => error.data?.reason === 'terminal_capture_unavailable');
});


test('zero-byte capture barriers and resize operations are also bounded', async () => {
  const screen = new TerminalScreen(80, 24);
  const captures = [];
  for (let i = 0; i <= SCREEN_LIMITS.pendingOperations; i++) captures.push(screen.capture().catch(error => error.data.reason));
  assert.equal(screen.available, false);
  assert.ok((await Promise.all(captures)).every(reason => reason === 'terminal_capture_unavailable'));
  const resized = new TerminalScreen(80, 24);
  for (let i = 0; i <= SCREEN_LIMITS.pendingOperations; i++) resized.resize(80, 24);
  assert.equal(resized.available, false);
});
