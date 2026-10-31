// The project, task, library and settings methods (docs/protocol/alp-json-rpc-v1.md §15) over a real
// socket: params and results against the v1 schema, refusals as protocol errors, paths kept inside
// their project, secrets kept inside alpd, and concurrent writes that never both win.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { addGate, getTask, loadTasks, resolveGate } from '@anhlp/alp-core/tasks';
import { getEntry } from '@anhlp/alp-core/library-edit';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { CAPABILITY } from '@anhlp/alp-protocol';
import { validateResult } from '@anhlp/alp-protocol/contract';

/** Agents whose turns complete by themselves, so mail they take counts as taken. */
function fakeTransport() {
  return () => {
    let notify = () => {};
    let turns = 0;
    return {
      async initialize() {}, onNotification(fn) { notify = fn; }, onFailure() {}, onRequest() {}, async close() {},
      async request(method) {
        if (method === 'turn/start') {
          const id = `turn-${++turns}`;
          setTimeout(() => notify('turn/completed', { threadId: 'thread-1', turn: { id, status: 'completed' } }), 5);
          return { turn: { id } };
        }
        return method.startsWith('thread/') ? { thread: { id: 'thread-1' } } : {};
      },
    };
  };
}

async function setup(t, { home: withHome = true, runtimeOptions = {} } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-ops-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const project = path.join(directory, 'project');
  await initProject(project);
  const runtime = createAlpRuntime({ transport: fakeTransport(), libraryDir: home, ...runtimeOptions });
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(directory).socket, version: 'test', ...(withHome ? { home } : {}) });
  await server.listen();
  t.after(async () => { await server.close(); await runtime.shutdown(); });
  // After hooks run in the order they are added: remove the files only once that has stopped.
  t.after(() => rm(directory, { recursive: true, force: true }));
  const client = await connect(daemonPaths(directory).socket, { name: 'operations-test', version: '0' });
  t.after(() => client.close());
  /** A request whose result must match the method's v1 result schema. */
  const call = async (method, params) => {
    const result = await client.request(method, params);
    assert.deepEqual(validateResult(method, result), [], `${method} result: ${JSON.stringify(result)}`);
    return result;
  };
  const fails = (method, params, code, reason) => assert.rejects(client.request(method, params), error => {
    assert.equal(error.code, code, `${method}: ${error.message}`);
    if (reason) assert.equal(error.data?.reason, reason, `${method}: ${error.message}`);
    return true;
  });
  return { directory, home, project, client, call, fails, runtime, socket: daemonPaths(directory).socket };
}

test('gates (t-ccac): task.gate.resolve approves with a choice or rejects, records the channel, and settles the live main\'s card', async t => {
  const { project, call, fails, runtime, socket } = await setup(t);
  const { id } = await call('task.create', { projectRoot: project, title: 'Ship' });
  await addGate(project, id, { kind: 'human', note: 'Which?', options: ['A', 'B'] }, 'main');
  await addGate(project, id, { kind: 'human', note: 'Plain?' }, 'main');
  // A viewer attaches a main root: the project's open human gates show on it as cards.
  const { client } = { client: await connect(socket, { name: 'alp-web-test', version: '1' }) };
  t.after(() => client.close());
  const { session } = await client.request('session.create', { spec: { cwd: project } });
  await client.request('session.attach', { sessionId: session.id });
  const cards = () => runtime.questions().filter(question => question.gate);
  for (let i = 0; i < 200 && cards().length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(cards().map(question => question.id).sort(), [`gate-${id}-g1`, `gate-${id}-g2`]);
  let list = await call('task.list', { projectRoot: project });
  assert.deepEqual(list.tasks[0].approvals[0], { gate: 'g1', note: 'Which?', options: ['A', 'B'] });

  await fails('task.gate.resolve', { projectRoot: project, id, gate: 'g1', choice: 'C' }, 1004, 'task_state');
  await fails('task.gate.resolve', { projectRoot: project, id, gate: 'g1', channel: 'cli' }, -32602, 'invalid_params');
  const rejected = await call('task.gate.resolve', { projectRoot: project, id, gate: 'g1', reject: true, note: 'Not yet', ifRev: list.tasks[0].rev });
  assert.equal(rejected.status, 'open');
  list = await call('task.list', { projectRoot: project });
  assert.equal(list.tasks[0].approvals[0].rejected.reason, 'Not yet');
  assert.ok(!cards().some(question => question.id === `gate-${id}-g1`), 'a rejected gate has no card');
  // Marked reported once main's turn took the mail (t-595d).
  for (let i = 0; i < 200 && !(await getTask(project, id)).gates[0].rejected?.notified; i++) await new Promise(resolve => setTimeout(resolve, 10));
  let stored = await getTask(project, id);
  assert.deepEqual([stored.gates[0].rejected.channel, !!stored.gates[0].rejected.notified], ['web', true]);

  // Answered from Paseo: the card's channel comes from the client's hello.
  const paseo = await connect(socket, { name: 'alp-paseo', version: '1' });
  t.after(() => paseo.close());
  await paseo.request('question.answer', { questionId: `gate-${id}-g2`, text: 'Duyệt' });
  for (let i = 0; i < 200 && !(await getTask(project, id)).gates[1].resolved?.notified; i++) await new Promise(resolve => setTimeout(resolve, 10));
  stored = await getTask(project, id);
  assert.deepEqual([stored.gates[1].resolved.by, stored.gates[1].resolved.channel], ['user', 'paseo']);
  // The answered card goes when the runtime handles the answer, not when the task file is written (t-1861).
  for (let i = 0; i < 200 && cards().length > 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(cards().length, 0);

  const approved = await call('task.gate.resolve', { projectRoot: project, id, gate: 'g1', choice: 'B', channel: 'paseo' });
  assert.equal(approved.status, 'open');
  for (let i = 0; i < 200 && !(await getTask(project, id)).gates[0].resolved?.notified; i++) await new Promise(resolve => setTimeout(resolve, 10));
  stored = await getTask(project, id);
  assert.deepEqual([stored.gates[0].resolved.choice, stored.gates[0].resolved.channel, !!stored.gates[0].resolved.notified], ['B', 'paseo', true]);
  await fails('task.gate.resolve', { projectRoot: project, id, gate: 'g1', choice: 'A' }, 1004, 'task_state');
});

test('question.answer refuses a gate card answer that decides nothing, with the reason (t-595d)', async t => {
  // No file watch or timer: the card stays up after a decision made behind alpd's back.
  const { project, call, socket } = await setup(t, { runtimeOptions: { gateSyncMs: 0 } });
  const { id } = await call('task.create', { projectRoot: project, title: 'Ship' });
  const { id: other } = await call('task.create', { projectRoot: project, title: 'Broken' });
  await addGate(project, id, { kind: 'human', note: 'Go?' }, 'main');
  await addGate(project, other, { kind: 'human', note: 'Fix?' }, 'main');
  const viewer = await connect(socket, { name: 'alp-web-test', version: '1' });
  t.after(() => viewer.close());
  const { session } = await viewer.request('session.create', { spec: { cwd: project } });
  await viewer.request('session.attach', { sessionId: session.id });
  const open = async () => (await viewer.request('question.list', {})).questions.map(question => question.id);
  for (let i = 0; i < 200 && (await open()).length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual((await open()).sort(), [`gate-${id}-g1`, `gate-${other}-g1`].sort());

  // The CLI approved it without alpd: the card's answer says so instead of vanishing.
  await resolveGate(project, id, 'g1', { by: 'user', channel: 'cli' });
  await assert.rejects(viewer.request('question.answer', { questionId: `gate-${id}-g1`, text: 'Từ chối' }), error => {
    assert.deepEqual([error.code, error.data?.reason], [1004, 'task_state'], error.message);
    assert.match(error.message, /already approved in cli/);
    return true;
  });
  assert.equal((await getTask(project, id)).gates[0].rejected, undefined);
  // The write fails: the task file is unreadable.
  await writeFile(path.join(project, '.alp', 'tasks', `${other}.json`), '{ not json');
  await assert.rejects(viewer.request('question.answer', { questionId: `gate-${other}-g1`, text: 'Duyệt' }), error => {
    assert.deepEqual([error.code, error.data?.reason], [1001, 'unknown_task'], error.message);
    return true;
  });
});

test('capabilities name only what this daemon serves; unserved methods are unknown', async t => {
  const bare = await setup(t, { home: false });
  const hello = await bare.client.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(hello.capabilities.includes(CAPABILITY.task));
  for (const name of [CAPABILITY.team, CAPABILITY.library, CAPABILITY.libraryProjectWrite, CAPABILITY.settingsLanguage]) assert.ok(!hello.capabilities.includes(name), name);
  for (const method of ['team.list', 'library.list', 'library.models', 'settings.language.get']) await bare.fails(method, { kind: 'agents' }, -32601);
  await bare.call('task.list', { projectRoot: bare.project });
  // No extension takes a v1 name or namespace, served here or not.
  await bare.fails('extension.register', { method: 'library.list' }, 1004);
  await bare.fails('extension.register', { method: 'library.anything' }, 1006);

  const full = await setup(t);
  const capabilities = (await full.client.request('daemon.hello', { protocolVersion: 1 })).capabilities;
  for (const name of [CAPABILITY.task, CAPABILITY.team, CAPABILITY.library, CAPABILITY.libraryProjectWrite, CAPABILITY.settingsLanguage]) assert.ok(capabilities.includes(name), name);
});

test('tasks: create, list, close, reopen and approve a gate, with revisions and the task state checked', async t => {
  const { project, call, fails } = await setup(t);
  assert.deepEqual((await call('task.list', { projectRoot: project })).tasks, []);
  const { id } = await call('task.create', { projectRoot: project, title: '  Viết test 😀  ', priority: 1 });
  let list = await call('task.list', { projectRoot: project });
  assert.equal(list.projectRoot, project);
  assert.deepEqual(list.tasks.map(task => [task.id, task.title, task.priority, task.status]), [[id, 'Viết test 😀', 1, 'open']]);
  const before = list.revision;

  const closed = await call('task.update', { projectRoot: project, id, action: 'close', note: 'Xong', ifRev: list.tasks[0].rev });
  assert.equal(closed.status, 'closed');
  assert.ok(closed.rev > list.tasks[0].rev);
  list = await call('task.list', { projectRoot: project });
  assert.notEqual(list.revision, before);
  assert.equal(list.tasks[0].closed.summary, 'Xong');
  // A stale revision and a second close are conflicts, and change nothing.
  await fails('task.update', { projectRoot: project, id, action: 'reopen', ifRev: closed.rev - 1 }, 1004, 'revision_conflict');
  await fails('task.update', { projectRoot: project, id, action: 'close' }, 1004, 'task_state');
  const reopened = await call('task.update', { projectRoot: project, id, action: 'reopen', note: 'chưa xong' });
  assert.equal(reopened.status, 'open');

  await addGate(project, id, { kind: 'human', note: 'Duyệt giúp' }, 'main');
  list = await call('task.list', { projectRoot: project });
  assert.deepEqual(list.tasks[0].approvals, [{ gate: 'g1', note: 'Duyệt giúp' }]);
  await fails('task.gate.resolve', { projectRoot: project, id, gate: 'g1', ifRev: list.tasks[0].rev - 1 }, 1004, 'revision_conflict');
  const approved = await call('task.gate.resolve', { projectRoot: project, id, gate: 'g1', note: 'OK', ifRev: list.tasks[0].rev });
  assert.equal(approved.id, id);
  await fails('task.gate.resolve', { projectRoot: project, id, gate: 'g1' }, 1004, 'task_state');
  assert.equal((await call('task.list', { projectRoot: project })).tasks[0].approvals, undefined);
  const [stored] = (await loadTasks(project)).tasks;
  assert.equal(stored.log.find(entry => entry.event === 'gate cleared').by, 'user');

  await fails('task.update', { projectRoot: project, id: 't-ffff', action: 'close' }, 1001, 'unknown_task');
  // The schema refuses bad params before anything runs.
  await fails('task.create', { projectRoot: project, title: '   ' }, -32602, 'invalid_params');
  await fails('task.create', { projectRoot: project, title: 'x', priority: 9 }, -32602, 'invalid_params');
  await fails('task.update', { projectRoot: project, id, action: 'approve' }, -32602, 'invalid_params');
  assert.equal((await loadTasks(project)).tasks.length, 1);
});

test('task.create: a requestId answers its repeats within this alpd, and refuses other content', async t => {
  const { project, call, fails } = await setup(t);
  const first = await call('task.create', { projectRoot: project, title: 'Một lần', requestId: 'req-1' });
  assert.deepEqual(await call('task.create', { projectRoot: project, title: 'Một lần', requestId: 'req-1' }), { id: first.id, duplicate: true });
  await fails('task.create', { projectRoot: project, title: 'Khác', requestId: 'req-1' }, 1004, 'key_conflict');
  const concurrent = await Promise.all(Array.from({ length: 5 }, () => call('task.create', { projectRoot: project, title: 'Cùng lúc', requestId: 'req-2' })));
  assert.equal(new Set(concurrent.map(result => result.id)).size, 1);
  assert.equal(concurrent.filter(result => result.duplicate).length, 4);
  // Without a requestId, concurrent creates all happen, each under the task lock.
  const many = await Promise.all(Array.from({ length: 8 }, (_, index) => call('task.create', { projectRoot: project, title: `Việc ${index}` })));
  assert.equal(new Set(many.map(result => result.id)).size, 8);
  assert.equal((await loadTasks(project)).tasks.length, 10);
});

test('projectRoot: absolute, normalized, a real project; symlinks out of .alp are refused', async t => {
  const { directory, project, fails } = await setup(t);
  await fails('task.list', { projectRoot: 'project' }, -32602, 'invalid_path');
  await fails('task.list', { projectRoot: `${project}/../project` }, -32602, 'invalid_path');
  await fails('task.list', { projectRoot: `${project}/` }, -32602, 'invalid_path');
  await fails('task.list', { projectRoot: path.join(directory, 'missing') }, 1001, 'not_alp_project');
  // alpd never walks up: a directory inside a project is not that project.
  await mkdir(path.join(project, 'src'));
  await fails('task.list', { projectRoot: path.join(project, 'src') }, 1001, 'not_alp_project');
  await fails('library.list', { kind: 'agents', projectRoot: path.join(project, 'src') }, 1001, 'not_alp_project');

  const outside = path.join(directory, 'outside');
  await mkdir(path.join(outside, 'tasks'), { recursive: true });
  const linked = path.join(directory, 'linked');
  await mkdir(linked);
  await symlink(outside, path.join(linked, '.alp'));
  await fails('task.list', { projectRoot: linked }, 1003, 'unsafe_path');
  await fails('task.create', { projectRoot: linked, title: 'x' }, 1003, 'unsafe_path');

  const tasksLink = path.join(directory, 'tasks-link');
  await initProject(tasksLink);
  await rm(path.join(tasksLink, '.alp', 'tasks'), { recursive: true, force: true });
  await symlink(path.join(outside, 'tasks'), path.join(tasksLink, '.alp', 'tasks'));
  await fails('task.create', { projectRoot: tasksLink, title: 'x' }, 1003, 'unsafe_path');
  assert.deepEqual(await readdir(path.join(outside, 'tasks')), [], 'nothing was written through the links');
});

test('task writes wait for the task lock, then answer busy', { timeout: 20_000 }, async t => {
  const { project, fails } = await setup(t);
  await mkdir(path.join(project, '.alp', 'tasks', '.lock'), { recursive: true });
  await fails('task.create', { projectRoot: project, title: 'x' }, 1005, 'busy');
});

test('library: secrets never leave alpd, and a save keeps, replaces or removes each one', async t => {
  const { home, project, call, fails } = await setup(t);
  const server = { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer sk-live-123', 'X-Team': 'blue' } };
  const created = await call('library.save', { kind: 'mcp', name: 'docs', scope: 'library', content: { server }, revision: null });
  const file = path.join(home, 'mcp', 'docs.json');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), server);

  const read = await call('library.get', { kind: 'mcp', name: 'docs' });
  assert.equal(JSON.stringify(read).includes('sk-live-123'), false);
  assert.deepEqual(read.content.server.headers, { Authorization: { $secret: 'keep' }, 'X-Team': { $secret: 'keep' } });
  assert.deepEqual(read.secrets, ['/server/headers/Authorization', '/server/headers/X-Team']);
  assert.equal(read.revision, created.revision);
  // The wire revision is not core's content hash, which would be an oracle for the secret.
  const core = await getEntry('mcp', 'docs', { library: home });
  assert.notEqual(read.revision, core.revision);

  // Sent back unchanged it keeps both values; a string replaces one; a missing key removes one.
  const kept = await call('library.save', { kind: 'mcp', name: 'docs', scope: 'library', content: read.content, revision: read.revision });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), server);
  const changed = await call('library.save', { kind: 'mcp', name: 'docs', scope: 'library', content: { server: { url: server.url, headers: { Authorization: 'Bearer sk-new' } } }, revision: kept.revision });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).headers, { Authorization: 'Bearer sk-new' });

  // A marker with nothing stored to keep, or outside a secret map, never reaches storage.
  await fails('library.save', { kind: 'mcp', name: 'docs', scope: 'library', content: { server: { url: server.url, headers: { Authorization: { $secret: 'keep' }, Other: { $secret: 'keep' } } } }, revision: changed.revision }, -32602, 'secret_marker');
  await fails('library.save', { kind: 'providers', name: 'gem', scope: 'library', content: { provider: { kind: 'acp', command: 'gemini', params: { token: { $secret: 'keep' } } } } }, -32602, 'secret_marker');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).headers, { Authorization: 'Bearer sk-new' });

  // An override in the project keeps the library's value it was read from.
  const fromLibrary = await call('library.get', { kind: 'mcp', name: 'docs', projectRoot: project });
  await call('library.save', { kind: 'mcp', name: 'docs', scope: 'project', projectRoot: project, content: fromLibrary.content, revision: null });
  assert.deepEqual(JSON.parse(await readFile(path.join(project, '.alp', 'mcp', 'docs.json'), 'utf8')).headers, { Authorization: 'Bearer sk-new' });

  // Providers: env is secret, command and args are not; library.models shows neither.
  await call('library.save', { kind: 'providers', name: 'gem', scope: 'library', content: { provider: { kind: 'acp', label: 'Gemini', command: 'gemini', args: ['--acp'], env: { GEMINI_API_KEY: 'g-secret' }, models: [{ id: 'g-2' }] } } });
  const provider = await call('library.get', { kind: 'providers', name: 'gem' });
  assert.deepEqual(provider.content.provider.env, { GEMINI_API_KEY: { $secret: 'keep' } });
  assert.equal(provider.content.provider.command, 'gemini');
  const { models } = await call('library.models', {});
  assert.ok(models.some(model => model.id === 'acp:gem/g-2'));
  assert.ok(models.some(model => model.id.startsWith('codex:')));
  assert.equal(JSON.stringify(models).includes('g-secret') || JSON.stringify(models).includes('gemini --acp'), false);
  await fails('library.save', { kind: 'providers', name: 'gem', scope: 'project', projectRoot: project, content: provider.content }, -32602, 'invalid_scope');
});

test('library: revisions refuse a save over another change; concurrent saves never both win', async t => {
  const { project, call, fails } = await setup(t);
  const created = await call('library.save', { kind: 'skills', name: 'tdd', scope: 'project', projectRoot: project, content: { body: 'Viết test trước.' }, revision: null });
  await fails('library.save', { kind: 'skills', name: 'tdd', scope: 'project', projectRoot: project, content: { body: 'x' }, revision: null }, 1004, 'revision_conflict');
  const results = await Promise.allSettled(['A', 'B', 'C'].map(body => call('library.save', { kind: 'skills', name: 'tdd', scope: 'project', projectRoot: project, content: { body }, revision: created.revision })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  for (const result of results.filter(result => result.status === 'rejected')) assert.equal(result.reason.data.reason, 'revision_conflict');
  const winner = results.find(result => result.status === 'fulfilled').value;
  const current = await call('library.get', { kind: 'skills', name: 'tdd', projectRoot: project, scope: 'project' });
  assert.equal(current.revision, winner.revision);

  await fails('library.delete', { kind: 'skills', name: 'tdd', scope: 'project', projectRoot: project, revision: created.revision }, 1004, 'revision_conflict');
  await fails('library.save', { kind: 'skills', name: 'tdd', scope: 'project', content: { body: 'x' } }, -32602, 'invalid_scope');
  await fails('library.save', { kind: 'skills', name: 'bad', scope: 'library', content: { body: 'x', extra: 1 } }, -32602, 'invalid_entry');
  await fails('library.get', { kind: 'skills', name: '..' }, -32602, 'invalid_params');
  await fails('library.get', { kind: 'skills', name: 'missing' }, 1001, 'not_found');

  await call('library.duplicate', { kind: 'skills', from: 'tdd', to: 'tdd-2', scope: 'library', projectRoot: project });
  await fails('library.duplicate', { kind: 'skills', from: 'nope', to: 'x', scope: 'library' }, 1001, 'not_found');
  await fails('library.duplicate', { kind: 'skills', from: 'tdd', to: 'tdd-2', scope: 'library', projectRoot: project }, 1004, 'revision_conflict');
  await call('library.rename', { kind: 'skills', from: 'tdd-2', to: 'tdd-3', scope: 'library' });
  await call('library.skills.set', { agent: 'main', skills: ['tdd-3'] });
  // A skill an agent is given is in use: renaming or deleting it is refused.
  await fails('library.rename', { kind: 'skills', from: 'tdd-3', to: 'tdd-4', scope: 'library' }, 1004, 'in_use');
  await fails('library.skills.set', { agent: 'main', skills: ['nope'] }, -32602, 'invalid_entry');
  assert.deepEqual((await call('library.get', { kind: 'agents', name: 'main' })).librarySkills, ['tdd-3']);
  await call('library.skills.set', { agent: 'main', skills: [] });
  const removed = await call('library.delete', { kind: 'skills', name: 'tdd-3', scope: 'library' });
  assert.deepEqual(removed, { removed: true });
  await fails('library.delete', { kind: 'skills', name: 'tdd-3', scope: 'library' }, 1001, 'not_found');
});

test('library.list and team.list show the layers without host paths', async t => {
  const { home, project, call } = await setup(t);
  const agents = await call('library.list', { kind: 'agents', projectRoot: project });
  assert.equal(agents.projectRoot, project);
  assert.ok(agents.entries.some(entry => entry.name === 'main' && entry.source === 'builtin'));
  assert.equal(JSON.stringify(agents).includes(home), false);
  assert.equal((await call('library.list', { kind: 'teams' })).projectRoot, null);
  const teams = await call('team.list', { projectRoot: project });
  assert.deepEqual(teams.teams.slice(0, 2).map(team => [team.id, team.source]), [['pho', 'builtin'], ['cafe', 'builtin']]);
  const team = await call('library.get', { kind: 'teams', name: 'pho' });
  await call('library.save', { kind: 'teams', name: 'mine', scope: 'library', content: team.content, revision: null });
  const listed = await call('team.list', {});
  assert.ok(listed.teams.some(entry => entry.id === 'mine' && entry.source === 'library' && !('path' in entry)));
  assert.equal(JSON.stringify(listed).includes(home), false);
});

test('settings.language: read, set, clear, and kept in settings.json with its other keys', async t => {
  const { home, call, fails } = await setup(t);
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ limits: { autoResume: false } }));
  assert.deepEqual(await call('settings.language.get', {}), { language: null, applies: 'Vietnamese', default: 'Vietnamese' });
  assert.deepEqual(await call('settings.language.set', { language: ' English ' }), { language: 'English', applies: 'English', default: 'Vietnamese' });
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')), { limits: { autoResume: false }, language: 'English' });
  await fails('settings.language.set', { language: 'x'.repeat(41) }, -32602);
  await fails('settings.language.set', { language: '' }, -32602, 'invalid_params');
  assert.equal((await call('settings.language.set', { language: null })).language, null);
  await writeFile(path.join(home, 'settings.json'), '{ broken');
  await fails('settings.language.get', {}, 1000, 'unreadable');
});

test('a team save syncs the projects alpd knows only when asked, and reports each one that fails', async t => {
  const { directory, project, client, call } = await setup(t);
  const other = path.join(directory, 'other');
  await initProject(other);
  await client.request('session.create', { sessionId: 'in-other', spec: { cwd: other } });
  await writeFile(path.join(other, '.alp', 'settings.json'), '{ broken');
  const team = await call('library.get', { kind: 'teams', name: 'pho' });
  const plain = await call('library.save', { kind: 'teams', name: 'mine', scope: 'library', content: team.content, revision: null });
  assert.equal(plain.syncedProjects, undefined);
  const synced = await call('library.save', { kind: 'teams', name: 'mine', scope: 'library', projectRoot: project, content: team.content, revision: plain.revision, sync: 'known-projects' });
  assert.equal(typeof synced.syncedProjects, 'number');
  assert.equal(synced.syncErrors.length, 1);
  assert.ok(synced.syncErrors[0].startsWith(`${other}:`));
});


test('project-data library policy is enforced by the authoritative daemon mutation', async t => {
  const { home, project, call, fails } = await setup(t);
  const safe = { kind: 'agents', scope: 'project', projectRoot: project, policy: 'project-data' };
  const content = { instructions: 'Project writer', config: { model: 'codex:gpt-6.1-sol', description: 'Docs' } };
  const saved = await call('library.save', { ...safe, name: 'project-writer', content, revision: null });
  await call('library.save', { ...safe, name: 'project-writer', content, revision: saved.revision });
  await call('library.duplicate', { ...safe, from: 'project-writer', to: 'project-copy' });
  await call('library.rename', { ...safe, from: 'project-copy', to: 'project-renamed' });
  await call('library.delete', { ...safe, name: 'project-renamed' });
  for (const config of [{ provider: 'codex' }, { mcp: [] }, { hooks: [] }, { skills: [] }, { mode: 'full-access' }, { model: 'acp:host' }]) {
    await fails('library.save', { ...safe, name: 'project-writer', content: { instructions: 'unsafe', config } }, 1003, 'library_policy');
  }
  await fails('library.save', { ...safe, name: 'project-writer', content, sync: 'known-projects' }, 1003, 'library_policy');
  await fails('library.save', { ...safe, name: 'host-write', scope: 'library', content }, 1003, 'library_policy');
  // Trusted local administration can keep its full contract; remote policy cannot reuse its references.
  await call('library.save', { kind: 'agents', name: 'host-entry', scope: 'library', content: { instructions: 'host', config: { provider: 'codex' } } });
  await call('library.save', { kind: 'agents', name: 'host-entry', scope: 'project', projectRoot: project, content: { instructions: 'override' } });
  await fails('library.delete', { ...safe, name: 'host-entry' }, 1003, 'library_policy');
  await fails('library.duplicate', { ...safe, from: 'host-entry', to: 'host-copy' }, 1003, 'library_policy');
  await fails('library.rename', { ...safe, from: 'host-entry', to: 'host-renamed' }, 1003, 'library_policy');
  await mkdir(path.join(project, '.alp/agents/project-writer/hooks'));
  await writeFile(path.join(project, '.alp/agents/project-writer/hooks/sidecar.sh'), 'echo unsafe');
  for (const [method, params] of [['save', { name: 'project-writer', content }], ['delete', { name: 'project-writer' }], ['duplicate', { from: 'project-writer', to: 'copy' }], ['rename', { from: 'project-writer', to: 'renamed' }]]) await fails('library.' + method, { ...safe, ...params }, 1003, 'library_policy');
  assert.equal(await readFile(path.join(project, '.alp/agents/project-writer/hooks/sidecar.sh'), 'utf8'), 'echo unsafe');
});
