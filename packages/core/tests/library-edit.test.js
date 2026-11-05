import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '../src/init.js';
import { resolveAgent } from '../src/resolver.js';
import { resolveTeam } from '../src/teams.js';
import { deleteEntry, duplicateEntry, getEntry, listEntries, listRetiredSkills, renameEntry, restoreSkill, saveEntry, setGivenSkills } from '../src/library-edit.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-edit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function setup(t) {
  const [root, library] = [await fixture(t), await fixture(t)];
  await initProject(root);
  return { root, library, options: { root, library } };
}

test('saving an agent writes its files, and a stale revision is refused', async t => {
  const { root, library, options } = await setup(t);
  const created = await saveEntry('agents', 'writer', { instructions: 'Write docs', config: { description: 'Docs writer', model: 'claude:claude-sonnet-5-5' } }, { ...options, scope: 'library', revision: null });
  assert.equal(await readFile(path.join(library, 'agents/writer/AGENT.md'), 'utf8'), 'Write docs\n');
  assert.deepEqual(JSON.parse(await readFile(path.join(library, 'agents/writer/agent.json'), 'utf8')), { description: 'Docs writer', model: 'claude:claude-sonnet-5-5' });
  const entry = await getEntry('agents', 'writer', options);
  assert.deepEqual([entry.source, entry.revision, entry.content.instructions], ['library', created.revision, 'Write docs\n']);
  // Creating again, or saving over a change made since, is refused.
  await assert.rejects(saveEntry('agents', 'writer', { instructions: 'Other' }, { ...options, scope: 'library', revision: null }), { code: 'REVISION_CONFLICT' });
  const second = await saveEntry('agents', 'writer', { instructions: 'Write docs well' }, { ...options, scope: 'library', revision: entry.revision });
  await assert.rejects(saveEntry('agents', 'writer', { instructions: 'Lost update' }, { ...options, scope: 'library', revision: entry.revision }), /changed in the library since you opened it/);
  // An empty config is no agent.json.
  await assert.rejects(readFile(path.join(library, 'agents/writer/agent.json')), { code: 'ENOENT' });
  assert.equal((await resolveAgent(root, { agent: 'writer', library })).instructions.agent, 'Write docs well\n');
  assert.notEqual(second.revision, entry.revision);
  // No temporary files are left behind.
  assert.deepEqual(await readdir(path.join(library, 'agents/writer')), ['AGENT.md']);
});

test('built-ins are never written: duplicate one, or override it by name in the library or project', async t => {
  const { root, library, options } = await setup(t);
  const builtin = await getEntry('agents', 'main', options);
  assert.equal(builtin.source, 'builtin');
  assert.deepEqual(builtin.usedBy, ['project settings', 'team cafe', 'team pho']);
  await assert.rejects(saveEntry('agents', 'main', builtin.content, { ...options, scope: 'builtin' }), { code: 'INVALID_SCOPE' });
  await duplicateEntry('agents', 'main', 'main-copy', { ...options, scope: 'library' });
  assert.equal((await getEntry('agents', 'main-copy', options)).content.instructions, builtin.content.instructions);
  await saveEntry('agents', 'main', { instructions: 'My main' }, { ...options, scope: 'project', revision: null });
  const override = await getEntry('agents', 'main', options);
  assert.deepEqual([override.source, override.overrides], ['project', 'builtin']);
  // Removing the override is allowed though main is in use: the built-in takes over.
  assert.deepEqual(await deleteEntry('agents', 'main', { ...options, scope: 'project' }), { removed: true, now: 'builtin' });
  assert.equal((await resolveAgent(root, { library })).source, 'builtin');
  await duplicateEntry('teams', 'pho', 'my-pho', { ...options, scope: 'project' });
  const team = await resolveTeam(root, 'my-pho', { library });
  assert.deepEqual([team.source, team.label, team.houseRules], ['project', 'Phở', (await resolveTeam(root, 'pho')).houseRules]);
});

test('what an entry names must exist where it lives, and an entry in use is not removed', async t => {
  const { root, library, options } = await setup(t);
  await saveEntry('skills', 'style', { body: '# Style\n' }, { ...options, scope: 'project' });
  // A library agent cannot name a project skill: other projects would not have it.
  await assert.rejects(saveEntry('agents', 'writer', { instructions: 'W', config: { skills: ['style'] } }, { ...options, scope: 'library' }), /names 'style', which is not in the library/);
  await saveEntry('agents', 'writer', { instructions: 'W', config: { skills: ['style'] } }, { ...options, scope: 'project' });
  await saveEntry('mcp', 'docs', { server: { url: 'https://example.test/mcp' } }, { ...options, scope: 'library' });
  await saveEntry('hooks', 'tests', { hook: { event: 'handoff', command: 'npm test', blocking: true } }, { ...options, scope: 'library' });
  await saveEntry('agents', 'checker', { instructions: 'C', config: { mcp: ['docs'], hooks: ['tests'] } }, { ...options, scope: 'library' });
  await assert.rejects(deleteEntry('skills', 'style', { ...options, scope: 'project' }), /skills 'style' is used by agent writer; change them first/);
  await assert.rejects(deleteEntry('mcp', 'docs', { ...options, scope: 'library' }), /used by agent checker/);
  await assert.rejects(renameEntry('hooks', 'tests', 'checks', { ...options, scope: 'library' }), /used by agent checker/);
  // Bad definitions never reach the disk.
  await assert.rejects(saveEntry('mcp', 'broken', { server: { command: '' } }, { ...options, scope: 'library' }), { code: 'INVALID_MCP' });
  await assert.rejects(saveEntry('hooks', 'broken', { hook: { event: 'turn.end', command: 'x', blocking: true } }, { ...options, scope: 'library' }), { code: 'INVALID_HOOK' });
  await assert.rejects(saveEntry('agents', 'broken', { instructions: '' }, { ...options, scope: 'library' }), { code: 'INVALID_ENTRY' });
  await assert.rejects(saveEntry('agents', '../escape', { instructions: 'x' }, { ...options, scope: 'library' }), { code: 'INVALID_NAME' });
  assert.deepEqual(await readdir(path.join(library, 'mcp')), ['docs.json']);
  // A team names existing agents, and keeps the agents it names from being removed.
  const team = { label: 'Docs', main: 'writer', members: { writer: {}, checker: { role: 'reviewer' } }, delegation: { writer: ['checker'] } };
  await assert.rejects(saveEntry('teams', 'docs', { team: { ...team, members: { ...team.members, ghost: { role: 'peer' } } } }, { ...options, scope: 'project' }), /agent 'ghost' is not built in/);
  await saveEntry('teams', 'docs', { team, houseRules: 'Check every page.' }, { ...options, scope: 'project' });
  assert.equal((await resolveTeam(root, 'docs', { library })).houseRules, 'Check every page.');
  await assert.rejects(deleteEntry('agents', 'checker', { ...options, scope: 'library' }), /used by team docs/);
  await deleteEntry('teams', 'docs', { ...options, scope: 'project' });
  await deleteEntry('agents', 'checker', { ...options, scope: 'library' });
  await renameEntry('hooks', 'tests', 'checks', { ...options, scope: 'library' });
  assert.deepEqual((await listEntries('hooks', options)).map(row => [row.name, row.source]), [['checks', 'library']]);
  assert.deepEqual((await listEntries('teams', options)).map(row => row.name), ['pho', 'cafe']);
  await assert.rejects(deleteEntry('hooks', 'absent', { ...options, scope: 'library' }), { code: 'NOT_FOUND' });
});

test('the library gives an agent skills by name, so a built-in agent changes its skills without a copy', async t => {
  const { root, library, options } = await setup(t);
  for (const name of ['xia', 'bug-loop']) await saveEntry('skills', name, { body: `---\nname: ${name}\ndescription: d\n---\n` }, { ...options, scope: 'library', revision: null });
  await writeFile(path.join(library, 'role-skills.json'), JSON.stringify({ main: ['xia'], peer: ['bug-loop'] }));
  const main = await getEntry('agents', 'main', options);
  assert.deepEqual([main.source, main.librarySkills], ['builtin', ['xia']]);
  assert.deepEqual(await setGivenSkills('main', ['xia', 'bug-loop', 'xia'], { library }), { skills: ['xia', 'bug-loop'] });
  assert.deepEqual(JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8')), { main: ['xia', 'bug-loop'], peer: ['bug-loop'] });
  assert.deepEqual((await resolveAgent(root, { agent: 'main', library })).skills.map(skill => skill.name), ['bug-loop', 'xia']);
  // Still built in: no copy of main was made.
  assert.equal((await getEntry('agents', 'main', options)).source, 'builtin');
  await assert.rejects(setGivenSkills('main', ['missing'], { library }), /No skill 'missing' in the library/);
  await setGivenSkills('peer', [], { library });
  assert.deepEqual(JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8')), { main: ['xia', 'bug-loop'] });
});

for (const placement of ['scope', 'kind', 'entry', 'file']) {
  test(`library editor rejects ${placement} symlink before reading or mutating outside its scope`, async t => {
    const root = await fixture(t);
    const outside = await fixture(t);
    const scope = path.join(root, '.alp');
    const target = path.join(scope, 'skills', 'escape', 'SKILL.md');
    const linked = { scope, kind: path.join(scope, 'skills'), entry: path.dirname(target), file: target }[placement];
    const suffix = path.relative(linked, target);
    const external = suffix ? path.join(outside, suffix) : path.join(outside, 'secret');
    await mkdir(path.dirname(external), { recursive: true });
    await writeFile(external, 'private original');
    await mkdir(path.dirname(linked), { recursive: true });
    await symlink(placement === 'file' ? external : outside, linked);
    const options = { root, scope: 'project' };
    for (const operation of [
      () => getEntry('skills', 'escape', options),
      () => saveEntry('skills', 'escape', { body: 'overwrite' }, options),
      () => deleteEntry('skills', 'escape', options),
      () => renameEntry('skills', 'escape', 'moved', options),
      () => duplicateEntry('skills', 'escape', 'copied', options),
    ]) {
      await assert.rejects(operation(), { code: 'UNSAFE_PATH' });
      assert.equal(await readFile(external, 'utf8'), 'private original');
    }
  });
}


test('project-data mutations support pure project agents and skills only', async t => {
  const { root, options } = await setup(t);
  const safe = { ...options, scope: 'project', policy: 'project-data' };
  for (const [kind, content] of [['agents', { instructions: 'Write docs', config: { description: 'Writer', model: 'codex:gpt-6.1-sol' } }], ['skills', { body: 'Review docs' }]]) {
    const saved = await saveEntry(kind, 'remote-writer', content, { ...safe, revision: null });
    assert.ok(saved.revision);
    await saveEntry(kind, 'remote-writer', content, { ...safe, revision: saved.revision });
    await duplicateEntry(kind, 'remote-writer', 'remote-copy', safe);
    await renameEntry(kind, 'remote-copy', 'remote-renamed', safe);
    assert.equal((await getEntry(kind, 'remote-renamed', options)).source, 'project');
    await deleteEntry(kind, 'remote-renamed', safe);
    await deleteEntry(kind, 'remote-writer', safe);
  }
});

test('project-data rejects host writes, execution references, sidecars and fallback changes before mutation', async t => {
  const { root, library, options } = await setup(t);
  const safe = { ...options, scope: 'project', policy: 'project-data' };
  const denied = promise => assert.rejects(promise, { code: 'UNSAFE_LIBRARY_WRITE' });
  await denied(saveEntry('skills', 'remote', { body: 'text' }, { ...safe, scope: 'library' }));
  for (const kind of ['mcp', 'hooks', 'providers', 'teams']) await denied(saveEntry(kind, 'remote', {}, safe));
  for (const config of [{ hooks: [] }, { mcp: ['host-server'] }, { provider: 'host-command' }, { skills: [] }, { mode: 'full-access' }, { model: 'acp:host-command' }, { futureExec: true }]) {
    await denied(saveEntry('agents', 'remote', { instructions: 'text', config }, safe));
  }
  await saveEntry('agents', 'local-only', { instructions: 'old', config: { provider: 'codex' } }, { ...options, scope: 'project' });
  await denied(saveEntry('agents', 'local-only', { instructions: 'new' }, safe));
  await denied(duplicateEntry('agents', 'local-only', 'copy', safe));
  await denied(renameEntry('agents', 'local-only', 'renamed', safe));
  await denied(deleteEntry('agents', 'local-only', safe));
  assert.equal((await getEntry('agents', 'local-only', options)).content.instructions, 'old\n');
  await saveEntry('skills', 'has-assets', { body: 'old' }, safe);
  await writeFile(path.join(root, '.alp/skills/has-assets/run.sh'), 'executable sidecar');
  for (const mutate of [() => saveEntry('skills', 'has-assets', { body: 'new' }, safe), () => deleteEntry('skills', 'has-assets', safe), () => duplicateEntry('skills', 'has-assets', 'copy', safe), () => renameEntry('skills', 'has-assets', 'renamed', safe)]) await denied(mutate());
  assert.equal(await readFile(path.join(root, '.alp/skills/has-assets/run.sh'), 'utf8'), 'executable sidecar');
  await saveEntry('agents', 'host-agent', { instructions: 'host', config: { provider: 'codex' } }, { ...options, scope: 'library' });
  await denied(saveEntry('agents', 'host-agent', { instructions: 'override' }, safe));
  await saveEntry('agents', 'host-agent', { instructions: 'project' }, { ...options, scope: 'project' });
  await denied(deleteEntry('agents', 'host-agent', safe));
  await denied(renameEntry('agents', 'host-agent', 'renamed', safe));
  await denied(duplicateEntry('agents', 'host-agent', 'copy', safe));
  await denied(saveEntry('agents', 'main', { instructions: 'builtin override' }, safe));
  // Destination collisions in lower layers are refused too.
  await saveEntry('agents', 'safe-source', { instructions: 'pure' }, safe);
  await denied(duplicateEntry('agents', 'safe-source', 'host-agent', safe));
  await denied(renameEntry('agents', 'safe-source', 'main', safe));
});

test('a retired skill is listed and restored to its recorded roles, or to --roles for an old retirement', async t => {
  const library = await fixture(t);
  const retired = path.join(library, 'retired-skills');
  const write = async (folder, meta) => {
    await mkdir(path.join(retired, folder), { recursive: true });
    await writeFile(path.join(retired, folder, 'SKILL.md'), `# ${folder}\n`);
    if (meta) await writeFile(path.join(retired, folder, 'retired.json'), JSON.stringify(meta));
  };
  await write('style-2026-10-01T00-00-00-000Z', { name: 'style', roles: ['peer'], retiredAt: '2026-10-01T00:00:00.000Z', agent: 'main', path: '/x' });
  await write('style-2026-11-01T00-00-00-000Z', { name: 'style', roles: ['main', 'lead'], retiredAt: '2026-11-01T00:00:00.000Z', agent: 'lead', path: '/x' });
  await write('old-2026-09-01T10-20-30-400Z');
  await mkdir(path.join(retired, 'not-a-retirement'));
  await writeFile(path.join(library, 'role-skills.json'), JSON.stringify({ main: ['xia'] }));

  const rows = await listRetiredSkills({ library });
  assert.deepEqual(rows.map(row => [row.name, row.retiredAt, row.roles, row.agent]), [
    ['style', '2026-11-01T00:00:00.000Z', ['main', 'lead'], 'lead'],
    ['style', '2026-10-01T00:00:00.000Z', ['peer'], 'main'],
    ['old', '2026-09-01T10:20:30.400Z', null, null],
  ]);
  assert.deepEqual(await listRetiredSkills({ library: await fixture(t) }), []);

  // The newest copy, back to its recorded roles; retired.json does not come along.
  const restored = await restoreSkill('style', { library });
  assert.deepEqual(restored.roles, ['main', 'lead']);
  assert.equal(restored.from, path.join(retired, 'style-2026-11-01T00-00-00-000Z'));
  assert.equal(await readFile(path.join(library, 'skills/style/SKILL.md'), 'utf8'), '# style-2026-11-01T00-00-00-000Z\n');
  assert.deepEqual(await readdir(path.join(library, 'skills/style')), ['SKILL.md']);
  assert.deepEqual(JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8')), { main: ['xia', 'style'], lead: ['style'] });

  // The library already has it: refused, nothing moves.
  await assert.rejects(restoreSkill('style', { library }), error => error.code === 'ALREADY_EXISTS');
  assert.equal(rows.length, 3);
  assert.equal((await listRetiredSkills({ library })).length, 2);

  // An old retirement records no roles: --roles or --no-roles is required.
  await assert.rejects(restoreSkill('old', { library }), error => error.code === 'ROLES_REQUIRED' && /--roles/.test(error.message));
  assert.ok(await readFile(path.join(retired, 'old-2026-09-01T10-20-30-400Z/SKILL.md'), 'utf8'));
  assert.deepEqual((await restoreSkill('old', { library, roles: [] })).roles, []);
  assert.deepEqual(JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8')), { main: ['xia', 'style'], lead: ['style'] });

  // --from picks a copy; --roles replaces the recorded roles.
  await rm(path.join(library, 'skills/style'), { recursive: true });
  const older = path.join(retired, 'style-2026-10-01T00-00-00-000Z');
  assert.deepEqual((await restoreSkill('style', { library, from: older, roles: ['reviewer'] })).roles, ['reviewer']);
  assert.equal(await readFile(path.join(library, 'skills/style/SKILL.md'), 'utf8'), '# style-2026-10-01T00-00-00-000Z\n');
  await assert.rejects(restoreSkill('nope', { library }), error => error.code === 'NOT_FOUND');
  await assert.rejects(restoreSkill('../x', { library, roles: [] }), error => error.code === 'INVALID_NAME');
});

test('a corrupt retired.json does not block other retired skills, a symlink --from is refused, and a restore that fails changes nothing', async t => {
  const library = await fixture(t);
  const retired = path.join(library, 'retired-skills');
  const write = async (folder, metaText) => {
    await mkdir(path.join(retired, folder), { recursive: true });
    await writeFile(path.join(retired, folder, 'SKILL.md'), `# ${folder}\n`);
    if (metaText !== undefined) await writeFile(path.join(retired, folder, 'retired.json'), metaText);
  };
  await write('bad-2026-10-01T00-00-00-000Z', '{not json');
  await write('good-2026-10-02T00-00-00-000Z', JSON.stringify({ name: 'good', roles: ['peer'] }));

  const rows = await listRetiredSkills({ library });
  assert.deepEqual(rows.map(row => [row.name, row.roles, Boolean(row.invalid)]), [['good', ['peer'], false], ['bad', null, true]]);
  // The corrupt copy needs explicit roles; with them it restores.
  await assert.rejects(restoreSkill('bad', { library }), error => error.code === 'INVALID_LIBRARY');
  assert.deepEqual((await restoreSkill('bad', { library, roles: [] })).roles, []);

  // --from must not be a symlink.
  const link = path.join(library, 'link');
  await symlink(path.join(retired, 'good-2026-10-02T00-00-00-000Z'), link);
  await assert.rejects(restoreSkill('good', { library, from: link }), error => error.code === 'INVALID_ENTRY');

  // role-skills.json is unreadable (a directory in its place): nothing moves.
  await rm(path.join(library, 'role-skills.json'), { force: true });
  await mkdir(path.join(library, 'role-skills.json'));
  await assert.rejects(restoreSkill('good', { library }));
  assert.ok(await readFile(path.join(retired, 'good-2026-10-02T00-00-00-000Z/SKILL.md'), 'utf8'));
  assert.ok(await readFile(path.join(retired, 'good-2026-10-02T00-00-00-000Z/retired.json'), 'utf8'));
  assert.equal((await readdir(path.join(library, 'skills'))).includes('good'), false);
});

test('copying a skill copies its whole directory, bytes and executable bits kept, and never a link', async t => {
  const { root, library, options } = await setup(t);
  const { chmod, stat } = await import('node:fs/promises');
  const source = path.join(library, 'skills', 'packer');
  await mkdir(path.join(source, 'references'), { recursive: true });
  await mkdir(path.join(source, 'scripts'), { recursive: true });
  await mkdir(path.join(source, 'assets'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: packer\ndescription: "Pack things. Use when packing."\n---\n\nSee [references/a.md](references/a.md).\n');
  await writeFile(path.join(source, 'references', 'a.md'), '# A\n');
  await writeFile(path.join(source, 'scripts', 'run.mjs'), '#!/usr/bin/env node\nconsole.log(1)\n');
  await chmod(path.join(source, 'scripts', 'run.mjs'), 0o755);
  const bytes = Buffer.from([0, 255, 1, 128]);
  await writeFile(path.join(source, 'assets', 'blob.bin'), bytes);
  await duplicateEntry('skills', 'packer', 'packer-copy', { ...options, scope: 'project' });
  const copy = path.join(root, '.alp', 'skills', 'packer-copy');
  assert.equal(await readFile(path.join(copy, 'references', 'a.md'), 'utf8'), '# A\n');
  assert.deepEqual(await readFile(path.join(copy, 'assets', 'blob.bin')), bytes);
  if (process.platform !== 'win32') assert.equal((await stat(path.join(copy, 'scripts', 'run.mjs'))).mode & 0o777, 0o755);
  // A link inside the source is refused before anything is written.
  await symlink(path.join(source, 'references', 'a.md'), path.join(source, 'references', 'b.md'));
  await assert.rejects(duplicateEntry('skills', 'packer', 'linked', { ...options, scope: 'library' }), { code: 'UNSAFE_LIBRARY_WRITE' });
  await assert.rejects(readdir(path.join(library, 'skills', 'linked')), { code: 'ENOENT' });
});

test('copying or renaming a skill sets its frontmatter name to the new directory (P0)', async t => {
  const { withSkillName } = await import('../src/library-edit.js');
  assert.equal(withSkillName('---\nname: "old"\ndescription: "D. Use when x."\n---\nBody\n', 'new'), '---\nname: new\ndescription: "D. Use when x."\n---\nBody\n');
  assert.equal(withSkillName('---\r\ndescription: x\r\n---\r\nBody\r\n', 'new'), '---\r\nname: new\r\ndescription: x\r\n---\r\nBody\r\n', 'a missing name is added, line endings kept');
  assert.equal(withSkillName('# No frontmatter\n', 'new'), '# No frontmatter\n', 'a legacy skill is left as it is');
  const { root, library, options } = await setup(t);
  const { validateSkill } = await import('../src/skill-validate.js');
  const source = path.join(library, 'skills', 'review-api');
  await mkdir(path.join(source, 'references'), { recursive: true });
  await writeFile(path.join(source, 'SKILL.md'), '---\nname: review-api\ndescription: "Review an API change. Use when an endpoint changes."\n---\n\nSee [references/a.md](references/a.md).\n');
  await writeFile(path.join(source, 'references', 'a.md'), '# A\n');
  await duplicateEntry('skills', 'review-api', 'review-api-v2', { ...options, scope: 'library' });
  const copy = path.join(library, 'skills', 'review-api-v2');
  assert.match(await readFile(path.join(copy, 'SKILL.md'), 'utf8'), /^---\nname: review-api-v2\n/);
  assert.deepEqual((await validateSkill(copy, { mode: 'strict' })).errors, []);
  assert.match(await readFile(path.join(source, 'SKILL.md'), 'utf8'), /^---\nname: review-api\n/, 'the source is unchanged');
  await renameEntry('skills', 'review-api-v2', 'api-review', { ...options, scope: 'library' });
  const moved = path.join(library, 'skills', 'api-review');
  assert.match(await readFile(path.join(moved, 'SKILL.md'), 'utf8'), /^---\nname: api-review\n/);
  assert.deepEqual((await validateSkill(moved, { mode: 'strict' })).errors, []);
  assert.equal(await readFile(path.join(moved, 'references', 'a.md'), 'utf8'), '# A\n');
  // A name the format refuses is refused for a skill in the format, and nothing is written.
  await assert.rejects(duplicateEntry('skills', 'api-review', 'Api_Review', { ...options, scope: 'project' }), { code: 'INVALID_NAME' });
  await assert.rejects(renameEntry('skills', 'api-review', 'API', { ...options, scope: 'library' }), { code: 'INVALID_NAME' });
  await assert.rejects(readdir(path.join(root, '.alp', 'skills', 'Api_Review')), { code: 'ENOENT' });
  // A legacy skill without frontmatter still copies under any valid entry name.
  await mkdir(path.join(library, 'skills', 'Old_Notes'), { recursive: true });
  await writeFile(path.join(library, 'skills', 'Old_Notes', 'SKILL.md'), 'Just notes.\n');
  await duplicateEntry('skills', 'Old_Notes', 'Old_Notes_2', { ...options, scope: 'library' });
  assert.equal(await readFile(path.join(library, 'skills', 'Old_Notes_2', 'SKILL.md'), 'utf8'), 'Just notes.\n');
});

test('a new skill saved strictly (the CLI) meets the format; editing an existing legacy skill still works (P1)', async t => {
  const { library, options } = await setup(t);
  const scope = { ...options, scope: 'library' };
  await assert.rejects(saveEntry('skills', 'plain', { body: 'No frontmatter\n' }, { ...scope, revision: null, strict: true }), { code: 'INVALID_ENTRY', message: /no YAML frontmatter/ });
  await assert.rejects(saveEntry('skills', 'named', { body: '---\nname: other\ndescription: "D. Use when x."\n---\nB\n' }, { ...scope, revision: null, strict: true }), { message: /differs from its directory/ });
  await assert.rejects(saveEntry('skills', 'keys', { body: '---\nname: keys\ndescription: "D. Use when x."\ncolor: red\n---\nB\n' }, { ...scope, revision: null, strict: true }), { message: /unknown frontmatter key 'color'/ });
  const saved = await saveEntry('skills', 'linked', { body: '---\nname: linked\ndescription: "Linked. Use when testing links."\n---\nSee [references/x.md](references/x.md).\n' }, { ...scope, revision: null, strict: true });
  assert.match(saved.warnings[0], /SKILL\.md points to references\/x\.md: add that file beside it/);
  // Without strict (programmatic callers, the settings screen) and for edits, nothing changes.
  await saveEntry('skills', 'legacy', { body: 'Legacy body\n' }, { ...scope, revision: null });
  const entry = await getEntry('skills', 'legacy', scope);
  await saveEntry('skills', 'legacy', { body: 'Edited legacy body\n' }, { ...scope, revision: entry.revision, strict: true });
  assert.equal(await readFile(path.join(library, 'skills', 'legacy', 'SKILL.md'), 'utf8'), 'Edited legacy body\n');
});

test('retired metadata IO errors stay isolated to their entry', async t => {
  const library = await fixture(t);
  for (const name of ['bad', 'good']) {
    const directory = path.join(library, 'retired-skills', `${name}-2026-10-01T00-00-00-000Z`);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'SKILL.md'), name);
    if (name === 'bad') await mkdir(path.join(directory, 'retired.json'));
    else await writeFile(path.join(directory, 'retired.json'), JSON.stringify({ name, roles: [] }));
  }
  const rows = await listRetiredSkills({ library });
  assert.equal(rows.length, 2);
  assert.match(rows.find(row => row.name === 'bad').invalid, /EISDIR|illegal operation/i);
  assert.deepEqual(rows.find(row => row.name === 'good').roles, []);
  await assert.rejects(restoreSkill('bad', { library }), { code: 'EISDIR' });
});

test('restore serializes __proto__ as an own role key', async t => {
  const library = await fixture(t);
  const directory = path.join(library, 'retired-skills', 'safe-2026-10-01T00-00-00-000Z');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), 'safe');
  await restoreSkill('safe', { library, roles: ['__proto__'] });
  const roles = JSON.parse(await readFile(path.join(library, 'role-skills.json'), 'utf8'));
  assert.equal(Object.hasOwn(roles, '__proto__'), true);
  assert.deepEqual(roles.__proto__, ['safe']);
});

test('restore rolls back an atomic roles write failure AFTER moving the skill', async t => {
  const fs = await import('node:fs');
  const { syncBuiltinESMExports } = await import('node:module');
  const library = await fixture(t);
  const directory = path.join(library, 'retired-skills', 'safe-2026-10-01T00-00-00-000Z');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'SKILL.md'), 'safe');
  const metadata = JSON.stringify({ name: 'safe', roles: ['peer'] });
  await writeFile(path.join(directory, 'retired.json'), metadata);
  const rolesFile = path.join(library, 'role-skills.json');
  await writeFile(rolesFile, '{"main":["existing"]}\n');
  const rename = fs.promises.rename;
  let moved = false, failed = false;
  fs.promises.rename = async (from, to) => {
    if (from === directory) moved = true;
    if (to === rolesFile && !failed) {
      assert.equal(moved, true);
      failed = true;
      throw Object.assign(new Error('injected post-move write failure'), { code: 'EIO' });
    }
    return rename(from, to);
  };
  syncBuiltinESMExports();
  try { await assert.rejects(restoreSkill('safe', { library }), /injected post-move/); }
  finally { fs.promises.rename = rename; syncBuiltinESMExports(); }
  assert.equal(failed, true);
  assert.equal(await readFile(path.join(directory, 'SKILL.md'), 'utf8'), 'safe');
  assert.equal(await readFile(path.join(directory, 'retired.json'), 'utf8'), metadata);
  assert.equal(await readFile(rolesFile, 'utf8'), '{"main":["existing"]}\n');
  await assert.rejects(readFile(path.join(library, 'skills/safe/SKILL.md')), { code: 'ENOENT' });
});
