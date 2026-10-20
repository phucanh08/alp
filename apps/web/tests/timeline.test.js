// The projection and the end of an attach (docs/protocol/alp-json-rpc-v1.md §8.3): cursor dedupe,
// synthetic envelopes that never move the cursor, reset before the buffer, ordering, questions
// announced afresh, a closed root that stays known.
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyAttach, prependHistory, historyEnvelope, deliveredPrompts, emptyProjection, entriesOf, members, project, promptTurnOver } from '../src/lib/timeline.js';

const env = (cursor, event, sessionId = 'r') => ({ sessionId, epoch: 'e', seq: cursor ?? 0, ts: '2026-10-16T00:00:00.000Z', event, ...(cursor === undefined ? {} : { cursor }) });
const item = (cursor, id, text, sessionId = 'r') => env(cursor, { type: 'item', item: { kind: 'assistant_message', id, text } }, sessionId);
const opened = (cursor, id, extra = {}) => env(cursor, { type: 'session.opened', session: { id, agent: 'main', mode: 'full-access', busy: false, ...extra }, cwd: '/w', effective: { model: 'm', thinking: 'low' } }, id);

test('kept envelopes apply once; synthetic ones never move the cursor', () => {
  let state = emptyProjection('r');
  state = project(state, opened(1, 'r'));
  state = project(state, item(2, 'm1', 'hel'));
  state = project(state, item(3, 'm1', 'hello'));
  assert.equal(state.cursor, 3);
  assert.equal(entriesOf(state, 'r').length, 1, 'a streamed item updates in place');
  assert.equal(entriesOf(state, 'r')[0].item.text, 'hello');
  // A replay of what was already applied changes nothing.
  const again = project(state, item(2, 'm1', 'hel'));
  assert.equal(again, state);
  // A synthetic announcement applies but leaves the cursor.
  const announced = project(state, env(undefined, { type: 'question', question: { id: 'q1', sessionId: 'r', rootId: 'r', agent: 'main', body: '?', askedAt: '' } }));
  assert.equal(announced.cursor, 3);
  assert.ok(announced.questions.q1);
});

test('unknown events and item kinds are ignored', () => {
  const state = project(project(emptyProjection('r'), env(1, { type: 'brand.new' })), env(2, { type: 'item', item: { kind: 'hologram', id: 'h' } }));
  assert.equal(state.cursor, 2, 'the cursor still advances past them');
  assert.equal(state.entries.length, 0);
});

test('reset clears the projection before the buffered replay applies', () => {
  let state = emptyProjection('r');
  for (const envelope of [opened(1, 'r'), item(2, 'old', 'from another timeline'), item(9, 'x', 'beyond')]) state = project(state, envelope);
  const rebuilt = applyAttach(state, { cursor: 3, reset: true, session: { id: 'r', status: 'idle', busy: false } }, [opened(1, 'r'), item(2, 'a', 'one'), item(3, 'b', 'two')]);
  assert.equal(rebuilt.cursor, 3, 'the cursor restarts from the replay, not the old view');
  assert.deepEqual(entriesOf(rebuilt, 'r').map(entry => entry.item.id), ['a', 'b']);
  assert.equal(rebuilt.historyUnavailable, false);
  assert.equal(rebuilt.reset, 1);
});

test('a reset with no history left is reported, with the summary kept', () => {
  const state = project(emptyProjection('r'), item(5, 'x', 'gone'));
  const rebuilt = applyAttach(state, { cursor: 0, reset: true, session: { id: 'r', status: 'closed', busy: false, title: 'T' } }, []);
  assert.equal(rebuilt.historyUnavailable, true);
  assert.equal(rebuilt.entries.length, 0);
  assert.equal(rebuilt.sessions.r.title, 'T');
  assert.equal(rebuilt.closed.r, true);
});

test('buffered envelopes apply in cursor order, announcements last, without duplicates', () => {
  // After session.create the connection is attached already: live events may come before the replay.
  const buffer = [opened(1, 'r'), item(3, 'b', 'live'), opened(1, 'r'), env(2, { type: 'session.ready' }), item(3, 'b', 'live'), env(undefined, { type: 'question', question: { id: 'q', sessionId: 'r', rootId: 'r', agent: 'main', body: '?', askedAt: '' } })];
  const state = applyAttach(emptyProjection('r'), { cursor: 3, session: { id: 'r', status: 'running', busy: true } }, buffer);
  assert.equal(state.cursor, 3);
  assert.equal(state.entries.length, 1);
  assert.ok(state.questions.q);
});

test('a reattach drops old questions (they are announced afresh) and keeps running turns', () => {
  let state = emptyProjection('r');
  state = project(state, opened(1, 'r'));
  state = project(state, env(2, { type: 'turn.started', turnId: 't1', origin: 'user' }));
  state = project(state, env(undefined, { type: 'question', question: { id: 'q-old', sessionId: 'r', rootId: 'r', agent: 'main', body: '?', askedAt: '' } }));
  const after = applyAttach(state, { cursor: 2, session: { id: 'r', status: 'running', busy: true } }, []);
  assert.deepEqual(Object.keys(after.questions), []);
  assert.equal(after.running.r, 't1', 'turn.started is not replayed after the cursor, so the projection keeps it');
});

test('the summary ends a turn a crash left without turn.ended', () => {
  let state = project(project(emptyProjection('r'), opened(1, 'r')), env(2, { type: 'turn.started', turnId: 't1', origin: 'user' }));
  state = applyAttach(state, { cursor: 2, session: { id: 'r', status: 'closed', busy: false } }, []);
  assert.deepEqual(state.running, {});
  assert.equal(state.closed.r, true);
});

test('session.closed keeps the timeline and the session; a resume reopens it', () => {
  let state = project(project(emptyProjection('r'), opened(1, 'r', { title: 'Keep me' })), item(2, 'a', 'hi'));
  state = project(state, env(3, { type: 'session.closed' }));
  assert.equal(state.closed.r, true);
  assert.equal(state.entries.length, 1);
  assert.equal(state.sessions.r.status, 'closed');
  state = project(state, opened(4, 'r'));
  assert.equal(state.closed.r, undefined);
});

test('children join the tree in opening order; their timelines stay apart', () => {
  let state = project(emptyProjection('r'), opened(1, 'r'));
  state = project(state, opened(2, 'c1', { parentId: 'r', agent: 'peer', busy: true }));
  state = project(state, item(3, 'm', 'child says', 'c1'));
  state = project(state, item(4, 'm', 'root says', 'r'));
  assert.deepEqual(members(state).map(member => member.id), ['r', 'c1']);
  assert.equal(entriesOf(state, 'c1')[0].item.text, 'child says');
  assert.equal(entriesOf(state, 'r')[0].item.text, 'root says', 'same item id in two sessions are two entries');
});

test('turn ends that failed or were canceled show in the timeline; prompt outcomes are tracked', () => {
  let state = project(emptyProjection('r'), opened(1, 'r'));
  state = project(state, env(2, { type: 'item', item: { kind: 'user_message', id: 'u', text: 'hi', clientMessageId: 'c1' } }));
  state = project(state, env(3, { type: 'prompt.failed', clientMessageId: 'c2', error: { message: 'nope' } }));
  state = project(state, env(4, { type: 'turn.started', turnId: 't', origin: 'user' }));
  state = project(state, env(5, { type: 'turn.ended', turnId: 't', state: 'canceled' }));
  assert.ok(deliveredPrompts(state).has('c1'));
  assert.equal(state.prompts.c2.state, 'failed');
  assert.equal(state.entries.at(-1).item.kind, 'turn_end');
  assert.deepEqual(state.running, {});
});

test('a message\'s turn is over only once it started and ended; accepted before turn.started is not', () => {
  let state = project(emptyProjection('r'), opened(1, 'r'));
  assert.equal(promptTurnOver(state, 'm1'), false, 'nothing known yet');
  state = project(state, env(2, { type: 'item', item: { kind: 'user_message', id: 'u1', text: 'one', clientMessageId: 'm1' } }));
  assert.equal(promptTurnOver(state, 'm1'), false, 'a user message alone says nothing of the turn');
  state = project(state, env(3, { type: 'prompt.accepted', clientMessageId: 'm1', result: 'turn', turnId: 't1' }));
  assert.equal(promptTurnOver(state, 'm1'), false, 'accepted, turn not started yet');
  state = project(state, env(4, { type: 'turn.started', turnId: 't1', origin: 'user' }));
  assert.equal(promptTurnOver(state, 'm1'), false, 'running');
  state = project(state, env(5, { type: 'prompt.accepted', clientMessageId: 'm2', result: 'steer', turnId: 't1' }));
  assert.equal(promptTurnOver(state, 'm2'), false, 'a steer waits for the running turn');
  state = project(state, env(6, { type: 'turn.ended', turnId: 't1', state: 'completed' }));
  assert.equal(promptTurnOver(state, 'm1'), true);
  assert.equal(promptTurnOver(state, 'm2'), true);
  state = project(state, env(7, { type: 'prompt.failed', clientMessageId: 'm3', error: { code: 'busy', message: 'no' } }));
  assert.equal(promptTurnOver(state, 'm3'), true, 'a refused message starts no turn');

  // A turn seen running that the host's summary later ends without turn.ended (a crash) is over.
  let crashed = project(project(emptyProjection('r'), env(1, { type: 'prompt.accepted', clientMessageId: 'm4', result: 'turn', turnId: 't9' })), env(2, { type: 'turn.started', turnId: 't9', origin: 'user' }));
  crashed = applyAttach(crashed, { session: { id: 'r', status: 'idle', busy: false } }, []);
  assert.equal(promptTurnOver(crashed, 'm4'), true);
});

test('older pages merge item fragments without replacing newer snapshots or live state', () => {
  let state = emptyProjection('r');
  for (const envelope of [item(500, 'x', 'latest'), item(600, 'y', 'newer')]) state = project(state, envelope);
  state = prependHistory(state, [item(1, 'old', 'first'), item(20, 'x', 'partial')]);
  assert.deepEqual(state.entries.map(row => row.item.text), ['first', 'latest', 'newer']);
  assert.equal(state.cursor, 600);
  state = prependHistory(state, [item(1, 'old', 'first')]);
  assert.equal(state.entries.length, 3);
  state = project(state, historyEnvelope({ cursor: 601, oversized: { bytes: 900000 } }, 'r'));
  assert.match(state.entries.at(-1).item.text, /900000 bytes/);
});

test('a child item in a bounded tail remains reachable before its older opening is loaded', () => {
  const state = project(emptyProjection('r'), item(600, 'child-item', 'child tail', 'child'));
  assert.ok(members(state).some(member => member.id === 'child'));
  assert.equal(entriesOf(state, 'child')[0].item.text, 'child tail');
});

test('an older child opening enriches tail membership while newer descriptor fields win', () => {
  let state = project(emptyProjection('r'), item(600, 'child-item', 'child tail', 'child'));
  state = project(state, env(601, { type: 'session.updated', session: { title: 'Current title' } }, 'child'));
  state = prependHistory(state, [env(1, { type: 'session.opened', session: { id: 'child', parentId: 'r', agent: 'peer', title: 'Old title', runtime: 'codex' } }, 'child')]);
  assert.equal(state.sessions.child.agent, 'peer');
  assert.equal(state.sessions.child.parentId, 'r');
  assert.equal(state.sessions.child.runtime, 'codex');
  assert.equal(state.sessions.child.title, 'Current title');
  assert.equal(entriesOf(state, 'child')[0].item.text, 'child tail');
});
