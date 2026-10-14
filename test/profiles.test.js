import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../packages/core/src/init.js';
import { upgradeProject } from '../packages/core/src/upgrade.js';
import { validateSettings } from '../packages/core/src/validation.js';
import { fakeTransport, until } from './support/fake-agent.js';
import { createAlpRuntime, resolveSession } from '../dist/runtime/index.js';

test('project profile resolves model/effort, supervisor and dual lenses; caller can override', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root, { library: root });
  const file = path.join(root, '.alp/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  settings.workflow.mode = 'cafe';
  settings.team.cafe.main = { profiles: ['codex:custom-main:low'], autocompact: 'auto' };
  settings.team.cafe.oracle = { profiles: ['claude:sonnet:medium', 'codex:custom-oracle:high', 'codex:another-oracle:low'], autocompact: 'auto' };
  await writeFile(file, JSON.stringify(settings));
  const main = await resolveSession({ cwd: root }, { library: root });
  assert.equal(main.runtimeKind, 'codex');
  assert.equal(main.model, 'custom-main');
  assert.equal(main.thinking, 'low');
  assert.deepEqual(main.oracleModels, ['claude:sonnet', 'codex:custom-oracle', 'codex:another-oracle']);
  for (const model of main.oracleModels) {
    const lens = await resolveSession({ cwd: root, agent: 'oracle', model }, { library: root });
    assert.equal(lens.thinking, settings.team.cafe.oracle.profiles.find(config => config.startsWith(`${model}:`)).split(':')[2]);
  }
  const explicit = await resolveSession({ cwd: root, model: 'claude:sonnet', thinking: 'high' }, { library: root });
  assert.equal(explicit.runtimeKind, 'claude');
  assert.equal(explicit.thinking, 'high');
  const before = await readFile(file, 'utf8');
  await upgradeProject(root);
  assert.equal(await readFile(file, 'utf8'), before, 'upgrade keeps existing profile choices');
});

test('invalid profile choices fail before launching', () => {
  for (const config of [{ provider: 'claude', model: 'codex:foo' }, { model: 'foo' }, { provider: 'codex', model: 'foo', effort: 'huge' }]) {
    assert.throws(() => validateSettings({ team: { cafe: { main: config } } }, 'settings'), /INVALID_SETTINGS|team\./);
  }
});


test('legacy oracle provider map works and upgrade migrates it without changing choices', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-oracle-list-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root, { library: root });
  const file = path.join(root, '.alp/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  const lenses = [{ provider: 'claude', model: 'sonnet', effort: 'low' }, { provider: 'codex', model: 'custom-oracle', effort: 'medium' }];
  settings.team.pho.oracle = Object.fromEntries(lenses.map(lens => [lens.provider, lens]));
  await writeFile(file, JSON.stringify(settings));
  const before = await resolveSession({ cwd: root, agent: 'oracle', model: 'claude:sonnet' }, { library: root });
  assert.equal(before.thinking, 'low');
  const result = await upgradeProject(root);
  assert.ok(result.backup);
  const updated = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(updated.team.pho.oracle, { profiles: ['claude:sonnet:low', 'codex:custom-oracle:medium'], autocompact: 'auto' });
  const after = await resolveSession({ cwd: root, agent: 'oracle', model: 'codex:custom-oracle' }, { library: root });
  assert.equal(after.thinking, 'medium');
});

test('oracle profiles list rejects empty, repeated, mismatched and malformed choices', () => {
  const valid = { provider: 'codex', model: 'foo', effort: 'high' };
  for (const profiles of [[], [valid, valid], [{ provider: 'claude', model: 'codex:foo' }], [null], [{ model: 'foo' }], 'foo']) {
    assert.throws(() => validateSettings({ team: { cafe: { oracle: { profiles } } } }, 'settings'), /profile/);
  }
});


test('every agent has model profiles; the requester picks a peer model and effort, and its autocompact applies', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-agent-profiles-'));
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), libraryDir: root, supervisor: false });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  await initProject(root, { library: root });
  const file = path.join(root, '.alp/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  const team = settings.team.pho;
  team.main = { profiles: [{ provider: 'codex', model: 'main-custom', effort: 'high' }], autocompact: 300000 };
  team.peer = { profiles: [
    { provider: 'claude', model: 'sonnet', effort: 'medium' },
    { provider: 'codex', model: 'peer-custom', effort: 'low' },
    { provider: 'codex', model: 'gpt-6-luna', effort: 'low' },
  ], autocompact: 250000 };
  team.reviewer = { profiles: [{ provider: 'codex', model: 'review-custom', effort: 'high' }], autocompact: 150000 };
  team.supervisor = { profiles: [
    { provider: 'codex', model: 'watch-custom', effort: 'low' },
    { provider: 'claude', model: 'sonnet', effort: 'medium' },
  ], autocompact: 180000 };
  await writeFile(file, JSON.stringify(settings));
  await runtime.open('root', { cwd: root });
  const main = agents[0];
  assert.equal(main.config.config.model_auto_compact_token_limit, 300000);
  assert.match(main.config.developerInstructions, /peer, choose a model and effort: claude:sonnet[^;]*usually medium; codex:peer-custom, usually low/);
  assert.match(main.config.developerInstructions, /reviewer: codex:review-custom \(effort high\)/);
  await runtime.prompt('root', { clientMessageId: 'm1', content: [{ type: 'text', text: 'Go' }] });
  const unchosen = await main.call('alp_delegate', { agent: 'peer', task: 'Inspect A', mode: 'read-only' });
  assert.match(unchosen.error, /several model profiles: choose one for this task as model, its effort as thinking/);
  const effortless = await main.call('alp_delegate', { agent: 'peer', task: 'Inspect A', model: 'claude:sonnet', mode: 'read-only' });
  assert.match(effortless.error, /its effort as thinking/);
  assert.deepEqual(unchosen.models, ['claude:sonnet', 'codex:peer-custom', 'codex:gpt-6-luna']);
  const unlisted = await main.call('alp_delegate', { agent: 'peer', task: 'Inspect A', model: 'codex:gpt-6-sol', thinking: 'low', mode: 'read-only' });
  assert.match(unlisted.error, /not one of peer's model profiles/);
  const unsupported = await main.call('alp_delegate', { agent: 'peer', task: 'Inspect A', model: 'codex:gpt-6-luna', thinking: 'ultra', mode: 'read-only' });
  assert.match(unsupported.error, /codex:gpt-6-luna takes effort low, medium, high, xhigh, max/);
  assert.match(main.config.developerInstructions, /codex:gpt-6-luna: Fast and affordable model for easier tasks\. Efforts low\|medium\|high\|xhigh\|max, usually low/);
  const first = await main.call('alp_delegate', { agent: 'peer', task: 'Inspect A', model: 'claude:sonnet', thinking: 'medium', modelReason: 'a careful read', mode: 'read-only' });
  assert.ok(first.assignmentId, JSON.stringify(first));
  await until(() => agents[1]?.started.length);
  assert.equal(agents[1].config.runtime, 'claude');
  assert.equal(agents[1].config.model, 'sonnet');
  assert.equal(agents[1].config.thinking, 'medium');
  assert.equal(agents[1].config.context, 250000);
  const second = await main.call('alp_delegate', { agent: 'peer', task: 'Inspect B', model: 'codex:peer-custom', thinking: 'high', mode: 'read-only' });
  assert.ok(second.assignmentId, JSON.stringify(second));
  await until(() => agents[2]?.started.length);
  assert.equal(agents[2].config.runtime, 'codex');
  assert.equal(agents[2].config.model, 'peer-custom');
  assert.equal(agents[2].config.thinking, 'high', 'the requester chose the effort');
  assert.equal(agents[2].config.config.model_auto_compact_token_limit, 250000);
  const reviewer = await resolveSession({ cwd: root, agent: 'reviewer' }, { library: root });
  assert.equal(reviewer.model, 'review-custom');
  assert.equal(reviewer.autocompact, 150000);
  const watcher = await resolveSession({ cwd: root, agent: 'supervisor', model: 'claude:sonnet' }, { library: root });
  assert.equal(watcher.thinking, 'medium');
  assert.equal(watcher.autocompact, 180000);
  const watched = [];
  const supervised = createAlpRuntime({ transport: fakeTransport(watched), libraryDir: root });
  try {
    await supervised.open('watched-root', { cwd: root });
    await until(() => watched.some(agent => agent.config?.model === 'watch-custom'));
    const supervisor = watched.find(agent => agent.config?.model === 'watch-custom');
    assert.equal(supervisor.config.thinking, 'low');
    assert.equal(supervisor.config.config.model_auto_compact_token_limit, 180000);
  } finally { await supervised.shutdown(); }
});

test('upgrade wraps old agent choices and preserves compaction and model order', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-profiles-upgrade-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root, { library: root });
  const file = path.join(root, '.alp/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  const oldMain = { provider: 'codex', model: 'custom-main', effort: 'low' };
  settings.team.pho.main = { ...oldMain, autocompact: 200000 };
  await writeFile(file, JSON.stringify(settings));
  const result = await upgradeProject(root);
  assert.ok(result.backup);
  const upgraded = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(upgraded.team.pho.main, { profiles: ['codex:custom-main:low'], autocompact: 200000 });
  for (const config of Object.values(upgraded.team.pho)) assert.ok(Array.isArray(config.profiles));
  const again = await upgradeProject(root);
  assert.deepEqual(again.updated, []);
});

test('all agents validate profile lists and autocompact before launching', () => {
  const profiles = [{ provider: 'codex', model: 'peer-model', effort: 'low' }];
  for (const name of ['main', 'lead', 'peer', 'reviewer', 'supervisor', 'oracle']) {
    for (const autocompact of [200000, 350000, 'auto']) validateSettings({ team: { cafe: { [name]: { profiles, autocompact } } } }, 'settings');
    for (const autocompact of [0, -1, 200000.5, '200k', null, false, 99999, 1000001]) {
      assert.throws(() => validateSettings({ team: { cafe: { [name]: { profiles, autocompact } } } }, 'settings'), /autocompact/);
    }
    for (const invalid of [[], [null], [profiles[0], profiles[0]], 'foo']) {
      assert.throws(() => validateSettings({ team: { cafe: { [name]: { profiles: invalid } } } }, 'settings'), /profiles/);
    }
  }
});

test('a peer on codex:* runs on any Codex model the requester picks, at the effort it picks', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-any-model-'));
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), libraryDir: root, supervisor: false });
  t.after(async () => { await runtime.shutdown(); await rm(root, { recursive: true, force: true }); });
  await initProject(root, { library: root });
  const file = path.join(root, '.alp/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  settings.team.pho.main = { profiles: ['codex:gpt-6.1-sol'] };
  settings.team.pho.peer = { profiles: ['codex:*'] };
  await writeFile(file, JSON.stringify(settings));
  await runtime.open('root', { cwd: root });
  const main = agents[0];
  assert.match(main.config.developerInstructions, /peer, choose a model and effort: any codex model .*codex:gpt-6-luna: Fast and affordable model for easier tasks\. Efforts low\|medium\|high\|xhigh\|max/);
  await runtime.prompt('root', { clientMessageId: 'm1', content: [{ type: 'text', text: 'Go' }] });
  const brief = { agent: 'peer', task: 'Inspect A', mode: 'read-only' };
  assert.match((await main.call('alp_delegate', brief)).error, /choose one for this task as model, its effort as thinking/);
  assert.match((await main.call('alp_delegate', { ...brief, model: 'claude:claude-sonnet-5', thinking: 'low' })).error, /not one of peer's model profiles/);
  assert.match((await main.call('alp_delegate', { ...brief, model: 'codex:gpt-6-astra', thinking: 'high' })).error, /takes effort low/);
  const started = await main.call('alp_delegate', { ...brief, model: 'codex:gpt-5.6-terra', thinking: 'xhigh', modelReason: 'a plain read' });
  assert.ok(started.assignmentId, JSON.stringify(started));
  await until(() => agents[1]?.started.length);
  assert.equal(agents[1].config.model, 'gpt-5.6-terra');
  assert.equal(agents[1].config.thinking, 'xhigh');
});

test('profiles take "provider:model[:effort]" and "provider:*"; main and oracle name their models, main just one', () => {
  validateSettings({ team: { cafe: { peer: { profiles: ['codex:*', 'claude:claude-sonnet-5-5'] }, main: { profiles: ['claude:claude-opus-5-5'] } } } }, 'settings');
  for (const profiles of [['gpt-6-sol'], ['codex:'], ['acp:'], ['codex:a b']]) assert.throws(() => validateSettings({ team: { cafe: { peer: { profiles } } } }, 'settings'), /profiles\[0\]/);
  assert.throws(() => validateSettings({ team: { cafe: { oracle: { profiles: ['codex:*'] } } } }, 'settings'), /oracle runs on a named model/);
  validateSettings({ team: { cafe: { lead: { profiles: ['claude:claude-opus-5-5:high', 'codex:gpt-6-astra:low', 'codex:custom:xhigh'] } } } }, 'settings');
  for (const [profiles, error] of [
    [['codex:gpt-6-astra:high'], /codex:gpt-6-astra takes effort low/],
    [['claude:claude-opus-5-5:huge'], /effort huge is unsupported/],
    [['codex:*:high'], /must be "provider:model"/],
  ]) assert.throws(() => validateSettings({ team: { cafe: { lead: { profiles } } } }, 'settings'), error);
  for (const profiles of [['claude:claude-opus-5-5:high', 'codex:gpt-6.1-sol:high'], ['codex:*']]) {
    assert.throws(() => validateSettings({ team: { cafe: { main: { profiles } } } }, 'settings'), /main runs on (exactly one|a named) model/);
  }
});

test('ACP model profiles are accepted and preserve nested OpenCode model IDs', () => {
  validateSettings({ team: { pho: { main: { profiles: ['acp:opencode'] } } } }, 'settings');
  const model = 'acp:opencode/opencode/cat-jam-free';
  assert.doesNotThrow(() => validateSettings({ team: { pho: { main: { profiles: [model] }, oracle: { profiles: [model, 'acp:opencode/opencode/mimo-v2.6-flash-free'] } } } }, 'settings'));
});


test('legacy profile settings still resolve and upgrade to team without losing choices', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-legacy-team-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await initProject(root, { library: root });
  const file = path.join(root, '.alp/settings.json');
  const settings = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(settings.profile, undefined);
  settings.team.pho.main = { profiles: ['codex:legacy-main:low'], autocompact: 200000 };
  settings.profile = settings.team;
  delete settings.team;
  await writeFile(file, JSON.stringify(settings));
  const before = await resolveSession({ cwd: root }, { library: root });
  assert.equal(before.model, 'legacy-main');
  await upgradeProject(root);
  const upgraded = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(upgraded.profile, undefined);
  assert.deepEqual(upgraded.team, settings.profile);
  const after = await resolveSession({ cwd: root }, { library: root });
  assert.equal(after.model, before.model);
  assert.equal(after.thinking, before.thinking);
});
