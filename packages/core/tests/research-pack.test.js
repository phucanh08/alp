import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installPack, listPacks } from '../src/packs.js';
import { ADVISORS, READ_ONLY_ROLES, commandDecision, profileFor } from '../src/permissions.js';
import { BUILTIN_AGENTS, resolveAgent } from '../src/resolver.js';
import { TEAM_ROLES, resolveTeam } from '../src/teams.js';

// The research pack: two read-only advisors (librarian, scout) and two variant teams. Phở and Cafe stay as they are.

async function scratch(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-research-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await mkdir(path.join(root, '.alp'), { recursive: true });
  return { root, library: path.join(directory, 'home') };
}

const ADVISORS_OF_PACK = ['librarian', 'scout'];

test('the research pack is valid and lists two agents, two variant teams and read-only permissions', async () => {
  const pack = (await listPacks()).find(candidate => candidate.id === 'research');
  assert.ok(pack, 'research ships');
  assert.equal(pack.label, 'Research');
  assert.deepEqual(pack.agents, ['librarian', 'scout']);
  assert.deepEqual(pack.teams, ['pho-research', 'cafe-research']);
  assert.deepEqual(pack.permissions, { librarian: 'read-only', scout: 'read-only' });
  assert.deepEqual(pack.skills, []);
  // No new built-in agent, no dashboard id, no new team role.
  for (const name of ADVISORS_OF_PACK) assert.ok(!BUILTIN_AGENTS.includes(name) && !ADVISORS.includes(name));
  assert.ok(!pack.agents.includes('finder'));
  assert.deepEqual(TEAM_ROLES, ['lead', 'peer', 'advisor', 'reviewer']);
});

test('installing the pack adds librarian and scout, read-only, and both variant teams', async t => {
  const { root, library } = await scratch(t);
  const result = await installPack('research', { scope: 'library', library });
  assert.deepEqual(result.installed.map(entry => `${entry.kind}/${entry.name}`), ['agents/librarian', 'agents/scout', 'teams/pho-research', 'teams/cafe-research']);
  assert.deepEqual(result.permissions, { set: ['librarian: read-only', 'scout: read-only'], kept: [], conflicts: [] });
  assert.deepEqual(JSON.parse(await readFile(path.join(library, 'settings.json'), 'utf8')).permissions.agents, { librarian: 'read-only', scout: 'read-only' });

  const librarian = await resolveAgent(root, { agent: 'librarian', library });
  assert.equal(librarian.source, 'library');
  assert.equal(librarian.mode, 'read-only');
  assert.deepEqual(librarian.runtime, { model: 'claude:claude-sonnet-5', reasoning: 'medium' });
  assert.match(librarian.instructions.agent, /^# Librarian/);
  assert.match(librarian.instructions.agent, /repo@sha:path:line/);
  assert.deepEqual(librarian.skills, []);
  const scout = await resolveAgent(root, { agent: 'scout', library });
  assert.equal(scout.mode, 'read-only');
  assert.deepEqual(scout.runtime, { model: 'claude:claude-sonnet-5', reasoning: 'low' });
  assert.match(scout.instructions.agent, /^# Scout/);
  assert.match(scout.instructions.agent, /Không tìm thấy \/ chưa chắc/);
  assert.deepEqual(scout.skills, []);
  for (const name of ADVISORS_OF_PACK) assert.equal((await profileFor(root, library, name)).base, 'read-only');
});

test('Phở + Research: main reaches scout and librarian; both are advisors that delegate to nobody', async t => {
  const { root, library } = await scratch(t);
  await installPack('research', { scope: 'library', library });
  const team = await resolveTeam(root, 'pho-research', { library });
  const pho = await resolveTeam(root, 'pho', { library });
  assert.equal(team.source, 'library');
  assert.deepEqual(team.delegation, { main: [...pho.delegation.main, 'librarian', 'scout'] });
  // Otherwise the same as Phở.
  assert.equal(team.maxPeers, pho.maxPeers);
  assert.deepEqual(team.supervisor, pho.supervisor);
  assert.deepEqual(Object.fromEntries(Object.entries(team.members).filter(([name]) => !ADVISORS_OF_PACK.includes(name))), pho.members);
  assert.ok(team.houseRules.startsWith(pho.houseRules.replace('Ở Phở (pho)', 'Ở Phở + Research (pho-research)')));
  assert.match(team.houseRules, /Dùng scout khi workspace lớn/);
  assert.match(team.houseRules, /Dùng librarian khi hành vi của một thư viện bên ngoài/);
  for (const name of ADVISORS_OF_PACK) {
    assert.equal(team.members[name].role, 'advisor');
    assert.ok(READ_ONLY_ROLES.includes(team.members[name].role), `${name} serves read-only`);
    assert.ok(!Object.hasOwn(team.delegation, name), `${name} delegates to nobody`);
  }
  // Only peer members count against maxPeers (runtime: roleOf(...) === 'peer').
  assert.deepEqual(Object.entries(team.members).filter(([, member]) => member.role === 'peer').map(([name]) => name), ['peer']);
});

test('Cafe + Research: lead reaches both, main reaches librarian only', async t => {
  const { root, library } = await scratch(t);
  await installPack('research', { scope: 'library', library });
  const team = await resolveTeam(root, 'cafe-research', { library });
  const cafe = await resolveTeam(root, 'cafe', { library });
  assert.deepEqual(team.delegation, {
    main: [...cafe.delegation.main, 'librarian'],
    lead: [...cafe.delegation.lead, 'librarian', 'scout'],
  });
  assert.ok(!team.delegation.main.includes('scout'));
  assert.equal(team.maxPeers, cafe.maxPeers);
  assert.deepEqual(team.supervisor, cafe.supervisor);
  assert.deepEqual(Object.fromEntries(Object.entries(team.members).filter(([name]) => !ADVISORS_OF_PACK.includes(name))), cafe.members);
  assert.ok(team.houseRules.startsWith(cafe.houseRules.replace('Ở Cafe (cafe)', 'Ở Cafe + Research (cafe-research)')));
  for (const name of ADVISORS_OF_PACK) {
    assert.equal(team.members[name].role, 'advisor');
    assert.ok(!Object.hasOwn(team.delegation, name));
  }
});

test('default Phở and Cafe gain no member and no delegation edge, installed or not', async t => {
  const { root, library } = await scratch(t);
  const before = { pho: await resolveTeam(root, 'pho', { library }), cafe: await resolveTeam(root, 'cafe', { library }) };
  await installPack('research', { scope: 'library', library });
  for (const id of ['pho', 'cafe']) {
    const team = await resolveTeam(root, id, { library });
    assert.equal(team.source, 'builtin');
    assert.deepEqual(team.delegation, before[id].delegation);
    assert.deepEqual(team.members, before[id].members);
    for (const name of ADVISORS_OF_PACK) {
      assert.ok(!Object.hasOwn(team.members, name));
      assert.ok(!Object.values(team.delegation).flat().includes(name));
    }
  }
  assert.deepEqual(before.pho.delegation, { main: ['peer', 'oracle', 'reviewer'] });
  assert.deepEqual(before.cafe.delegation, { main: ['lead', 'oracle', 'reviewer'], lead: ['peer', 'oracle', 'reviewer'] });
});

test('serving as a team advisor, librarian and scout stay read-only even when settings give them full access', async t => {
  const { root, library } = await scratch(t);
  await installPack('research', { scope: 'library', library });
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ permissions: { agents: { librarian: 'full-access', scout: 'workspace-write' } } }));
  for (const [name, from] of [['librarian', 'full-access'], ['scout', 'workspace-write']]) {
    const profile = await profileFor(root, library, name, { readOnly: true });
    assert.equal(profile.base, 'read-only');
    assert.equal(profile.cappedFrom, from);
  }
});

// What librarian needs beyond read-only (clone and fetch into /tmp/alp-librarian, nothing pushed). pack.json can
// carry only a base mode (packs.js validatePack), so this profile is the user's to add in settings for now; the
// test pins what it decides once given, and that a team advisor's cap keeps its rules (permissions.js profileFor).
const LIBRARIAN_PROFILE = {
  base: 'read-only',
  allow: ['Bash(git clone:*)', 'Bash(git -C /tmp/alp-librarian/*)', 'Bash(git fetch:*)', 'WebFetch(domain:github.com)', 'WebFetch(domain:raw.githubusercontent.com)', 'WebFetch(domain:gitlab.com)'],
  ask: ['Bash(gh repo clone:*)'],
  deny: ['Bash(git push:*)', 'Bash(rm:*)'],
};

test('a librarian profile in settings keeps its rules under the advisor cap: clone and fetch run, push is refused, nothing writes the workspace', async t => {
  const { root, library } = await scratch(t);
  await installPack('research', { scope: 'library', library });
  await writeFile(path.join(root, '.alp', 'settings.json'), JSON.stringify({ permissions: { profiles: { librarian: LIBRARIAN_PROFILE }, agents: { librarian: 'librarian' } } }));
  const profile = await profileFor(root, library, 'librarian', { readOnly: true });
  assert.equal(profile.base, 'read-only');
  assert.deepEqual(profile.allow, LIBRARIAN_PROFILE.allow);
  assert.deepEqual(profile.ask, LIBRARIAN_PROFILE.ask);
  assert.deepEqual(profile.deny, LIBRARIAN_PROFILE.deny);
  const decide = command => commandDecision(profile, command);
  assert.equal(decide('git clone --depth 50 https://github.com/getpaseo/paseo /tmp/alp-librarian/getpaseo-paseo'), 'allow');
  assert.equal(decide('git -C /tmp/alp-librarian/getpaseo-paseo log -S needle --oneline'), 'allow');
  assert.equal(decide('git -C /tmp/alp-librarian/getpaseo-paseo fetch --depth 50'), 'allow');
  assert.equal(decide('git fetch --filter=blob:none origin'), 'allow');
  assert.equal(decide('gh repo clone owner/private /tmp/alp-librarian/owner-private'), 'ask');
  assert.equal(decide('git push origin main'), 'deny');
  assert.equal(decide('git clone https://github.com/a/b /tmp/alp-librarian/a-b && git push'), 'deny');
  assert.equal(decide('rm -rf /tmp/alp-librarian'), 'deny');
  // Not covered: the read-only base decides, so writes to the workspace stay refused.
  assert.equal(decide('git -C . commit -m x'), undefined);
  assert.equal(decide('git -C /tmp/alp-librarian/a-b log > notes.txt'), undefined, 'a redirect is never allowed by a rule');
  assert.equal(decide('touch src/x.js'), undefined);
});
