import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { createTask } from '@anhlp/alp-core/tasks';
import { validateSettings } from '@anhlp/alp-core/validation';
import { validateTeam } from '@anhlp/alp-core/teams';
import { resolveWorkflow } from '@anhlp/alp-core/workflow';
import { createAlpRuntime } from '@anhlp/alp-runtime';

// workflow.maxLeads (t-672e): in Cafe a lead runs beside read-only assignments, and up to maxLeads
// leads run together when each has its own worktree and a task whose paths no other lead's overlaps.

let calls = 0;
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      kind, cwd, calls: [], threadId: `thread-${index}`, turnId: undefined,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') { this.turnId = `turn-${index}-${++turns}`; return { turn: { id: this.turnId } }; }
        return {};
      },
      get started() { return this.calls.filter(call => call.method === 'turn/start'); },
      get config() { return this.calls.find(call => call.method === 'thread/start')?.params; },
      async call(tool, args) {
        return JSON.parse((await this.serverRequest('item/tool/call', { threadId: this.threadId, turnId: this.turnId, callId: `${tool}-${index}-${++calls}`, namespace: null, tool, arguments: args })).contentItems[0].text);
      },
      finish(text = 'done') {
        this.notification('item/completed', { threadId: this.threadId, item: { type: 'agentMessage', id: `output-${index}-${turns}`, text } });
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'completed' } });
      },
      limit() {
        this.notification('turn/completed', { threadId: this.threadId, turn: { id: this.turnId, status: 'failed', error: { message: 'You have hit your usage limit', codexErrorInfo: 'usageLimitExceeded', additionalDetails: null } } });
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

async function until(check) {
  for (let i = 0; i < 600; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();

/** A Cafe project in git, its main on Codex; `workflow` adds maxLeads/maxPeers. */
async function setup(t, workflow = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-multi-lead-')));
  const root = path.join(directory, 'project');
  await initProject(root);
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ defaultAgent: 'main', workflow: { mode: 'cafe', maxPeers: 2, supervisor: false, ...workflow } }));
  for (const dir of ['api', 'web']) { await mkdir(path.join(root, dir)); await writeFile(path.join(root, dir, 'index.txt'), `${dir}\n`); }
  git(root, 'init', '--quiet', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  git(root, 'add', '-A');
  git(root, '-c', 'user.name=T', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'init');
  const runtimes = [];
  const runtime = createAlpRuntime({
    language: 'English', transport: fakeTransport(runtimes), supervisor: false, silentForMs: 3_600_000,
    libraryDir: path.join(directory, 'home'), runLogDir: path.join(directory, 'runs'), boardDir: path.join(directory, 'boards'),
    worktreeDir: path.join(directory, 'worktrees'), assignmentResultFile: path.join(directory, 'assignment-results.json'),
    pauseFile: path.join(directory, 'home', 'state', 'pause.json'),
  });
  // After hooks run in the order they are added: remove the files only once the runtime has stopped.
  t.after(() => runtime.shutdown());
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  await runtime.open('root', { cwd: root, model: 'codex:gpt-5.6-sol' });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Work' }] });
  const task = (title, paths) => createTask(root, { title, ...(paths ? { paths } : {}) }, 'user');
  return { directory, root, runtime, runtimes, main: runtimes[0], task };
}

const lead = (task, extra = {}) => ({ agent: 'lead', task, mode: 'workspace-write', model: 'claude:claude-sonnet-4-6', wait: false, ...extra });
const isolatedLead = (task, taskId, extra = {}) => lead(task, { isolation: 'worktree', taskId, ...extra });

test('maxLeads 1: a lead starts beside a reviewer, a second lead is refused as before, and main is told so', async t => {
  const { runtimes, main, task } = await setup(t);
  assert.match(main.config.developerInstructions, /At most 2 peers may run concurrently in this session tree\. /);
  assert.match(main.config.developerInstructions, /One lead runs at a time \(workflow\.maxLeads 1\); it may run beside read-only assignments/);
  const review = await main.call('alp_delegate', { agent: 'reviewer', task: 'Review', mode: 'read-only', model: 'claude:claude-fable-5-1', wait: false });
  assert.equal(review.status, 'running', JSON.stringify(review));
  const first = await main.call('alp_delegate', lead('Build the API'));
  assert.equal(first.status, 'running', JSON.stringify(first));
  // Even isolated, with a task of its own paths, a second lead waits while maxLeads is 1.
  const api = await task('Web', ['web']);
  const second = await main.call('alp_delegate', isolatedLead('Build the web', api.id));
  assert.match(second.error, /A lead is already running \(maxLeads 1\); wait for its handoff, or ask the user to raise workflow\.maxLeads/);
  // A lead's instructions do not offer it leads.
  await until(() => runtimes.length === 3);
  assert.doesNotMatch(runtimes[2].config.developerInstructions, /workflow\.maxLeads/);
});

test('a read-only lead counts toward maxLeads like any other lead', async t => {
  const { main, task } = await setup(t);
  const first = await main.call('alp_delegate', lead('Survey the code', { mode: 'read-only' }));
  assert.equal(first.status, 'running', JSON.stringify(first));
  // maxLeads 1: a second lead is refused, read-only or writing, whatever its task and isolation.
  const api = await task('API', ['api']);
  const readOnly = await main.call('alp_delegate', lead('Survey the API', { mode: 'read-only', taskId: api.id }));
  assert.match(readOnly.error, /A lead is already running \(maxLeads 1\)/);
  const writer = await main.call('alp_delegate', isolatedLead('Build the API', api.id));
  assert.match(writer.error, /A lead is already running \(maxLeads 1\)/);
});

test('maxLeads 2: two isolated leads with separate task paths run together, and main merges both', async t => {
  const { root, runtimes, main, task } = await setup(t, { maxLeads: 2 });
  assert.match(main.config.developerInstructions, /At most 4 peers may run concurrently in this session tree \(2 for each of up to 2 leads\)/);
  assert.match(main.config.developerInstructions, /Up to 2 leads may run at once \(workflow\.maxLeads 2\), only for independent tasks/);
  const api = await task('API', ['api']);
  const web = await task('Web', ['web']);
  // Started together: the checks run without yielding, so both are judged against each other.
  const [first, second] = await Promise.all([
    main.call('alp_delegate', isolatedLead('Build the API', api.id)),
    main.call('alp_delegate', isolatedLead('Build the web', web.id)),
  ]);
  assert.equal(first.status, 'running', JSON.stringify(first));
  assert.equal(second.status, 'running', JSON.stringify(second));
  await until(() => runtimes.length === 3 && runtimes.slice(1).every(runtime => runtime.started.length === 1));
  const leads = runtimes.slice(1);
  assert.notEqual(leads[0].cwd, leads[1].cwd);
  for (const one of leads) assert.ok(!one.cwd.startsWith(root), `${one.cwd} is a worktree`);
  // By brief: the board digest in a lead's prompt can name the other lead's task.
  const byTask = Object.fromEntries(leads.map(one => [one.started[0].params.input.at(-1).text.includes('Build the API') ? 'api' : 'web', one]));
  assert.deepEqual(Object.keys(byTask).sort(), ['api', 'web']);
  await writeFile(path.join(byTask.api.cwd, 'api', 'index.txt'), 'api v2\n');
  await writeFile(path.join(byTask.web.cwd, 'web', 'index.txt'), 'web v2\n');
  for (const one of leads) one.finish();
  const done = [];
  for (let call = 0; done.length < 2; call++) {
    const { events } = await main.call('alp_wait', { timeoutMs: 2000 });
    done.push(...events.filter(event => event.kind === 'result').map(event => event.result));
  }
  // One merge at a time, as main's guidance says.
  for (const result of done) {
    const merged = await main.call('alp_merge', { assignmentId: result.sessionId });
    assert.equal(merged.status, 'applied', JSON.stringify(merged));
  }
  assert.equal(await readFile(path.join(root, 'api', 'index.txt'), 'utf8'), 'api v2\n');
  assert.equal(await readFile(path.join(root, 'web', 'index.txt'), 'utf8'), 'web v2\n');
});

test('maxLeads 2: a second lead in the shared checkout, or beside a shared-checkout lead, is refused', async t => {
  const { main, task } = await setup(t, { maxLeads: 2 });
  const api = await task('API', ['api']);
  const web = await task('Web', ['web']);
  const first = await main.call('alp_delegate', isolatedLead('Build the API', api.id));
  assert.equal(first.status, 'running', JSON.stringify(first));
  const shared = await main.call('alp_delegate', lead('Build the web', { taskId: web.id }));
  assert.match(shared.error, /Another lead is running; a second lead needs isolation "worktree" and a taskId with its own paths \(maxLeads 2\)/);
  await main.call('alp_cancel', { assignmentId: first.assignmentId });

  // The other way round: the running lead writes the shared checkout.
  const sharedFirst = await main.call('alp_delegate', lead('Build the API in place'));
  assert.equal(sharedFirst.status, 'running', JSON.stringify(sharedFirst));
  const beside = await main.call('alp_delegate', isolatedLead('Build the web', web.id));
  assert.match(beside.error, /Another lead is running; a second lead needs isolation "worktree"/);
});

test('maxLeads 2: overlapping paths, a missing taskId, a task without paths, or a first lead without one are refused', async t => {
  const { main, task } = await setup(t, { maxLeads: 2 });
  const api = await task('API', ['api']);
  const apiRoutes = await task('API routes', ['api/routes']);
  const bare = await task('Something');
  const first = await main.call('alp_delegate', isolatedLead('Build the API', api.id));
  assert.equal(first.status, 'running', JSON.stringify(first));
  const overlap = await main.call('alp_delegate', isolatedLead('Build the routes', apiRoutes.id));
  assert.match(overlap.error, new RegExp(`Task ${apiRoutes.id} overlaps the task of lead ${first.assignmentId} on api/routes; parallel leads need independent tasks`));
  const noTask = await main.call('alp_delegate', lead('Build the web', { isolation: 'worktree' }));
  assert.match(noTask.error, /a second lead needs isolation "worktree" and a taskId with its own paths/);
  const noPaths = await main.call('alp_delegate', isolatedLead('Do something', bare.id));
  assert.match(noPaths.error, new RegExp(`Task ${bare.id} declares no paths; a lead beside another lead needs a task with paths`));
  await main.call('alp_cancel', { assignmentId: first.assignmentId });

  // A running lead without a task of its own paths cannot be told apart from a new one.
  const untasked = await main.call('alp_delegate', lead('Explore', { isolation: 'worktree' }));
  assert.equal(untasked.status, 'running', JSON.stringify(untasked));
  const web = await task('Web', ['web']);
  const refused = await main.call('alp_delegate', isolatedLead('Build the web', web.id));
  assert.match(refused.error, new RegExp(`lead ${untasked.assignmentId} runs without a task of its own paths`));
});

test('maxLeads 2: two leads with overlapping tasks started together: exactly one runs', async t => {
  const { main, task } = await setup(t, { maxLeads: 2 });
  const api = await task('API', ['api']);
  const apiRoutes = await task('API routes', ['api/routes']);
  // Neither has pinned its claim yet when the other is judged: the task paths are compared without yielding.
  const answers = await Promise.all([
    main.call('alp_delegate', isolatedLead('Build the API', api.id)),
    main.call('alp_delegate', isolatedLead('Build the routes', apiRoutes.id)),
  ]);
  assert.equal(answers.filter(answer => answer.status === 'running').length, 1, JSON.stringify(answers));
  assert.match(answers.find(answer => answer.error).error, /overlaps the task of lead .* parallel leads need independent tasks/);
});

test('maxLeads 2: a third lead is refused, a parked lead still counts, and alp_cancel frees its place', async t => {
  const { runtime, runtimes, main, task } = await setup(t, { maxLeads: 2 });
  const api = await task('API', ['api']);
  const web = await task('Web', ['web']);
  const docs = await task('Docs', ['docs']);
  // The first lead runs on Codex, so a Codex usage limit parks it.
  const parked = await main.call('alp_delegate', isolatedLead('Build the API', api.id, { model: 'codex:gpt-6-astra' }));
  assert.equal(parked.status, 'running', JSON.stringify(parked));
  await until(() => runtimes.length === 2 && runtimes[1].started.length === 1);
  runtimes[1].limit();
  await until(() => runtime.pauses().parked.length === 1);
  // A refusal because of the parked lead names alp_cancel.
  const apiRoutes = await task('API routes', ['api/routes']);
  const overlap = await main.call('alp_delegate', isolatedLead('Build the routes', apiRoutes.id));
  assert.match(overlap.error, /overlaps the task of lead/);
  assert.match(overlap.next, new RegExp(`lead ${parked.assignmentId} is parked; to go on without it, stop it with alp_cancel`));
  const second = await main.call('alp_delegate', isolatedLead('Build the web', web.id));
  assert.equal(second.status, 'running', JSON.stringify(second));
  const third = await main.call('alp_delegate', isolatedLead('Write the docs', docs.id));
  assert.match(third.error, /Lead limit reached: 2 leads are already running or parked \(maxLeads 2\); wait for a handoff, or ask the user to raise workflow\.maxLeads/);
  assert.match(third.next, new RegExp(`lead ${parked.assignmentId} is parked; to go on without it, stop it with alp_cancel`));
  const canceled = await main.call('alp_cancel', { assignmentId: parked.assignmentId });
  assert.equal(canceled.status, 'canceled', JSON.stringify(canceled));
  const now = await main.call('alp_delegate', isolatedLead('Write the docs', docs.id));
  assert.equal(now.status, 'running', JSON.stringify(now));
});

test('the session tree runs maxPeers × maxLeads peers', async t => {
  const { runtimes, main, task } = await setup(t, { maxPeers: 1, maxLeads: 2 });
  const api = await task('API', ['api']);
  await main.call('alp_delegate', isolatedLead('Build the API', api.id));
  await until(() => runtimes[1]?.started.length === 1);
  const first = runtimes[1];
  const look = n => first.call('alp_delegate', { agent: 'peer', task: `Look ${n}`, mode: 'read-only', model: 'claude:claude-sonnet-4-6', wait: false });
  assert.equal((await look(1)).status, 'running');
  assert.equal((await look(2)).status, 'running');
  assert.match((await look(3)).error, /Concurrent peer limit reached \(2 in this session tree\)/);
});

test('workflow.maxLeads is a positive integer in settings and teams, and a resumed session keeps its own', async t => {
  for (const maxLeads of [0, -1, 1.5, '2']) {
    assert.throws(() => validateSettings({ workflow: { maxLeads } }, 'settings'), /workflow\.maxLeads must be a positive integer/);
  }
  validateSettings({ workflow: { mode: 'cafe', maxLeads: 3 } }, 'settings');
  const team = { label: 'T', main: 'main', members: { main: {}, lead: { role: 'lead' } }, delegation: { main: ['lead'] } };
  assert.throws(() => validateTeam({ ...team, maxLeads: 0 }, 'team'), /maxLeads must be a positive integer/);
  validateTeam({ ...team, maxLeads: 2 }, 'team');

  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-max-leads-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'project');
  await initProject(root);
  const settings = maxLeads => writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ workflow: { mode: 'cafe', ...(maxLeads ? { maxLeads } : {}) } }));
  await settings();
  assert.equal((await resolveWorkflow(root, undefined, undefined, { library: path.join(directory, 'home') })).maxLeads, 1);
  await settings(3);
  const fresh = await resolveWorkflow(root, undefined, undefined, { library: path.join(directory, 'home') });
  assert.equal(fresh.maxLeads, 3);
  // settings changed since: the resumed session keeps the number it started with.
  await settings(1);
  const { team: _team, ...saved } = fresh;
  assert.equal((await resolveWorkflow(root, undefined, saved, { library: path.join(directory, 'home') })).maxLeads, 3);
});
