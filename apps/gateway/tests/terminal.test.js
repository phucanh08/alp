// Terminals through the gateway (docs/protocol/alp-json-rpc-v1.md §12.10, docs/alp/remote-gateway.md
// §5.18, issue #121 branch H): terminal.exec only (never a default, implied by nothing, session.write
// included); the workspace checked against the grant before alpd; the gateway's own principal context
// on every call whatever the client sends; terminal.event passed on only for terminals this connection
// attached, projected; alpd's refusals rewritten; and a revoked or changed credential's terminals ended
// through terminal.revoke. alpd's own binding and real PTYs are tested in packages/daemon/tests and
// test/integration/gateway.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TERMINAL } from '@anhlp/alp-protocol';
import { DEFAULT_PERMISSIONS, EXPOSURE, FORWARDED_CAPABILITIES, PERMISSIONS, TERMINAL_EXEC_WARNING, gatewayTerminalLimits, projectTerminal, projectTerminalEvent } from '../src/policy.js';
import { reissueCredential, revokeCredential } from '../src/credentials.js';
import { fakeDaemon } from './support/fake-daemon.js';
import { startGateway, until } from './support/harness.js';

const T1 = `term_${'1'.repeat(32)}`;
const T2 = `term_${'2'.repeat(32)}`;
const LIMITS = Object.fromEntries(['maxPerPrincipal', 'maxPerDaemon', 'maxInputBytes', 'maxOutputFrameBytes', 'replayBytes', 'idleMs', 'maxLifetimeMs', 'reconnectMs'].map(key => [key, TERMINAL[key]]));
const info = (id = T1, extra = {}) => ({ terminalId: id, workspaceId: 'wks_a', title: 'zsh', cols: 80, rows: 24, state: 'running', attached: false, createdAt: '2026-10-23T00:00:00.000Z', lastActivityAt: '2026-10-23T00:00:00.000Z', expiresAt: '2026-10-23T08:00:00.000Z', ...extra });

async function world(t, { capabilities = ['terminal', 'workspace.registry'], config } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-term-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = path.join(directory, 'a');
  const b = path.join(directory, 'b');
  await mkdir(a); await mkdir(b);
  const ca = await realpath(a);
  const cb = await realpath(b);
  const workspaces = [{ id: 'wks_a', projectId: 'prj_a', directory: ca, canonical: ca, createdAt: 'old', labels: [] }, { id: 'wks_b', projectId: 'prj_b', directory: cb, canonical: cb, createdAt: 'old', labels: [] }];
  const daemon = fakeDaemon({ capabilities });
  daemon.state.handlers['daemon.hello'] = () => ({ protocolVersion: 1, daemonVersion: 'fake', capabilities, terminalLimits: { ...LIMITS, maxPerPrincipal: 2 } });
  daemon.state.handlers['workspace.get'] = params => { const workspace = workspaces.find(w => w.id === params.workspaceId); if (!workspace) throw { code: 1001, message: 'x' }; return { workspace, revision: 1 }; };
  daemon.state.handlers['terminal.create'] = () => ({ terminal: { ...info(), pid: 4242, shell: '/bin/zsh', cwd: ca } });
  daemon.state.handlers['terminal.list'] = () => ({ terminals: [info(), info(T2, { state: 'exited', exitCode: 0, signal: null, endReason: 'exited' })] });
  daemon.state.handlers['terminal.attach'] = (params, link) => {
    // The replay precedes the answer, as alpd sends it; plus an event of a terminal nobody here attached.
    link.send({ jsonrpc: '2.0', method: 'terminal.event', params: { terminalId: params.terminalId, type: 'output', seq: 1, data: 'PROMPT$ ', secret: 'x' } });
    link.send({ jsonrpc: '2.0', method: 'terminal.event', params: { terminalId: T2, type: 'output', seq: 1, data: 'NOT YOURS' } });
    return { terminal: info(params.terminalId, { attached: true }), nextSeq: 2, gap: { fromSeq: 1, toSeq: 1, bytes: 9 } };
  };
  daemon.state.handlers['terminal.input'] = params => ({ bytes: Buffer.byteLength(params.data) });
  daemon.state.handlers['terminal.resize'] = params => ({ cols: params.cols, rows: params.rows });
  daemon.state.handlers['terminal.close'] = () => ({ closed: true });
  daemon.state.handlers['terminal.revoke'] = () => ({ closed: 1 });
  const credentials = {
    exec: { workspaces: [a], permissions: ['terminal.exec'] },
    writer: { workspaces: [a], permissions: ['session.read', 'session.write', 'project.read', 'project.write', 'files.read', 'library.write', 'workspace.write', 'attachments.write', 'session.team.write'] },
    defaults: { workspaces: [a] },
  };
  const gw = await startGateway(t, { daemon, credentials, ...(config ? { config } : {}) });
  return { daemon, a, b, ca, cb, ...gw };
}

const terminalCalls = (daemon, mark) => daemon.calls().slice(mark).filter(call => call.method.startsWith('terminal.'));

test('the matrix: terminal.exec alone, never a default, implied by nothing; terminal.revoke never exposed', () => {
  assert.ok(PERMISSIONS.includes('terminal.exec'));
  assert.ok(!DEFAULT_PERMISSIONS.includes('terminal.exec'));
  assert.ok(FORWARDED_CAPABILITIES.includes('terminal'));
  for (const method of ['terminal.create', 'terminal.list', 'terminal.attach', 'terminal.input', 'terminal.resize', 'terminal.close']) {
    assert.equal(EXPOSURE[method].status, 'exposed', method);
    assert.equal(EXPOSURE[method].permission, 'terminal.exec', method);
    assert.equal(EXPOSURE[method].alsoRequires, undefined, method);
    for (const field of ['principalId', 'principalEpoch', 'authorizedRoots', 'shell', 'command', 'args', 'env', 'cwd', 'pid']) assert.ok(!EXPOSURE[method].params.includes(field), `${method} forwards ${field}`);
  }
  assert.equal(EXPOSURE['terminal.revoke'].status, 'prohibited');
  assert.match(TERMINAL_EXEC_WARNING, /NOT a sandbox/);
  // Limits: never above TERMINAL; an output frame fits the client's frame.
  assert.deepEqual(gatewayTerminalLimits({ ...LIMITS, maxPerPrincipal: 99, idleMs: 1000 }), { ...LIMITS, idleMs: 1000 });
  assert.equal(gatewayTerminalLimits(LIMITS, 64 * 1024).maxOutputFrameBytes, Math.floor((64 * 1024 - 1024) / 6));
  // Projections keep the schema's fields only.
  assert.deepEqual(projectTerminal({ ...info(), pid: 1, cwd: '/x' }), info());
  assert.equal(projectTerminal({ ...info(), terminalId: '../x' }), undefined);
  assert.equal(projectTerminal({ ...info(), title: 'a/b' }), undefined);
  assert.equal(projectTerminalEvent({ terminalId: T1, type: 'output', seq: 1, data: 'x'.repeat(10) }, 5), undefined, 'over the frame');
  assert.equal(projectTerminalEvent({ terminalId: T1, type: 'input', seq: 1, data: 'x' }, 5), undefined);
  assert.deepEqual(projectTerminalEvent({ terminalId: T1, type: 'exit', seq: 2, exitCode: null, signal: 1, reason: 'revoked', extra: 1 }, 5), { terminalId: T1, type: 'exit', seq: 2, exitCode: null, signal: 1, reason: 'revoked' });
});

test('without terminal.exec nothing reaches alpd; with it, the grant\'s workspace and the gateway\'s own principal context', async t => {
  const env = await world(t);
  const { daemon, sdk, ids, ca } = env;
  for (const label of ['writer', 'defaults']) {
    const { client, hello } = await sdk(label);
    assert.ok(hello.capabilities.includes('terminal'), 'the capability says what alpd can do, not what this token may');
    const mark = daemon.calls().length;
    for (const [method, params] of [['terminal.create', { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 'r' }], ['terminal.list', {}], ['terminal.attach', { terminalId: T1 }], ['terminal.input', { terminalId: T1, data: 'id\r' }], ['terminal.resize', { terminalId: T1, cols: 80, rows: 24 }], ['terminal.close', { terminalId: T1 }]]) {
      await assert.rejects(client.request(method, params), error => error.code === 1003 && error.data?.reason === 'grant' && error.data.permission === 'terminal.exec', `${label} ${method}`);
    }
    assert.deepEqual(terminalCalls(daemon, mark), [], `${label}: no terminal call reached alpd`);
  }
  const { client, hello } = await sdk('exec');
  assert.equal(hello.terminalLimits.maxPerPrincipal, 2, 'alpd\'s lower limit passed on');
  // Outside the grant: refused before alpd. Client-sent principal fields and process fields are refused by the schema.
  const mark = daemon.calls().length;
  await assert.rejects(client.request('terminal.create', { workspaceId: 'wks_b', cols: 80, rows: 24, requestId: 'r' }), error => error.code === 1003 && error.data?.reason === 'outside_workspace');
  await assert.rejects(client.request('terminal.create', { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 'r', shell: '/bin/bash' }), error => error.code === -32602);
  assert.deepEqual(terminalCalls(daemon, mark), []);
  const created = await client.request('terminal.create', { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 'r' });
  assert.deepEqual(created, { terminal: info() }, 'pid, shell and cwd dropped');
  const [call] = terminalCalls(daemon, mark);
  assert.deepEqual(call.params, { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 'r', principalId: ids.exec, principalEpoch: call.params.principalEpoch, authorizedRoots: [ca] });
  assert.ok(typeof call.params.principalEpoch === 'string' && call.params.principalEpoch.length > 0);
  // Principal fields a client sends are dropped: the gateway's own go to alpd.
  const spoof = daemon.calls().length;
  await client.request('terminal.create', { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 's', principalId: 'someone-else', principalEpoch: 'x', authorizedRoots: ['/'] });
  const [spoofed] = terminalCalls(daemon, spoof);
  assert.deepEqual([spoofed.params.principalId, spoofed.params.principalEpoch, spoofed.params.authorizedRoots], [ids.exec, call.params.principalEpoch, [ca]]);
  // Input over the limit never reaches alpd.
  await assert.rejects(client.request('terminal.input', { terminalId: T1, data: 'x'.repeat(TERMINAL.maxInputBytes / 2 + 1) + 'é'.repeat(TERMINAL.maxInputBytes / 4) }), error => error.code === -32602 && error.data?.reason === 'input_too_large');
  const listed = await client.request('terminal.list', {});
  assert.equal(listed.terminals.length, 2);
});

test('events: only of terminals this connection attached, replay before the answer, projected; refusals rewritten', async t => {
  const env = await world(t);
  const { daemon, sdk } = env;
  const { client } = await sdk('exec');
  const events = [];
  client.onNotification((method, params) => { if (method === 'terminal.event') events.push(params); });
  // An event before any attach is dropped.
  const link = [...daemon.state.links].at(-1);
  link.send({ jsonrpc: '2.0', method: 'terminal.event', params: { terminalId: T1, type: 'output', seq: 9, data: 'early' } });
  const attached = await client.request('terminal.attach', { terminalId: T1, after: 0 });
  assert.deepEqual(events, [{ terminalId: T1, type: 'output', seq: 1, data: 'PROMPT$ ' }], 'the replay arrived before the answer; T2 and the early event dropped; extra fields gone');
  assert.deepEqual(attached.gap, { fromSeq: 1, toSeq: 1 });
  link.send({ jsonrpc: '2.0', method: 'terminal.event', params: { terminalId: T1, type: 'exit', seq: 2, exitCode: 0, signal: null, reason: 'exited' } });
  await until(() => events.length === 2, 'the exit');
  // alpd's refusals keep their code and reason, with the gateway's own text.
  daemon.state.handlers['terminal.input'] = () => { throw { code: 1004, message: 'host detail /Users/someone', data: { reason: 'terminal_exited', path: '/Users/someone' } }; };
  await assert.rejects(client.request('terminal.input', { terminalId: T1, data: 'x' }), error => error.code === 1004 && error.data?.reason === 'terminal_exited' && error.message === 'The terminal has ended' && error.data.path === undefined);
  daemon.state.handlers['terminal.create'] = () => { throw { code: 1005, message: 'x', data: { reason: 'terminal_limit', limit: 'principal' } }; };
  await assert.rejects(client.request('terminal.create', { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 'q' }), error => error.code === 1005 && error.data?.reason === 'terminal_limit' && error.data.limit === 'principal');
  daemon.state.handlers['terminal.create'] = () => { throw { code: 1005, message: 'x', data: { reason: 'terminal_disabled' } }; };
  await assert.rejects(client.request('terminal.create', { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 'q' }), error => /alp terminal allow/.test(error.message));
  // An answer the gateway does not know is refused.
  daemon.state.handlers['terminal.create'] = () => ({ terminal: { ...info(), terminalId: '/etc/passwd' } });
  await assert.rejects(client.request('terminal.create', { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 'q' }), error => error.code === 1000);
});

test('a revoked, rotated or regranted credential\'s terminals end through terminal.revoke', async t => {
  const env = await world(t);
  const { daemon, sdk, home, ids, a } = env;
  const revokes = () => daemon.state.calls.filter(call => call.method === 'terminal.revoke');
  const first = await sdk('exec');
  await reissueCredential(home, ids.exec, { workspaces: [a], permissions: ['session.read'] });
  await until(() => revokes().length === 1, 'revoke after a regrant');
  assert.deepEqual(revokes()[0].params, { principalId: ids.exec });
  await until(() => first.client.state === 'closed' || first.client.closed !== false, 'the connection closed');
  await revokeCredential(home, ids.exec);
  await until(() => revokes().length === 2, 'revoke after a revocation');
});

test('the credential CLI says what terminal.exec grants where it is granted', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-term-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workspace = path.join(directory, 'w');
  await mkdir(workspace);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = (...args) => promisify(execFile)(process.execPath, [path.join(import.meta.dirname, '../src/cli.js'), ...args], { env: { ...process.env, ALP_GATEWAY_HOME: path.join(directory, 'gateway'), ALP_HOME: directory, ALP_AGENT_SESSION: '' } });
  const help = await run('--help');
  assert.match(help.stdout, /terminal\.exec/);
  assert.match(help.stdout, /NOT a sandbox/);
  const created = await run('credential', 'create', '--label', 'shell', '--workspace', workspace, '--permission', 'terminal.exec', '--json');
  assert.deepEqual(JSON.parse(created.stdout).credential.permissions, ['terminal.exec'], 'implies nothing');
  assert.match(created.stderr, /NOT a sandbox/);
  const plain = await run('credential', 'create', '--label', 'plain', '--workspace', workspace, '--json');
  assert.ok(!JSON.parse(plain.stdout).credential.permissions.includes('terminal.exec'), 'never a default');
  assert.equal(plain.stderr, '');
});

test('a gateway frame too small for alpd\'s output events forwards no terminals (fail closed)', async t => {
  const env = await world(t, { config: { limits: { maxFrame: 256 * 1024 } } });
  const { client, hello } = await env.sdk('exec');
  assert.ok(!hello.capabilities.includes('terminal'));
  assert.equal(hello.terminalLimits, undefined);
  // A client that ignores the hello is refused before alpd too.
  const mark = env.daemon.calls().length;
  await assert.rejects(client.request('terminal.create', { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 'r' }), error => error.code === 1005 && error.data?.reason === 'terminal_unsupported');
  await assert.rejects(client.request('terminal.attach', { terminalId: T1 }), error => error.code === 1005);
  assert.deepEqual(terminalCalls(env.daemon, mark), []);
});


test('late host opt-in still refuses incompatible frames; repeated hello cannot reset limits or authority', async t => {
  const env = await world(t, { capabilities: ['workspace.registry'], config: { limits: { maxFrame: 256 * 1024 } } });
  const { client } = await env.sdk('exec');
  const again = await client.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(!again.capabilities.includes('terminal'));
  const mark = env.daemon.calls().length;
  await assert.rejects(client.request('terminal.create', { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 'late' }), error => error.code === 1005 && error.data?.reason === 'terminal_unsupported');
  assert.deepEqual(terminalCalls(env.daemon, mark), []);
  const next = await env.sdk('exec');
  await assert.rejects(next.client.request('terminal.attach', { terminalId: T1 }), error => error.data?.reason === 'terminal_unsupported');
});


test('oversized output from an attached terminal closes with an explicit negotiated-limit reason', async t => {
  const env = await world(t);
  const { client } = await env.sdk('exec');
  await client.request('terminal.attach', { terminalId: T1 });
  let closed;
  client.onClose(error => { closed = error; });
  const link = [...env.daemon.state.links].at(-1);
  link.send({ jsonrpc: '2.0', method: 'terminal.event', params: { terminalId: T1, type: 'output', seq: 2, data: 'x'.repeat(LIMITS.maxOutputFrameBytes + 1) } });
  await until(() => closed !== undefined, 'explicit socket refusal');
  assert.match(closed.data?.reason, /negotiated frame limit/);
});

test('directory cursors and captures retain terminal.exec binding and explicit frame refusals', async t => {
  const env = await world(t, { capabilities: ['terminal', 'terminal.watch', 'terminal.capture', 'workspace.registry'], config: { limits: { maxFrame: 512 * 1024 } } });
  const wid = 'a'.repeat(32), cursor = 'b'.repeat(32);
  env.daemon.state.handlers['terminal.watch'] = (params, link) => {
    link.send({ jsonrpc: '2.0', method: 'terminal.changed', params: { watchId: wid, cursor, private: 'host secret' } });
    return { terminals: [info()], watchId: wid, cursor, reset: true, private: 'x' };
  };
  env.daemon.state.handlers['terminal.unwatch'] = () => ({ closed: true });
  env.daemon.state.handlers['terminal.capture'] = () => ({ lines: ['screen'], totalLines: 1, private: 'host path' });
  const denied = await env.sdk('writer');
  for (const method of ['terminal.watch', 'terminal.capture', 'terminal.unwatch']) await assert.rejects(denied.client.request(method, method === 'terminal.capture' ? { terminalId: T1 } : {}), error => error.code === 1003);
  const { client } = await env.sdk('exec');
  const events = [];
  client.onNotification((method, params) => { if (method === 'terminal.changed') events.push(params); });
  const result = await client.request('terminal.watch', { workspaceId: 'wks_a' });
  assert.deepEqual(events, [{ watchId: wid, cursor }], 'notification before response is projected and preserved');
  assert.deepEqual(result, { terminals: [info()], watchId: wid, cursor, reset: true });
  const call = env.daemon.calls().find(call => call.method === 'terminal.watch');
  assert.equal(call.params.principalId, env.ids.exec);
  assert.deepEqual(call.params.authorizedRoots, [env.ca]);
  await assert.rejects(client.request('terminal.watch', { workspaceId: 'wks_b' }), error => error.data?.reason === 'outside_workspace');
  assert.deepEqual(await client.request('terminal.capture', { terminalId: T1 }), { lines: ['screen'], totalLines: 1 });
  env.daemon.state.handlers['terminal.capture'] = () => ({ lines: ['x'.repeat(600 * 1024)], totalLines: 1 });
  await assert.rejects(client.request('terminal.capture', { terminalId: T1 }), error => error.data?.reason === 'terminal_capture_too_large');
  env.daemon.state.handlers['terminal.watch'] = () => ({ terminals: Array.from({ length: 3000 }, () => info()), watchId: wid, cursor, reset: true });
  await assert.rejects(client.request('terminal.watch', {}), error => error.data?.reason === 'terminal_snapshot_too_large');
  await client.request('terminal.unwatch', {});
  const count = events.length;
  const link = [...env.daemon.state.links].at(-1);
  link.send({ jsonrpc: '2.0', method: 'terminal.changed', params: { watchId: wid, cursor: 'c'.repeat(32) } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(events.length, count, 'unwatched connection receives no invalidation');
});

test('reduced protection passes through the gateway without acknowledgment and keeps the principal binding', async t => {
  const { daemon, sdk, ids, ca } = await world(t);
  const { client } = await sdk('exec');
  daemon.state.handlers['terminal.create'] = params => {
    assert.equal(params.principalId, ids.exec); assert.deepEqual(params.authorizedRoots, [ca]);
    return { terminal: info(T1, { protection: params.requestId === 'win' ? 'none' : 'root-only' }) };
  };
  const params = { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 'open' };
  assert.equal((await client.request('terminal.create', params)).terminal.protection, 'root-only', 'opens directly and discloses the limit');
  assert.equal((await client.request('terminal.create', { ...params, requestId: 'win' })).terminal.protection, 'none');
  assert.equal((await client.request('terminal.create', { ...params, protectionAcknowledgment: 'linux-root-only-v1' })).terminal.protection, 'root-only', 'the deprecated acknowledgment is still accepted');
  await assert.rejects(client.request('terminal.create', { ...params, protectionAcknowledgment: true }), error => error.code === -32602);
  daemon.state.handlers['terminal.create'] = () => ({ terminal: info(T1, { protection: 'bogus' }) });
  await assert.rejects(client.request('terminal.create', { ...params, requestId: 'bogus' }));
  const { client: forbidden } = await sdk('writer');
  await assert.rejects(forbidden.request('terminal.create', params), error => error.code === 1003 && error.data.reason === 'grant');
});

test('an older alpd that still requires the root-only acknowledgment gets a specific, actionable refusal', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('exec');
  // Exactly what alpd built from main between 131e545 and 96bc24f (never in a release tag) answered a
  // terminal.create without protectionAcknowledgment on a Linux root-only host; this web never sends one.
  daemon.state.handlers['terminal.create'] = () => { throw { code: 1005, message: 'This Linux host lacks terminal process protection. /private/host-secret', data: { reason: 'terminal_protection_ack_required', secret: 'must-not-leak' } }; };
  await assert.rejects(client.request('terminal.create', { workspaceId: 'wks_a', cols: 80, rows: 24, requestId: 'old' }), error => {
    assert.equal(error.code, 1005);
    assert.deepEqual(error.data, { reason: 'terminal_protection_ack_required' });
    assert.match(error.message, /older alpd/);
    assert.match(error.message, /alp update/);
    assert.doesNotMatch(JSON.stringify(error), /host-secret|must-not-leak/);
    return true;
  });
});
