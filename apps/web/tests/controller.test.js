// The controller against an in-memory host speaking real JSON-RPC frames: connect, select, attach
// and replay; a dropped connection, a second drop while reattaching, a terminal verdict, a refused
// credential; a root closed while nobody watched and resumed; stale answers after switching; a
// disconnect during backoff; mutations whose outcome is unknown and are never sent again by
// themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlpRpcError } from '@anhlp/alp-client/portable';
import { Controller, needsInput } from '../src/lib/controller.js';
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

test('interrupt waits for a sending prompt to reach the host turn', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  let release;
  const receipt = new Promise(resolve => { release = resolve; });
  // alpd persists a pending receipt before enqueuing runtime.prompt; an interrupt can
  // otherwise reach the runtime first, while no turn exists to cancel.
  w.host.intercept.set('session.prompt', async () => { await receipt; });
  const sending = w.controller.sendPrompt('long [hold]');
  await until(() => w.host.count('session.prompt') === 1, 'pending receipt');
  assert.equal(w.controller.rootBusy(), true, 'the composer already offers Interrupt');
  const stopping = w.controller.interrupt();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(w.host.count('session.interrupt'), 0, 'stop must follow prompt delivery');
    assert.equal(w.state().busy.interrupt, true);
  } finally {
    release();
    await sending;
    await stopping;
  }
  await until(() => !('ses_a' in w.state().tree.projection.running), 'stopped');
  assert.equal(w.host.count('session.interrupt'), 1);
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

for (const answer of ['before', 'middle', 'after']) {
  test(`a message sent before its predecessor's turn shows as running steers it instead of being refused (answer ${answer})`, async t => {
    const w = setup(t, { separateTasks: true, promptTiming: { gapMs: 50, answer } });
    w.host.seed('ses_a');
    await connected(w);
    w.controller.selectSession('ses_a');
    await until(() => attached(w.state), 'attached');
    const first = w.controller.sendPrompt('one [hold]');
    assert.equal(w.controller.rootBusy('ses_a'), true, 'busy while the first message is on its way');
    // The second goes before turn.started: it must not start a turn of its own.
    const second = w.controller.sendPrompt('two');
    await Promise.all([first, second]);
    await until(() => texts(w.state, 'ses_a').includes('two'), 'second user message');
    const sent = w.host.calls.filter(call => call.method === 'session.prompt');
    assert.deepEqual(sent.map(call => call.params.delivery), ['auto', 'steer']);
    assert.equal(w.state().prompts.length, 0, 'nothing failed');
    await until(() => 'ses_a' in w.state().tree.projection.running, 'turn started');
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(w.controller.rootBusy('ses_a'), true);
    w.host.finishTurn('ses_a', 'done');
    await until(() => !w.controller.rootBusy('ses_a'), 'idle once the turn ended');
  });
}

test('rootBusy: an idle root with nothing of ours in flight is not busy; a refused message does not keep it busy', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  assert.equal(w.controller.rootBusy('ses_a'), false);
  await w.controller.sendPrompt('hello');
  await until(() => texts(w.state, 'ses_a').includes('echo: hello'), 'reply');
  await until(() => !w.controller.rootBusy('ses_a'), 'idle after the turn');
  w.host.intercept.set('session.prompt', (_params, _connection, { answer }) => { answer({ outcome: 'failed', error: { message: 'refused' } }); return 'handled'; });
  await w.controller.sendPrompt('nope');
  assert.equal(w.state().prompts[0].status, 'failed');
  assert.equal(w.controller.rootBusy('ses_a'), false);
});

test('configureMode changes the open session\'s mode through session.configure', async t => {
  const w = setup(t);
  w.host.seed('ses_a', { mode: 'full-access' });
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  await w.controller.configureMode('read-only');
  const call = w.host.calls.find(entry => entry.method === 'session.configure');
  assert.deepEqual(call.params, { sessionId: 'ses_a', mode: 'read-only' });
  assert.equal(w.state().tree.projection.sessions.ses_a.mode, 'read-only');
  assert.equal(w.state().busy.mode, false);
});

test('configureMode refuses a mode outside the token\'s grant without calling the host', async t => {
  const w = setup(t, { principal: { id: 'p1', label: 'ro', permissions: ['session.read', 'session.write', 'project.read'], modes: ['read-only', 'workspace-write'], workspaces: ['/w/a'], workspaceRoots: [{ path: '/w/a', canonical: '/w/a' }] } });
  w.host.seed('ses_a', { mode: 'read-only' });
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  await w.controller.configureMode('full-access');
  assert.equal(w.host.count('session.configure'), 0);
  assert.match(w.state().notice.text, /only use read-only, workspace-write/);
});

test('a message the host took but whose events never come stops counting as working after a while (no stuck steer)', async t => {
  const w = setup(t, {}, { busyUnseenMs: 150 });
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  // Taken, and then nothing: no user message, no prompt.accepted, no turn.
  w.host.intercept.set('session.prompt', (_params, _connection, { answer }) => { answer({ outcome: 'accepted', durable: true }); return 'handled'; });
  await w.controller.sendPrompt('lost');
  assert.equal(w.controller.rootBusy('ses_a'), true, 'busy right after it was taken');
  const renders = [];
  const stop = w.controller.subscribe(() => renders.push(w.controller.rootBusy('ses_a')));
  t.after(stop);
  await until(() => !w.controller.rootBusy('ses_a'), 'not busy after the limit', 2000);
  await until(() => renders.includes(false), 'the views are told to render again', 2000);
  w.host.intercept.delete('session.prompt');
  await w.controller.sendPrompt('next');
  const sent = w.host.calls.filter(call => call.method === 'session.prompt');
  assert.deepEqual(sent.map(call => call.params.delivery), ['auto', 'auto']);
  await until(() => texts(w.state, 'ses_a').includes('echo: next'), 'reply to the next message');
});

test('a second message waits for the answer to the first before it goes out', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  // The host holds its answer to the first message (and the turn it starts) for a while.
  let firstAnswered = false;
  const order = [];
  w.host.intercept.set('session.prompt', async params => {
    order.push({ text: params.content[0].text, firstAnswered });
    if (params.content[0].text === 'one [hold]') { await new Promise(resolve => setTimeout(resolve, 100)); firstAnswered = true; }
    return undefined;
  });
  const first = w.controller.sendPrompt('one [hold]');
  const second = w.controller.sendPrompt('two');
  await Promise.all([first, second]);
  assert.deepEqual(order, [{ text: 'one [hold]', firstAnswered: false }, { text: 'two', firstAnswered: true }]);
  const sent = w.host.calls.filter(call => call.method === 'session.prompt');
  assert.deepEqual(sent.map(call => call.params.delivery), ['auto', 'steer']);
  assert.equal(w.state().prompts.filter(prompt => prompt.status === 'failed').length, 0);
});

test('a retry under a new id waits for the message before it and steers the turn that message started', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  // A message the runtime refused, waiting for Retry (a new id).
  w.host.intercept.set('session.prompt', (_params, _connection, { answer }) => { answer({ outcome: 'failed', error: { message: 'busy' } }); return 'handled'; });
  await w.controller.sendPrompt('again [finish]');
  const failed = w.state().prompts.find(prompt => prompt.status === 'failed');
  assert.ok(failed);
  // Then a new turn whose answer the host holds; the retry comes before that answer.
  const order = [];
  let firstAnswered = false;
  w.host.intercept.set('session.prompt', async params => {
    order.push({ text: params.content[0].text, firstAnswered });
    if (params.content[0].text === 'long [hold]') { await new Promise(resolve => setTimeout(resolve, 100)); firstAnswered = true; }
    return undefined;
  });
  const first = w.controller.sendPrompt('long [hold]');
  const retry = w.controller.retryPrompt(failed.id);
  await Promise.all([first, retry]);
  assert.deepEqual(order, [{ text: 'long [hold]', firstAnswered: false }, { text: 'again [finish]', firstAnswered: true }]);
  const sent = w.host.calls.filter(call => call.method === 'session.prompt');
  assert.deepEqual(sent.map(call => call.params.delivery), ['auto', 'auto', 'steer']);
  assert.notEqual(sent[2].params.clientMessageId, sent[0].params.clientMessageId);
  await until(() => texts(w.state, 'ses_a').includes('again [finish]'), 'steered in');
});

test('three quick messages to an idle root, the first refused: the others are not sent as steers', async t => {
  const w = setup(t);
  w.host.seed('ses_a');
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => attached(w.state), 'attached');
  let refused = false;
  w.host.intercept.set('session.prompt', (_params, _connection, { answer }) => {
    if (refused) return undefined;
    refused = true;
    answer({ outcome: 'failed', error: { message: 'not now' } });
    return 'handled';
  });
  await Promise.all([w.controller.sendPrompt('a'), w.controller.sendPrompt('b'), w.controller.sendPrompt('c')]);
  const sent = w.host.calls.filter(call => call.method === 'session.prompt');
  assert.equal(sent[0].params.delivery, 'auto');
  assert.equal(sent[1].params.delivery, 'auto', 'b starts a turn: nothing of ours is running');
  const failures = w.state().prompts.filter(prompt => prompt.status === 'failed').map(prompt => prompt.text);
  assert.ok(!failures.includes('b'), `b was refused: ${JSON.stringify(w.state().prompts)}`);
});

test('attention: question.list marks every root that waits, not only the open one', async t => {
  const w = setup(t, undefined, { attentionPollMs: 20 });
  w.host.seed('ses_a', { title: 'Asks' });
  w.host.seed('ses_b', { title: 'Open' });
  w.host.seed('ses_c', { projectRoot: '/w/b' });
  w.host.ask('ses_a', 'ses_a', 'qa');
  w.host.ask('ses_c', 'ses_c', 'qc');
  await connected(w);
  w.controller.selectSession('ses_b');
  await until(() => attached(w.state), 'attached');
  await until(() => needsInput(w.state(), 'ses_a'), 'ses_a waits');
  assert.deepEqual(w.state().attention, { ses_a: 1 }, 'only the workspace asked for');
  assert.equal(needsInput(w.state(), 'ses_b'), false);
  assert.ok(w.host.calls.some(call => call.method === 'question.list' && call.params.projectRoot === '/w/a'));
  // The open tree's own questions count at once, before the next poll.
  w.host.ask('ses_b', 'ses_b', 'qb');
  await until(() => needsInput(w.state(), 'ses_b'), 'ses_b waits');
  await w.controller.answerQuestion('qb', { text: 'ok' });
  assert.equal(needsInput(w.state(), 'ses_b'), false);
  // Answered elsewhere: the next poll clears it.
  w.host.questions.delete('qa');
  await until(() => !needsInput(w.state(), 'ses_a'), 'ses_a cleared');
});

test('history lists archived roots too; unarchive brings one back into the list', async t => {
  const w = setup(t);
  w.host.seed('ses_a', { title: 'Kept' });
  w.host.seed('ses_b', { title: 'Put away' });
  await connected(w);
  await w.controller.archiveSession('ses_b');
  assert.deepEqual(w.state().sessions.list.map(row => row.id), ['ses_a']);
  await w.controller.loadHistory();
  assert.equal(w.state().history.status, 'ready');
  assert.deepEqual(w.state().history.list.map(row => [row.id, !!row.archived]).sort(), [['ses_a', false], ['ses_b', true]]);
  assert.ok(w.host.calls.some(call => call.method === 'session.list' && call.params.includeArchived === true));
  w.controller.selectSession('ses_b');
  assert.equal(w.controller.isArchived('ses_b'), true);
  assert.equal(w.controller.isArchived('ses_a'), false);
  await w.controller.restoreSession('ses_b');
  assert.deepEqual(w.host.calls.filter(call => call.method === 'session.archive').map(call => call.params), [{ sessionId: 'ses_b', archived: true }, { sessionId: 'ses_b', archived: false }]);
  assert.equal(w.controller.isArchived('ses_b'), false);
  assert.ok(w.state().sessions.list.some(row => row.id === 'ses_b'));
  await until(() => w.state().sessions.list.length === 2, 'listed again');
  await w.controller.renameSession('ses_b', 'Back again');
  assert.equal(w.state().history.list.find(row => row.id === 'ses_b')?.title, 'Back again');
});

// ---- t-7679.3: preferences in storage, session.preview, a session started with a first message

const memoryStorage = () => {
  const entries = new Map();
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, String(value)); } };
};

test('preferences survive a new controller (a reload) and connect/disconnect; the token never reaches storage', async t => {
  const storage = memoryStorage();
  const w = setup(t, undefined, { storage });
  assert.deepEqual(w.state().preferences, { sendBehavior: 'steer', theme: 'system', newSession: {} });
  await connected(w);
  w.controller.setSendBehavior('queue');
  w.controller.setTheme('light');
  w.controller.disconnect();
  assert.equal(w.state().preferences.sendBehavior, 'queue', 'disconnecting keeps them');
  await connected(w);
  assert.equal(w.state().preferences.theme, 'light', 'a new connection keeps them');
  const stored = [...storage.entries.values()].join('\n');
  assert.doesNotMatch(stored, /alpgw1|secret|127\.0\.0\.1/);
  const reloaded = setup(t, undefined, { storage });
  assert.deepEqual(reloaded.state().preferences, { sendBehavior: 'queue', theme: 'light', newSession: {} });
  reloaded.controller.resetPreferences();
  assert.equal(JSON.parse(storage.entries.get('alp-web:preferences')).sendBehavior, 'steer');
  // Another tab wrote something: reloadPreferences follows it; garbage gives the defaults.
  storage.setItem('alp-web:preferences', JSON.stringify({ v: 1, sendBehavior: 'queue', theme: 'dark' }));
  reloaded.controller.reloadPreferences();
  assert.equal(reloaded.state().preferences.theme, 'dark');
  storage.setItem('alp-web:preferences', '{broken');
  reloaded.controller.reloadPreferences();
  assert.equal(reloaded.state().preferences.theme, 'system');
});

test('the catalog keeps each model\'s efforts; session.preview answers for the workspace', async t => {
  const w = setup(t);
  await connected(w);
  await until(() => w.state().catalog.status === 'ready', 'catalog');
  assert.deepEqual(w.state().catalog.models[0], { id: 'codex:gpt-5.6-sol', label: 'GPT', efforts: ['low', 'medium', 'high'], effort: 'low' });
  const preview = await w.controller.previewSession({ workflow: 'cafe', model: 'codex:gpt-5.6-sol', thinking: 'high', cwd: '/elsewhere' });
  assert.deepEqual(preview, { teams: [{ id: 'pho', label: 'Phở' }, { id: 'cafe', label: 'Cafe' }], team: 'cafe', teamLabel: 'Cafe', agent: 'main', runtime: 'codex', model: 'gpt-5.6-sol', mode: 'full-access', thinking: 'high' });
  const call = w.host.calls.find(entry => entry.method === 'session.preview');
  assert.equal(call.params.spec.cwd, '/w/a', 'the cwd is always the open workspace');
  await assert.rejects(w.controller.previewSession({ thinking: 'ultra' }), /not offered/);
});

test('session.preview is not asked without session.read', async t => {
  // project.read only: session.write would imply session.read.
  const w = setup(t, { principal: { id: 'p2', label: 'blind', permissions: ['project.read'], workspaces: ['/w/a'], workspaceRoots: [{ path: '/w/a', canonical: '/w/a' }] } });
  await connected(w);
  assert.match(w.controller.previewBlock(), /cannot read sessions/);
  await assert.rejects(w.controller.previewSession({}), /cannot read sessions/);
  assert.equal(w.host.count('session.preview'), 0);
});

test('session.preview honors caller cancellation before sending a request', async t => {
  const w = setup(t);
  await connected(w);
  await until(() => w.state().catalog.status === 'ready', 'catalog');
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(w.controller.previewSession({}, { signal: abort.signal }), /abort/i);
  assert.equal(w.host.count('session.preview'), 0);
});

test('a session started with a first message and thinking: spec.thinking sent, the message delivered once after attach, named by the host after it, the choices remembered', async t => {
  const storage = memoryStorage();
  const w = setup(t, undefined, { storage });
  await connected(w);
  const id = await w.controller.createSession({ team: 'cafe', mode: 'workspace-write', model: 'codex:gpt-5.6-sol', thinking: 'high', prompt: 'Fix the login bug\nmore detail' });
  await until(() => texts(w.state, id).includes('echo: Fix the login bug\nmore detail'), 'the first message ran');
  const create = w.host.calls.find(call => call.method === 'session.create');
  assert.deepEqual(create.params.spec, { cwd: '/w/a', persist: true, workflow: 'cafe', mode: 'workspace-write', model: 'codex:gpt-5.6-sol', thinking: 'high' });
  const prompts = w.host.calls.filter(call => call.method === 'session.prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].params.sessionId, id);
  assert.ok(w.host.calls.indexOf(prompts[0]) > w.host.calls.findIndex(call => call.method === 'session.attach' && call.params.sessionId === id), 'sent after the attach');
  // alpd names it after the message (Paseo's rule); the app no longer renames it itself.
  assert.equal(w.host.count('session.rename'), 0);
  await until(() => w.state().sessions.list.find(row => row.id === id)?.title === 'Fix the login bug', 'the list row took the name the host announced');
  assert.deepEqual(w.state().preferences.newSession, { team: 'cafe', mode: 'workspace-write', model: 'codex:gpt-5.6-sol', thinkingByModel: { 'codex:gpt-5.6-sol': 'high' } });
  assert.deepEqual(JSON.parse(storage.entries.get('alp-web:preferences')).newSession, w.state().preferences.newSession);
  // An explicit title wins; no prompt sends nothing.
  const second = await w.controller.createSession({ title: 'Named' });
  await until(() => attached(w.state) && w.state().tree.rootId === second, 'second attached');
  assert.equal(w.host.root(second).summary.title, 'Named');
  assert.equal(w.host.count('session.rename'), 1);
  assert.equal(w.host.count('session.prompt'), 1);
});

test('a refused create sends no first message', async t => {
  const w = setup(t);
  await connected(w);
  w.host.intercept.set('session.create', (params, connection, { fail }) => { fail(1003, 'mode not allowed'); return 'handled'; });
  await assert.rejects(w.controller.createSession({ prompt: 'hello' }));
  assert.equal(w.host.count('session.prompt'), 0);
  assert.equal(w.state().selected, null);
});

test('a second create while the first waits on session.release is refused: exactly one session.create', async t => {
  const w = setup(t);
  await connected(w);
  const first = await w.controller.createSession({ team: 'pho', title: 'First' });
  await until(() => attached(w.state) && w.state().tree.rootId === first, 'first attached');
  let release = () => {};
  w.host.intercept.set('session.release', () => new Promise(resolve => { release = () => resolve(undefined); }));
  const creates = w.host.count('session.create');
  const one = w.controller.createSession({ team: 'pho', prompt: 'one' });
  assert.equal(w.state().busy.create, true, 'busy before any await');
  await assert.rejects(w.controller.createSession({ team: 'pho', prompt: 'two' }), /already starting/);
  release();
  await one;
  assert.equal(w.host.count('session.create'), creates + 1);
  assert.equal(w.state().busy.create, false);
});

test('a create whose answer is lost (timeout) rejects with its id: the caller keeps the first message, none is sent', async t => {
  const w = setup(t, undefined, { createTimeoutMs: 30 });
  await connected(w);
  w.host.intercept.set('session.create', () => 'handled');
  const failure = await w.controller.createSession({ team: 'pho', prompt: 'keep me' }).then(() => null, error => error);
  assert.ok(failure, 'not a silent success');
  assert.equal(failure.name, 'CreateOutcomeUnknownError');
  assert.match(failure.message, /may still have run/);
  assert.match(failure.message, /open it and send your message there/);
  assert.doesNotMatch(failure.message, /first message was not sent/, 'the caller words what happened to the message');
  assert.equal(w.state().selected, failure.sessionId, 'the maybe-session stays selected');
  assert.equal(w.state().busy.create, false);
  assert.equal(w.host.count('session.prompt'), 0);
  // A new start is possible afterwards.
  w.host.intercept.delete('session.create');
  const id = await w.controller.createSession({ team: 'pho', prompt: 'again' });
  await until(() => texts(w.state, id).includes('echo: again'), 'the second start ran');
});

test('the catalog says why teams are unknown, and retryTeams asks team.list again only after a failure', async t => {
  const w = setup(t);
  let fail = true;
  w.host.intercept.set('team.list', (_params, _connection, { fail: reject }) => { if (fail) { reject(1000, 'Gateway busy.'); return 'handled'; } });
  await connected(w);
  await until(() => w.state().catalog.status === 'ready', 'catalog');
  assert.equal(w.state().catalog.teamsKnown, false);
  assert.equal(w.state().catalog.teamsUnavailable?.reason, 'failed');
  assert.match(w.state().catalog.teamsUnavailable?.message ?? '', /Gateway busy/);
  fail = false;
  const before = w.host.count('team.list');
  await w.controller.retryTeams();
  assert.equal(w.host.count('team.list'), before + 1);
  assert.equal(w.state().catalog.teamsKnown, true);
  assert.equal(w.state().catalog.teamsUnavailable, undefined);
  assert.ok(w.state().catalog.teams.length > 0, 'the teams arrived');
  // Answered: a further retry does not ask again.
  await w.controller.retryTeams();
  assert.equal(w.host.count('team.list'), before + 1);
});

test('teams are unknown (not empty) without project.read or the team capability, and nothing is asked', async t => {
  const w = setup(t, { principal: { id: 'p3', label: 'no-project', permissions: ['session.read', 'session.write'], workspaces: ['/w/a'], workspaceRoots: [{ path: '/w/a', canonical: '/w/a' }] } });
  await connected(w);
  await until(() => w.state().catalog.status === 'ready', 'catalog');
  assert.deepEqual(w.state().catalog.teamsUnavailable, { reason: 'permission' });
  assert.equal(w.state().catalog.teamsKnown, false);
  const v = setup(t);
  v.host.capabilities = v.host.capabilities.filter(capability => capability !== 'team');
  await connected(v);
  await until(() => v.state().catalog.status === 'ready', 'catalog');
  assert.deepEqual(v.state().catalog.teamsUnavailable, { reason: 'capability' });
  assert.equal(v.host.count('team.list'), 0);
  await v.controller.retryTeams();
  assert.equal(v.host.count('team.list'), 0, 'retry does not ask a host without teams');
});

test('a first message kept from a failed start is handed to the next New session screen of its workspace once', async t => {
  const w = setup(t);
  await connected(w);
  assert.equal(w.controller.unsentDraft(), '');
  const origin = w.controller.startOrigin();
  assert.equal(origin.workspace, '/w/a');
  w.controller.keepUnsentDraft('x'.repeat(500), origin);
  assert.equal(w.controller.unsentDraft().length, 500, 'kept whole');
  w.controller.clearUnsentDraft();
  assert.equal(w.controller.unsentDraft(), '');
  // Written for /w/a: another workspace does not see it, its own does again.
  w.controller.keepUnsentDraft('for a', origin);
  w.controller.selectWorkspace('/w/b');
  assert.equal(w.controller.unsentDraft(), '', 'not offered in another workspace');
  w.controller.selectWorkspace('/w/a');
  assert.equal(w.controller.unsentDraft(), 'for a');
  // A disconnect forgets it (the next sign-in may be another token).
  w.controller.disconnect();
  assert.equal(w.controller.unsentDraft(), '', 'forgotten on disconnect');
});

test('a kept first message belongs to its connection: another token forgets it, a start from an earlier connection keeps nothing', async t => {
  const w = setup(t);
  await connected(w);
  w.controller.keepUnsentDraft('first', w.controller.startOrigin());
  assert.equal(w.controller.unsentDraft(), 'first');
  // connect() with another token while connected: the kept message goes with the old connection.
  w.controller.connect({ url: 'http://127.0.0.1:7434', token: 'alpgw1.fedcba9876543210.other' });
  await until(() => w.state().connection.phase === 'open', 'open again');
  w.controller.selectWorkspace('/w/a');
  assert.equal(w.controller.unsentDraft(), '', 'another token does not see it');
  // A start begun before a disconnect fails after the next connect: nothing is kept for this one.
  const before = w.controller.startOrigin();
  w.controller.disconnect();
  await connected(w);
  w.controller.keepUnsentDraft('late', before);
  assert.equal(w.controller.unsentDraft(), '', 'a start from an earlier connection keeps nothing');
  w.controller.keepUnsentDraft('now', w.controller.startOrigin());
  assert.equal(w.controller.unsentDraft(), 'now', 'this connection keeps its own');
});

test('an open New session screen of the workspace takes a kept first message at once', async t => {
  const w = setup(t);
  await connected(w);
  const taken = [];
  const release = w.controller.takeUnsentDrafts(kept => kept.workspace === '/w/a' && (taken.push(kept.text), true));
  w.controller.keepUnsentDraft('to the open screen', w.controller.startOrigin());
  assert.deepEqual(taken, ['to the open screen']);
  assert.equal(w.controller.unsentDraft(), '', 'not kept again for the next screen');
  release();
  w.controller.keepUnsentDraft('for the next screen', w.controller.startOrigin());
  // A screen forgets only the message it showed: one kept after it read stays.
  w.controller.clearUnsentDraft('something it showed earlier');
  assert.equal(w.controller.unsentDraft(), 'for the next screen');
  assert.deepEqual(taken, ['to the open screen'], 'a closed screen takes nothing');
  assert.equal(w.controller.unsentDraft(), 'for the next screen');
});

test('attention with question.watch: events of roots not attached keep it current, without polling', async t => {
  const w = setup(t, undefined, { attentionPollMs: 20, attentionWatchPollMs: 60_000 });
  w.host.capabilities.push('question.watch');
  w.host.seed('ses_a', { title: 'Asks' });
  w.host.seed('ses_b', { title: 'Open' });
  w.host.seed('ses_c', { projectRoot: '/w/b' });
  w.host.ask('ses_a', 'ses_a', 'qa');
  await connected(w);
  w.controller.selectSession('ses_b');
  await until(() => attached(w.state), 'attached');
  await until(() => needsInput(w.state(), 'ses_a'), 'the waiting question from the watch answer');
  assert.ok(w.host.calls.some(call => call.method === 'question.watch' && call.params.projectRoot === '/w/a'));
  // Asked in a root this view is not attached to: the event alone marks it.
  w.host.seed('ses_d', { title: 'Later' });
  w.host.ask('ses_d', 'ses_d', 'qd');
  await until(() => w.state().attention.ses_d === 1, 'ses_d waits');
  // Another workspace is not told; the open tree's projection gets none of these.
  w.host.ask('ses_c', 'ses_c', 'qc');
  assert.deepEqual(Object.keys(w.state().tree.projection.questions), []);
  // Resolved elsewhere: the event clears it.
  w.host.resolve('qa');
  await until(() => !needsInput(w.state(), 'ses_a'), 'ses_a cleared');
  assert.deepEqual(w.state().attention, { ses_d: 1 });
  // The open tree still has its own, once.
  w.host.ask('ses_b', 'ses_b', 'qb');
  await until(() => needsInput(w.state(), 'ses_b'), 'ses_b waits');
  assert.deepEqual(Object.keys(w.state().tree.projection.questions), ['qb']);
  await w.controller.answerQuestion('qb', { text: 'ok' });
  await until(() => !needsInput(w.state(), 'ses_b'), 'ses_b answered');
  const watches = w.host.count('question.watch');
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(w.host.count('question.list'), 0, 'no question.list poll');
  assert.equal(w.host.count('question.watch'), watches, 'no poll at attentionPollMs');
  // A reconnect lists again: what was resolved while away is gone.
  w.host.drop();
  w.host.questions.delete('qd');
  await until(() => w.host.count('question.watch') > watches && !w.state().attention.ses_d, 'listed again after the reconnect');
});

test('history pages: Load more reads the next page, a query is searched by the host', async t => {
  const w = setup(t, undefined, { historyPageSize: 2 });
  w.host.capabilities.push('session.list.page');
  for (const [index, title] of ['Fix login', 'Docs', 'Fix logout', 'Ship'].entries()) {
    w.host.seed(`ses_${index}`, { title });
    w.host.root(`ses_${index}`).summary.updatedAt = new Date(Date.UTC(2026, 9, 1, index)).toISOString();
  }
  await connected(w);
  await w.controller.loadHistory();
  assert.deepEqual(w.state().history.list.map(row => row.title), ['Ship', 'Fix logout']);
  assert.equal(w.state().history.nextCursor, '@2');
  await w.controller.loadMoreHistory();
  assert.deepEqual(w.state().history.list.map(row => row.title), ['Ship', 'Fix logout', 'Docs', 'Fix login']);
  assert.equal(w.state().history.nextCursor, undefined);
  await w.controller.loadHistory({ query: 'fix' });
  assert.deepEqual([w.state().history.list.map(row => row.title), w.state().history.query, w.state().history.nextCursor], [['Fix logout', 'Fix login'], 'fix', undefined]);
  const asked = w.host.calls.filter(call => call.method === 'session.list' && call.params.limit === 2).map(call => [call.params.cursor, call.params.query]);
  assert.deepEqual(asked, [[undefined, undefined], ['@2', undefined], [undefined, 'fix']]);
  // A quiet reload keeps the query.
  await w.controller.loadHistory({ quiet: true });
  assert.equal(w.host.calls.at(-1).params.query, 'fix');
});

test('history without session.list.page reads everything once, with no cursor', async t => {
  const w = setup(t, undefined, { historyPageSize: 1 });
  w.host.seed('ses_a', { title: 'One' });
  w.host.seed('ses_b', { title: 'Two' });
  await connected(w);
  await w.controller.loadHistory({ query: 'one' });
  assert.equal(w.state().history.list.length, 2, 'the screen filters');
  assert.equal(w.state().history.nextCursor, undefined);
  const call = w.host.calls.filter(entry => entry.method === 'session.list').at(-1);
  assert.equal(call.params.limit, undefined);
  assert.equal(call.params.query, undefined);
});

test('question events that come before the question.watch answer are not lost to it', async t => {
  const w = setup(t, undefined, { attentionWatchPollMs: 60_000 });
  w.host.capabilities.push('question.watch');
  w.host.seed('ses_a', { title: 'A' });
  w.host.seed('ses_b', { title: 'B' });
  w.host.ask('ses_a', 'ses_a', 'qa');
  // As through the gateway: the host reads its questions, then events of later changes reach the
  // client before the answer does.
  w.host.intercept.set('question.watch', (params, connection, { answer }) => {
    connection.watching = params.projectRoot ?? null;
    const snapshot = structuredClone([...w.host.questions.values()]);
    w.host.ask('ses_b', 'ses_b', 'qb');
    w.host.resolve('qa');
    setTimeout(() => answer({ questions: snapshot }), 10);
    return 'handled';
  });
  await connected(w);
  await until(() => w.host.count('question.watch') >= 1, 'watched');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(w.state().attention, { ses_b: 1 }, 'qb asked and qa resolved after the read');
});

test('history: a Load more overtaken by a new first page ends without changing it', async t => {
  const w = setup(t, undefined, { historyPageSize: 1 });
  w.host.capabilities.push('session.list.page');
  w.host.seed('ses_a', { title: 'A' });
  w.host.seed('ses_b', { title: 'B' });
  await connected(w);
  await w.controller.loadHistory();
  assert.equal(w.state().history.list.length, 1);
  let release;
  w.host.intercept.set('session.list', params => params.cursor ? new Promise(resolve => { release = () => resolve(undefined); }) : undefined);
  const more = w.controller.loadMoreHistory();
  await until(() => w.state().history.more === 'loading' && release, 'loading more');
  await w.controller.loadHistory({ quiet: true });
  release();
  await more;
  assert.equal(w.state().history.more, undefined);
  assert.equal(w.state().history.list.length, 1, 'the page of the older list is dropped');
  assert.ok(w.state().history.nextCursor);
});
