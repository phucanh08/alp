import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fakeDaemon, summary } from './support/fake-daemon.js';
import { startGateway, until } from './support/harness.js';
import { DEFAULT_PERMISSIONS } from '../src/policy.js';
test('worktree grants are opt-in, creator+scope-epoch bound and refreshed before cached events/resources; mappings never grant siblings', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-gw-wt-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'),
    dest = path.join(root, 'dest'),
    sibling = path.join(root, 'sibling');
  for (const d of [source, dest, sibling]) await mkdir(d);
  const daemon = fakeDaemon({
    capabilities: ['workspace.registry', 'workspace.worktree', 'attach.after'],
    sessions: [summary('generated', dest), summary('sibling', sibling)]
  });
  const permissions = ['project.read', 'session.read', 'workspace.manage'];
  const env = await startGateway(t, {
    daemon,
    credentials: {
      owner: { workspaces: [source], permissions, worktreeMappings: ['approved'] },
      other: { workspaces: [source], permissions, worktreeMappings: ['approved'] },
      missing: { workspaces: [source], permissions },
      defaults: { workspaces: [source] }
    }
  });
  assert.ok(!DEFAULT_PERMISSIONS.includes('workspace.manage'));
  let revoked = false;
  let epoch;
  const w = {
    id: 'wks_generated',
    projectId: 'prj',
    directory: dest,
    canonical: dest,
    labels: [],
    createdAt: 'now',
    worktree: { kind: 'user', source, mappingId: 'approved', principalId: env.ids.owner, grantEpoch: '' }
  };
  daemon.state.handlers['registry.worktree'] = (p) => {
    epoch ??= p.principalEpoch;
    w.worktree.grantEpoch = epoch;
    return {
      mappings: [],
      workspaces:
        !revoked &&
        p.principalId === env.ids.owner &&
        p.principalEpoch === epoch &&
        p.mappingIds.includes('approved') &&
        p.authorizedRoots.includes(source)
          ? [w]
          : []
    };
  };
  daemon.state.handlers['workspace.get'] = (p) => ({
    workspace:
      p.workspaceId === 'wks_source'
        ? { id: 'wks_source', directory: source }
        : p.workspaceId === w.id
          ? w
          : { id: 'sibling', directory: sibling },
    revision: 0
  });
  daemon.state.handlers['workspace.list'] = (p) => ({
    workspaces: p.projectRoots.includes(dest)
      ? [{ ...w, worktree: undefined, managedWorktree: true, branch: 'generated', ownerSecret: 'hidden' }]
      : [],
    revision: 0,
    total: p.projectRoots.includes(dest) ? 1 : 0,
    nextCursor: null
  });
  let writes = 0;
  daemon.state.handlers['workspace.worktree.create'] = () => {
    writes++;
    return { workspace: { ...w, worktree: undefined, managedWorktree: true }, revision: 1 };
  };
  const { client } = await env.sdk('owner');
  const listed = await client.request('workspace.list', {});
  assert.equal(listed.total, 1);
  assert.equal(listed.workspaces[0].worktree, undefined);
  assert.equal(listed.workspaces[0].ownerSecret, undefined);
  for (const label of ['other', 'missing']) {
    const { client: other } = await env.sdk(label);
    assert.equal((await other.request('workspace.list', {})).total, 0);
    await assert.rejects(other.request('session.get', { sessionId: 'generated' }), (e) => e.code === 1001);
  }
  const { client: defaults } = await env.sdk('defaults');
  await assert.rejects(
    defaults.request('workspace.worktree.create', {
      workspaceId: 'wks_source',
      mappingId: 'approved',
      requestId: 'x',
      ifRevision: 0
    }),
    (e) => e.code === 1003
  );
  assert.equal(writes, 0);
  await assert.rejects(client.request('registry.worktree', {}), (e) => e.code === -32601);
  await assert.rejects(
    client.request('workspace.worktree.create', {
      workspaceId: 'sibling',
      mappingId: 'approved',
      requestId: 'x',
      ifRevision: 0
    }),
    (e) => e.code === 1003
  );
  assert.equal(writes, 0);
  await assert.rejects(client.request('session.get', { sessionId: 'sibling' }), (e) => e.code === 1001);
  const events = [];
  client.onEvent((e) => events.push(e));
  await client.request('session.attach', { sessionId: 'generated' });
  daemon.emit('generated', { type: 'notice', text: 'before' });
  await until(() => events.some((e) => e.event.text === 'before'));
  revoked = true;
  const count = events.length;
  daemon.emit('generated', { type: 'notice', text: 'after' });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(events.length, count);
  assert.equal((await client.request('workspace.list', {})).total, 0);
  await assert.rejects(client.request('session.get', { sessionId: 'generated' }), (e) => e.code === 1001);
});
