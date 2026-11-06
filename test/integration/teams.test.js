import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { initProject } from '../../packages/core/src/init.js';
import { listTeams, resolveTeam } from '../../packages/core/src/teams.js';
import { createAlpRuntime } from '../../dist/runtime/index.js';
import { createProvider } from '../../integrations/paseo/server/dist/index.js';
import { PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';
import { teardown } from '../support/teardown.js';
import { templateText } from '../support/template-text.js';

// The user library is $ALP_HOME (default ~/.alp), read when a session resolves its team and
// providers. Give this file an empty library of its own, so it never reads the user's real one
// whether or not a runner (scripts/test.mjs) already isolated ALP_HOME.
const previousHome = process.env.ALP_HOME;
let isolatedHome;
before(async () => { isolatedHome = await mkdtemp(path.join(tmpdir(), 'alp-teams-home-')); process.env.ALP_HOME = isolatedHome; });
after(async () => {
  if (previousHome === undefined) delete process.env.ALP_HOME; else process.env.ALP_HOME = previousHome;
  if (isolatedHome) await rm(isolatedHome, { recursive: true, force: true });
});

// Each team's house rules, as shipped: the runtime prints them after the profile line. A custom
// graph has no team of its own and falls back to Phở's (packages/runtime/src/resolve.ts).
const HOUSE_RULES = mode => `Profile: ${mode}; fixed for this session. ${templateText(`teams/${mode === 'custom' ? 'pho' : mode}/HOUSE_RULES.md`).trim()}`;

async function fixture(t) {
  const defer = teardown(t);
  const root = await mkdtemp(path.join(tmpdir(), 'alp-teams-'));
  defer(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function files(root, entries) {
  for (const [name, content] of Object.entries(entries)) {
    const file = path.join(root, name);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content));
  }
}
async function until(check) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Expected condition did not arrive');
}
function fakeTransport(runtimes) {
  return (cwd, env, kind) => {
    const index = runtimes.length;
    const runtime = {
      kind, calls: [], threadId: `thread-${index}`,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() { this.closed = true; },
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') return { turn: { id: `turn-${index}` } };
        return {};
      },
      get config() { return this.calls.find(call => call.method === 'thread/start').params; },
    };
    runtimes.push(runtime);
    return runtime;
  };
}
async function session(t, root, spec, options = {}) {
  const runtimes = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), runLogDir: path.join(root, '.runs'), ...options });
  teardown(t)(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, ...spec });
  return { runtime, runtimes };
}

const docsTeam = {
  label: 'Docs', description: 'An architect plans; writers write.', main: 'architect',
  members: { architect: { model: 'claude:claude-sonnet-5-5', thinking: 'low' }, writer: { role: 'peer' }, reviewer: { role: 'reviewer' } },
  delegation: { architect: ['writer', 'reviewer'] }, maxPeers: 3,
  supervisor: { agent: 'watcher', model: 'codex:gpt-6-sol', thinking: 'low' },
};

test('Phở and Cafe each give main their own house rules, and a custom graph gets Phở\'s', async t => {
  // R6/D2 of the architecture review: each team's rules describe that team, not both.
  assert.match(templateText('teams/pho/HOUSE_RULES.md'), /Phở \(pho\)/);
  assert.doesNotMatch(templateText('teams/pho/HOUSE_RULES.md'), /Cafe|cafe/);
  assert.match(templateText('teams/cafe/HOUSE_RULES.md'), /Cafe \(cafe\)/);
  assert.doesNotMatch(templateText('teams/cafe/HOUSE_RULES.md'), /Phở|pho\b/);
  for (const mode of ['pho', 'cafe', undefined]) {
    const root = await fixture(t);
    await initProject(root);
    if (!mode) await files(root, { '.alp/settings.json': { delegation: { main: ['peer'] } } });
    const { runtimes } = await session(t, root, mode ? { workflow: mode } : {}, { supervisor: false });
    const instructions = runtimes[0].config.developerInstructions;
    assert.ok(instructions.includes(`\n\n${HOUSE_RULES(mode ?? 'custom')}\n\n`), instructions);
    // Main still runs on Opus 5.5 with high effort, in a team or a custom graph.
    assert.deepEqual([runtimes[0].kind, runtimes[0].config.model, runtimes[0].config.thinking], ['claude', 'claude-opus-5-5', 'high']);
  }
});

test('session.preview names the team, main and model session.create runs, from one resolution (t-5586)', async t => {
  const ran = snapshot => ({ team: snapshot.workflow.mode, teamLabel: snapshot.teamLabel, agent: snapshot.agent, runtime: snapshot.runtime, model: snapshot.model, mode: snapshot.mode, thinking: snapshot.thinking });
  const cases = [
    // A folder without settings: init writes settings naming Phở before the session runs.
    ['no workflow, no settings', {}, {}, 'pho'],
    // Settings without workflow.mode: the custom graph of settings' delegation, not Phở.
    ['no workflow, settings without workflow.mode', { '.alp/settings.json': { delegation: { main: ['peer'] } } }, {}, 'custom'],
    ['no workflow, settings name cafe', { '.alp/settings.json': { workflow: { mode: 'cafe' } } }, {}, 'cafe'],
    ['explicit workflow over settings', { '.alp/settings.json': { workflow: { mode: 'cafe' } } }, { workflow: 'pho' }, 'pho'],
    ['explicit workflow, no settings', {}, { workflow: 'smart' }, 'pho'],
  ];
  for (const [name, entries, spec, team] of cases) {
    const root = await fixture(t);
    await files(root, entries);
    const runtimes = [];
    const runtime = createAlpRuntime({ transport: fakeTransport(runtimes), runLogDir: path.join(root, '.runs'), supervisor: false });
    teardown(t)(() => runtime.shutdown());
    const settingsBefore = await readFile(path.join(root, '.alp/settings.json'), 'utf8').catch(() => undefined);
    const { teams, ...preview } = await runtime.preview({ cwd: root, ...spec });
    // A preview writes nothing.
    assert.equal(await readFile(path.join(root, '.alp/settings.json'), 'utf8').catch(() => undefined), settingsBefore, name);
    assert.ok(teams.length > 0, name);
    assert.equal(preview.team, team, name);
    // A client sends back the team the preview named, as the ACP agent and apps/web do; without one it is the same session.
    for (const [index, sent] of [{ ...spec }, { ...spec, workflow: preview.team }].entries()) {
      const id = `root-${index}`;
      const opened = await runtime.open(id, { cwd: root, ...sent });
      assert.deepEqual(JSON.parse(JSON.stringify(ran(opened))), preview, `${name} (${index ? 'team sent back' : 'as previewed'})`);
      assert.equal(runtimes.at(-1).kind, preview.runtime, name);
      assert.equal(runtimes.at(-1).config.model, preview.model, name);
      await runtime.close(id);
    }
  }
  // `custom` may be sent only when it is what would run anyway.
  const root = await fixture(t);
  await files(root, { '.alp/settings.json': { workflow: { mode: 'pho' } } });
  const runtime = createAlpRuntime({ transport: fakeTransport([]), runLogDir: path.join(root, '.runs'), supervisor: false });
  teardown(t)(() => runtime.shutdown());
  await assert.rejects(runtime.preview({ cwd: root, workflow: 'custom' }), /Choose a team/);
  await assert.rejects(runtime.open('root', { cwd: root, workflow: 'custom' }), /Choose a team/);
});

test('teams come from the built-ins, then the library, then the project, and are checked', async t => {
  const [root, library] = [await fixture(t), await fixture(t)];
  await files(library, { 'teams/pho/team.json': { ...docsTeam, label: 'My Phở' }, 'teams/pho/HOUSE_RULES.md': 'Library rules\n', 'teams/docs/team.json': docsTeam, 'teams/draft/notes.md': 'not a team' });
  await files(root, { '.alp/teams/docs/team.json': { ...docsTeam, label: 'Project docs' } });
  assert.deepEqual((await listTeams(root, { library })).map(row => [row.id, row.source, row.label, row.overrides]), [
    ['cafe', 'builtin', 'Cafe', undefined], ['pho', 'library', 'My Phở', 'builtin'], ['docs', 'project', 'Project docs', 'library'],
  ]);
  assert.deepEqual((await listTeams(undefined, {})).map(row => row.id), ['pho', 'cafe']);
  const pho = await resolveTeam(root, 'smart', { library });
  assert.deepEqual([pho.id, pho.main, pho.houseRules], ['pho', 'architect', 'Library rules']);
  await assert.rejects(resolveTeam(root, 'absent', { library }), /Team 'absent' not found; teams: pho, cafe, docs/);
  const broken = async (change, pattern) => {
    await files(root, { '.alp/teams/bad/team.json': { ...docsTeam, ...change } });
    await assert.rejects(resolveTeam(root, 'bad'), error => error.code === 'INVALID_TEAM' && pattern.test(error.message) && error.message.includes(path.join('.alp', 'teams', 'bad', 'team.json')));
  };
  await broken({ delegation: { architect: ['writer'], writer: ['reviewer'], reviewer: ['writer'] } }, /delegation cycle/);
  await broken({ delegation: { architect: ['stranger'] } }, /stranger is not a member/);
  await broken({ delegation: { writer: ['architect'] } }, /architect is not a member main can be assigned to/);
  await broken({ main: 'boss' }, /members must include main \(boss\)/);
  await broken({ members: { ...docsTeam.members, writer: { role: 'coder' } } }, /members\.writer\.role must be one of lead, peer, advisor, reviewer/);
  await broken({ members: { ...docsTeam.members, writer: { role: 'peer', thinkng: 'x' } } }, /members\.writer: unknown setting 'thinkng'; did you mean 'thinking'\?/);
  await broken({ supervisor: { agent: 'writer' } }, /cannot be a member/);
  await broken({ maxPers: 2 }, /did you mean 'maxPeers'/);
  await files(root, { '.alp/teams/bad/team.json': '{' });
  await assert.rejects(resolveTeam(root, 'bad'), { code: 'INVALID_TEAM' });
});

test('a team of your own: its main leads with the team graph, models and house rules, and its supervisor watches', async t => {
  const root = await fixture(t);
  await initProject(root);
  await files(root, {
    '.alp/teams/docs/team.json': docsTeam,
    '.alp/teams/docs/HOUSE_RULES.md': 'Docs rules: every page gets a reviewer.\n',
    '.alp/agents/architect/AGENT.md': 'Architect',
    // The team chooses the architect's model over its own.
    '.alp/agents/architect/agent.json': { provider: 'codex', model: 'gpt-6-sol', thinking: 'max' },
    '.alp/agents/writer/AGENT.md': 'Writer',
    '.alp/agents/watcher/AGENT.md': 'Watcher',
  });
  const { runtimes } = await session(t, root, { workflow: 'docs', agent: 'architect' });
  const main = runtimes[0].config;
  assert.deepEqual([runtimes[0].kind, main.model, main.thinking, main.sandbox], ['claude', 'claude-sonnet-5-5', 'low', 'full-access']);
  assert.match(main.developerInstructions, /Profile: docs; fixed for this session\. Docs rules: every page gets a reviewer\./);
  assert.match(main.developerInstructions, /ALP runtime identity: architect\. Use alp_delegate to assign bounded work to: writer, reviewer\./);
  assert.match(main.developerInstructions, /At most 3 peers may run concurrently/);
  // As the team's main, the architect manages tasks and files issues.
  assert.ok(main.dynamicTools.some(tool => tool.name === 'alp_issue'));
  assert.ok(main.dynamicTools.find(tool => tool.name === 'alp_task').inputSchema.properties.action.enum.includes('create'));
  await until(() => runtimes.length === 2 && runtimes[1].calls.some(call => call.method === 'thread/start'));
  const watcher = runtimes[1].config;
  assert.deepEqual([runtimes[1].kind, watcher.model, watcher.thinking, watcher.sandbox], ['codex', 'gpt-6-sol', 'low', 'read-only']);
  assert.match(watcher.developerInstructions, /Watcher[\s\S]*supervisor of architect/);
});

// R5/E3 of docs/alp/architecture-review-templates-scopes-model-routing.md: the oracle paragraph is
// printed only to an agent that can delegate to oracle, and "two independent opinions" only when the
// team has more than one oracle model. The usage sentence that shared the line stays for everyone.
test('the oracle paragraph appears only where oracle is a delegation target, and two opinions only with two models', async t => {
  const oracleLine = /Oracle runs on /;
  const twoOpinions = /For two independent opinions/;
  const usage = /Usage context is advisory, may be unavailable or stale/;
  // A team without an oracle member (like the architecture pack's Blueprint).
  const root = await fixture(t);
  await initProject(root);
  await files(root, {
    '.alp/teams/docs/team.json': docsTeam,
    '.alp/agents/architect/AGENT.md': 'Architect',
    '.alp/agents/writer/AGENT.md': 'Writer',
    '.alp/agents/watcher/AGENT.md': 'Watcher',
  });
  let { runtimes } = await session(t, root, { workflow: 'docs', agent: 'architect' }, { supervisor: false });
  let config = runtimes[0].config;
  assert.doesNotMatch(config.developerInstructions, oracleLine);
  assert.match(config.developerInstructions, usage);
  assert.doesNotMatch(config.dynamicTools.find(tool => tool.name === 'alp_delegate').inputSchema.properties.model.description, /Oracle:/);
  // The same team with an oracle and one oracle model: the line, without the two-opinions advice.
  const single = await fixture(t);
  await initProject(single);
  await files(single, {
    '.alp/teams/docs/team.json': { ...docsTeam, members: { ...docsTeam.members, oracle: { role: 'advisor' } }, delegation: { architect: ['writer', 'oracle', 'reviewer'] }, oracleModels: ['codex:gpt-6-astra'] },
    '.alp/agents/architect/AGENT.md': 'Architect',
    '.alp/agents/writer/AGENT.md': 'Writer',
  });
  ({ runtimes } = await session(t, single, { workflow: 'docs', agent: 'architect' }, { supervisor: false }));
  config = runtimes[0].config;
  assert.match(config.developerInstructions, /Oracle runs on codex:gpt-6-astra; pass one as model/);
  assert.doesNotMatch(config.developerInstructions, twoOpinions);
  assert.match(config.developerInstructions, usage);
  // Phở's main delegates to oracle on two models: both sentences, as before.
  const pho = await fixture(t);
  await initProject(pho);
  ({ runtimes } = await session(t, pho, { workflow: 'pho' }, { supervisor: false }));
  config = runtimes[0].config;
  assert.match(config.developerInstructions, oracleLine);
  assert.match(config.developerInstructions, twoOpinions);
  assert.match(config.developerInstructions, usage);
  assert.match(config.dynamicTools.find(tool => tool.name === 'alp_delegate').inputSchema.properties.model.description, /Oracle: /);
});

test('settings.json runtime still comes before a team, and the caller before both', async t => {
  const root = await fixture(t);
  await initProject(root);
  await files(root, { '.alp/settings.json': { workflow: { mode: 'pho', supervisor: false }, runtime: { provider: 'codex', model: 'gpt-6-sol', reasoning: 'low' } } });
  let { runtimes } = await session(t, root, {});
  assert.deepEqual([runtimes[0].kind, runtimes[0].config.model, runtimes[0].config.thinking], ['codex', 'gpt-6-sol', 'low']);
  await files(root, { '.alp/settings.json': { workflow: { mode: 'pho', supervisor: false } } });
  ({ runtimes } = await session(t, root, { model: 'codex:gpt-6.1-sol', thinking: 'medium' }));
  assert.deepEqual([runtimes[0].kind, runtimes[0].config.model, runtimes[0].config.thinking], ['codex', 'gpt-6.1-sol', 'medium']);
});

test('Paseo offers every team the project can use, and alp teams lists them', async t => {
  const [root, home] = [await fixture(t), await fixture(t)];
  await initProject(root);
  await files(home, { 'teams/review/team.json': { ...docsTeam, label: 'Review' } });
  await files(root, { '.alp/teams/docs/team.json': docsTeam, '.alp/teams/broken/team.json': '{' });
  const previous = process.env.ALP_HOME;
  process.env.ALP_HOME = home;
  const defer = teardown(t);
  defer(() => { if (previous === undefined) delete process.env.ALP_HOME; else process.env.ALP_HOME = previous; });
  const conn = await createProvider({ transport: fakeTransport([]) }).connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  defer(() => conn.close());
  const events = [];
  conn.onEvent(event => events.push(event));
  await conn.send({ type: 'catalog', requestId: 'c', cwd: root });
  assert.deepEqual(events[0].catalog.models.map(model => [model.id, model.label]), [['pho', 'Phở'], ['cafe', 'Cafe'], ['review', 'Review'], ['docs', 'Docs']]);
  assert.equal(events[0].catalog.defaultModel, 'pho');
  const cli = fileURLToPath(new URL('../../packages/cli/src/cli.js', import.meta.url));
  const listed = spawnSync(process.execPath, [cli, 'teams', '--project', root], { encoding: 'utf8', env: { ...process.env, ALP_HOME: home } });
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /^docs {2}Docs {2}project$/m);
  assert.match(listed.stdout, /members: architect \(main\) on claude:claude-sonnet-5-5, low, writer \(peer\), reviewer \(reviewer\)/);
  assert.match(listed.stdout, /delegation: architect → writer, reviewer/);
  assert.match(listed.stdout, /^broken {2} {2}project\n {2}error: /m);
});
