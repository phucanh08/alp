// Issue #121 H: the Terminal tab's logic (lib/terminal.js) — gating on the host's switch and the
// token's terminal.exec, create/attach, replay bookkeeping by seq, gaps, input batching within
// maxInputBytes, debounced resize, reconnect, replaced and exit — and the controller's routing of
// terminal.event notifications through a fake host. No real shell is reached here; the e2e
// (e2e/terminal.spec.js) runs a real PTY through the real gateway and alpd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AlpRpcError } from '@anhlp/alp-client/portable';
import { TERMINAL } from '@anhlp/alp-protocol';
import { Controller } from '../src/lib/controller.js';
import { TERMINAL_MESSAGES, TerminalSession, clampSize, exitText, gapMarker, splitUtf8, terminalGate, terminalLimits } from '../src/lib/terminal.js';
import { FakeHost, until } from './support/fake-host.js';

const ID = `term_${'a'.repeat(32)}`;
const ID2 = `term_${'b'.repeat(32)}`;
const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
const info = (terminalId = ID, extra = {}) => ({ terminalId, workspaceId: 'wks_a', title: 'sh', cols: 80, rows: 24, state: 'running', attached: true, createdAt: 'x', lastActivityAt: 'x', expiresAt: 'x', ...extra });
const out = (seq, data, terminalId = ID) => ({ terminalId, type: 'output', seq, data });
const rpcError = (code, reason, message = 'refused') => new AlpRpcError({ code, message, data: { reason } });

/** A memory sessionStorage. */
function memoryStorage() {
  const map = new Map();
  return { map, getItem: key => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)); }, removeItem: key => { map.delete(key); } };
}

/**
 * A TerminalSession on a scripted host: `handlers[method](params, session)` answers (or throws);
 * every call is recorded. Output written goes to `screen`.
 */
function rig({ handlers = {}, limits, storage = memoryStorage(), ...options } = {}) {
  const calls = [];
  let session;
  const defaults = {
    'terminal.create': () => ({ terminal: info() }),
    'terminal.attach': () => ({ terminal: info(), nextSeq: 1 }),
    'terminal.input': params => ({ bytes: Buffer.byteLength(params.data) }),
    'terminal.resize': params => ({ cols: params.cols, rows: params.rows }),
    'terminal.close': () => ({ closed: true }),
  };
  const request = async (method, params) => {
    calls.push([method, params]);
    const handler = handlers[method] ?? defaults[method];
    return handler(params, session);
  };
  session = new TerminalSession({ workspaceId: 'wks_a', request, storage, storageKey: 'k', inputDelayMs: 1, resizeDelayMs: 5, newRequestId: (() => { let n = 0; return () => `req-${++n}`; })(), ...(limits ? { limits } : {}), ...options });
  const screen = [];
  session.onOutput(text => screen.push(text));
  return { session, calls, screen, storage, of: method => calls.filter(([name]) => name === method).map(([, params]) => params) };
}

// ---- pure helpers ----------------------------------------------------------------------------

test('splitUtf8 cuts at most max UTF-8 bytes and never inside a character', () => {
  assert.deepEqual(splitUtf8('abcdef', 4), ['abcd', 'ef']);
  assert.deepEqual(splitUtf8('aé€', 3), ['aé', '€']); // 1 + 2 bytes, then 3
  assert.deepEqual(splitUtf8('a😀b', 4), ['a', '😀b']); // the emoji is 4 bytes (a surrogate pair)
  assert.deepEqual(splitUtf8('😀b', 4), ['😀', 'b']);
  assert.deepEqual(splitUtf8('', 4), ['', '']);
});

test('terminalLimits takes the hello\'s values, never above TERMINAL, and TERMINAL\'s for what is missing or bad', () => {
  assert.deepEqual(terminalLimits(undefined), Object.fromEntries(['maxPerPrincipal', 'maxPerDaemon', 'maxInputBytes', 'maxOutputFrameBytes', 'replayBytes', 'idleMs', 'maxLifetimeMs', 'reconnectMs'].map(key => [key, TERMINAL[key]])));
  const limits = terminalLimits({ maxInputBytes: 1024, reconnectMs: 10 * TERMINAL.reconnectMs, idleMs: -1, maxPerDaemon: 'x' });
  assert.equal(limits.maxInputBytes, 1024);
  assert.equal(limits.reconnectMs, TERMINAL.reconnectMs);
  assert.equal(limits.idleMs, TERMINAL.idleMs);
  assert.equal(limits.maxPerDaemon, TERMINAL.maxPerDaemon);
});

test('clampSize keeps cols 2-500 and rows 1-200', () => {
  assert.deepEqual(clampSize(1, 0), { cols: 2, rows: 1 });
  assert.deepEqual(clampSize(900.7, 300), { cols: 500, rows: 200 });
  assert.deepEqual(clampSize(120.9, 40.2), { cols: 120, rows: 40 });
});

test('exitText: "Process exited (code N / reason)"', () => {
  assert.equal(exitText({ exitCode: 0, signal: null, reason: 'exited' }), 'Process exited (code 0)');
  assert.equal(exitText({ exitCode: null, signal: 1, reason: 'closed' }), 'Process exited (signal 1 / closed)');
  assert.equal(exitText({ exitCode: null, signal: null, reason: 'idle' }), 'Process exited (ended after being idle)');
  assert.equal(exitText({ exitCode: 130, signal: null, reason: 'disabled' }), 'Process exited (code 130 / the host turned terminals off)');
});

test('terminalGate: the host\'s switch and the token\'s terminal.exec, each said plainly, then the registry workspace', () => {
  const principal = permissions => ({ id: 'p', permissions, workspaces: ['/w/a'], workspaceRoots: [{ path: '/w/a', canonical: '/real/a' }] });
  const row = { id: 'wks_a', projectId: 'p', directory: '/real/a', labels: [], createdAt: 'x' };
  const state = (capabilities, permissions, rows = [row], extra = {}) => ({ connection: { phase: 'open', capabilities }, principal: principal(permissions), workspace: '/w/a', registry: { workspaces: rows, ...extra } });
  const all = ['terminal', 'workspace.registry'];
  assert.deepEqual(terminalGate(state(all, ['terminal.exec'])), { ok: true, workspaceId: 'wks_a' });
  assert.deepEqual(terminalGate(state(['workspace.registry'], ['terminal.exec'])).messages, ['The host has not allowed remote terminals (its owner runs: alp terminal allow --yes)']);
  assert.deepEqual(terminalGate(state(all, ['session.read', 'session.write', 'project.read'])).messages, ['Your access token cannot open terminals (it needs terminal.exec)']);
  assert.deepEqual(terminalGate(state(['workspace.registry'], ['session.write'])).reasons, ['capability', 'permission']);
  // session.write implies nothing: only terminal.exec opens terminals.
  assert.equal(terminalGate(state(all, ['session.write', 'session.team.write', 'workspace.manage'])).ok, false);
  assert.deepEqual(terminalGate(state(['terminal'], ['terminal.exec'])).reasons, ['registry']);
  assert.deepEqual(terminalGate(state(all, ['terminal.exec'], [], { loading: true })).reasons, ['loading']);
  assert.deepEqual(terminalGate(state(all, ['terminal.exec'], [])).reasons, ['unregistered']);
  assert.deepEqual(terminalGate(state(all, ['terminal.exec'], [{ ...row, directory: '/elsewhere' }])).reasons, ['unregistered']);
  assert.deepEqual(terminalGate({ ...state(all, ['terminal.exec']), workspace: null }).reasons, ['workspace']);
  assert.equal(TERMINAL_MESSAGES.permission, 'Your access token cannot open terminals (it needs terminal.exec)');
});

// ---- the session -------------------------------------------------------------------------------

test('start creates a terminal in the workspace at the view\'s size, keeps its id for the page, attaches and streams', async () => {
  const r = rig({ handlers: {
    'terminal.attach': (_params, session) => { session.event(out(1, 'hello ')); session.event(out(2, 'world')); return { terminal: info(), nextSeq: 3 }; },
  } });
  r.session.start(100, 30);
  await until(() => r.session.getState().status === 'running', 'running');
  assert.deepEqual(r.of('terminal.create'), [{ workspaceId: 'wks_a', cols: 100, rows: 30, requestId: 'req-1' }]);
  assert.deepEqual(r.of('terminal.attach'), [{ terminalId: ID }]);
  assert.equal(r.screen.join(''), 'hello world');
  assert.equal(r.session.lastSeq, 2);
  assert.equal(r.storage.map.get('k'), ID);
  r.session.event(out(3, '!'));
  r.session.event(out(3, '!')); // a duplicate never shows twice
  r.session.event(out(2, 'world')); // nor an older one
  assert.equal(r.session.history(), 'hello world!');
  r.session.start(1, 1); // once only
  assert.equal(r.of('terminal.create').length, 1);
});

test('an attach\'s replay waits for its answer: the gap line comes before the output that follows it', async () => {
  const r = rig({ handlers: {
    'terminal.attach': (_params, session) => { session.event(out(41, 'later')); return { terminal: info(), nextSeq: 42, gap: { fromSeq: 1, toSeq: 40 } }; },
  } });
  r.session.start(80, 24);
  await until(() => r.session.getState().status === 'running', 'running');
  assert.equal(r.screen.length, 2);
  assert.match(r.screen[0], /\[output lost: 40 output events \(#1–40\) are no longer kept by the host\]/);
  assert.equal(r.screen[1], 'later');
  // A jump in a running stream is also said.
  r.session.event(out(45, 'x'));
  assert.match(r.screen[2], /\[output lost: 3 output events \(#42–44\)/);
  assert.equal(gapMarker(7, 7).includes('1 output event (#7)'), true);
});

test('input is batched and in order, one request at a time, each at most maxInputBytes UTF-8 bytes', async () => {
  let release;
  const r = rig({ limits: terminalLimits({ maxInputBytes: 8 }), handlers: {
    'terminal.input': params => new Promise(resolve => { release = () => resolve({ bytes: Buffer.byteLength(params.data) }); }),
  } });
  r.session.start(80, 24);
  await until(() => r.session.accepting, 'running');
  for (const key of ['e', 'c', 'h', 'o']) assert.equal(r.session.input(key), true);
  await until(() => r.of('terminal.input').length === 1, 'first batch');
  // While it is on its way, more keys wait and go together after it, split at 8 bytes.
  r.session.input(' héllo wörld\r');
  await tick(10);
  assert.equal(r.of('terminal.input').length, 1);
  release();
  await until(() => r.of('terminal.input').length === 2, 'second');
  release();
  await until(() => r.of('terminal.input').length === 3, 'third');
  release();
  await tick(10);
  const sent = r.of('terminal.input').map(params => params.data);
  assert.deepEqual(sent, ['echo', ' héllo ', 'wörld\r']);
  assert.ok(sent.every(data => Buffer.byteLength(data) <= 8));
  assert.ok(r.of('terminal.input').every(params => params.terminalId === ID));
});

test('a debounced resize sends the last size once, clamped, and not again when unchanged', async () => {
  const r = rig();
  r.session.start(80, 24);
  await until(() => r.session.accepting, 'running');
  r.session.resize(90, 30);
  r.session.resize(100, 31);
  r.session.resize(1000, 2);
  await tick(30);
  assert.deepEqual(r.of('terminal.resize'), [{ terminalId: ID, cols: 500, rows: 2 }]);
  r.session.resize(1000, 2);
  await tick(30);
  assert.equal(r.of('terminal.resize').length, 1);
});

test('exit ends input and says how; a new terminal can replace it', async () => {
  const r = rig();
  r.session.start(80, 24);
  await until(() => r.session.accepting, 'running');
  r.session.event({ terminalId: ID, type: 'exit', seq: 1, exitCode: 0, signal: null, reason: 'exited' });
  assert.equal(r.session.getState().status, 'exited');
  assert.equal(exitText(r.session.getState().exit), 'Process exited (code 0)');
  assert.equal(r.session.input('ls\r'), false);
  await tick(10);
  assert.equal(r.of('terminal.input').length, 0);
  r.session.restart();
  await until(() => r.of('terminal.create').length === 2 && r.session.accepting, 'restarted');
  assert.deepEqual(r.of('terminal.close'), [{ terminalId: ID }]);
  assert.notEqual(r.of('terminal.create')[1].requestId, r.of('terminal.create')[0].requestId);
});

test('a reconnect attaches again after the last seq seen; input waits for it and is never resent', async () => {
  let attaches = 0;
  const r = rig({ handlers: {
    'terminal.attach': (params, session) => {
      attaches += 1;
      if (attaches === 1) { session.event(out(1, 'a')); session.event(out(2, 'b')); return { terminal: info(), nextSeq: 3 }; }
      session.event(out(5, 'e'));
      return { terminal: info(), nextSeq: 6, gap: { fromSeq: 3, toSeq: 4 } };
    },
  } });
  r.session.start(80, 24);
  await until(() => r.session.accepting, 'running');
  r.session.disconnected();
  assert.equal(r.session.getState().status, 'reconnecting');
  assert.equal(r.session.input('x'), false);
  r.session.resize(100, 30); // the window changed meanwhile
  await tick(20);
  assert.equal(r.of('terminal.resize').length, 0);
  r.session.connected();
  await until(() => r.session.accepting, 'running again');
  assert.deepEqual(r.of('terminal.attach'), [{ terminalId: ID }, { terminalId: ID, after: 2 }]);
  assert.equal(r.screen[0] + r.screen[1], 'ab');
  assert.match(r.screen[2], /\[output lost: 2 output events \(#3–4\)/);
  assert.equal(r.screen[3], 'e');
  assert.equal(r.session.lastSeq, 5);
  // The size the view took meanwhile is sent once attached again.
  await until(() => r.of('terminal.resize').length === 1, 'resize after reattach');
  assert.deepEqual(r.of('terminal.resize'), [{ terminalId: ID, cols: 100, rows: 30 }]);
});

test('input in flight when the connection drops is said to be maybe lost, not sent again', async () => {
  const r = rig({ handlers: {
    'terminal.input': async () => { throw Object.assign(new Error('closed'), { reason: 'disconnected', name: 'AlpClientError' }); },
  } });
  r.session.start(80, 24);
  await until(() => r.session.accepting, 'running');
  r.session.input('rm -rf build\r');
  await until(() => r.session.getState().lost, 'lost note');
  await tick(10);
  assert.equal(r.of('terminal.input').length, 1);
  assert.match(r.session.history(), /may not have reached the shell/);
});

test('detached replaced: "Opened in another client" until Reattach; slow_consumer attaches again by itself', async () => {
  const r = rig();
  r.session.start(80, 24);
  await until(() => r.session.accepting, 'running');
  r.session.event(out(1, 'x'));
  r.session.event({ terminalId: ID, type: 'detached', reason: 'replaced' });
  assert.equal(r.session.getState().status, 'replaced');
  assert.equal(r.session.input('y'), false);
  r.session.reattach();
  await until(() => r.session.accepting, 'reattached');
  assert.deepEqual(r.of('terminal.attach').at(-1), { terminalId: ID, after: 1 });
  r.session.event({ terminalId: ID, type: 'detached', reason: 'slow_consumer' });
  await until(() => r.of('terminal.attach').length === 3 && r.session.accepting, 'auto reattach');
  assert.deepEqual(r.of('terminal.attach').at(-1), { terminalId: ID, after: 1 });
  // Another terminal's events are not this one's.
  r.session.event(out(2, 'other', ID2));
  assert.equal(r.session.history(), 'x');
});

test('a reload attaches the kept terminal from the start; one the host forgot is replaced by a new one', async () => {
  const storage = memoryStorage();
  storage.setItem('k', ID);
  const r = rig({ storage, handlers: {
    'terminal.attach': (_params, session) => { session.event(out(1, 'before reload')); return { terminal: info(), nextSeq: 2 }; },
  } });
  r.session.start(80, 24);
  await until(() => r.session.accepting, 'running');
  assert.deepEqual(r.of('terminal.attach'), [{ terminalId: ID }]);
  assert.equal(r.of('terminal.create').length, 0);
  assert.equal(r.session.history(), 'before reload');

  const kept = memoryStorage();
  kept.setItem('k', ID2);
  const gone = rig({ storage: kept, handlers: {
    'terminal.attach': params => { if (params.terminalId === ID2) throw rpcError(1001, 'not_found'); return { terminal: info(), nextSeq: 1 }; },
  } });
  gone.session.start(80, 24);
  await until(() => gone.session.accepting, 'fresh');
  assert.equal(gone.of('terminal.create').length, 1);
  assert.equal(kept.map.get('k'), ID);
});

test('refusals are said plainly and never shown as a running terminal', async () => {
  const off = rig({ handlers: { 'terminal.create': () => { throw rpcError(1005, 'terminal_disabled'); } } });
  off.session.start(80, 24);
  await until(() => off.session.getState().status === 'failed', 'failed');
  assert.equal(off.session.getState().error, TERMINAL_MESSAGES.capability);
  assert.equal(off.of('terminal.attach').length, 0);
  const full = rig({ handlers: { 'terminal.create': () => { throw rpcError(1005, 'terminal_limit'); } } });
  full.session.start(80, 24);
  await until(() => full.session.getState().status === 'failed', 'failed');
  assert.match(full.session.getState().error, /Too many terminals/);
});

test('a create whose answer was lost is repeated with the same requestId once the connection is back', async () => {
  let creates = 0;
  const r = rig({ handlers: {
    'terminal.create': () => { if (++creates === 1) throw Object.assign(new Error('closed'), { reason: 'disconnected', name: 'AlpClientError' }); return { terminal: info() }; },
  } });
  r.session.start(80, 24);
  await until(() => r.session.getState().status === 'reconnecting', 'reconnecting');
  r.session.disconnected();
  r.session.connected();
  await until(() => r.session.accepting, 'running');
  assert.deepEqual(r.of('terminal.create').map(params => params.requestId), ['req-1', 'req-1']);
});

test('close ends the terminal on the host and forgets it for the page', async () => {
  const r = rig();
  r.session.start(80, 24);
  await until(() => r.session.accepting, 'running');
  await r.session.close();
  assert.deepEqual(r.of('terminal.close'), [{ terminalId: ID }]);
  assert.equal(r.storage.map.has('k'), false);
  assert.equal(r.session.getState().status, 'closed');
  assert.equal(r.session.input('x'), false);
});

// ---- through the controller --------------------------------------------------------------------

const ROW = { id: 'wks_a', projectId: 'prj', directory: '/w/a', canonical: '/w/a', labels: [], createdAt: 'x', revision: 1 };

function hostWith({ permissions = ['session.read', 'session.write', 'project.read', 'terminal.exec'], capabilities = ['workspace.registry', 'terminal'] } = {}) {
  const host = new FakeHost({ principal: { id: 'p1', label: 'tests', permissions, workspaces: ['/w/a'], workspaceRoots: [{ path: '/w/a', canonical: '/w/a' }] } });
  host.capabilities.push(...capabilities);
  host.intercept.set('workspace.list', (_params, _connection, { answer }) => { answer({ workspaces: [ROW], revision: 1, total: 1, nextCursor: null }); return 'handled'; });
  let seq = 0;
  host.intercept.set('terminal.create', (_params, _connection, { answer }) => { answer({ terminal: info() }); return 'handled'; });
  host.intercept.set('terminal.attach', (params, connection, { answer }) => {
    // Replay before the answer, as alpd sends it: everything after `after`.
    for (let at = (params.after ?? 0) + 1; at <= seq; at++) connection.deliver(JSON.stringify({ jsonrpc: '2.0', method: 'terminal.event', params: out(at, `#${at}`) }));
    answer({ terminal: info(), nextSeq: seq + 1 });
    return 'handled';
  });
  host.intercept.set('terminal.input', (params, connection, { answer }) => {
    seq += 1;
    connection.deliver(JSON.stringify({ jsonrpc: '2.0', method: 'terminal.event', params: out(seq, `echo:${params.data}`) }));
    answer({ bytes: params.data.length });
    return 'handled';
  });
  host.intercept.set('terminal.resize', (params, _connection, { answer }) => { answer({ cols: params.cols, rows: params.rows }); return 'handled'; });
  host.intercept.set('terminal.close', (_params, _connection, { answer }) => { answer({ closed: true }); return 'handled'; });
  return host;
}

async function connectController(t, host) {
  const controller = new Controller({ open: host.open, backoff: { initialMs: 5, maxMs: 20, jitter: 0 }, stableMs: 1, taskPollMs: 60_000, sessionPollMs: 60_000, attentionWatchPollMs: 60_000, requestTimeoutMs: 2_000, releaseTimeoutMs: 500, terminalStorage: memoryStorage(), terminalOptions: { inputDelayMs: 1, resizeDelayMs: 5 } });
  t.after(() => controller.disconnect());
  controller.connect({ url: 'http://127.0.0.1:7434', token: 'alpgw1.0123456789abcdef.secret' });
  await until(() => controller.getState().connection.phase === 'open', 'open');
  controller.selectWorkspace('/w/a');
  await until(() => controller.getState().registry.workspaces.length > 0, 'registry');
  return controller;
}

test('controller: terminal.event notifications reach the terminal; a dropped connection reattaches after the last seq', async t => {
  const host = hostWith();
  const controller = await connectController(t, host);
  assert.deepEqual(controller.terminalGate(), { ok: true, workspaceId: 'wks_a' });
  assert.equal(controller.getState().connection.terminalLimits?.maxInputBytes, TERMINAL.maxInputBytes);
  const session = controller.terminal('wks_a');
  assert.equal(controller.terminal('wks_a'), session);
  const screen = [];
  session.onOutput(text => screen.push(text));
  session.start(80, 24);
  await until(() => session.accepting, 'running');
  session.input('one');
  await until(() => screen.join('') === 'echo:one', 'echo');
  host.drop();
  await until(() => session.getState().status === 'reconnecting', 'reconnecting');
  await until(() => session.accepting, 'reattached');
  const attaches = host.calls.filter(call => call.method === 'terminal.attach').map(call => call.params);
  assert.deepEqual(attaches.map(params => params.after), [undefined, 1]);
  session.input('two');
  await until(() => screen.join('') === 'echo:oneecho:two', 'echo after reconnect');
  await controller.closeTerminal();
  assert.deepEqual(host.calls.filter(call => call.method === 'terminal.close').map(call => call.params.terminalId), [ID]);
});

test('controller: no terminal without terminal.exec or the host\'s switch, and none is made', async t => {
  const host = hostWith({ permissions: ['session.read', 'session.write', 'project.read'] });
  const controller = await connectController(t, host);
  const gate = controller.terminalGate();
  assert.equal(gate.ok, false);
  assert.deepEqual(gate.ok ? [] : gate.messages, [TERMINAL_MESSAGES.permission]);
  assert.throws(() => controller.terminal('wks_a'), /terminal\.exec/);
  const off = hostWith({ capabilities: ['workspace.registry'] });
  const other = await connectController(t, off);
  assert.deepEqual(other.terminalGate().messages, [TERMINAL_MESSAGES.capability]);
  assert.equal(host.calls.concat(off.calls).some(call => call.method.startsWith('terminal.')), false);
});

test('controller: a page going away keeps its terminal for the reload; a person\'s Disconnect ends it', async t => {
  const closes = host => host.calls.filter(call => call.method === 'terminal.close').length;
  const kept = hostWith();
  const reloading = await connectController(t, kept);
  const first = reloading.terminal('wks_a');
  first.start(80, 24);
  await until(() => first.accepting, 'running');
  reloading.disconnect({ keepTerminals: true });
  await tick(20);
  assert.equal(closes(kept), 0);

  const ended = hostWith();
  const leaving = await connectController(t, ended);
  const second = leaving.terminal('wks_a');
  second.start(80, 24);
  await until(() => second.accepting, 'running');
  leaving.disconnect();
  await until(() => closes(ended) === 1, 'terminal.close');
});
