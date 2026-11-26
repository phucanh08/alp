// t-4b59: alp_skill_read returns a file only from the directory of one of the caller's own skills.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSkillFile, readsSkillsByTool, supervisorMayCall } from '@anhlp/alp-runtime';
import { teardown } from '../../../test/support/teardown.ts';

async function library(t: test.TestContext) {
  const defer = teardown(t);
  const dir = await mkdtemp(path.join(tmpdir(), 'alp-skill-files-'));
  defer(() => rm(dir, { recursive: true, force: true }));
  const skill = path.join(dir, 'home', 'skills', 'bug-loop');
  await mkdir(path.join(skill, 'references'), { recursive: true });
  await writeFile(path.join(skill, 'SKILL.md'), '---\nname: bug-loop\ndescription: Diagnose a bug.\n---\n# Bug loop\n');
  await writeFile(path.join(skill, 'references', 'test-proof.md'), 'proof\n');
  await writeFile(path.join(skill, '.notes'), 'hidden\n');
  // A skill the caller does not have, beside it in the same library.
  const other = path.join(dir, 'home', 'skills', 'xia');
  await mkdir(other, { recursive: true });
  await writeFile(path.join(other, 'SKILL.md'), '# xia\n');
  await writeFile(path.join(dir, 'secret.txt'), 'secret\n');
  return { dir, skill, skills: [{ name: 'bug-loop', path: path.join(skill, 'SKILL.md') }] };
}

test('returns SKILL.md by default with the skill\'s other files, and a reference by relative path', async t => {
  const { skills } = await library(t);
  const main = await readSkillFile(skills, { skill: 'bug-loop' });
  assert.ok(main.ok, JSON.stringify(main));
  assert.equal(main.value.file, 'SKILL.md');
  assert.match(main.value.content, /# Bug loop/);
  assert.deepEqual(main.value.files, ['references/test-proof.md']);
  const reference = await readSkillFile(skills, { skill: 'bug-loop', file: 'references/test-proof.md' });
  assert.ok(reference.ok);
  assert.equal(reference.value.content, 'proof\n');
  assert.equal(reference.value.files, undefined);
  assert.ok((await readSkillFile(skills, { skill: 'bug-loop', file: './references\\test-proof.md' })).ok);
});

test('refuses another skill, paths leaving the skill, hidden files, directories, links out and oversized or binary files', async t => {
  const { dir, skill, skills } = await library(t);
  const refused = async (args: unknown, pattern: RegExp, options?: { maxBytes?: number }) => {
    const result = await readSkillFile(skills, args, options);
    assert.equal(result.ok, false, JSON.stringify(args));
    if (!result.ok) assert.match(result.error, pattern);
  };
  await refused({ skill: 'xia' }, /'xia' is not one of your skills: bug-loop/);
  await refused({ skill: 'bug-loop', file: '../xia/SKILL.md' }, /stay inside skill 'bug-loop'/);
  await refused({ skill: 'bug-loop', file: '../../../secret.txt' }, /stay inside/);
  await refused({ skill: 'bug-loop', file: path.join(dir, 'secret.txt') }, /relative to the skill/);
  await refused({ skill: 'bug-loop', file: 'C:\\secret.txt' }, /relative to the skill/);
  await refused({ skill: 'bug-loop', file: '.notes' }, /Hidden/);
  await refused({ skill: 'bug-loop', file: 'references' }, /not a file/);
  await refused({ skill: 'bug-loop', file: 'missing.md' }, /has no file missing.md/);
  await refused({ skill: 'bug-loop', path: '/etc/hosts' }, /takes \{skill, file\?\}/);
  await refused({ skill: 'bug-loop', file: 'SKILL.md' }, /bytes; ALP returns at most 10/, { maxBytes: 10 });
  // A link inside the skill that leads out of it is refused; one that stays inside is followed.
  await symlink(path.join(dir, 'secret.txt'), path.join(skill, 'references', 'out.md'));
  await refused({ skill: 'bug-loop', file: 'references/out.md' }, /stay inside/);
  await symlink(path.join(skill, 'references', 'test-proof.md'), path.join(skill, 'references', 'alias.md'));
  assert.ok((await readSkillFile(skills, { skill: 'bug-loop', file: 'references/alias.md' })).ok);
  await writeFile(path.join(skill, 'references', 'blob.bin'), Buffer.from([1, 0, 2]));
  await refused({ skill: 'bug-loop', file: 'references/blob.bin' }, /binary/);
});

test('edge cases: a prefix sibling, a hidden directory, an empty file, a FIFO, a linked skill directory and a project skill', async t => {
  const { dir, skill, skills } = await library(t);
  const refused = async (list: typeof skills, args: unknown, pattern: RegExp) => {
    const result = await readSkillFile(list, args);
    assert.equal(result.ok, false, JSON.stringify(args));
    if (!result.ok) assert.match(result.error, pattern);
  };
  // A sibling whose name starts with the skill's own (bug-loop2) is outside it, reached through a link.
  await mkdir(path.join(dir, 'home', 'skills', 'bug-loop2'), { recursive: true });
  await writeFile(path.join(dir, 'home', 'skills', 'bug-loop2', 'x.md'), 'sibling\n');
  await symlink(path.join(dir, 'home', 'skills', 'bug-loop2', 'x.md'), path.join(skill, 'sibling.md'));
  await refused(skills, { skill: 'bug-loop', file: 'sibling.md' }, /stay inside skill 'bug-loop'/);
  await mkdir(path.join(skill, '.private'));
  await writeFile(path.join(skill, '.private', 'x.md'), 'hidden\n');
  await refused(skills, { skill: 'bug-loop', file: '.private/x.md' }, /Hidden/);
  await writeFile(path.join(skill, 'references', 'empty.md'), '');
  const empty = await readSkillFile(skills, { skill: 'bug-loop', file: 'references/empty.md' });
  assert.ok(empty.ok);
  assert.equal(empty.value.content, '');
  // A FIFO is refused without being opened, so the call cannot block.
  if (process.platform !== 'win32' && spawnSync('mkfifo', [path.join(skill, 'references', 'pipe.md')]).status === 0) {
    await refused(skills, { skill: 'bug-loop', file: 'references/pipe.md' }, /not a file/);
  }
  // A skill whose directory is itself a link (an installed skill) is read through the link.
  await symlink(skill, path.join(dir, 'linked'));
  const linked = await readSkillFile([{ name: 'bug-loop', path: path.join(dir, 'linked', 'SKILL.md') }], { skill: 'bug-loop', file: 'references/test-proof.md' });
  assert.ok(linked.ok, JSON.stringify(linked));
  // A project skill in .alp/skills is served the same way; the dot in its directory's path is not the file's.
  const project = path.join(dir, 'project', '.alp', 'skills', 'local');
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, 'SKILL.md'), '# local\n');
  const local = await readSkillFile([{ name: 'local', path: path.join(project, 'SKILL.md') }], { skill: 'local' });
  assert.ok(local.ok, JSON.stringify(local));
  assert.equal(local.value.content, '# local\n');
});

test('only Antigravity sessions with skills read them through the tool; a supervisor too, and nothing else new', () => {
  assert.equal(readsSkillsByTool('antigravity', [{}]), true);
  assert.equal(readsSkillsByTool('antigravity', []), false);
  for (const kind of ['claude', 'codex', 'acp']) assert.equal(readsSkillsByTool(kind, [{}]), false);
  assert.equal(supervisorMayCall('alp_skill_read', 'antigravity', [{}]), true);
  assert.equal(supervisorMayCall('alp_skill_read', 'antigravity', []), false);
  assert.equal(supervisorMayCall('alp_skill_read', 'claude', [{}]), false);
  for (const tool of ['alp_send', 'alp_board', 'alp_task']) assert.equal(supervisorMayCall(tool, 'claude', []), true);
  for (const tool of ['alp_pin', 'alp_delegate', 'alp_handoff']) assert.equal(supervisorMayCall(tool, 'antigravity', [{}]), false);
});
