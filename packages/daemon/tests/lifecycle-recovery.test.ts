// Unknown is an answer, not a successful commit. Startup observation must be durable,
// including legacy unknown entries, without extending their retention on every restart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createLifecycle, createLifecycleJournal } from '@anhlp/alp-daemon/lifecycle';

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-lifecycle-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, journal: createLifecycleJournal(directory) };
}
function entry(journal, operation, state) {
  const now = new Date().toISOString();
  return { version: 1, key: journal.keyOf('root', operation, state), resource: 'root', operation,
    requestId: state, fingerprint: 'original', state, plan: { root: 'root' }, createdAt: now, updatedAt: now };
}
for (const operation of ['configure', 'fork', 'rewind', 'reload']) {
  for (const state of ['prepared', 'unknown']) {
    test(`${operation} ${state}: startup observes unknown once, repeats stay unknown and conflict detection survives`, async t => {
      const { directory, journal } = await setup(t);
      const original = entry(journal, operation, state);
      await journal.put(original);
      const logs = [];
      const commits = { [operation]: () => assert.fail('an unknown must never be committed') };
      await createLifecycle(journal).recover(commits, (message, fields) => logs.push({ message, fields }));
      const seen = await journal.get('root', operation, state);
      assert.equal(seen.state, 'unknown');
      assert.equal(typeof seen.recoverySeenAt, 'string', 'durable startup observation');
      assert.equal(seen.result, undefined, 'no fabricated success');
      assert.equal(logs.filter(log => log.fields.code === 'ALPD_LIFECYCLE_UNKNOWN').length, 1);
      const filename = path.join(directory, `${original.key}.json`);
      // A subsequent start must not touch the terminal entry, even after later mutations.
      const aged = new Date(Date.now() - 30_000);
      await utimes(filename, aged, aged);
      const before = await stat(filename);
      await createLifecycle(journal).recover(commits, (message, fields) => logs.push({ message, fields }));
      assert.deepEqual(await journal.get('root', operation, state), seen);
      assert.equal((await stat(filename)).mtimeMs, before.mtimeMs);
      assert.equal(logs.length, 1, 'no startup replay of a seen unknown');
      const lifecycle = createLifecycle(journal);
      const steps = { prepare: () => assert.fail('unknown may not prepare again'), apply: () => assert.fail('unknown may not send again'), commit: commits[operation] };
      const request = { resource: 'root', operation, requestId: state, fingerprint: 'original' };
      await assert.rejects(lifecycle.run(request, steps), error => error.data?.reason === 'outcome_unknown');
      await assert.rejects(lifecycle.run({ ...request, fingerprint: 'other' }, steps), error => error.data?.reason === 'key_conflict');
      let calls = 0;
      await lifecycle.run({ ...request, requestId: 'new' }, { prepare: async () => ({}), apply: async () => { calls++; return {}; }, commit: async () => ({ ok: true }) });
      assert.equal(calls, 1, 'a new requestId remains usable');
      await journal.prune(1000);
      assert.equal(await journal.get('root', operation, state), undefined, 'seen unknown retains normal terminal retention');
    });
  }
}

test('a failed observation write remains eligible next startup and cannot fabricate a commit', async t => {
  const { journal } = await setup(t);
  const original = entry(journal, 'rewind', 'unknown');
  await journal.put(original);
  const persisted = await journal.get('root', 'rewind', 'unknown');
  const logs = [];
  const broken = { ...journal, put: async () => { throw new Error('disk unavailable'); } };
  const commits = { rewind: () => assert.fail('unknown cannot roll forward') };
  await createLifecycle(broken).recover(commits, (_message, fields) => logs.push(fields.code));
  assert.deepEqual(await journal.get('root', 'rewind', 'unknown'), persisted);
  assert.deepEqual(logs, ['ALPD_LIFECYCLE_OBSERVE_FAILED']);
  await createLifecycle(journal).recover(commits, (_message, fields) => logs.push(fields.code));
  assert.equal(typeof (await journal.get('root', 'rewind', 'unknown')).recoverySeenAt, 'string');
  assert.deepEqual(logs, ['ALPD_LIFECYCLE_OBSERVE_FAILED', 'ALPD_LIFECYCLE_UNKNOWN']);
});
