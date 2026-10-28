// The Paseo bridge's terminals (issue #121 H, ALPD §62): Paseo's terminal messages over alpd's
// terminal.* (docs/protocol/alp-json-rpc-v1.md §12.10). A fake alpd checks what the bridge asks and
// in which order; fake app clients decode the binary frames with Paseo's own decoder and validate
// every JSON message with Paseo's validator. The last test runs a real shell through a real alpd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateWSOutboundMessage } from '@getpaseo/protocol/validation/ws-outbound';
import { decodeBinaryFrame, TerminalStreamOpcode } from '@getpaseo/protocol/binary-frames/index';
import { TerminalInputModeTracker } from '@getpaseo/protocol/terminal-input-mode';
import { createTerminals, TERMINALS_OFF } from '@anhlp/alp-paseo/paseo/terminals';

const decoder = new TextDecoder();
const text = bytes => decoder.decode(bytes);

async function until(check, what = 'condition', ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${what} did not happen`);
}
const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));

/** A home whose terminal.json (owner-private) says what the owner allowed; none when `config` is null. */
async function homeWith(t, config = { version: 1, allowRemoteTerminal: true, allowPaseoTerminal: true }) {
  const home = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-paseo-term-')));
  t.after(() => rm(home, { recursive: true, force: true }));
  if (config) await writeFile(path.join(home, 'terminal.json'), JSON.stringify(config), { mode: 0o600 });
  return home;
}

const WORKSPACES = [
  { id: 'ws-a', projectId: 'p1', directory: '/w/a', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'ws-a2', projectId: 'p1', directory: '/w/a', createdAt: '2026-02-01T00:00:00.000Z' },
  { id: 'ws-b', projectId: 'p1', directory: '/w/b', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'ws-old', projectId: 'p1', directory: '/w/old', createdAt: '2026-01-01T00:00:00.000Z', archivedAt: '2026-03-01T00:00:00.000Z' },
  { id: 'ws-gone', projectId: 'p2', directory: '/w/gone', createdAt: '2026-01-01T00:00:00.000Z' },
];

/**
 * alpd's terminal service as §12.10 says, without a PTY: one attached connection per terminal,
 * replay of the ring before the attach answers, a gap when the ring moved on, detached events.
 */
function fakeAlpd({ capabilities = ['terminal'], replayBytes = 1024 * 1024, maxInputBytes = 64 * 1024 } = {}) {
  const calls = [];
  const conns = [];
  const terminals = new Map();
  let made = 0;
  const error = (code, reason, message = reason) => Object.assign(new Error(message), { code, data: { reason } });
  const send = (conn, params) => { if (conn && !conn.closed) for (const listener of [...conn.listeners]) listener('terminal.event', params); };
  const info = term => ({ terminalId: term.id, workspaceId: term.workspaceId, title: 'sh', cols: term.cols, rows: term.rows, state: term.state, createdAt: '2026-01-01T00:00:00.000Z' });
  function handle(conn, method, params) {
    if (method === 'daemon.hello') return { protocolVersion: 1, capabilities, ...(capabilities.includes('terminal') ? { terminalLimits: { maxPerPrincipal: 4, maxPerDaemon: 16, maxInputBytes, maxOutputFrameBytes: 65536, replayBytes, idleMs: 1e6, maxLifetimeMs: 1e7, reconnectMs: 60000 } } : {}) };
    if (method === 'registry.owner') return { registry: { projects: [{ id: 'p1' }, { id: 'p2', removedAt: '2026-03-01T00:00:00.000Z' }], workspaces: WORKSPACES } };
    if (method === 'terminal.create') {
      const id = `term_${String(++made).padStart(32, '0')}`;
      const term = { id, workspaceId: params.workspaceId, cols: params.cols, rows: params.rows, state: 'running', events: [], seq: 0, attached: null, inputs: [] };
      terminals.set(id, term);
      return { terminal: info(term) };
    }
    if (method === 'terminal.list') return { terminals: [...terminals.values()].filter(term => !term.forgotten).map(info) };
    const term = terminals.get(params.terminalId);
    if (!term || term.forgotten) throw error(1001, 'not_found', 'No such terminal');
    if (method === 'terminal.attach') {
      if (term.attached && term.attached !== conn) send(term.attached, { terminalId: term.id, type: 'detached', reason: 'replaced' });
      term.attached = conn;
      const after = params.after ?? 0;
      const first = term.events[0]?.seq ?? term.seq + 1;
      for (const event of term.events) if (event.seq > after) send(conn, event);
      return { terminal: info(term), nextSeq: term.seq + 1, ...(after + 1 < first ? { gap: { fromSeq: after + 1, toSeq: first - 1 } } : {}) };
    }
    if (term.attached !== conn) throw error(1004, 'not_attached');
    if (method === 'terminal.input') { term.inputs.push(params.data); return { bytes: Buffer.byteLength(params.data) }; }
    if (method === 'terminal.resize') { term.cols = params.cols; term.rows = params.rows; return { cols: params.cols, rows: params.rows }; }
    if (method === 'terminal.close') { alpd.exit(term.id, 'closed'); term.forgotten = true; return { closed: true }; }
    throw error(-32601, 'unknown');
  }
  function connect() {
    const conn = {
      closed: false, listeners: new Set(), closes: new Set(),
      async request(method, params) {
        if (conn.closed) throw new Error('ALP daemon connection closed');
        calls.push({ method, params, conn });
        await Promise.resolve();
        return handle(conn, method, params);
      },
      onEvent() { return () => {}; },
      onNotification(listener) { conn.listeners.add(listener); return () => conn.listeners.delete(listener); },
      onClose(listener) { conn.closes.add(listener); return () => conn.closes.delete(listener); },
      close() { if (conn.closed) return; conn.closed = true; for (const listener of [...conn.closes]) listener(new Error('closed')); },
    };
    conns.push(conn);
    return Promise.resolve(conn);
  }
  const alpd = {
    calls, conns, terminals, connect,
    terminalCalls: () => calls.filter(call => call.method.startsWith('terminal.')),
    methods: () => calls.map(call => call.method),
    /** A terminal made by another ALP client: nobody attached. */
    async create(workspaceId = 'ws-a') { return handle(null, 'terminal.create', { workspaceId, cols: 80, rows: 24 }).terminal.terminalId; },
    out(id, data) {
      const term = terminals.get(id);
      const event = { terminalId: id, type: 'output', seq: ++term.seq, data };
      term.events.push(event);
      let bytes = term.events.reduce((sum, item) => sum + (item.data ? Buffer.byteLength(item.data) : 0), 0);
      while (bytes > replayBytes && term.events.length > 1) bytes -= Buffer.byteLength(term.events.shift().data ?? '');
      send(term.attached, event);
    },
    exit(id, reason = 'exited') {
      const term = terminals.get(id);
      term.state = 'exited';
      const event = { terminalId: id, type: 'exit', seq: ++term.seq, exitCode: 0, signal: null, reason };
      term.events.push(event);
      send(term.attached, event);
    },
    /** The ring forgets everything before seq `from`. */
    forget(id, from) { const term = terminals.get(id); term.events = term.events.filter(event => event.seq >= from); },
    detach(id, reason) { const term = terminals.get(id); const conn = term.attached; term.attached = null; send(conn, { terminalId: id, type: 'detached', reason }); },
  };
  return alpd;
}

/** An app client: every JSON message passes Paseo's validator; binary frames decode as terminal frames. */
function fakeClient(name = 'c1') {
  const log = [];
  let buffered = 0;
  const client = {
    clientId: name, log,
    emit(message) {
      const checked = validateWSOutboundMessage({ type: 'session', message });
      assert.ok(checked.success, `the bridge sent a message Paseo's app drops: ${JSON.stringify(message).slice(0, 300)}\n${checked.error}`);
      log.push({ json: message });
    },
    emitBinary(bytes) {
      assert.ok(bytes instanceof Uint8Array);
      const decoded = decodeBinaryFrame(bytes);
      assert.equal(decoded?.kind, 'terminal', 'a terminal stream frame');
      log.push({ opcode: decoded.frame.opcode, slot: decoded.frame.slot, data: text(decoded.frame.payload) });
    },
    buffered: () => buffered,
    setBuffered(value) { buffered = value; },
    json: type => log.filter(entry => entry.json?.type === type).map(entry => entry.json),
    frames: (slot, opcode) => log.filter(entry => entry.opcode !== undefined && (slot === undefined || entry.slot === slot) && (opcode === undefined || entry.opcode === opcode)),
    output: slot => client.frames(slot, TerminalStreamOpcode.Output).map(entry => entry.data).join(''),
  };
  return client;
}

/** The bridge's terminals on a fake alpd; `call` answers like the gateway (a returned reply is emitted). */
async function setup(t, { config, capabilities, timing, replayBytes, maxInputBytes, archiveAgent } = {}) {
  const home = await homeWith(t, config);
  const alpd = fakeAlpd({ capabilities, replayBytes, maxInputBytes });
  const logs = [];
  const terminals = createTerminals({ home, connect: alpd.connect, log: message => logs.push(message), archiveAgent, timing: { retryMs: 10, drainMs: 10, ...timing } });
  t.after(() => terminals.close());
  const call = async (client, message) => {
    const reply = await terminals.handlers[message.type](message, client);
    if (reply) client.emit(reply);
    return reply;
  };
  const create = async (client, fields = {}) => (await call(client, { type: 'create_terminal_request', requestId: `r-${Math.random()}`, cwd: '/w/a', ...fields })).payload;
  const subscribe = async (client, terminalId) => {
    await call(client, { type: 'subscribe_terminal_request', terminalId, requestId: `s-${Math.random()}` });
    return client.json('subscribe_terminal_response').filter(entry => entry.payload.terminalId === terminalId).at(-1).payload;
  };
  return { home, alpd, terminals, call, create, subscribe, logs };
}

for (const [label, options] of [
  ['the host switch is off (no terminal.json)', { config: null }],
  ['the switch is on but Paseo devices are not allowed', { config: { version: 1, allowRemoteTerminal: true } }],
  ['Paseo is allowed without the host switch', { config: { version: 1, allowRemoteTerminal: false, allowPaseoTerminal: true } }],
  ['alpd does not list the terminal capability', { capabilities: [] }],
]) {
  test(`off when ${label}: empty lists, clear refusals, and no terminal.* call`, async t => {
    const world = await setup(t, options);
    const client = fakeClient();
    assert.equal(await world.terminals.refresh(), false);
    assert.equal(world.terminals.features.workspaceTerminals, false);
    assert.deepEqual((await world.call(client, { type: 'list_terminals_request', requestId: 'l1', cwd: '/w/a' })).payload.terminals, []);
    assert.deepEqual((await world.call(client, { type: 'list_terminals_request', requestId: 'l2' })).payload.terminals, []);
    const changed = (await world.call(client, { type: 'subscribe_terminals_request', requestId: 's1', cwd: '/w/a', workspaceId: 'ws-a' })).payload;
    assert.deepEqual(changed, { requestId: 's1', cwd: '/w/a', workspaceId: 'ws-a', terminals: [] });
    const created = await world.create(client);
    assert.equal(created.terminal, null);
    assert.equal(created.error, TERMINALS_OFF);
    assert.match(created.error, /alp terminal allow --paseo --yes/);
    assert.match(created.error, /not a sandbox/);
    const subscribed = await world.subscribe(client, 'term_00000000000000000000000000000001');
    assert.equal(subscribed.error, TERMINALS_OFF);
    assert.equal(subscribed.slot, undefined);
    await world.call(client, { type: 'terminal_input', terminalId: 'term_00000000000000000000000000000001', message: { type: 'input', data: 'ls\r' } });
    await world.call(client, { type: 'terminal_input', terminalId: 'term_00000000000000000000000000000001', message: { type: 'resize', cols: 100, rows: 30, intent: 'claim' } });
    assert.equal((await world.call(client, { type: 'kill_terminal_request', terminalId: 'term_00000000000000000000000000000001', requestId: 'k1' })).payload.success, false);
    assert.deepEqual((await world.call(client, { type: 'close_items_request', agentIds: [], terminalIds: ['term_00000000000000000000000000000001'], requestId: 'x1' })).payload.terminals, [{ terminalId: 'term_00000000000000000000000000000001', success: false }]);
    await tick();
    assert.deepEqual(world.alpd.terminalCalls(), [], 'no terminal.* call');
    assert.equal(client.frames().length, 0, 'no frame');
    // Without both opt-ins the bridge does not even open a connection to alpd.
    if (options.config !== undefined) assert.equal(world.alpd.conns.length, 0);
    else assert.deepEqual(world.alpd.methods(), ['daemon.hello']);
  });
}

test('on: features follow the switch; turning Paseo off ends every stream and closes the connection', async t => {
  const world = await setup(t, { timing: { checkMs: 0 } });
  const client = fakeClient();
  assert.equal(await world.terminals.refresh(), true);
  assert.equal(world.terminals.features.workspaceTerminals, true);
  assert.equal(world.terminals.features['terminal-restore-modes'], true);
  assert.equal(world.terminals.features['terminal-input-mode-replay'], true);
  assert.equal(world.terminals.features['terminal-size-ownership'], true);
  const { terminal } = await world.create(client);
  assert.equal((await world.subscribe(client, terminal.id)).slot, 0);
  await writeFile(path.join(world.home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o600 });
  const before = world.alpd.terminalCalls().length;
  assert.deepEqual((await world.call(client, { type: 'list_terminals_request', requestId: 'l1' })).payload.terminals, []);
  assert.equal(world.terminals.features.workspaceTerminals, false);
  assert.deepEqual(client.json('terminal_stream_exit').map(entry => entry.payload), [{ terminalId: terminal.id, error: TERMINALS_OFF }]);
  await tick();
  // The shell it held is closed in alpd at once, not left for alpd's reconnect time; then the connection goes.
  assert.deepEqual(world.alpd.terminalCalls().slice(before).map(call => [call.method, call.params.terminalId]), [['terminal.close', terminal.id]]);
  assert.ok(world.alpd.conns.every(conn => conn.closed), 'the terminals connection is closed');
  await world.call(client, { type: 'terminal_input', terminalId: terminal.id, message: { type: 'input', data: 'x' } });
  await tick();
  assert.equal(world.alpd.terminalCalls().length, before + 1, 'nothing more reaches alpd');
});

test('turning Paseo off ends a stream that only prints, without any request', async t => {
  const world = await setup(t, { timing: { checkMs: 0 } });
  const client = fakeClient();
  const { terminal } = await world.create(client);
  await world.subscribe(client, terminal.id);
  await writeFile(path.join(world.home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true, allowPaseoTerminal: false }), { mode: 0o600 });
  await until(() => client.json('terminal_stream_exit').length === 1, 'the stream ended', 2000);
  assert.equal(client.json('terminal_stream_exit')[0].payload.error, TERMINALS_OFF);
  world.alpd.out(terminal.id, 'after');
  assert.equal(client.output(0), '', 'no output after');
});

test('alpd away, then Paseo turned off: the reconnect does not attach again', async t => {
  const world = await setup(t, { timing: { checkMs: 0 } });
  const client = fakeClient();
  const { terminal } = await world.create(client);
  await world.subscribe(client, terminal.id);
  const attaches = world.alpd.calls.filter(call => call.method === 'terminal.attach').length;
  await writeFile(path.join(world.home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true }), { mode: 0o600 });
  world.alpd.conns[0].close();
  await until(() => client.json('terminal_stream_exit').length === 1, 'the stream ended', 2000);
  assert.equal(client.json('terminal_stream_exit')[0].payload.error, TERMINALS_OFF);
  await tick(50);
  assert.equal(world.alpd.calls.filter(call => call.method === 'terminal.attach').length, attaches, 'no attach after');
});

test('create: exactly a live registry workspace\'s directory, ALP\'s shell only; attached at once', async t => {
  const world = await setup(t);
  const client = fakeClient();
  const refused = async (fields, pattern) => {
    const reply = await world.create(client, fields);
    assert.equal(reply.terminal, null, JSON.stringify(fields));
    assert.match(reply.error, pattern, JSON.stringify(fields));
  };
  await refused({ workspaceId: 'ws-nope' }, /No such workspace/);
  await refused({ workspaceId: 'ws-b' }, /not the workspace's own directory/);
  await refused({ cwd: '/w/a/sub' }, /not a workspace of ALP's registry/);
  await refused({ cwd: '/w/a/sub', workspaceId: 'ws-a' }, /not the workspace's own directory/);
  await refused({ cwd: '/w/a/sub/..' + '/../elsewhere' }, /not a workspace/);
  await refused({ cwd: '/etc' }, /not a workspace/);
  await refused({ cwd: 'w/a' }, /absolute path/);
  await refused({ cwd: '/w/old' }, /not a workspace/);
  await refused({ cwd: '/w/gone' }, /not a workspace/);
  await refused({ workspaceId: 'ws-old', cwd: '/w/old' }, /No such workspace/);
  await refused({ command: 'bash' }, /shell: a command, arguments or an agent are not accepted/);
  await refused({ args: ['-c', 'id'] }, /not accepted/);
  await refused({ args: [] }, /not accepted/);
  await refused({ agentId: 'agent-1' }, /not accepted.*not a sandbox/);
  assert.equal(world.alpd.calls.filter(call => call.method === 'terminal.create').length, 0, 'no refused request reached alpd');

  const oldest = await world.create(client, { requestId: 'c1', cwd: '/w/a/', name: 'ignored' });
  assert.equal(oldest.error, null);
  assert.equal(oldest.terminal.workspaceId, 'ws-a', 'the oldest workspace of that directory');
  assert.equal(oldest.terminal.cwd, '/w/a');
  assert.equal(oldest.terminal.title, 'sh');
  const chosen = await world.create(client, { cwd: '/w/a', workspaceId: 'ws-a2', size: { cols: 1000, rows: 0 } });
  assert.equal(chosen.terminal.workspaceId, 'ws-a2');
  const creates = world.alpd.calls.filter(call => call.method === 'terminal.create').map(call => call.params);
  assert.deepEqual({ ...creates[0], requestId: undefined }, { workspaceId: 'ws-a', cols: 80, rows: 24, requestId: undefined });
  assert.match(creates[0].requestId, /^paseo:[0-9a-f]{64}$/, 'namespaced per client');
  assert.deepEqual([creates[1].cols, creates[1].rows], [500, 1], 'sizes are clamped to alpd\'s bounds');
  // Attached right away, so the terminal outlives a client that went away (alpd kills an unattached one).
  assert.deepEqual(world.alpd.methods().filter(method => method.startsWith('terminal.')), ['terminal.create', 'terminal.attach', 'terminal.create', 'terminal.attach']);
  const listed = (await world.call(client, { type: 'list_terminals_request', requestId: 'l1', cwd: '/w/a' })).payload.terminals;
  assert.deepEqual(listed.map(entry => entry.workspaceId), ['ws-a']);
  assert.equal((await world.call(client, { type: 'list_terminals_request', requestId: 'l2', cwd: '/w/a', workspaceId: 'ws-a2' })).payload.terminals.length, 1);
  assert.equal((await world.call(client, { type: 'list_terminals_request', requestId: 'l3', cwd: '/w/a/sub' })).payload.terminals.length, 0);
  assert.equal((await world.call(client, { type: 'list_terminals_request', requestId: 'l4' })).payload.terminals.length, 2);
});

test('subscribe: the claimed size waits for the attach; the answer first, then Restore in seq order, then the input modes, then live output', async t => {
  const world = await setup(t);
  const client = fakeClient();
  // Made by another ALP client: the bridge is not attached yet.
  const id = await world.alpd.create();
  world.alpd.out(id, 'one ');
  world.alpd.out(id, 'two \x1b[?2004h');
  world.alpd.out(id, 'three');
  await world.call(client, { type: 'terminal_input', terminalId: id, message: { type: 'resize', cols: 120, rows: 40, intent: 'claim' } });
  await tick();
  assert.equal(world.alpd.calls.filter(call => call.method === 'terminal.resize').length, 0, 'alpd resizes only an attached terminal');
  const answer = await world.subscribe(client, id);
  assert.deepEqual(answer, { terminalId: id, slot: 0, error: null, requestId: answer.requestId });
  const methods = world.alpd.methods().filter(method => method.startsWith('terminal.'));
  assert.deepEqual(methods.slice(-2), ['terminal.attach', 'terminal.resize']);
  assert.deepEqual(world.alpd.calls.find(call => call.method === 'terminal.resize').params, { terminalId: id, cols: 120, rows: 40 });
  assert.deepEqual(world.alpd.calls.find(call => call.method === 'terminal.attach').params, { terminalId: id, after: 0 });
  const tracker = new TerminalInputModeTracker();
  tracker.feed('one two \x1b[?2004hthree');
  const order = client.log.map(entry => entry.json ? entry.json.type : entry.opcode === TerminalStreamOpcode.Restore ? 'restore' : 'output');
  assert.deepEqual(order, ['subscribe_terminal_response', 'restore', 'output']);
  assert.equal(client.log[1].data, 'one two \x1b[?2004hthree');
  assert.equal(client.log[2].data, tracker.getPreamble());
  assert.match(client.log[2].data, /\?2004h/);
  world.alpd.out(id, ' four');
  assert.deepEqual(client.log.at(-1), { opcode: TerminalStreamOpcode.Output, slot: 0, data: ' four' });
  // A size update from another client does not take the size from the one that claimed it.
  const other = fakeClient('c2');
  await world.subscribe(other, id);
  await world.call(other, { type: 'terminal_input', terminalId: id, message: { type: 'resize', cols: 50, rows: 10, intent: 'update' } });
  await world.call(other, { type: 'terminal_input', terminalId: id, message: { type: 'resize', cols: 60, rows: 12, intent: 'claim' } });
  await tick();
  assert.deepEqual(world.alpd.calls.filter(call => call.method === 'terminal.resize').map(call => call.params.cols), [120, 60]);
});

test('an empty terminal gets no Restore frame', async t => {
  const world = await setup(t);
  const client = fakeClient();
  const { terminal } = await world.create(client);
  await world.subscribe(client, terminal.id);
  assert.equal(client.frames().length, 0);
});

test('two clients share one attach, each with its own slots', async t => {
  const world = await setup(t);
  const one = fakeClient('one');
  const two = fakeClient('two');
  const a = (await world.create(one)).terminal.id;
  const b = (await world.create(one, { cwd: '/w/b' })).terminal.id;
  world.alpd.out(a, 'hello ');
  assert.equal((await world.subscribe(one, a)).slot, 0);
  assert.equal((await world.subscribe(two, b)).slot, 0);
  assert.equal((await world.subscribe(two, a)).slot, 1);
  assert.equal((await world.subscribe(two, a)).slot, 1, 'subscribing again keeps the slot');
  assert.equal(world.alpd.calls.filter(call => call.method === 'terminal.attach' && call.params.terminalId === a).length, 1, 'one attach');
  world.alpd.out(a, 'world');
  world.alpd.out(b, 'bee');
  assert.equal(one.output(0), 'world');
  assert.equal(two.output(1), 'world');
  assert.equal(two.output(0), 'bee');
  assert.equal(two.frames(1, TerminalStreamOpcode.Restore).at(-1).data, 'hello ', 'what the copy held at subscribe');
  await world.call(two, { type: 'unsubscribe_terminal_request', terminalId: a });
  world.alpd.out(a, '!');
  assert.equal(one.output(0), 'world!');
  assert.equal(two.output(1), 'world', 'unsubscribed');
  assert.equal((await world.subscribe(two, b)).slot, 0);
});

test('exit and replaced end the stream for every client; directory subscriptions hear of it', async t => {
  const world = await setup(t);
  const one = fakeClient('one');
  const two = fakeClient('two');
  const a = (await world.create(one)).terminal.id;
  const b = (await world.create(one)).terminal.id;
  const initial = (await world.call(two, { type: 'subscribe_terminals_request', requestId: 'w1', cwd: '/w/a' })).payload;
  assert.deepEqual(initial.terminals.map(entry => entry.id).sort(), [a, b].sort());
  await world.subscribe(one, a);
  await world.subscribe(two, a);
  await world.subscribe(one, b);
  world.alpd.exit(a);
  assert.deepEqual(one.json('terminal_stream_exit').map(entry => entry.payload), [{ terminalId: a }]);
  assert.deepEqual(two.json('terminal_stream_exit').map(entry => entry.payload), [{ terminalId: a }]);
  world.alpd.terminals.get(a).forgotten = true;
  await until(() => two.json('terminals_changed').length === 2, 'terminals_changed after the exit');
  assert.deepEqual(two.json('terminals_changed').at(-1).payload, { cwd: '/w/a', terminals: [{ id: b, name: 'sh', workspaceId: 'ws-a', title: 'sh' }] });
  // Its slot is free again.
  const c = (await world.create(one)).terminal.id;
  assert.equal((await world.subscribe(one, c)).slot, 0);
  // Another ALP client took b: the app is told, and the bridge does not take it back by itself.
  const attaches = world.alpd.calls.filter(call => call.method === 'terminal.attach').length;
  const thief = await world.alpd.connect();
  await thief.request('terminal.attach', { terminalId: b });
  assert.match(one.json('terminal_stream_exit').at(-1).payload.error, /opened in another ALP client/);
  assert.equal(one.json('terminal_stream_exit').at(-1).payload.terminalId, b);
  await tick(50);
  assert.equal(world.alpd.calls.filter(call => call.method === 'terminal.attach').length, attaches + 1, 'no re-attach');
});

test('slow_consumer: the bridge attaches again after its last seq; a gap shows a marker, in order', async t => {
  const world = await setup(t);
  const client = fakeClient();
  const id = (await world.create(client)).terminal.id;
  await world.subscribe(client, id);
  world.alpd.out(id, 'a');
  world.alpd.detach(id, 'slow_consumer');
  world.alpd.out(id, 'b');
  world.alpd.out(id, 'c');
  await until(() => client.output(0) === 'abc', 'the missed output, once');
  assert.deepEqual(world.alpd.calls.filter(call => call.method === 'terminal.attach').at(-1).params, { terminalId: id, after: 1 });
  world.alpd.detach(id, 'slow_consumer');
  world.alpd.out(id, 'd');
  world.alpd.out(id, 'e');
  world.alpd.forget(id, 5);
  await until(() => client.output(0).endsWith('e'), 'output after the gap');
  assert.match(client.output(0), /^abc\r\n.*no longer kept.*\r\ne$/s);
  world.alpd.out(id, 'f');
  assert.equal(client.log.at(-1).data, 'f');
  const late = fakeClient('late');
  await world.subscribe(late, id);
  assert.match(late.frames(0, TerminalStreamOpcode.Restore)[0].data, /^abc\r\n.*no longer kept.*\r\nef$/s);
});

test('a gap before the bridge attached comes first in the Restore; the copy is trimmed to replayBytes', async t => {
  const world = await setup(t, { replayBytes: 100 });
  const client = fakeClient();
  const id = await world.alpd.create();
  world.alpd.out(id, 'lost');
  world.alpd.out(id, 'kept');
  world.alpd.forget(id, 2);
  await world.subscribe(client, id);
  assert.match(client.frames(0, TerminalStreamOpcode.Restore)[0].data, /^\r\n.*no longer kept.*\r\nkept$/s);
  world.alpd.out(id, '0123456789'.repeat(9) + '01234');
  world.alpd.out(id, 'é9');
  const late = fakeClient('late');
  await world.subscribe(late, id);
  assert.equal(late.frames(0, TerminalStreamOpcode.Restore)[0].data, '0123456789'.repeat(9) + '01234é9', 'the oldest pieces went');
  // One piece larger than the copy: its end is kept, whole characters only.
  world.alpd.out(id, '€'.repeat(40));
  const later = fakeClient('later');
  await world.subscribe(later, id);
  assert.equal(later.frames(0, TerminalStreamOpcode.Restore)[0].data, '€'.repeat(33));
});

test('a client over 4 MiB behind gets no live output, then a Restore once it drained', async t => {
  const world = await setup(t);
  const slow = fakeClient('slow');
  const fast = fakeClient('fast');
  const id = (await world.create(slow)).terminal.id;
  world.alpd.out(id, '\x1b[?1h');
  await world.subscribe(slow, id);
  await world.subscribe(fast, id);
  slow.setBuffered(5 * 1024 * 1024);
  world.alpd.out(id, 'x');
  world.alpd.out(id, 'y');
  assert.equal(fast.output(0).endsWith('xy'), true);
  const frames = slow.frames().length;
  await tick(50);
  assert.equal(slow.frames().length, frames, 'nothing while it is behind');
  slow.setBuffered(0);
  await until(() => slow.frames().length > frames, 'a resync');
  const resync = slow.frames().slice(frames);
  assert.deepEqual(resync.map(frame => frame.opcode), [TerminalStreamOpcode.Restore, TerminalStreamOpcode.Output]);
  assert.equal(resync[0].data, '\x1b[?1hxy');
  assert.match(resync[1].data, /\?1h/);
  world.alpd.out(id, 'z');
  assert.equal(slow.log.at(-1).data, 'z');
});

test('alpd went away: the bridge reconnects and attaches again after its last seq', async t => {
  const world = await setup(t);
  const client = fakeClient();
  const id = (await world.create(client)).terminal.id;
  await world.subscribe(client, id);
  world.alpd.out(id, 'before ');
  world.alpd.conns.at(-1).close();
  world.alpd.terminals.get(id).attached = null;
  world.alpd.out(id, 'while ');
  await until(() => world.alpd.conns.length === 2 && world.alpd.terminals.get(id).attached === world.alpd.conns[1], 'attached on a new connection');
  assert.deepEqual(world.alpd.calls.filter(call => call.method === 'terminal.attach').at(-1).params, { terminalId: id, after: 1 });
  world.alpd.out(id, 'after');
  await until(() => client.output(0) === 'before while after', 'every output once, in order');
  assert.equal(client.json('terminal_stream_exit').length, 0);
});

test('input: in order, in whole-character pieces of at most 64 KiB; mouse and strangers ignored', async t => {
  const world = await setup(t, { maxInputBytes: 1000 });
  const client = fakeClient();
  const stranger = fakeClient('stranger');
  const id = (await world.create(client)).terminal.id;
  await world.call(client, { type: 'terminal_input', terminalId: id, message: { type: 'input', data: 'early' } });
  await world.subscribe(client, id);
  const big = 'é'.repeat(1500) + 'end';
  await world.call(client, { type: 'terminal_input', terminalId: id, message: { type: 'input', data: big } });
  await world.call(client, { type: 'terminal_input', terminalId: id, message: { type: 'input', data: '\u0003' } });
  await world.call(client, { type: 'terminal_input', terminalId: id, message: { type: 'mouse', row: 1, col: 1, button: 0, action: 'down' } });
  await world.call(stranger, { type: 'terminal_input', terminalId: id, message: { type: 'input', data: 'not subscribed' } });
  const inputs = world.alpd.terminals.get(id).inputs;
  await until(() => inputs.at(-1) === '\u0003', 'every piece written');
  assert.ok(inputs.length >= 4, 'split');
  assert.ok(inputs.every(piece => Buffer.byteLength(piece) <= 1000));
  assert.equal(inputs.join(''), big + '\u0003', 'in order, nothing from before subscribe, the mouse or a stranger');

  const world2 = await setup(t);
  const id2 = (await world2.create(client)).terminal.id;
  await world2.subscribe(client, id2);
  const huge = 'a'.repeat(200 * 1024);
  await world2.call(client, { type: 'terminal_input', terminalId: id2, message: { type: 'input', data: huge } });
  await until(() => world2.alpd.terminals.get(id2).inputs.join('').length === huge.length, 'all of it');
  assert.ok(world2.alpd.terminals.get(id2).inputs.every(piece => Buffer.byteLength(piece) <= 64 * 1024));
});

test('kill and close_items close terminals and report successful agent archives', async t => {
  const archived = [];
  const world = await setup(t, { archiveAgent: async agentId => {
    if (agentId === 'missing') throw new Error('No agent missing');
    archived.push(agentId);
    return { agentId, archivedAt: '2026-01-01T00:00:00.000Z' };
  } });
  const client = fakeClient();
  const watcher = fakeClient('watcher');
  const a = (await world.create(client)).terminal.id;
  const b = (await world.create(client)).terminal.id;
  const c = (await world.create(client)).terminal.id;
  await world.subscribe(client, a);
  await world.call(watcher, { type: 'subscribe_terminals_request', requestId: 'w1', cwd: '/w/a', workspaceId: 'ws-a' });
  const killed = (await world.call(client, { type: 'kill_terminal_request', terminalId: a, requestId: 'k1' })).payload;
  assert.deepEqual(killed, { terminalId: a, success: true, requestId: 'k1' });
  assert.deepEqual(world.alpd.calls.filter(call => call.method === 'terminal.close').map(call => call.params), [{ terminalId: a }]);
  assert.deepEqual(client.json('terminal_stream_exit').map(entry => entry.payload), [{ terminalId: a }]);
  await until(() => watcher.json('terminals_changed').at(-1).payload.terminals.length === 2, 'the list without it');
  assert.equal((await world.call(client, { type: 'kill_terminal_request', terminalId: a, requestId: 'k2' })).payload.success, false, 'gone');
  assert.equal((await world.call(client, { type: 'kill_terminal_request', terminalId: 'term_ffffffffffffffffffffffffffffffff', requestId: 'k3' })).payload.success, false);
  const closed = (await world.call(client, { type: 'close_items_request', agentIds: [], terminalIds: [b, 'term_ffffffffffffffffffffffffffffffff'], requestId: 'x1' })).payload;
  assert.deepEqual(closed, { agents: [], terminals: [{ terminalId: b, success: true }, { terminalId: 'term_ffffffffffffffffffffffffffffffff', success: false }], requestId: 'x1' });
  const mixed = await world.call(client, { type: 'close_items_request', agentIds: ['agent-1', 'missing', 'agent-2'], terminalIds: [c], requestId: 'x2' });
  assert.deepEqual(mixed, { type: 'close_items_response', payload: { requestId: 'x2', agents: ['agent-1', 'agent-2'].map(agentId => ({ agentId, archivedAt: '2026-01-01T00:00:00.000Z' })), terminals: [{ terminalId: c, success: true }] } });
  assert.deepEqual(archived, ['agent-1', 'agent-2']);
  assert.match(world.logs.at(-1), /No agent missing/);
  assert.deepEqual((await world.call(client, { type: 'close_items_request', agentIds: [], terminalIds: [], requestId: 'empty' })).payload, { agents: [], terminals: [], requestId: 'empty' });
  const replay = await world.call(client, { type: 'close_items_request', agentIds: ['agent-1'], terminalIds: [c], requestId: 'x2' });
  assert.deepEqual(replay.payload, { requestId: 'x2', agents: [{ agentId: 'agent-1', archivedAt: '2026-01-01T00:00:00.000Z' }], terminals: [{ terminalId: c, success: false }] });
  assert.equal(world.alpd.terminals.get(c).state, 'exited', 'its terminals closed all the same');
  const renamed = (await world.call(client, { type: 'terminal.rename.request', terminalId: c, title: 'x', requestId: 'n1' })).payload;
  assert.equal(renamed.success, false);
  assert.match(renamed.error, /cannot rename/);
  assert.equal(world.terminals.handlers.capture_terminal_request, undefined, 'capture answers "in development" from the gateway');
});

test('a client that leaves loses its slots and subscriptions; the terminal keeps running and attached', async t => {
  const world = await setup(t, { timing: { pollMs: 20 } });
  const one = fakeClient('one');
  const two = fakeClient('two');
  const id = (await world.create(one)).terminal.id;
  await world.subscribe(one, id);
  await world.subscribe(two, id);
  await world.call(one, { type: 'subscribe_terminals_request', requestId: 'w1', cwd: '/w/a' });
  await world.call(one, { type: 'terminal_input', terminalId: id, message: { type: 'resize', cols: 90, rows: 30, intent: 'claim' } });
  world.terminals.drop(one);
  const seen = one.log.length;
  world.alpd.out(id, 'still');
  await world.alpd.create();
  await tick(80);
  assert.equal(one.log.length, seen, 'nothing more for a client that left');
  assert.equal(two.output(0), 'still');
  assert.equal(world.alpd.calls.filter(call => call.method === 'terminal.close').length, 0);
  assert.equal(world.alpd.terminals.get(id).attached, world.alpd.conns[0]);
  // The size claim went with it: another client's update now applies.
  await world.call(two, { type: 'terminal_input', terminalId: id, message: { type: 'resize', cols: 70, rows: 20, intent: 'update' } });
  await until(() => world.alpd.terminals.get(id).cols === 70, 'the update applied');
});

test('a watched directory hears of terminals made elsewhere within the poll interval', async t => {
  const world = await setup(t, { timing: { pollMs: 20 } });
  const client = fakeClient();
  await world.call(client, { type: 'subscribe_terminals_request', requestId: 'w1', cwd: '/w/b' });
  const id = await world.alpd.create('ws-b');
  await world.alpd.create('ws-a');
  await until(() => client.json('terminals_changed').length === 2, 'a pushed change');
  assert.deepEqual(client.json('terminals_changed').at(-1).payload, { cwd: '/w/b', terminals: [{ id, name: 'sh', workspaceId: 'ws-b', title: 'sh' }] });
  await tick(60);
  assert.equal(client.json('terminals_changed').length, 2, 'only on a change');
  await world.call(client, { type: 'unsubscribe_terminals_request', cwd: '/w/b' });
  const lists = world.alpd.calls.filter(call => call.method === 'terminal.list').length;
  await tick(60);
  assert.equal(world.alpd.calls.filter(call => call.method === 'terminal.list').length, lists, 'no poll without a subscription');
});

// ── A real shell through a real alpd and the real bridge ─────────────────────────────────────────

const realSkip = process.platform !== 'darwin' ? 'the real terminal check runs on macOS'
  : await import('node-pty').then(() => false, () => 'node-pty is not installed');

test('real: create, type, see the output; a new client gets a Restore holding it; kill ends it and every process', { skip: realSkip }, async t => {
  process.env.SHELL = '/bin/sh';
  process.env.PS1 = 'PROMPT$ ';
  process.env.ENV = '';
  const [{ createDaemonServer, createStore }, { createAlpRuntime }, { initProject }, { connect }, { createPaseoBridge }, { spawn: realSpawn }] = await Promise.all([
    import('@anhlp/alp-daemon'), import('@anhlp/alp-runtime'), import('@anhlp/alp-core/init'), import('@anhlp/alp-client/index'), import('@anhlp/alp-paseo'), import('node-pty'),
  ]);
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-paseo-real-')));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(home, 'terminal.json'), JSON.stringify({ version: 1, allowRemoteTerminal: true, allowPaseoTerminal: true }), { mode: 0o600 });
  const pids = new Set();
  const runtime = createAlpRuntime({ transport: () => ({ async initialize() {}, onNotification() {}, onFailure() {}, onRequest() {}, async close() {}, async request() { return {}; } }), runLogDir: path.join(directory, 'runs') });
  const socketPath = path.join(directory, 's', 'alpd.sock');
  const server = createDaemonServer({
    runtime, socketPath, version: 'test', store: createStore(path.join(home, 'state')), home,
    terminalOptions: { sweepMs: 50, killGraceMs: 200, spawn: (...args) => { const pty = realSpawn(...args); pids.add(pty.pid); return pty; } },
  });
  await server.listen();
  const owner = await connect(socketPath);
  await owner.request('project.register', { directory: project, ifRevision: 0, requestId: 'p1' });
  const token = 'a'.repeat(64);
  const bridge = createPaseoBridge({
    version: 'test', home, token: () => token, serverId: () => 'alp-0000000000000000',
    clientFactory: async onEvent => { const connection = await connect(socketPath); connection.onEvent(onEvent); return connection; },
  });
  const tree = () => {
    const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,pgid='], { encoding: 'utf8' }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const found = new Set(pids);
    let grew = true;
    while (grew) { grew = false; for (const [pid, ppid] of rows) if (!found.has(pid) && found.has(ppid)) { found.add(pid); grew = true; } }
    const groups = new Set(rows.filter(([pid]) => found.has(pid)).map(([, , pgid]) => pgid));
    for (const [pid, , pgid] of rows) if (groups.has(pgid) && pgid !== process.pid) found.add(pid);
    return [...found];
  };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const seen = new Set();
  t.after(async () => {
    try {
      for (const pid of tree()) seen.add(pid);
      bridge.close();
      owner.close();
      await server.close().catch(() => {});
      await runtime.shutdown?.();
      await until(() => [...seen].every(pid => !alive(pid)), 'every process of the terminal gone', 8000);
    } finally {
      for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch {} }
      for (const pid of seen) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
  /** A socket as the app's: JSON frames pass Paseo's validator, binary ones decode as terminal frames. */
  const app = async name => {
    const listeners = { message: [], close: [], error: [] };
    const json = [];
    const frames = [];
    const ws = {
      readyState: 1, bufferedAmount: 0,
      send(data) {
        if (typeof data === 'string') {
          const frame = JSON.parse(data);
          const checked = validateWSOutboundMessage(frame);
          assert.ok(checked.success, `${data.slice(0, 300)}\n${checked.error}`);
          json.push(frame.message ?? frame);
        } else {
          const decoded = decodeBinaryFrame(data);
          assert.equal(decoded?.kind, 'terminal');
          frames.push({ opcode: decoded.frame.opcode, slot: decoded.frame.slot, data: text(decoded.frame.payload) });
        }
      },
      close() { ws.readyState = 3; for (const listener of listeners.close) listener(1000, ''); },
      on(event, listener) { listeners[event].push(listener); },
    };
    bridge.attach(ws);
    const send = frame => { for (const listener of listeners.message) listener(JSON.stringify(frame), false); };
    send({ type: 'hello', clientId: name, clientType: 'browser', protocolVersion: 1, auth: { kind: 'password', password: token } });
    await until(() => json.some(message => message.payload?.status === 'server_info'), 'server_info');
    const ask = async (message, type) => {
      send({ type: 'session', message });
      await until(() => json.some(entry => entry.type === type && entry.payload?.requestId === message.requestId), type);
      return json.find(entry => entry.type === type && entry.payload?.requestId === message.requestId).payload;
    };
    return { ws, json, frames, send: message => send({ type: 'session', message }), ask, output: () => frames.filter(frame => frame.opcode === TerminalStreamOpcode.Output).map(frame => frame.data).join('') };
  };

  const first = await app('first');
  assert.equal(first.json.find(message => message.payload?.status === 'server_info').payload.features.workspaceTerminals, true);
  const created = await first.ask({ type: 'create_terminal_request', requestId: 'c1', cwd: project }, 'create_terminal_response');
  assert.equal(created.error, null);
  const id = created.terminal.id;
  first.send({ type: 'terminal_input', terminalId: id, message: { type: 'resize', cols: 100, rows: 30, intent: 'claim' } });
  const subscribed = await first.ask({ type: 'subscribe_terminal_request', terminalId: id, requestId: 's1' }, 'subscribe_terminal_response');
  assert.equal(subscribed.error, null);
  await until(() => /PROMPT\$ /.test(first.frames.map(frame => frame.data).join('')), 'the prompt');
  for (const pid of tree()) seen.add(pid);
  first.send({ type: 'terminal_input', terminalId: id, message: { type: 'input', data: 'echo alp-ok\r' } });
  // The typed line echoes once, the command prints once.
  await until(() => (first.output().match(/alp-ok\r\n/g) ?? []).length >= 2, 'alp-ok printed');

  const second = await app('second');
  await second.ask({ type: 'subscribe_terminal_request', terminalId: id, requestId: 's2' }, 'subscribe_terminal_response');
  const restored = second.frames.find(frame => frame.opcode === TerminalStreamOpcode.Restore);
  assert.ok(restored, 'a Restore frame');
  assert.match(restored.data, /alp-ok\r\n/);
  // The first app goes away; the terminal keeps running for the second.
  first.ws.close();
  second.send({ type: 'terminal_input', terminalId: id, message: { type: 'input', data: 'echo second-$((40+2))\r' } });
  await until(() => second.output().includes('second-42'), 'the second client types');

  for (const pid of tree()) seen.add(pid);
  const killed = await second.ask({ type: 'kill_terminal_request', terminalId: id, requestId: 'k1' }, 'kill_terminal_response');
  assert.equal(killed.success, true);
  await until(() => second.json.some(message => message.type === 'terminal_stream_exit' && message.payload.terminalId === id), 'terminal_stream_exit');
  await until(() => [...seen].every(pid => !alive(pid)), 'every process of the terminal gone after kill', 8000);
});

test('a create requestId is namespaced per Paseo client: two devices never share a terminal by reusing one', async t => {
  const world = await setup(t);
  const one = fakeClient('device-1');
  const two = fakeClient('device-2');
  const a = await world.call(one, { type: 'create_terminal_request', requestId: 'same', cwd: '/w/a' });
  const b = await world.call(two, { type: 'create_terminal_request', requestId: 'same', cwd: '/w/a' });
  const ids = world.alpd.terminalCalls().filter(call => call.method === 'terminal.create').map(call => call.params.requestId);
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every(id => id.length <= 128 && !id.includes('device')), 'bounded, no client id in clear');
  assert.notEqual(a.payload.terminal.id, b.payload.terminal.id);
});
