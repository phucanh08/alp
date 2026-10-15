// Mode grants (docs/alp/remote-gateway.md §5.5): a credential with `modes` drives only trees that
// run within them. Driving means starting or continuing work: a prompt, a message (it wakes or
// steers the session, and an assignment's message also tells its requester) and an answer (it
// lets the asking turn go on). Each looks every session from the one driven up to its root up
// afresh, so a mode changed by a local client counts, and a session within the grant inside a tree
// beyond it is refused. Stopping stays possible; reading and naming are not driving.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fakeDaemon, summary } from './support/fake-daemon.js';
import { startGateway } from './support/harness.js';

async function world(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-modes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = path.join(directory, 'a');
  await mkdir(a);
  const where = await realpath(a);
  const daemon = fakeDaemon({
    sessions: [
      // A full-access root and its read-only assignment, which the runtime caps at its requester's mode.
      summary('fa', where, { mode: 'full-access' }), summary('fa-ro', where, { mode: 'read-only', parentId: 'fa' }),
      summary('ro', where, { mode: 'read-only' }), summary('ro-c', where, { mode: 'read-only', parentId: 'ro' }),
    ],
    questions: [
      { id: 'q-fa', sessionId: 'fa', rootId: 'fa', agent: 'main', body: 'go on?', askedAt: '2026-10-15T00:00:00.000Z' },
      { id: 'q-fa-ro', sessionId: 'fa-ro', rootId: 'fa', agent: 'peer', body: 'go on?', askedAt: '2026-10-15T00:00:00.000Z' },
      { id: 'q-ro', sessionId: 'ro', rootId: 'ro', agent: 'main', body: 'go on?', askedAt: '2026-10-15T00:00:00.000Z' },
    ],
  });
  const gw = await startGateway(t, { daemon, credentials: { viewer: { workspaces: [a], modes: ['read-only'] }, owner: { workspaces: [a] } } });
  return { daemon, a, ...gw };
}

const text = [{ type: 'text', text: 'hi' }];
const DRIVES = /** @type {const} */ (['session.prompt', 'session.message', 'question.answer']);
const drive = (method, target) => method === 'session.prompt' ? { sessionId: target, clientMessageId: `m-${target}`, content: text }
  : method === 'session.message' ? { sessionId: target, text: 'carry on' }
  : { questionId: `q-${target}`, text: 'yes' };
const mode = error => error.code === 1003 && error.data?.reason === 'mode' && Array.isArray(error.data.modes);

test('a read-only grant cannot prompt, message or answer a full-access session: refused before alpd', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('viewer');
  for (const method of DRIVES) {
    await assert.rejects(client.request(method, drive(method, 'fa')), mode, method);
    await assert.rejects(client.request(method, method === 'question.answer' ? { questionId: 'q-fa', dismiss: true } : drive(method, 'fa')), mode, `${method} again`);
  }
  assert.deepEqual([...daemon.calls('session.prompt'), ...daemon.calls('session.message'), ...daemon.calls('question.answer')], [], 'nothing reached alpd');
  assert.equal(daemon.state.questions.length, 3, 'the questions still wait');
});

test('a session within the grant inside a tree beyond it cannot be driven: its requester would go on', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('viewer');
  // fa-ro runs read-only, but a message to it is passed on to fa, and its answer or reply lets fa continue.
  for (const method of DRIVES) await assert.rejects(client.request(method, drive(method, 'fa-ro')), mode, method);
  assert.deepEqual([...daemon.calls('session.prompt'), ...daemon.calls('session.message'), ...daemon.calls('question.answer')], []);
});

test('the mode is looked up afresh for each drive, up to the root: a local change counts at once', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('viewer');
  // Both sessions are read-only and now known to the gateway.
  assert.deepEqual(await client.request('session.message', { sessionId: 'ro-c', text: 'one' }), {});
  // A local client raises the root; the cached tree must not be trusted.
  daemon.state.sessions.get('ro').mode = 'full-access';
  const mark = daemon.calls().length;
  for (const method of ['session.prompt', 'session.message']) {
    await assert.rejects(client.request(method, drive(method, 'ro')), mode, `${method} ro`);
    await assert.rejects(client.request(method, drive(method, 'ro-c')), mode, `${method} ro-c`);
  }
  await assert.rejects(client.request('question.answer', { questionId: 'q-ro', text: 'yes' }), mode);
  assert.deepEqual(daemon.calls().slice(mark).filter(call => call.method !== 'session.get' && call.method !== 'question.list'), []);
  // Each of the five drives asked alpd about the root again, the two of ro-c through ro-c itself.
  const looked = daemon.calls().slice(mark).filter(call => call.method === 'session.get');
  assert.equal(looked.filter(call => call.params.sessionId === 'ro').length, 5);
  assert.equal(looked.filter(call => call.params.sessionId === 'ro-c').length, 2);
});

test('within the grant every drive works, and a credential without modes is not limited', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('viewer');
  assert.equal((await client.request('session.prompt', drive('session.prompt', 'ro'))).outcome, 'accepted');
  assert.deepEqual(await client.request('session.message', drive('session.message', 'ro-c')), {});
  assert.equal((await client.request('question.answer', drive('question.answer', 'ro'))).questionId, 'q-ro');
  assert.equal(daemon.calls('session.message').length, 1);
  const { client: owner } = await sdk('owner');
  assert.deepEqual(await owner.request('session.message', drive('session.message', 'fa')), {});
  assert.equal((await owner.request('question.answer', drive('question.answer', 'fa-ro'))).questionId, 'q-fa-ro');
});

test('stopping, reading and naming stay possible; stopping an assignment of a tree beyond the grant is refused', async t => {
  const { daemon, sdk, a } = await world(t);
  const { client } = await sdk('viewer');
  // A root may always be stopped: no requester is told.
  assert.deepEqual(await client.request('session.interrupt', { sessionId: 'fa' }), {});
  assert.deepEqual(await client.request('session.close', { sessionId: 'fa' }), {});
  for (const [method, params] of [['session.get', { sessionId: 'fa-ro' }], ['session.status', { sessionId: 'fa' }], ['session.log', { sessionId: 'fa' }], ['session.attach', { sessionId: 'fa' }],
    ['session.rename', { sessionId: 'fa', title: 'seen' }], ['session.archive', { sessionId: 'fa' }], ['session.release', { sessionId: 'fa' }]]) {
    await client.request(method, params);
  }
  // Lowering a session into the grant is allowed; raising one is not.
  assert.equal((await client.request('session.configure', { sessionId: 'fa', mode: 'read-only' })).session.mode, 'read-only');
  await assert.rejects(client.request('session.configure', { sessionId: 'ro', mode: 'full-access' }), mode);
  // An assignment of a full-access requester: stopping it reports to the requester, which would go on.
  daemon.state.sessions.get('fa').mode = 'full-access';
  for (const method of ['session.interrupt', 'session.close']) await assert.rejects(client.request(method, { sessionId: 'fa-ro' }), mode, method);
  assert.deepEqual(daemon.calls('session.interrupt').map(call => call.params.sessionId), ['fa']);
  // Attaching to a live full-access root through create attaches only; nothing is driven.
  assert.equal((await client.request('session.create', { sessionId: 'fa', spec: { cwd: a, mode: 'read-only' } })).attached, true);
});
