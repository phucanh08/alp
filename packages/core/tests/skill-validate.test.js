import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseFrontmatter, skillReferences, specName, validateSkill } from '@anhlp/alp-core/skill-validate';

async function skill(t, name, files) {
  const root = await mkdtemp(path.join(tmpdir(), 'alp-skill-validate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, name);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  await mkdir(dir, { recursive: true });
  return dir;
}
const good = '---\nname: api-review\ndescription: "Review an HTTP API change for compatibility. Use when an endpoint, schema or status code changes."\n---\n\n# API review\n\nRead [references/rules.md](references/rules.md) when checking status codes.\n';
const codes = list => list.map(finding => finding.code).sort();

test('specification names: lowercase, digits, single hyphens, at most 64 characters', () => {
  for (const name of ['a', 'bug-loop', 'x1-2y']) assert.ok(specName(name), name);
  for (const name of ['', 'Bug', 'bug_loop', '-a', 'a-', 'a--b', 'a.b', 'x'.repeat(65)]) assert.ok(!specName(name), name);
});

test('the frontmatter parser reads plain, quoted, folded and nested values and reports unsupported YAML', () => {
  const { data, problems } = parseFrontmatter([
    'name: demo', 'description: >-', '  Folded across', '  two lines.', "license: 'Apache-2.0'",
    'metadata:', '  owner: "team a"', '  tier: core', '# a comment', 'compatibility: "Node 22: any OS"',
  ].join('\n'));
  assert.deepEqual(problems, []);
  assert.deepEqual(data, { name: 'demo', description: 'Folded across two lines.', license: 'Apache-2.0', metadata: { owner: 'team a', tier: 'core' }, compatibility: 'Node 22: any OS' });
  assert.match(parseFrontmatter('description: Use when: a colon').problems[0], /quote the value/);
  assert.match(parseFrontmatter('allowed-tools: [Read, Grep]').problems[0], /unsupported YAML/);
  assert.match(parseFrontmatter('name: a\nname: b').problems[0], /duplicate/);
});

test('references are link targets and references/ code spans, not URLs, anchors or fenced examples', () => {
  const found = skillReferences('[a](references/a.md) `references/b.md` `scripts/run.mjs` [u](https://x.test) [h](#top) [s](scripts/run.mjs#L2)\n```\n[z](z.md)\n```\n');
  assert.deepEqual(found.sort(), ['references/a.md', 'references/b.md', 'scripts/run.mjs']);
});

test('a well-formed skill passes strict validation', async t => {
  const dir = await skill(t, 'api-review', { 'SKILL.md': good, 'references/rules.md': '# Rules\n' });
  const report = await validateSkill(dir, { mode: 'strict', shipped: true });
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.deepEqual(report.warnings, []);
});

test('format problems are errors in strict mode and warnings with hints in legacy mode', async t => {
  const dir = await skill(t, 'Old_Skill', { 'SKILL.md': '---\nname: other\ndescription: x\ncolor: blue\n---\n\nSee [missing](references/missing.md).\n' });
  const strict = await validateSkill(dir, { mode: 'strict' });
  assert.equal(strict.ok, false);
  assert.deepEqual(codes(strict.errors), ['BROKEN_REFERENCE', 'DIRECTORY_NAME', 'NAME_DIRECTORY', 'UNKNOWN_KEY']);
  const legacy = await validateSkill(dir);
  assert.equal(legacy.ok, true);
  assert.deepEqual(codes(legacy.warnings), ['BROKEN_REFERENCE', 'DESCRIPTION_SHORT', 'DESCRIPTION_TRIGGER', 'DIRECTORY_NAME', 'NAME_DIRECTORY', 'UNKNOWN_KEY']);
  const noFront = await validateSkill(await skill(t, 'plain', { 'SKILL.md': '# Just instructions\n' }));
  assert.deepEqual(codes(noFront.warnings), ['NO_FRONTMATTER']);
  assert.deepEqual(codes((await validateSkill(path.dirname(dir) + '/nothing')).errors), ['NOT_FOUND']);
  assert.deepEqual(codes((await validateSkill(await skill(t, 'empty', { 'skill.md': good }))).errors), ['SKILL_MD_MISSING']);
});

test('a symlink leaving the skill is an error in every mode; a path leaving it, only for new skills', async t => {
  const dir = await skill(t, 'escape', { 'SKILL.md': good.replace('references/rules.md)', '../outside.md)').replace('api-review', 'escape') + '\nAlso [abs](/etc/passwd).\n' });
  await writeFile(path.join(path.dirname(dir), 'outside.md'), 'secret');
  await mkdir(path.join(dir, 'references'), { recursive: true });
  await symlink(path.join(path.dirname(dir), 'outside.md'), path.join(dir, 'references', 'leak.md'));
  await symlink(path.join(dir, 'nowhere'), path.join(dir, 'references', 'dangling.md'));
  const legacy = await validateSkill(dir);
  assert.deepEqual(codes(legacy.errors), ['BROKEN_SYMLINK', 'UNSAFE_SYMLINK']);
  assert.deepEqual(codes(legacy.warnings), ['ABSOLUTE_REFERENCE', 'REFERENCE_OUTSIDE']);
  const strict = codes((await validateSkill(dir, { mode: 'strict' })).errors);
  for (const code of ['ABSOLUTE_REFERENCE', 'REFERENCE_OUTSIDE', 'BROKEN_SYMLINK', 'UNSAFE_SYMLINK']) assert.ok(strict.includes(code), code);
  // A link through a symlink that leaves the skill is an error even in legacy mode.
  await writeFile(path.join(dir, 'SKILL.md'), '---\nname: escape\ndescription: "Escape. Use when testing."\n---\n\nSee [leak](references/leak.md).\n');
  assert.ok(codes((await validateSkill(dir)).errors).includes('REFERENCE_OUTSIDE'));
});

test('shipped skills must be text; a script with #! should be executable', async t => {
  const dir = await skill(t, 'api-review', { 'SKILL.md': good, 'references/rules.md': '# Rules\n', 'assets/logo.bin': Buffer.from([0, 1, 2, 255]), 'scripts/run.mjs': '#!/usr/bin/env node\n' });
  assert.deepEqual(codes((await validateSkill(dir, { mode: 'strict', shipped: true })).errors), ['SHIPPED_BINARY']);
  const user = await validateSkill(dir, { mode: 'strict' });
  assert.equal(user.ok, true);
  if (process.platform !== 'win32') {
    assert.deepEqual(codes(user.warnings), ['SCRIPT_NOT_EXECUTABLE']);
    await chmod(path.join(dir, 'scripts/run.mjs'), 0o755);
    assert.deepEqual((await validateSkill(dir, { mode: 'strict' })).warnings, []);
  }
});

test('long descriptions are clipped in the index, and allowed-tools never grants permissions', async t => {
  const long = `Use when reviewing. ${'x'.repeat(420)}`;
  const dir = await skill(t, 'wordy', { 'SKILL.md': `---\nname: wordy\ndescription: "${long}"\nallowed-tools: Read Grep\n---\n\nBody.\n` });
  assert.deepEqual(codes((await validateSkill(dir, { mode: 'strict' })).warnings), ['ALLOWED_TOOLS_ADVISORY', 'DESCRIPTION_CLIPPED']);
});

test('every skill ALP ships, core and optional packs, passes strict validation', async () => {
  const { readdir } = await import('node:fs/promises');
  const { shippedTemplateRoot } = await import('@anhlp/alp-core/template-path');
  const root = new URL('../../../templates/', import.meta.url).pathname;
  const dirs = async parent => (await readdir(parent, { withFileTypes: true }).catch(() => [])).filter(e => e.isDirectory()).map(e => path.join(parent, e.name));
  const packs = await dirs(path.join(root, 'packs'));
  const skills = [...await dirs(path.join(root, 'skills')), ...(await Promise.all(packs.map(pack => dirs(path.join(pack, 'skills'))))).flat()];
  assert.ok(skills.length >= 8 && shippedTemplateRoot());
  for (const dir of skills) {
    const report = await validateSkill(dir, { mode: 'strict', shipped: true });
    assert.deepEqual(report.errors, [], `${dir}: ${JSON.stringify(report.errors)}`);
  }
});

test('odd input becomes a finding, never a crash: a malformed % in a link, an indentation indicator', async t => {
  const dir = await skill(t, 'odd', { 'SKILL.md': '---\nname: odd\ndescription: |2\n  Use when odd.\n---\n\nSee [100%](100%) and [ok](references/a%20b.md).\n', 'references/a b.md': '# A\n' });
  const report = await validateSkill(dir, { mode: 'strict' });
  assert.deepEqual(codes(report.errors), ['BROKEN_REFERENCE', 'YAML']);
});
