// The Paseo remote mode end to end (docs/alp/paseo-remote.md §6): three processes that share no
// files. alpd runs with its own ALP_HOME (A) and a fake Codex; the gateway CLI serves it; the Paseo
// side (the built remote entry, test/integration/support/paseo-remote-client.mjs) runs with another
// home (B) under Node's permission model: it may read the code and use the network, nothing else,
// so it cannot read A or the project, and cannot start a process. Through it: authentication,
// catalog, create, prompt and stream, a question answered and one dismissed, tasks, the library
// list and the refusals of what remote mode does not have, interrupt, a gateway restart and an alpd
// restart with replay after the last cursor and no repeated item, and a mode-limited credential.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initProject } from '../../packages/core/src/init.js';
import { connectSocket, readLock } from '../../packages/client/src/index.js';
import { AlpRpcClient, hello } from '../../packages/client/src/portable.js';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ALPD = path.join(ROOT, 'packages/daemon/dist/alpd.js');
const GATEWAY = path.join(ROOT, 'apps/gateway/src/cli.js');
const CLIENT = path.join(ROOT, 'test/integration/support/paseo-remote-client.mjs');
const REMOTE_ENTRY = path.join(ROOT, 'integrations/paseo/server/dist/remote/index.js');
const FAKE_CODEX = path.join(ROOT, 'packages/daemon/tests/support/fake-codex.js');
const flags = process.allowedNodeEnvironmentFlags;
const skip = process.platform === 'win32' ? 'the fake provider is a Node script run as an executable'
  : !flags.has('--permission') && !flags.has('--experimental-permission') ? 'this Node has no permission model' : false;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(20); }
  assert.fail(`${what} never happened`);
}

const freePort = () => new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });

async function world(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-paseo-remote-')));
  const hostHome = path.join(base, 'host-home');
  const clientHome = path.join(base, 'client-home');
  const project = path.join(base, 'project');
  await mkdir(hostHome, { mode: 0o700 });
  await mkdir(clientHome, { mode: 0o700 });
  await writeFile(path.join(hostHome, 'settings.json'), '{}');
  await initProject(project);
  // Phở's main runs on Codex here, which the fake app-server stands in for.
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false }, team: { pho: { main: { profiles: ['codex:gpt-5.6-sol'] } } } }));
  const journal = path.join(base, 'codex.jsonl');
  const hostEnv = { PATH: process.env.PATH, HOME: hostHome, ALP_HOME: hostHome, ALP_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_JOURNAL: journal };
  const children = new Set();
  t.after(async () => {
    for (const child of children) { try { process.kill(child.detached ? -child.pid : child.pid, 'SIGTERM'); } catch {} }
    await sleep(300);
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  let alpd;
  async function startDaemon() {
    const log = openSync(path.join(base, 'alpd.log'), 'a');
    alpd = spawn(process.execPath, [ALPD], { env: hostEnv, stdio: ['ignore', log, log], detached: true });
    alpd.detached = true;
    children.add(alpd);
    closeSync(log);
    await until(async () => { const lock = await readLock(hostHome); return lock?.ready && lock.pid === alpd.pid; }, 'alpd ready');
  }
  async function stopDaemon() {
    const exited = once(alpd, 'exit');
    process.kill(-alpd.pid, 'SIGTERM');
    await exited;
    children.delete(alpd);
  }
  await startDaemon();

  const cli = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [GATEWAY, ...args], { env: hostEnv });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('exit', code => code === 0 ? resolve(stdout) : reject(new Error(`alp-gateway ${args[0]} exited ${code}`)));
  });
  const credential = async (label, extra = []) => JSON.parse(await cli('credential', 'create', '--label', label, '--workspace', project, '--json', ...extra)).token;
  const tokens = { owner: await credential('owner'), viewer: await credential('viewer', ['--mode', 'read-only']) };

  const port = await freePort();
  const gatewayLog = [];
  let gateway;
  async function startGateway() {
    gateway = spawn(process.execPath, [GATEWAY, 'serve', '--port', String(port)], { env: hostEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(gateway);
    gateway.stderr.on('data', chunk => gatewayLog.push(String(chunk)));
    const [line] = await once(createInterface({ input: gateway.stdout }), 'line');
    assert.match(JSON.parse(line).listening, /^http:\/\/127\.0\.0\.1:/);
    await until(async () => (await fetch(`http://127.0.0.1:${port}/readyz`).catch(() => ({ status: 0 }))).status === 200, 'gateway ready');
  }
  async function stopGateway() {
    const exited = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    await exited;
    children.delete(gateway);
  }
  await startGateway();

  /** The Paseo side, in its own process with its own home, allowed to read the code only. */
  function client(token) {
    const permission = flags.has('--permission') ? '--permission' : '--experimental-permission';
    const args = [permission, `--allow-fs-read=${ROOT}`, ...(flags.has('--allow-net') ? ['--allow-net'] : []), CLIENT];
    const child = spawn(process.execPath, args, {
      env: { PATH: process.env.PATH, HOME: clientHome, ALP_HOME: clientHome, ALP_GATEWAY_URL: `http://127.0.0.1:${port}`, ALP_GATEWAY_TOKEN: token, ALP_REMOTE_ENTRY: pathToFileURL(REMOTE_ENTRY).href },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child);
    const events = [];
    const waiting = new Map();
    const output = [];
    let next = 0;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    createInterface({ input: child.stdout }).on('line', line => {
      output.push(line);
      const message = JSON.parse(line);
      if (message.event) events.push(message.event);
      else waiting.get(message.id)?.(message);
    });
    const call = (op, args = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      waiting.set(id, message => { waiting.delete(id); message.ok ? resolve(message.result) : reject(Object.assign(new Error(message.error.message), message.error)); });
      child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`);
    });
    return { call, events, output, stderr: () => stderr, child };
  }

  const turnStarts = async () => (await readFile(journal, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.method === 'turn/start');
  return { base, hostHome, clientHome, project, port, tokens, gatewayLog, client, turnStarts, startDaemon, stopDaemon, startGateway, stopGateway, socket: async () => (await readLock(hostHome)).socket };
}

const config = (cwd, extra = {}) => ({ cwd, model: 'pho', mode: 'workspace-write', settings: {}, env: {}, mcpServers: {}, persist: true, ...extra });
const prompt = (sessionId, clientMessageId, text) => ({ type: 'session.prompt', sessionId, prompt: { clientMessageId, delivery: 'auto', input: { type: 'message', content: [{ type: 'text', text }] } } });
const turnsEnded = (events, sessionId) => events.filter(event => event.type === 'session.turn' && event.sessionId === sessionId && event.state !== 'started');

test('Paseo remote mode through the gateway to a real alpd: create, stream, questions, tasks, refusals, restarts and replay', { skip, timeout: 180_000 }, async t => {
  const w = await world(t);
  const paseo = w.client(w.tokens.owner);

  // The client process cannot read alpd's home or the project, nor start a process.
  const probe = await paseo.call('probe', { paths: [path.join(w.hostHome, 'settings.json'), path.join(w.project, '.alp/settings.json')] });
  assert.deepEqual(Object.values(probe.reads), ['ERR_ACCESS_DENIED', 'ERR_ACCESS_DENIED']);
  assert.equal(probe.spawn, 'ERR_ACCESS_DENIED');
  assert.equal(probe.home, w.clientHome);

  // Authentication and handshake through the gateway; the catalog lists alpd's teams.
  await paseo.call('connect');
  await paseo.call('send', { input: { type: 'catalog', requestId: 'catalog', cwd: w.project } });
  const catalog = paseo.events.find(event => event.type === 'catalog');
  assert.ok(catalog.catalog.models.some(model => model.id === 'pho'), JSON.stringify(catalog.catalog.models));
  assert.deepEqual(catalog.catalog.modes.map(mode => mode.id), ['read-only', 'workspace-write', 'full-access']);

  // Create: Paseo's environment is not sent, and the user is told.
  await paseo.call('send', { input: { type: 'session.open', requestId: 'open', sessionId: 'p1', config: config(w.project, { env: { PASEO_ONLY: '1' } }), history: 'skip' } });
  await until(() => paseo.events.some(event => event.type === 'session.ready' && event.sessionId === 'p1'), 'the session is ready');
  assert.ok(paseo.events.some(event => event.type === 'timeline.item' && event.item.type === 'notification' && /environment variables stay on this machine/.test(event.item.message)));
  const opened = paseo.events.find(event => event.type === 'session.opened' && event.sessionId === 'p1');
  assert.equal(opened.persistence.version, 2);

  // Prompt and stream.
  await paseo.call('send', { input: prompt('p1', 'm1', 'first') });
  await until(() => turnsEnded(paseo.events, 'p1').length >= 1, 'the first turn ended');
  assert.ok(paseo.events.some(event => event.type === 'session.prompt_result' && event.clientMessageId === 'm1' && event.result.type === 'turn'));
  assert.ok(paseo.events.some(event => event.type === 'timeline.item' && event.sessionId === 'p1' && event.item.type === 'assistant_message'));

  // A question to the user (alp_ask through the real runtime): answered, then one dismissed.
  for (const [n, behavior] of [[2, 'allow'], [3, 'deny']]) {
    await paseo.call('send', { input: prompt('p1', `ask${n}`, `need input ${n} [ask]`) });
    await until(() => paseo.events.filter(event => event.type === 'session.permission').length >= n - 1, `question ${n}`);
    const asked = paseo.events.filter(event => event.type === 'session.permission').at(-1);
    const response = behavior === 'allow' ? { behavior: 'allow', updatedInput: { answers: { Answer: 'go ahead' } } } : { behavior: 'deny', message: 'not now' };
    await paseo.call('send', { input: { type: 'session.permission', sessionId: 'p1', permissionId: asked.request.id, response } });
    await until(() => paseo.events.some(event => event.type === 'session.permission_resolved' && event.permissionId === asked.request.id), `question ${n} resolved`);
    await until(() => turnsEnded(paseo.events, 'p1').length >= n, `the asking turn ${n} ended`);
  }

  // Tasks through alpd: add, list, close.
  const { id: task } = await paseo.call('panel', { name: 'alp.tasks.add', input: { directory: w.project, title: 'remote task' } });
  const listed = await paseo.call('panel', { name: 'alp.tasks.list', input: { directory: w.project } });
  assert.equal(listed.projectRoot, w.project);
  assert.deepEqual(listed.tasks.map(row => row.id), [task]);
  assert.equal((await paseo.call('panel', { name: 'alp.tasks.change', input: { directory: w.project, id: task, action: 'close' } })).status, 'closed');
  assert.deepEqual((await paseo.call('panel', { name: 'alp.tasks.list', input: { directory: w.project } })).tasks.map(row => row.status), ['closed']);

  // Library: names and models come from alpd; content, edits, tests and usage are refused clearly.
  assert.ok((await paseo.call('panel', { name: 'alp.library.list', input: { directory: w.project, kind: 'agents' } })).entries.length > 0);
  assert.ok((await paseo.call('panel', { name: 'alp.library.models', input: {} })).models.length > 0);
  assert.equal(typeof (await paseo.call('panel', { name: 'alp.settings.language.get', input: {} })).applies, 'string');
  for (const [name, input] of [
    ['alp.library.get', { directory: w.project, kind: 'mcp', name: 'x' }],
    ['alp.library.save', { directory: w.project, kind: 'skills', name: 'x', scope: 'project', content: {} }],
    ['alp.library.test', { directory: w.project, kind: 'hooks', name: 'x' }],
    ['alp.settings.language.set', { language: 'English' }],
    ['alp.usage.get', {}],
  ]) await assert.rejects(paseo.call('panel', { name, input }), /Unavailable in ALP remote mode/, name);

  // Interrupt a running turn.
  await paseo.call('send', { input: prompt('p1', 'hold1', 'long [hold]') });
  await until(async () => (await w.turnStarts()).some(entry => entry.text?.includes('long [hold]')), 'the held turn reached the provider');
  await paseo.call('send', { input: { type: 'session.interrupt', requestId: 'stop', sessionId: 'p1' } });
  await until(() => turnsEnded(paseo.events, 'p1').some(event => event.state === 'canceled'), 'the held turn was canceled');

  // The gateway restarts while a turn runs; the turn ends meanwhile (a local client on the host
  // interrupts it). The client reconnects with a new ticket and gets the end by replay, once.
  const before = turnsEnded(paseo.events, 'p1').length;
  await paseo.call('send', { input: prompt('p1', 'hold2', 'longer [hold]') });
  await until(async () => (await w.turnStarts()).some(entry => entry.text?.includes('longer [hold]')), 'the second held turn reached the provider');
  await w.stopGateway();
  const local = new AlpRpcClient(await connectSocket(await w.socket()));
  await hello(local);
  const [root] = (await local.request('session.list', { rootsOnly: true })).sessions;
  await local.request('session.interrupt', { sessionId: root.id });
  local.close();
  await sleep(300);
  assert.equal(turnsEnded(paseo.events, 'p1').length, before, 'the end happened while the client was away');
  await w.startGateway();
  await until(() => paseo.events.some(event => event.type === 'timeline.item' && /reconnected/.test(event.item.message ?? '')), 'the client reconnected');
  await until(() => turnsEnded(paseo.events, 'p1').length === before + 1, 'the turn end arrived by replay');
  await sleep(300);
  assert.equal(turnsEnded(paseo.events, 'p1').length, before + 1, 'and only once');

  // alpd restarts: the client reconnects, and the next prompt reopens the session.
  await w.stopDaemon();
  await w.startDaemon();
  await until(() => paseo.events.filter(event => event.type === 'timeline.item' && /reconnected/.test(event.item.message ?? '')).length >= 2, 'the client reconnected after alpd restarted', 40_000);
  const ended = turnsEnded(paseo.events, 'p1').length;
  await paseo.call('send', { input: prompt('p1', 'after', 'after restart') });
  await until(() => turnsEnded(paseo.events, 'p1').length > ended, 'a turn after alpd restarted');

  // No item twice, and every prompt reached the provider once.
  const items = paseo.events.filter(event => event.type === 'timeline.item' && event.item.type !== 'notification').map(event => `${event.sessionId}:${event.item.id}`);
  assert.equal(new Set(items).size, items.length, 'no timeline item repeated');
  const starts = await w.turnStarts();
  for (const text of ['first', 'need input 2', 'need input 3', 'long [hold]', 'longer [hold]', 'after restart']) assert.equal(starts.filter(entry => entry.text?.includes(text)).length, 1, text);

  // No credential in what the client printed or the gateway logged.
  const secret = w.tokens.owner.split('.').at(-1);
  assert.ok(!paseo.output.join('\n').includes(secret) && !w.gatewayLog.join('').includes(secret));
  await paseo.call('close');
});

test('a mode-limited credential is refused a full-access session and works within its mode, and a folder outside the grant is refused', { skip, timeout: 60_000 }, async t => {
  const w = await world(t);
  const paseo = w.client(w.tokens.viewer);
  await paseo.call('connect');
  await paseo.call('send', { input: { type: 'catalog', requestId: 'catalog', cwd: w.project } });
  assert.deepEqual(paseo.events.find(event => event.type === 'catalog').catalog.modes.map(mode => mode.id), ['read-only']);
  await paseo.call('send', { input: { type: 'session.open', requestId: 'wide', sessionId: 'v1', config: config(w.project, { mode: 'full-access' }), history: 'skip' } });
  await until(() => paseo.events.some(event => event.type === 'request.failed' && event.requestId === 'wide'), 'the full-access open is refused');
  assert.match(paseo.events.find(event => event.type === 'request.failed' && event.requestId === 'wide').error.message, /modes read-only/);
  await paseo.call('send', { input: { type: 'session.open', requestId: 'elsewhere', sessionId: 'v2', config: config(w.base, { mode: 'read-only' }), history: 'skip' } });
  await until(() => paseo.events.some(event => event.type === 'request.failed' && event.requestId === 'elsewhere'), 'a folder outside the grant is refused');
  assert.match(paseo.events.find(event => event.type === 'request.failed' && event.requestId === 'elsewhere').error.message, /not a workspace your ALP credential grants/);
  await paseo.call('send', { input: { type: 'session.open', requestId: 'narrow', sessionId: 'v3', config: config(w.project, { mode: 'read-only' }), history: 'skip' } });
  await until(() => paseo.events.some(event => event.type === 'session.ready' && event.sessionId === 'v3'), 'the read-only session is ready');
  await paseo.call('send', { input: prompt('v3', 'r1', 'read only work') });
  await until(() => turnsEnded(paseo.events, 'v3').length >= 1, 'its turn ended');
  assert.deepEqual((await w.turnStarts()).filter(entry => entry.text?.includes('read only work')).length, 1);
  await paseo.call('close');
});
