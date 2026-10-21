import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, chmod, access, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { user_worktree } from '@anhlp/alp-core';

const git = (cwd, ...args) =>
  execFileSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
    cwd,
    env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8'
  }).trim();
test('user worktree uses generated identity, runs no hooks/filters/PATH traps, refuses data and keeps branch', async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-user-worktree-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo'),
    parent = path.join(root, 'dest');
  await mkdir(repo);
  await mkdir(parent);
  git(repo, 'init', '-q');
  await writeFile(path.join(repo, 'file'), 'content\n');
  await writeFile(path.join(repo, '.gitattributes'), 'file filter=trap\n');
  git(repo, 'add', '.');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'initial');
  const trap = path.join(root, 'TRAP'),
    hook = path.join(repo, '.git', 'hooks', 'post-checkout');
  await writeFile(hook, `#!/bin/sh\ntouch '${trap}'\n`);
  await chmod(hook, 0o700);
  git(repo, 'config', 'filter.trap.smudge', `touch '${trap}'`);
  git(repo, 'config', 'filter.trap.process', `touch '${trap}'`);
  git(repo, 'config', 'filter.trap.required', 'true');
  git(repo, 'config', 'core.fsmonitor', `touch '${trap}'`);
  const conditional = path.join(root, 'conditional');
  await writeFile(
    conditional,
    `[filter "target-only"]\n smudge = touch '${trap}'\n process = touch '${trap}'\n required = true\n`
  );
  git(repo, 'config', 'includeIf.onbranch:alp/workspace/**.path', conditional);
  await writeFile(path.join(repo, '.gitattributes'), 'file filter=target-only\n');
  git(repo, 'add', '.gitattributes');
  git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'conditional');
  const adapter = user_worktree.userWorktreeGit();
  const facts = await adapter.facts(repo);
  const name = 'wks_0123456789abcdef',
    branch = `alp/workspace/${name}`;
  const target = await adapter.create(repo, parent, name, branch, facts.head);
  assert.equal(git(target, 'branch', '--show-current'), branch);
  assert.ok(await adapter.inspect(repo, target, branch));
  await assert.rejects(access(trap));
  await assert.rejects(adapter.create(repo, parent, '../escape', 'arbitrary', facts.head));
  await writeFile(path.join(target, 'untracked'), 'keep');
  await assert.rejects(adapter.remove(repo, target, branch));
  await access(path.join(target, 'untracked'));
  await assert.rejects(access(trap));
  await rm(path.join(target, 'untracked'));
  await writeFile(path.join(target, '.gitignore'), 'ignored\n');
  await assert.rejects(adapter.remove(repo, target, branch));
  await rm(path.join(target, '.gitignore'));
  await writeFile(path.join(target, 'file'), 'hidden\n');
  git(target, 'update-index', '--assume-unchanged', 'file');
  await assert.rejects(adapter.remove(repo, target, branch), /hidden index/);
  await access(path.join(target, 'file'));
  git(target, 'update-index', '--no-assume-unchanged', 'file');
  await writeFile(path.join(target, 'file'), 'content\n');
  await writeFile(path.join(repo, '.git', 'info', 'exclude'), 'ignored\n');
  await writeFile(path.join(target, 'ignored'), 'keep');
  await assert.rejects(adapter.remove(repo, target, branch));
  await access(path.join(target, 'ignored'));
  await rm(path.join(target, 'ignored'));
  await adapter.remove(repo, target, branch);
  await assert.rejects(access(target));
  assert.equal(git(repo, 'rev-parse', `refs/heads/${branch}`), facts.head);
  await assert.rejects(access(trap));
  const alias = path.join(root, 'alias');
  await symlink(parent, alias);
  await assert.rejects(adapter.create(repo, alias, name, branch, facts.head));
});

test('bounded Git kills the whole process group before delayed descendants can write', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX process groups');
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-git-timeout-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fake = path.join(root, 'host-git'),
    marker = path.join(root, 'late-write');
  await writeFile(fake, `#!/bin/sh\n(/bin/sleep 1; /usr/bin/touch '${marker}') &\nwait\n`);
  await chmod(fake, 0o700);
  const adapter = user_worktree.userWorktreeGit({ executable: fake, timeoutMs: 50 });
  await assert.rejects(adapter.facts(root), /host limit/);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  await assert.rejects(access(marker));
});
