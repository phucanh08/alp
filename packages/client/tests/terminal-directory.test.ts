import test from 'node:test';
import assert from 'node:assert/strict';
import { watchTerminals } from '../dist/portable.js';

// `any`: the fake host answers terminal.* requests with JSON of each method's result; snapshots are read by field.
type Json = any;
const id = (n: number) => String(n).padStart(32, '0');
function connection(request: (method: string, params?: unknown) => Promise<Json>) {
  const listeners = new Set<(method: string, params: unknown) => void>();
  return { request, onNotification(fn: (method: string, params: unknown) => void) { listeners.add(fn); return () => listeners.delete(fn); }, onClose() { return () => {}; }, changed(watchId: string, cursor: string) { for (const fn of listeners) fn('terminal.changed', { watchId, cursor }); } };
}
test('invalidation between snapshot and reply is recovered, then duplicates are ignored', async () => {
  let calls = 0;
  const snapshots: Json[] = [];
  const conn = connection(async method => {
    if (method === 'terminal.unwatch') return {};
    calls++;
    if (calls === 1) { conn.changed(id(1), id(3)); return { terminals: [], watchId: id(1), cursor: id(2), reset: true }; }
    return { terminals: [{ terminalId: 'new' }], watchId: id(1), cursor: id(3), reset: false };
  });
  const watcher = watchTerminals(conn, { capabilities: ['terminal.watch'], onSnapshot: value => snapshots.push(value) });
  await watcher.ready;
  assert.equal(calls, 2);
  assert.equal(snapshots.at(-1)[0].terminalId, 'new');
  conn.changed(id(1), id(3));
  conn.changed(id(9), id(4));
  await Promise.resolve();
  assert.equal(calls, 2, 'duplicate/other subscription cannot trigger replay');
  watcher.close();
});
test('older hosts explicitly poll and close cancels future reads; errors remain observable', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let calls = 0;
  const modes: unknown[] = [], errors: unknown[] = [];
  const watcher = watchTerminals(connection(async method => { assert.equal(method, 'terminal.list'); calls++; if (calls === 2) throw new Error('refused'); return { terminals: [] }; }), { capabilities: ['terminal'], pollMs: 50, onSnapshot() {}, onError: error => errors.push((error as Error).message), onMode: mode => modes.push(mode) });
  await watcher.ready;
  t.mock.timers.tick(50);
  await watcher.refresh();
  assert.deepEqual(modes, ['polling']);
  assert.deepEqual(errors, ['refused']);
  watcher.close();
  t.mock.timers.tick(100);
  assert.equal(calls, 2);
});
test('close during a pending snapshot never delivers late host data', async () => {
  let answer!: (value: Json) => void;
  const snapshots: unknown[] = [];
  const watcher = watchTerminals(connection(() => new Promise(resolve => { answer = resolve; })), { capabilities: [], onSnapshot: value => snapshots.push(value) });
  watcher.close();
  answer({ terminals: [{ terminalId: 'late' }] });
  await watcher.ready;
  assert.deepEqual(snapshots, []);
});
