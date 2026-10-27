import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createShutdown } from '../server/dist/shutdown.js';
import { createWebServer } from '../server/dist/web.js';
import { childMessages } from './support/child-message.mjs';

const stages = ['unregister', 'web', 'relay', 'bridge', 'supervision', 'release'];
for (const hung of stages) test(`total deadline exits when ${hung} never settles`, { timeout: 4000 }, async t => {
  const child = fork(new URL('./support/shutdown-child.mjs', import.meta.url), [hung], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const { seen, message } = childMessages(child, 2000);
  const exited = once(child, 'exit');
  await message('ready');
  child.kill('SIGTERM');
  await message(hung);
  child.kill('SIGTERM');
  assert.deepEqual(await exited, [1, null]);
  assert.equal(seen.filter(m => m.event === 'timeout').length, 1);
  assert.equal(seen.filter(m => m.event === 'release').length, hung === 'release' ? 1 : 0);
  for (const stage of stages) assert.ok(seen.filter(m => m.event === stage).length <= 1);
});

test('cleanup errors continue once through release and fatal status upgrades a running shutdown', async () => {
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const seen = [], exits = [];
  const shutdown = createShutdown({
    steps: [
      { name: 'cleanup', run: async () => { await gate; throw new Error('cleanup failure'); } },
      { name: 'release', run: () => seen.push('release') },
    ],
    exit: code => exits.push(code), report: (stage, error) => seen.push([stage, error.message]),
  });
  const first = shutdown();
  assert.equal(shutdown(1), first);
  resume(); await first;
  assert.deepEqual(exits, [1]);
  assert.deepEqual(seen, [['cleanup', 'cleanup failure'], 'release']);
});

test('message helper rejects signal death and bounds a missing repeated-signal event', { timeout: 8000 }, async t => {
  const child = fork(new URL('./support/shutdown-child.mjs', import.meta.url), ['idle'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  t.after(() => child.kill('SIGKILL'));
  const { message } = childMessages(child, 2000);
  await message('ready');
  await assert.rejects(message('signal', m => m.signals === 2), /no signal/);
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  await assert.rejects(message('missing'), /exited before missing \(SIGKILL\)/);
});

test('web close destroys incomplete HTTP connections and awaits bridge cleanup once', { timeout: 4000 }, async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-shutdown-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  let calls = 0, done = false;
  const web = createWebServer({ home, gateway: { attach() {}, async close() { calls++; await new Promise(r => setTimeout(r, 20)); done = true; } } });
  const info = await web.listen();
  const socket = net.connect(info.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await once(socket, 'connect');
  socket.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
  socket.on('error', error => assert.equal(error.code, 'ECONNRESET'));
  const gone = new Promise(resolve => socket.once('close', resolve));
  await web.close(); await gone;
  assert.equal(calls, 1); assert.equal(done, true);
});
