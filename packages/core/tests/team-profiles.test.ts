// t-3aad: the profile ALP writes for a team member that team.json gives no model is its agent.json's
// model and effort before main's; a profile the user wrote stays; Phở's and Cafe's defaults do not change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { projectProfiles } from '@anhlp/alp-core/profiles';

const LAB = {
  label: 'Lab',
  main: 'main',
  members: {
    main: { model: 'codex:gpt-6.1-sol', thinking: 'high' },
    scout: { role: 'peer' },
    helper: { role: 'peer', model: 'claude:claude-sonnet-5', thinking: 'low' },
    plain: { role: 'peer' },
  },
  delegation: { main: ['scout', 'helper', 'plain'] },
};

async function project(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-team-profiles-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.alp/teams/lab'), { recursive: true });
  await writeFile(path.join(root, '.alp/teams/lab/team.json'), JSON.stringify(LAB));
  return root;
}

async function agentJson(root, name, config) {
  const directory = path.join(root, '.alp/agents', name);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'AGENT.md'), `You are ${name}.\n`);
  await writeFile(path.join(directory, 'agent.json'), JSON.stringify(config));
}

const settingsOf = async root => JSON.parse(await readFile(path.join(root, '.alp/settings.json'), 'utf8'));

test('a member without a team.json model gets its agent.json model and effort; the team.json model still wins', async t => {
  const root = await project(t);
  await agentJson(root, 'scout', { model: 'claude:claude-haiku-4-5-20251001', thinking: 'low' });
  await agentJson(root, 'helper', { model: 'codex:gpt-5.6-terra', thinking: 'xhigh' });
  await agentJson(root, 'plain', { provider: 'claude', model: 'claude-sonnet-5' });
  await initProject(root, { library: root });
  const lab = (await settingsOf(root)).team.lab;
  assert.deepEqual(lab.scout.profiles, ['claude:claude-haiku-4-5-20251001:low']);
  assert.deepEqual(lab.helper.profiles, ['claude:claude-sonnet-5:low']);
  // No effort in agent.json: main's, fitted to the model.
  assert.deepEqual(lab.plain.profiles, ['claude:claude-sonnet-5:high']);
});

test('a profile ALP wrote from main\'s model follows a new agent.json; one the user wrote is kept', async t => {
  const root = await project(t);
  await initProject(root, { library: root });
  let lab = (await settingsOf(root)).team.lab;
  assert.deepEqual(lab.scout.profiles, ['codex:gpt-6.1-sol:high'], 'no agent.json: main\'s model, as before');
  assert.deepEqual(lab.plain.profiles, ['codex:gpt-6.1-sol:high']);
  // The user writes plain's profile by hand; then both agents gain an agent.json model.
  const settings = await settingsOf(root);
  settings.team.lab.plain = { profiles: ['codex:gpt-5.6-terra:low'], autocompact: 'auto' };
  await writeFile(path.join(root, '.alp/settings.json'), JSON.stringify(settings));
  await agentJson(root, 'scout', { model: 'claude:claude-haiku-4-5-20251001' });
  await agentJson(root, 'plain', { model: 'claude:claude-haiku-4-5-20251001' });
  await initProject(root, { library: root });
  lab = (await settingsOf(root)).team.lab;
  assert.match(lab.scout.profiles[0], /^claude:claude-haiku-4-5-20251001(:|$)/, 'the managed entry follows agent.json');
  assert.deepEqual(lab.plain.profiles, ['codex:gpt-5.6-terra:low'], 'the hand-written entry is kept');
});

test('Phở\'s and Cafe\'s default profiles do not depend on agent.json lookups for built-in agents', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-team-profiles-builtin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profiles = await projectProfiles({ root, library: root, teamIds: ['pho', 'cafe'] });
  // Every member but the oracle and supervisor runs on its team.json model or main's.
  for (const id of ['pho', 'cafe']) {
    for (const [name, config] of Object.entries(profiles[id])) {
      if (name === 'oracle' || name === 'supervisor') continue;
      assert.match(config.profiles[0], /^claude:claude-opus-5-5:/, `${id}.${name}: ${config.profiles[0]}`);
    }
  }
});
