// Paseo's Pin to top and labels per root session (capability `session.meta`, docs/protocol/alp-json-rpc-v1.md §12.1):
// session.update and label.list over the registry's label catalog, kept in the session store.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { initProject } from '@anhlp/alp-core/init';
import { seedLibrary } from '@anhlp/alp-core/library';
import { fakeTransport } from '../../../test/support/fake-agent.js';

/** An alpd with a store and a registry under one directory; `start` again is a restart over both. */
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alpd-session-meta-'));
  const home = path.join(root, 'home');
  const state = path.join(root, 'state');
  const project = path.join(root, 'project');
  await seedLibrary(home);
  await initProject(project, { library: home });
  const stops = [];
  t.after(async () => { for (const stop of stops.reverse()) await stop(); await rm(root, { recursive: true, force: true }); });
  async function start() {
    const runtime = createAlpRuntime({ libraryDir: home, supervisor: false, transport: fakeTransport([]) });
    const store = createStore(state);
    const server = createDaemonServer({ runtime, home, store, socketPath: '', version: 'test' });
    const client = server.local();
    let stopped = false;
    const stop = async () => { if (stopped) return; stopped = true; client.close(); await store.flush().catch(() => {}); await server.close().catch(() => {}); await runtime.shutdown(); };
    stops.push(stop);
    await client.request('daemon.hello', { protocolVersion: 1, client: { name: 'test', version: '0' } });
    return { client, stop, request: (method, params) => client.request(method, params) };
  }
  /** Makes the store's sessions directory unwritable; returns the undo. */
  async function breakSessions() {
    const dir = path.join(state, 'sessions');
    await rename(dir, `${dir}.saved`);
    await writeFile(dir, 'not a directory');
    return async () => { await rm(dir, { force: true }); await rename(`${dir}.saved`, dir); };
  }
  return { project, start, breakSessions };
}

/** Adds labels to the registry's catalog as the owner's workspace label menu does. */
async function catalog(daemon, project, labels) {
  let { registry } = await daemon.request('registry.owner', {});
  if (!registry.workspaces.length) {
    await daemon.request('project.register', { directory: project, ifRevision: registry.revision, requestId: 'register' });
    ({ registry } = await daemon.request('registry.owner', {}));
  }
  const workspaceId = registry.workspaces[0].id;
  for (const label of labels) {
    ({ registry } = await daemon.request('registry.owner', { operation: 'label.assign', args: { workspaceId, label, assigned: true }, ifRevision: registry.revision, requestId: `assign-${label.name}` }));
  }
  return registry;
}

const invalid = error => error.code === -32602;

test('session.update pins and labels a root with catalog names; label.list is the catalog; neither is activity', async t => {
  const { project, start } = await setup(t);
  const daemon = await start();
  const hello = await daemon.request('daemon.hello', { protocolVersion: 1, client: { name: 'test', version: '0' } });
  assert.ok(hello.capabilities.includes('session.meta'));
  assert.deepEqual(await daemon.request('label.list', {}), { labels: [] });
  await catalog(daemon, project, [{ name: 'Bug', color: 'red' }, { name: 'Đang làm', color: 'sky' }]);
  assert.deepEqual(await daemon.request('label.list', {}), { labels: [{ name: 'Bug', color: 'red' }, { name: 'Đang làm', color: 'sky' }] });

  const older = (await daemon.request('session.create', { spec: { cwd: project, workflow: 'pho', persist: true } })).session;
  const newer = (await daemon.request('session.create', { spec: { cwd: project, workflow: 'pho', persist: true } })).session;
  const order = async () => (await daemon.request('session.list', { projectRoot: project })).sessions.map(s => s.id);
  const before = await order();
  const { session: listed } = await daemon.request('session.get', { sessionId: older.id });
  assert.equal(listed.pinnedAt, undefined);
  assert.equal(listed.labels, undefined);

  const pinned = (await daemon.request('session.update', { sessionId: older.id, pinned: true })).session;
  assert.match(pinned.pinnedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(pinned.updatedAt, listed.updatedAt, 'a pin is not activity');
  assert.equal((await daemon.request('session.update', { sessionId: older.id, pinned: true })).session.pinnedAt, pinned.pinnedAt, 'pinning again keeps the time');

  // Case-insensitive, stored in the catalog's spelling, once each.
  const labelled = (await daemon.request('session.update', { sessionId: older.id, labels: ['bug', ' BUG ', 'đang làm'] })).session;
  assert.deepEqual(labelled.labels, ['Bug', 'Đang làm']);
  assert.equal(labelled.pinnedAt, pinned.pinnedAt, 'labels alone leave the pin');
  assert.equal(labelled.updatedAt, listed.updatedAt);
  assert.deepEqual(await order(), before, 'the list keeps its order');
  const row = (await daemon.request('session.list', { projectRoot: project })).sessions.find(s => s.id === older.id);
  assert.deepEqual([row.pinnedAt, row.labels], [pinned.pinnedAt, ['Bug', 'Đang làm']]);

  await assert.rejects(daemon.request('session.update', { sessionId: older.id, labels: ['Nope'] }), error => invalid(error) && error.data?.reason === 'unknown_label');
  await assert.rejects(daemon.request('session.update', { sessionId: older.id }), invalid, 'pinned or labels');
  await assert.rejects(daemon.request('session.update', { sessionId: older.id, labels: Array.from({ length: 21 }, () => 'Bug') }), invalid, 'at most 20');
  await assert.rejects(daemon.request('session.update', { sessionId: older.id, pinned: 'yes' }), invalid);
  await assert.rejects(daemon.request('session.update', { sessionId: 'missing', pinned: true }), error => error.code === 1001);
  assert.deepEqual((await daemon.request('session.get', { sessionId: older.id })).session.labels, ['Bug', 'Đang làm'], 'a refused update changes nothing');

  const cleared = (await daemon.request('session.update', { sessionId: older.id, pinned: false, labels: [] })).session;
  assert.equal(cleared.pinnedAt, undefined);
  assert.equal(cleared.labels, undefined);
  assert.deepEqual(await order(), before);
  assert.equal(newer.labels, undefined);
});

test('pin and labels survive a restart; a catalog rename follows to the sessions, a delete leaves them', async t => {
  const { project, start } = await setup(t);
  let daemon = await start();
  await catalog(daemon, project, [{ name: 'Bug', color: 'red' }, { name: 'Later', color: 'amber' }, { name: 'Idea', color: 'teal' }]);
  const { session } = await daemon.request('session.create', { spec: { cwd: project, workflow: 'pho', persist: true } });
  const saved = (await daemon.request('session.update', { sessionId: session.id, pinned: true, labels: ['Bug', 'Later', 'Idea'] })).session;
  await daemon.stop();

  daemon = await start();
  const restored = (await daemon.request('session.get', { sessionId: session.id })).session;
  assert.equal(restored.status, 'closed');
  assert.deepEqual([restored.pinnedAt, restored.labels], [saved.pinnedAt, ['Bug', 'Later', 'Idea']]);
  // A closed root is not marked unread: no turn of it ended unseen now (board p-60e3c299).
  assert.deepEqual(await daemon.request('session.attention.mark', { sessionId: session.id }), { marked: false });

  let { registry } = await daemon.request('registry.owner', {});
  ({ registry } = await daemon.request('registry.owner', { operation: 'label.update', args: { name: 'bug', newName: 'Defect' }, ifRevision: registry.revision, requestId: 'rename' }));
  ({ registry } = await daemon.request('registry.owner', { operation: 'label.delete', args: { name: 'later' }, ifRevision: registry.revision, requestId: 'delete' }));
  assert.deepEqual((await daemon.request('session.get', { sessionId: session.id })).session.labels, ['Defect', 'Idea']);
  assert.deepEqual((await daemon.request('label.list', {})).labels.map(l => l.name), ['Defect', 'Idea']);
  await daemon.stop();

  // The records followed, not only the read: after a restart the renamed label is still there.
  daemon = await start();
  assert.deepEqual((await daemon.request('session.get', { sessionId: session.id })).session.labels, ['Defect', 'Idea']);
  // A rename to the case of another spelling, then a delete of the last one: none left, no labels field.
  ({ registry } = await daemon.request('registry.owner', {}));
  ({ registry } = await daemon.request('registry.owner', { operation: 'label.delete', args: { name: 'Defect' }, ifRevision: registry.revision, requestId: 'delete-2' }));
  ({ registry } = await daemon.request('registry.owner', { operation: 'label.delete', args: { name: 'IDEA' }, ifRevision: registry.revision, requestId: 'delete-3' }));
  const bare = (await daemon.request('session.get', { sessionId: session.id })).session;
  assert.equal(bare.labels, undefined);
  assert.equal(bare.pinnedAt, saved.pinnedAt);
});

test('a session.update that cannot be saved fails with persistence_failed and changes nothing', async t => {
  const { project, start, breakSessions } = await setup(t);
  const daemon = await start();
  await catalog(daemon, project, [{ name: 'Bug', color: 'red' }]);
  const { session } = await daemon.request('session.create', { spec: { cwd: project, workflow: 'pho', persist: true } });
  const undo = await breakSessions();
  try {
    await assert.rejects(daemon.request('session.update', { sessionId: session.id, pinned: true, labels: ['Bug'] }), error => error.data?.reason === 'persistence_failed');
  } finally { await undo(); }
  const after = (await daemon.request('session.get', { sessionId: session.id })).session;
  assert.equal(after.pinnedAt, undefined);
  assert.equal(after.labels, undefined);
});

test('a case-only rename shows the new spelling; a replayed delete leaves a label created again under that name', async t => {
  const { project, start } = await setup(t);
  const daemon = await start();
  let registry = await catalog(daemon, project, [{ name: 'Bug', color: 'red' }]);
  const { session } = await daemon.request('session.create', { spec: { cwd: project, workflow: 'pho', persist: true } });
  await daemon.request('session.update', { sessionId: session.id, labels: ['Bug'] });
  ({ registry } = await daemon.request('registry.owner', { operation: 'label.update', args: { name: 'Bug', newName: 'BUG' }, ifRevision: registry.revision, requestId: 'case' }));
  assert.deepEqual((await daemon.request('session.get', { sessionId: session.id })).session.labels, ['BUG']);
  const deletion = { operation: 'label.delete', args: { name: 'BUG' }, ifRevision: registry.revision, requestId: 'delete' };
  await daemon.request('registry.owner', deletion);
  assert.equal((await daemon.request('session.get', { sessionId: session.id })).session.labels, undefined);
  await catalog(daemon, project, [{ name: 'bug', color: 'teal' }]);
  await daemon.request('session.update', { sessionId: session.id, labels: ['BUG'] });
  await daemon.request('registry.owner', deletion);
  assert.deepEqual((await daemon.request('session.get', { sessionId: session.id })).session.labels, ['bug'], 'the replay answered its receipt and changed nothing');
});
