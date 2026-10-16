import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { initProject } from '../../packages/core/src/init.js';
import { getEntry, listEntries, saveEntry } from '../../packages/core/src/library-edit.js';
import { testEntry } from '../../packages/client/src/library-test.js';
import { diagnose } from '../../packages/client/src/doctor.js';
import { probeAntigravity } from '../../packages/client/src/antigravity-probe.js';
import { validateProvider } from '../../packages/core/src/providers.js';
import { createAlpRuntime, resolveSession, AntigravityTransport } from '../../dist/runtime/index.js';

const FAKE_AGY = fileURLToPath(new URL('../support/fake-agy.js', import.meta.url));

async function until(check, what = 'Expected condition') {
  for (let i = 0; i < 1000; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`${what} did not arrive`);
}

async function setup(t, { env = {}, settings = {}, provider = {}, supervisor = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-'));
  const root = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const logFile = path.join(dir, 'agy.jsonl');
  await initProject(root);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({
    defaultAgent: 'main',
    workflow: { mode: 'pho', supervisor: false },
    ...settings,
  }));
  await saveEntry('providers', 'antigravity', {
    provider: {
      kind: 'antigravity',
      label: 'Antigravity',
      command: process.execPath,
      args: [FAKE_AGY],
      env: { FAKE_AGY_LOG: logFile, ALP_AGY_MCP_CONFIG: path.join(dir, 'mcp_config.json'), ...env },
      ...provider,
    },
  }, { scope: 'library', library: home });

  const runtime = createAlpRuntime({
    environment: { ...process.env, ALP_AGY_MCP_CONFIG: path.join(dir, 'mcp_config.json') },
    language: 'English',
    supervisor,
    libraryDir: home,
    runLogDir: path.join(dir, 'runs'),
  });

  const events = [];
  runtime.onEvent(envelope => events.push(envelope));
  t.after(async () => {
    await runtime.shutdown();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  let prompts = 0;
  const turn = async (text, sessionId = 'root') => {
    const id = `m${++prompts}`;
    const start = events.length;
    await runtime.prompt(sessionId, { clientMessageId: id, delivery: 'auto', content: [{ type: 'text', text }] });
    const ended = entry => entry.sessionId === sessionId && (entry.event.type === 'turn.ended' || (entry.event.type === 'prompt.failed' && entry.event.clientMessageId === id));
    await until(() => events.slice(start).some(ended), `the turn of ${text}`);
    const mine = events.slice(start).filter(entry => entry.sessionId === sessionId);
    const said = mine.filter(entry => entry.event.type === 'item' && entry.event.item.kind === 'assistant_message').map(entry => entry.event.item.text);
    return { end: events.slice(start).find(ended).event, text: said.at(-1), events: mine.map(entry => entry.event) };
  };

  return { dir, root, home, runtime, events, turn };
}

test('antigravity provider validation and id checks', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-agy-val-'));
  t.after(() => rm(home, { recursive: true, force: true }));

  // Valid antigravity provider
  const valid = { kind: 'antigravity', command: 'agy', label: 'Antigravity' };
  assert.equal(validateProvider(valid, 'test', 'antigravity').kind, 'antigravity');

  // Reserved id codex is rejected
  assert.throws(() => validateProvider(valid, 'test', 'codex'), /'codex' cannot name a provider/);

  // 'antigravity' id is accepted when kind is antigravity
  assert.doesNotThrow(() => validateProvider(valid, 'test', 'antigravity'));

  // 'antigravity' id is rejected when kind is acp
  assert.throws(() => validateProvider({ kind: 'acp', command: 'acp-agent' }, 'test', 'antigravity'), /'antigravity' cannot name a provider/);

  // Invalid kind is rejected
  assert.throws(() => validateProvider({ kind: 'other', command: 'agy' }, 'test', 'agy'), /kind must be "acp" or "antigravity"/);
});

test('antigravity probing via probeAntigravity', async () => {
  const result = await probeAntigravity({
    command: process.execPath,
    args: [FAKE_AGY],
    env: { PATH: process.env.PATH },
  });
  assert.equal(result.agent.name, 'antigravity');
  assert.ok(result.version.includes('1.3.4'));
  assert.ok(result.models.length >= 3);
  assert.equal(result.currentMode, 'full-access');
});

test('antigravity fallback models when models command fails', async () => {
  const result = await probeAntigravity({
    command: process.execPath,
    args: [FAKE_AGY],
    env: { FAKE_AGY_MODELS_FAIL: '1' },
  });
  assert.ok(result.models.some(m => m.id === 'gemini-3.8-flash-high'));
});

test('resolveSession resolves antigravity models without elevating permissions', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-agy-res-'));
  const root = await mkdtemp(path.join(tmpdir(), 'alp-agy-root-'));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  await initProject(root);

  // 1. antigravity:gemini-3.8-flash-high
  await assert.rejects(resolveSession({ cwd: root, model: 'antigravity:gemini-3.8-flash-high', mode: 'read-only' }, { library: home }), /Antigravity.*full-access/);
  const res1 = await resolveSession({ cwd: root, model: 'antigravity:gemini-3.8-flash-high', mode: 'full-access' }, { library: home });
  assert.equal(res1.runtimeKind, 'antigravity');
  assert.equal(res1.model, 'gemini-3.8-flash-high');
  assert.equal(res1.mode, 'full-access');
  assert.equal(res1.thinking, 'none');

  // 2. antigravity/gemini-2.5-pro
  const res2 = await resolveSession({ cwd: root, model: 'antigravity/gemini-2.5-pro' }, { library: home });
  assert.equal(res2.runtimeKind, 'antigravity');
  assert.equal(res2.model, 'gemini-2.5-pro');

  // 3. Provider registered in library
  await saveEntry('providers', 'antigravity', {
    provider: { kind: 'antigravity', command: 'agy' },
  }, { scope: 'library', library: home });

  const res3 = await resolveSession({ cwd: root, model: 'acp:antigravity/gemini-3.8-flash-high' }, { library: home });
  assert.equal(res3.runtimeKind, 'antigravity');
  assert.equal(res3.model, 'gemini-3.8-flash-high');
  assert.equal(res3.antigravity?.kind, 'antigravity');
});

test('antigravity doctor check reports ok', async () => {
  const checks = await diagnose({
    home: tmpdir(),
    env: {
      ...process.env,
      ALP_ANTIGRAVITY_BIN: FAKE_AGY,
    },
  });
  const agyCheck = checks.find(entry => entry.id === 'antigravity');
  assert.ok(agyCheck);
  assert.equal(agyCheck.status, 'ok');
});

test('antigravity library entry test', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-agy-lib-'));
  const root = await mkdtemp(path.join(tmpdir(), 'alp-agy-proj-'));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  await initProject(root);

  await saveEntry('providers', 'antigravity', {
    provider: {
      kind: 'antigravity',
      command: process.execPath,
      args: [FAKE_AGY],
    },
  }, { scope: 'library', library: home });

  const result = await testEntry('providers', 'antigravity', { root, library: home });
  assert.equal(result.ok, true);
  assert.equal(result.agent?.name, 'antigravity');
  assert.equal(result.currentMode, 'full-access');
  assert.ok(result.models.length > 0);
});

test('antigravity session: turn streaming, tool bridge, and turn end', async t => {
  const { root, runtime, turn, events } = await setup(t);
  const opened = await runtime.open('root', { cwd: root, model: 'antigravity:gemini-3.8-flash-high' });
  assert.equal(opened.runtime, 'antigravity');
  assert.equal(opened.model, 'gemini-3.8-flash-high');

  const first = await turn('say hello antigravity');
  assert.equal(first.end.state, 'completed');
  assert.equal(first.text, 'hello antigravity');

  // Verify MCP tool bridge
  const tools = await turn('tools');
  assert.ok(tools.text.includes('alp_board') || tools.text.includes('alp_pin'));

  // Test turn failure
  const failed = await turn('fail');
  assert.equal(failed.end.state, 'failed');
});


test('antigravity rejects constrained permission profiles and review copies', async t => {
  const { root, home } = await setup(t, { settings: { permissions: {
    profiles: { safe: { base: 'full-access', deny: ['Bash'] } }, agents: { main: 'safe' },
  } } });
  await assert.rejects(resolveSession({ cwd: root, model: 'antigravity:gemini-3.8-flash-high' }, { library: home }), /Antigravity.*permission/);
});

test('antigravity keeps separate assistant messages within a turn', async t => {
  const transport = new AntigravityTransport();
  t.after(() => transport.close());
  const completed = [];
  transport.onNotification((method, params) => { if (method === 'item/completed') completed.push(params.item.text); });
  transport.activeTurn = 'test-turn';
  for (const [step_index, text_delta] of [[1, 'First'], [3, 'Second']]) {
    transport.receiveLine(JSON.stringify({event: 'step_update', step_update: {step_type: 'agent_response', step_index, text_delta, state: 'DONE'}}));
  }
  assert.deepEqual(completed, ['First', 'Second']);
});


/**
 * Removes `dir` after the test's other cleanups, which stop the child processes using it: hooks run in the
 * order registered, and Windows cannot remove a directory a process still holds (nor at once after it ends).
 */
const removeLast = (t, dir) => t.after(() => { t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })); });

async function transportFixture(t, directory, tools, mcpServers = {}) {
  const configFile = path.join(directory, 'mcp_config.json');
  const transport = new AntigravityTransport(process.execPath, directory,
    { ...process.env, ALP_AGY_MCP_CONFIG: configFile }, { id: 'antigravity', label: 'fake', command: process.execPath, args: [FAKE_AGY] });
  t.after(() => transport.close());
  const events = [];
  transport.onNotification((method, params) => events.push({ method, params }));
  await transport.request('thread/start', { cwd: directory, sandbox: 'full-access', mcpServers, dynamicTools: tools.map(name => ({ name, description: name })) });
  const turn = async text => {
    const start = events.length;
    await transport.request('turn/start', { input: [{ text }] });
    await until(() => events.slice(start).some(e => e.method === 'turn/completed'));
    return events.slice(start).filter(e => e.method === 'item/completed').map(e => e.params.item.text).join('');
  };
  return { transport, turn, configFile, events };
}

test('MCP routes concurrent sessions separately without persisting session credentials', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-isolation-'));
  removeLast(t, dir);
  const existing = { mcpServers: { unrelated: { command: 'unchanged' } }, custom: true };
  await writeFile(path.join(dir, 'mcp_config.json'), JSON.stringify(existing));
  const a = await transportFixture(t, dir, ['only_a']);
  const b = await transportFixture(t, dir, ['only_b']);
  const [one, two] = await Promise.all([a.turn('tools'), b.turn('tools')]);
  assert.equal(one, 'tools: only_a');
  assert.equal(two, 'tools: only_b');
  const config = JSON.parse(await readFile(a.configFile, 'utf8'));
  assert.deepEqual(config.mcpServers.unrelated, existing.mcpServers.unrelated);
  assert.equal(config.custom, true);
  assert.equal(JSON.stringify(config).includes(a.transport.bridge.token), false);
  assert.equal(JSON.stringify(config).includes(a.transport.bridge.socket), false);
  await a.transport.close();
  assert.equal(await b.turn('tools'), 'tools: only_b');
});

test('Antigravity bridges session MCP tools without persisting external server credentials', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-external-mcp-'));
  removeLast(t, dir);
  const server = label => ({ command: process.execPath, args: [path.resolve('test/support/fake-mcp.js')], env: { FAKE_MCP_LABEL: label } });
  const a = await transportFixture(t, dir, ['alp_test'], { docs: server('session-a') });
  const b = await transportFixture(t, dir, [], { docs: server('session-b') });
  const one = await a.turn('tools');
  assert.match(one, /alp_test/);
  const search = one.slice('tools: '.length).split(',').find(name => name.includes('search'));
  assert.ok(search);
  assert.match(one, /fetch/, 'all pages of external tools are bridged');
  assert.match(await a.turn(`call_tool ${search} {"query":"hello"}`), /session-a/);
  assert.match(await b.turn(`call_tool ${search} {"query":"hello"}`), /session-b/);
  const config = await readFile(a.configFile, 'utf8');
  assert.equal(config.includes('session-a'), false);
  assert.equal(config.includes('session-b'), false);
  assert.equal(config.includes('fake-mcp.js'), false);
  await a.transport.close();
  assert.match(await b.turn(`call_tool ${search} {}`), /session-b/);
});

test('Antigravity forwards HTTP MCP authentication and preserves rich tool results', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-http-mcp-'));
  removeLast(t, dir);
  const server = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(405).end(); return; }
    assert.equal(req.headers.authorization, 'Bearer session-private-token');
    let body = '';
    for await (const chunk of req) body += chunk;
    const message = JSON.parse(body);
    if (message.id === undefined) { res.writeHead(202).end(); return; }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'http-test', version: '1' } };
    if (message.method === 'tools/list') result = { tools: [{ name: 'search', inputSchema: { type: 'object' } }] };
    if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'http-session-result' }], structuredContent: { source: 'http-session' }, isError: true };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const port = server.address().port;
  const { turn, configFile } = await transportFixture(t, dir, [], { docs: { url: `http://127.0.0.1:${port}/mcp`, http_headers: { Authorization: 'Bearer session-private-token' } } });
  const search = (await turn('tools')).slice('tools: '.length).split(',').find(name => name.includes('search'));
  const result = await turn(`call_tool ${search} {}`);
  assert.match(result, /http-session-result/);
  assert.match(result, /structuredContent/);
  assert.match(result, /isError.*true/);
  assert.equal((await readFile(configFile, 'utf8')).includes('session-private-token'), false);
});

test('failed external MCP startup closes servers already opened and names do not collide', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-mcp-failure-'));
  removeLast(t, dir);
  const pidFile = path.join(dir, 'mcp.pid');
  const server = { command: process.execPath, args: [path.resolve('test/support/fake-mcp.js')], env: { FAKE_MCP_PID_FILE: pidFile } };
  await assert.rejects(transportFixture(t, dir, [], { docs: server, broken: { command: 'alp-test-missing-mcp-command' } }), /External MCP server 'broken'/);
  const pid = Number(await readFile(pidFile, 'utf8'));
  await until(() => { try { process.kill(pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } }, 'MCP process cleanup');
  const { turn } = await transportFixture(t, dir, [], { 'a-b': server, a_b: server });
  const aliases = (await turn('tools')).slice('tools: '.length).split(',');
  assert.equal(aliases.length, 4);
  assert.equal(new Set(aliases).size, 4);
});

test('closing while the MCP config is locked cannot launch a late AGY process', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-mcp-startup-close-'));
  removeLast(t, dir);
  const configFile = path.join(dir, 'mcp_config.json');
  const logFile = path.join(dir, 'agy.jsonl');
  const pidFile = path.join(dir, 'mcp.pid');
  await writeFile(`${configFile}.alp-lock`, '');
  const transport = new AntigravityTransport(process.execPath, dir, {
    ...process.env, ALP_AGY_MCP_CONFIG: configFile, FAKE_AGY_LOG: logFile,
  }, { id: 'antigravity', label: 'fake', command: process.execPath, args: [FAKE_AGY] });
  t.after(() => transport.close());
  const opening = transport.request('thread/start', { cwd: dir, sandbox: 'full-access', mcpServers: {
    docs: { command: process.execPath, args: [path.resolve('test/support/fake-mcp.js')], env: { FAKE_MCP_PID_FILE: pidFile } },
  } }).then(() => null, error => error);
  await until(() => transport.bridge, 'bridge waiting for the config lock');
  await transport.close();
  await rm(`${configFile}.alp-lock`);
  assert.match((await opening).message, /Runtime is closed/);
  await assert.rejects(readFile(logFile), { code: 'ENOENT' });
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('closing during a stalled external MCP handshake aborts and cleans its process promptly', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-mcp-abort-'));
  removeLast(t, dir);
  const pidFile = path.join(dir, 'mcp.pid');
  const transport = new AntigravityTransport(process.execPath, dir, process.env, { id: 'antigravity', label: 'fake', command: process.execPath, args: [FAKE_AGY] });
  t.after(() => transport.close());
  const opening = transport.request('thread/start', { cwd: dir, sandbox: 'full-access', mcpServers: {
    docs: { command: process.execPath, args: [path.resolve('test/support/fake-mcp.js')], env: { FAKE_MCP_PID_FILE: pidFile, FAKE_MCP_HANG_INITIALIZE: '1' } },
  } }).then(() => null, error => error);
  await until(async () => readFile(pidFile).then(() => true, () => false), 'external MCP startup');
  await transport.close();
  assert.match((await opening).message, /External MCP server 'docs'/);
  const pid = Number(await readFile(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
});

test('invalid MCP configuration is preserved and prevents launch', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-invalid-'));
  removeLast(t, dir);
  const file = path.join(dir, 'mcp_config.json');
  await writeFile(file, '{invalid');
  await assert.rejects(transportFixture(t, dir, ['test']), /JSON|property|Invalid/);
  assert.equal(await readFile(file, 'utf8'), '{invalid');
});

test('interrupt ends one turn and the next prompt resumes the conversation', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-agy-interrupt-'));
  removeLast(t, dir);
  const { transport, turn, events } = await transportFixture(t, dir, []);
  const threadId = transport.conversationId;
  await transport.request('turn/start', { input: [{ text: 'hang' }] });
  await transport.request('turn/interrupt', {});
  await until(() => events.some(e => e.method === 'turn/completed' && e.params.turn.status === 'interrupted'));
  assert.equal(await turn('say after interrupt'), 'after interrupt');
  assert.equal(transport.conversationId, threadId);
});

test('Antigravity rejects permission downgrades after opening', async t => {
  const { root, runtime } = await setup(t);
  await runtime.open('root', { cwd: root, model: 'antigravity:gemini-3.8-flash-high' });
  await assert.rejects(runtime.configure('root', { mode: 'read-only' }), /Antigravity.*full-access/);
});

test('Antigravity definitions use the native provider ID', () => {
  assert.throws(() => validateProvider({ kind: 'antigravity', command: 'agy' }, 'test', 'agy-local'), /antigravity/);
});

test('Antigravity can be selected in the main agent profile', async t => {
  const { root, home } = await setup(t, { settings: { profile: { pho: { main: { profiles: ['antigravity:gemini-3.8-flash-high'] } } } } });
  const session = await resolveSession({ cwd: root }, { library: home });
  assert.equal(session.runtimeKind, 'antigravity');
  assert.equal(session.model, 'gemini-3.8-flash-high');
});

test('Antigravity instruction read-only is opt-in and opens all advisory roles without claiming a sandbox', async t => {
  const { root, home, runtime, turn, dir } = await setup(t, {
    provider: { readOnlyMode: 'instructions' },
    settings: { profile: { pho: Object.fromEntries(['main', 'peer', 'oracle', 'reviewer', 'supervisor'].map(name => [name, {
      profiles: ['antigravity:gemini-3.8-flash-high'],
    }])) } },
  });
  for (const agent of ['oracle', 'reviewer', 'supervisor']) {
    const resolved = await resolveSession({ cwd: root, agent, model: 'antigravity:gemini-3.8-flash-high' }, { library: home });
    assert.equal(resolved.runtimeKind, 'antigravity');
    assert.equal(resolved.mode, 'read-only');
  }
  await runtime.open('review', { cwd: root, agent: 'reviewer' });
  assert.equal((await turn('say reviewed', 'review')).text, 'reviewed');
  const prompts = await readFile(path.join(dir, 'agy.jsonl'), 'utf8');
  assert.match(prompts, /Read-only is emulated by instructions/);
  assert.match(prompts, /Do not edit, create, delete or rename files/);
  assert.match(prompts, /not enforced by an OS sandbox/);
  await assert.rejects(resolveSession({ cwd: root, model: 'antigravity:gemini-3.8-flash-high', mode: 'workspace-write' }, { library: home }), /Antigravity/);
  await assert.rejects(resolveSession({ cwd: root, agent: 'reviewer', copy: true }, { library: home }), /copy/);
});

test('a complete Antigravity Cafe team runs its supervisor and delegates to lead, peer, reviewer and oracle', async t => {
  const model = 'antigravity:gemini-3.8-flash-high';
  const { root, runtime, turn, dir } = await setup(t, {
    supervisor: true,
    provider: { readOnlyMode: 'instructions' },
    settings: {
      workflow: { mode: 'cafe', supervisor: true },
      profile: { cafe: Object.fromEntries(['main', 'lead', 'peer', 'oracle', 'reviewer', 'supervisor'].map(name => [name, { profiles: [model] }])) },
    },
  });
  await runtime.open('root', { cwd: root });
  await until(() => runtime.list().some(session => session.agent === 'supervisor'), 'Antigravity supervisor');
  for (const agent of ['lead', 'reviewer', 'oracle']) {
    const delegated = await turn(`call_tool alp_delegate ${JSON.stringify({ agent, model, wait: true, task: 'say delegated' })}`);
    assert.match(delegated.text, /delegated/);
    assert.doesNotMatch(delegated.text, /Use a runtime-prefixed model ID|isError.*true/);
  }
  const nested = await turn(`call_tool alp_delegate ${JSON.stringify({ agent: 'lead', model, wait: true, task: `call_tool alp_delegate ${JSON.stringify({ agent: 'peer', model, wait: true, task: 'say peer-done' })}` })}`);
  assert.match(nested.text, /peer-done/);
  const log = await readFile(path.join(dir, 'agy.jsonl'), 'utf8');
  assert.match(log, /ALP runtime identity: supervisor/);
  assert.match(log, /Read-only is emulated by instructions/);
});

test('instruction read-only never relaxes custom rules and is not allowed for ACP providers', async t => {
  assert.throws(() => validateProvider({ kind: 'acp', command: 'opencode', readOnlyMode: 'instructions' }, 'test', 'opencode'), /only for Antigravity/);
  assert.throws(() => validateProvider({ kind: 'antigravity', command: 'agy', readOnlyMode: true }, 'test', 'antigravity'), /readOnlyMode/);
  const { root, home } = await setup(t, {
    provider: { readOnlyMode: 'instructions' },
    settings: { permissions: { profiles: { restricted: { base: 'read-only', deny: ['Bash'] } }, agents: { main: 'restricted' } } },
  });
  await assert.rejects(resolveSession({ cwd: root, model: 'antigravity:gemini-3.8-flash-high' }, { library: home }), /custom permission rules/);
});

test('Antigravity instruction modes are fixed per session but no-op configuration succeeds', async t => {
  const { root, runtime } = await setup(t, { provider: { readOnlyMode: 'instructions' } });
  await runtime.open('root', { cwd: root, model: 'antigravity:gemini-3.8-flash-high', mode: 'read-only' });
  assert.equal((await runtime.configure('root', { mode: 'read-only' })).mode, 'read-only');
  await assert.rejects(runtime.configure('root', { mode: 'full-access' }), /new session/);
  const discovered = await probeAntigravity({ command: process.execPath, args: [FAKE_AGY], readOnlyMode: 'instructions' });
  assert.deepEqual(discovered.modes.map(mode => mode.id), ['full-access', 'read-only']);
  assert.match(discovered.modes[1].description, /new sessions.*no OS sandbox/);
});
