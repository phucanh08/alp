import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '@anhlp/alp-daemon/store';
import { validateResult } from '@anhlp/alp-protocol/contract';

const event = (cursor, text = `message ${cursor}`) => ({ sessionId: cursor % 3 ? 'r' : 'child', epoch: 'e', seq: cursor, ts: '2026-10-20T00:00:00Z', event: { type: 'item', item: { kind: cursor % 2 ? 'assistant_message' : 'notice', id: `m${cursor}`, level: 'info', text, cursor: 9999999 } }, cursor });
async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-history-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: createStore(root) };
}
test('650 mixed events page backwards ascending, fixed watermark across append/restart, no duplicates', async t => {
  const { root, store } = await setup(t);
  for (let cursor = 1; cursor <= 650; cursor++) await store.append('r', event(cursor));
  let page = await store.history('r', 'r');
  assert.deepEqual(validateResult('session.history', page), []);
  assert.equal(page.items.length, 200);
  assert.equal(page.items[0].cursor, 451);
  assert.equal(page.tipCursor, 650);
  const generation = page.generation;
  const all = [...page.items];
  await store.append('r', event(651));
  const restarted = createStore(root);
  while (page.hasOlder) {
    page = await restarted.history('r', 'r', { before: page.olderCursor });
    assert.equal(page.generation, generation);
    assert.equal(page.tipCursor, 650);
    assert.ok(page.items.every((item, i, a) => !i || a[i - 1].cursor < item.cursor));
    all.unshift(...page.items);
  }
  assert.deepEqual(all.map(item => item.cursor), Array.from({ length: 650 }, (_, i) => i + 1));
  assert.equal((await restarted.history('r', 'r')).tipCursor, 651);
});
test('signed cursors reject foreign session, tampering and malformed positions; replacement is stale', async t => {
  const { root, store } = await setup(t);
  for (let i = 1; i <= 4; i++) await store.append('r', event(i));
  const page = await store.history('r', 'r', { limit: 1 });
  for (const before of ['', 'bad', page.olderCursor + 'x', 'x'.repeat(4097)]) await assert.rejects(store.history('r', 'r', { before }), { reason: 'invalid_cursor' });
  await assert.rejects(store.history('r', 'foreign', { before: page.olderCursor }), { reason: 'invalid_cursor' });
  const [body, signature] = page.olderCursor.split('.');
  const decoded = JSON.parse(Buffer.from(body, 'base64url'));
  decoded.position = -1;
  await assert.rejects(store.history('r', 'r', { before: Buffer.from(JSON.stringify(decoded)).toString('base64url') + '.' + signature }), { reason: 'invalid_cursor' });
  await unlink(path.join(root, 'timeline/r.jsonl'));
  await writeFile(path.join(root, 'timeline/r.jsonl'), JSON.stringify(event(20)) + '\n');
  await assert.rejects(createStore(root).history('r', 'r', { before: page.olderCursor }), { reason: 'stale_cursor' });
});
test('byte budgets progress past oversized nested-cursor event and actual outer cursor gaps', async t => {
  const { store } = await setup(t);
  for (const cursor of [2, 4, 9, 20]) await store.append('r', event(cursor, cursor === 9 ? 'x'.repeat(700000) : '😀'.repeat(400)));
  let page = await store.history('r', 'r', { maxBytes: 4096 });
  const all = [...page.items];
  while (page.hasOlder) { page = await store.history('r', 'r', { before: page.olderCursor, maxBytes: 4096 }); assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 4096); all.unshift(...page.items); }
  assert.deepEqual(all.map(item => item.cursor), [2, 4, 9, 20]);
  assert.ok(all[2].oversized.bytes > 700000);
  assert.deepEqual(validateResult('session.history', { ...page, items: all }), []);
});
test('derived index deletion/truncation and malformed metadata rebuild safely from source', async t => {
  const { root, store } = await setup(t);
  for (let i = 1; i <= 10; i++) await store.append('r', event(i));
  await store.history('r', 'r');
  const idx = path.join(root, 'timeline/r.jsonl.idx');
  for (const mutate of [() => unlink(idx), () => writeFile(idx, 'broken'), () => writeFile(path.join(root, 'timeline/r.jsonl.history.json'), '{')]) {
    await mutate();
    const page = await createStore(root).history('r', 'r');
    assert.deepEqual(page.items.map(item => item.cursor), Array.from({ length: 10 }, (_, i) => i + 1));
  }
  assert.equal((await readFile(idx)).length, 10 * 24);
});
test('empty history keeps generation when first append arrives; partial tail is not covered', async t => {
  const { store } = await setup(t);
  const empty = await store.history('r', 'r');
  assert.equal(empty.tipCursor, 0);
  await store.append('r', event(1));
  assert.equal((await store.history('r', 'r')).generation, empty.generation);
});

test('indexed older pages neither scan nor readFile the JSONL and seek only their bounded slice', async t => {
  const { root, store } = await setup(t);
  for (let i = 1; i <= 650; i++) await store.append('r', event(i));
  const page = await store.history('r', 'r', { limit: 10 });
  const fs = await import('node:fs');
  const promises = await import('node:fs/promises');
  const { syncBuiltinESMExports } = await import('node:module');
  const file = path.join(root, 'timeline/r.jsonl');
  const read = promises.default.readFile;
  const stream = fs.default.createReadStream;
  t.mock.method(fs.default, 'createReadStream', (name, ...args) => { assert.notEqual(name, file, 'indexed page must not scan source'); return stream(name, ...args); });
  t.mock.method(promises.default, 'readFile', (name, ...args) => { assert.notEqual(name, file, 'indexed page must not load full source'); return read(name, ...args); });
  const originalOpen = promises.default.open;
  let sourceBytes = 0;
  t.mock.method(promises.default, 'open', async (name, ...args) => {
    const handle = await originalOpen(name, ...args);
    if (name === file) {
      const originalRead = handle.read.bind(handle);
      handle.read = async (...readArgs) => { sourceBytes += readArgs[2]; return originalRead(...readArgs); };
    }
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const older = await createStore(root).history('r', 'r', { before: page.olderCursor, limit: 10 });
  assert.deepEqual(older.items.map(item => item.cursor), Array.from({ length: 10 }, (_, i) => i + 631));
  assert.ok(sourceBytes < 10000, `only page bytes read: ${sourceBytes}`);
  assert.ok(sourceBytes > 0);
});

test('removing a root deletes derived history and recreating it gets a new generation', async t => {
  const { root, store } = await setup(t);
  await store.append('r', event(1));
  const page = await store.history('r', 'r');
  await store.remove('r', []);
  for (const suffix of ['.jsonl', '.jsonl.idx', '.jsonl.history.json']) await assert.rejects(readFile(path.join(root, `timeline/r${suffix}`)), { code: 'ENOENT' });
  await store.append('r', event(1));
  const recreated = await store.history('r', 'r');
  assert.notEqual(recreated.generation, page.generation);
});
