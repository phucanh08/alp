import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAlpRuntime } from '../dist/runtime.js';

test('workspace mutation reserves admission and releases after callback failure', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-mutation-'));
  const runtime = createAlpRuntime();
  await runtime.registerWorkspace(root);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  try {
    const mutation = runtime.withWorkspaceMutation(root, async () => { entered(); await gate; throw new Error('callback failure'); });
    await ready;
    await assert.rejects(runtime.withWorkspaceMutation(root, async () => assert.fail('nested callback')), error => error.data.reason === 'workspace_busy');
    // Public open queues behind the mutation; it must never enter the callback's interval.
    release();
    await assert.rejects(mutation, /callback failure/);
    assert.equal(await runtime.withWorkspaceMutation(root, async () => 42), 42);
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('persisted assignment results block only contained paths and malformed books fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-mutation-'));
  const target = path.join(root, 'checkout');
  const sibling = path.join(root, 'checkout-other');
  await mkdir(target); await mkdir(sibling);
  const recallFile = path.join(root, 'recall.json');
  const liveFile = path.join(root, 'live.json');
  await writeFile(liveFile, '[]');
  const runtime = createAlpRuntime({ recallFile, liveFile });
  await runtime.registerWorkspace(target); await runtime.registerWorkspace(sibling);
  try {
    assert.equal(await runtime.withWorkspaceMutation(sibling, async () => 'fresh'), 'fresh');
    await writeFile(recallFile, JSON.stringify([{ assignmentId: 'retained', cwd: path.join(target, 'deleted-subdir') }]));
    await assert.rejects(runtime.withWorkspaceMutation(target, async () => assert.fail('unsafe callback')), error => error.data.reason === 'workspace_assignment_result');
    assert.equal(await runtime.withWorkspaceMutation(sibling, async () => true), true);
    await writeFile(liveFile, JSON.stringify([{ assignmentId: 'unknown', project: sibling, spec: {}, worktree: {} }]));
    await assert.rejects(runtime.withWorkspaceMutation(sibling, async () => assert.fail('incomplete worktree')), error => error.data.reason === 'workspace_assignment_result');
    await writeFile(liveFile, '{broken');
    await assert.rejects(runtime.withWorkspaceMutation(sibling, async () => assert.fail('unknown callback')), error => error.data.reason === 'workspace_assignment_result');
    await writeFile(liveFile, JSON.stringify([{ assignmentId: 'recoverable', project: sibling, spec: { workdir: target } }]));
    await assert.rejects(runtime.withWorkspaceMutation(target, async () => assert.fail('recoverable callback')), error => error.data.reason === 'workspace_assignment_result');
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('an opening transport prevents mutation and live sessions protect their own checkout only', async () => {
  const { initProject } = await import('@anhlp/alp-core/init');
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-mutation-'));
  const target = path.join(root, 'checkout');
  const sibling = path.join(root, 'checkout-other');
  await initProject(target); await mkdir(sibling);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const runtime = createAlpRuntime({
    supervisor: false, libraryDir: path.join(root, 'library'),
    transport: () => ({
      async initialize() { entered(); await gate; },
      onNotification() {}, onFailure() {}, onRequest() {}, async close() {},
      async request() { return { thread: { id: 'test-thread' } }; },
    }),
  });
  try {
    await runtime.registerWorkspace(target); await runtime.registerWorkspace(sibling);
    const opening = runtime.open('opening', { cwd: target, model: 'codex:gpt-5.6-sol' });
    await ready;
    await assert.rejects(runtime.withWorkspaceMutation(sibling, async () => assert.fail('opening race')), error => error.data.reason === 'workspace_busy');
    release(); await opening;
    await assert.rejects(runtime.withWorkspaceMutation(target, async () => assert.fail('live session')), error => error.data.reason === 'workspace_busy');
    assert.equal(await runtime.withWorkspaceMutation(sibling, async () => 'safe'), 'safe');
    await runtime.close('opening');
    assert.equal(await runtime.withWorkspaceMutation(target, async () => 'closed'), 'closed');
  } finally { release(); await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('delegation preflight reserves admission until its child is registered', async () => {
  const { initProject } = await import('@anhlp/alp-core/init');
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-mutation-'));
  const project = path.join(root, 'project');
  const target = path.join(root, 'target');
  await initProject(project); await mkdir(target);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  const transports = [];
  const runtime = createAlpRuntime({ supervisor: false, libraryDir: path.join(root, 'library'), transport: () => {
    const index = transports.length;
    const transport = {
      async initialize() { if (index === 1) { entered(); await gate; } },
      onNotification() {}, onFailure() {}, onRequest(fn) { this.handle = fn; }, async close() {},
      async request(method) {
        if (method.startsWith('thread/')) return { thread: { id: `thread-${index}` } };
        if (method === 'turn/start') return { turn: { id: `turn-${index}` } };
        return {};
      },
    };
    transports.push(transport); return transport;
  } });
  try {
    await runtime.registerWorkspace(target);
    await runtime.open('root', { cwd: project, model: 'codex:gpt-5.6-sol' });
    await runtime.prompt('root', { clientMessageId: 'start', delivery: 'auto', content: [{ type: 'text', text: 'Work' }] });
    const delegation = transports[0].handle('item/tool/call', { threadId: 'thread-0', turnId: 'turn-0', callId: 'delegate', tool: 'alp_delegate', arguments: { agent: 'peer', task: 'Inspect', mode: 'read-only', wait: false } });
    await ready;
    await assert.rejects(runtime.withWorkspaceMutation(target, async () => assert.fail('delegation race')), error => error.data.reason === 'workspace_busy');
    release(); await delegation;
    assert.equal(await runtime.withWorkspaceMutation(target, async () => {
      await assert.rejects(transports[0].handle('item/tool/call', { threadId: 'thread-0', turnId: 'turn-0', callId: 'blocked-delegate', tool: 'alp_delegate', arguments: { agent: 'peer', task: 'Inspect again', mode: 'read-only', wait: false } }), error => error.data.reason === 'workspace_busy');
      assert.equal(transports.length, 2);
      return 'independent';
    }), 'independent');
  } finally { release(); await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('permanent result ownership survives restart and recall expiry; lost ledger fails closed', async () => {
  const { createAssignmentResults } = await import('../dist/assignment-results.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-mutation-'));
  const target = path.join(root, 'checkout');
  await mkdir(target);
  const assignmentResultFile = path.join(root, 'results.json');
  const options = { assignmentResultFile, recallFile: path.join(root, 'recall.json'), liveFile: path.join(root, 'live.json') };
  let runtime = createAlpRuntime(options);
  try {
    await runtime.registerWorkspace(target);
    const ledger = createAssignmentResults(assignmentResultFile);
    await ledger.put({ assignmentId: 'unmerged', checkout: target, worktree: path.join(root, 'retained-worktree') });
    await runtime.shutdown();
    // Neither recall nor live history exists: permanent ownership remains authoritative.
    runtime = createAlpRuntime(options);
    await assert.rejects(runtime.withWorkspaceMutation(target, async () => assert.fail('retained result')), error => error.data.reason === 'workspace_assignment_result');
    await ledger.remove('unmerged');
    assert.equal(await runtime.withWorkspaceMutation(target, async () => 'released'), 'released');
    await rm(assignmentResultFile);
    await assert.rejects(runtime.registerWorkspace(target), error => error.data.reason === 'workspace_assignment_result');
    await assert.rejects(runtime.withWorkspaceMutation(target, async () => assert.fail('lost ledger')), error => error.data.reason === 'workspace_assignment_result');
    await writeFile(assignmentResultFile, '{broken');
    await assert.rejects(runtime.registerWorkspace(target), error => error.data.reason === 'workspace_assignment_result');
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('unfinished writers remain owned if recovery books disappear before their first result',async()=>{
 const {initProject}=await import('@anhlp/alp-core/init');const {fakeTransport}=await import('../../../test/support/fake-agent.js');const {readFile,realpath}=await import('node:fs/promises');
 const root=await realpath(await mkdtemp(path.join(os.tmpdir(),'alp-unfinished-owner-')));const project=path.join(root,'project'),target=path.join(root,'managed');await initProject(project);await mkdir(target);const assignmentResultFile=path.join(root,'results.json'),liveFile=path.join(root,'live.json'),recallFile=path.join(root,'recall.json');
 const options={assignmentResultFile,liveFile,recallFile,supervisor:false,libraryDir:path.join(root,'library')};const agents=[];let runtime=createAlpRuntime({...options,transport:fakeTransport(agents)});
 try{
  await runtime.registerWorkspace(target);await runtime.open('root',{cwd:project,workflow:'pho',mode:'workspace-write',model:'codex:gpt-5.6-sol'});await runtime.prompt('root',{clientMessageId:'start',delivery:'auto',content:[{type:'text',text:'Work'}]});
  const result=await agents[0].call('alp_delegate',{agent:'peer',task:'Keep working',mode:'workspace-write',writeRoot:target,wait:false});assert.ok(result.assignmentId,JSON.stringify(result));
  const ledger=JSON.parse(await readFile(assignmentResultFile,'utf8'));assert.ok(ledger.results.some(owner=>owner.assignmentId===result.assignmentId && owner.checkout===target),'ownership must precede native assignment work');
  await runtime.shutdown();await rm(liveFile,{force:true});await rm(recallFile,{force:true});runtime=createAlpRuntime(options);
  await assert.rejects(runtime.withWorkspaceMutation(target,async()=>assert.fail('unfinished owner lost with recovery books')),error=>error.data.reason==='workspace_assignment_result');
 }finally{await runtime.shutdown();await rm(root,{recursive:true,force:true});}
});

test('ancestor ownership refuses mutation while boundary siblings remain independent', async () => {
  const { createAssignmentResults } = await import('../dist/assignment-results.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-overlap-owner-'));
  const target = path.join(root, 'checkout');
  const sibling = path.join(root, 'checkout-other');
  await mkdir(target); await mkdir(sibling);
  const assignmentResultFile = path.join(root, 'results.json');
  const liveFile = path.join(root, 'live.json'), recallFile = path.join(root, 'recall.json');
  const runtime = createAlpRuntime({ assignmentResultFile, liveFile, recallFile });
  try {
    await runtime.registerWorkspace(target);
    const ledger = createAssignmentResults(assignmentResultFile);
    for (const checkout of [root, target, path.join(target, 'missing-child')]) {
      await ledger.put({ assignmentId: 'owner', checkout });
      await assert.rejects(runtime.withWorkspaceMutation(target, async () => assert.fail('overlapping retained owner')), error => error.data.reason === 'workspace_assignment_result');
      await ledger.remove('owner');
    }
    await ledger.put({ assignmentId: 'sibling', checkout: sibling });
    assert.equal(await runtime.withWorkspaceMutation(target, async () => 'independent'), 'independent');
    await ledger.remove('sibling');
    await writeFile(liveFile, JSON.stringify([{ assignmentId: 'ancestor-live', project: sibling, spec: { writeRoot: root } }]));
    await assert.rejects(runtime.withWorkspaceMutation(target, async () => assert.fail('ancestor live scope')), error => error.data.reason === 'workspace_assignment_result');
    await writeFile(liveFile, '[]');
    await writeFile(recallFile, JSON.stringify([{ assignmentId: 'ancestor-recall', cwd: sibling, shared: { writeRoot: root } }]));
    await assert.rejects(runtime.withWorkspaceMutation(target, async () => assert.fail('ancestor recall scope')), error => error.data.reason === 'workspace_assignment_result');
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('a shared writer result holds its checkout until its requester resolves it; then it is archived and recall no longer holds it', async () => {
  const { initProject } = await import('@anhlp/alp-core/init');
  const { fakeTransport } = await import('../../../test/support/fake-agent.js');
  const { readFile, readdir, realpath } = await import('node:fs/promises');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-shared-result-')));
  const project = path.join(root, 'project'), target = path.join(root, 'managed');
  await initProject(project); await mkdir(target);
  const assignmentResultFile = path.join(root, 'results.json'), liveFile = path.join(root, 'live.json'), recallFile = path.join(root, 'recall.json');
  const options = { assignmentResultFile, liveFile, recallFile, supervisor: false, libraryDir: path.join(root, 'library') };
  const agents = [];
  let runtime = createAlpRuntime({ ...options, transport: fakeTransport(agents) });
  try {
    await runtime.registerWorkspace(target);
    await runtime.open('root', { cwd: project, workflow: 'pho', mode: 'workspace-write', model: 'codex:gpt-5.6-sol' });
    await runtime.prompt('root', { clientMessageId: 'start', delivery: 'auto', content: [{ type: 'text', text: 'Work' }] });
    const main = agents[0];
    assert.ok(main.config.dynamicTools.some(tool => tool.name === 'alp_resolve'));
    const started = await main.call('alp_delegate', { agent: 'peer', task: 'Write in managed', mode: 'workspace-write', writeRoot: target, wait: false });
    assert.ok(started.assignmentId, JSON.stringify(started));
    while (agents.length < 2 || !agents[1].turnId) await new Promise(resolve => setTimeout(resolve, 10));
    agents[1].finish('wrote managed/file');
    await main.call('alp_wait', { assignments: [started.assignmentId] });
    const [owner] = JSON.parse(await readFile(assignmentResultFile, 'utf8')).results;
    assert.equal(owner.assignmentId, started.assignmentId);
    assert.equal(owner.result.agent, 'peer');
    assert.equal(owner.result.status, 'completed');
    assert.deepEqual(owner.result.requesters, ['root']);
    assert.match(owner.result.summary, /wrote managed\/file/);
    // Recall expiry is no proof of handling: without its recall entry the ledger still holds the checkout.
    await runtime.shutdown();
    await rm(recallFile, { force: true });
    runtime = createAlpRuntime({ ...options, transport: fakeTransport(agents) });
    await assert.rejects(runtime.withWorkspaceMutation(target, async () => assert.fail('produced result')), error => error.data.reason === 'workspace_assignment_result' && error.message.includes(`Resolve permanent assignment result ${started.assignmentId}`));
    await runtime.open('root', { cwd: project, workflow: 'pho', mode: 'workspace-write', model: 'codex:gpt-5.6-sol' });
    await runtime.prompt('root', { clientMessageId: 'again', delivery: 'auto', content: [{ type: 'text', text: 'Handle it' }] });
    const reopened = agents.at(-1);
    assert.match((await reopened.call('alp_resolve', { assignmentId: started.assignmentId, outcome: 'merged' })).error, /outcome/);
    assert.match((await reopened.call('alp_resolve', { assignmentId: 'unknown', outcome: 'applied' })).error, /No unresolved assignment result/);
    // The requester's session is gone; a root of the project may still resolve it.
    const resolved = await reopened.call('alp_resolve', { assignmentId: started.assignmentId, outcome: 'applied', note: 'committed as abc123' });
    assert.equal(resolved.resolved, started.assignmentId, JSON.stringify(resolved));
    assert.match((await reopened.call('alp_resolve', { assignmentId: started.assignmentId, outcome: 'applied' })).error, /No unresolved assignment result/);
    assert.deepEqual(JSON.parse(await readFile(assignmentResultFile, 'utf8')).results, []);
    const months = await readdir(path.join(root, 'assignment-archive'));
    assert.equal(months.length, 1);
    const [record] = (await readFile(path.join(root, 'assignment-archive', months[0]), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(record.assignmentId, started.assignmentId);
    assert.equal(record.result.agent, 'peer');
    assert.deepEqual({ outcome: record.handled.outcome, note: record.handled.note, by: record.handled.by }, { outcome: 'applied', note: 'committed as abc123', by: 'main in root' });
    // A recall entry of the resolved result no longer holds the checkout; one of another assignment still does.
    await writeFile(recallFile, JSON.stringify([{ assignmentId: started.assignmentId, cwd: project, shared: { writeRoot: target } }]));
    await runtime.close('root');
    assert.equal(await runtime.withWorkspaceMutation(target, async () => 'released'), 'released');
    await writeFile(recallFile, JSON.stringify([{ assignmentId: 'other', cwd: project, shared: { writeRoot: target } }]));
    await assert.rejects(runtime.withWorkspaceMutation(target, async () => assert.fail('unresolved recall')), error => error.data.reason === 'workspace_assignment_result');
  } finally { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); }
});

test('the result ledger archives handled entries, survives a torn archive line, and prunes only old archive months', async () => {
  const { createAssignmentResults, ARCHIVE_KEEP_MS } = await import('../dist/assignment-results.js');
  const { readFile, readdir } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-result-archive-'));
  const file = path.join(root, 'state', 'assignment-results.json');
  const archive = path.join(root, 'state', 'assignment-archive');
  const ledger = createAssignmentResults(file);
  const handled = { outcome: 'discarded', by: 'main in root', at: new Date().toISOString() };
  try {
    await ledger.put({ assignmentId: 'a', checkout: root });
    await ledger.put({ assignmentId: 'b', checkout: root });
    await assert.rejects(ledger.resolve('missing', handled), /No retained assignment result/);
    await assert.rejects(ledger.resolve('a', { ...handled, outcome: 'expired' }), /Invalid result handling/);
    // A handled entry left by a crash before archiving is archived with the next resolution.
    const value = JSON.parse(await readFile(file, 'utf8'));
    value.results[1].handled = handled;
    await writeFile(file, JSON.stringify(value));
    assert.equal((await ledger.inspect()).results.length, 2);
    const month = new Date().toISOString().slice(0, 7);
    await mkdir(archive, { recursive: true });
    await writeFile(path.join(archive, `${month}.jsonl`), '{"assignmentId":"torn"');
    const old = new Date(Date.now() - ARCHIVE_KEEP_MS - 62 * 86_400_000).toISOString().slice(0, 7);
    await writeFile(path.join(archive, `${old}.jsonl`), JSON.stringify({ assignmentId: 'old' }) + '\n');
    const record = await ledger.resolve('a', handled);
    assert.equal(record.assignmentId, 'a');
    assert.deepEqual((await ledger.inspect()).results, []);
    assert.deepEqual(await readdir(archive), [`${month}.jsonl`]);
    assert.equal((await ledger.archived('a')).handled.outcome, 'discarded');
    assert.equal((await ledger.archived('b')).assignmentId, 'b');
    assert.equal(await ledger.archived('old'), undefined);
    assert.equal(await ledger.archived('torn'), undefined);
    // An invalid handling record makes the ledger fail closed rather than release paths.
    await writeFile(file, JSON.stringify({ version: 1, workspaces: [], results: [{ assignmentId: 'c', checkout: root, handled: { outcome: 'expired' } }] }));
    await assert.rejects(ledger.inspect(), /Invalid assignment result ledger/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
