// Terminals (docs/protocol/alp-json-rpc-v1.md §12.10, issue #121 branch H): a real PTY through alpd,
// in process, with a real store and registry. The host switch, the principal binding, the limits,
// replay and gaps, reconnect, revocation and cleanup are checked against real shells, and every
// test ends with no process of any terminal left alive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { CAPABILITY, TERMINAL } from '@anhlp/alp-protocol';
import { validateResult } from '@anhlp/alp-protocol/contract';
import { AlpRpcClient, hello } from '@anhlp/alp-client/portable';
import { createSocketTransport } from '@anhlp/alp-client/ipc';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { createTerminalService, frames, readTerminalConfig } from '@anhlp/alp-daemon/terminals';

const skip = !['darwin', 'linux'].includes(process.platform) && 'terminals are served on macOS and Linux only';
// A predictable shell: alpd picks $SHELL when /etc/shells lists it, else /bin/sh.
process.env.SHELL = '/bin/sh';
process.env.PS1 = 'PROMPT$ ';
process.env.ENV = '';

const alice = { principalId: 'aaaaaaaaaaaaaaaa', principalEpoch: 'e1' };
const bob = { principalId: 'bbbbbbbbbbbbbbbb', principalEpoch: 'e1' };

/** Every pid alive now with its process group (ps). */
function table() {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
  return rows.map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
}
/** The shell's process tree now: descendants and their process groups. */
function treeOf(pid) {
  const rows = table();
  const found = new Set([pid]);
  let grew = true;
  while (grew) { grew = false; for (const row of rows) if (!found.has(row.pid) && found.has(row.ppid)) { found.add(row.pid); grew = true; } }
  const groups = new Set(rows.filter(row => found.has(row.pid)).map(row => row.pgid));
  for (const row of rows) if (groups.has(row.pgid) && row.pgid !== process.pid) found.add(row.pid);
  return [...found];
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function until(check, what = 'condition', ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail(`${what} did not happen`);
}

async function refusal(promise) {
  try { await promise; } catch (error) { return { code: error.code, reason: error.data?.reason, message: error.message, data: error.data }; }
  assert.fail('expected a refusal');
}

/** A minimal runtime: these tests open no session. */
function idleTransport() {
  return () => ({ async initialize() {}, onNotification() {}, onFailure() {}, onRequest() {}, async close() {}, async request() { return {}; } });
}

/**
 * A home with two registered projects and alpd in process. `allow` writes the host switch. Every
 * pid a terminal ran is remembered; after the test none may be alive.
 */
async function setup(t, { allow = true, mode = 0o600, terminalOptions = {}, config = {} } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-term-')));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const project = path.join(directory, 'project');
  const other = path.join(directory, 'other');
  await initProject(project);
  await initProject(other);
  if (allow) await writeFile(path.join(home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true, ...config }), { mode });
  const seen = new Set();
  const logs = [];
  const runtime = createAlpRuntime({ transport: idleTransport(), runLogDir: path.join(directory, 'runs') });
  const store = createStore(path.join(home, 'state'));
  let spawned = 0;
  const { spawn: realSpawn } = await import('node-pty');
  const server = createDaemonServer({
    runtime, socketPath: path.join(directory, 's', 'alpd.sock'), version: 'test', store, home,
    terminalOptions: { sweepMs: 50, killGraceMs: 200, ...terminalOptions, spawn: (...args) => { spawned++; const pty = realSpawn(...args); seen.add(pty.pid); return pty; } },
  });
  await server.listen?.();
  const owner = server.local();
  await owner.request('daemon.status');
  await owner.request('project.register', { directory: project, ifRevision: 0, requestId: 'p1' });
  await owner.request('project.register', { directory: other, ifRevision: 1, requestId: 'p2' });
  const { workspaces } = await owner.request('workspace.list', {});
  const workspaceOf = async dir => workspaces.find(w => w.directory === dir || w.canonical === dir).id;
  const ws = await workspaceOf(project);
  const wsOther = await workspaceOf(other);
  /** A connection with its own terminal output per terminal id. */
  function connect() {
    const connection = server.local();
    const out = new Map();
    const events = [];
    connection.onNotification((method, params) => {
      if (method !== 'terminal.event') return;
      events.push(params);
      if (params.type === 'output') out.set(params.terminalId, (out.get(params.terminalId) ?? '') + params.data);
    });
    return { connection, out, events, request: (method, params) => connection.request(method, params), text: id => out.get(id) ?? '' };
  }
  let closed = false;
  const stop = async () => { if (closed) return; closed = true; owner.close(); await server.close().catch(() => {}); await runtime.shutdown?.(); };
  t.after(async () => {
    // Remember every process of every terminal before stopping, then prove none survived.
    for (const pid of [...seen]) if (alive(pid)) for (const child of treeOf(pid)) seen.add(child);
    await stop();
    await until(() => [...seen].every(pid => !alive(pid)), 'every terminal process gone');
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, home, project, other, ws, wsOther, server, owner, connect, stop, seen, logs, spawned: () => spawned };
}

async function open(world, as = alice, { cols = 80, rows = 24, workspaceId = world.ws } = {}) {
  const viewer = world.connect();
  const { terminal } = await viewer.request('terminal.create', { workspaceId, cols, rows, requestId: `r-${Math.random()}`, ...as });
  const attached = await viewer.request('terminal.attach', { terminalId: terminal.terminalId, ...as });
  assert.deepEqual(validateResult('terminal.attach', attached), []);
  await until(() => /PROMPT\$ $/.test(viewer.text(terminal.terminalId)), 'the first prompt');
  const type = data => viewer.request('terminal.input', { terminalId: terminal.terminalId, data, ...as });
  return { viewer, terminal, id: terminal.terminalId, type, text: () => viewer.text(terminal.terminalId) };
}

test('helpers: frames never split a character; the switch is a private file of this user', { skip }, async t => {
  assert.deepEqual(frames('abc', 10), ['abc']);
  const split = frames('é'.repeat(10), 5);
  assert.ok(split.every(piece => Buffer.byteLength(piece) <= 5));
  assert.equal(split.join(''), 'é'.repeat(10));
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-term-config-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal((await readTerminalConfig(home)).enabled, false, 'missing: off');
  const file = path.join(home, 'terminal.json');
  await writeFile(file, JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o644 });
  await chmod(file, 0o644);
  assert.deepEqual([(await readTerminalConfig(home)).enabled, (await readTerminalConfig(home)).reason], [false, 'not_private']);
  await chmod(file, 0o600);
  assert.deepEqual([(await readTerminalConfig(home)).enabled, (await readTerminalConfig(home)).paseo], [true, false], 'Paseo devices need their own opt-in');
  await writeFile(file, JSON.stringify({ version: 1, allowRemoteTerminal: true, allowPaseoTerminal: true }), { mode: 0o600 });
  assert.equal((await readTerminalConfig(home)).paseo, true);
  await writeFile(file, JSON.stringify({ version: 1, allowRemoteTerminal: false, allowPaseoTerminal: true }), { mode: 0o600 });
  assert.equal((await readTerminalConfig(home)).paseo, false, 'never without allowRemoteTerminal');
  await writeFile(file, JSON.stringify({ version: 1, allowRemoteTerminal: 'yes' }), { mode: 0o600 });
  assert.equal((await readTerminalConfig(home)).enabled, false, 'only true turns it on');
  await writeFile(file, JSON.stringify({ version: 1, allowRemoteTerminal: true, limits: { maxPerPrincipal: 2, maxPerDaemon: 99, idleMs: 0, bogus: 1 } }), { mode: 0o600 });
  const { limits } = await readTerminalConfig(home);
  assert.equal(limits.maxPerPrincipal, 2, 'lowered');
  assert.equal(limits.maxPerDaemon, TERMINAL.maxPerDaemon, 'never raised');
  assert.equal(limits.idleMs, TERMINAL.idleMs, 'zero ignored');
  await rm(file);
  await writeFile(path.join(home, 'elsewhere.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o600 });
  await symlink(path.join(home, 'elsewhere.json'), file);
  assert.equal((await readTerminalConfig(home)).enabled, false, 'a symlink is not the file');
});

test('off by default: no capability and no PTY is ever spawned', { skip }, async t => {
  const world = await setup(t, { allow: false });
  const viewer = world.connect();
  const helloed = await viewer.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(!helloed.capabilities.includes(CAPABILITY.terminal));
  assert.equal(helloed.terminalLimits, undefined);
  const refused = await refusal(viewer.request('terminal.create', { workspaceId: world.ws, cols: 80, rows: 24, requestId: 'r' }));
  assert.deepEqual([refused.code, refused.reason], [1005, 'terminal_disabled']);
  assert.equal(world.spawned(), 0);
  // A world-readable switch is off too.
  await writeFile(path.join(world.home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o644 });
  await chmod(path.join(world.home, 'terminal.json'), 0o644);
  assert.equal((await refusal(viewer.request('terminal.create', { workspaceId: world.ws, cols: 80, rows: 24, requestId: 'r' }))).reason, 'terminal_disabled');
  assert.equal(world.spawned(), 0);
});

test('a real shell: interactive prompt, Ctrl-C, resize, exit; the hello advertises the limits', { skip }, async t => {
  const world = await setup(t);
  const helloed = await world.connect().request('daemon.hello', { protocolVersion: 1 });
  assert.ok(helloed.capabilities.includes(CAPABILITY.terminal));
  assert.equal(helloed.terminalLimits.maxPerPrincipal, TERMINAL.maxPerPrincipal);
  assert.deepEqual(validateResult('daemon.hello', helloed), []);
  const term = await open(world);
  assert.equal(term.terminal.state, 'running');
  assert.ok(!('pid' in term.terminal));
  assert.equal(term.terminal.title, 'sh');
  // Starts in the workspace.
  await term.type('pwd\r');
  await until(() => term.text().includes(world.project), 'pwd prints the workspace');
  // An interactive prompt.
  await term.type('printf "name? "; read NAME; echo "hello [$NAME]"\r');
  await until(() => term.text().includes('name? '), 'the question');
  await term.type('alp\r');
  await until(() => term.text().includes('hello [alp]'), 'the answer');
  // Ctrl-C ends the foreground job, the shell stays.
  await term.type('sleep 30 && echo NOT-$((1))-INTERRUPTED\r');
  await new Promise(resolve => setTimeout(resolve, 300));
  await term.type('\u0003');
  await term.type('echo after-$((40+2))\r');
  await until(() => term.text().includes('after-42'), 'the shell after Ctrl-C');
  assert.ok(!term.text().includes('NOT-1-INTERRUPTED'));
  // Resize reaches the PTY.
  assert.deepEqual(await term.viewer.request('terminal.resize', { terminalId: term.id, cols: 132, rows: 40, ...alice }), { cols: 132, rows: 40 });
  await term.type('stty size\r');
  await until(() => term.text().includes('40 132'), 'stty size');
  // A background job outlives nothing: once the shell exits on its own, its jobs are killed too.
  await term.type('sleep 997 & echo job-started\r');
  await until(() => term.text().includes('job-started'), 'the job');
  await new Promise(resolve => setTimeout(resolve, 200));
  const job = Number(execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n').find(line => / sleep 997$/.test(line))?.trim().split(/\s+/)[0]);
  assert.ok(job > 1 && alive(job));
  // exit ends it: the exit event, then the terminal stays listed as exited for reconnectMs.
  await term.type('exit 3\r');
  await until(() => term.viewer.events.some(event => event.type === 'exit'), 'the exit event');
  const exit = term.viewer.events.find(event => event.type === 'exit');
  assert.deepEqual([exit.reason, exit.exitCode], ['exited', 3]);
  const seqs = term.viewer.events.filter(event => event.seq).map(event => event.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), 'seq counts every output and exit event from 1');
  const { terminals } = await term.viewer.request('terminal.list', alice);
  assert.equal(terminals[0].state, 'exited');
  assert.equal(terminals[0].endReason, 'exited');
  assert.equal((await refusal(term.type('echo late\r'))).reason, 'terminal_exited');
  await until(() => !alive(job), 'the background job killed after the shell exited');
});

test('binding: foreign principals, epochs and roots get not_found; outside roots, unknown workspaces and limits refuse', { skip }, async t => {
  const world = await setup(t, { terminalOptions: { limits: { maxPerPrincipal: 2, maxPerDaemon: 3 } } });
  const term = await open(world, alice);
  const stranger = world.connect();
  for (const as of [bob, { ...alice, principalEpoch: 'e2' }, { ...alice, authorizedRoots: [world.other] }, {}]) {
    for (const [method, params] of [['terminal.attach', {}], ['terminal.input', { data: 'id\r' }], ['terminal.resize', { cols: 10, rows: 10 }], ['terminal.close', {}]]) {
      const refused = await refusal(stranger.request(method, { terminalId: term.id, ...params, ...as }));
      assert.deepEqual([refused.code, refused.reason], [1001, 'not_found'], `${method} as ${JSON.stringify(as)}`);
    }
    assert.deepEqual((await stranger.request('terminal.list', as)).terminals, []);
  }
  // The same principal, from a connection that did not attach, cannot type.
  assert.equal((await refusal(stranger.request('terminal.input', { terminalId: term.id, data: 'id\r', ...alice }))).reason, 'not_attached');
  // Outside the grant's roots, and unknown workspaces.
  const outside = await refusal(stranger.request('terminal.create', { workspaceId: world.wsOther, cols: 80, rows: 24, requestId: 'x', ...alice, authorizedRoots: [world.project] }));
  assert.deepEqual([outside.code, outside.reason], [1003, 'outside_workspace']);
  assert.equal((await refusal(stranger.request('terminal.create', { workspaceId: 'ws_nope', cols: 80, rows: 24, requestId: 'y', ...alice }))).code, 1001);
  // Too much input at once.
  const big = await refusal(term.type('é'.repeat(TERMINAL.maxInputBytes / 2 + 1)));
  assert.deepEqual([big.code, big.reason], [-32602, 'input_too_large']);
  // A repeated requestId answers the same terminal.
  const first = await stranger.request('terminal.create', { workspaceId: world.ws, cols: 80, rows: 24, requestId: 'same', ...alice });
  const again = await stranger.request('terminal.create', { workspaceId: world.ws, cols: 80, rows: 24, requestId: 'same', ...alice });
  assert.equal(again.terminal.terminalId, first.terminal.terminalId);
  // Limits: 2 per principal, 3 per daemon.
  const perPrincipal = await refusal(stranger.request('terminal.create', { workspaceId: world.ws, cols: 80, rows: 24, requestId: 'third', ...alice }));
  assert.deepEqual([perPrincipal.reason, perPrincipal.data.limit], ['terminal_limit', 'principal']);
  await stranger.request('terminal.create', { workspaceId: world.ws, cols: 80, rows: 24, requestId: 'b1', ...bob });
  const perDaemon = await refusal(stranger.request('terminal.create', { workspaceId: world.ws, cols: 80, rows: 24, requestId: 'b2', ...bob }));
  assert.deepEqual([perDaemon.reason, perDaemon.data.limit], ['terminal_limit', 'daemon']);
  assert.equal(world.spawned(), 3, 'refusals spawn nothing');
});

test('replay, gap and reconnect: a detached terminal keeps running for reconnectMs, then ends; input is never replayed', { skip }, async t => {
  const world = await setup(t, { terminalOptions: { limits: { replayBytes: 4096, reconnectMs: 1500 } } });
  const term = await open(world);
  await term.type('echo SECRET-INPUT-$((6*7)) >/dev/null; i=0; while [ $i -lt 300 ]; do echo line-$i-xxxxxxxxxxxxxxxxxxxxxxxx; i=$((i+1)); done; echo DONE\r');
  await until(() => term.text().includes('DONE\r\n'), 'the output');
  const last = Math.max(...term.viewer.events.map(event => event.seq ?? 0));
  // Disconnect: the terminal keeps running.
  term.viewer.connection.close();
  await new Promise(resolve => setTimeout(resolve, 300));
  const back = world.connect();
  const resumed = await back.request('terminal.attach', { terminalId: term.id, after: last, ...alice });
  assert.equal(resumed.gap, undefined, 'nothing missed');
  assert.equal(back.text(term.id), '', 'nothing replayed after the last seq');
  await back.request('terminal.input', { terminalId: term.id, data: 'echo back-$((1+1))\r', ...alice });
  await until(() => back.text(term.id).includes('back-2'), 'the reattached stream');
  // From the start, the 4 KiB ring lost the beginning: a gap, then the tail.
  const fresh = world.connect();
  const replayed = await fresh.request('terminal.attach', { terminalId: term.id, after: 0, ...alice });
  assert.ok(replayed.gap && replayed.gap.fromSeq === 1 && replayed.gap.toSeq >= 1, JSON.stringify(replayed.gap));
  assert.ok(Buffer.byteLength(fresh.text(term.id)) <= 4096 + TERMINAL.maxOutputFrameBytes);
  assert.ok(fresh.text(term.id).includes('back-2'));
  // The earlier stream was replaced.
  await until(() => back.events.some(event => event.type === 'detached' && event.reason === 'replaced'), 'replaced');
  // The typed text is output (echo), never stored or replayed as input: the ring holds no input frames.
  assert.ok(fresh.events.every(event => event.type !== 'input'));
  // Not attached again within reconnectMs: ended as detached.
  fresh.connection.close();
  const watcher = world.connect();
  await until(async () => (await watcher.request('terminal.list', alice)).terminals[0]?.endReason === 'detached', 'detach timeout', 6000);
});

test('revocation and the host switch kill the whole process tree, background jobs included', { skip }, async t => {
  const world = await setup(t);
  const term = await open(world);
  await term.type('sleep 1000 & sleep 1001 & (sleep 1002 &) ; echo started\r');
  await until(() => term.text().includes('started'), 'the jobs');
  await new Promise(resolve => setTimeout(resolve, 200));
  // The double-forked sleep 1002 left the shell's tree (its parent is init now): found by command.
  const sleepers = execFileSync('ps', ['-A', '-o', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(line => / sleep 100[012]$/.test(line)).map(line => Number(line.trim().split(/\s+/)[0]));
  const before = [...new Set([...treeOf([...world.seen][0]), ...sleepers])];
  assert.ok(sleepers.length === 3 && before.length >= 4, `shell and jobs: ${before}`);
  const other = await open(world, bob);
  // Revoke alice: only her terminal ends.
  const owner = world.connect();
  assert.deepEqual(await owner.request('terminal.revoke', { principalId: alice.principalId }), { closed: 1 });
  await until(() => before.every(pid => !alive(pid)), 'every process of the revoked terminal gone');
  await until(() => term.viewer.events.some(event => event.type === 'exit' && event.reason === 'revoked'), 'the revoked exit');
  assert.deepEqual((await owner.request('terminal.list', alice)).terminals, [], 'forgotten');
  await other.type('echo still-$((2+3))\r');
  await until(() => other.text().includes('still-5'), 'bob unaffected');
  // Turning the host switch off ends the rest at the next check.
  await rm(path.join(world.home, 'terminal.json'));
  await until(() => other.viewer.events.some(event => event.type === 'exit' && event.reason === 'disabled'), 'disabled');
  assert.equal((await refusal(owner.request('terminal.create', { workspaceId: world.ws, cols: 80, rows: 24, requestId: 'z', ...alice }))).reason, 'terminal_disabled');
  const helloed = await owner.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(!helloed.capabilities.includes(CAPABILITY.terminal));
});

test('alpd shutdown ends every terminal with no process left; idle and lifetime end them too', { skip }, async t => {
  const world = await setup(t, { terminalOptions: { limits: { idleMs: 600 } } });
  const idle = await open(world);
  await until(() => idle.viewer.events.some(event => event.type === 'exit' && event.reason === 'idle'), 'idle', 6000);
  const busy = await open(world, bob);
  await busy.type('sleep 999 & echo bg\r');
  await until(() => busy.text().includes('bg'), 'the job');
  const pids = treeOf([...world.seen].at(-1));
  assert.ok(pids.length >= 2);
  await world.stop();
  assert.ok(pids.every(pid => !alive(pid)), 'nothing survives alpd');
  assert.ok(busy.viewer.events.some(event => event.type === 'exit' && event.reason === 'shutdown'));
});

test('lifetime, slow consumers and an audit log without keystrokes (the service on its own)', { skip }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-term-svc-')));
  await writeFile(path.join(directory, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o600 });
  const lines = [];
  const log = { info: (message, fields) => lines.push(JSON.stringify({ message, ...fields })), warn: (message, fields) => lines.push(JSON.stringify({ message, ...fields })) };
  const service = createTerminalService({ home: directory, resolveWorkspace: async () => directory, log, sweepMs: 50, killGraceMs: 200, limits: { maxLifetimeMs: 1500 }, maxBufferedBytes: 1024 });
  t.after(async () => { await service.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const sent = [];
  const slow = { send: message => sent.push(message), socket: { writableLength: 0 } };
  const owner = { id: 'owner', epoch: 'owner' };
  const { terminal } = await service.create(owner, { workspaceId: 'w', cols: 80, rows: 24, requestId: 'r' });
  const pid = service.pids()[0];
  await service.attach(owner, slow, { terminalId: terminal.terminalId });
  await until(() => sent.some(message => message.params?.type === 'output'), 'output');
  // The socket backs up: the output of this input detaches the stream (slow_consumer); the terminal runs on.
  await service.input(owner, slow, { terminalId: terminal.terminalId, data: 'echo hunter2-PASSWORD; sleep 0.2; echo more\r' });
  slow.socket.writableLength = 10_000;
  await until(() => sent.some(message => message.params?.type === 'detached' && message.params.reason === 'slow_consumer'), 'slow consumer');
  assert.ok(alive(pid));
  // Lifetime ends it.
  await until(async () => (await service.list(owner, {})).terminals[0]?.endReason === 'lifetime', 'lifetime', 6000);
  await until(() => !alive(pid), 'the shell gone');
  const audit = lines.join('\n');
  for (const code of ['ALPD_TERMINAL_CREATED', 'ALPD_TERMINAL_ATTACHED', 'ALPD_TERMINAL_DETACHED', 'ALPD_TERMINAL_ENDED']) assert.ok(audit.includes(code), code);
  assert.ok(!audit.includes('hunter2'), 'no keystroke in the log');
  assert.ok(!audit.includes('PASSWORD'), 'no output in the log');
});

test('a socket client: the stream survives a disconnect only for the same principal', { skip }, async t => {
  const world = await setup(t);
  const socketPath = path.join(world.directory, 's', 'alpd.sock');
  const open_ = async () => {
    const socket = net.connect(socketPath);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    const client = new AlpRpcClient(createSocketTransport(socket));
    await hello(client, { name: 'test', version: '1' });
    const events = [];
    client.onNotification((method, params) => { if (method === 'terminal.event') events.push(params); });
    return { client, events, text: () => events.filter(event => event.type === 'output').map(event => event.data).join('') };
  };
  const first = await open_();
  t.after(() => first.client.close());
  const { terminal } = await first.client.request('terminal.create', { workspaceId: world.ws, cols: 80, rows: 24, requestId: 'sock', ...alice });
  await first.client.request('terminal.attach', { terminalId: terminal.terminalId, ...alice });
  await until(() => /PROMPT\$ $/.test(first.text()), 'prompt over the socket');
  first.client.close();
  const second = await open_();
  t.after(() => second.client.close());
  assert.equal((await refusal(second.client.request('terminal.attach', { terminalId: terminal.terminalId, ...bob }))).code, 1001);
  const resumed = await second.client.request('terminal.attach', { terminalId: terminal.terminalId, after: 0, ...alice });
  assert.equal(resumed.terminal.state, 'running');
  await second.client.request('terminal.input', { terminalId: terminal.terminalId, data: 'echo sock-$((3*3))\r', ...alice });
  await until(() => second.text().includes('sock-9'), 'output after reconnect');
  await second.client.request('terminal.close', { terminalId: terminal.terminalId, ...alice });
  await until(() => second.events.some(event => event.type === 'exit' && event.reason === 'closed'), 'closed');
});

/** A spawner that runs nothing: a fake PTY whose exit the test drives. */
function fakePty({ ptsName } = {}) {
  let next = 70_000;
  const made = [];
  const spawn = (_file, _args, options) => {
    const exits = new Set();
    const pty = { pid: next++, ...(ptsName ? { ptsName } : {}), env: options.env, write() {}, resize() {}, kill() { queueMicrotask(() => { for (const listener of exits) listener({ exitCode: 0, signal: 1 }); }); }, onData: () => ({ dispose() {} }), onExit: listener => { exits.add(listener); return { dispose: () => exits.delete(listener) }; } };
    made.push(pty);
    return pty;
  };
  return { spawn, made };
}

test('ending a terminal never kills by a remembered or reused id: only processes identified now (marker, live shell and PTY, live groups)', { skip }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-term-ids-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o600 });
  const { spawn, made } = fakePty();
  let table = [];
  const service = createTerminalService({ home: directory, resolveWorkspace: async () => directory, log: { info() {}, warn() {} }, spawn, processes: async () => table, sweepMs: 60_000, killGraceMs: 10, platform: 'darwin' });
  t.after(() => service.shutdown());
  const owner = { id: 'owner', epoch: 'owner' };
  await service.create(owner, { workspaceId: 'w', cols: 80, rows: 24, requestId: 'r' });
  const shell = made[0];
  const marker = shell.env.ALP_TERMINAL_ID;
  assert.match(marker, /^atm_[0-9a-f]{32}$/);
  // Probe processes that are never really signalled: ids far above any live pid would throw ESRCH,
  // so the test records the kill calls instead.
  const killed = [];
  const realKill = process.kill;
  process.kill = (pid, signal) => { if (pid >= 70_000) { killed.push([pid, signal]); return true; } return realKill.call(process, pid, signal); };
  t.after(() => { process.kill = realKill; });
  table = [
    { pid: shell.pid, ppid: process.pid, pgid: shell.pid, elapsedMs: 0 },
    { pid: 80_001, ppid: 1, pgid: 80_001, elapsedMs: 0, markers: [marker] }, // a double-forked job: found by its marker
    { pid: 80_002, ppid: 1, pgid: 80_001, elapsedMs: 0 }, // in that job's live group
    { pid: 80_003, ppid: 1, pgid: 75_000, elapsedMs: 0 }, // a stranger in a group id the shell's jobs once had
    { pid: 80_004, ppid: 1, pgid: 80_004, elapsedMs: 0, markers: ['atm_' + '0'.repeat(32)] }, // another terminal's job
  ];
  const { terminals } = await service.list(owner, {});
  await service.close(owner, { terminalId: terminals[0].terminalId });
  const hit = new Set(killed.map(([pid]) => pid));
  assert.ok(hit.has(shell.pid) && hit.has(80_001) && hit.has(80_002), JSON.stringify(killed));
  assert.ok(!hit.has(80_003) && !hit.has(80_004), 'never a stranger or another terminal\'s process');
  // After the shell exited, neither its pid nor anything else is killed by id alone.
  killed.length = 0;
  await service.create(owner, { workspaceId: 'w', cols: 80, rows: 24, requestId: 'r2' });
  const second = made[1];
  table = [{ pid: second.pid, ppid: 1, pgid: second.pid, elapsedMs: 0 }]; // the pid, reused by a stranger after the exit
  second.kill();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(killed, [], 'an exited shell\'s pid is not trusted');
});

test('after the shell has gone its Linux session still counts; a younger holder of its pid, or of its PTY name, never does', { skip }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-term-linux-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o600 });
  const { spawn, made } = fakePty({ ptsName: '/dev/pts/9' });
  let clock = 1_000_000_000;
  let table = [];
  const service = createTerminalService({ home: directory, resolveWorkspace: async () => directory, log: { info() {}, warn() {} }, spawn, processes: async () => table, sweepMs: 60_000, killGraceMs: 10, platform: 'linux', now: () => clock });
  t.after(() => service.shutdown());
  const owner = { id: 'owner', epoch: 'owner' };
  const killed = [];
  const realKill = process.kill;
  process.kill = (pid, signal) => { if (pid >= 70_000) { killed.push([pid, signal]); return true; } return realKill.call(process, pid, signal); };
  t.after(() => { process.kill = realKill; });
  const hits = () => new Set(killed.map(([pid]) => pid));
  const close = async () => { const { terminals } = await service.list(owner, {}); for (const terminal of terminals.filter(row => row.state === 'running')) await service.close(owner, { terminalId: terminal.terminalId }); };

  // The shell exits on its own; a job that cleared its environment and ignores SIGHUP stays in its
  // session, its parent gone: the SIGKILL pass after the grace still finds it by the session.
  await service.create(owner, { workspaceId: 'w', cols: 80, rows: 24, requestId: 'r1' });
  const first = made[0];
  clock += 60_000;
  table = [{ pid: 80_101, ppid: 1, pgid: 80_101, sid: first.pid, elapsedMs: 30_000 }];
  first.kill();
  // The reap's passes: SIGHUP, SIGKILL after the grace, and SIGKILL again 100 ms later.
  await until(() => killed.filter(([pid]) => pid === 80_101).length >= 3, 'the reap to finish');
  assert.deepEqual(killed.filter(([pid]) => pid === 80_101).map(([, signal]) => signal).slice(0, 2), ['SIGHUP', 'SIGKILL'], JSON.stringify(killed));

  // A process younger than the terminal holds the shell's pid and leads a session of its own: neither
  // it nor that session is ours.
  killed.length = 0;
  await service.create(owner, { workspaceId: 'w', cols: 80, rows: 24, requestId: 'r2' });
  const second = made[1];
  clock += 60_000;
  table = [
    { pid: second.pid, ppid: 1, pgid: second.pid, sid: second.pid, elapsedMs: 5_000 },
    { pid: 80_201, ppid: 1, pgid: 80_201, sid: second.pid, elapsedMs: 4_000 },
  ];
  await close();
  assert.deepEqual(killed, [], 'a reused shell pid and its session are never ours');

  // The PTY's name counts only while the shell row of the same snapshot still has it.
  await service.create(owner, { workspaceId: 'w', cols: 80, rows: 24, requestId: 'r3' });
  const third = made[2];
  clock += 1_000;
  table = [
    { pid: third.pid, ppid: process.pid, pgid: third.pid, sid: third.pid, elapsedMs: 1_000 },
    { pid: 80_301, ppid: 1, pgid: 80_301, sid: 80_301, tty: 'pts/9', elapsedMs: 500 },
  ];
  await close();
  assert.ok(hits().has(third.pid), JSON.stringify(killed));
  assert.ok(!hits().has(80_301), 'a PTY name the shell no longer has may be another terminal\'s');
  killed.length = 0;
  await service.create(owner, { workspaceId: 'w', cols: 80, rows: 24, requestId: 'r4' });
  const fourth = made[3];
  clock += 1_000;
  table = [
    { pid: fourth.pid, ppid: process.pid, pgid: fourth.pid, sid: fourth.pid, tty: 'pts/9', elapsedMs: 1_000 },
    { pid: 80_401, ppid: 1, pgid: 80_401, sid: 80_401, tty: 'pts/9', elapsedMs: 500 },
  ];
  await close();
  assert.ok(hits().has(fourth.pid) && hits().has(80_401), JSON.stringify(killed));
});

test('concurrent creates cannot pass the limits or duplicate a requestId', { skip }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-term-race-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true, limits: { maxPerPrincipal: 1 } }), { mode: 0o600 });
  const { spawn, made } = fakePty();
  const service = createTerminalService({ home: directory, resolveWorkspace: async () => { await new Promise(resolve => setTimeout(resolve, 5)); return directory; }, log: { info() {}, warn() {} }, spawn, processes: async () => [], sweepMs: 60_000, killGraceMs: 10, platform: 'darwin' });
  t.after(() => service.shutdown());
  const owner = { id: 'owner', epoch: 'owner' };
  const outcomes = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => service.create(owner, { workspaceId: 'w', cols: 80, rows: 24, requestId: `r${i}` })));
  assert.equal(outcomes.filter(outcome => outcome.status === 'fulfilled').length, 1);
  assert.ok(outcomes.filter(outcome => outcome.status === 'rejected').every(outcome => outcome.reason.data.reason === 'terminal_limit'));
  assert.equal(made.length, 1);
  const bob = { id: 'bob', epoch: 'e' };
  const same = await Promise.all([1, 2, 3].map(() => service.create(bob, { workspaceId: 'w', cols: 80, rows: 24, requestId: 'one' })));
  assert.equal(new Set(same.map(result => result.terminal.terminalId)).size, 1);
  assert.equal(made.length, 2);
});

test('a job started just before the shell exits on its own is killed, with no sweep to help', { skip }, async t => {
  const world = await setup(t, { terminalOptions: { sweepMs: 600_000 } });
  const term = await open(world);
  await term.type('sleep 995 & exit\r');
  await until(() => term.viewer.events.some(event => event.type === 'exit'), 'the exit');
  await until(() => !execFileSync('ps', ['-A', '-o', 'command='], { encoding: 'utf8' }).split('\n').some(line => line.trim() === 'sleep 995'), 'the job killed after the exit');
});

test('the process table parser: commands with spaces, a marker in the environment only, escaped newlines (macOS ps)', { skip: process.platform !== 'darwin' && 'the macOS ps format' }, async t => {
  const { psProcesses } = await import('@anhlp/alp-daemon/terminals');
  const bin = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-fake-ps-')));
  t.after(() => rm(bin, { recursive: true, force: true }));
  const marker = `atm_${'a'.repeat(32)}`;
  // Two passes: with -E (command line, then the environment) and the command line alone.
  const withEnv = [
    `  101     1   101 ttys001     00:05 /bin/zsh -l HOME=/x ALP_TERMINAL_ID=${marker} TERM=xterm`,
    `  102     1   102 ??          01:00 grep ALP_TERMINAL_ID=${marker} HOME=/x`,
    `  103     1   103 ??       1-02:03:04 node server.js --flag=ALP_TERMINAL_ID=${marker} HOME=/x`,
    `  104     1   104 ??          00:01 sleep 9 X=a\\012  999     1   999 ??          00:01 x ALP_TERMINAL_ID=${marker}`,
    `  105     1   105 ??          00:01   spaced arg HOME=/x ALP_TERMINAL_ID=${marker}`,
  ].join('\n');
  const plain = ['  101 /bin/zsh -l', `  102 grep ALP_TERMINAL_ID=${marker}`, `  103 node server.js --flag=ALP_TERMINAL_ID=${marker}`, '  104 sleep 9', '  105   spaced arg'].join('\n');
  await writeFile(path.join(bin, 'ps'), `#!/bin/sh\ncase "$*" in *-E*) cat <<'EOF_'\n${withEnv}\nEOF_\n;; *) cat <<'EOF_'\n${plain}\nEOF_\n;; esac\n`, { mode: 0o755 });
  const saved = process.env.PATH;
  process.env.PATH = `${bin}:${saved}`;
  t.after(() => { process.env.PATH = saved; });
  const rows = await psProcesses('darwin')();
  const byPid = new Map(rows.map(row => [row.pid, row]));
  assert.deepEqual(byPid.get(101).markers, [marker]);
  assert.equal(byPid.get(101).tty, 'ttys001');
  assert.equal(byPid.get(101).elapsedMs, 5_000);
  assert.equal(byPid.get(102).markers, undefined, 'a marker in the arguments does not count');
  assert.equal(byPid.get(103).markers, undefined);
  assert.equal(byPid.get(103).elapsedMs, ((26 * 60 + 3) * 60 + 4) * 1000);
  assert.deepEqual(byPid.get(104).markers, [marker], 'an escaped newline is one line');
  assert.deepEqual(byPid.get(105).markers, [marker], 'a command line that starts with spaces');
  assert.equal(rows.length, 5, 'no forged row');
});
