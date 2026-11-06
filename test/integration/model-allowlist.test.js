import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { seedLibrary } from '@anhlp/alp-core/library';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { fakeTransport, until } from '../support/fake-agent.js';
import { teardown } from '../support/teardown.js';

/**
 * A target's model profiles are its allowlist, for one profile as for several (P2 of
 * docs/alp/architecture-review-templates-scopes-model-routing.md). Before, a target with one named
 * profile took any runtime-prefixed model at any effort, while its coordinator's instructions said a
 * model outside its profiles is refused.
 *
 * Reaches main and lead (they lose passing a model outside a target's profiles). From their side:
 * a normal delegation to each configured target still starts on the model its profiles name, and a
 * wrong model is refused with the allowed ones named.
 */
const PEER = 'claude:claude-sonnet-5';
const REVIEWER = ['claude:claude-sonnet-5:high', 'codex:gpt-6-sol:low', 'claude:sonnet'];

async function setup(t, profiles = { peer: { profiles: [`${PEER}:medium`] }, reviewer: { profiles: REVIEWER } }, { custom = false, team = 'pho', teamJson, settings } = {}) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-allowlist-'));
  // defer runs in reverse: the directory, registered first, goes after the runtime has shut down.
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  const library = path.join(directory, 'home');
  // teamJson: a team of the project's own, in .alp/teams/<team>/team.json.
  if (teamJson) {
    await mkdir(path.join(root, '.alp', 'teams', team), { recursive: true });
    await writeFile(path.join(root, '.alp', 'teams', team, 'team.json'), JSON.stringify(teamJson));
  }
  await initProject(root);
  await seedLibrary(library);
  // settings: a function of the project root that prepares the project's settings itself (alp init, alp setup).
  if (settings) await settings({ root, library });
  // custom: a delegation graph of the project's own, which has no team and so no model profiles.
  else await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify(custom
    ? { defaultAgent: 'main', delegation: { main: ['peer'] } }
    : { defaultAgent: 'main', workflow: { mode: team, supervisor: false }, team: { [team]: profiles } }));
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), supervisor: false, libraryDir: library, runLogDir: path.join(directory, 'runs') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, ...(custom ? {} : { workflow: team }) });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Go' }] });
  const main = agents[0];
  /** Delegates read-only (so assignments never wait on the shared checkout's one writer) and returns the answer. */
  const delegate = args => main.call('alp_delegate', { task: 'Look at it', mode: 'read-only', wait: false, ...args });
  /** The model the child of a started assignment was given. */
  const startedOn = async answer => {
    assert.equal(answer.status, 'running', JSON.stringify(answer));
    await until(() => runtime.snapshot(answer.assignmentId)?.model, `${answer.assignmentId} started`);
    return runtime.snapshot(answer.assignmentId).model;
  };
  return { runtime, agents, main, delegate, startedOn };
}

test('one named profile is the only model a target takes; a wrong one is refused naming it', async t => {
  const { delegate, startedOn } = await setup(t);
  // (1) Another runtime's model, and another model of the same runtime: refused, naming the profile.
  for (const model of ['codex:gpt-6-sol', 'claude:claude-opus-5-5']) {
    const refused = await delegate({ agent: 'peer', model, thinking: 'low' });
    assert.match(refused.error ?? '', new RegExp(`${model} is not one of peer's model profiles in team pho; pass ${PEER}, or omit model`), JSON.stringify(refused));
    assert.deepEqual(refused.models, [PEER]);
  }
  // The refusal alone is enough to fix it: the settings key with the team id, the file, the
  // wildcard grammar, and the CLI command that writes both providers for Phở and Cafe.
  const refused = await delegate({ agent: 'peer', model: 'codex:gpt-6-sol' });
  assert.match(refused.error, /The user can allow it by adding it to team\.pho\.peer\.profiles in \S+[\\/]\.alp[\\/]settings\.json/);
  assert.match(refused.error, /"codex:\*" for any model of that provider/);
  assert.match(refused.error, /or run alp setup \S+ --runtime mix/);
  // (2) Its configured model, named or omitted, starts on that model.
  assert.match(await startedOn(await delegate({ agent: 'peer' })), /claude-sonnet-5/);
  assert.match(await startedOn(await delegate({ agent: 'peer', model: PEER, thinking: 'high' })), /claude-sonnet-5/);
  // Its effort is checked against the model's, as it already was for a choice among several.
  const effort = await delegate({ agent: 'peer', model: PEER, thinking: 'ludicrous' });
  assert.match(effort.error ?? '', /claude:claude-sonnet-5 takes effort .*high/, JSON.stringify(effort));
});

test('in Cafe, main to lead and lead to peer follow the same allowlist', async t => {
  const { agents, delegate, startedOn } = await setup(t, { lead: { profiles: [`${PEER}:medium`] }, peer: { profiles: ['codex:gpt-6-sol:low'] } }, { team: 'cafe' });
  // main → lead: a wrong model is refused naming Cafe, lead and its profile; its own starts.
  const refused = await delegate({ agent: 'lead', model: 'codex:gpt-6-sol' });
  assert.match(refused.error ?? '', /codex:gpt-6-sol is not one of lead's model profiles in team cafe; pass claude:claude-sonnet-5, or omit model[\s\S]*team\.cafe\.lead\.profiles/, JSON.stringify(refused));
  const started = await delegate({ agent: 'lead' });
  assert.match(await startedOn(started), /claude-sonnet-5/);
  // lead → peer, from lead's own session.
  await until(() => agents.at(-1).turnId, 'lead\'s turn');
  const lead = agents.at(-1);
  const wrong = await lead.call('alp_delegate', { agent: 'peer', task: 'Look', mode: 'read-only', model: 'claude:claude-opus-5-5', wait: false });
  assert.match(wrong.error ?? '', /claude:claude-opus-5-5 is not one of peer's model profiles in team cafe; pass codex:gpt-6-sol/, JSON.stringify(wrong));
  assert.match(await startedOn(await lead.call('alp_delegate', { agent: 'peer', task: 'Look', mode: 'read-only', wait: false })), /gpt-6-sol/);
});

test('several profiles and oracle refuse and accept as before', async t => {
  const { delegate, startedOn } = await setup(t);
  // (3) Several profiles: a choice is required, a model outside them is refused, a listed one starts.
  const unchosen = await delegate({ agent: 'reviewer' });
  assert.match(unchosen.error ?? '', /reviewer has several model profiles: choose one/);
  assert.deepEqual(unchosen.models, ['claude:claude-sonnet-5', 'codex:gpt-6-sol', 'claude:sonnet']);
  const outside = await delegate({ agent: 'reviewer', model: 'codex:gpt-6.1-sol', thinking: 'low' });
  assert.match(outside.error ?? '', /codex:gpt-6\.1-sol is not one of reviewer's model profiles in team pho; pass claude:claude-sonnet-5 or codex:gpt-6-sol or claude:sonnet\. The user can allow it/);
  assert.match((await delegate({ agent: 'reviewer', model: 'codex:gpt-6-sol', thinking: 'medium-ish' })).error ?? '', /codex:gpt-6-sol takes effort low, medium/);
  assert.match(await startedOn(await delegate({ agent: 'reviewer', model: 'codex:gpt-6-sol', thinking: 'low' })), /gpt-6-sol/);
  // (4) Oracle keeps its own list: a model is required and must be an oracle model.
  const oracle = await delegate({ agent: 'oracle' });
  assert.match(oracle.error ?? '', /Oracle runs on .*; pass one as model/);
  // Oracle's refusal is its own: it never names another target's profiles.
  assert.doesNotMatch(oracle.error, /model profiles|claude-sonnet-5/);
  assert.equal(oracle.models, undefined);
  assert.match((await delegate({ agent: 'oracle', model: 'claude:claude-sonnet-5' })).error ?? '', /Oracle runs on /);
  assert.match(await startedOn(await delegate({ agent: 'oracle', model: 'codex:gpt-6-astra' })), /gpt-6-astra/);
});

test('an effort ALP cannot check is passed on, and the answer says it was not checked', async t => {
  const { delegate, startedOn } = await setup(t);
  // (5) claude:sonnet is an alias the catalog lists without efforts: accepted, never silently.
  const answer = await delegate({ agent: 'reviewer', model: 'claude:sonnet', thinking: 'high' });
  assert.match(answer.thinkingNote ?? '', /effort high was not checked: ALP does not know which efforts claude:sonnet takes/, JSON.stringify(answer));
  assert.match(await startedOn(answer), /sonnet/);
  // A checked effort carries no such note.
  assert.equal((await delegate({ agent: 'reviewer', model: 'codex:gpt-6-sol', thinking: 'low' })).thinkingNote, undefined);
});

test('a target with no model profiles takes any model, as before; its effort is reported unchecked', async t => {
  // A custom delegation graph has no team, so settings hold no profiles for its peer. (A team's
  // members always have some: every session open writes the team's managed profiles.)
  const { delegate, startedOn } = await setup(t, undefined, { custom: true });
  // No model: the requester's own, as before (runtime.ts falls through to session.runtimeKind:mapping.model).
  assert.match(await startedOn(await delegate({ agent: 'peer' })), /claude-opus-5-5/);
  // Any runtime-prefixed model: an empty profile list means no restriction, not nothing allowed.
  const codex = await delegate({ agent: 'peer', model: 'codex:gpt-6-sol', thinking: 'low' });
  assert.match(codex.thinkingNote ?? '', /effort low was not checked: no model profile of peer names a model/, JSON.stringify(codex));
  assert.match(await startedOn(codex), /gpt-6-sol/);
});

test('a provider:* profile still takes any model of that provider, chosen with its effort', async t => {
  const { delegate, startedOn } = await setup(t, { peer: { profiles: ['codex:*'] } });
  assert.match((await delegate({ agent: 'peer' })).error ?? '', /peer has several model profiles: choose one .* Pass any codex: model/);
  const claude = await delegate({ agent: 'peer', model: 'claude:claude-opus-5-5', thinking: 'high' });
  assert.match(claude.error ?? '', /claude:claude-opus-5-5 is not one of peer's model profiles in team pho; pass any codex: model\. /);
  assert.match((await delegate({ agent: 'peer', model: 'codex:gpt-6-astra', thinking: 'high' })).error ?? '', /codex:gpt-6-astra takes effort low/);
  assert.match(await startedOn(await delegate({ agent: 'peer', model: 'codex:gpt-6.1-sol', thinking: 'low' })), /gpt-6\.1-sol/);
});

test('an antigravity: profile starts, and the answer says its effort was not checked', async t => {
  const { delegate, startedOn } = await setup(t, { reviewer: { profiles: ['antigravity:gemini-3.8-flash-high', `${PEER}:high`] } });
  const answer = await delegate({ agent: 'reviewer', model: 'antigravity:gemini-3.8-flash-high', thinking: 'high' });
  assert.match(answer.thinkingNote ?? '', /effort high was not checked: ALP does not know which efforts antigravity:gemini-3\.8-flash-high takes/, JSON.stringify(answer));
  assert.ok(await startedOn(answer));
});

test('a paused runtime: the hint offers only a model the target\'s profiles contain', async t => {
  const { runtime, delegate } = await setup(t);
  await runtime.pause({ runtime: 'claude' });
  // peer has no Codex profile, so passing a Codex model would be refused: the hint says wait.
  const peer = await delegate({ agent: 'peer' });
  assert.match(peer.next ?? '', /None of peer's model profiles runs on .*: wait/, JSON.stringify(peer));
  // reviewer has one: the hint names it.
  const reviewer = await delegate({ agent: 'reviewer', model: 'claude:claude-sonnet-5', thinking: 'high' });
  assert.match(reviewer.next ?? '', /Pass codex:gpt-6-sol to run it on .*, or wait/, JSON.stringify(reviewer));
});

test('the coordinator is told one rule: the profiles are the allowlist', async t => {
  const { main } = await setup(t);
  const instructions = main.config.developerInstructions;
  assert.match(instructions, /Model profiles of your targets are the models you may pass for them; a model outside them is refused/);
  assert.doesNotMatch(instructions, /unless you pass another model/);
  assert.match(instructions, /peer: claude:claude-sonnet-5 \(effort medium\)/);
});

test('the refusal offers alp setup only where it helps: Phở or Cafe, and a Claude or Codex model', async t => {
  const { delegate } = await setup(t);
  // setup writes no Antigravity or ACP model, so it is not offered for one; the settings key still is.
  const antigravity = await delegate({ agent: 'peer', model: 'antigravity:gemini-3.8-flash-high' });
  assert.match(antigravity.error ?? '', /team\.pho\.peer\.profiles in \S+[\\/]\.alp[\\/]settings\.json/, JSON.stringify(antigravity));
  assert.match(antigravity.error, /"antigravity:\*" for any model of that provider/);
  assert.doesNotMatch(antigravity.error, /alp setup/);
  // For a Codex model in Phở it is, and says it keeps lists written by hand.
  const codex = await delegate({ agent: 'peer', model: 'codex:gpt-6-sol' });
  assert.match(codex.error ?? '', /or run alp setup \S+ --runtime mix, which gives Phở's and Cafe's members both Claude and Codex profiles \(it keeps profiles written by hand\)\./, JSON.stringify(codex));
});

test('in a team of the project\'s own, the refusal names its settings key and never alp setup', async t => {
  const teamJson = { label: 'Review', main: 'main', members: { main: { model: 'claude:claude-opus-5-5', thinking: 'high' }, peer: { role: 'peer', model: 'claude:claude-sonnet-5', thinking: 'medium' } }, delegation: { main: ['peer'] } };
  const { delegate, startedOn } = await setup(t, { peer: { profiles: [`${PEER}:medium`] } }, { team: 'review', teamJson });
  const refused = await delegate({ agent: 'peer', model: 'codex:gpt-6-sol' });
  assert.match(refused.error ?? '', /codex:gpt-6-sol is not one of peer's model profiles in team review; pass claude:claude-sonnet-5, or omit model/, JSON.stringify(refused));
  assert.match(refused.error, /team\.review\.peer\.profiles in \S+[\\/]\.alp[\\/]settings\.json/);
  // alp setup writes only Phở's and Cafe's profiles, so it would not help this team.
  assert.doesNotMatch(refused.error, /alp setup/);
  assert.match(await startedOn(await delegate({ agent: 'peer' })), /claude-sonnet-5/);
});

test('an acp: profile starts, and the answer says its effort was not checked', async t => {
  // acp: takes the same path as antigravity:: ALP has no effort list for it (profileEfforts returns []).
  const { delegate, startedOn } = await setup(t, { reviewer: { profiles: ['acp:opencode/big-model', `${PEER}:high`] } });
  const answer = await delegate({ agent: 'reviewer', model: 'acp:opencode/big-model', thinking: 'high' });
  assert.match(answer.thinkingNote ?? '', /effort high was not checked: ALP does not know which efforts acp:opencode\/big-model takes/, JSON.stringify(answer));
  assert.match(await startedOn(answer), /big-model/);
  // Still an allowlist: another ACP model is refused.
  assert.match((await delegate({ agent: 'reviewer', model: 'acp:opencode/other', thinking: 'high' })).error ?? '', /acp:opencode\/other is not one of reviewer's model profiles/);
});

const repository = fileURLToPath(new URL('../..', import.meta.url));
/** Runs alp init or alp setup on a project, with ALP_HOME at the test's library. */
const alp = (library, ...args) => {
  const result = spawnSync(process.execPath, [path.join(repository, 'packages/cli/src/cli.js'), ...args], { env: { ...process.env, ALP_HOME: library }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
/** Settings as alp init writes them, in Cafe, with or without alp setup after. */
const cafe = runtime => async ({ root, library }) => {
  await rm(path.join(root, '.alp', 'settings.json'));
  alp(library, 'init', root);
  if (runtime) alp(library, 'setup', root, '--runtime', runtime);
  const file = path.join(root, '.alp', 'settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  await writeFile(file, JSON.stringify({ ...settings, workflow: { mode: 'cafe', supervisor: false } }));
};

test('a default Claude-only project: each configured target still starts on its model without one being passed', async t => {
  const { agents, delegate, startedOn } = await setup(t, undefined, { team: 'cafe', settings: cafe() });
  // lead first: one lead runs at a time, while reviewer and oracle, read-only advisors, run beside it.
  assert.match(await startedOn(await delegate({ agent: 'lead' })), /claude-opus-5-5/);
  await until(() => agents.at(-1).turnId, 'lead\'s turn');
  const lead = agents.at(-1);
  assert.match(await startedOn(await lead.call('alp_delegate', { agent: 'peer', task: 'Look', mode: 'read-only', wait: false })), /claude-opus-5-5/);
  assert.match(await startedOn(await delegate({ agent: 'reviewer' })), /claude-opus-5-5/);
  assert.match(await startedOn(await delegate({ agent: 'oracle', model: 'claude:claude-fable-5-1' })), /claude-fable-5-1/);
  // And a model outside the profiles is refused with an actionable message.
  const refused = await delegate({ agent: 'reviewer', model: 'codex:gpt-6.1-sol', thinking: 'high' });
  assert.match(refused.error ?? '', /codex:gpt-6\.1-sol is not one of reviewer's model profiles in team cafe; pass claude:claude-opus-5-5, or omit model[\s\S]*team\.cafe\.reviewer\.profiles[\s\S]*alp setup \S+ --runtime mix/, JSON.stringify(refused));
});

test('a project set up with --runtime mix: lead, reviewer and peer start on either provider', async t => {
  const { agents, main, delegate, startedOn } = await setup(t, undefined, { team: 'cafe', settings: cafe('mix') });
  // main is told, per target, that it chooses model and effort for lead and reviewer; oracle keeps its lenses.
  const instructions = main.config.developerInstructions;
  assert.match(instructions, /For an agent with several, or with any model of a provider, you choose both for each assignment/);
  for (const agent of ['lead', 'reviewer']) assert.match(instructions, new RegExp(`${agent}, choose a model and effort: claude:claude-opus-5-5[^;]*, usually high; codex:gpt-6\\.1-sol[^;]*, usually high`));
  // Several profiles: the coordinator chooses, so a delegation without a model is answered with the choice.
  assert.match((await delegate({ agent: 'lead' })).error ?? '', /lead has several model profiles: choose one/);
  // lead on the provider main does not run on, then lead's peers on either.
  assert.match(await startedOn(await delegate({ agent: 'lead', model: 'codex:gpt-6.1-sol', thinking: 'high', modelReason: 'test' })), /gpt-6\.1-sol/);
  await until(() => agents.at(-1).turnId, 'lead\'s turn');
  const lead = agents.at(-1);
  for (const model of ['codex:gpt-6-luna', 'claude:claude-sonnet-5']) {
    assert.match(await startedOn(await lead.call('alp_delegate', { agent: 'peer', task: 'Look', mode: 'read-only', model, thinking: 'medium', wait: false })), new RegExp(model.split(':')[1]));
  }
  for (const model of ['codex:gpt-6.1-sol', 'claude:claude-opus-5-5']) {
    assert.match(await startedOn(await delegate({ agent: 'reviewer', model, thinking: 'high' })), new RegExp(model.split(':')[1].replace('.', '\\.')));
  }
  assert.match(await startedOn(await delegate({ agent: 'oracle', model: 'codex:gpt-6-astra' })), /gpt-6-astra/);
  // A model outside them is still refused, naming what may be passed.
  const refused = await delegate({ agent: 'reviewer', model: 'antigravity:gemini-3.8-flash-high', thinking: 'high' });
  assert.match(refused.error ?? '', /is not one of reviewer's model profiles in team cafe; pass claude:claude-opus-5-5 or codex:gpt-6\.1-sol\. /, JSON.stringify(refused));
});
