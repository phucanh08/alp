import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { seedLibrary } from '@anhlp/alp-core/library';
import { installPack, listPacks, packStatus } from '@anhlp/alp-core/packs';
import { profileFor } from '@anhlp/alp-core/permissions';
import { resolveAgent } from '@anhlp/alp-core/resolver';
import { resolveTeam } from '@anhlp/alp-core/teams';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { fakeTransport, until } from '../support/fake-agent.js';

async function dirs(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-packs-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const root = path.join(directory, 'project');
  await initProject(root);
  return { directory, root, library: path.join(directory, 'home') };
}

test('ALP ships its optional packs valid, and seeding a library installs none of them', async t => {
  const packs = await listPacks();
  assert.deepEqual(packs.map(pack => pack.id), ['architecture', 'backend', 'design', 'frontend', 'integration', 'operations', 'quality']);
  const { root, library } = await dirs(t);
  await seedLibrary(library);
  const seeded = await readdir(path.join(library, 'skills'));
  for (const pack of packs) {
    for (const skill of pack.skills) assert.ok(!seeded.includes(skill), `${skill} is optional`);
    assert.deepEqual(await packStatus(pack, { root, library }), { library: false, project: false });
  }
  await assert.rejects(readdir(path.join(library, 'agents')), { code: 'ENOENT' });
});

test('a pack skill reaches a role only when assigned, and a reinstall never overwrites the user\'s copy', async t => {
  const { root, library } = await dirs(t);
  const installed = await installPack('backend', { scope: 'library', library });
  assert.deepEqual(installed.installed.map(entry => entry.name), ['backend-development', 'databases']);
  assert.deepEqual(installed.assigned, []);
  const peerSkills = async () => (await resolveAgent(root, { agent: 'peer', library })).skills.map(skill => skill.name);
  assert.ok(!(await peerSkills()).includes('backend-development'), 'installed but not assigned: not in peer\'s index');
  // The user edits a skill; installing again, with --assign, keeps the edit and assigns once.
  const skillFile = path.join(library, 'skills/backend-development/SKILL.md');
  await writeFile(skillFile, (await readFile(skillFile, 'utf8')) + '\nOur house rule: every endpoint has an OpenAPI entry.\n');
  const edited = await readFile(skillFile, 'utf8');
  const again = await installPack('backend', { scope: 'library', library, assign: true });
  assert.deepEqual(again.installed, []);
  assert.deepEqual(again.kept.map(entry => entry.name), ['backend-development', 'databases']);
  assert.deepEqual(again.assigned, ['lead/backend-development', 'lead/databases', 'peer/backend-development', 'peer/databases']);
  assert.equal(await readFile(skillFile, 'utf8'), edited);
  assert.ok((await peerSkills()).includes('backend-development'));
  assert.ok(!(await resolveAgent(root, { agent: 'main', library })).skills.some(skill => skill.name === 'backend-development'), 'main gets no specialist skill');
  assert.deepEqual((await installPack('backend', { scope: 'library', library, assign: true })).assigned, [], 'assigned once');
  // An ALP update leaves the pack's skills alone: they are the user's files now.
  assert.deepEqual((await seedLibrary(library)).updated.filter(name => name.includes('backend')), []);
  // Projects take packs too, but assign only through their own agents.
  await assert.rejects(installPack('frontend', { scope: 'project', root, library, assign: true }), { code: 'INVALID_SCOPE' });
  const project = await installPack('frontend', { scope: 'project', root, library });
  assert.equal(project.installed[0].path, path.join(root, '.alp/skills/frontend-development'));
  await assert.rejects(installPack('nope', { scope: 'library', library }), { code: 'NOT_FOUND' });
});

test('the architecture pack adds a read-only architect, a docs-maintainer peer and the Blueprint team', async t => {
  const { root, library } = await dirs(t);
  const result = await installPack('architecture', { scope: 'library', library });
  assert.deepEqual(result.installed.map(entry => `${entry.kind}/${entry.name}`), ['agents/architect', 'agents/docs-maintainer', 'teams/blueprint']);
  assert.deepEqual(result.permissions, { set: ['architect: read-only'], kept: [], conflicts: [] });
  const architect = await resolveAgent(root, { agent: 'architect', library });
  assert.deepEqual(architect.skills.map(skill => skill.name), ['architecture-docs', 'feature-architecture']);
  assert.equal(architect.mode, 'read-only');
  assert.equal((await profileFor(root, library, 'architect')).base, 'read-only');
  assert.deepEqual((await resolveAgent(root, { agent: 'docs-maintainer', library })).skills.map(skill => skill.name), ['architecture-docs']);
  const team = await resolveTeam(root, 'blueprint', { library });
  assert.equal(team.members.architect.role, 'advisor');
  assert.equal(team.members['docs-maintainer'].role, 'peer');
  // The feature-architecture checker the architect may run is executable where the library holds it.
  if (process.platform !== 'win32') assert.ok((await stat(path.join(library, 'skills/feature-architecture/scripts/check-boundaries.mjs'))).mode & 0o100);
  // A user's own permission entry for the agent is never changed, only reported.
  const other = await dirs(t);
  await seedLibrary(other.library);
  await writeFile(path.join(other.library, 'settings.json'), JSON.stringify({ permissions: { agents: { architect: 'workspace-write' } } }));
  const conflict = await installPack('architecture', { scope: 'library', library: other.library });
  assert.equal(conflict.permissions.conflicts.length, 1);
  assert.equal(JSON.parse(await readFile(path.join(other.library, 'settings.json'), 'utf8')).permissions.agents.architect, 'workspace-write');
  // A user's own architect agent is kept, and no permission is written for it.
  const own = await dirs(t);
  await seedLibrary(own.library);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(own.library, 'agents/architect'), { recursive: true });
  await writeFile(path.join(own.library, 'agents/architect/AGENT.md'), '# My architect, who writes\n');
  const kept = await installPack('architecture', { scope: 'library', library: own.library });
  assert.deepEqual(kept.kept.map(entry => entry.name), ['architect']);
  assert.deepEqual(kept.permissions.set, []);
  assert.match(kept.permissions.conflicts[0], /your own architect agent was kept/);
  await assert.rejects(readFile(path.join(own.library, 'settings.json'), 'utf8'), { code: 'ENOENT' });
});

test('in the Blueprint team, main delegating to the architect gets a read-only advisor even when asking for writes', async t => {
  const { directory, root, library } = await dirs(t);
  await installPack('architecture', { scope: 'library', library });
  const agents = [];
  const runtime = createAlpRuntime({ transport: fakeTransport(agents), supervisor: false, libraryDir: library, runLogDir: path.join(directory, 'runs') });
  t.after(() => runtime.shutdown());
  await runtime.open('root', { cwd: root, workflow: 'blueprint' });
  await runtime.prompt('root', { clientMessageId: 'm1', delivery: 'auto', content: [{ type: 'text', text: 'Does invoicing fit?' }] });
  const main = agents[0];
  const advice = await main.call('alp_delegate', { agent: 'architect', task: 'Does an invoices module fit the layering?', mode: 'workspace-write', wait: false });
  assert.ok(advice.assignmentId, JSON.stringify(advice));
  assert.equal(advice.mode, 'read-only');
  assert.match(advice.modeNote, /architect runs read-only: its permission profile read-only caps it/);
  await until(() => agents.length === 2, 'the architect');
  assert.match(agents[1].config.developerInstructions, /# Architect — read-only architecture advisor/);
  assert.match(agents[1].config.developerInstructions, /- feature-architecture \(/);
  // Main itself never delegates to docs-maintainer in Blueprint: that is lead's member.
  assert.match((await main.call('alp_delegate', { agent: 'docs-maintainer', task: 'Docs', wait: false })).error ?? '', /unauthorized target/);
});

test('a project reached through a linked directory installs there and is reported by the path given (macOS /var)', async t => {
  const { directory, root, library } = await dirs(t);
  // Like macOS's /var -> /private/var: the link is above the project, so it is not refused.
  const alias = path.join(directory, 'alias');
  await symlink(directory, alias, 'dir');
  const given = path.join(alias, 'project');
  const result = await installPack('frontend', { scope: 'project', root: given, library });
  assert.deepEqual(result.installed.map(entry => entry.path), [path.join(given, '.alp/skills/frontend-development')]);
  assert.ok((await stat(path.join(await realpath(root), '.alp/skills/frontend-development/SKILL.md'))).isFile());
  const again = await installPack('frontend', { scope: 'project', root: given, library });
  assert.deepEqual(again.kept.map(entry => entry.path), [path.join(given, '.alp/skills/frontend-development')]);
});

test('pack install refuses links in its scope and never writes through one (P0)', async t => {
  const { symlink, mkdir, readdir: list } = await import('node:fs/promises');
  // .alp/skills of a project is a link to somewhere else.
  const linked = await dirs(t);
  const outside = path.join(linked.directory, 'outside');
  await mkdir(outside, { recursive: true });
  await symlink(outside, path.join(linked.root, '.alp', 'skills'));
  await assert.rejects(installPack('backend', { scope: 'project', root: linked.root, library: linked.library }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await list(outside), []);
  // .alp itself is a link.
  const whole = await dirs(t);
  const elsewhere = path.join(whole.directory, 'elsewhere');
  await mkdir(elsewhere, { recursive: true });
  await rm(path.join(whole.root, '.alp'), { recursive: true });
  await symlink(elsewhere, path.join(whole.root, '.alp'));
  await assert.rejects(installPack('frontend', { scope: 'project', root: whole.root, library: whole.library }), { code: 'UNSAFE_PATH' });
  assert.deepEqual(await list(elsewhere), []);
  // settings.json is a link to a file of the user's: refused before any entry is written.
  const settings = await dirs(t);
  const victim = path.join(settings.directory, 'victim.json');
  await writeFile(victim, '{"keep":true}\n');
  await rm(path.join(settings.root, '.alp', 'settings.json'), { force: true });
  await symlink(victim, path.join(settings.root, '.alp', 'settings.json'));
  await assert.rejects(installPack('architecture', { scope: 'project', root: settings.root, library: settings.library }), { code: 'UNSAFE_PATH' });
  assert.equal(await readFile(victim, 'utf8'), '{"keep":true}\n');
  await assert.rejects(list(path.join(settings.root, '.alp', 'agents')), { code: 'ENOENT' });
  // A skill that is a link (the user's own, kept elsewhere) is kept, not written through.
  const own = await dirs(t);
  await seedLibrary(own.library);
  const mine = path.join(own.directory, 'my-backend');
  await mkdir(mine, { recursive: true });
  await symlink(mine, path.join(own.library, 'skills', 'backend-development'));
  const result = await installPack('backend', { scope: 'library', library: own.library });
  assert.deepEqual(result.kept.map(entry => entry.name), ['backend-development']);
  assert.deepEqual(await list(mine), []);
  // No staging directory is left behind.
  assert.ok(!(await list(own.library)).some(name => name.startsWith('.alp-pack-')));
});

test('a pack whose file paths are not plain relative names is refused', async t => {
  const { library } = await dirs(t);
  const templates = {
    'packs/evil/pack.json': JSON.stringify({ label: 'Evil', description: 'Escapes', skills: ['a'] }),
    'packs/evil/skills/a/SKILL.md': '---\nname: a\ndescription: "A. Use when testing."\n---\n\nBody.\n',
    'packs/evil/skills/a/../../../../escape.txt': 'pwned',
  };
  await assert.rejects(installPack('evil', { scope: 'library', library, templates }), { code: 'INVALID_PACK' });
  await assert.rejects(readFile(path.join(library, '..', 'escape.txt')), { code: 'ENOENT' });
});
