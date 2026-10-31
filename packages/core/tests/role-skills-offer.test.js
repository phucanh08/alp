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
  assert.deepEqual(offered, ['main/compact', 'main/curate']);
  assert.deepEqual(await roles(dir), { main: ['mine', 'xia', 'compact', 'curate'], peer: ['bug-loop'], custom: ['mine'] });
  assert.ok((await manifest(dir)).roleSkillsOffered.includes('main/curate'));
  assert.equal((await manifest(dir)).files['role-skills.json'], OLD, 'the file stays the user\'s: later shipped versions do not overwrite it');
  // The user removes compact: the next upgrade respects it.
  await writeFile(path.join(dir, 'role-skills.json'), JSON.stringify({ main: ['mine', 'xia', 'curate'], peer: ['bug-loop'], custom: ['mine'] }));
  assert.deepEqual((await seedLibrary(dir, { offerRoleSkills: true })).offered, []);
  assert.deepEqual((await roles(dir)).main, ['mine', 'xia', 'curate']);
});

test('before the record: a library last given the compact version is offered curate only, so a removed compact stays removed', async t => {
  const dir = await home(t);
  await editedLibrary(dir, WITH_COMPACT, { main: ['xia'] });
  assert.deepEqual((await seedLibrary(dir, { offerRoleSkills: true })).offered, ['main/curate']);
  assert.deepEqual(await roles(dir), { main: ['xia', 'curate'] });
});

test('a role the user does not list gets nothing; a missing or broken file is left alone', async t => {
  const dir = await home(t);
  await editedLibrary(dir, OLD, { peer: ['xia'] });
  assert.deepEqual((await seedLibrary(dir, { offerRoleSkills: true })).offered, []);
  assert.deepEqual(await roles(dir), { peer: ['xia'] });
  assert.ok((await manifest(dir)).roleSkillsOffered.includes('main/compact'), 'offered, by the user\'s choice of roles');

  const broken = await home(t);
  await editedLibrary(broken, OLD, {});
  await writeFile(path.join(broken, 'role-skills.json'), '{ not json');
  assert.deepEqual((await seedLibrary(broken, { offerRoleSkills: true })).offered, []);
  assert.equal(await readFile(path.join(broken, 'role-skills.json'), 'utf8'), '{ not json');
  assert.equal((await manifest(broken)).roleSkillsOffered, undefined, 'offered again once the file can be read');
  await writeFile(path.join(broken, 'role-skills.json'), '{"main":["xia"]}');
  assert.deepEqual((await seedLibrary(broken, { offerRoleSkills: true })).offered, ['main/compact', 'main/curate']);

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
