// Real controller + daemon delivery + durable receipts + runtime admission. Only provider I/O is
// scripted. The gate is before the pending receipt reaches disk, where an interrupt used to win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { initProject } from '@anhlp/alp-core/init';
import { Controller } from '../../apps/web/src/lib/controller.js';
import { fakeTransport } from '../support/fake-agent.js';

async function until(check, message) {
  for (let i = 0; i < 600; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(message);
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-stop-intent-'));
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'] } }));
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), runLogDir: path.join(directory, 'runs') });
  const store = createStore(path.join(directory, 'state'));
  const server = createDaemonServer({ runtime, store, socketPath: path.join(directory, 'd.sock'), version: 'test' });
  await server.listen();
  let controller;
  const held = [];
  t.after(async () => {
    for (const gate of held) gate.resolve();
    controller?.disconnect();
    owner.close();
    await server.close();
    await runtime.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = server.local();
  await owner.request('session.create', { sessionId: 'root', spec: { cwd: project } });
  await owner.request('session.attach', { sessionId: 'root' }); // Another viewer keeps idle work live across a drop.
  const links = [];
  const calls = [];
  const responses = [];
  let intercept;
  let opening;
  const open = async () => {
    if (opening) await opening;
    const messages = new Set(), closes = new Set();
    let ended = false;
    const connection = server.accept(frame => { if (frame.id !== undefined) responses.push(frame); queueMicrotask(() => { if (!ended) for (const listener of messages) listener(JSON.stringify(frame)); }); });
    const end = () => { if (ended) return; ended = true; connection.close(); for (const listener of closes) listener({ code: 1006 }); };
    const transport = {
      get state() { return ended ? 'closed' : 'open'; },
      send(frame) { const message = JSON.parse(frame); calls.push(message); queueMicrotask(async () => { if (await intercept?.(message)) return; connection.receive(message); }); },
      onMessage(fn) { messages.add(fn); return () => messages.delete(fn); },
      onClose(fn) { closes.add(fn); return () => closes.delete(fn); },
      close: end,
    };
    links.push({ end, connection });
    return { transport, principal: { id: 'test', label: 'test', permissions: ['session.read', 'session.write', 'project.read', 'project.write'], workspaces: [project], workspaceRoots: [{ path: project, canonical: project }] } };
  };
  controller = new Controller({ open, requestTimeoutMs: 50, releaseTimeoutMs: 50, stableMs: 1, backoff: { initialMs: 5, maxMs: 10, jitter: 0 }, sessionPollMs: 60_000, taskPollMs: 60_000 });
  const state = () => controller.getState();
  controller.connect({ url: 'http://127.0.0.1:7434', token: 'test' });
  await until(() => state().connection.phase === 'open', 'controller connected');
  controller.selectWorkspace(project);
  await until(() => state().sessions.status === 'ready', 'sessions ready');
  controller.selectSession('root');
  await until(() => state().tree?.status === 'attached', 'root attached');
  return { controller, state, runtime, store, agents, owner, calls, links, responses, pauseOpen(promise) { opening = promise; }, gate() { const gate = deferred(); held.push(gate); return gate; }, intercept(fn) { intercept = fn; } };
}

for (const stopAfterTimeout of [false, true]) for (const replay of [false, true]) {
  test(`receipt-gated Stop: click ${stopAfterTimeout ? 'after' : 'before'} 50ms timeout, replay=${replay}`, { timeout: 5_000 }, async t => {
    const w = await setup(t);
    const gate = w.gate();
    const putReceipt = w.store.putReceipt.bind(w.store);
    let gated = false;
    w.store.putReceipt = async (key, receipt) => { if (receipt.state === 'pending') { gated = true; await gate.promise; } return putReceipt(key, receipt); };
    const sending = w.controller.sendPrompt('delayed');
    await until(() => gated, 'pending receipt is gated');
    if (stopAfterTimeout) await sending;
    let settled = false;
    const stopping = w.controller.interrupt().then(() => { settled = true; });
    await sending;
    await new Promise(resolve => setTimeout(resolve, 10));
    const premature = settled;
    assert.equal(w.agents[0].started.length, 0, 'the provider has not seen the prompt');
    if (replay) {
      // Start the target while disconnected: reattachment must reconcile the same intent.
      w.links.at(-1).end();
      gate.resolve();
      await until(() => w.agents[0].started.length === 1, 'provider starts');
      await until(() => w.links.length > 1 && w.state().tree?.status === 'attached' && w.state().connection.phase === 'open', 'replay attached');
    } else gate.resolve();
    assert.equal(premature, false, 'Stop cannot acknowledge while the prompt may later run');
    await stopping;
    await until(() => !w.runtime.snapshot('root')?.activeTurnId, 'target canceled');
    assert.equal(w.agents[0].started.length, 1);
    assert.equal(w.calls.filter(call => call.method === 'session.prompt').length, 1, 'no prompt resend');
    assert.equal(w.agents[0].calls.filter(call => call.method === 'turn/interrupt').length, 1);
    assert.equal(w.state().busy.interrupt, false);
  });
}

test('a delayed conditional Stop cannot interrupt an unrelated later turn', { timeout: 5_000 }, async t => {
  const w = await setup(t);
  await w.controller.sendPrompt('first');
  await until(() => !!w.runtime.snapshot('root')?.activeTurnId, 'first turn');
  const first = w.runtime.snapshot('root').activeTurnId;
  const gate = w.gate();
  let seen = false;
  w.intercept(async message => { if (message.method === 'session.interrupt') { seen = true; await gate.promise; } });
  const stopping = w.controller.interrupt();
  await until(() => seen, 'conditional stop on wire');
  w.agents[0].finish('first completed');
  await until(() => !w.runtime.snapshot('root')?.activeTurnId, 'first ended');
  await w.owner.request('session.prompt', { sessionId: 'root', clientMessageId: 'unrelated', content: [{ type: 'text', text: 'next' }] });
  const next = w.runtime.snapshot('root').activeTurnId;
  assert.notEqual(next, first);
  gate.resolve();
  await stopping;
  await until(() => w.calls.some(call => call.method === 'session.interrupt'), 'stop sent');
  const request = w.calls.find(call => call.method === 'session.interrupt');
  await until(() => w.responses.some(frame => frame.id === request.id), 'conditional Stop answered');
  assert.equal(w.runtime.snapshot('root').activeTurnId, next);
  await w.runtime.interruptTurn('root', first).then(result => assert.equal(result, false));
  assert.equal(w.agents[0].calls.filter(call => call.method === 'turn/interrupt').length, 0);
});


test('a target that finished during the gap resolves on replay without stopping the next turn', { timeout: 5_000 }, async t => {
  const w = await setup(t);
  const receiptGate = w.gate();
  const reconnectGate = w.gate();
  const putReceipt = w.store.putReceipt.bind(w.store);
  let pending = false;
  w.store.putReceipt = async (key, receipt) => {
    if (receipt.clientMessageId !== 'later' && receipt.state === 'pending') { pending = true; await receiptGate.promise; }
    return putReceipt(key, receipt);
  };
  const sending = w.controller.sendPrompt('original');
  await until(() => pending, 'receipt gated');
  const stopping = w.controller.interrupt();
  await sending;
  w.pauseOpen(reconnectGate.promise);
  w.links.at(-1).end();
  receiptGate.resolve();
  await until(() => w.agents[0].started.length === 1, 'original started in gap');
  w.agents[0].finish('original completed in gap');
  await until(() => !w.runtime.snapshot('root').activeTurnId, 'original ended in gap');
  await w.owner.request('session.prompt', { sessionId: 'root', clientMessageId: 'later', content: [{ type: 'text', text: 'later' }] });
  const next = w.runtime.snapshot('root').activeTurnId;
  reconnectGate.resolve();
  await stopping;
  assert.equal(w.runtime.snapshot('root').activeTurnId, next);
  assert.equal(w.calls.filter(call => call.method === 'session.interrupt').length, 0);
});
