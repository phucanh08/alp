import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';

// session.compact rewrites the user's conversation context, so an ALP agent's connection is refused (t-de1a review).
async function connectAs(socket, agent) {
  const saved = process.env.ALP_AGENT_SESSION;
  if (agent) process.env.ALP_AGENT_SESSION = '1'; else delete process.env.ALP_AGENT_SESSION;
  try { return await connect(socket, { name: 'compact-test', version: '0' }); }
  finally { if (saved === undefined) delete process.env.ALP_AGENT_SESSION; else process.env.ALP_AGENT_SESSION = saved; }
}

test('alpd: session.compact answers the owner and refuses an agent connection 1003 user_only', { skip: process.platform === 'win32' ? 'unix socket path' : false }, async t => {
  const base = await mkdtemp(path.join(tmpdir(), 'alp-compact-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(base, { recursive: true, mode: 0o700 });
  const compacted = [];
  const library = path.join(base, 'library');
  await mkdir(library, { mode: 0o700 });
  const transport = () => ({ async initialize() {}, onNotification() {}, onFailure() {}, onRequest() {}, async close() {}, async request() { return {}; } });
  const runtime = createAlpRuntime({ transport, libraryDir: library });
  runtime.compact = sessionId => { compacted.push(sessionId); return { status: 'started' }; };
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(base).socket, version: 'test' });
  await server.listen();
  t.after(async () => { await server.close(); await runtime.shutdown(); });
  const owner = await connectAs(daemonPaths(base).socket, false);
  t.after(() => owner.close());
  await owner.request('daemon.hello', { protocolVersion: 1 });
  assert.deepEqual(await owner.request('session.compact', { sessionId: 'sa' }), { status: 'started' });
  const agent = await connectAs(daemonPaths(base).socket, true);
  t.after(() => agent.close());
  await agent.request('daemon.hello', { protocolVersion: 1 }).catch(() => {});
  await assert.rejects(agent.request('session.compact', { sessionId: 'sb' }), error => error.code === 1003 && error.data?.reason === 'user_only');
  assert.deepEqual(compacted, ['sa']);
});
