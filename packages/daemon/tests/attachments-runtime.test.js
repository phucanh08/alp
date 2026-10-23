// Attachments reaching a runtime (docs/protocol/alp-json-rpc-v1.md §12.6, issue #121 branch J): alpd's
// store, the real ALP runtime and its staging of read-only copies, with a scripted native transport.
// What the turn's input names, what the timeline shows, and what retries, restarts, tampering,
// collection and forks of forks keep. Real Codex and Claude runs are test/e2e/attachments-e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { ATTACHMENT_HEADER, ATTACHMENT_ROUTES, attachmentStageDir, createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { createAttachmentStore } from '@anhlp/alp-daemon/attachments';
import { validateResult } from '@anhlp/alp-protocol/contract';

const skip = process.platform === 'win32' && 'attachments are not served on Windows';
const sha = data => createHash('sha256').update(data).digest('hex');

async function until(check, what = 'condition') {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${what} did not happen`);
}

/** A scripted native runtime: turn/start answers a turn that finish() completes; its input is recorded. */
function fakeTransport(transports) {
  return () => {
    const index = transports.length;
    let turns = 0;
    const transport = {
      calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() {},
      async request(method, params) {
        this.calls.push({ method, params: structuredClone(params) });
        if (method === 'thread/resume') { this.threadId = params.threadId; return { thread: { id: params.threadId } }; }
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `out-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
    };
    transports.push(transport);
    return transport;
  };
}

/** A home with alpd in process; `start()` again on the same home is a restart. `stage: false` gives the runtime no staging directory. */
async function setup(t, { stage = true } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-attach-rt-')));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const transports = [];
  const stops = [];
  const clock = { now: Date.now() };
  const native = { next: 0 };
  t.after(async () => { for (const stop of stops.reverse()) await stop(); await rm(directory, { recursive: true, force: true }); });
  let count = 0;
  async function start() {
    const runtime = createAlpRuntime({ supervisor: false, transport: fakeTransport(transports), runLogDir: path.join(directory, 'runs'), ...(stage ? { attachmentStageDir: attachmentStageDir(home) } : {}) });
    runtime.branch = async () => ({ threadId: `thread-branch-${++native.next}` });
    runtime.rebind = async sessionId => runtime.snapshot(sessionId);
    const store = createStore(path.join(home, 'state'));
    const socketPath = daemonPaths(path.join(directory, `d${count++}`)).socket;
    const server = createDaemonServer({ runtime, socketPath, version: 'test', store, home, attachmentOptions: { now: () => clock.now, sweepMs: 0 } });
    await server.listen();
    const client = await connect(socketPath, { name: 'test', version: '0' });
    const events = [];
    client.onEvent(envelope => events.push(envelope));
    let stopped = false;
    const stop = async () => { if (stopped) return; stopped = true; client.close(); await store.flush().catch(() => {}); await server.close().catch(() => {}); await runtime.shutdown(); };
    stops.push(stop);
    const request = (method, params) => client.request(method, params);
    await request('daemon.status');
    return { runtime, server, store, client, events, request, stop };
  }
  return { directory, home, project, transports, clock, stageRoot: attachmentStageDir(home), start };
}

async function upload(request, sessionId, data, { name = 'notes.txt', mimeType = 'text/plain', requestId = `r-${Math.random()}` } = {}) {
  const bytes = Buffer.from(data);
  const begun = await request('attachment.begin', { sessionId, name, size: bytes.length, mimeType, requestId });
  for (let offset = 0; offset < bytes.length; offset += 4096) await request('attachment.chunk', { uploadId: begun.uploadId, offset, data: bytes.subarray(offset, offset + 4096).toString('base64') });
  return (await request('attachment.commit', { uploadId: begun.uploadId, sha256: sha(bytes) })).attachment;
}

/** The attachment parts of a native turn input, parsed: the JSON after ATTACHMENT_HEADER. */
const attachmentParts = input => input.filter(part => part.type === 'text' && part.text.startsWith(ATTACHMENT_HEADER)).map(part => JSON.parse(part.text.slice(ATTACHMENT_HEADER.length).split('\n', 1)[0]));
const turnStarts = transports => transports.flatMap(transport => transport.calls.filter(call => call.method === 'turn/start'));

/** Runs one prompt to a completed turn; answers the prompt's result. */
async function turn(d, world, sessionId, clientMessageId, content) {
  const result = await d.request('session.prompt', { sessionId, clientMessageId, content });
  const transport = world.transports.at(-1);
  if (result.outcome === 'accepted' && !result.duplicate) {
    await until(() => transport.turnId, 'turn started');
    transport.finish(`answer ${clientMessageId}`);
    await until(async () => !(await d.request('session.get', { sessionId })).session.activeTurnId, 'turn ended');
  }
  return result;
}

const BINARY = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f, 0x80, 0x0a, 0x0d, 0x00, 0x01, 0x02, 0x03]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

test('the capability matrix: Codex and Claude read staged files by path; ACP and Antigravity take no attachments', () => {
  assert.deepEqual(ATTACHMENT_ROUTES, { codex: ['file.path'], claude: ['file.path'], acp: [], antigravity: [] });
});

test('a Codex session stages exact read-only copies its tools read by path; the timeline keeps ids and names, never the path', { skip }, async t => {
  const world = await setup(t);
  const d = await world.start();
  await d.request('session.create', { sessionId: 'r1', spec: { cwd: world.project, persist: true } });
  const status = await d.request('session.get', { sessionId: 'r1' });
  assert.deepEqual(status.session.promptAttachments ?? (await d.request('session.status', { sessionId: 'r1' })).sessions?.[0]?.promptAttachments, ['file.path']);
  const binary = await upload(d.request, 'r1', BINARY, { name: 'blob.bin', mimeType: 'application/octet-stream' });
  const pdf = await upload(d.request, 'r1', PDF, { name: 'report.PDF', mimeType: 'application/pdf' });
  const textFile = await upload(d.request, 'r1', 'héllo wörld\n', { name: 'notes.txt' });
  const content = [{ type: 'text', text: 'read these' }, ...[binary, pdf, textFile].map(({ attachmentId }) => ({ type: 'attachment', attachmentId }))];
  const result = await turn(d, world, 'r1', 'm1', content);
  assert.equal(result.outcome, 'accepted');

  const [start] = turnStarts(world.transports);
  const parts = attachmentParts(start.params.input);
  assert.equal(parts.length, 3);
  for (const [index, [attachment, bytes]] of [[binary, BINARY], [pdf, PDF], [textFile, Buffer.from('héllo wörld\n')]].entries()) {
    const part = parts[index];
    assert.equal(part.attachmentId, attachment.attachmentId);
    assert.equal(part.sha256, sha(bytes));
    assert.equal(part.size, bytes.length);
    // A host-generated path in the dedicated directory: id and a plain extension, never the display name.
    assert.equal(path.dirname(part.path), world.stageRoot);
    assert.match(path.basename(part.path), /^att_[0-9a-f]{32}(\.[a-z0-9]+)?$/);
    const staged = await readFile(part.path);
    assert.equal(sha(staged), sha(bytes), 'the staged copy holds the exact bytes');
    const info = await lstat(part.path);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.mode & 0o777, 0o400, 'read-only, never executable');
  }
  assert.equal(path.extname(parts[1].path), '.pdf');
  assert.equal((await lstat(world.stageRoot)).mode & 0o777, 0o700);
  // The prompt is where CATALOG says; the attachment parts follow it, counted in the layout.
  const catalog = JSON.parse(start.params.input[0].text.replace(/^[^{]*/, ''));
  assert.equal(start.params.input[catalog.inputLayout.prompt].text, 'read these');
  assert.equal(catalog.inputLayout.textParts, start.params.input.filter(part => part.type === 'text').length);
  assert.deepEqual(catalog.attachments.map(entry => entry.attachmentId), [binary, pdf, textFile].map(entry => entry.attachmentId));
  assert.ok(!JSON.stringify(catalog.attachments).includes(world.directory), 'CATALOG names no path');

  // The timeline: ids, display names, types and sizes; no host path in anything a client replays.
  const history = await d.request('session.history', { sessionId: 'r1' });
  const message = history.items.map(item => item.event).find(event => event?.type === 'item' && event.item.kind === 'user_message');
  assert.deepEqual(message.item.attachments, [
    { attachmentId: binary.attachmentId, name: 'blob.bin', mimeType: 'application/octet-stream', size: BINARY.length },
    { attachmentId: pdf.attachmentId, name: 'report.PDF', mimeType: 'application/pdf', size: PDF.length },
    { attachmentId: textFile.attachmentId, name: 'notes.txt', mimeType: 'text/plain', size: Buffer.byteLength('héllo wörld\n') },
  ]);
  assert.equal(message.item.text, 'read these');
  assert.ok(!JSON.stringify(history).includes(world.stageRoot), 'no staging path in history');
  assert.ok(!JSON.stringify(d.events).includes(world.stageRoot), 'no staging path in live events');
  const timelines = path.join(world.home, 'state');
  for (const name of await readdir(timelines, { recursive: true })) {
    if (!/\.(jsonl|json)$/.test(name) || name.startsWith('attachments')) continue;
    assert.ok(!(await readFile(path.join(timelines, name), 'utf8')).includes(world.stageRoot), `no staging path in ${name}`);
  }
  assert.deepEqual(validateResult('session.history', history), [], 'the history answer, attachments included, matches the contract');
  assert.deepEqual(validateResult('session.get', status), []);
});

test('a tool command, its output or a reply that names a staged copy reaches the timeline with the directory masked', { skip }, async t => {
  const world = await setup(t);
  const d = await world.start();
  await d.request('session.create', { sessionId: 'rm', spec: { cwd: world.project, persist: true } });
  const attachment = await upload(d.request, 'rm', 'masked');
  await d.request('session.prompt', { sessionId: 'rm', clientMessageId: 'm1', content: [{ type: 'text', text: 'x' }, { type: 'attachment', attachmentId: attachment.attachmentId }] });
  const transport = world.transports.at(-1);
  await until(() => transport.turnId, 'turn started');
  const [part] = attachmentParts(turnStarts(world.transports)[0].params.input);
  const real = await realpath(part.path);
  transport.notification('item/completed', { threadId: transport.threadId, item: { type: 'commandExecution', id: 'cmd-1', command: `shasum -a 256 ${part.path}`, cwd: world.project, status: 'completed', exitCode: 0, aggregatedOutput: `${sha('masked')}  ${real}\n` } });
  transport.finish(`The file at ${part.path} has SHA-256 ${sha('masked')}.`);
  await until(async () => !(await d.request('session.get', { sessionId: 'rm' })).session.activeTurnId, 'turn ended');
  const history = JSON.stringify(await d.request('session.history', { sessionId: 'rm' }));
  assert.ok(!history.includes(world.stageRoot) && !history.includes(path.dirname(real)), 'no spelling of the staging directory in history');
  assert.ok(!JSON.stringify(d.events).includes(world.stageRoot), 'nor in live events');
  assert.ok(history.includes(`<alp-attachments>/${path.basename(part.path)}`), 'the copy shows under the mask with its id');
  assert.ok(history.includes(sha('masked')));
});

test('retry, restart and reconnect keep one object and one staged copy; a tampered copy is replaced, never followed', { skip }, async t => {
  const world = await setup(t);
  let d = await world.start();
  await d.request('session.create', { sessionId: 'r2', spec: { cwd: world.project, persist: true } });
  // The same upload request twice (a reconnect mid-upload): one object.
  const first = await upload(d.request, 'r2', BINARY, { name: 'blob.bin', requestId: 'same' });
  const again = await d.request('attachment.begin', { sessionId: 'r2', name: 'blob.bin', size: BINARY.length, mimeType: 'text/plain', requestId: 'same' });
  assert.equal(again.attachmentId, first.attachmentId);
  const content = [{ type: 'text', text: 'one' }, { type: 'attachment', attachmentId: first.attachmentId }];
  await turn(d, world, 'r2', 'm1', content);
  // A retry of the same message is the receipt's answer: nothing sent again.
  assert.equal((await d.request('session.prompt', { sessionId: 'r2', clientMessageId: 'm1', content })).duplicate, true);
  assert.equal(turnStarts(world.transports).length, 1);
  const [part] = attachmentParts(turnStarts(world.transports)[0].params.input);
  const inode = (await lstat(part.path)).ino;

  // Restart alpd on the same home: the object, its references and the staged copy are the same.
  await d.stop();
  d = await world.start();
  await d.request('session.create', { sessionId: 'r2', spec: { cwd: world.project, persist: true }, resume: true });
  assert.equal((await d.request('session.prompt', { sessionId: 'r2', clientMessageId: 'm1', content })).duplicate, true, 'a retry after the restart is still a duplicate');
  await turn(d, world, 'r2', 'm2', [{ type: 'text', text: 'two' }, { type: 'attachment', attachmentId: first.attachmentId }]);
  const [reused] = attachmentParts(turnStarts(world.transports).at(-1).params.input);
  assert.equal(reused.path, part.path);
  assert.equal((await lstat(part.path)).ino, inode, 'the verified copy is reused, not rewritten');
  const objects = (await readdir(path.join(world.home, 'state', 'attachments'))).filter(name => /^[0-9a-f]{32}$/.test(name));
  assert.deepEqual(objects, [first.attachmentId.slice(4)], 'one immutable object');
  assert.deepEqual((await readdir(world.stageRoot)).filter(name => !name.startsWith('.')), [path.basename(part.path)], 'one staged copy');

  // Tampering: a changed copy, a copy made writable, a link to another file. Each is replaced, the link's target untouched.
  const outside = path.join(world.directory, 'outside.txt');
  await writeFile(outside, 'not yours');
  const tamper = [
    async () => { await chmod(part.path, 0o600); await writeFile(part.path, 'changed'); await chmod(part.path, 0o400); },
    async () => { await chmod(part.path, 0o644); },
    async () => { await unlink(part.path); await symlink(outside, part.path); },
  ];
  for (const [index, change] of tamper.entries()) {
    await change();
    await turn(d, world, 'r2', `t${index}`, [{ type: 'text', text: `tampered ${index}` }, { type: 'attachment', attachmentId: first.attachmentId }]);
    const info = await lstat(part.path);
    assert.ok(info.isFile() && !info.isSymbolicLink(), `copy ${index} is a regular file again`);
    assert.equal(info.mode & 0o777, 0o400);
    assert.equal(sha(await readFile(part.path)), sha(BINARY));
  }
  assert.equal(await readFile(outside, 'utf8'), 'not yours', 'a link is replaced, never written through');
});

test('names never become paths: traversal and shell names stage under the id, without an executable bit', { skip }, async t => {
  const world = await setup(t);
  const d = await world.start();
  await d.request('session.create', { sessionId: 'r3', spec: { cwd: world.project, persist: true } });
  // Without a plain extension in the name, the copy takes the detected type's (text here).
  const names = ['../../evil.sh', '$(touch pwned).txt', '-rf', 'a.b/../../c', 'x.verylongextensionname1234'];
  const ids = [];
  for (const name of names) ids.push((await upload(d.request, 'r3', `#!/bin/sh\necho ${name}\n`, { name })).attachmentId);
  await turn(d, world, 'r3', 'm1', [{ type: 'text', text: 'names' }, ...ids.map(attachmentId => ({ type: 'attachment', attachmentId }))]);
  const parts = attachmentParts(turnStarts(world.transports)[0].params.input);
  assert.deepEqual(parts.map(part => path.basename(part.path)), [`${ids[0]}.sh`, `${ids[1]}.txt`, `${ids[2]}.txt`, `${ids[3]}.c`, `${ids[4]}.txt`]);
  for (const part of parts) {
    assert.equal(path.dirname(part.path), world.stageRoot);
    assert.equal((await lstat(part.path)).mode & 0o111, 0, 'not executable');
  }
  assert.deepEqual((await readdir(world.stageRoot)).sort(), parts.map(part => path.basename(part.path)).sort(), 'every copy, and only they, in the staging directory');
  assert.deepEqual((await readdir(path.dirname(world.stageRoot))).filter(name => /evil|pwned|^c$/.test(name)), []);
});

test('a staging directory that is a link, or a runtime without one, refuses the prompt honestly with no host path', { skip }, async t => {
  const world = await setup(t);
  const d = await world.start();
  await d.request('session.create', { sessionId: 'r4', spec: { cwd: world.project, persist: true } });
  const attachment = await upload(d.request, 'r4', 'data');
  // The directory swapped for a link to elsewhere before first use.
  const elsewhere = path.join(world.directory, 'elsewhere');
  await mkdir(elsewhere, { mode: 0o700 });
  await mkdir(path.dirname(world.stageRoot), { recursive: true });
  await rm(world.stageRoot, { recursive: true, force: true });
  await symlink(elsewhere, world.stageRoot);
  const failed = await d.request('session.prompt', { sessionId: 'r4', clientMessageId: 'm1', content: [{ type: 'text', text: 'x' }, { type: 'attachment', attachmentId: attachment.attachmentId }] });
  assert.equal(failed.outcome, 'failed');
  assert.match(failed.error.message, /could not give the runtime a readable copy of "notes.txt"/);
  assert.ok(!failed.error.message.includes(world.directory), 'no host path in the error');
  assert.deepEqual(await readdir(elsewhere), [], 'nothing staged through the link');
  assert.equal(turnStarts(world.transports).length, 0, 'nothing reached the provider');

  // Without a staging directory no session takes attachments: 1005 before any receipt.
  const bare = await setup(t, { stage: false });
  const b = await bare.start();
  await b.request('session.create', { sessionId: 'r5', spec: { cwd: bare.project, persist: true } });
  assert.equal((await b.request('session.get', { sessionId: 'r5' })).session.promptAttachments, undefined);
  const stored = await upload(b.request, 'r5', 'data');
  await assert.rejects(b.request('session.prompt', { sessionId: 'r5', clientMessageId: 'm1', content: [{ type: 'attachment', attachmentId: stored.attachmentId }] }), error => error.code === 1005 && error.data?.reason === 'attachment_unsupported');
});

test('a collected object takes its staged copy with it', { skip }, async t => {
  const world = await setup(t);
  let d = await world.start();
  await d.request('session.create', { sessionId: 'r6', spec: { cwd: world.project, persist: true } });
  const attachment = await upload(d.request, 'r6', 'gone soon');
  await turn(d, world, 'r6', 'm1', [{ type: 'text', text: 'x' }, { type: 'attachment', attachmentId: attachment.attachmentId }]);
  const [part] = attachmentParts(turnStarts(world.transports)[0].params.input);
  await lstat(part.path);
  // The session's history deleted (the deletion seam), then past the grace period: collected at the next start.
  await d.stop();
  const store = createAttachmentStore({ root: path.join(world.home, 'state', 'attachments'), sessionProject: () => world.project, sweepMs: 0 });
  await store.releaseSessions(['r6']);
  store.close();
  world.clock.now += 8 * 24 * 60 * 60 * 1000;
  d = await world.start();
  await until(async () => !(await lstat(part.path).then(() => true, () => false)), 'staged copy removed');
});

test('a fork of a fork keeps the attachments of its kept prompts after the first ancestor\'s history is deleted', { skip }, async t => {
  const world = await setup(t);
  let d = await world.start();
  await d.request('session.create', { sessionId: 'root', spec: { cwd: world.project, persist: true } });
  const attachment = await upload(d.request, 'root', PDF, { name: 'report.pdf', mimeType: 'application/pdf' });
  await turn(d, world, 'root', 'm1', [{ type: 'text', text: 'read' }, { type: 'attachment', attachmentId: attachment.attachmentId }]);
  const firstTurn = world.transports.at(-1).turnId;
  const generation = (await d.request('session.history', { sessionId: 'root', limit: 1 })).generation;
  const fork1 = await d.request('session.fork', { sessionId: 'root', requestId: 'f1', ifGeneration: generation, boundary: { throughTurnId: firstTurn }, newSessionId: 'fork1' });
  assert.equal(fork1.session.id, 'fork1');
  // fork1's copy of the conversation still names the attachment by id.
  const kept = (await d.request('session.history', { sessionId: 'fork1' })).items.map(item => item.event).find(event => event?.item?.kind === 'user_message');
  assert.deepEqual(kept.item.attachments.map(entry => entry.attachmentId), [attachment.attachmentId]);
  await d.stop();

  // The root's history is deleted as retention does: its record and timeline go, its references are released.
  const state = path.join(world.home, 'state');
  const store = createStore(state);
  await store.remove('root', ['root']);
  await store.flush();
  const attachments = createAttachmentStore({ root: path.join(state, 'attachments'), sessionProject: () => world.project, sweepMs: 0 });
  await attachments.releaseSessions(['root']);
  assert.deepEqual(Object.values(attachments.holders()).map(holder => holder.kind), ['fork']);
  attachments.close();

  d = await world.start();
  const generation1 = (await d.request('session.history', { sessionId: 'fork1', limit: 1 })).generation;
  const fork2 = await d.request('session.fork', { sessionId: 'fork1', requestId: 'f2', ifGeneration: generation1, boundary: { throughTurnId: firstTurn }, newSessionId: 'fork2' });
  assert.equal(fork2.session.id, 'fork2');
  await d.stop();
  const after = createAttachmentStore({ root: path.join(state, 'attachments'), sessionProject: () => world.project, sweepMs: 0 });
  await after.heldBy([]);
  const holders = Object.entries(after.holders());
  after.close();
  assert.deepEqual(holders.filter(([key]) => key === 'fork:fork2').map(([, holder]) => holder.attachments.map(id => `att_${id}`)), [[attachment.attachmentId]], 'the fork of the fork pins the attachment itself');
  assert.ok(holders.some(([key]) => key === 'fork:fork1'));
});
