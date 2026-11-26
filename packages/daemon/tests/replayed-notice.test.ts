// A notice read from history says when it was issued (t-2e23).
//
// On 2026-11-01 a root was opened again and its history replayed. Among it was the notice of a real
// crash two days earlier, "ALP: alpd stopped unexpectedly (around 2026-10-29T11:52:22.440Z). 2 of 2
// running assignments reopened.", and nothing in the replay said it was old: it read as happening now.
// alpd now delivers a notice from history as `[issued <time>, replayed] <text>`; a notice sent as it
// happens is unchanged, and so is what the timeline stores.
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { connect, daemonPaths } from '@anhlp/alp-client';

import { fakeTransport, until, workspace } from '../../../test/support/recovery.ts';
import type { FakeRuntime } from '../../../test/support/recovery.ts';
import { teardown } from '../../../test/support/teardown.ts';

// `any`: alpd's answers, events and errors are JSON whose shape depends on the method; the tests read the fields they assert on.
type Json = any;

const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const notices = (envelopes: Json[]) => envelopes.filter((envelope: Json) => envelope.event?.type === 'item' && envelope.event.item.kind === 'notice');

/** alpd's server and runtime in this process, on one state directory; `daemon()` starts the next one. */
async function world(t: TestContext) {
  const defer = teardown(t);
  const { directory, root, options } = await workspace(t);
  const runtimes: FakeRuntime[] = [];
  let count = 0;
  const daemon = async () => {
    const runtime = createAlpRuntime({ ...options, transport: fakeTransport(runtimes) });
    const store = createStore(path.join(directory, 'state'));
    const socketPath = daemonPaths(path.join(directory, `d${++count}`)).socket;
    const server = createDaemonServer({ runtime, socketPath, version: 'test', store, runLogDir: options.runLogDir });
    await server.listen();
    let stopped = false;
    const stop = async () => { if (stopped) return; stopped = true; await server.close(); await runtime.shutdown(); await store.flush(); };
    defer(stop);
    /** A client and every event it is sent. */
    const client = async () => {
      const connection = await connect(socketPath);
      defer(() => connection.close());
      const events: Json[] = [];
      connection.onEvent(envelope => events.push(envelope));
      return { request: (method: string, params?: unknown) => connection.request(method, params), events, close: () => connection.close() };
    };
    return { stop, client };
  };
  const timelineFile = (sessionId: string) => path.join(directory, 'state', 'timeline', `${sessionId}.jsonl`);
  const timeline = async (sessionId: Json) => (await readFile(timelineFile(sessionId), 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { root, runtimes, daemon, timeline, timelineFile };
}

test('t-2e23: a notice is delivered as written when it happens, and with its issue time whenever history replays it', async t => {
  const w = await world(t);
  const alpd = await w.daemon();
  const watcher = await alpd.client();
  const { session } = await watcher.request('session.create', { spec: { cwd: w.root, persist: true } });

  // As it happens: the client that watches gets the text as it was written.
  await watcher.request('daemon.pause', { reason: 'maintenance window' });
  await until(() => notices(watcher.events).length === 1, 'the live notice');
  const [live] = notices(watcher.events);
  assert.match(live.event.item.text, /maintenance window/);
  assert.doesNotMatch(live.event.item.text, /issued|replayed/);
  await until(async () => notices(await w.timeline(session.id)).length === 1, 'the notice in the timeline');
  const [stored] = notices(await w.timeline(session.id));
  assert.equal(stored.event.item.text, live.event.item.text, 'the timeline holds the text as it was written');
  assert.match(stored.ts, ISO);
  const replayedText = `[issued ${stored.ts}, replayed] ${live.event.item.text}`;

  // A client that attaches afterwards reads history: the same notice says when it was issued.
  const late = await alpd.client();
  await late.request('session.attach', { sessionId: session.id, replay: true });
  const [replayed] = notices(late.events);
  assert.equal(replayed.event.item.text, replayedText);
  assert.deepEqual({ ...replayed, event: undefined }, { ...stored, event: undefined }, 'nothing but the text differs: same id, cursor and time');
  assert.equal(replayed.event.item.id, stored.event.item.id);
  assert.equal(replayed.event.item.level, stored.event.item.level);

  // Replayed again, to the same client and to another: one mark, the same time.
  await late.request('session.attach', { sessionId: session.id, replay: true });
  const again = await alpd.client();
  await again.request('session.attach', { sessionId: session.id, replay: true });
  assert.deepEqual([...notices(late.events), ...notices(again.events)].map(envelope => envelope.event.item.text), [replayedText, replayedText, replayedText]);

  // The pages of history (what the web timeline loads) carry it too.
  const page = await late.request('session.history', { sessionId: session.id });
  assert.deepEqual(notices(page.items).map((envelope: Json) => envelope.event.item.text), [replayedText]);

  // The client that was watching was sent the notice once, unmarked; the timeline still holds it as written.
  assert.deepEqual(notices(watcher.events).map((envelope: Json) => envelope.event.item.text), [live.event.item.text]);
  assert.deepEqual(notices(await w.timeline(session.id)).map((envelope: Json) => envelope.event.item.text), [live.event.item.text]);

  // A notice issued now, while all three watch, reaches each of them as it is written.
  await watcher.request('daemon.resume', {});
  await until(() => [watcher, late, again].every(client => notices(client.events).some((envelope: Json) => envelope.event.item.id !== stored.event.item.id)), 'the next live notice');
  for (const client of [watcher, late, again]) {
    const fresh = notices(client.events).filter((envelope: Json) => envelope.event.item.id !== stored.event.item.id);
    assert.equal(fresh.length, 1);
    assert.doesNotMatch(fresh[0].event.item.text, /issued|replayed/);
  }
});

test('t-2e23: a root opened again days later replays an old crash notice with the time it was issued, not as news', async t => {
  const w = await world(t);
  const first = await w.daemon();
  const owner = await first.client();
  const { session } = await owner.request('session.create', { spec: { cwd: w.root, persist: true } });
  await owner.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: [{ type: 'text', text: 'Hello' }] });
  await until(() => w.runtimes[0]?.started.length === 1, 'the turn');
  w.runtimes[0].finish('Hi');
  await until(async () => (await w.timeline(session.id)).some(envelope => envelope.event.type === 'turn.ended'), 'the turn to end');
  owner.close();
  await first.stop();

  // The timeline of the incident: the notice alpd wrote once, on 2026-10-29, after a real crash, and a
  // fork marker beside it, which is a place in the conversation and not news.
  const tip = Math.max(...(await w.timeline(session.id)).map(envelope => envelope.cursor ?? 0));
  const incident = 'ALP: alpd stopped unexpectedly (around 2026-10-29T11:52:22.440Z). 2 of 2 running assignments reopened.';
  const line = (cursor: number, ts: string, item: Json) => `${JSON.stringify({ sessionId: session.id, epoch: 'earlier-alpd', seq: cursor, ts, cursor, event: { type: 'item', item } })}\n`;
  await appendFile(w.timelineFile(session.id),
    line(tip + 1, '2026-10-29T11:52:53.033Z', { kind: 'notice', id: 'notice-50d8f063', level: 'info', text: incident })
    + line(tip + 2, '2026-10-30T08:00:00.000Z', { kind: 'notice', id: 'fork:ses_other', level: 'info', text: 'Forked from another session.' }));

  const second = await w.daemon();
  const reader = await second.client();
  await reader.request('session.create', { sessionId: session.id, spec: { cwd: w.root, persist: true }, history: 'replay', resume: true });
  await until(() => notices(reader.events).length >= 2, 'the replayed notices');
  const shown = Object.fromEntries(notices(reader.events).map((envelope: Json) => [envelope.event.item.id, envelope.event.item.text]));
  assert.equal(shown['notice-50d8f063'], `[issued 2026-10-29T11:52:53.033Z, replayed] ${incident}`);
  assert.equal(shown['fork:ses_other'], 'Forked from another session.', 'a conversation marker is not marked');
  // The same through attach and through the history pages.
  const other = await second.client();
  await other.request('session.attach', { sessionId: session.id, replay: true });
  assert.equal(notices(other.events).find((envelope: Json) => envelope.event.item.id === 'notice-50d8f063').event.item.text, `[issued 2026-10-29T11:52:53.033Z, replayed] ${incident}`);
  const page = await other.request('session.history', { sessionId: session.id });
  assert.equal(notices(page.items).find((envelope: Json) => envelope.event.item.id === 'notice-50d8f063').event.item.text, `[issued 2026-10-29T11:52:53.033Z, replayed] ${incident}`);
});
