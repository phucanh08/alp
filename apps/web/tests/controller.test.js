// The controller against an in-memory host speaking real JSON-RPC frames: connect, select, attach
// and replay; a dropped connection, a second drop while reattaching, a terminal verdict, a refused
// credential; a root closed while nobody watched and resumed; stale answers after switching; a
// disconnect during backoff; mutations whose outcome is unknown and are never sent again by
// themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlpRpcError } from '@anhlp/alp-client/portable';
import { Controller } from '../src/lib/controller.js';
import { AuthenticationError } from '../src/lib/errors.js';
import { entriesOf } from '../src/lib/timeline.js';
import { FakeHost, until } from './support/fake-host.js';

function setup(t, hostOptions, controllerOptions = {}) {
  const host = new FakeHost(hostOptions);
  const controller = new Controller({ open: host.open, backoff: { initialMs: 5, maxMs: 20, jitter: 0 }, stableMs: 1, taskPollMs: 60_000, sessionPollMs: 60_000, requestTimeoutMs: 2_000, releaseTimeoutMs: 500, ...controllerOptions });
  t.after(() => controller.disconnect());
  const state = () => controller.getState();
  return { host, controller, state };
}

async function connected({ controller, state }, workspace = '/w/a') {
  controller.connect({ url: 'http://127.0.0.1:7434', token: 'alpgw1.0123456789abcdef.secret' });
  await until(() => state().connection.phase === 'open', 'open');
  controller.selectWorkspace(workspace);
  await until(() => state().sessions.status === 'ready', 'sessions');
}

const texts = (state, sessionId) => entriesOf(state().tree.projection, sessionId).map(entry => entry.item.text);
const attached = state => state().tree?.status === 'attached';

test('connects, lists, attaches with a full replay and streams a prompt', async t => {
  const w = setup(t);
  w.host.seed('ses_a', { title: 'First' });
  await connected(w);
  assert.equal(w.state().connection.capabilities.includes('prompt.receipts'), true);
  assert.deepEqual(w.state().sessions.list.map(session => session.id), ['ses_a']);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  assert.equal(w.state().tree.projection.cursor, 2);
  await w.controller.sendPrompt('hello');
  await until(() => texts(w.state, 'ses_a').includes('echo: hello'), 'reply');
  assert.deepEqual(texts(w.state, 'ses_a'), ['hello', 'echo: hello']);
  assert.equal(w.state().prompts.length, 0, 'the pending entry gives way to the user message');
  assert.equal(w.host.count('session.prompt'), 1);
});

test('a dropped connection reconnects and continues after the cursor, without duplicates', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  await w.controller.sendPrompt('one [hold]');
  await until(() => 'ses_a' in w.state().tree.projection.running, 'running');
  const before = w.state().tree.projection.cursor;
  w.host.drop();
  // The turn keeps running on the host and ends while nobody watches.
  w.host.finishTurn('ses_a', 'finished while away');
  await until(() => w.state().connection.phase === 'reconnecting' || w.state().connection.phase === 'open', 'reconnecting');
  await until(() => texts(w.state, 'ses_a').includes('finished while away') && w.state().connection.phase === 'open', 'replayed');
  const attaches = w.host.calls.filter(call => call.method === 'session.attach');
  assert.equal(attaches.at(-1).params.after, before, 'attach continues after the last cursor');
  assert.deepEqual(texts(w.state, 'ses_a'), ['one [hold]', 'finished while away']);
  assert.deepEqual(w.state().tree.projection.running, {});
});

test('a second drop while reattaching keeps the root and its timeline; the next link adopts it', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  await w.controller.sendPrompt('first');
  await until(() => texts(w.state, 'ses_a').includes('echo: first'), 'first reply');
  // The next attach is answered by a dropped socket, after part of the replay went out.
  let drops = 0;
  w.host.intercept.set('session.attach', (params, connection) => {
    if (drops++ > 0) return undefined;
    connection.end({ code: 1006, error: new Error('dropped during attach') });
    return 'handled';
  });
  w.host.drop();
  await until(() => drops >= 2 && attached(w.state) && w.state().connection.phase === 'open', 'reattached on a third link');
  assert.equal(w.state().tree.status, 'attached');
  assert.deepEqual(texts(w.state, 'ses_a'), ['first', 'echo: first'], 'nothing lost, nothing doubled');
  assert.equal(w.host.opens, 3);
  // The adopted link works.
  await w.controller.sendPrompt('second');
  await until(() => texts(w.state, 'ses_a').includes('echo: second'), 'second reply');
});

test('a terminal verdict on reattach gives that root up; the connection stays', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  w.host.roots.delete('ses_a');
  w.host.drop();
  await until(() => w.state().tree?.status === 'gone' && w.state().connection.phase === 'open', 'gone');
  assert.equal(w.state().tree.error.code, 1001);
  const opens = w.host.opens;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(w.host.opens, opens, 'no reconnect loop for a gone root');
});

test('a refused credential stops reconnecting and forgets everything', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  w.host.refuse = new AuthenticationError();
  w.host.drop();
  await until(() => w.state().connection.phase === 'failed', 'failed');
  assert.match(w.state().connection.error.message, /refused this access token/);
  assert.equal(w.state().principal, null);
  assert.equal(w.state().tree, null);
  assert.deepEqual(w.state().sessions.list, []);
  const opens = w.host.opens;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(w.host.opens, opens);
});

test('the first connection failing is reported at once, not retried', async t => {
  const w = setup(t);
  const { TransientError } = await import('../src/lib/errors.js');
  w.host.refuse = new TransientError('Cannot reach the gateway.');
  w.controller.connect({ url: 'http://127.0.0.1:7434', token: 't' });
  await until(() => w.state().connection.phase === 'failed', 'failed');
  assert.equal(w.host.opens, 1);
  assert.match(w.state().connection.error.message, /Cannot reach/);
});

test('a root closed while nobody watched stays listed and reopens before the next prompt', async t => {
  const w = setup(t);
  w.host.seed('ses_a', { title: 'Idle one' });
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  // A gateway restart while idle: alpd closes the root nobody watches (09B-2).
  w.host.drop();
  await until(() => w.host.root('ses_a').live === false, 'closed on the host');
  await until(() => w.state().connection.phase === 'open' && w.state().tree.projection.closed.ses_a === true, 'replayed session.closed');
  assert.deepEqual(w.state().sessions.list.map(session => session.id), ['ses_a'], 'still listed');
  assert.equal(w.state().tree.status, 'attached');
  await w.controller.sendPrompt('wake up');
  await until(() => texts(w.state, 'ses_a').includes('echo: wake up'), 'reply after resume');
  const create = w.host.calls.find(call => call.method === 'session.create');
  assert.equal(create.params.resume, true);
  assert.equal(create.params.history, 'skip');
  assert.equal(create.params.spec.mode, 'full-access');
  assert.equal(w.state().tree.projection.closed.ses_a, undefined);
});

test('answers for an old workspace or session are dropped', async t => {
  const w = setup(t);
  w.host.seed('ses_a', { projectRoot: '/w/a' });
  w.host.seed('ses_b', { projectRoot: '/w/b' });
  await connected(w);
  let release;
  w.host.intercept.set('session.list', params => params.projectRoot === '/w/a' ? new Promise(resolve => { release = () => resolve(undefined); }) : undefined);
  void w.controller.refreshSessions();
  await until(() => release, 'slow list');
  w.host.intercept.delete('session.list');
  w.controller.selectWorkspace('/w/b');
  await until(() => w.state().sessions.status === 'ready' && w.state().sessions.list[0]?.id === 'ses_b', 'b listed');
  release();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(w.state().sessions.list.map(session => session.id), ['ses_b'], 'the late answer for a is ignored');

  // Switching sessions while an attach is pending: the first tree's events do not leak into the second.
  w.host.seed('ses_b2', { projectRoot: '/w/b' });
  w.controller.selectSession('ses_b');
  w.controller.selectSession('ses_b2');
  await until(() => attached(w.state) && w.state().tree.rootId === 'ses_b2', 'b2 attached');
  w.host.emit('ses_b', 'ses_b', { type: 'item', item: { kind: 'assistant_message', id: 'x', text: 'from b' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(w.state().tree.rootId, 'ses_b2');
  assert.deepEqual(texts(w.state, 'ses_b2'), []);
  assert.ok(w.host.calls.some(call => call.method === 'session.release' && call.params.sessionId === 'ses_b'), 'the first tree was released');
});

test('disconnect during backoff stops for good and clears the token and data', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  w.host.refuse = new (await import('../src/lib/errors.js')).TransientError('down');
  w.host.drop();
  await until(() => w.state().connection.phase === 'reconnecting', 'reconnecting');
  w.controller.disconnect();
  const opens = w.host.opens;
  w.host.refuse = undefined;
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(w.host.opens, opens, 'no connection after disconnect');
  assert.equal(w.state().connection.phase, 'idle');
  assert.equal(w.state().tree, null);
  assert.equal(w.host.connections.size, 0);
});

test('a prompt whose answer was lost is shown as unknown and reconciled from the replay, never resent', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  // The host takes the prompt, then the connection drops before the answer.
  w.host.intercept.set('session.prompt', (params, connection) => {
    w.host.intercept.delete('session.prompt');
    return (async () => {
      connection.end({ code: 1006, error: new Error('dropped') });
      return 'handled';
    })();
  });
  await w.controller.sendPrompt('maybe');
  assert.equal(w.state().prompts[0]?.status, 'unknown');
  assert.equal(w.state().prompts[0].retrySameId, true);
  // Not delivered, so nothing reconciles it: it stays for the user to decide; no second send.
  await until(() => w.state().connection.phase === 'open', 'back');
  assert.equal(w.host.count('session.prompt'), 1);
  // The user retries: same clientMessageId, so the host could dedupe it.
  const id = w.state().prompts[0].id;
  await w.controller.retryPrompt(id);
  await until(() => texts(w.state, 'ses_a').includes('echo: maybe'), 'delivered on retry');
  assert.equal(w.host.calls.filter(call => call.method === 'session.prompt').at(-1).params.clientMessageId, id);
  assert.equal(w.state().prompts.length, 0);
});

test('a prompt that did reach the host before the drop is settled by the replay', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  w.host.intercept.set('session.prompt', (params, connection, { answer }) => {
    w.host.intercept.delete('session.prompt');
    // Run it for real on a detached copy of the connection, then cut the link before answering.
    const root = w.host.root('ses_a');
    root.viewers.delete(connection);
    return (async () => {
      const key = `${params.sessionId}:${params.clientMessageId}`;
      w.host.receipts.set(key, { outcome: 'accepted', durable: true });
      w.host.emit('ses_a', 'ses_a', { type: 'item', item: { kind: 'user_message', id: 'u1', text: params.content[0].text, clientMessageId: params.clientMessageId } });
      connection.end({ code: 1006, error: new Error('dropped') });
      void answer;
      return 'handled';
    })();
  });
  await w.controller.sendPrompt('landed');
  await until(() => w.state().connection.phase === 'open' && texts(w.state, 'ses_a').includes('landed'), 'replayed');
  assert.equal(w.state().prompts.length, 0, 'the timeline shows it, so it is done');
  assert.equal(w.host.count('session.prompt'), 1);
});

test('outcome_unknown asks for a new id; a runtime refusal is not retried under the same id', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  w.host.intercept.set('session.prompt', (params, connection, { fail }) => { w.host.intercept.delete('session.prompt'); fail(1004, 'unknown', { reason: 'outcome_unknown' }); return 'handled'; });
  await w.controller.sendPrompt('unsure');
  const pending = w.state().prompts[0];
  assert.equal(pending.status, 'unknown');
  assert.equal(pending.retrySameId, false);
  await w.controller.retryPrompt(pending.id);
  const ids = w.host.calls.filter(call => call.method === 'session.prompt').map(call => call.params.clientMessageId);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1], 'a new id after outcome_unknown');
});

test('task.create with an unknown outcome reads the list and waits for the user', async t => {
  const w = setup(t);
  await connected(w);
  w.controller.setTasksVisible(true);
  await until(() => w.state().tasks.status === 'ready', 'tasks');
  w.host.intercept.set('task.create', (params, connection, { fail }) => {
    w.host.intercept.delete('task.create');
    // It was created, but the gateway lost alpd before the answer.
    w.host.tasks.push({ id: 'T1', title: params.title, type: 'task', priority: 2, status: 'open', rev: 1, ready: true, updatedAt: '' });
    w.host.taskRev++;
    fail(1000, 'lost', { reason: 'daemon_disconnected' });
    return 'handled';
  });
  await w.controller.createTask({ title: 'Write docs' });
  const create = w.state().tasks.creates[0];
  assert.equal(create.status, 'unknown');
  assert.equal(create.match, 'T1', 'the refreshed list shows a matching task');
  assert.equal(w.host.count('task.create'), 1, 'not sent again');
  w.controller.dismissTaskCreate(create.requestId);
  assert.deepEqual(w.state().tasks.rows.map(row => row.id), ['T1']);
});

test('task changes send ifRev; a stale row fails without changing anything and the list refreshes', async t => {
  const w = setup(t);
  w.host.tasks.push({ id: 'T1', title: 'One', type: 'task', priority: 2, status: 'open', rev: 1, ready: true, updatedAt: '', approvals: [{ gate: 'g1', note: 'ok?' }] });
  await connected(w);
  w.controller.setTasksVisible(true);
  await until(() => w.state().tasks.rows.length === 1, 'rows');
  const row = w.state().tasks.rows[0];
  await w.controller.changeTask(row, { gate: 'g1' });
  assert.equal(w.host.calls.find(call => call.method === 'task.gate.resolve').params.ifRev, 1);
  await w.controller.changeTask(row, { action: 'close' });
  assert.match(w.state().tasks.message.text, /changed on the host/);
  assert.equal(w.host.tasks[0].status, 'open');
  const fresh = w.state().tasks.rows[0];
  await w.controller.changeTask(fresh, { action: 'close' });
  assert.equal(w.host.tasks[0].status, 'closed');
});

test('create session: own id, history skip, then attach; events before the answer are kept', async t => {
  const w = setup(t);
  await connected(w);
  const id = await w.controller.createSession({ team: 'pho', mode: 'workspace-write', title: 'Fresh' });
  assert.match(id, /^web_[0-9a-f]{16}$/);
  await until(() => attached(w.state) && w.state().tree.rootId === id, 'attached');
  const create = w.host.calls.find(call => call.method === 'session.create');
  assert.equal(create.params.sessionId, id);
  assert.equal(create.params.history, 'skip');
  assert.deepEqual(create.params.spec, { cwd: '/w/a', persist: true, workflow: 'pho', mode: 'workspace-write' });
  assert.equal(w.state().tree.projection.cursor, 2, 'session.opened and ready, once each');
  assert.equal(w.host.root(id).summary.title, 'Fresh');
});

test('a new session whose first attach times out is not left attaching: it shows Retry, and nothing is created twice', async t => {
  const w = setup(t, undefined, { requestTimeoutMs: 30 });
  await connected(w);
  // The host never answers session.attach (a timeout, not a terminal refusal); the connection stays open.
  w.host.intercept.set('session.attach', () => 'handled');
  const id = await w.controller.createSession({ title: 'Slow attach' });
  await until(() => w.state().tree?.status === 'error', 'the attach failure is shown');
  assert.equal(w.state().connection.phase, 'open');
  assert.equal(w.state().tree.rootId, id);
  const attaches = w.host.count('session.attach');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(w.host.count('session.attach'), attaches, 'no endless attach loop');
  assert.equal(w.host.count('session.create'), 1, 'session.create is never sent again');

  // Retry attaches the same session from its cursor; still one create.
  w.host.intercept.delete('session.attach');
  w.controller.retryAttach();
  await until(() => attached(w.state) && w.state().tree.rootId === id, 'attached after Retry');
  assert.equal(w.host.count('session.create'), 1);
  assert.equal(w.host.count('session.rename'), 1, 'the title is set once');
});

test('children and questions: answer and dismiss reach the host', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  w.host.openChild('ses_a', 'child-1');
  w.host.emit('ses_a', 'child-1', { type: 'item', item: { kind: 'assistant_message', id: 'c', text: 'child work' } });
  w.host.ask('ses_a', 'child-1', 'q1');
  w.host.ask('ses_a', 'ses_a', 'q2');
  await until(() => Object.keys(w.state().tree.projection.questions).length === 2, 'questions');
  assert.deepEqual(w.state().tree.projection.order, ['ses_a', 'child-1']);
  w.controller.focusSession('child-1');
  assert.deepEqual(texts(w.state, 'child-1'), ['child work']);
  await w.controller.answerQuestion('q1', { text: 'yes' });
  await w.controller.answerQuestion('q2', { dismiss: true });
  await until(() => Object.keys(w.state().tree.projection.questions).length === 0, 'resolved');
  const answers = w.host.calls.filter(call => call.method === 'question.answer').map(call => call.params);
  assert.deepEqual(answers, [{ questionId: 'q1', text: 'yes' }, { questionId: 'q2', dismiss: true, reason: 'Declined in ALP web' }]);
});

test('cancel interrupts the running turn', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  await w.controller.sendPrompt('long [hold]');
  await until(() => 'ses_a' in w.state().tree.projection.running, 'running');
  await w.controller.interrupt();
  await until(() => !('ses_a' in w.state().tree.projection.running), 'stopped');
  assert.equal(w.state().tree.projection.entries.at(-1).item.state, 'canceled');
});

test('a queued message waits for the turn, then goes once by itself; edit takes it back', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  await w.controller.sendPrompt('long [hold]');
  await until(() => 'ses_a' in w.state().tree.projection.running, 'running');
  w.controller.queuePrompt('first after');
  w.controller.queuePrompt('second after');
  const edited = w.controller.editQueued(w.state().queued[1].id);
  assert.equal(edited, 'second after');
  assert.deepEqual(w.state().queued.map(item => item.text), ['first after']);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(w.host.count('session.prompt'), 1, 'nothing is sent while the turn runs');
  w.host.finishTurn('ses_a', 'done');
  await until(() => texts(w.state, 'ses_a').includes('echo: first after'), 'the queued message went by itself');
  assert.equal(w.state().queued.length, 0);
  assert.equal(w.host.count('session.prompt'), 2, 'sent once');
});

for (const answer of ['before', 'middle', 'after']) {
  test(`the queue waits for the turn its message started, not just for the user message (answer ${answer} the events, each event its own task)`, async t => {
    const w = setup(t, { separateTasks: true, promptTiming: { gapMs: 50, answer } });
    w.host.seed('ses_a');
    await connected(w);
    w.controller.selectSession('ses_a');
    await until(() => attached(w.state), 'attached');
    const sending = w.controller.sendPrompt('one [hold]');
    w.controller.queuePrompt('two');
    // The user message is in, its turn has not started yet: the queue must not go.
    await until(() => texts(w.state, 'ses_a').includes('one [hold]'), 'user message');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(w.host.count('session.prompt'), 1, 'nothing sent between the user message and turn.started');
    await until(() => 'ses_a' in w.state().tree.projection.running, 'turn started');
    await sending;
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(w.host.count('session.prompt'), 1, 'nothing sent while the turn runs');
    assert.equal(w.state().queued.length, 1);
    w.host.finishTurn('ses_a', 'done');
    await until(() => w.host.count('session.prompt') === 2, 'the queued message went after the turn');
    const sent = w.host.calls.filter(call => call.method === 'session.prompt');
    assert.deepEqual(sent.map(call => call.params.delivery), ['auto', 'auto']);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(w.host.count('session.prompt'), 2, 'sent once');
  });
}

test('a drop between the user message and turn.started keeps the queue waiting; the replay settles it', async t => {
  const w = setup(t, { separateTasks: true, promptTiming: { gapMs: 50, answer: 'middle' } });
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  const sending = w.controller.sendPrompt('one [hold]');
  w.controller.queuePrompt('two');
  await until(() => texts(w.state, 'ses_a').includes('one [hold]'), 'user message');
  w.host.drop();
  await sending;
  await until(() => w.state().connection.phase === 'open' && attached(w.state) && 'ses_a' in w.state().tree.projection.running, 'reattached with the turn running', 4000);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(w.host.count('session.prompt'), 1, 'still one message on the host');
  w.host.finishTurn('ses_a', 'done');
  await until(() => w.host.count('session.prompt') === 2, 'the queued message went after the turn');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(w.host.count('session.prompt'), 2);
});

test('send now steers a queued message into the running turn', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  await w.controller.sendPrompt('long [hold]');
  await until(() => 'ses_a' in w.state().tree.projection.running, 'running');
  w.controller.queuePrompt('now please');
  await w.controller.sendQueuedNow(w.state().queued[0].id);
  const sent = w.host.calls.filter(call => call.method === 'session.prompt').at(-1);
  assert.equal(sent.params.delivery, 'steer');
  assert.equal(w.state().queued.length, 0);
});

test('the queue waits behind a message whose outcome the user has not settled', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  w.host.intercept.set('session.prompt', (params, connection, { fail }) => { fail(1004, 'unknown', { reason: 'outcome_unknown' }); return 'handled'; });
  await w.controller.sendPrompt('unsure');
  assert.equal(w.state().prompts[0]?.status, 'unknown');
  w.controller.queuePrompt('behind it');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(w.host.count('session.prompt'), 1, 'the queue does not jump an unsettled message');
  assert.equal(w.state().queued.length, 1);
});

test('a credential limited to some modes cannot drive a tree outside them (UI hint; the gateway decides)', async t => {
  const w = setup(t, { principal: { id: 'v', permissions: ['session.read', 'session.write'], workspaces: ['/w/a'], modes: ['read-only'] } });
  w.host.seed('ses_a', { mode: 'full-access' });
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  assert.match(w.controller.driveBlock(), /read-only/);
  await assert.rejects(w.controller.sendPrompt('x'), /read-only/);
  assert.equal(w.host.count('session.prompt'), 0);
  assert.deepEqual(w.state().catalog.modes.map(mode => mode.id), ['read-only']);
});

test('a reset from the host rebuilds the view from the start', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  // The host's timeline restarted (another store): the client's cursor is beyond its tip.
  const root = w.host.root('ses_a');
  root.running = 'held'; // busy, so the drop does not close it
  root.timeline = root.timeline.slice(0, 1);
  root.cursor = 1;
  w.host.drop();
  await until(() => w.state().connection.phase === 'open' && w.state().tree.projection.reset === 1, 'reset applied');
  assert.equal(w.state().tree.projection.cursor, 1);
});

test('RPC errors keep their codes through the SDK', () => {
  const error = new AlpRpcError({ code: 1003, message: 'no', data: { reason: 'grant', permission: 'session.write' } });
  assert.equal(error.code, 1003);
});
