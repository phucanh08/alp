// t-de1a: an edited role-skills.json is offered, on alp upgrade / update-template, the built-in role
// skills it never was (compact, curate); what was offered is recorded so a removal is respected, and
// nothing the user wrote is removed or reordered.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SHIPPED_ROLE_SKILLS, seedLibrary } from '../src/library.js';

const sha = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
const SHIPPED = await readFile(new URL('../../../templates/role-skills.json', import.meta.url), 'utf8');
const OLD = '8c5664042d4a4ecd3ded61240d8febbffa6e8965a88af0e9ba0420ad2f2ce8fe'; // before compact and curate
const WITH_COMPACT = 'b12b52102c358119cf834e5f3be54e6a69aa4c9f388fe889dffbb529755292dc';
const WITH_CURATE = 'a84b035d0058cbfcda7e32dc1706b9e83e67764eed24e2e121bdfcd60f924e46'; // before skill system v2
const V2_MAIN = ['skill-authoring', 'architecture-docs', 'feature-architecture', 'test-strategy', 'safe-refactor', 'security-review', 'release-readiness'];
const V2_PEER = ['feature-architecture', 'test-strategy', 'safe-refactor'];

async function home(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-offer-'));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
const roles = async dir => JSON.parse(await readFile(path.join(dir, 'role-skills.json'), 'utf8'));
const manifest = async dir => JSON.parse(await readFile(path.join(dir, 'library.json'), 'utf8'));
/** A library ALP last seeded with the role-skills.json of `version`, whose role-skills.json the user then edited to `edited`. */
async function editedLibrary(dir, version, edited) {
  await seedLibrary(dir);
  const recorded = await manifest(dir);
  recorded.files['role-skills.json'] = version;
  delete recorded.roleSkillsOffered;
  await writeFile(path.join(dir, 'library.json'), JSON.stringify(recorded, null, 2) + '\n');
  await writeFile(path.join(dir, 'role-skills.json'), JSON.stringify(edited, null, 2) + '\n');
}

test('the role-skills.json ALP ships now is in SHIPPED_ROLE_SKILLS, with what it gives', () => {
  assert.deepEqual(SHIPPED_ROLE_SKILLS[sha(SHIPPED)], Object.fromEntries(Object.entries(JSON.parse(SHIPPED)).filter(([, names]) => names.length)));
});

test('upgrade offers an edited file the new built-ins once; the user\'s own entries and order stay', async t => {
  const dir = await home(t);
  await editedLibrary(dir, OLD, { main: ['mine', 'xia'], peer: ['bug-loop'], custom: ['mine'] });
  // A session's seeding (no offer) leaves the edited file alone.
  assert.equal((await seedLibrary(dir)).offered, undefined);
  assert.deepEqual((await roles(dir)).main, ['mine', 'xia']);
  const { offered } = await seedLibrary(dir, { offerRoleSkills: true });
  assert.deepEqual(offered, ['main/compact', 'main/curate', 'main/skill-authoring', 'main/architecture-docs', 'main/feature-architecture', 'main/test-strategy', 'main/safe-refactor', 'main/security-review', 'main/release-readiness', 'peer/feature-architecture', 'peer/test-strategy', 'peer/safe-refactor']);
  assert.deepEqual(await roles(dir), { main: ['mine', 'xia', 'compact', 'curate', ...V2_MAIN], peer: ['bug-loop', ...V2_PEER], custom: ['mine'] });
  assert.ok((await manifest(dir)).roleSkillsOffered.includes('main/curate'));
  assert.equal((await manifest(dir)).files['role-skills.json'], OLD, 'the file stays the user\'s: later shipped versions do not overwrite it');
  // The user removes compact: the next upgrade respects it.
  await writeFile(path.join(dir, 'role-skills.json'), JSON.stringify({ main: ['mine', 'xia', 'curate', ...V2_MAIN], peer: ['bug-loop'], custom: ['mine'] }));
  assert.deepEqual((await seedLibrary(dir, { offerRoleSkills: true })).offered, []);
  assert.deepEqual((await roles(dir)).main, ['mine', 'xia', 'curate', ...V2_MAIN]);
});

test('before the record: a library last given the compact version is offered curate only, so a removed compact stays removed', async t => {
  const dir = await home(t);
  await editedLibrary(dir, WITH_COMPACT, { main: ['xia'] });
  assert.deepEqual((await seedLibrary(dir, { offerRoleSkills: true })).offered, ['main/curate', 'main/skill-authoring', 'main/architecture-docs', 'main/feature-architecture', 'main/test-strategy', 'main/safe-refactor', 'main/security-review', 'main/release-readiness']);
  assert.deepEqual(await roles(dir), { main: ['xia', 'curate', ...V2_MAIN] });
});

test('skill system v2: an edited library last given curate is offered the new engineering skills for the roles it lists, once', async t => {
  const dir = await home(t);
  await editedLibrary(dir, WITH_CURATE, { main: ['xia', 'curate'], lead: ['xia'], reviewer: [], custom: ['x'] });
  const { offered } = await seedLibrary(dir, { offerRoleSkills: true });
  assert.deepEqual(offered, [...V2_MAIN.map(name => `main/${name}`), ...['architecture-docs', 'feature-architecture', 'test-strategy', 'safe-refactor', 'security-review', 'release-readiness'].map(name => `lead/${name}`), 'reviewer/security-review', 'reviewer/release-readiness']);
  assert.deepEqual((await roles(dir)).custom, ['x']);
  assert.deepEqual((await roles(dir)).reviewer, ['security-review', 'release-readiness']);
  // Removing one afterwards is respected.
  await writeFile(path.join(dir, 'role-skills.json'), JSON.stringify({ main: ['xia'], lead: ['xia'], reviewer: [], custom: ['x'] }));
  assert.deepEqual((await seedLibrary(dir, { offerRoleSkills: true })).offered, []);
});

test('a role the user does not list gets nothing; a missing or broken file is left alone', async t => {
  const dir = await home(t);
  await editedLibrary(dir, OLD, { peer: ['xia'] });
  assert.deepEqual((await seedLibrary(dir, { offerRoleSkills: true })).offered, ['peer/feature-architecture', 'peer/test-strategy', 'peer/safe-refactor']);
  assert.deepEqual(await roles(dir), { peer: ['xia', ...V2_PEER] });
  assert.ok((await manifest(dir)).roleSkillsOffered.includes('main/compact'), 'offered, by the user\'s choice of roles');

  const broken = await home(t);
  await editedLibrary(broken, OLD, {});
  await writeFile(path.join(broken, 'role-skills.json'), '{ not json');
  assert.deepEqual((await seedLibrary(broken, { offerRoleSkills: true })).offered, []);
  assert.equal(await readFile(path.join(broken, 'role-skills.json'), 'utf8'), '{ not json');
  assert.equal((await manifest(broken)).roleSkillsOffered, undefined, 'offered again once the file can be read');
  await writeFile(path.join(broken, 'role-skills.json'), '{"main":["xia"]}');
  assert.deepEqual((await seedLibrary(broken, { offerRoleSkills: true })).offered, ['main/compact', 'main/curate', 'main/skill-authoring', 'main/architecture-docs', 'main/feature-architecture', 'main/test-strategy', 'main/safe-refactor', 'main/security-review', 'main/release-readiness']);

  const removed = await home(t);
  await editedLibrary(removed, OLD, {});
  await rm(path.join(removed, 'role-skills.json'));
  assert.deepEqual((await seedLibrary(removed, { offerRoleSkills: true })).offered, []);
  await assert.rejects(readFile(path.join(removed, 'role-skills.json')), { code: 'ENOENT' });
});

test('an unedited or fresh library needs no offer: the shipped file already gives them', async t => {
  const fresh = await home(t);
  assert.deepEqual((await seedLibrary(fresh, { offerRoleSkills: true })).offered, []);
  assert.equal(await readFile(path.join(fresh, 'role-skills.json'), 'utf8'), SHIPPED);
  // Unedited, last written as the old version: the normal update replaces it; nothing is added twice.
  const old = await home(t);
  await seedLibrary(old);
  const recorded = await manifest(old);
  const oldText = '{"main":["xia"]}\n';
  recorded.files['role-skills.json'] = sha(oldText);
  await writeFile(path.join(old, 'library.json'), JSON.stringify(recorded));
  await writeFile(path.join(old, 'role-skills.json'), oldText);
  const result = await seedLibrary(old, { offerRoleSkills: true });
  assert.deepEqual(result.updated, ['role-skills.json']);
  assert.deepEqual(result.offered, []);
  assert.equal(await readFile(path.join(old, 'role-skills.json'), 'utf8'), SHIPPED);
});

test('a shipped skill script with #! is executable where the library is seeded, and only it', async t => {
  if (process.platform === 'win32') return;
  const { mkdtemp, rm, stat } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const pathModule = (await import('node:path')).default;
  const { seedLibrary: seed } = await import('../src/library.js');
  const home = await mkdtemp(pathModule.join(tmpdir(), 'alp-seed-exec-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await seed(home, { templates: {
    'role-skills.json': '{}',
    'skills/demo/SKILL.md': '---\nname: demo\ndescription: "Demo. Use when testing."\n---\n',
    'skills/demo/scripts/run.mjs': '#!/usr/bin/env node\n',
    'skills/demo/scripts/lib.mjs': 'export {}\n',
    'skills/demo/references/x.md': '#!not a script\n',
  } });
  const mode = file => stat(pathModule.join(home, 'skills/demo', file)).then(info => info.mode & 0o111);
  assert.notEqual(await mode('scripts/run.mjs'), 0);
  assert.equal(await mode('scripts/lib.mjs'), 0);
  assert.equal(await mode('references/x.md'), 0);
});
