// t-e80a: the pause, live, recall and result writes tell the host of each failed write as it
// happens, so alpd's disk guard holds work on a full disk at once instead of at its next check.
// Each write still fails as it did before: pauses and recall go on in memory, live entries are
// logged, and result ownership is refused to its caller. A state directory without write
// permission makes every write fail (EACCES); the disk guard, not the runtime, decides which
// errors are a full disk.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAlpRuntime } from '../dist/runtime.js';
import { createLiveBook } from '../dist/live.js';
import { createRecallBook } from '../dist/recall.js';
import { createAssignmentResults } from '../dist/assignment-results.js';

const skip = (process.platform === 'win32' || process.getuid?.() === 0) && 'POSIX permissions, not as root';

async function unwritable(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-write-errors-'));
  const state = path.join(directory, 'state');
  await mkdir(state, { mode: 0o700 });
  // Nothing can be created in `state`.
  await chmod(state, 0o500);
  t.after(async () => { await chmod(state, 0o700); await rm(directory, { recursive: true, force: true }); });
  return { directory, state };
}

const until = async (check, what) => {
  for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`${what} did not happen`);
};

test('a failed pause write reaches onWriteError at once, and the pause holds in memory as before', { skip }, async t => {
  const { state } = await unwritable(t);
  const heard = [];
  const runtime = createAlpRuntime({ language: 'English', transport: () => { throw new Error('no sessions here'); }, supervisor: false, pauseFile: path.join(state, 'pause.json'), onWriteError: error => heard.push(error) });
  runtime.pause({ reason: 'Lunch' });
  await until(() => heard.length === 1, 'the failed pause write to be reported');
  assert.equal(heard[0].code, 'EACCES');
  assert.equal(runtime.pauses().all.reason, 'Lunch');
  runtime.resume();
  await until(() => heard.length === 2, 'the second failed pause write to be reported');
  assert.equal(runtime.pauses().all, undefined);
  await runtime.shutdown();
});

test('an onWriteError that throws does not change how a pause write fails', { skip }, async t => {
  const { state } = await unwritable(t);
  const runtime = createAlpRuntime({ language: 'English', transport: () => { throw new Error('no sessions here'); }, supervisor: false, pauseFile: path.join(state, 'pause.json'), onWriteError: () => { throw new Error('the host failed'); } });
  runtime.pause({ reason: 'Lunch' });
  runtime.resume();
  // shutdown waits for the pause writes: they settle, no unhandled rejection.
  await runtime.shutdown();
});

test('failed live and recall writes reach onError and still resolve; the books keep their entries in memory', { skip }, async t => {
  const { state } = await unwritable(t);
  const heard = [];
  const live = createLiveBook(path.join(state, 'live.json'), error => heard.push(['live', error.code]));
  const entry = { assignmentId: 'a1', rootId: 'r', parentId: 'r', callId: 'c', agent: 'peer', project: '/p', ancestry: [], runtime: 'codex', model: 'm', threadId: 't', spec: {}, delegation: false, mode: 'read-only', isolation: 'shared', startedAt: 1, epoch: 'e' };
  await live.put(entry);
  assert.deepEqual(live.all().map(item => item.assignmentId), ['a1']);
  const recall = createRecallBook(path.join(state, 'recall.json'), error => heard.push(['recall', error.code]));
  await recall.add({ assignmentId: 'a1', rootId: 'r', requesters: [], agent: 'peer', project: '/p', runtime: 'codex', threadId: 't', cwd: '/p', model: 'm', status: 'completed', finishedAt: new Date().toISOString() });
  assert.equal((await recall.all()).length, 1);
  assert.deepEqual(heard, [['live', 'EACCES'], ['recall', 'EACCES']]);
  // A book without a file never reports.
  await createLiveBook(undefined, () => assert.fail('no file, no write')).put(entry);
});

test('failed result ledger and archive writes reach onError and still fail their caller', { skip }, async t => {
  const { state } = await unwritable(t);
  const heard = [];
  const ledger = createAssignmentResults(path.join(state, 'assignment-results.json'), error => heard.push(error.code));
  await assert.rejects(ledger.put({ assignmentId: 'a1', checkout: '/p' }), { code: 'EACCES' });
  assert.deepEqual(heard, ['EACCES']);

  // The ledger saves, but its archive directory cannot be made: resolving reports that write too.
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-write-errors-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'assignment-archive'), '');
  const archived = [];
  const kept = createAssignmentResults(path.join(directory, 'assignment-results.json'), error => archived.push(error.code));
  await kept.put({ assignmentId: 'a2', checkout: '/p' });
  await assert.rejects(kept.resolve('a2', { outcome: 'applied', by: 'main', at: new Date().toISOString() }));
  assert.equal(archived.length, 1);
  assert.match(archived[0], /^E(EXIST|NOTDIR)$/);
});
