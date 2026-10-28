// Exercise the real facade create path and sole registry owner; fault only the daemon transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRegistry } from '@anhlp/alp-daemon/registry';
import { createAgents } from '../server/dist/paseo/agents.js';
import { createWorkspaces } from '../server/dist/paseo/workspaces.js';
import { createCreationReceipts } from '../server/dist/paseo/create-receipts.js';
import { writeAtomic } from '@anhlp/alp-core/atomic';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-create-retry-'));
  const cwd = path.join(home, 'project'); await mkdir(cwd);
  const registry = createRegistry(home), sessions = [], calls = [], frames = [];
  let fault, gate, journalWrite, active = true;
  const summary = id => ({ id, status: 'idle', projectRoot: cwd, agent: 'main', title: 'root', runtime: 'codex', model: 'test', mode: 'workspace-write', workflow: { mode: 'custom' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const request = async (method, params) => {
    calls.push({ method, params });
    if (gate?.method === method) { const held = gate; gate = undefined; held.enter(); await held.promise; }
    const faultMatches = () => fault && (fault.method === method || (method === 'registry.owner' && fault.method === params.operation));
    if (faultMatches() && !fault.after) { const held = fault; fault = undefined; throw held.error; }
    let result = {};
    if (method === 'registry.owner') result = { registry: await registry.snapshot(), ...(params.operation ? { result: await registry.mutate(params.operation, params.args, { requestId: params.requestId }) } : {}) };
    // Return the committed snapshot after the mutation, as alpd does.
    if (method === 'registry.owner') result.registry = await registry.snapshot();
    if (method === 'session.list') result = { sessions: structuredClone(sessions) };
    if (method === 'workspace.git.status') result = { state: 'not_repository' };
    if (method === 'question.list') result = { questions: [] };
    if (method === 'session.create') { const session = summary(params.sessionId); sessions.push(session); result = { session }; }
    if (method === 'session.prompt') result = { outcome: 'accepted' };
    if (faultMatches() && fault.after) { const held = fault; fault = undefined; throw held.error; }
    return result;
  };
  const connection = { closed: false, onEvent() {}, onClose() {}, close() {}, request };
  let agents, workspaces;
  const setup = () => {
    const receipts = createCreationReceipts(home, { write: async (...args) => { await writeAtomic(...args); if (journalWrite) await journalWrite(JSON.parse(args[1])); } });
    workspaces = createWorkspaces({ rpc: request, receipts, broadcast() {}, agents: () => agents.view, inDevelopment: async () => 'unsupported' });
    agents = createAgents({ home, receipts, clientFactory: async () => connection, directory: workspaces, broadcast() {} });
  };
  setup();
  t.after(async () => { await agents.close(); await workspaces.close(); await rm(home, { recursive: true, force: true }); });
  await agents.start();
  const client = { clientId: 'untrusted', emit: frame => frames.push(frame), assertActive() { if (!active) throw new Error('socket disconnected'); } };
  const send = (message, context = client) => agents.handlers.create_agent_request(message, context);
  const agentRequest = { type: 'create_agent_request', requestId: 'once', config: { provider: 'alp', cwd }, initialPrompt: 'hello' };
  const workspaceRequest = { type: 'workspace.create.request', requestId: 'workspace-once', idempotencyKey: 'workspace-key', source: { kind: 'directory', path: cwd }, agent: { config: { provider: 'alp', cwd }, initialPrompt: 'hello' } };
  return { home, cwd, get agents() { return agents; }, get workspaces() { return workspaces; }, registry, calls, sessions, frames, client, send, agentRequest, workspaceRequest,
    async restart() { await agents.close(); await workspaces.close(); setup(); await agents.start(); },
    onJournal(fn) { journalWrite = fn; }, active(value) { active = value; },
    fail(method, error, after = false) { fault = { method, error, after }; },
    hold(method) { let release, enter; const entered = new Promise(r => enter = r), promise = new Promise(r => release = r); gate = { method, promise, enter }; return { entered, release }; },
    count: method => calls.filter(c => c.method === method).length,
  };
}

test('sequential duplicate create replays the original agent without another session or first prompt', async t => {
  const f = await fixture(t);
  await f.send(f.agentRequest); await f.send(f.agentRequest);
  assert.equal(f.count('session.create'), 1);
  assert.equal(f.count('session.prompt'), 1);
  assert.equal(f.frames[0].payload.agentId, f.frames[1].payload.agentId);
});

test('concurrent duplicate create joins its in-flight attempt', async t => {
  const f = await fixture(t), held = f.hold('session.create');
  const first = f.send(f.agentRequest); await held.entered;
  const second = f.send(f.agentRequest); held.release(); await Promise.all([first, second]);
  assert.equal(f.count('session.create'), 1); assert.equal(f.count('session.prompt'), 1);
});

test('lost facade response can be replayed on a new socket without sending another prompt', async t => {
  const f = await fixture(t);
  await f.send(f.agentRequest, { ...f.client, emit() {} });
  await f.send(f.agentRequest);
  assert.equal(f.count('session.create'), 1); assert.equal(f.count('session.prompt'), 1);
  assert.equal(f.frames[0].payload.agentId, f.sessions[0].id);
});

test('the same request identity with different content is refused before mutations', async t => {
  const f = await fixture(t); await f.send(f.agentRequest);
  const answer = await f.send({ ...f.agentRequest, initialPrompt: 'different' });
  assert.match(answer?.payload.error ?? '', /different|conflict/i);
  assert.equal(f.count('session.create'), 1); assert.equal(f.count('session.prompt'), 1);
});

test('unknown session.create outcome is never automatically repeated', async t => {
  const f = await fixture(t); f.fail('session.create', new Error('connection lost'), true);
  const first = await f.send(f.agentRequest); const again = await f.send(f.agentRequest);
  assert.match(first.payload.error, /unknown|connection lost/i); assert.ok(again?.payload.error);
  assert.equal(f.count('session.create'), 1); assert.equal(f.count('session.prompt'), 0);
});

test('workspace initial agent retries a definite validation refusal in the original workspace', async t => {
  const f = await fixture(t);
  f.fail('session.create', Object.assign(new Error('spec rejected before create'), { code: -32602 }));
  const first = await f.workspaces.handlers['workspace.create.request'](f.workspaceRequest, f.client);
  assert.ok(first.payload.error);
  await f.restart();
  const again = await f.workspaces.handlers['workspace.create.request'](f.workspaceRequest, f.client);
  assert.equal(again.payload.error, null); assert.ok(again.payload.agent?.id);
  const registry = await f.registry.snapshot();
  // project registration creates its default workspace; the requested workspace is made once.
  assert.equal(registry.workspaces.filter(w => w.idempotencyKey === 'workspace-key').length, 1);
  assert.equal(f.count('session.prompt'), 1);
  assert.equal(f.calls.filter(c => c.method === 'session.create')[0].params.sessionId, f.calls.filter(c => c.method === 'session.create')[1].params.sessionId);
});

test('completed agent and workspace receipts replay and reject conflicting payloads across bridge restart', async t => {
  const f = await fixture(t); await f.send(f.agentRequest);
  const first = await f.workspaces.handlers['workspace.create.request'](f.workspaceRequest, f.client);
  assert.ok(first.payload.agent?.id);
  await f.restart();
  await f.send(f.agentRequest);
  const again = await f.workspaces.handlers['workspace.create.request']({ ...f.workspaceRequest, requestId: 'new-correlation' }, f.client);
  assert.equal(again.payload.requestId, 'new-correlation'); assert.equal(again.payload.agent.id, first.payload.agent.id);
  assert.equal(f.count('session.create'), 2); assert.equal(f.count('session.prompt'), 2);
  const conflict = await f.workspaces.handlers['workspace.create.request']({ ...f.workspaceRequest, title: 'changed' }, f.client);
  assert.match(conflict.payload.error, /conflict/);
  const agentConflict = await f.send({ ...f.agentRequest, initialPrompt: 'changed' });
  assert.match(agentConflict.payload.error, /conflict/);
  assert.equal(f.count('session.create'), 2);
  const disk = await readFile(path.join(f.home, 'state/paseo-create/receipts.json'), 'utf8');
  assert.ok(!disk.includes('hello')); assert.ok(!disk.includes('changed'));
});

for (const method of ['session.create', 'session.rename', 'session.prompt']) {
  test(`unknown ${method} outcome remains fenced after bridge restart`, async t => {
    const f = await fixture(t), request = { ...f.agentRequest, config: { ...f.agentRequest.config, title: 'title' } };
    f.fail(method, new Error('lost native answer'), true);
    assert.ok((await f.send(request))?.payload.error);
    const before = f.count(method); await f.restart();
    const again = await f.send(request);
    assert.match(again?.payload.error ?? '', /unknown/i); assert.equal(f.count(method), before);
    assert.equal(f.count('session.create'), 1);
  });
}

test('unknown workspace metadata result never dispatches a replacement or initial agent after restart', async t => {
  const f = await fixture(t);
  // Register the project first, then lose the workspace-create response.
  await f.workspaces.handlers.open_project_request({ type: 'open_project_request', requestId: 'open', cwd: f.cwd }, f.client);
  f.fail('workspace.create', new Error('lost workspace answer'), true);
  const first = await f.workspaces.handlers['workspace.create.request'](f.workspaceRequest, f.client);
  assert.ok(first.payload.error);
  await f.restart();
  const again = await f.workspaces.handlers['workspace.create.request'](f.workspaceRequest, f.client);
  assert.match(again.payload.error, /unknown/); assert.equal(f.count('session.create'), 0);
  assert.equal((await f.registry.snapshot()).workspaces.filter(w => w.idempotencyKey === 'workspace-key').length, 1);
});

test('a read failure after native creation resumes the unfinished workflow without another create', async t => {
  const f = await fixture(t); f.fail('session.list', new Error('read unavailable'));
  assert.ok((await f.send(f.agentRequest)).payload.error);
  await f.restart(); await f.send(f.agentRequest);
  assert.equal(f.count('session.create'), 1); assert.equal(f.count('session.prompt'), 1);
});

for (const kind of ['agent', 'workspace']) {
  test(`disconnect while persisting ${kind} write-ahead state cannot dispatch late creation`, async t => {
    const f = await fixture(t);
    f.onJournal(value => {
      if (Object.values(value.receipts).some(row => row.state.phase === (kind === 'agent' ? 'create_pending' : 'workspace_pending'))) { f.active(false); f.onJournal(undefined); }
    });
    const send = () => kind === 'agent' ? f.send(f.agentRequest) : f.workspaces.handlers['workspace.create.request'](f.workspaceRequest, f.client);
    assert.match((await send()).payload.error, /disconnected/);
    assert.equal(f.count('session.create'), 0);
    if (kind === 'workspace') assert.equal((await f.registry.snapshot()).workspaces.length, 0);
    f.active(true); await send(); assert.equal(f.count('session.create'), 1);
  });
}

async function journalFixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-create-journal-'));
  const stores = [];
  t.after(async () => { for (const store of stores) await store.close(); await rm(home, { recursive: true, force: true }); });
  return { home, file: path.join(home, 'state/paseo-create/receipts.json'), lock: path.join(home, 'state/paseo-create/writer.lock'),
    store(options) { const store = createCreationReceipts(home, options); stores.push(store); return store; } };
}

test('journal excludes concurrent writers, never reclaims malformed/stale locks, and drains before releasing', async t => {
  const f = await journalFixture(t), a = f.store(); let release, entered;
  const entry = new Promise(r => entered = r), held = new Promise(r => release = r);
  const first = a.run('test', 'key', {}, false, async () => { entered(); await held; }); await entry;
  const b = f.store(); await assert.rejects(b.run('test', 'key', {}, false, async () => assert.fail()), /writer lock exists/);
  let closed = false; const close = a.close().then(() => closed = true);
  await new Promise(r => setImmediate(r)); assert.equal(closed, false); release(); await first; await close;
  await writeFile(f.lock, '', { mode: 0o600 });
  const c = f.store(); await assert.rejects(c.run('test', 'another', {}, false, async () => assert.fail()), /writer lock exists/);
  assert.equal(await readFile(f.lock, 'utf8'), ''); await unlink(f.lock);
  const d = f.store(); await d.run('test', 'key', {}, false, async () => {});
});

test('failed atomic reservation/request writes authorize no mutation and retain the previous valid journal', async t => {
  const f = await journalFixture(t); let writes = 0, mutations = 0;
  const { writeAtomic } = await import('@anhlp/alp-core/atomic');
  const a = f.store({ write: async (...args) => { if (++writes === 2) throw new Error('disk fault'); return writeAtomic(...args); } });
  await assert.rejects(a.run('test', 'key', { secret: 'not-on-disk' }, false, async (_state, checkpoint) => { await checkpoint({ phase: 'create_pending' }); mutations++; }), /disk fault/);
  assert.equal(mutations, 0); assert.deepEqual(Object.values(JSON.parse(await readFile(f.file, 'utf8')).receipts)[0].state, {});
  assert.ok(!(await readFile(f.file, 'utf8')).includes('not-on-disk'));
});

test('corrupt journal is retained and blocks all creation, while recognized partial temps are removed', async t => {
  const f = await journalFixture(t), a = f.store(); await a.run('test', 'key', {}, false, async () => {}); await a.close();
  await writeFile(f.file, '{broken');
  const temp = `${f.file}.123.1234abcd.tmp`; await writeFile(temp, '{partial');
  const b = f.store(); await assert.rejects(b.run('test', 'new', {}, false, async () => assert.fail()), /cannot be read safely/);
  assert.equal(await readFile(f.file, 'utf8'), '{broken'); assert.ok(!(await readdir(path.dirname(f.file))).includes(path.basename(temp)));
});

test('unsupported journal versions fail closed without replacing existing bytes', async t => {
  const f = await journalFixture(t), a = f.store(); await a.run('test', 'key', {}, false, async () => {}); await a.close();
  const value = JSON.parse(await readFile(f.file, 'utf8')); value.version = 99;
  const text = JSON.stringify(value); await writeFile(f.file, text);
  const b = f.store(); await assert.rejects(b.run('test', 'new', {}, false, async () => assert.fail()), /Unsupported/);
  assert.equal(await readFile(f.file, 'utf8'), text);
});

test('journal capacity refuses new identities without evicting completed/uncertain keys', async t => {
  const f = await journalFixture(t), a = f.store({ limit: 1 });
  await a.run('test', 'key', {}, false, async (_state, checkpoint) => checkpoint({ phase: 'create_pending' }));
  await assert.rejects(a.run('test', 'other', {}, false, async () => assert.fail()), /full/);
  assert.equal(await a.run('test', 'key', {}, false, async state => state.phase), 'create_pending');
});

test('a process killed after its requested checkpoint leaves a durable barrier and requires lock-only recovery', { skip: process.platform === 'win32' }, async t => {
  const f = await journalFixture(t);
  const module = pathToFileURL(path.resolve('integrations/paseo/server/dist/paseo/create-receipts.js')).href;
  const script = `import {createCreationReceipts} from ${JSON.stringify(module)}; const store=createCreationReceipts(process.env.ALP_HOME); await store.run('test','crash',{},false,async(_,checkpoint)=>{await checkpoint({phase:'create_pending',sessionId:'reserved'}); process.kill(process.pid,'SIGKILL');});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, ALP_HOME: f.home }, encoding: 'utf8', timeout: 10000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  const blocked = f.store(); await assert.rejects(blocked.run('test', 'crash', {}, false, async () => assert.fail()), /writer lock exists/);
  // The disposable writer has exited and no other facade owns this test home.
  await unlink(f.lock);
  const recovered = f.store();
  assert.equal(await recovered.run('test', 'crash', {}, false, async state => state.phase), 'create_pending');
  assert.equal(Object.keys(JSON.parse(await readFile(f.file, 'utf8')).receipts).length, 1);
});
