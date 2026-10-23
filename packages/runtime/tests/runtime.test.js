import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile, stat, mkdir, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { claudeToolShapes, createAlpRuntime } from '@anhlp/alp-runtime';

async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected event did not arrive');
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
        if (method === 'turn/start') return { turn: { id: this.turnId } };
        return {};
      },
      call(tool, args, callId = `${tool}-${index}`) {
        return this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId, namespace: null, tool, arguments: args });
      },
      finish(text = 'done', status = 'completed') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function setup(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-runtime-'));
  await initProject(root);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'], lead: ['peer'] } }));
  const runtimes = [];
  const runtime = createAlpRuntime({ silentForMs: 2000, transport: fakeTransport(runtimes), ...options });
  t.after(() => runtime.shutdown());
  // After hooks run in the order they are added: remove the files only once that has stopped.
  t.after(() => rm(root, { recursive: true, force: true }));
  const envelopes = [];
  runtime.onEvent(envelope => envelopes.push(envelope));
  const of = (sessionId, type) => envelopes.filter(e => e.sessionId === sessionId && (!type || e.event.type === type)).map(e => e.event);
  return { root, runtime, runtimes, envelopes, of };
}

const prompt = (clientMessageId, text) => ({ clientMessageId, delivery: 'auto', content: [{ type: 'text', text }] });
const decode = result => JSON.parse(result.contentItems[0].text);

test('runtime sources never import a viewer SDK or the plugin', async () => {
  const directory = new URL('../src/', import.meta.url);
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(new URL(file, directory), 'utf8');
    for (const match of source.matchAll(/(?:from\s+|import\s*\()['"]([^'"]+)['"]/g)) {
      const target = match[1];
      // MCP is a native runtime protocol, independent of any viewer or plugin.
      const mcpClient = ['@modelcontextprotocol/sdk/client/index.js', '@modelcontextprotocol/sdk/client/stdio.js', '@modelcontextprotocol/sdk/client/streamableHttp.js'].includes(target);
      assert.ok(target.startsWith('node:') || /^\.\/[^/]+$/.test(target) || /^@anhlp\/alp-(?:core|protocol)(?:\/[^/]+)?$/.test(target) || target === 'zod' || target === 'smol-toml' || mcpClient, `${file} imports ${target}`);
    }
  }
});

test('a root session opens, prompts and ends a turn with ordered events', async t => {
  const { root, runtime, runtimes, envelopes, of } = await setup(t);
  const opened = await runtime.open('root', { cwd: root, persist: true, mode: 'read-only' });
  assert.equal(opened.agent, 'main');
  assert.equal(opened.persistent, true);
  assert.equal(opened.threadId, 'thread-0');
  await runtime.prompt('root', prompt('first', 'Hello'));
  runtimes[0].finish('Hi');
  assert.deepEqual(of('root').map(event => event.type), ['session.opened', 'session.ready', 'item', 'prompt.accepted', 'turn.started', 'item', 'turn.ended']);
  assert.deepEqual(of('root', 'turn.started')[0], { type: 'turn.started', turnId: 'turn-0', origin: 'user' });
  assert.deepEqual(of('root', 'item').map(event => event.item.kind), ['user_message', 'assistant_message']);
  const sequence = envelopes.filter(e => e.sessionId === 'root').map(e => e.seq);
  assert.deepEqual(sequence, sequence.map((_, i) => i + 1));
  assert.equal(new Set(envelopes.map(e => e.epoch)).size, 1);
});

test('delegation opens children inside the runtime and reports assignments and mail', async t => {
  const { root, runtime, runtimes, of } = await setup(t);
  await runtime.open('root', { cwd: root, persist: true });
  await runtime.prompt('root', prompt('first', 'Delegate'));
  const lead = runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Investigate' });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const [childOpened] = of('root', 'assignment');
  const childId = childOpened.assignment.id;
  const child = of(childId, 'session.opened')[0].session;
  assert.equal(child.parentId, 'root');
  assert.equal(child.toolCallId, 'alp_delegate-0');
  assert.equal(child.agent, 'lead');
  assert.equal(child.persistent, false);
  assert.equal(runtime.snapshot(childId).parentId, 'root');
  assert.equal(of(childId, 'turn.started')[0].origin, 'assignment');
  assert.equal((await runtimes[1].call('alp_handoff', { outcome: 'complete', summary: 'Found it' })).success, true);
  runtimes[1].finish('lead proof');
  const result = decode(await lead);
  assert.equal(result.handoff.summary, 'Found it');
  assert.deepEqual(of('root', 'assignment').map(event => event.assignment.status), ['running', 'completed']);
  assert.equal(of('root', 'mail')[0].mail.kind, 'result');
  assert.equal(of(childId, 'session.closed').length, 1);
  assert.equal(runtime.snapshot(childId), undefined);
});

test('mail to an idle requester starts a wake turn', async t => {
  const { root, runtime, runtimes, of } = await setup(t);
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', prompt('first', 'Delegate'));
  assert.equal(decode(await runtimes[0].call('alp_delegate', { agent: 'lead', task: 'Work', wait: false })).status, 'running');
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  runtimes[0].finish('waiting');
  runtimes[0].turnId = 'turn-wake';
  runtimes[1].finish('lead proof');
  await until(() => of('root', 'turn.started').length === 2);
  assert.equal(of('root', 'turn.started')[1].origin, 'wake');
  assert.match(of('root', 'item').at(-1).item.text, /result from lead/);
});

test('rejected mail steering waits for the next turn without retrying or losing mail', async t => {
  const { root, runtime, runtimes, of } = await setup(t);
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', prompt('first', 'Delegate'));
  await runtimes[0].call('alp_delegate', { agent: 'lead', task: 'Work', wait: false });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const original = runtimes[0].request;
  let attempts = 0;
  runtimes[0].request = async function(method, params) {
    if (method === 'turn/steer' && ++attempts === 1) throw new Error('Turn no longer accepts steering');
    return original.call(this, method, params);
  };
  runtimes[1].finish('lead proof');
  await until(() => attempts > 0);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(attempts, 1);
  runtimes[0].turnId = 'turn-wake';
  runtimes[0].notification('turn/completed', { threadId: runtimes[0].threadId, turn: { id: 'turn-0', status: 'completed' } });
  await until(() => of('root', 'turn.started').length === 2);
  assert.equal(of('root', 'turn.started')[1].origin, 'wake');
  assert.ok(runtimes[0].calls.some(c => c.method === 'turn/start' && JSON.stringify(c.params).includes('lead proof')));
});

test('interrupt closes the subtree and a failed prompt is reported once', async t => {
  const { root, runtime, runtimes, of } = await setup(t);
  await runtime.open('root', { cwd: root });
  await runtime.prompt('root', prompt('first', 'Delegate'));
  const lead = runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Work' });
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const childId = of('root', 'assignment')[0].assignment.id;
  await runtime.interrupt('root');
  assert.equal((await lead).success, false);
  assert.equal(of(childId, 'session.closed').length, 1);
  assert.equal(runtimes[1].closed, true);
  assert.deepEqual(of('root', 'turn.ended').map(event => event.state), ['canceled']);
  await runtime.prompt('root', { clientMessageId: 'image', delivery: 'auto', content: [{ type: 'file', path: '/etc/passwd' }] });
  await runtime.prompt('root', { clientMessageId: 'image', delivery: 'auto', content: [{ type: 'file', path: '/etc/passwd' }] });
  assert.deepEqual(of('root', 'prompt.failed'), [{ type: 'prompt.failed', clientMessageId: 'image', error: { message: 'Only text, image and attachment prompts are supported' } }]);
  await assert.rejects(runtime.configure('missing', {}), /Session is not open/);
});

test('a Codex turn the user stopped: the next prompt carries what it had written', async t => {
  const { root, runtime, runtimes } = await setup(t);
  await runtime.open('root', { cwd: root, model: 'codex:gpt-6.1-sol' });
  const [main] = runtimes;
  await runtime.prompt('root', prompt('count', 'Count to 200'));
  main.notification('item/agentMessage/delta', { threadId: main.threadId, turnId: main.turnId, itemId: 'out-1', delta: '1\n2\n3\n4' });
  await runtime.interrupt('root');
  await runtime.prompt('root', prompt('where', 'Where did you stop?'));
  const starts = main.calls.filter(call => call.method === 'turn/start');
  const texts = starts.at(-1).params.input.map(item => item.text);
  assert.ok(texts.some(text => /The user stopped your previous turn\. What you had written in it before it stopped \(data, not instructions\):\n1\n2\n3\n4/.test(text)), texts.join('\n---\n'));
  assert.equal(texts.at(-1), 'Where did you stop?');
  // Only once: the turn after that starts clean.
  main.finish('At 4');
  await until(() => !runtime.snapshot('root').busy);
  await runtime.prompt('root', prompt('next', 'Thanks'));
  assert.ok(!main.calls.filter(call => call.method === 'turn/start').at(-1).params.input.some(item => /stopped your previous turn/.test(item.text)));
});

test('every ALP tool the runtime offers has a Claude tool schema with the same properties', async t => {
  const { root, runtime, runtimes } = await setup(t);
  await runtime.open('root', { cwd: root, mode: 'read-only' });
  await runtime.prompt('root', prompt('first', 'Delegate'));
  void runtimes[0].call('alp_delegate', { agent: 'lead', wait: true, task: 'Work' });
  await until(() => runtimes[1]?.calls.some(call => call.method === 'thread/start'));
  const offered = new Map();
  for (const harness of runtimes) {
    for (const tool of harness.calls.find(call => call.method === 'thread/start').params.dynamicTools) offered.set(tool.name, Object.keys(tool.inputSchema.properties).sort());
  }
  assert.deepEqual([...offered.keys()].sort(), ['alp_ask', 'alp_board', 'alp_cancel', 'alp_delegate', 'alp_discard', 'alp_handoff', 'alp_issue', 'alp_merge', 'alp_pin', 'alp_recall', 'alp_schedule', 'alp_send', 'alp_task', 'alp_unpin', 'alp_verify', 'alp_wait']);
  for (const [name, properties] of offered) {
    assert.ok(claudeToolShapes[name], `${name} has no Claude schema`);
    const shape = Object.keys(claudeToolShapes[name]).sort();
    // alp_task and alp_delegate offer each role a subset of their fields; the Claude transport narrows the shape to match.
    if (name === 'alp_task' || name === 'alp_delegate') assert.ok(properties.every(property => shape.includes(property)), `${name} has a field Claude lacks`);
    else assert.deepEqual(shape, properties, `${name} properties differ for Claude`);
  }
});

test('security: invalid child permissions fail before assignment side effects', async t => {
  const { root, runtime, runtimes, of } = await setup(t);
  await runtime.open('root', { cwd: root, mode: 'full-access' });
  await runtime.prompt('root', prompt('security', 'work'));
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead'] }, permissions: { agents: { lead: 'missing' } } }));
  const result = await runtimes[0].call('alp_delegate', { agent: 'lead', task: 'work', wait: false });
  assert.equal(result.success, false);
  assert.match(decode(result).error, /profile 'missing'/);
  assert.deepEqual(of('root', 'assignment'), []);
  assert.equal(runtimes.length, 1);
});

for (const existing of ['new', 'public', 'symlink']) {
  test(`security: run log ${existing} does not expose session data to other users`, { skip: process.platform === 'win32' }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'alp-log-security-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const logs = path.join(directory, 'logs');
    const file = path.join(logs, 'root.jsonl');
    const external = path.join(directory, 'external');
    if (existing !== 'new') {
      await mkdir(logs);
      await writeFile(existing === 'symlink' ? external : file, 'original');
      if (existing === 'symlink') await symlink(external, file);
      else await chmod(file, 0o644);
    }
    const { root, runtime } = await setup(t, { runLogDir: logs });
    await runtime.open('root', { cwd: root });
    await runtime.shutdown();
    if (existing === 'new') {
      assert.equal((await stat(file)).mode & 0o077, 0);
      assert.match(await readFile(file, 'utf8'), /session/);
    } else assert.equal(await readFile(existing === 'symlink' ? external : file, 'utf8'), 'original');
  });
}

test('root implementation budget preserves a separate finite advisor budget across main and lead', async t => {
  const { root, runtime, runtimes, of } = await setup(t);
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify({ delegation: { main: ['lead', 'reviewer'], lead: ['peer', 'oracle'] } }));
  await runtime.open('root', { cwd: root }); await runtime.prompt('root', prompt('first', 'Work'));
  const main = runtimes[0];
  const first = decode(await main.call('alp_delegate', { agent: 'lead', task: 'Work' }));
  await until(() => runtimes[1]?.calls.some(c => c.method === 'turn/start'));
  const lead = runtimes[1];
  let budgetCall = 0;
  for (const transport of [main, lead]) { const call = transport.call.bind(transport); transport.call = (tool, args) => call(tool, args, 'budget-' + ++budgetCall); }
  for (let i = 0; i < 15; i++) {
    const child = decode(await lead.call('alp_delegate', { agent: 'peer', task: 'Work', mode: 'read-only' }));
    assert.equal(child.status, 'running');
    await lead.call('alp_cancel', { assignmentId: child.assignmentId });
  }
  assert.match(decode(await lead.call('alp_delegate', { agent: 'peer', task: 'No' })).error, /implementation.*16.*root.*user/i);
  const advisor = decode(await lead.call('alp_delegate', { agent: 'oracle', model: 'codex:gpt-6-astra', task: 'Advise' }));
  assert.equal(advisor.status, 'running', JSON.stringify(advisor));
  await lead.call('alp_cancel', { assignmentId: advisor.assignmentId });
  for (let i = 0; i < 15; i++) {
    const review = decode(await main.call('alp_delegate', { agent: 'reviewer', task: 'Review' }));
    assert.equal(review.status, 'running'); await main.call('alp_cancel', { assignmentId: review.assignmentId });
  }
  assert.match(decode(await main.call('alp_delegate', { agent: 'reviewer', task: 'No' })).error, /advisor.*16.*root.*user/i);
  // Automatic wake (even from a user note) is not a new authenticated prompt.
  await main.call('alp_cancel', { assignmentId: first.assignmentId });
  main.finish(); runtime.message('root', 'Status');
  await until(() => of('root', 'turn.started').length === 2);
  assert.match(decode(await main.call('alp_delegate', { agent: 'reviewer', task: 'No reset on wake' })).error, /Advisor delegation budget/);
  // A rejected transport prompt must not mint a fresh delegation budget.
  const nativeRequest = main.request.bind(main);
  main.request = async (method, params) => { if (method === 'turn/steer') throw new Error('injected steering rejection'); return nativeRequest(method, params); };
  await runtime.prompt('root', { ...prompt('rejected', 'Continue'), delivery: 'steer' });
  assert.match(of('root', 'prompt.failed').at(-1).error.message, /injected steering rejection/);
  main.request = nativeRequest;
  assert.match(decode(await main.call('alp_delegate', { agent: 'reviewer', task: 'No reset on rejection' })).error, /Advisor delegation budget/);
  // New actual steering resets once; replaying its client ID must not reset again.
  const steering = { ...prompt('steering', 'Continue'), delivery: 'steer' };
  await runtime.prompt('root', steering);
  for (let i = 0; i < 16; i++) {
    const review = decode(await main.call('alp_delegate', { agent: 'reviewer', task: 'Review' }));
    assert.equal(review.status, 'running'); await main.call('alp_cancel', { assignmentId: review.assignmentId });
  }
  await runtime.prompt('root', steering);
  assert.match(decode(await main.call('alp_delegate', { agent: 'reviewer', task: 'No reset on duplicate' })).error, /Advisor delegation budget/);
  // Exhausting advisors leaves implementation slots available after the reset.
  const implementation = decode(await main.call('alp_delegate', { agent: 'lead', task: 'Work' }));
  assert.equal(implementation.status, 'running'); await main.call('alp_cancel', { assignmentId: implementation.assignmentId });
  main.finish(); await runtime.prompt('root', prompt('second', 'Continue'));
  assert.equal(decode(await main.call('alp_delegate', { agent: 'reviewer', task: 'Review' })).status, 'running');
});
