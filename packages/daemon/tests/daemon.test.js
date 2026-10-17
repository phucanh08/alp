import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpath as realpathOf } from 'node:fs/promises';
import { initProject } from '@anhlp/alp-core/init';
import { connect, daemonPaths, ensureDaemon, findDaemonEntry, readLock, PROTOCOL_VERSION } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';

async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

function fakeTransport(runtimes) {
  return () => {
    const index = runtimes.length;
    const runtime = {
      calls: [], closed: false, threadId: `thread-${index}`, turnId: `turn-${index}`,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { await this.hold; return { turn: { id: this.turnId } }; }
        return {};
      },
      call(tool, args) {
        return this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}`, namespace: null, tool, arguments: args });
      },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function setup(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-'));
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'] } }));
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes) });
  const socketPath = daemonPaths(directory).socket;
  const server = createDaemonServer({ runtime, socketPath, version: 'test' });
  await server.listen();
  t.after(async () => { await server.close(); await runtime.shutdown(); });
  // After hooks run in the order they are added: remove the files only once that has stopped.
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clients = [];
  const open = async () => {
    const client = await connect(socketPath, { name: 'test', version: '0' });
    const events = [];
    client.onEvent(envelope => events.push(envelope));
    clients.push(client);
    return { client, events };
  };
  t.after(() => clients.forEach(client => client.close()));
  return { project, runtimes, runtime, socketPath, server, open };
}

const types = (events, sessionId) => events.filter(e => !sessionId || e.sessionId === sessionId).map(e => e.event.type);
const text = body => [{ type: 'text', text: body }];

test('handshake is required and versioned', async t => {
  const { socketPath } = await setup(t);
  const { AlpClient } = await import('@anhlp/alp-client');
  const net = await import('node:net');
  const raw = new AlpClient(net.createConnection(socketPath));
  t.after(() => raw.close());
  await assert.rejects(raw.request('session.list'), { code: 1006 });
  await assert.rejects(raw.request('daemon.hello', { protocolVersion: PROTOCOL_VERSION + 1 }), { code: 1006 });
  const hello = await raw.request('daemon.hello', { protocolVersion: PROTOCOL_VERSION });
  assert.equal(hello.protocolVersion, PROTOCOL_VERSION);
  // The machine name, as Paseo's hello carries it (patch 0017): clients label the host with it.
  assert.equal(hello.hostname, hostname());
  await assert.rejects(raw.request('session.nope'), { code: -32601 });
  await assert.rejects(raw.request('session.get', { sessionId: 'missing' }), { code: 1001 });
});

// The in-process connection a host hands to an embedded integration (main.ts, tests) must tear down
// like the socket client: in-flight requests fail, onClose listeners run once, and later requests
// fail rather than hanging. A bridge relies on onClose to notice a lost daemon connection.
test('a local connection rejects in-flight requests and fires onClose exactly once on close', async t => {
  const { server } = await setup(t);
  server.extend('test.never', () => new Promise(() => {}));
  const connection = server.local();
  const closes = [];
  connection.onClose(error => closes.push(error));

  const inFlight = connection.request('test.never', {});
  await new Promise(resolve => setTimeout(resolve, 20));
  connection.close();

  await assert.rejects(inFlight, /connection closed/);
  assert.equal(closes.length, 1, 'onClose fires once');
  assert.match(closes[0].message, /connection closed/);

  connection.close();
  assert.equal(closes.length, 1, 'a second close does not fire onClose again');
  await assert.rejects(connection.request('daemon.hello', {}), /connection closed/);
});

test('a client creates, prompts and receives the events of its whole tree over the socket', async t => {
  const { project, runtimes, open } = await setup(t);
  const { client, events } = await open();
  const { session } = await client.request('session.create', { spec: { cwd: project, persist: true } });
  assert.match(session.id, /^ses_[0-9a-f]{16}$/);
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Delegate') });
  const lead = runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Investigate' });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  runtimes[1].finish('lead proof');
  assert.equal(JSON.parse((await lead).contentItems[0].text).output, 'lead proof');
  await until(() => events.some(e => e.event.type === 'session.closed'));
  const child = events.find(e => e.event.type === 'session.opened' && e.event.session.parentId === session.id);
  assert.ok(child, 'child events reach the root client');
  assert.deepEqual(types(events, child.sessionId).slice(0, 3), ['session.opened', 'session.ready', 'item']);
  assert.deepEqual(types(events, session.id).slice(0, 6), ['session.opened', 'session.ready', 'item', 'session.updated', 'prompt.accepted', 'turn.started']);
  const listed = await client.request('session.list');
  assert.deepEqual(listed.sessions.map(s => s.id), [session.id]);
});

test('a root keeps working after its client leaves and closes once idle', async t => {
  const { project, runtimes, runtime, open } = await setup(t);
  const first = await open();
  const { session } = await first.client.request('session.create', { sessionId: 'paseo-1', spec: { cwd: project } });
  await first.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Work') });
  first.client.close();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(runtime.snapshot('paseo-1').busy, true);

  // A viewer reopening the same root attaches to the running work instead of starting over.
  const second = await open();
  const reopened = await second.client.request('session.create', { sessionId: 'paseo-1', spec: { cwd: project }, history: 'replay' });
  assert.equal(reopened.attached, true);
  assert.deepEqual(types(second.events), ['session.opened', 'item', 'session.ready', 'turn.started']);
  assert.equal(runtimes.length, 1);

  assert.deepEqual(await second.client.request('session.release', { sessionId: 'paseo-1' }), { closed: false });
  runtimes[0].finish();
  await until(() => runtimes[0].closed);
  assert.equal(runtime.snapshot('paseo-1'), undefined);
});

test('an idle released root closes at once; attach replays the retained tree', async t => {
  const { project, runtimes, open } = await setup(t);
  const { client } = await open();
  const watcher = await open();
  const { session } = await client.request('session.create', { spec: { cwd: project } });
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hi') });
  runtimes[0].finish('hello');
  await watcher.client.request('session.attach', { sessionId: session.id });
  assert.deepEqual(types(watcher.events), ['session.opened', 'session.ready', 'item', 'session.updated', 'prompt.accepted', 'turn.started', 'item', 'turn.ended']);
  await watcher.client.request('session.release', { sessionId: session.id });
  assert.deepEqual(await client.request('session.release', { sessionId: session.id }), { closed: true });
  assert.equal(runtimes[0].closed, true);
});

// t-7679.11: a prompt may carry inline images, which reach Codex as data URLs; never a host path.
test('session.prompt takes inline images within the limits and passes them to the runtime', async t => {
  const { project, runtimes, open } = await setup(t);
  const { client, events } = await open();
  assert.ok((await client.request('daemon.hello', { protocolVersion: PROTOCOL_VERSION })).capabilities.includes('prompt.images'));
  const { session } = await client.request('session.create', { spec: { cwd: project } });
  assert.equal(session.promptImages, true);
  const png = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=', name: 'shot.png' };
  const prompt = (id, content) => client.request('session.prompt', { sessionId: session.id, clientMessageId: id, content });
  const refused = async (id, content, pattern) => {
    await assert.rejects(prompt(id, content), error => error.code === -32602 && pattern.test(error.message));
  };
  await refused('p1', [{ ...png, path: '/etc/passwd' }], /content/);
  await refused('p2', [{ ...png, url: 'file:///etc/passwd' }], /content/);
  const failed = async (id, content, pattern) => {
    await prompt(id, content);
    await until(() => events.some(e => e.event.type === 'prompt.failed' && e.event.clientMessageId === id));
    assert.match(events.find(e => e.event.type === 'prompt.failed' && e.event.clientMessageId === id).event.error.message, pattern);
  };
  await failed('p3', [{ type: 'localImage', path: '/etc/passwd' }], /Only text and image prompts/);
  await refused('p4', [{ ...png, mimeType: 'image/svg+xml' }], /content/);
  await refused('p5', Array.from({ length: 9 }, () => png), /at most 8 images/);
  await refused('p6', [{ ...png, data: 'A'.repeat(6990508) }], /at most 5242880 bytes/);
  // Three of 3.75 MiB pass one by one but not together (11 MiB), and still fit one 16 MiB frame.
  await refused('p7', Array.from({ length: 3 }, () => ({ ...png, data: 'A'.repeat(5 * 1024 * 1024) })), /at most 11534336 bytes together/);
  assert.equal(runtimes[0].calls.filter(c => c.method === 'turn/start').length, 0);
  await prompt('m1', [...text('What is this?'), png]);
  const input = runtimes[0].calls.find(c => c.method === 'turn/start').params.input;
  assert.deepEqual(input.at(-1), { type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=' });
  assert.equal(input.at(-2).text, 'What is this?');
  const message = events.map(e => e.event).find(e => e.type === 'item' && e.item.kind === 'user_message');
  assert.equal(message.item.images, 1);
  assert.equal(JSON.stringify(events).includes('iVBORw0KGgo'), false, 'image data is not replayed in events');
  runtimes[0].finish();
  // A runtime that takes no images refuses them before anything is sent.
  runtimes[0].takesImages = () => false;
  await until(() => events.some(e => e.event.type === 'turn.ended'));
  assert.equal((await client.request('session.get', { sessionId: session.id })).session.promptImages, undefined);
  await failed('m2', [png], /takes no images/);
  assert.equal(runtimes[0].calls.filter(c => c.method === 'turn/start').length, 1);
});

test('alpd starts detached, publishes its socket in the lock, and shuts down cleanly', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
  const socket = await ensureDaemon({ home, entry });
  const lock = await readLock(home);
  assert.equal(lock.ready, true);
  assert.equal(lock.socket, daemonPaths(home).socket);
  assert.equal(socket, lock.socket);
  assert.equal(await ensureDaemon({ home, entry }), socket, 'a second start reuses the running daemon');
  const client = await connect(socket);
  const status = await client.request('daemon.status');
  assert.equal(status.pid, lock.pid);
  assert.equal(status.sessions, 0);
  assert.equal(JSON.parse(await readFile(daemonPaths(home).install, 'utf8')).entry, entry, 'alpd records where it is installed');
  await client.request('daemon.shutdown');
  client.close();
  await until(async () => !(await readLock(home)));
  await assert.rejects(connect(socket), 'a stopped daemon no longer accepts connections');

  // A client that cannot locate alpd (the Paseo plugin) starts it from the recorded location.
  const restarted = await ensureDaemon({ home, env: { ...process.env, PATH: '' } });
  const again = await connect(restarted);
  await again.request('daemon.shutdown');
  again.close();
  await until(async () => !(await readLock(home)));
});

test('alpd tells a clean stop from a crash by the marker it keeps while running', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const entry = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
  const marker = path.join(home, 'state', 'alpd.running');
  const status = async () => {
    const client = await connect(await ensureDaemon({ home, entry }));
    try { return await client.request('daemon.status'); } finally { client.close(); }
  };
  assert.deepEqual((await status()).previousExit, { kind: 'clean' });
  assert.equal(JSON.parse(await readFile(marker, 'utf8')).pid, (await readLock(home)).pid);
  const client = await connect((await readLock(home)).socket);
  await client.request('daemon.shutdown');
  client.close();
  await until(async () => !(await readLock(home)));
  await assert.rejects(access(marker), 'a clean stop removes the marker last');

  assert.deepEqual((await status()).previousExit, { kind: 'clean' });
  // The alpd of this test's own home, killed as a crash would.
  const { pid } = await readLock(home);
  assert.equal(JSON.parse(await readFile(marker, 'utf8')).pid, pid);
  process.kill(pid, 'SIGKILL');
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
  const after = await status();
  assert.equal(after.previousExit.kind, 'crash');
  assert.ok(Date.parse(after.previousExit.at) > 0);
  const last = await connect((await readLock(home)).socket);
  await last.request('daemon.shutdown');
  last.close();
  await until(async () => !(await readLock(home)));
});

test('finds alpd through the ALP CLI on PATH', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'lib', 'alp');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'dist'));
  await mkdir(path.join(directory, 'bin'));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: '@anhlp/alp' }));
  await writeFile(path.join(root, 'src', 'cli.js'), '');
  await writeFile(path.join(root, 'dist', 'alpd.js'), '');
  await symlink(path.join(root, 'src', 'cli.js'), path.join(directory, 'bin', 'alp'));
  const home = path.join(directory, 'home');
  assert.equal(await findDaemonEntry({ home, env: { PATH: path.join(directory, 'bin') } }), await realpathOf(path.join(root, 'dist', 'alpd.js')));
  assert.equal(await findDaemonEntry({ home, env: { PATH: path.join(directory, 'bin') }, candidates: [undefined, path.join(root, 'src', 'cli.js')] }), path.join(root, 'src', 'cli.js'));
});

/** A daemon over a durable store; `stop(false)` abandons it without a clean shutdown, like a crash. */
async function durable(t, directory, project, runtimes) {
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), runLogDir: path.join(directory, 'runs') });
  const store = createStore(path.join(directory, 'state'));
  const home = path.join(directory, `d${runtimes.length}`);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const socketPath = daemonPaths(home).socket;
  const server = createDaemonServer({ runtime, socketPath, version: 'test', store, runLogDir: path.join(directory, 'runs') });
  await server.listen();
  const client = await connect(socketPath);
  const events = [];
  client.onEvent(envelope => events.push(envelope));
  let stopped = false;
  const stop = async (clean = true) => {
    if (stopped) return;
    stopped = true;
    client.close();
    if (clean) { await server.close(); await runtime.shutdown(); } else { await store.flush(); await server.close(); }
  };
  cleanupsOf(t).push(async () => { await stop(); await runtime.shutdown(); await store.flush(); });
  return { client, events, store, stop };
}

/** Teardown in reverse order, so daemons stop before their directory is removed. */
const cleanups = new WeakMap();
const cleanupsOf = t => {
  if (!cleanups.has(t)) {
    cleanups.set(t, []);
    t.after(async () => { for (const cleanup of cleanups.get(t).reverse()) await cleanup(); });
  }
  return cleanups.get(t);
};

async function durableProject(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-'));
  cleanupsOf(t).push(() => rm(directory, { recursive: true, force: true }));
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'] } }));
  return { directory, project };
}

test('sessions survive a daemon restart and resume with their history', async t => {
  const { directory, project } = await durableProject(t);
  const runtimes = [];
  const first = await durable(t, directory, project, runtimes);
  const { session } = await first.client.request('session.create', { spec: { cwd: project, persist: true } });
  await first.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Remember ORCHID') });
  runtimes[0].finish('Noted');
  await until(() => first.events.some(e => e.event.type === 'turn.ended'));
  await first.stop();

  const second = await durable(t, directory, project, runtimes);
  const { sessions } = await second.client.request('session.list', { includeClosed: true });
  assert.deepEqual(sessions.map(s => [s.id, s.status, s.title]), [[session.id, 'closed', 'Remember ORCHID']]);
  const resumed = await second.client.request('session.create', { sessionId: session.id, spec: { cwd: project }, history: 'replay' });
  assert.equal(resumed.resumed, true);
  const resumeCall = runtimes[1].calls.find(c => c.method === 'thread/resume');
  assert.equal(resumeCall.params.threadId, 'thread-0');
  const replayed = second.events.filter(e => e.event.type === 'item').map(e => e.event.item.text);
  assert.deepEqual(replayed, ['Remember ORCHID', 'Noted']);
  assert.equal((await second.client.request('session.get', { sessionId: session.id })).session.status, 'idle');
});

test('after a crash the next daemon reopens a root that was working; an assignment it cannot continue fails', async t => {
  const { directory, project } = await durableProject(t);
  const runtimes = [];
  const first = await durable(t, directory, project, runtimes);
  const { session } = await first.client.request('session.create', { spec: { cwd: project, persist: true } });
  await first.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Delegate') });
  void runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Work' });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start') && first.events.some(e => e.event.type === 'session.opened' && e.event.session.parentId));
  const child = first.events.find(e => e.event.type === 'session.opened' && e.event.session.parentId).sessionId;
  await first.stop(false);

  // This runtime keeps running assignments in memory only, so the lead cannot continue.
  const before = runtimes.length;
  const second = await durable(t, directory, project, runtimes);
  await until(() => runtimes[before]?.calls.some(c => c.method === 'turn/start'));
  const reopened = runtimes[before];
  assert.equal(reopened.calls[0].method, 'thread/resume');
  assert.match(reopened.calls.find(c => c.method === 'turn/start').params.input.at(-1).text, /alpd restarted during your turn, and reopened this session\. Continue the user's request/);
  const { sessions } = await second.client.request('session.list', { includeClosed: true });
  assert.equal(sessions.find(s => s.id === session.id).status, 'running');
  assert.equal(sessions.find(s => s.id === child).status, 'closed');
  const runLog = (await readFile(path.join(directory, 'runs', `${session.id}.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(runLog.some(entry => entry.event === 'assignment.finished' && entry.assignmentId === child && entry.status === 'failed' && entry.reconciled));
  const timeline = await second.store.timeline(session.id);
  assert.ok(timeline.some(e => e.sessionId === session.id && e.event.type === 'turn.ended' && e.event.state === 'failed'));
  // A client opening it attaches to the reopened root.
  assert.equal((await second.client.request('session.create', { sessionId: session.id, spec: { cwd: project } })).attached, true);
});

test('closed trees older than 30 days are pruned at startup', async t => {
  const { directory, project } = await durableProject(t);
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  const store = createStore(path.join(directory, 'state'));
  await store.put({ version: 1, id: 'old-root', rootId: 'old-root', status: 'closed', createdAt: old, updatedAt: old });
  await store.put({ version: 1, id: 'recent', rootId: 'recent', status: 'closed', createdAt: old, updatedAt: new Date().toISOString() });
  await store.append('old-root', { sessionId: 'old-root', epoch: 'e', seq: 1, ts: old, event: { type: 'session.ready' } });
  await store.flush();
  // Its file was written when its record says; a file written now would be a restored tree (ALPD §68).
  await utimes(path.join(directory, 'state', 'sessions', 'old-root.json'), new Date(old), new Date(old));
  const runtimes = [];
  const daemon = await durable(t, directory, project, runtimes);
  const { sessions } = await daemon.client.request('session.list', { includeClosed: true });
  assert.deepEqual(sessions.map(s => s.id), []);
  assert.deepEqual((await store.list()).map(r => r.id), ['recent']);
  assert.deepEqual(await store.timeline('old-root'), []);
});

test('resumed history replays a grandchild while its parent is open', async t => {
  const { directory, project } = await durableProject(t);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'], lead: ['peer'] } }));
  const runtimes = [];
  const first = await durable(t, directory, project, runtimes);
  const { session } = await first.client.request('session.create', { spec: { cwd: project, persist: true } });
  await first.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Delegate') });
  const lead = runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Work' });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const peer = runtimes[1].call('alp_delegate', { agent: 'peer', wait: true, task: 'Work' });
  await until(() => runtimes[2]?.calls.some(c => c.method === 'turn/start'));
  runtimes[2].finish('peer done');
  await peer;
  runtimes[1].finish('lead done');
  await lead;
  runtimes[0].finish('main done');
  await until(() => first.events.some(e => e.sessionId === session.id && e.event.type === 'turn.ended'));
  await first.stop();

  const second = await durable(t, directory, project, runtimes);
  await second.client.request('session.create', { sessionId: session.id, spec: { cwd: project }, history: 'replay' });
  const open = new Set([session.id]);
  for (const { sessionId, event } of second.events) {
    if (event.type === 'session.opened' && event.session.parentId) assert.ok(open.has(event.session.parentId), `${event.session.agent} opened after its parent closed`);
    if (event.type === 'session.opened') open.add(sessionId);
    if (event.type === 'session.closed') open.delete(sessionId);
  }
  assert.deepEqual(second.events.filter(e => e.event.type === 'session.opened').map(e => e.event.session.agent), ['main', 'lead', 'peer']);
});

test('a clientMessageId is delivered once; reuse with other content conflicts', async t => {
  const { directory, project } = await durableProject(t);
  const runtimes = [];
  const daemon = await durable(t, directory, project, runtimes);
  const { session } = await daemon.client.request('session.create', { spec: { cwd: project, persist: true } });
  const prompt = content => daemon.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content });
  const [first, again] = await Promise.all([prompt(text('Hello')), prompt(text('Hello'))]);
  assert.deepEqual([first, again], [{ outcome: 'accepted', durable: true }, { outcome: 'accepted', duplicate: true, durable: true }]);
  assert.equal(runtimes[0].calls.filter(c => c.method === 'turn/start').length, 1);
  await assert.rejects(prompt(text('Other')), error => error.code === 1004 && error.data?.reason === 'key_conflict');
});

test('a prompt cut off by a crash answers outcome unknown instead of sending twice', async t => {
  const { directory, project } = await durableProject(t);
  const runtimes = [];
  const first = await durable(t, directory, project, runtimes);
  const { session } = await first.client.request('session.create', { spec: { cwd: project, persist: true } });
  let release;
  runtimes[0].hold = new Promise(resolve => { release = resolve; });
  try {
    const cut = first.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') }).catch(error => error);
    await until(() => runtimes[0].calls.some(c => c.method === 'turn/start'));
    await first.stop(false);
    await cut;

    const second = await durable(t, directory, project, runtimes);
    await second.client.request('session.create', { sessionId: session.id, spec: { cwd: project } });
    const resent = second.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Hello') });
    await assert.rejects(resent, error => error.code === 1004 && error.data?.reason === 'outcome_unknown');
    assert.equal(runtimes.at(-1).calls.filter(c => c.method === 'turn/start').length, 0);
    await second.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('Hello') });
    assert.equal(runtimes.at(-1).calls.filter(c => c.method === 'turn/start').length, 1);
  } finally {
    release();
  }
});


// Paseo names an agent from its first message (server/agent/create-agent-title.ts at b63a325): the
// first non-blank line, whitespace folded, at most 60 characters, no ellipsis. Every viewer hears it.
test('a root is named after its first prompt, as Paseo names an agent, and every attached viewer hears it', async t => {
  const { project, runtimes, open } = await setup(t);
  const { client, events } = await open();
  const watcher = await open();
  const { session } = await client.request('session.create', { spec: { cwd: project, persist: true } });
  await watcher.client.request('session.attach', { sessionId: session.id });
  const first = `\n   \n  Fix   the\tlogin ${'é'.repeat(70)}  \nsecond line`;
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text(first) });
  const title = `Fix the login ${'é'.repeat(46)}`;
  assert.equal([...title].length, 60);
  const named = list => list.find(e => e.event.type === 'session.updated' && e.event.session.title);
  await until(() => named(events) && named(watcher.events));
  for (const seen of [events, watcher.events]) {
    const update = named(seen);
    assert.equal(update.sessionId, session.id);
    assert.equal(update.event.session.title, title);
    assert.equal(update.event.session.id, session.id);
    // After the message it names, so a viewer that drops older cursors still keeps the message.
    const message = seen.find(e => e.event.type === 'item' && e.event.item.kind === 'user_message');
    assert.ok(update.cursor > message.cursor, 'the title follows its message');
  }
  assert.equal((await client.request('session.get', { sessionId: session.id })).session.title, title);
  runtimes[0].finish('ok');
  await until(() => events.some(e => e.event.type === 'turn.ended'));
  // Only the first message names it.
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('Something else') });
  await until(() => events.filter(e => e.event.type === 'item' && e.event.item.kind === 'user_message').length === 2);
  assert.equal((await client.request('session.get', { sessionId: session.id })).session.title, title);
  assert.equal(events.filter(e => e.event.type === 'session.updated' && e.event.session.title).length, 1);
  // A name the user gives is announced the same way.
  await client.request('session.rename', { sessionId: session.id, title: 'Login fix' });
  await until(() => watcher.events.some(e => e.event.type === 'session.updated' && e.event.session.title === 'Login fix'));
});

test('a root named before its first prompt keeps that name', async t => {
  const { project, open } = await setup(t);
  const { client, events } = await open();
  const { session } = await client.request('session.create', { spec: { cwd: project, persist: true } });
  await client.request('session.rename', { sessionId: session.id, title: 'Chosen' });
  await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Fix the login') });
  await until(() => events.some(e => e.event.type === 'item' && e.event.item.kind === 'user_message'));
  assert.equal((await client.request('session.get', { sessionId: session.id })).session.title, 'Chosen');
});

test('a root is renamed and archived, and archived ones are listed only when asked', async t => {
  const { project, open } = await setup(t);
  const { client } = await open();
  const { session } = await client.request('session.create', { spec: { cwd: project, persist: true } });
  const listed = async params => (await client.request('session.list', { rootsOnly: true, includeClosed: true, ...params })).sessions.map(row => [row.id, row.title, !!row.archived]);
  assert.equal((await client.request('session.rename', { sessionId: session.id, title: '  Fix   the login  ' })).session.title, 'Fix the login');
  await assert.rejects(client.request('session.rename', { sessionId: session.id, title: ' ' }), { code: -32602 });
  await assert.rejects(client.request('session.rename', { sessionId: 'missing', title: 'x' }), /No session missing/);
  const archived = (await client.request('session.archive', { sessionId: session.id })).session;
  assert.deepEqual([archived.archived, archived.status], [true, 'closed']);
  assert.deepEqual(await listed(), []);
  assert.deepEqual(await listed({ includeArchived: true }), [[session.id, 'Fix the login', true]]);
  await client.request('session.archive', { sessionId: session.id, archived: false });
  assert.deepEqual(await listed(), [[session.id, 'Fix the login', false]]);
});

test('session.list pages with a keyset cursor and searches titles on the daemon', async t => {
  const { project, open } = await setup(t);
  const { client } = await open();
  const hello = await client.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(hello.capabilities.includes('session.list.page'));
  const ids = [];
  for (const title of ['Fix the login', 'Write docs', 'Fix the logout', 'Ship it', 'Review login page']) {
    const { session } = await client.request('session.create', { spec: { cwd: project, persist: true } });
    await client.request('session.rename', { sessionId: session.id, title });
    ids.push(session.id);
    await new Promise(resolve => setTimeout(resolve, 3));
  }
  const all = (await client.request('session.list', { rootsOnly: true, includeClosed: true })).sessions.map(row => row.id);
  assert.deepEqual(all, [...ids].reverse(), 'newest first');
  // Without paging params the answer is the whole list with no cursor, as before.
  assert.equal((await client.request('session.list', { rootsOnly: true })).nextCursor, undefined);
  const pages = [];
  let cursor;
  do {
    const page = await client.request('session.list', { rootsOnly: true, includeClosed: true, limit: 2, ...(cursor ? { cursor } : {}) });
    assert.ok(page.sessions.length <= 2);
    pages.push(page.sessions.map(row => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(pages.map(page => page.length), [2, 2, 1]);
  assert.deepEqual(pages.flat(), all, 'pages join into the list without gaps or repeats');
  // A page that ends the list exactly has no cursor.
  assert.equal((await client.request('session.list', { rootsOnly: true, limit: 5 })).nextCursor, undefined);
  // Search: every word, case-folded, in the title or the id; with paging.
  const found = await client.request('session.list', { rootsOnly: true, query: '  LOGIN  fix ', limit: 1 });
  assert.deepEqual(found.sessions.map(row => row.title), ['Fix the login']);
  assert.equal(found.nextCursor, undefined);
  const login = await client.request('session.list', { rootsOnly: true, query: 'login', limit: 1 });
  assert.deepEqual(login.sessions.map(row => row.title), ['Review login page']);
  const rest = await client.request('session.list', { rootsOnly: true, query: 'login', limit: 1, cursor: login.nextCursor });
  assert.deepEqual([rest.sessions.map(row => row.title), rest.nextCursor], [['Fix the login'], undefined]);
  assert.deepEqual((await client.request('session.list', { query: ids[1] })).sessions.map(row => row.id), [ids[1]]);
  // projectRoots: any of several projects, paged among them only.
  assert.equal((await client.request('session.list', { projectRoots: ['/elsewhere', project], limit: 10 })).sessions.length, 5);
  assert.deepEqual(await client.request('session.list', { projectRoots: ['/elsewhere'], limit: 1 }), { sessions: [] });
  await assert.rejects(client.request('session.list', { cursor: 'not-a-cursor' }), { code: -32602 });
  await assert.rejects(client.request('session.list', { limit: 0 }), { code: -32602 });
});

test('question.watch tells a connection of questions in trees it is not attached to', async t => {
  const { project, runtimes, open } = await setup(t);
  const owner = await open();
  const watcher = await open();
  const other = await open();
  const { session } = await owner.client.request('session.create', { spec: { cwd: project, persist: true } });
  assert.ok((await watcher.client.request('daemon.hello', { protocolVersion: 1 })).capabilities.includes('question.watch'));
  assert.deepEqual(await watcher.client.request('question.watch', { projectRoot: project }), { questions: [] });
  await other.client.request('question.watch', { projectRoot: path.join(project, 'elsewhere') });
  await owner.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Ask me') });
  const asked = runtimes[0].call('alp_ask', { question: 'Go on?', to: 'user' });
  await until(() => watcher.events.some(e => e.event.type === 'question'));
  const question = watcher.events.find(e => e.event.type === 'question');
  assert.equal(question.sessionId, session.id);
  assert.equal(question.event.question.body, 'Go on?');
  assert.equal(question.cursor, undefined, 'not part of a timeline the watcher replays');
  const kept = owner.events.find(e => e.event.type === 'question');
  assert.equal(typeof kept.cursor, 'number', 'the attached client still gets the kept envelope');
  assert.equal(owner.events.filter(e => e.event.type === 'question').length, 1);
  // A watcher that calls again gets what waits now.
  assert.deepEqual((await watcher.client.request('question.watch', { projectRoot: project })).questions.map(q => q.id), [question.event.question.id]);
  await owner.client.request('question.answer', { questionId: question.event.question.id, text: 'yes' });
  await asked;
  await until(() => watcher.events.some(e => e.event.type === 'question.resolved'));
  assert.equal(watcher.events.find(e => e.event.type === 'question.resolved').event.questionId, question.event.question.id);
  // A watcher attached to the tree is told once, by its attachment.
  runtimes[0].finish();
  await until(() => owner.events.some(e => e.event.type === 'turn.ended'));
  await watcher.client.request('session.attach', { sessionId: session.id, replay: false });
  await owner.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('Ask again') });
  await until(() => owner.events.filter(e => e.event.type === 'turn.started').length === 2);
  void runtimes[0].call('alp_ask', { question: 'Again?', to: 'user' });
  await until(() => watcher.events.some(e => e.event.type === 'question' && e.event.question.body === 'Again?' && e.cursor !== undefined));
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(watcher.events.filter(e => e.event.type === 'question' && e.event.question.body === 'Again?').length, 1);
  assert.equal(other.events.filter(e => e.event.type.startsWith('question')).length, 0, 'another project hears nothing');
});

test('question.watch with turns tells a connection when a root it is not attached to ends a turn', async t => {
  const { project, runtimes, open } = await setup(t);
  const owner = await open();
  const watcher = await open();
  const plain = await open();
  const other = await open();
  const { session } = await owner.client.request('session.create', { spec: { cwd: project, persist: true } });
  assert.ok((await watcher.client.request('daemon.hello', { protocolVersion: 1 })).capabilities.includes('question.watch.turns'));
  await watcher.client.request('question.watch', { projectRoot: project, turns: true });
  await plain.client.request('question.watch', { projectRoot: project });
  await other.client.request('question.watch', { projectRoot: path.join(project, 'elsewhere'), turns: true });
  await owner.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('Delegate') });
  // A child's turn end is not the root's: no copy.
  const lead = runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Investigate' });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  runtimes[1].finish('lead proof');
  await lead;
  await until(() => owner.events.some(e => e.event.type === 'turn.ended' && e.sessionId !== session.id));
  runtimes[0].finish();
  await until(() => watcher.events.some(e => e.event.type === 'turn.ended'));
  await new Promise(resolve => setTimeout(resolve, 20));
  const ended = watcher.events.filter(e => e.event.type === 'turn.ended');
  assert.equal(ended.length, 1, 'only the root\'s turn end');
  assert.equal(ended[0].sessionId, session.id);
  assert.equal(ended[0].event.state, 'completed');
  assert.equal(ended[0].cursor, undefined, 'not part of a timeline the watcher replays');
  assert.equal(plain.events.length, 0, 'a watch without turns hears no turn ends');
  assert.equal(other.events.length, 0, 'another project hears nothing');
  // A failed turn, to a watcher that attached meanwhile: told once, by its attachment.
  await watcher.client.request('session.attach', { sessionId: session.id, replay: false });
  await owner.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('Again') });
  await until(() => owner.events.filter(e => e.event.type === 'turn.started' && e.sessionId === session.id).length === 2);
  runtimes[0].notification('turn/completed', { threadId: runtimes[0].threadId, turn: { id: runtimes[0].turnId, status: 'failed', error: { message: 'boom' } } });
  await until(() => watcher.events.some(e => e.event.type === 'turn.ended' && e.event.state === 'failed'));
  await new Promise(resolve => setTimeout(resolve, 20));
  const failed = watcher.events.filter(e => e.event.type === 'turn.ended' && e.event.state === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(typeof failed[0].cursor, 'number', 'the attached watcher gets the kept envelope only');
  // A second call without turns stops them.
  await watcher.client.request('session.release', { sessionId: session.id });
  await watcher.client.request('question.watch', { projectRoot: project });
  await owner.client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm3', content: text('Third') });
  await until(() => owner.events.filter(e => e.event.type === 'turn.started' && e.sessionId === session.id).length === 3);
  runtimes[0].finish();
  await until(() => owner.events.filter(e => e.event.type === 'turn.ended' && e.sessionId === session.id).length === 3);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(watcher.events.filter(e => e.event.type === 'turn.ended' && e.sessionId === session.id).length, 2);
});

test('workspace.files.search lists matching files inside the directory only, never through a link', async t => {
  const { project, open } = await setup(t);
  const { client } = await open();
  assert.ok((await client.request('daemon.hello', { protocolVersion: 1 })).capabilities.includes('workspace.files'));
  const outside = await mkdtemp(path.join(tmpdir(), 'alpd-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, 'secret-server.ts'), 'x');
  await mkdir(path.join(project, 'src', 'deep'), { recursive: true });
  await mkdir(path.join(project, 'node_modules', 'pkg'), { recursive: true });
  await mkdir(path.join(project, '.hidden'), { recursive: true });
  await writeFile(path.join(project, 'src', 'server.ts'), 'x');
  await writeFile(path.join(project, 'src', 'deep', 'server-utils.ts'), 'x');
  await writeFile(path.join(project, 'README.md'), 'x');
  await writeFile(path.join(project, '.env'), 'SECRET=1');
  await writeFile(path.join(project, 'node_modules', 'pkg', 'server.js'), 'x');
  await writeFile(path.join(project, '.hidden', 'server.txt'), 'x');
  await symlink(outside, path.join(project, 'linked-dir'));
  await symlink(path.join(outside, 'secret-server.ts'), path.join(project, 'linked-server.ts'));
  const found = await client.request('workspace.files.search', { projectRoot: project, query: 'server' });
  assert.deepEqual(found, { files: [{ path: 'src/server.ts' }, { path: 'src/deep/server-utils.ts' }] }, 'exact name first; links, ignored and hidden directories left out');
  const all = (await client.request('workspace.files.search', { projectRoot: project, limit: 100 })).files.map(f => f.path);
  assert.ok(all.includes('README.md') && all.includes('src/server.ts'));
  assert.ok(!all.some(file => file.includes('secret') || file.startsWith('.env') || file.includes('linked') || file.includes('node_modules')), all.join());
  assert.equal(all.indexOf('README.md') < all.indexOf('src/server.ts'), true, 'shallow files first');
  assert.deepEqual((await client.request('workspace.files.search', { projectRoot: project, query: 'deep/serv' })).files, [{ path: 'src/deep/server-utils.ts' }]);
  assert.equal((await client.request('workspace.files.search', { projectRoot: project, limit: 1 })).files.length, 1);
  // The root itself reached through a link is searched as its real directory.
  const alias = path.join(outside, 'alias');
  await symlink(project, alias);
  assert.deepEqual((await client.request('workspace.files.search', { projectRoot: alias, query: 'server.ts' })).files[0], { path: 'src/server.ts' });
  await assert.rejects(client.request('workspace.files.search', { projectRoot: 'relative/dir' }), { code: -32602 });
  await assert.rejects(client.request('workspace.files.search', { projectRoot: `${project}/../project` }), { code: -32602 });
  await assert.rejects(client.request('workspace.files.search', { projectRoot: path.join(project, 'README.md') }), { code: 1001 });
  await assert.rejects(client.request('workspace.files.search', { projectRoot: path.join(project, 'missing') }), { code: 1001 });
  await assert.rejects(client.request('workspace.files.search', { projectRoot: project, limit: 101 }), { code: -32602 });
});
