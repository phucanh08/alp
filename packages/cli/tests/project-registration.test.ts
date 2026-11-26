import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { daemonPaths } from '@anhlp/alp-client/index';
import { registerProject } from '../dist/commands/dashboard/start.js';

// `any`: results and fakes here are JSON or tagged unions the tests read field by field after asserting which case they hold.
type Json = any;

for (const stage of ['connect', 'project.list', 'project.register']) test(`best-effort project registration bounds stalled ${stage} and closes late clients`, async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let closed = 0;
  const calls: unknown[] = [];
  let entered!: () => void;
  const seen = new Promise<void>(resolve => { entered = resolve; });
  const client = {
    async request(method: string): Promise<Json> {
      calls.push(method);
      if (method === stage) { entered(); await gate; }
      return method === 'project.list' ? { revision: 1 } : {};
    },
    close() { closed++; },
  };
  // The fake client answers only what registerProject asks; it stands in for a connected client.
  const connectClient = (async () => {
    if (stage === 'connect') { entered(); await gate; }
    return client;
  }) as unknown as NonNullable<Parameters<typeof registerProject>[2]>['connectClient'];
  const registering = registerProject('/unused', '/project', { timeoutMs: 20, connectClient });
  await seen;
  let watchdog;
  try {
    await Promise.race([registering, new Promise((_, reject) => { watchdog = setTimeout(() => reject(new Error('registration exceeded deadline')), 500); })]);
    if (stage === 'connect') {
      assert.equal(closed, 0, 'connection is still pending');
      release();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.ok(closed > 0, 'deadline closes current or late client');
    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    if (stage !== 'project.register') assert.ok(!calls.includes('project.register'), 'expired work never registers a project');
  } finally {
    clearTimeout(watchdog);
    release();
    await registering;
  }
});

test('a daemon that never answers hello is disconnected at the registration deadline', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-register-timeout-'));
  const sockets = new Set<net.Socket>();
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
  await new Promise<void>(resolve => server.listen(daemonPaths(home).socket, resolve));
  await registerProject(home, '/project', { timeoutMs: 100 });
  for (let i = 0; i < 100 && sockets.size; i++) await new Promise<void>(resolve => setTimeout(resolve, 5));
  assert.equal(sockets.size, 0, 'the stalled handshake socket is closed');
});
