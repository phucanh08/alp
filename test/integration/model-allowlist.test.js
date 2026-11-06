import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

async function setup(t, pho = { peer: { profiles: [`${PEER}:medium`] }, reviewer: { profiles: REVIEWER } }, { custom = false } = {}) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-allowlist-'));
  // defer runs in reverse: the directory, registered first, goes after the runtime has shut down.
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  const library = path.join(directory, 'home');
  await initProject(root);
  await seedLibrary(library);
  // custom: a delegation graph of the project's own, which has no team and so no model profiles.
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify(custom
    ? { defaultAgent: 'main', delegation: { main: ['peer'] } }
    : { defaultAgent: 'main', workflow: { mode: 'pho', supervisor: false }, team: { pho } }));
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), supervisor: false, libraryDir: library, runLogDir: path.join(directory, 'runs') });
  defer(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, ...(custom ? {} : { workflow: 'pho' }) });
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
