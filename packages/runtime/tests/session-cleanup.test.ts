import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { createAlpRuntime } from '@anhlp/alp-runtime';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function until(check) {
  for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected lifecycle boundary did not arrive');
}
const tick = () => new Promise(resolve => setImmediate(resolve));

async function setup(t, configure = () => {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-cleanup-'));
  const root = path.join(directory, 'project');
  const home = path.join(directory, 'home');
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'], lead: ['peer'] } }));
  const transports = [];
  const manager = createAlpRuntime({ supervisor: false, libraryDir: home, environment: { ...process.env, ALP_HOME: home }, transport: (cwd, env) => {
    const index = transports.length;
    const transport = {
      closeCalls: 0, calls: [],
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closeCalls++; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: `thread-${index}` } };
        if (method === 'turn/start') return { turn: { id: `turn-${index}` } };
        return {};
      },
      call(tool, args) { return this.serverRequest('item/tool/call', { threadId: `thread-${index}`, turnId: `turn-${index}`, callId: `${tool}-${index}`, namespace: null, tool, arguments: args }); },
    };
    transports.push(transport);
    configure(transport, index, cwd, env);
    return transport;
  } });
  t.after(() => manager.shutdown());
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events = [];
  manager.onEvent(event => events.push(event));
  const lifecycle = id => events.filter(e => e.sessionId === id && ['session.opened', 'session.failed', 'session.closed'].includes(e.event.type)).map(e => e.event.type);
  return { root, manager, transports, events, lifecycle };
}

// Gate only filesystem stat at the real resolveSession boundary. Both opens have
// passed the id check before either can register; then select each ordering explicitly.
async function overlappingChild(t, { lateClose = false, older = 'public', beforeRegistration = false } = {}) {
  const initialization = deferred();
  const closing = deferred();
  let first;
  const state = await setup(t, (transport, index) => {
    if (beforeRegistration) return;
    if (index === 1) {
      first = transport;
      transport.initialize = () => initialization.promise;
      transport.close = async () => { transport.closeCalls++; await closing.promise; };
    }
    if (index === 2 && lateClose) first.failure(new Error('process exited during initialization'));
  });
  const { manager, root, transports } = state;
  const workdirs = { public: path.join(root, 'public'), delegated: path.join(root, 'delegated') };
  await Promise.all(Object.values(workdirs).map(dir => mkdir(dir)));
  await manager.open('root', { cwd: root, workdir: workdirs.delegated });
  await manager.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Delegate' }] });
  const gates = { public: deferred(), delegated: deferred() };
  const reached = new Set();
  const stat = fsPromises.stat;
  let enabled = false;
  const mocked = t.mock.method(fsPromises, 'stat', async (target, ...args) => {
    const owner = Object.keys(workdirs).find(owner => workdirs[owner] === target);
    if (enabled && owner) {
      reached.add(owner); await gates[owner].promise;
      if (beforeRegistration && owner === 'delegated') throw new Error('delegated config refused before registration');
    }
    return stat(target, ...args);
  });
  syncBuiltinESMExports();
  let publicOpen, id;
  const unsubscribe = manager.onEvent(envelope => {
    if (envelope.event.type !== 'assignment' || id) return;
    id = envelope.event.assignment.id;
    enabled = true;
    publicOpen = manager.open(id, { cwd: root, workdir: workdirs.public, agent: 'lead' });
    publicOpen.catch(() => {});
  });
  const delegated = transports[0].call('alp_delegate', { agent: 'lead', task: 'Work', wait: false });
  try {
    await until(() => reached.size === 2);
    const first = beforeRegistration ? 'public' : older;
    gates[first].resolve();
    await until(() => transports.length === 2);
    gates[first === 'public' ? 'delegated' : 'public'].resolve();
    await until(() => transports.length === (beforeRegistration ? 2 : 3) && manager.snapshot(id)?.threadId === (beforeRegistration ? 'thread-1' : 'thread-2'));
  } catch (error) {
    gates.public.resolve(); gates.delegated.resolve();
    initialization.reject(error); closing.resolve();
    await Promise.allSettled([publicOpen, delegated]);
    throw error;
  } finally {
    gates.public.resolve(); gates.delegated.resolve();
    mocked.mock.restore(); syncBuiltinESMExports(); unsubscribe();
  }
  return { ...state, id, initialization, closing, publicOpen, delegated, older };
}

async function settledOpens(s) {
  const [publicResult, delegatedResult] = await Promise.allSettled([s.publicOpen, s.delegated]);
  assert.equal(delegatedResult.status, 'fulfilled');
  if (s.older === 'public') {
    assert.equal(publicResult.status, 'rejected', 'superseded public open failed');
    assert.equal(delegatedResult.value.success, true, 'delegated replacement opened');
  } else {
    assert.equal(publicResult.status, 'fulfilled', 'public replacement opened');
    assert.equal(publicResult.value.threadId, 'thread-2');
    assert.equal(delegatedResult.value.success, false, 'superseded assignment failed');
  }
  await tick();
}

for (const older of ['public', 'delegated']) {
  test(`late close preserves replacement and parent membership (old ${older})`, async t => {
    const s = await overlappingChild(t, { lateClose: true, older });
    s.closing.resolve();
    await tick();
    const afterClose = s.manager.snapshot(s.id);
    s.initialization.reject(new Error('old initialization rejected'));
    await settledOpens(s);
    assert.equal(afterClose?.threadId, 'thread-2', 'late close alone preserves replacement before old open catch runs');
    assert.equal(s.manager.snapshot(s.id)?.threadId, 'thread-2');
    assert.equal(s.transports[1].closeCalls, 1);
    assert.equal(s.transports[2].closeCalls, 0);
    assert.ok(s.manager.status('root').sessions.some(session => session.id === s.id), 'parent still reaches replacement');
    assert.equal(s.lifecycle(s.id).filter(type => type === 'session.closed').length, 0);
  });

  test(`late open rejection cleans up only its own record (old ${older})`, async t => {
    const s = await overlappingChild(t, { older });
    s.initialization.reject(new Error('old initialization rejected'));
    s.closing.resolve();
    await settledOpens(s);
    assert.equal(s.manager.snapshot(s.id)?.threadId, 'thread-2');
    assert.equal(s.transports[1].closeCalls, 1);
    assert.equal(s.transports[2].closeCalls, 0);
    assert.deepEqual(s.lifecycle(s.id), ['session.opened']);
    assert.ok(s.manager.status('root').sessions.some(session => session.id === s.id), 'parent still reaches replacement');
    const transport = s.transports[2];
    const before = transport.calls.filter(call => call.method === 'turn/start').length;
    if (before) transport.notification('turn/completed', { threadId: 'thread-2', turn: { id: 'turn-2', status: 'completed' } });
    await s.manager.prompt(s.id, { clientMessageId: 'replacement-prompt', delivery: 'auto', content: [{ type: 'text', text: 'Still available' }] });
    assert.equal(transport.calls.filter(call => call.method === 'turn/start').length, before + 1);
    transport.notification('turn/completed', { threadId: 'thread-2', turn: { id: 'turn-2', status: 'completed' } });
  });

  test(`late successful initialization cannot publish a superseded open (old ${older})`, async t => {
    const s = await overlappingChild(t, { older });
    s.initialization.resolve();
    s.closing.resolve();
    await settledOpens(s);
    assert.equal(s.manager.snapshot(s.id)?.threadId, 'thread-2');
    assert.equal(s.transports[1].closeCalls, 1);
    assert.equal(s.transports[2].closeCalls, 0);
    assert.deepEqual(s.lifecycle(s.id), ['session.opened']);
    assert.ok(s.manager.status('root').sessions.some(session => session.id === s.id));
  });

  test(`superseded transport failure leaves replacement live (old ${older})`, async t => {
    const s = await overlappingChild(t, { older });
    s.transports[1].failure(new Error('superseded process exited'));
    await tick();
    const afterFailure = s.manager.snapshot(s.id);
    const closedReplacement = s.transports[2].closeCalls;
    const lifecycle = s.lifecycle(s.id);
    s.initialization.reject(new Error('old initialization rejected'));
    s.closing.resolve();
    await settledOpens(s);
    assert.equal(afterFailure?.threadId, 'thread-2');
    assert.equal(closedReplacement, 0);
    assert.deepEqual(lifecycle, ['session.opened']);
  });
}

test('assignment failure before registration does not harvest or close another open', async t => {
  const s = await overlappingChild(t, { beforeRegistration: true });
  const [opened, delegated] = await Promise.all([s.publicOpen, s.delegated]);
  assert.equal(opened.threadId, 'thread-1');
  assert.equal(delegated.success, false);
  assert.equal(s.manager.snapshot(s.id)?.threadId, 'thread-1');
  assert.equal(s.transports[1].closeCalls, 0);
  assert.deepEqual(s.lifecycle(s.id), ['session.opened']);
  assert.ok(s.manager.status('root').sessions.some(session => session.id === s.id));
  await s.manager.close(s.id);
  assert.equal(s.transports[1].closeCalls, 1);
});

test('failure while open is pending closes its transport once and reports only failed', async t => {
  const initialization = deferred();
  const s = await setup(t, transport => { transport.initialize = () => initialization.promise; });
  const opening = s.manager.open('root', { cwd: s.root });
  const rejected = assert.rejects(opening, /initialization rejected/);
  await until(() => s.transports.length === 1);
  s.transports[0].failure(new Error('process exited'));
  await tick();
  initialization.reject(new Error('initialization rejected'));
  await rejected;
  assert.equal(s.transports[0].closeCalls, 1);
  assert.deepEqual(s.lifecycle('root'), ['session.failed']);
  assert.equal(s.manager.snapshot('root'), undefined);
});

test('a transport failure while open is pending waits for the open: it fails with that error and reports it once', async t => {
  const initialization = deferred();
  const s = await setup(t, transport => { transport.initialize = () => initialization.promise; });
  const opening = s.manager.open('root', { cwd: s.root });
  const rejected = assert.rejects(opening, /process exited/);
  await until(() => s.transports.length === 1);
  s.transports[0].failure(new Error('process exited'));
  await tick();
  // The open still runs: nothing closed or reported under it yet.
  assert.equal(s.transports[0].closeCalls, 0);
  assert.deepEqual(s.lifecycle('root'), []);
  // The step it waited on settles without an error of its own: the failure fails the open, not 'Session closed'.
  initialization.resolve();
  await rejected;
  assert.equal(s.transports[0].closeCalls, 1);
  assert.deepEqual(s.lifecycle('root'), ['session.failed']);
  assert.equal(s.events.find(e => e.event.type === 'session.failed').event.error.message, 'process exited');
  assert.equal(s.transports[0].calls.filter(call => call.method.startsWith('thread/')).length, 0, 'no thread is asked for after the failure');
  assert.equal(s.manager.snapshot('root'), undefined);
});

test('ordinary initialization rejection and normal live close retain their lifecycle', async t => {
  const s = await setup(t, (transport, index) => { if (index === 0) transport.initialize = async () => { throw new Error('bad config'); }; });
  await assert.rejects(s.manager.open('root', { cwd: s.root }), /bad config/);
  assert.equal(s.transports[0].closeCalls, 1);
  assert.deepEqual(s.lifecycle('root'), []);
  await s.manager.open('root', { cwd: s.root });
  await s.manager.close('root');
  assert.equal(s.transports[1].closeCalls, 1);
  assert.deepEqual(s.lifecycle('root'), ['session.opened', 'session.closed']);
});

test('a live nonpersistent transport failure ends its turn and emits failed then closed once', async t => {
  const s = await setup(t);
  await s.manager.open('root', { cwd: s.root });
  await s.manager.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Work' }] });
  s.transports[0].failure(new Error('process exited'));
  await until(() => s.lifecycle('root').includes('session.closed'));
  s.transports[0].failure(new Error('duplicate callback'));
  assert.equal(s.transports[0].closeCalls, 1);
  assert.deepEqual(s.lifecycle('root'), ['session.opened', 'session.failed', 'session.closed']);
  assert.deepEqual(s.events.filter(e => e.event.type === 'turn.ended').map(e => e.event.state), ['failed']);
});
