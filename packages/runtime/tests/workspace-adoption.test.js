import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAlpRuntime } from '../dist/runtime.js';
import { createAssignmentResults } from '../dist/assignment-results.js';

// t-c1ba: a checkout that predates birth certification is adopted only explicitly, after the removal guard's checks.
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-adoption-')));
  const legacy = path.join(root, 'legacy');
  await mkdir(legacy);
  const assignmentResultFile = path.join(root, 'results.json');
  // As a restore leaves it: owners kept, no checkout certified.
  await writeFile(assignmentResultFile, JSON.stringify({ version: 1, workspaces: [], results: [] }));
  await writeFile(assignmentResultFile + '.initialized', '1\n');
  const runtime = createAlpRuntime({ assignmentResultFile, liveFile: path.join(root, 'live.json'), recallFile: path.join(root, 'recall.json') });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  return { root, legacy, runtime, assignmentResultFile };
}
const refused = (runtime, directory, reason = 'workspace_assignment_result') =>
  assert.rejects(runtime.withWorkspaceMutation(directory, async () => assert.fail('uncertified checkout reached its mutation')), error => error.data?.reason === reason);

test('adoption certifies a legacy checkout only after verify succeeds; the default stays refusal', async t => {
  const f = await fixture(t);
  await refused(f.runtime, f.legacy);
  let checked;
  await f.runtime.adoptWorkspace(f.legacy, async canonical => { checked = canonical; });
  assert.equal(checked, f.legacy);
  assert.equal(await f.runtime.withWorkspaceMutation(f.legacy, async () => 'adopted'), 'adopted');
  // Adopting one checkout certifies nothing else.
  const other = path.join(f.root, 'other');
  await mkdir(other);
  await refused(f.runtime, other);
});

test('a failed verification, a symlinked path or an owned checkout certifies nothing', async t => {
  const f = await fixture(t);
  await assert.rejects(f.runtime.adoptWorkspace(f.legacy, async () => { throw Object.assign(new Error('identity changed'), { data: { reason: 'identity_changed' } }); }), /identity changed/);
  await refused(f.runtime, f.legacy);
  const link = path.join(f.root, 'link');
  await symlink(f.legacy, link);
  await assert.rejects(f.runtime.adoptWorkspace(link, async () => assert.fail('verified a symlinked path')), error => error.data?.reason === 'workspace_identity');
  await refused(f.runtime, f.legacy);
  await refused(f.runtime, link);
  const ledger = createAssignmentResults(f.assignmentResultFile);
  for (const owner of [{ checkout: f.legacy }, { checkout: f.root }, { checkout: path.join(f.root, 'elsewhere'), worktree: path.join(f.legacy, 'nested') }]) {
    await ledger.put({ assignmentId: 'retained', ...owner });
    await assert.rejects(f.runtime.adoptWorkspace(f.legacy, async () => assert.fail('verified an owned checkout')), error => error.data?.reason === 'workspace_assignment_result');
    await ledger.remove('retained');
    await refused(f.runtime, f.legacy);
  }
  await writeFile(path.join(f.root, 'recall.json'), JSON.stringify([{ assignmentId: 'recalled', cwd: f.legacy }]));
  await assert.rejects(f.runtime.adoptWorkspace(f.legacy, async () => assert.fail('verified a recalled checkout')), error => error.data?.reason === 'workspace_assignment_result');
  await writeFile(path.join(f.root, 'recall.json'), '[]');
  await refused(f.runtime, f.legacy);
});

test('adoption waits for no mutation and never initializes a lost ledger', async t => {
  const f = await fixture(t);
  const fresh = path.join(f.root, 'fresh');
  await mkdir(fresh);
  await f.runtime.registerWorkspace(fresh);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const mutation = f.runtime.withWorkspaceMutation(fresh, async () => { entered(); await gate; });
  await ready;
  await assert.rejects(f.runtime.adoptWorkspace(f.legacy, async () => assert.fail('adopted during a mutation')), error => error.data?.reason === 'workspace_busy');
  release();
  await mutation;
  await refused(f.runtime, f.legacy);
  await rm(f.assignmentResultFile);
  await assert.rejects(f.runtime.adoptWorkspace(f.legacy, async () => assert.fail('adopted into a lost ledger')), error => error.data?.reason === 'workspace_assignment_result');
  await refused(f.runtime, f.legacy);
});
