import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { daemonPaths } from '@anhlp/alp-client/index';
import { registerProject } from '../src/interfaces.js';

for (const stage of ['connect', 'project.list', 'project.register']) test(`best-effort project registration bounds stalled ${stage} and closes late clients`, async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let closed = 0;
  const calls = [];
  let entered;
  const seen = new Promise(resolve => { entered = resolve; });
  const client = {
    async request(method) {
      calls.push(method);
      if (method === stage) { entered(); await gate; }
      return method === 'project.list' ? { revision: 1 } : {};
    },
    close() { closed++; },
  };
  const connectClient = async () => {
    if (stage === 'connect') { entered(); await gate; }
    return client;
  };
  const registering = registerProject('/unused', '/project', { timeoutMs: 20, connectClient });
  await seen;
  let watchdog;
  try {
    await Promise.race([registering, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('registration exceeded deadline')), 500); })]);
    if (stage === 'connect') {
      assert.equal(closed, 0, 'connection is still pending');
      release();
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(closed > 0, 'deadline closes current or late client');
    release();
    await new Promise(resolve => setImmediate(resolve));
    if (stage !== 'project.register') assert.ok(!calls.includes('project.register'), 'expired work never registers a project');
  } finally {
    clearTimeout(watchdog);
    release();
    await registering;
  }
});

test('a daemon that never answers hello is disconnected at the registration deadline', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-register-timeout-'));
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('data', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  await new Promise(resolve => server.listen(daemonPaths(home).socket, resolve));
  await registerProject(home, '/project', { timeoutMs: 100 });
  for (let i = 0; i < 100 && sockets.size; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sockets.size, 0, 'the stalled handshake socket is closed');
});
