// Retention (ALPD §68): old trees go with their timeline and run log, while trees with a live
// session, a receipt still in its window, or a recent restore stay, at start and in the sweeps of a running alpd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';

const DAY = 24 * 60 * 60 * 1000;
const ago = days => new Date(Date.now() - days * DAY).toISOString();

async function until(check, what) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`${what} did not happen`);
}

test('retention keeps live trees and trees with receipts in their window, removes the rest, and sweeps while running', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-retention-'));
  const state = path.join(directory, 'state');
  const runs = path.join(directory, 'runs');
  for (const name of ['sessions', 'timeline', 'receipts']) await mkdir(path.join(state, name), { recursive: true });
  await mkdir(runs);
  // Written when its record says, as alpd would have written it.
  const record = async (id, rootId, status, updatedAt, extra = {}) => {
    const file = path.join(state, 'sessions', `${id}.json`);
    await writeFile(file, JSON.stringify({ version: 1, id, rootId, status, createdAt: updatedAt, updatedAt, session: { id, agent: 'main', ...(id === rootId ? {} : { parentId: rootId }) }, ...extra }));
    await utimes(file, new Date(updatedAt), new Date(updatedAt));
  };
  const receipt = async (name, sessionId, days) => {
    // Content and time land together, as a sweep may read the receipt at any moment.
    const file = path.join(state, 'receipts', `${name}.json`);
    const temporary = path.join(directory, `${name}.json`);
    await writeFile(temporary, JSON.stringify({ version: 1, sessionId, clientMessageId: name, fingerprint: 'f', state: 'completed', outcome: 'accepted', updatedAt: ago(days) }));
    const at = new Date(Date.now() - days * DAY);
    await utimes(temporary, at, at);
    await rename(temporary, file);
  };
  for (const root of ['old', 'archived', 'receipted', 'working', 'recent', 'restored', 'later']) {
    await writeFile(path.join(state, 'timeline', `${root}.jsonl`), `${JSON.stringify({ sessionId: root, epoch: 'e', seq: 1, cursor: 1, ts: 't', event: { type: 'turn.ended' } })}\n`);
    await writeFile(path.join(runs, `${root}.jsonl`), '{}\n');
  }
  await record('old', 'old', 'closed', ago(40));
  await record('old-child', 'old', 'closed', ago(40));
  await record('archived', 'archived', 'closed', ago(31), { archived: true });
  // Its last prompt's receipt is still honoured: a retry must find the session.
  await record('receipted', 'receipted', 'closed', ago(40));
  await receipt('r-receipted', 'receipted', 2);
  // A child still working (as a crash leaves it) keeps its whole tree.
  await record('working', 'working', 'closed', ago(40));
  await record('working-child', 'working', 'running', ago(40));
  await record('recent', 'recent', 'error', ago(10));
  // Restored from an old backup today: its record says 40 days, its file was written now.
  await record('restored', 'restored', 'closed', ago(40));
  await utimes(path.join(state, 'sessions', 'restored.json'), new Date(), new Date());
  // Kept at start by its receipt; that receipt ages out while alpd runs.
  await record('later', 'later', 'closed', ago(40));
  await receipt('r-later', 'later', 6);
  await receipt('r-gone', 'nobody', 8);

  const runtime = createAlpRuntime({ runLogDir: runs });
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(directory).socket, version: 'test', store: createStore(state), runLogDir: runs, retentionSweepMs: 50 });
  await server.listen();
  t.after(() => server.close());
  // After hooks run in the order they are added: remove the files only once that has stopped.
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = await connect(daemonPaths(directory).socket, { name: 'test', version: '0' });
  t.after(() => client.close());
  const listed = async () => (await client.request('session.list', { includeClosed: true, includeArchived: true, rootsOnly: true })).sessions.map(row => row.id).sort();

  assert.deepEqual(await listed(), ['later', 'receipted', 'recent', 'restored', 'working']);
  assert.deepEqual((await readdir(path.join(state, 'timeline'))).sort(), ['later.jsonl', 'receipted.jsonl', 'recent.jsonl', 'restored.jsonl', 'working.jsonl']);
  assert.deepEqual((await readdir(runs)).sort(), ['later.jsonl', 'receipted.jsonl', 'recent.jsonl', 'restored.jsonl', 'working.jsonl']);
  assert.deepEqual((await readdir(path.join(state, 'receipts'))).sort(), ['r-later.json', 'r-receipted.json']);

  // The receipt of `later` leaves its window; the next sweep removes the receipt, then the tree.
  await receipt('r-later', 'later', 8);
  await until(async () => !(await listed()).includes('later'), 'the sweep to remove the expired tree');
  assert.deepEqual(await listed(), ['receipted', 'recent', 'restored', 'working']);
  assert.deepEqual((await readdir(path.join(state, 'receipts'))).sort(), ['r-receipted.json']);
  // Its files go after the row: the sweep may still be removing them.
  await until(async () => !(await readdir(runs)).includes('later.jsonl'), 'the sweep to remove the expired run log');
});
