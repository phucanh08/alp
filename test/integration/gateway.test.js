// The remote gateway end to end (docs/alp/remote-gateway.md §9): a remote client on the portable
// client SDK → WebSocket → apps/gateway → client SDK over IPC → a real alpd process with a fake
// Codex app-server. Handshake, create, prompt and stream; reconnect and replay from a cursor; a
// gateway restart and an alpd restart while the client keeps its place; another credential that
// cannot see or touch the session; and a mutation never resent by the gateway. No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { initProject } from '../../packages/core/src/init.js';
import { connectSocket, readLock } from '../../packages/client/src/index.js';
import { AlpRpcClient, createReconnectingClient, hello, isAlpClientError } from '../../packages/client/src/portable.js';
import { connectWebSocket } from '../../packages/client/src/websocket.js';
import { CredentialStore, createCredential, createGateway, createGatewayLogger, resolveConfig, revokeCredential } from '../../apps/gateway/src/index.js';

const ALPD = fileURLToPath(new URL('../../packages/daemon/dist/alpd.js', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../../packages/daemon/tests/support/fake-codex.js', import.meta.url));
const skip = process.platform === 'win32' && 'the fake provider is a Node script run as an executable';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MODEL = 'codex:gpt-5.6-sol';

async function until(check, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(10); }
  assert.fail(`${what} never happened`);
}

async function world(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-e2e-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), '{}');
  const projects = {};
  for (const name of ['a', 'b']) {
    projects[name] = path.join(directory, name);
    await initProject(projects[name]);
    await writeFile(path.join(projects[name], '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  }
  const journal = path.join(directory, 'codex.jsonl');
  const logFile = path.join(directory, 'alpd.log');
  /** @type {import('node:child_process').ChildProcess | undefined} */
  let child;
  let socket = '';
  async function startDaemon() {
    const log = openSync(logFile, 'a');
    child = spawn(process.execPath, [ALPD], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ALP_HOME: home, ALP_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_JOURNAL: journal } });
    closeSync(log);
    for (let i = 0; ; i++) {
      const lock = await readLock(home);
      if (lock?.ready && lock.pid === child.pid) { socket = lock.socket; return; }
      if (child.exitCode !== null || i > 400) assert.fail(`alpd did not start:\n${await readFile(logFile, 'utf8')}`);
      await sleep(25);
    }
  }
  async function stopDaemon() {
    const running = child;
    if (!running || running.exitCode !== null || running.signalCode !== null) return;
    const exited = once(running, 'exit');
    try { process.kill(-/** @type {number} */ (running.pid), 'SIGTERM'); } catch {}
    await Promise.race([exited, sleep(5000)]);
    if (running.exitCode === null && running.signalCode === null) { try { process.kill(-/** @type {number} */ (running.pid), 'SIGKILL'); } catch {} await exited; }
  }
  await startDaemon();

  const gatewayHome = path.join(directory, 'gateway');
  const all = ['session.read', 'session.write', 'project.read', 'project.write'];
  const alice = await createCredential(gatewayHome, { label: 'alice', workspaces: [projects.a], permissions: all });
  const bob = await createCredential(gatewayHome, { label: 'bob', workspaces: [projects.b], permissions: all });
  // May drive read-only trees of a only; may read a's project resources only.
  const viewer = await createCredential(gatewayHome, { label: 'viewer', workspaces: [projects.a], permissions: all, modes: ['read-only'] });
  const reader = await createCredential(gatewayHome, { label: 'reader', workspaces: [projects.a], permissions: ['session.read', 'project.read'] });
  // Reads a's files (files.read is never a default); bob reads b's.
  const files = await createCredential(gatewayHome, { label: 'files', workspaces: [projects.a], permissions: ['session.read', 'files.read'] });
  const bobFiles = await createCredential(gatewayHome, { label: 'bob-files', workspaces: [projects.b], permissions: ['files.read'] });
  // Uploads attachments for a's sessions (attachments.write is never a default); bob's for b.
  const uploader = await createCredential(gatewayHome, { label: 'uploader', workspaces: [projects.a], permissions: ['session.read', 'session.write', 'attachments.write'] });
  const bobUploader = await createCredential(gatewayHome, { label: 'bob-uploader', workspaces: [projects.b], permissions: ['session.read', 'session.write', 'attachments.write'] });
  const lines = [];
  const logger = createGatewayLogger({ write: line => lines.push(line) });
  const store = new CredentialStore({ home: gatewayHome, logger, pollMs: 50 });
  /** @type {ReturnType<typeof createGateway> | undefined} */
  let gateway;
  let base = '';
  async function startGateway() {
    gateway = createGateway({ config: resolveConfig({ port: 0 }), store, logger, version: 'e2e', openTransport: () => connectSocket(socket), monitorIntervalMs: 100 });
    base = (await gateway.listen()).url;
  }
  await startGateway();

  t.after(async () => {
    await gateway?.close();
    store.close();
    await stopDaemon();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  /** The way a remote client connects: a ticket over HTTPS-style POST, then the WebSocket. */
  async function open(token) {
    const response = await fetch(`${base}/v1/tickets`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    if (response.status !== 201) throw new Error(`ticket refused: ${response.status}`);
    const { subprotocols, websocket } = await response.json();
    return connectWebSocket(`${base.replace(/^http/, 'ws')}${websocket}`, { WebSocket, protocols: subprotocols });
  }

  const turnStarts = async () => (await readFile(journal, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.method === 'turn/start');

  return {
    projects, home, tokens: { alice: alice.token, bob: bob.token, viewer: viewer.token, reader: reader.token, files: files.token, bobFiles: bobFiles.token, uploader: uploader.token, bobUploader: bobUploader.token }, ids: { alice: alice.credential.id, uploader: uploader.credential.id }, gatewayHome, lines, open, turnStarts, journal: () => readFile(journal, 'utf8').catch(() => ''),
    get base() { return base; }, get gateway() { return gateway; }, get socket() { return socket; },
    startDaemon, stopDaemon, startGateway,
    async stopGateway() { await gateway?.close(); gateway = undefined; },
  };
}

/**
 * A remote client that follows the protocol's reconnect algorithm (§8.3) with the SDK's
 * reconnecting client: hello, then attach after the last cursor it holds.
 */
function follower(w, token) {
  const state = { sessionId: /** @type {string | undefined} */ (undefined), cursor: 0, cursors: /** @type {number[]} */ ([]), events: /** @type {any[]} */ ([]), resets: 0, attaches: 0, closes: /** @type {number[]} */ ([]) };
  const alp = createReconnectingClient({
    connect: () => w.open(token),
    backoff: { initialMs: 50, maxMs: 300 },
    stableMs: 200,
    onDisconnect: error => { const code = /** @type {any} */ (error)?.data?.code; if (code) state.closes.push(code); },
    onConnect: async client => {
      await hello(client, { name: 'e2e', version: '0' });
      if (!state.sessionId) return;
      const answer = await client.request('session.attach', { sessionId: state.sessionId, after: state.cursor });
      state.attaches++;
      if (answer.reset) { state.resets++; state.cursor = 0; }
    },
  });
  alp.onEvent(envelope => {
    state.events.push(envelope);
    if (envelope.cursor === undefined) return;
    state.cursors.push(envelope.cursor);
    state.cursor = Math.max(state.cursor, envelope.cursor);
  });
  return { alp, state };
}

const text = body => [{ type: 'text', text: body }];
const ended = (state, turns) => state.events.filter(envelope => envelope.event.type === 'turn.ended').length >= turns;

test('a remote client works through the gateway across reconnects and restarts of the gateway and alpd', { skip, timeout: 120_000 }, async t => {
  const w = await world(t);
  const { alp, state } = follower(w, w.tokens.alice);
  t.after(() => alp.stop());
  const client = await alp.ready();

  // Handshake through the gateway: alpd's capabilities, never extension methods.
  const greeting = await hello(client, { name: 'e2e', version: '0' });
  assert.deepEqual(greeting.capabilities.sort(), ['attach.after', 'library', 'library.project.write', 'prompt.images', 'prompt.receipts', 'question.watch', 'question.watch.turns', 'session.attention', 'session.history', 'session.list.page', 'settings.language', 'task', 'team', 'workspace.files', 'workspace.files.read', 'workspace.git', 'workspace.registry', ...(process.platform === 'win32' ? [] : ['attachments', 'session.fork', 'session.rewind', 'workspace.worktree'])].sort());
  assert.ok(!greeting.capabilities.includes('extension.methods'));
  assert.equal(greeting.pid, undefined);
  assert.equal(greeting.hostname, hostname(), 'alpd\'s machine name, as Paseo labels a host');

  // Create and prompt; the stream arrives with cursors.
  const { session } = await alp.request('session.create', { spec: { cwd: w.projects.a, persist: true, model: MODEL }, history: 'skip' });
  state.sessionId = session.id;
  assert.equal((await alp.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('first') })).outcome, 'accepted');
  await until(() => ended(state, 1), 'the first turn');

  // A turn that keeps running; the client drops. Nothing cancels it.
  await alp.request('session.prompt', { sessionId: session.id, clientMessageId: 'm2', content: text('second [hold]') });
  await until(() => state.events.some(envelope => envelope.event.type === 'turn.started' && state.events.filter(e => e.event.type === 'turn.started').length >= 2), 'the second turn started');
  const before = state.cursor;
  for (const connection of w.gateway.connections) connection.close(1012, 'test drop');
  await until(() => state.attaches >= 1 && alp.state === 'open', 'reattached after the drop');
  // An observer with the same grant sees the session still running.
  const observer = new AlpRpcClient(await w.open(w.tokens.alice));
  t.after(() => observer.close());
  await hello(observer);
  assert.equal((await observer.request('session.get', { sessionId: session.id })).session.status, 'running');
  observer.close();

  // The gateway restarts. While it is down the turn ends (interrupted by a local client on alpd's
  // socket); the remote client gets that event by replay from its cursor once it is back.
  await w.stopGateway();
  const local = new AlpRpcClient(await connectSocket(w.socket));
  await hello(local);
  await local.request('session.interrupt', { sessionId: session.id });
  local.close();
  assert.ok(!ended(state, 2), 'the end of the turn happened while the client was away');
  await w.startGateway();
  await until(() => state.attaches >= 2 && alp.state === 'open', 'reattached after the gateway restart');
  await until(() => ended(state, 2), 'the interrupted turn ended, by replay');
  assert.ok(state.cursor > before);

  // alpd restarts: the gateway tells the client (4503), readiness drops, then everything resumes.
  await w.stopDaemon();
  await until(() => state.closes.includes(4503), 'the client told alpd went away');
  await until(async () => (await fetch(`${w.base}/readyz`)).status === 503, 'not ready while alpd is down');
  await w.startDaemon();
  await until(async () => (await fetch(`${w.base}/readyz`)).status === 200, 'ready again');
  await until(() => state.attaches >= 3 && alp.state === 'open', 'reattached after the alpd restart', 30_000);
  const resumed = await alp.request('session.create', { sessionId: session.id, spec: { cwd: w.projects.a }, resume: true, history: 'skip' });
  assert.equal(resumed.session.id, session.id);
  await alp.request('session.prompt', { sessionId: session.id, clientMessageId: 'm3', content: text('third') });
  await until(() => ended(state, 3), 'the turn after the restart');

  // Cursors: every kept envelope once, in order, without a reset.
  assert.equal(state.resets, 0);
  const sorted = [...state.cursors].sort((x, y) => x - y);
  assert.deepEqual(state.cursors, sorted, 'cursor order');
  assert.equal(new Set(state.cursors).size, state.cursors.length, 'no envelope twice');
  assert.deepEqual(sorted, Array.from({ length: sorted.length }, (_, i) => i + 1), 'no gap');

  // Each prompt reached the provider once: nothing was resent by the gateway or the SDK.
  const starts = await w.turnStarts();
  assert.equal(starts.filter(entry => entry.text?.includes('first')).length, 1);
  assert.equal(starts.filter(entry => entry.text?.includes('second')).length, 1);
  assert.equal(starts.filter(entry => entry.text?.includes('third')).length, 1);

  // Nothing secret in the gateway's log.
  const log = w.lines.join('\n');
  assert.ok(!log.includes(w.tokens.alice.split('.').at(-1)) && !log.includes(w.tokens.bob.split('.').at(-1)));
});

// t-7679.12: a session's token usage reaches a remote client in its grant, live and in session.get; never another credential.
test('session usage goes through the gateway to the credential that holds the session only', { skip, timeout: 60_000 }, async t => {
  const w = await world(t);
  const alice = new AlpRpcClient(await w.open(w.tokens.alice));
  const bob = new AlpRpcClient(await w.open(w.tokens.bob));
  t.after(() => { alice.close(); bob.close(); });
  await hello(alice);
  await hello(bob);
  const seen = { alice: /** @type {any[]} */ ([]), bob: /** @type {any[]} */ ([]) };
  alice.onEvent(envelope => seen.alice.push(envelope));
  bob.onEvent(envelope => seen.bob.push(envelope));
  const { session } = await alice.request('session.create', { spec: { cwd: w.projects.a, model: MODEL }, history: 'skip' });
  await alice.request('session.prompt', { sessionId: session.id, clientMessageId: 'u1', content: text('count [usage]') });
  await until(() => ended({ events: seen.alice }, 1), 'the turn');
  const usage = { contextWindowUsedTokens: 26_000, contextWindowMaxTokens: 258_400, inputTokens: 25_000, cachedInputTokens: 20_000, outputTokens: 1000 };
  const live = seen.alice.filter(envelope => envelope.event.type === 'usage');
  assert.deepEqual(live.map(envelope => envelope.event.usage), [usage]);
  assert.equal(typeof live[0].cursor, 'number');
  assert.deepEqual((await alice.request('session.get', { sessionId: session.id })).session.usage, usage);
  assert.equal(seen.bob.some(envelope => envelope.sessionId === session.id), false);
  await assert.rejects(bob.request('session.get', { sessionId: session.id }));
  // Account-wide usage stays on the host.
  await assert.rejects(alice.request('daemon.usage', {}), error => /** @type {any} */ (error).code === -32601);
});

test('another credential cannot see, attach, prompt or receive the session or touch the project\'s tasks, and revocation ends a client', { skip, timeout: 60_000 }, async t => {
  const w = await world(t);
  const owner = new AlpRpcClient(await w.open(w.tokens.alice));
  t.after(() => owner.close());
  await hello(owner);
  const { session } = await owner.request('session.create', { spec: { cwd: w.projects.a, persist: true, model: MODEL }, history: 'skip' });

  const other = new AlpRpcClient(await w.open(w.tokens.bob));
  t.after(() => other.close());
  await hello(other);
  const leaked = [];
  other.onEvent(envelope => leaked.push(envelope));
  await assert.rejects(other.request('session.attach', { sessionId: session.id }), error => error.code === 1001);
  await assert.rejects(other.request('session.prompt', { sessionId: session.id, clientMessageId: 'x', content: text('steal') }), error => error.code === 1001);
  await assert.rejects(other.request('session.create', { spec: { cwd: w.projects.a } }), error => error.code === 1003);
  await assert.rejects(other.request('session.create', { sessionId: session.id, spec: { cwd: w.projects.b } }), error => error.code === 1003);
  assert.deepEqual((await other.request('session.list', { includeClosed: true })).sessions, []);
  await owner.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('private') });
  await sleep(300);
  assert.deepEqual(leaked, []);
  assert.equal((await w.turnStarts()).filter(entry => entry.text?.includes('steal')).length, 0);

  // Project resources (alpd §15) through the gateway: tasks and teams of a granted project only.
  const { id: task } = await owner.request('task.create', { projectRoot: w.projects.a, title: 'remote task', requestId: 'e2e-1' });
  assert.deepEqual((await owner.request('task.list', { projectRoot: w.projects.a })).tasks.map(row => row.id), [task]);
  assert.equal((await owner.request('task.update', { projectRoot: w.projects.a, id: task, action: 'close' })).status, 'closed');
  assert.ok((await owner.request('team.list', { projectRoot: w.projects.a })).teams.length > 0);
  assert.equal(typeof (await owner.request('settings.language.get')).applies, 'string');
  // library.get is read only through the gateway (built-in main: instructions, no secrets to hide).
  const main = await owner.request('library.get', { kind: 'agents', name: 'main', projectRoot: w.projects.a });
  assert.equal(main.source, 'builtin');
  assert.equal(typeof main.content.instructions, 'string');
  await assert.rejects(owner.request('library.get', { kind: 'agents', name: 'main', projectRoot: w.projects.b }), error => error.code === 1003);
  await assert.rejects(owner.request('library.save', { kind: 'mcp', name: 'x', scope: 'library', content: { command: 'sh' } }), error => error.code === 1003 && error.data.permission === 'library.write');
  await assert.rejects(other.request('task.list', { projectRoot: w.projects.a }), error => error.code === 1003);
  await assert.rejects(other.request('task.create', { projectRoot: w.projects.a, title: 'intruder' }), error => error.code === 1003);
  await assert.rejects(other.request('task.update', { projectRoot: w.projects.a, id: task, action: 'reopen' }), error => error.code === 1003);
  const after = (await owner.request('task.list', { projectRoot: w.projects.a })).tasks;
  assert.deepEqual(after.map(row => [row.id, row.status]), [[task, 'closed']], 'the other credential changed nothing');

  // Revoking the owner's credential closes its connection with 4401; its session stays.
  const closed = new Promise(resolve => owner.onClose(error => resolve(error)));
  await revokeCredential(w.gatewayHome, w.ids.alice);
  const error = await closed;
  assert.ok(isAlpClientError(error, 'disconnected'));
  assert.equal(/** @type {any} */ (error).data?.code, 4401);
  await assert.rejects(w.open(w.tokens.alice), /401/);
});

// docs/alp/remote-gateway.md §5.5: a grant with modes drives only trees within them. Against the
// real runtime: a message wakes an idle session and steers a running one, an answer lets the asking
// turn go on, so each is refused for a full-access tree before alpd sees it, and works for a
// read-only tree the same credential opened.
test('a read-only grant cannot wake, steer or answer a full-access session on a real alpd, and can drive its own read-only one', { skip, timeout: 60_000 }, async t => {
  const w = await world(t);
  const local = new AlpRpcClient(await connectSocket(w.socket));
  t.after(() => local.close());
  await hello(local);
  const { session: full } = await local.request('session.create', { spec: { cwd: w.projects.a, persist: true, model: MODEL, mode: 'full-access' }, history: 'skip' });
  const events = [];
  local.onEvent(envelope => events.push(envelope));
  const ends = () => events.filter(envelope => envelope.sessionId === full.id && envelope.event.type === 'turn.ended').length;

  const viewer = new AlpRpcClient(await w.open(w.tokens.viewer));
  t.after(() => viewer.close());
  await hello(viewer);
  const refusedMode = error => error.code === 1003 && error.data?.reason === 'mode';
  const reachedProvider = async marker => (await w.journal()).includes(marker);

  // Idle: a message would wake it into a full-access turn.
  await assert.rejects(viewer.request('session.message', { sessionId: full.id, text: 'wake-marker please go on' }), refusedMode);
  // Running: a message would steer the full-access turn.
  await local.request('session.prompt', { sessionId: full.id, clientMessageId: 'hold', content: text('long work [hold]') });
  await until(async () => (await local.request('session.get', { sessionId: full.id })).session.status === 'running', 'the held turn runs');
  await assert.rejects(viewer.request('session.message', { sessionId: full.id, text: 'steer-marker change course' }), refusedMode);
  await assert.rejects(viewer.request('session.prompt', { sessionId: full.id, clientMessageId: 'v1', content: text('prompt-marker') }), refusedMode);
  await local.request('session.interrupt', { sessionId: full.id });
  await until(() => ends() >= 1, 'the held turn ended');
  // Asking: an answer would let the full-access turn go on.
  await local.request('session.prompt', { sessionId: full.id, clientMessageId: 'ask', content: text('need input [ask]') });
  await until(async () => (await local.request('question.list', {})).questions.some(question => question.sessionId === full.id), 'the question to the user');
  const [question] = (await viewer.request('question.list', {})).questions;
  assert.equal(question.sessionId, full.id, 'the viewer sees the question: it is in its workspace');
  await assert.rejects(viewer.request('question.answer', { questionId: question.id, text: 'answer-marker yes' }), refusedMode);
  await assert.rejects(viewer.request('question.answer', { questionId: question.id, dismiss: true }), refusedMode);
  await sleep(300);
  assert.equal((await local.request('question.list', {})).questions.length, 1, 'the question still waits');
  for (const marker of ['wake-marker', 'steer-marker', 'prompt-marker', 'answer-marker']) assert.equal(await reachedProvider(marker), false, `${marker} reached the provider`);
  assert.equal(ends(), 1, 'no turn ran for the viewer');
  // The owner answers locally; the turn goes on and ends.
  await local.request('question.answer', { questionId: question.id, text: 'local yes' });
  await until(() => ends() >= 2, 'the asking turn ended after the local answer');
  // Stopping the full-access root is still allowed.
  assert.deepEqual(await viewer.request('session.interrupt', { sessionId: full.id }), {});

  // The viewer's own read-only tree: a message wakes it, an answer lets it go on.
  const own = [];
  viewer.onEvent(envelope => own.push(envelope));
  const { session: mine } = await viewer.request('session.create', { spec: { cwd: w.projects.a, persist: true, model: MODEL, mode: 'read-only' }, history: 'skip' });
  const mineEnded = () => own.filter(envelope => envelope.sessionId === mine.id && envelope.event.type === 'turn.ended').length;
  assert.deepEqual(await viewer.request('session.message', { sessionId: mine.id, text: 'own-wake-marker' }), {});
  await until(() => reachedProvider('own-wake-marker'), 'the message woke the read-only session');
  await until(() => mineEnded() >= 1, 'its turn ended');
  await viewer.request('session.prompt', { sessionId: mine.id, clientMessageId: 'own-ask', content: text('own [ask]') });
  await until(async () => (await viewer.request('question.list', {})).questions.some(row => row.sessionId === mine.id), 'its question');
  const asked = (await viewer.request('question.list', {})).questions.find(row => row.sessionId === mine.id);
  assert.equal((await viewer.request('question.answer', { questionId: asked.id, text: 'own-answer' })).questionId, asked.id);
  await until(() => mineEnded() >= 2, 'its asking turn ended after the answer');
});

// docs/alp/remote-gateway.md §5.4: entry content leaves through the gateway's projection only; rows carry names.
test('project.read gets no MCP, hook or provider secret from a real alpd: library.get answers them hidden and rows carry names only', { skip, timeout: 60_000 }, async t => {
  const w = await world(t);
  const SENTINELS = ['SENTINEL-userinfo', 'SENTINEL-query', 'SENTINEL-header', 'SENTINEL-arg', 'SENTINEL-env', 'SENTINEL-hook', 'SENTINEL-provider-arg', 'SENTINEL-provider-env'];
  const a = w.projects.a;
  await mkdir(path.join(a, '.alp/mcp'), { recursive: true });
  await mkdir(path.join(a, '.alp/hooks'), { recursive: true });
  await mkdir(path.join(w.home, 'providers'), { recursive: true });
  await writeFile(path.join(a, '.alp/mcp/remote.json'), JSON.stringify({ url: 'https://alice:SENTINEL-userinfo@mcp.example.test/sse?token=SENTINEL-query', headers: { Authorization: 'Bearer SENTINEL-header' } }));
  await writeFile(path.join(a, '.alp/mcp/local.json'), JSON.stringify({ command: 'npx', args: ['server', '--api-key', 'SENTINEL-arg'], env: { API_KEY: 'SENTINEL-env' } }));
  await writeFile(path.join(a, '.alp/hooks/notify.json'), JSON.stringify({ event: 'turn.end', command: "curl -H 'Authorization: SENTINEL-hook' https://hooks.example.test" }));
  await writeFile(path.join(w.home, 'providers/custom.json'), JSON.stringify({ kind: 'acp', label: 'Custom', command: 'custom-agent', args: ['--key', 'SENTINEL-provider-arg'], env: { KEY: 'SENTINEL-provider-env' }, models: [{ id: 'vendor-model' }] }));

  // What alpd answers a local client: the fixture holds secrets alpd itself does not redact.
  const local = new AlpRpcClient(await connectSocket(w.socket));
  t.after(() => local.close());
  await hello(local);
  const direct = JSON.stringify([
    await local.request('library.get', { kind: 'mcp', name: 'remote', projectRoot: a, scope: 'project' }),
    await local.request('library.get', { kind: 'mcp', name: 'local', projectRoot: a, scope: 'project' }),
    await local.request('library.get', { kind: 'hooks', name: 'notify', projectRoot: a, scope: 'project' }),
  ]);
  for (const sentinel of ['SENTINEL-userinfo', 'SENTINEL-query', 'SENTINEL-arg', 'SENTINEL-hook']) assert.ok(direct.includes(sentinel), `alpd answers ${sentinel} locally`);

  const reader = new AlpRpcClient(await w.open(w.tokens.reader));
  t.after(() => reader.close());
  await hello(reader);
  const MARK = { $secret: 'keep' };
  const entries = [];
  for (const params of [{ kind: 'mcp', name: 'remote', projectRoot: a, scope: 'project' }, { kind: 'mcp', name: 'local', projectRoot: a, scope: 'project' }, { kind: 'hooks', name: 'notify', projectRoot: a, scope: 'project' }, { kind: 'mcp', name: 'remote', projectRoot: a }, { kind: 'providers', name: 'custom', projectRoot: a }]) {
    entries.push(await reader.request('library.get', params));
  }
  assert.deepEqual(entries.map(entry => entry.content), [
    { server: { url: MARK, headers: { Authorization: MARK } } },
    { server: { command: 'npx', args: [MARK, MARK, MARK], env: { API_KEY: MARK } } },
    { hook: { event: 'turn.end', command: MARK } },
    { server: { url: MARK, headers: { Authorization: MARK } } },
    { provider: { kind: 'acp', label: 'Custom', command: 'custom-agent', args: [MARK, MARK], env: { KEY: MARK }, models: [{ id: 'vendor-model' }] } },
  ]);
  assert.deepEqual(entries[1].secrets, ['/server/args/0', '/server/args/1', '/server/args/2', '/server/env/API_KEY']);
  const answers = [...entries];
  for (const kind of ['mcp', 'hooks', 'agents', 'skills', 'providers']) answers.push(await reader.request('library.list', { kind, projectRoot: a }));
  answers.push(await reader.request('team.list', { projectRoot: a }), await reader.request('library.models'));
  const seen = JSON.stringify(answers);
  for (const sentinel of SENTINELS) assert.ok(!seen.includes(sentinel), `${sentinel} reached the remote client`);
  const [mcpRows, hookRows] = answers.slice(entries.length);
  assert.ok(mcpRows.entries.some(entry => entry.name === 'remote') && hookRows.entries.some(entry => entry.name === 'notify'), 'rows still name the entries');
  assert.ok(!seen.includes(w.home), 'no host library path');
  // The ACP model library.models lists is one a session may use.
  const acp = answers.at(-1).models.find(model => model.id === 'acp:custom/vendor-model');
  assert.ok(acp, 'library.models lists the provider\'s model');
  const owner = new AlpRpcClient(await w.open(w.tokens.alice));
  t.after(() => owner.close());
  await hello(owner);
  const { preview } = await owner.request('session.preview', { spec: { cwd: a, model: acp.id } });
  assert.equal(typeof preview, 'object');
});

// t-70c4: a library, settings or task file that does not parse makes a real alpd answer its host
// path and V8's quote of the file. Through the gateway the code and the reason remain.
test('a malformed library or task file reaches a remote client without its host path or content', { skip, timeout: 60_000 }, async t => {
  const w = await world(t);
  const a = w.projects.a;
  const broken = tag => `{"key": SENTINEL-${tag}-secret}`;
  await mkdir(path.join(w.home, 'providers'), { recursive: true });
  await mkdir(path.join(w.home, 'teams/broken'), { recursive: true });
  await mkdir(path.join(w.home, 'agents/broken'), { recursive: true });
  await mkdir(path.join(a, '.alp/tasks'), { recursive: true });
  await writeFile(path.join(w.home, 'providers/broken.json'), broken('provider'));
  await writeFile(path.join(w.home, 'teams/broken/team.json'), broken('team'));
  await writeFile(path.join(w.home, 'agents/broken/AGENT.md'), '# Broken');
  await writeFile(path.join(w.home, 'agents/broken/agent.json'), broken('agent'));
  await writeFile(path.join(a, '.alp/tasks/t-bad0.json'), broken('task'));
  const calls = [
    ['library.models', {}],
    ['library.get', { kind: 'providers', name: 'broken', projectRoot: a }],
    ['session.preview', { spec: { cwd: a, workflow: 'broken' } }],
    ['session.preview', { spec: { cwd: a, agent: 'broken' } }],
    ['session.preview', { spec: { cwd: a, model: 'acp:broken' } }],
  ];
  const answer = (client, method, params) => client.request(method, params).then(result => ({ result }), error => ({ code: error.code, message: error.message, data: error.data }));

  // A local client gets alpd's own message: the fixture does make alpd quote the files.
  const local = new AlpRpcClient(await connectSocket(w.socket));
  t.after(() => local.close());
  await hello(local);
  const direct = [];
  for (const [method, params] of calls) direct.push(await answer(local, method, params));
  direct.push(await answer(local, 'task.list', { projectRoot: a }));
  // V8 quotes about ten characters around the fault: here `SENTINEL-` and the tag's first letter.
  for (const [index, entry] of direct.entries()) {
    assert.ok(JSON.stringify(entry).includes('SENTINEL'), `alpd quotes the file to a local client: ${JSON.stringify(entry)}`);
    if (!entry.result) assert.ok(entry.message.includes(w.home), `alpd names the host path to a local client (${index})`);
  }

  const owner = new AlpRpcClient(await w.open(w.tokens.alice));
  t.after(() => owner.close());
  await hello(owner);
  const remote = [];
  for (const [method, params] of calls) remote.push(await answer(owner, method, params));
  const tasks = await owner.request('task.list', { projectRoot: a });
  const seen = JSON.stringify([remote, tasks]);
  assert.ok(!seen.includes('SENTINEL') && !seen.includes(w.home), seen);
  for (const [index, entry] of remote.entries()) assert.equal(typeof entry.code, 'number', `${calls[index][0]} still fails: ${JSON.stringify(entry)}`);
  assert.equal(remote[0].data?.reason, 'invalid_entry', 'the reason stays for the UI');
  // A session spec that fails on a library file says which entry, by the name the client sent.
  assert.deepEqual(remote.slice(2).map(entry => entry.message), [
    "Team 'broken' has a configuration the daemon host cannot read",
    "Agent 'broken' has a configuration the daemon host cannot read",
    "Provider 'broken' has a configuration the daemon host cannot read",
  ]);
  assert.deepEqual(tasks.unreadable, [{ file: path.join('.alp', 'tasks', 't-bad0.json'), error: 'This task file cannot be read on the daemon host' }]);
});

// docs/protocol/alp-json-rpc-v1.md §12.2, §12.3 against a real alpd: a watch with turns hears a
// granted root's turn end and not another workspace's; file search lists names of the granted
// workspace only, never through a link out of it, and not for another credential's workspace.
test('question.watch turns and workspace.files.search stay in the grant on a real alpd', { skip, timeout: 60_000 }, async t => {
  const w = await world(t);
  const { symlink } = await import('node:fs/promises');
  await mkdir(path.join(w.projects.a, 'src'), { recursive: true });
  await writeFile(path.join(w.projects.a, 'src', 'server.ts'), 'x');
  await writeFile(path.join(w.projects.b, 'b-server.ts'), 'x');
  await symlink(w.projects.b, path.join(w.projects.a, 'to-b'));
  const owner = new AlpRpcClient(await w.open(w.tokens.alice));
  t.after(() => owner.close());
  await hello(owner);
  const watcher = new AlpRpcClient(await w.open(w.tokens.alice));
  t.after(() => watcher.close());
  await hello(watcher);
  const heard = [];
  watcher.onEvent(envelope => heard.push(envelope));
  await watcher.request('question.watch', { projectRoot: w.projects.a, turns: true, attention: true });
  const intruder = new AlpRpcClient(await w.open(w.tokens.bob));
  t.after(() => intruder.close());
  await hello(intruder);
  const leaked = [];
  intruder.onEvent(envelope => leaked.push(envelope));
  await intruder.request('question.watch', { turns: true, attention: true });

  const { session } = await owner.request('session.create', { spec: { cwd: w.projects.a, persist: true, model: MODEL }, history: 'skip' });
  await owner.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('hello') });
  await until(() => heard.some(envelope => envelope.event.type === 'turn.ended'), 'the watched turn end');
  const turn = heard.find(envelope => envelope.event.type === 'turn.ended');
  assert.equal(turn.sessionId, session.id);
  assert.equal(turn.cursor, undefined);
  assert.equal(turn.event.state, 'completed');
  // Issue #120: the host keeps the attention for every client of the grant, and a reader's look clears it.
  await until(() => heard.some(envelope => envelope.event.type === 'attention' && envelope.event.attention), 'the attention of a');
  const viewer = new AlpRpcClient(await w.open(w.tokens.reader));
  t.after(() => viewer.close());
  await hello(viewer);
  const { attention } = await viewer.request('question.watch', { projectRoot: w.projects.a, attention: true });
  assert.deepEqual(attention.map(entry => [entry.sessionId, entry.attention.reason]), [[session.id, 'finished']], 'a client that came later reads it');
  assert.deepEqual((await intruder.request('question.watch', { attention: true })).attention, [], 'not another credential\'s');
  assert.deepEqual(await viewer.request('session.attention.clear', { sessionId: session.id, at: attention[0].attention.at }), { cleared: true });
  await until(() => heard.some(envelope => envelope.event.type === 'attention' && !envelope.event.attention), 'cleared for the other client');
  await sleep(200);
  assert.deepEqual(leaked, [], 'another credential hears nothing of a');

  const files = (await owner.request('workspace.files.search', { projectRoot: w.projects.a, query: 'server', limit: 100 })).files.map(file => file.path);
  assert.deepEqual(files, ['src/server.ts'], 'b\'s file behind the link is not listed');
  await assert.rejects(owner.request('workspace.files.search', { projectRoot: w.projects.b }), error => error.code === 1003);
  await assert.rejects(intruder.request('workspace.files.search', { projectRoot: w.projects.a }), error => error.code === 1003);
  assert.deepEqual((await viewer.request('workspace.files.search', { projectRoot: w.projects.a, query: 'server.ts' })).files, [{ path: 'src/server.ts' }]);
});

// docs/protocol/alp-json-rpc-v1.md §12.4, docs/alp/remote-gateway.md §5.10 against a real alpd: only
// a credential holding files.read lists and reads, within its workspace; blocked files, links out
// of it, a hard link and .gitignore'd files are refused by alpd or the gateway, with fixed text:
// no host path and no quote of a file reaches the client.
test('workspace.files.list and read stay in the grant and the block list on a real alpd', { skip, timeout: 60_000 }, async t => {
  const w = await world(t);
  const { link, symlink } = await import('node:fs/promises');
  await mkdir(path.join(w.projects.a, 'src'), { recursive: true });
  await writeFile(path.join(w.projects.a, 'src', 'server.ts'), 'export const port = 1;\n');
  await writeFile(path.join(w.projects.a, '.env'), 'TOKEN=SENTINEL-env');
  await writeFile(path.join(w.projects.a, 'tls.key'), 'SENTINEL-key');
  await writeFile(path.join(w.projects.a, 'id_github'), 'SENTINEL-ssh');
  await writeFile(path.join(w.projects.a, 'deploy.txt'), '-----BEGIN OPENSSH PRIVATE KEY-----\nSENTINEL-pem\n-----END OPENSSH PRIVATE KEY-----\n');
  // alpd asks git which files .gitignore hides: a is a repository.
  (await import('node:child_process')).execFileSync('git', ['init', '-q'], { cwd: w.projects.a, stdio: 'ignore' });
  await writeFile(path.join(w.projects.a, '.gitignore'), 'secret-notes.txt\n');
  await writeFile(path.join(w.projects.a, 'secret-notes.txt'), 'SENTINEL-ignored');
  await writeFile(path.join(w.projects.b, 'b.txt'), 'SENTINEL-b');
  await symlink(path.join(w.projects.b, 'b.txt'), path.join(w.projects.a, 'to-b.txt'));
  await link(path.join(w.projects.b, 'b.txt'), path.join(w.projects.a, 'hard-b.txt'));
  const reader = new AlpRpcClient(await w.open(w.tokens.files));
  t.after(() => reader.close());
  assert.ok((await hello(reader)).capabilities.includes('workspace.files.read'));
  const root = (await reader.request('workspace.files.list', { projectRoot: w.projects.a })).entries.map(entry => entry.path);
  assert.ok(root.includes('src') && root.includes('.gitignore') && root.includes('hard-b.txt'), root.join());
  for (const hidden of ['.env', '.alp', 'tls.key', 'id_github', 'to-b.txt', 'secret-notes.txt']) assert.ok(!root.includes(hidden), hidden);
  assert.deepEqual(await reader.request('workspace.files.read', { projectRoot: w.projects.a, path: 'src/server.ts' }).then(({ modifiedAt, ...rest }) => rest), { path: 'src/server.ts', content: 'export const port = 1;\n', size: 23 });
  const refusal = async (client, method, params) => {
    const error = await client.request(method, params).then(() => assert.fail(`${method} ${JSON.stringify(params)}`), caught => caught);
    const seen = JSON.stringify({ message: error.message, data: error.data });
    for (const host of [w.projects.a, w.projects.b, w.home]) assert.ok(!seen.includes(host), `no host path: ${seen}`);
    assert.ok(!seen.includes('SENTINEL'), `no file content: ${seen}`);
    return [error.code, error.data?.reason];
  };
  assert.deepEqual(await refusal(reader, 'workspace.files.read', { projectRoot: w.projects.a, path: '.env' }), [1003, 'blocked_path']);
  assert.deepEqual(await refusal(reader, 'workspace.files.read', { projectRoot: w.projects.a, path: 'tls.key' }), [1003, 'blocked_path']);
  assert.deepEqual(await refusal(reader, 'workspace.files.read', { projectRoot: w.projects.a, path: '.alp/settings.json' }), [1003, 'blocked_path']);
  assert.deepEqual(await refusal(reader, 'workspace.files.read', { projectRoot: w.projects.a, path: 'id_github' }), [1003, 'blocked_path']);
  assert.deepEqual(await refusal(reader, 'workspace.files.read', { projectRoot: w.projects.a, path: 'deploy.txt' }), [1003, 'blocked_path'], 'a private key under an ordinary name');
  assert.deepEqual(await refusal(reader, 'workspace.files.read', { projectRoot: w.projects.a, path: 'to-b.txt' }), [1003, 'linked']);
  assert.deepEqual(await refusal(reader, 'workspace.files.read', { projectRoot: w.projects.a, path: 'hard-b.txt' }), [1003, 'linked']);
  assert.deepEqual(await refusal(reader, 'workspace.files.read', { projectRoot: w.projects.a, path: 'secret-notes.txt' }), [1003, 'ignored']);
  assert.equal((await reader.request('workspace.files.read', { projectRoot: w.projects.a, path: 'secret-notes.txt', includeIgnored: true })).content, 'SENTINEL-ignored', 'shown when asked for');
  assert.deepEqual(await refusal(reader, 'workspace.files.read', { projectRoot: w.projects.a, path: 'missing.txt' }), [1001, 'not_found']);
  assert.deepEqual(await refusal(reader, 'workspace.files.read', { projectRoot: w.projects.a, path: '../b/b.txt' }), [-32602, 'invalid_path']);
  assert.deepEqual(await refusal(reader, 'workspace.files.read', { projectRoot: w.projects.b, path: 'b.txt' }), [1003, 'outside_workspace']);
  // Without files.read: the default permissions are refused, alpd never asked.
  const owner = new AlpRpcClient(await w.open(w.tokens.alice));
  t.after(() => owner.close());
  await hello(owner);
  assert.deepEqual(await refusal(owner, 'workspace.files.read', { projectRoot: w.projects.a, path: 'src/server.ts' }), [1003, 'grant']);
  assert.deepEqual(await refusal(owner, 'workspace.files.list', { projectRoot: w.projects.a }), [1003, 'grant']);
  // Another credential's workspace: its own files only.
  const other = new AlpRpcClient(await w.open(w.tokens.bobFiles));
  t.after(() => other.close());
  await hello(other);
  assert.deepEqual(await refusal(other, 'workspace.files.list', { projectRoot: w.projects.a }), [1003, 'outside_workspace']);
  // b.txt has a second name in a (the hard link above), so it is refused in b as well; another file reads.
  assert.deepEqual(await refusal(other, 'workspace.files.read', { projectRoot: w.projects.b, path: 'b.txt' }), [1003, 'linked']);
  await writeFile(path.join(w.projects.b, 'notes.md'), '# b');
  assert.equal((await other.request('workspace.files.read', { projectRoot: w.projects.b, path: 'notes.md' })).content, '# b');
});

test('attachments through the gateway on a real alpd: upload, commit, get; an honest refusal from today\'s runtime; binding, deletion and revocation', { skip, timeout: 60_000 }, async t => {
  const w = await world(t);
  const { createHash } = await import('node:crypto');
  const { readdir, stat } = await import('node:fs/promises');
  const client = new AlpRpcClient(await w.open(w.tokens.uploader));
  t.after(() => client.close());
  const greeting = await hello(client);
  assert.ok(greeting.capabilities.includes('attachments'));
  assert.equal(greeting.attachmentLimits.maxChunkBytes, 256 * 1024);
  const { session } = await client.request('session.create', { spec: { cwd: w.projects.a, model: MODEL, persist: true } });
  const data = Buffer.from('%PDF-1.4\n' + 'page '.repeat(70_000));
  const sha256 = createHash('sha256').update(data).digest('hex');
  const begun = await client.request('attachment.begin', { sessionId: session.id, name: '../Report\u202E.pdf', size: data.length, mimeType: 'application/pdf', sha256, requestId: 'r1' });
  for (let offset = 0; offset < data.length; offset += greeting.attachmentLimits.maxChunkBytes) {
    await client.request('attachment.chunk', { uploadId: begun.uploadId, offset, data: data.subarray(offset, offset + greeting.attachmentLimits.maxChunkBytes).toString('base64') });
  }
  const { attachment } = await client.request('attachment.commit', { uploadId: begun.uploadId, sha256 });
  assert.deepEqual([attachment.name, attachment.size, attachment.sha256, attachment.detectedMimeType, attachment.referenced], ['..Report.pdf', data.length, sha256, 'application/pdf', false]);
  assert.deepEqual((await client.request('attachment.get', { attachmentId: attachment.attachmentId })).attachment, attachment);
  const seen = JSON.stringify([begun, attachment]);
  for (const host of [w.home, w.projects.a]) assert.ok(!seen.includes(host), 'no host path');
  // Stored by alpd under its own id, private, read-only.
  const stored = path.join(w.home, 'state', 'attachments', attachment.attachmentId.slice(4));
  assert.equal((await stat(path.join(stored, 'payload'))).mode & 0o777, 0o400);
  assert.deepEqual(await readFile(path.join(stored, 'payload')), data);
  // Today's runtimes cannot read attachments: refused before anything is sent, the file kept.
  const refused = await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: [{ type: 'text', text: 'Summarise' }, { type: 'attachment', attachmentId: attachment.attachmentId }] }).catch(error => error);
  assert.deepEqual([refused.code, refused.data?.reason], [1005, 'attachment_unsupported']);
  assert.ok(!(await w.journal()).includes('Summarise'), 'nothing reached the provider');
  // Another credential (another workspace, another principal) cannot see or use it: as an unknown id.
  const bob = new AlpRpcClient(await w.open(w.tokens.bobUploader));
  t.after(() => bob.close());
  await hello(bob);
  const foreign = await bob.request('attachment.get', { attachmentId: attachment.attachmentId }).catch(error => error);
  const unknown = await bob.request('attachment.get', { attachmentId: `att_${'0'.repeat(32)}` }).catch(error => error);
  assert.deepEqual([foreign.code, foreign.data, foreign.message], [unknown.code, unknown.data, unknown.message]);
  assert.equal(foreign.code, 1001);
  assert.equal((await bob.request('attachment.begin', { sessionId: session.id, name: 'x', size: 1, mimeType: 'text/plain', requestId: 'b' }).catch(error => error)).code, 1001, 'a session outside its grant');
  assert.deepEqual(await client.request('attachment.delete', { attachmentId: attachment.attachmentId }), { deleted: true });
  assert.ok(!(await readdir(path.join(w.home, 'state', 'attachments'))).includes(attachment.attachmentId.slice(4)));

  // Revoked mid-upload: the connection ends, the token gets no ticket, no one else can finish it.
  const pending = await client.request('attachment.begin', { sessionId: session.id, name: 'half.bin', size: 8, mimeType: 'application/octet-stream', requestId: 'r2' });
  await client.request('attachment.chunk', { uploadId: pending.uploadId, offset: 0, data: Buffer.from('1234').toString('base64') });
  const closed = new Promise(resolve => client.onClose(resolve));
  await revokeCredential(w.gatewayHome, w.ids.uploader);
  await closed;
  await assert.rejects(w.open(w.tokens.uploader), /ticket refused: 401/);
  const finish = await bob.request('attachment.commit', { uploadId: pending.uploadId, sha256 }).catch(error => error);
  assert.equal(finish.code, 1001);
});
