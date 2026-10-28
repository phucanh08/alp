import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, link, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WORKSPACE_GIT } from '@anhlp/alp-protocol';
import { validateResult } from '@anhlp/alp-protocol/contract';
import { GIT_READ, createGitReader, gitReadsRunning, scrubRemoteUrl, validBranchName } from '@anhlp/alp-daemon/git';
import { RegistryError } from '@anhlp/alp-daemon/registry';

/**
 * workspace.git.status and workspace.git.diff (docs/protocol/alp-json-rpc-v1.md §12.5) over real,
 * disposable repositories. Every trap a repository can set writes a marker when it runs; none may.
 */

const posix = process.platform !== 'win32';
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const skip = !hasGit ? 'git is not installed' : !posix ? 'the traps are POSIX shell scripts' : false;

/** The test's own Git: no configuration of the host, no GIT_* of the test runner. */
const cleanEnv = () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
};

async function sandbox(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-git-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return base;
}

/** A repository at `root` and the test's git in it. */
async function repository(root, branch = 'main') {
  await mkdir(root, { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=ALP', '-c', 'user.email=alp@example.com', '-c', 'protocol.file.allow=always', ...args], { cwd: root, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', branch);
  return git;
}

const put = async (file, content) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };

/** A reader whose registry knows `workspaces` (id → directory). */
const readerFor = (workspaces, options = {}) => createGitReader({
  registry: { resolve: async id => { if (!Object.hasOwn(workspaces, id)) throw new RegistryError(1001, 'No workspace', { reason: 'not_found' }); return workspaces[id]; } },
  ...options,
});

/** A result checked against the v1 schema, and free of host paths. */
function checked(method, result, base) {
  const issues = validateResult(method, result);
  assert.deepEqual(issues, [], `${method} result matches the schema: ${JSON.stringify(issues)}`);
  if (base) assert.ok(!JSON.stringify(result).includes(base), `${method} result names no host path`);
  return result;
}

/** The refusal of a promise: code, reason, and a message that names no host path. */
async function refusal(promise, base) {
  try { await promise; } catch (error) {
    if (base) assert.ok(!String(error.message).includes(base), `no host path in "${error.message}"`);
    return { code: error.code, reason: error.data?.reason };
  }
  assert.fail('expected a refusal');
}

/** Every page of a diff, following nextCursor. */
async function allPages(reader, params, base) {
  const pages = [];
  let cursor;
  do {
    const page = checked('workspace.git.diff', await reader.diff({ ...params, ...(cursor ? { cursor } : {}) }), base);
    pages.push(page);
    cursor = page.nextCursor;
  } while (cursor && pages.length < 100);
  return pages;
}

const byPath = files => Object.fromEntries(files.map(file => [file.path, file]));
const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nQyNTUxOQAAACDsecretsecretsecretsecretsecretsecretsecretsecretAAAA\n-----END OPENSSH PRIVATE KEY-----\n';

test('no program the repository or alpd\'s environment names runs: planted git, drivers, filters, fsmonitor, pager, hooks, GIT_* variables', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'work');
  const traps = path.join(base, 'traps');
  await mkdir(traps);
  /** A script that leaves a marker named `name` when anything runs it, then does `body`. */
  const trap = async (name, body = '') => {
    const file = path.join(base, `${name}.sh`);
    await writeFile(file, `#!/bin/sh\necho "$*" >> '${path.join(traps, name)}'\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  };
  const git = await repository(root);
  await put(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
  await put(path.join(root, 'b.txt'), 'kept\n');
  await put(path.join(root, '.gitattributes'), '* diff=evil filter=evil\n');
  await put(path.join(root, '.gitignore'), '/git\nnode_modules/\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  // The repository's configuration, set after the commit so the test's own git ran none of it.
  const hooks = path.join(base, 'hooks');
  await mkdir(hooks);
  for (const hook of ['post-index-change', 'pre-commit', 'post-checkout', 'reference-transaction', 'fsmonitor-watchman']) {
    await writeFile(path.join(hooks, hook), `#!/bin/sh\necho hook >> '${path.join(traps, `hook-${hook}`)}'\n`);
    await chmod(path.join(hooks, hook), 0o755);
    await writeFile(path.join(root, '.git', 'hooks', hook), `#!/bin/sh\necho hook >> '${path.join(traps, `git-hook-${hook}`)}'\n`);
    await chmod(path.join(root, '.git', 'hooks', hook), 0o755);
  }
  const settings = {
    'core.fsmonitor': await trap('fsmonitor'),
    'core.hooksPath': hooks,
    'core.pager': await trap('core-pager', 'cat'),
    'pager.diff': await trap('pager-diff', 'cat'),
    'pager.status': await trap('pager-status', 'cat'),
    'diff.external': await trap('diff-external'),
    'diff.evil.command': await trap('driver-command'),
    'diff.evil.textconv': await trap('textconv', 'cat "$1"'),
    'filter.evil.clean': await trap('filter-clean', 'cat'),
    'filter.evil.smudge': await trap('filter-smudge', 'cat'),
    'filter.evil.process': await trap('filter-process'),
    'filter.evil.required': 'true',
    'gpg.program': await trap('gpg'),
    'log.showSignature': 'true',
    'core.sshCommand': await trap('ssh'),
  };
  for (const [key, value] of Object.entries(settings)) git('config', key, value);
  await put(path.join(root, 'a.txt'), 'one\n2\nthree\n');
  await put(path.join(root, 'new.txt'), 'fresh\n');
  // Only touched: Git must hash it again to know it did not change (clean filter, index refresh).
  const later = new Date(Date.now() + 5_000);
  await utimes(path.join(root, 'b.txt'), later, later);

  // A git planted in the workspace, on PATH before the real one (relative and inside entries).
  for (const directory of [root, path.join(root, 'node_modules', '.bin')]) {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'git'), `#!/bin/sh\necho planted >> '${path.join(traps, 'planted-git')}'\nexit 1\n`);
    await chmod(path.join(directory, 'git'), 0o755);
  }
  // alpd's own environment pointing Git elsewhere: a decoy repository and configuration.
  const decoy = path.join(base, 'decoy');
  const decoyGit = await repository(decoy);
  await put(path.join(decoy, 'decoy.txt'), 'decoy\n');
  decoyGit('add', '.');
  decoyGit('commit', '-q', '-m', 'decoy');
  const saved = { ...process.env };
  t.after(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });
  Object.assign(process.env, {
    PATH: [root, path.join(root, 'node_modules', '.bin'), '.', '', saved.PATH].join(path.delimiter),
    GIT_DIR: path.join(decoy, '.git'), GIT_WORK_TREE: decoy, GIT_INDEX_FILE: path.join(decoy, '.git', 'index'),
    GIT_CONFIG_PARAMETERS: `'core.fsmonitor=${await trap('env-parameters')}'`, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.pager', GIT_CONFIG_VALUE_0: await trap('env-count'),
    GIT_EXTERNAL_DIFF: await trap('env-external'), GIT_PAGER: await trap('env-pager'), GIT_SSH_COMMAND: await trap('env-ssh'),
  });
  const indexBefore = await readFile(path.join(root, '.git', 'index'));
  const reader = readerFor({ w: root });

  const status = checked('workspace.git.status', await reader.status('w'), base);
  assert.deepEqual(status.files.map(file => [file.path, file.change]), [['a.txt', 'modified'], ['new.txt', 'untracked']], 'the workspace, not the decoy; b.txt only touched');
  for (const mode of ['uncommitted', 'staged', 'unstaged']) {
    for (const ignoreWhitespace of [false, true]) {
      const page = checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode, ignoreWhitespace } }), base);
      if (mode !== 'staged') {
        const files = byPath(page.files);
        assert.deepEqual(Object.keys(files).sort(), ['a.txt', 'new.txt']);
        assert.deepEqual(files['a.txt'].hunks[0].lines.map(line => [line.type, line.content]), [['context', 'one'], ['remove', 'two'], ['add', '2'], ['context', 'three']], 'the content itself, no textconv');
      } else assert.deepEqual(page.files, []);
    }
  }
  assert.deepEqual(await readdir(traps), [], 'no trap ran');
  assert.ok((await readFile(path.join(root, '.git', 'index'))).equals(indexBefore), 'the index is not rewritten');

  // The traps are armed: Git run naively (PATH as alpd's, no overrides) runs them.
  for (const key of Object.keys(process.env)) if (/^GIT_/.test(key)) delete process.env[key];
  const naive = args => { try { execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'ignore' }); } catch {} };
  naive(['status']);
  naive(['diff', 'HEAD']);
  const ran = await readdir(traps);
  assert.ok(ran.includes('planted-git'), `a naive spawn finds the planted git first: ${ran}`);
  process.env.PATH = saved.PATH;
  naive(['status']);
  // Each trap on its own: a failing required filter would stop Git before the next one.
  const without = (...keys) => keys.flatMap(key => ['-c', `${key}=${key.endsWith('required') ? 'false' : key === 'core.fsmonitor' ? 'false' : ''}`]);
  // (An empty `process` disables `clean` as well, as the reader's override relies on.)
  naive([...without('filter.evil.process', 'filter.evil.clean', 'filter.evil.required', 'core.fsmonitor'), 'diff', 'HEAD']);
  naive([...without('filter.evil.process', 'filter.evil.clean', 'filter.evil.required', 'core.fsmonitor'), 'diff', '--no-ext-diff', 'HEAD']);
  const armed = await readdir(traps);
  // The attribute's driver command is the external diff Git picks before diff.external.
  for (const name of ['fsmonitor', 'filter-process', 'driver-command', 'textconv']) assert.ok(armed.includes(name), `trap ${name} is armed: ${armed}`);
  assert.ok(armed.some(name => name.endsWith('post-index-change')), `Git run without GIT_OPTIONAL_LOCKS=0 and diff.autoRefreshIndex=false rewrites the index and runs its hook: ${armed}`);
});

test('a filter driver whose name -c cannot carry fails closed', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'work');
  const git = await repository(root);
  await put(path.join(root, 'a.txt'), 'one\n');
  await put(path.join(root, '.gitattributes'), '* filter=a=b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const marker = path.join(base, 'ran');
  git('config', 'filter.a=b.clean', `touch '${marker}'; cat`);
  await put(path.join(root, 'a.txt'), 'two\n');
  const reader = readerFor({ w: root });
  assert.deepEqual(await refusal(reader.status('w'), base), { code: 1000, reason: 'git_failed' });
  assert.deepEqual(await refusal(reader.diff({ workspaceId: 'w', compare: { mode: 'uncommitted' } }), base), { code: 1000, reason: 'git_failed' });
  assert.equal(existsSync(marker), false);
});

test('status: branch, upstream, base branch, remote without credentials, detached and unborn heads', { skip }, async t => {
  const base = await sandbox(t);
  const origin = path.join(base, 'origin.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: cleanEnv() });
  const root = path.join(base, 'work');
  const git = await repository(root);
  await put(path.join(root, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'main');
  git('fetch', '-q', 'origin');
  git('remote', 'set-head', 'origin', 'main');
  git('branch', '-q', '--set-upstream-to=origin/main', 'main');
  await put(path.join(root, 'a.txt'), 'two\n');
  git('commit', '-q', '-am', 'second');
  const reader = readerFor({ w: root });

  let status = checked('workspace.git.status', await reader.status('w'), base);
  assert.deepEqual([status.state, status.branch, status.detached, status.upstream, status.baseRef, status.aheadBehind, status.dirty], ['repository', 'main', false, { ref: 'origin/main', ahead: 1, behind: 0 }, 'main', null, false]);
  assert.equal(status.head, git('rev-parse', 'HEAD').trim());
  assert.deepEqual([status.hasRemote, status.remoteUrl], [true, null], 'a local path remote is not shown');
  assert.match(status.snapshot, /^s1\./);

  git('checkout', '-q', '-b', 'feature');
  await put(path.join(root, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'third');
  git('config', 'remote.origin.url', 'https://user:ghp_secrettoken@github.com/acme/repo.git?token=x#frag');
  status = checked('workspace.git.status', await reader.status('w'), base);
  assert.deepEqual([status.branch, status.upstream, status.baseRef, status.aheadBehind], ['feature', null, 'main', { ahead: 2, behind: 0 }], 'against origin/main, which is one behind main');
  assert.equal(status.remoteUrl, 'https://github.com/acme/repo.git');
  assert.ok(!JSON.stringify(status).includes('secrettoken'));

  for (const malformed of ['github.com:org@evil:x', 'user:pa/ss@host:repo', 'https://user:pa/ss@host:repo', 'ssh://user:pa/ss@host:repo']) {
    git('config', 'remote.origin.url', malformed);
    const refused = checked('workspace.git.status', await reader.status('w'), base);
    assert.equal(refused.remoteUrl, null, malformed);
    assert.ok(!JSON.stringify(refused).includes('pa/ss'));
  }

  git('checkout', '-q', '--detach', 'HEAD~1');
  status = checked('workspace.git.status', await reader.status('w'), base);
  assert.deepEqual([status.branch, status.detached, status.upstream, status.aheadBehind, status.head], [null, true, null, null, git('rev-parse', 'HEAD').trim()]);

  const fresh = path.join(base, 'fresh');
  const freshGit = await repository(fresh, 'trunk');
  await put(path.join(fresh, 'staged.txt'), 'staged\n');
  freshGit('add', '.');
  await put(path.join(fresh, 'loose.txt'), 'loose\n');
  const unborn = readerFor({ f: fresh });
  status = checked('workspace.git.status', await unborn.status('f'), base);
  assert.deepEqual([status.branch, status.head, status.detached, status.baseRef, status.dirty], ['trunk', null, false, null, true]);
  assert.deepEqual(status.files.map(file => [file.path, file.change, file.staged]), [['staged.txt', 'added', true], ['loose.txt', 'untracked', false]]);
  const all = checked('workspace.git.diff', await unborn.diff({ workspaceId: 'f', compare: { mode: 'uncommitted' } }), base);
  assert.deepEqual(all.files.map(file => [file.path, file.change, file.kind, file.additions]), [['staged.txt', 'added', 'text', 1], ['loose.txt', 'untracked', 'text', 1]]);
  const staged = checked('workspace.git.diff', await unborn.diff({ workspaceId: 'f', compare: { mode: 'staged' } }), base);
  assert.deepEqual(staged.files.map(file => file.path), ['staged.txt']);
  assert.deepEqual(checked('workspace.git.diff', await unborn.diff({ workspaceId: 'f', compare: { mode: 'base' } }), base).files, []);
});

test('remote URLs lose credentials, queries and local paths; branch names are names only', () => {
  assert.equal(scrubRemoteUrl('https://x-access-token:tok@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.equal(scrubRemoteUrl('ssh://git@github.com:22/a/b.git'), 'ssh://github.com:22/a/b.git');
  assert.equal(scrubRemoteUrl('git@github.com:a/b.git'), 'github.com:a/b.git');
  assert.equal(scrubRemoteUrl('user:s3cret@github.com:a/b.git'), null, 'ambiguous scp user information is refused');
  for (const value of ['a@b:c@github.com:org/x.git', 'github.com:org@evil:x', 'user:pa/ss@host:repo', 'https://user:pa/ss@host:repo', 'ssh://user:pa/ss@host:repo']) assert.equal(scrubRemoteUrl(value), null, value);
  assert.equal(scrubRemoteUrl('HTTPS://u@host/p?q=1#f'), 'https://host/p');
  for (const local of ['/srv/repo.git', '../repo', './repo', 'file:///srv/repo', 'file:/srv/repo', 'C:\\repo', 'c:/repo', '', null, 'ext::sh -c evil', 'a\nb']) assert.equal(scrubRemoteUrl(local), null, String(local));
  for (const good of ['main', 'feature/x', 'release-1.2', 'a.b']) assert.equal(validBranchName(good), true, good);
  for (const bad of ['--output=/tmp/x', '-x', 'HEAD~1', 'main^', 'a..b', 'a b', '@{-1}', 'HEAD', '@', 'x:y', 'x*', 'x?', 'x[', 'x\\y', '/x', 'x/', 'x//y', '.x', 'x/.y', 'x.lock', 'x.', '', 'a'.repeat(256)]) assert.equal(validBranchName(bad), false, bad);
});

test('not a repository, a subdirectory workspace, an unknown workspace, no Git', { skip }, async t => {
  const base = await sandbox(t);
  const plain = path.join(base, 'plain');
  await mkdir(plain);
  const root = path.join(base, 'repo');
  const git = await repository(root);
  await put(path.join(root, 'sub', 'a.txt'), 'a\n');
  await put(path.join(root, 'outside.txt'), 'outside\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  await put(path.join(root, 'outside.txt'), 'changed\n');
  const reader = readerFor({ plain, sub: path.join(root, 'sub') });

  const none = checked('workspace.git.status', await reader.status('plain'), base);
  assert.deepEqual([none.state, none.files, none.snapshot, none.branch], ['not_repository', [], '', null]);
  assert.deepEqual(await refusal(reader.diff({ workspaceId: 'plain', compare: { mode: 'uncommitted' } }), base), { code: 1001, reason: 'not_repository' });
  const sub = checked('workspace.git.status', await reader.status('sub'), base);
  assert.deepEqual([sub.state, sub.reason, sub.files, sub.dirty], ['unsupported', 'not_repository_root', [], false], 'nothing of the repository outside it');
  assert.deepEqual(await refusal(reader.diff({ workspaceId: 'sub', compare: { mode: 'uncommitted' } }), base), { code: 1001, reason: 'not_repository' });
  assert.deepEqual(await refusal(reader.status('wks_missing'), base), { code: 1001, reason: 'not_found' });
  assert.deepEqual(await refusal(reader.diff({ workspaceId: 'wks_missing', compare: { mode: 'uncommitted' } }), base), { code: 1001, reason: 'not_found' });

  const noGit = readerFor({ w: root }, { binary: path.join(base, 'no-such-git') });
  assert.deepEqual(await refusal(noGit.status('w'), base), { code: 1005, reason: 'git_unavailable' });
  // A Git too old for --end-of-options would answer HEAD as missing: refused, never misread.
  const old = path.join(base, 'old-git');
  await writeFile(old, `#!/bin/sh\nif [ "$*" != "\${*%--version}" ]; then echo 'git version 2.25.1'; exit 0; fi\nexit 1\n`);
  await chmod(old, 0o755);
  assert.deepEqual(await refusal(readerFor({ w: root }, { binary: old }).status('w'), base), { code: 1005, reason: 'git_unavailable' });
  // A planted git in the workspace is never the answer, even named absolutely.
  await writeFile(path.join(root, 'git'), '#!/bin/sh\nexit 0\n');
  await chmod(path.join(root, 'git'), 0o755);
  assert.deepEqual(await refusal(readerFor({ w: root }, { binary: path.join(root, 'git') }).status('w'), base), { code: 1005, reason: 'git_unavailable' });
});

test('secrets: blocked paths on either side of a rename, deleted keys, private keys in any content, links, hard links', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'work');
  const git = await repository(root);
  const lines = n => Array.from({ length: n }, (_, i) => `line ${i} of a file long enough to be found again`).join('\n') + '\n';
  await put(path.join(root, '.env'), `SECRET_FROM_ENV=1\n${lines(20)}`);
  await put(path.join(root, 'config.txt'), `PLAIN_CONFIG=1\n${lines(20)}`);
  await put(path.join(root, '.ssh', 'id_rsa'), PEM);
  await put(path.join(root, 'notes', 'old-key.txt'), `notes\n${PEM}`);
  await put(path.join(root, 'body.txt'), `${PEM.replace('secretsecret', 'aaaaaaaaaaaa')}trailer\n`);
  await put(path.join(root, 'linked.txt'), 'target-one\n');
  await symlink('linked.txt', path.join(root, 'tracked-link'));
  git('add', '-f', '.');
  git('commit', '-q', '-m', 'first');
  git('checkout', '-q', '-b', 'feature');
  git('mv', '.env', 'renamed-from-env.txt');
  git('mv', 'config.txt', '.env.local');
  git('rm', '-q', '.ssh/id_rsa', 'notes/old-key.txt');
  // A change inside the key's body only: the patch would show key lines without the header.
  await put(path.join(root, 'body.txt'), `${PEM}trailer\n`);
  await unlink(path.join(root, 'tracked-link'));
  await symlink('/etc/hosts', path.join(root, 'tracked-link'));
  await put(path.join(root, 'untracked-key.pem.txt'), PEM);
  await put(path.join(root, 'id_ed25519'), PEM);
  await symlink('/etc/passwd', path.join(root, 'untracked-link'));
  await put(path.join(base, 'outside-secret.txt'), 'OUTSIDE_SECRET\n');
  await link(path.join(base, 'outside-secret.txt'), path.join(root, 'hardlink.txt'));
  const reader = readerFor({ w: root });

  const status = checked('workspace.git.status', await reader.status('w'), base);
  const listed = status.files.map(file => file.path);
  for (const hidden of ['renamed-from-env.txt', '.env', '.env.local', 'config.txt', '.ssh/id_rsa', 'id_ed25519']) {
    assert.ok(!listed.includes(hidden) && !status.files.some(file => file.oldPath === hidden), `${hidden} is not listed`);
  }
  assert.ok(status.hiddenCount >= 4, `hidden: ${status.hiddenCount}`);
  for (const mode of ['uncommitted', 'staged']) {
    const page = checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode } }), base);
    const text = JSON.stringify(page);
    for (const secret of ['SECRET_FROM_ENV', 'PLAIN_CONFIG', 'PRIVATE KEY', 'secretsecret', 'OUTSIDE_SECRET', 'renamed-from-env', '.env', 'id_rsa', 'id_ed25519', 'hosts', 'passwd']) assert.ok(!text.includes(secret), `${mode}: ${secret} never shown`);
    assert.ok(page.hiddenCount >= 3, `${mode} hidden: ${page.hiddenCount}`);
    const files = byPath(page.files);
    assert.equal(files['notes/old-key.txt']?.kind, 'withheld', 'a deleted file\'s key is withheld');
    assert.deepEqual(files['notes/old-key.txt'].hunks, []);
    if (mode === 'uncommitted') {
      assert.equal(files['body.txt'].kind, 'withheld');
      assert.equal(files['tracked-link'].kind, 'symlink');
      assert.equal(files['untracked-link'].kind, 'symlink');
      assert.equal(files['untracked-key.pem.txt'].kind, 'withheld');
      assert.equal(files['hardlink.txt'].kind, 'withheld', 'a second name of a file from anywhere is not read');
    }
  }
  // Historical content against the base branch: committed on feature, compared with main.
  await unlink(path.join(root, 'hardlink.txt'));
  git('add', '-A');
  git('commit', '-q', '-m', 'second');
  const page = checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode: 'base', baseRef: 'main' } }), base);
  assert.equal(page.compare.baseRef, 'main');
  const text = JSON.stringify(page);
  for (const secret of ['SECRET_FROM_ENV', 'PLAIN_CONFIG', 'PRIVATE KEY', 'OUTSIDE_SECRET', 'hosts']) assert.ok(!text.includes(secret), `base: ${secret} never shown`);
  // The deleted key file may pair with the committed one as a rename: by either side, withheld.
  assert.equal(page.files.find(file => file.path === 'notes/old-key.txt' || file.oldPath === 'notes/old-key.txt')?.kind, 'withheld');
  assert.equal(byPath(page.files)['body.txt'].kind, 'withheld');
  // Asking for a blocked path by name is refused; its rename partner is hidden too.
  assert.deepEqual(await refusal(reader.diff({ workspaceId: 'w', compare: { mode: 'base' }, path: '.env' }), base), { code: 1003, reason: 'blocked_path' });
  assert.deepEqual(checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode: 'base' }, path: 'renamed-from-env.txt' }), base).files, []);
});

test('a work tree file changed between the scan and its patch is withheld, never shown unscanned', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'work');
  const git = await repository(root);
  await put(path.join(root, 'swap.txt'), 'first line\nsecond line\n');
  await put(path.join(root, 'steady.txt'), 'steady\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  await put(path.join(root, 'swap.txt'), 'first line\nchanged line\n');
  await put(path.join(root, 'steady.txt'), 'steady and edited\n');
  // The racing writer: after alpd scanned swap.txt (no key), before Git reads it for the patch.
  let swaps = 0;
  const reader = readerFor({ w: root }, { probe: async step => { if (step === 'scanned') { swaps++; await writeFile(path.join(root, 'swap.txt'), `first line\n${PEM}`); } } });
  const page = checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode: 'uncommitted' } }), base);
  assert.equal(swaps, 1);
  const files = byPath(page.files);
  assert.equal(files['swap.txt'].kind, 'withheld');
  assert.deepEqual(files['swap.txt'].hunks, []);
  assert.ok(!JSON.stringify(page).includes('PRIVATE KEY') && !JSON.stringify(page).includes('secretsecret'), 'the swapped-in key is never shown');
  assert.equal(files['steady.txt'].kind, 'text', 'an unchanged file keeps its hunks');
});

test('kinds: text hunks, binary, too large, mode change, symlink, submodule, conflicts, whitespace', { skip }, async t => {
  const base = await sandbox(t);
  const inner = path.join(base, 'inner');
  const innerGit = await repository(inner);
  await put(path.join(inner, 'x.txt'), 'x\n');
  innerGit('add', '.');
  innerGit('commit', '-q', '-m', 'inner');
  const root = path.join(base, 'work');
  const git = await repository(root);
  await put(path.join(root, 'code.js'), 'function main() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}\n');
  await put(path.join(root, 'image.bin'), Buffer.from([0, 1, 2, 3, 4, 0, 6]));
  await put(path.join(root, 'big.txt'), 'small\n');
  await put(path.join(root, 'run.sh'), 'echo hi\n');
  await put(path.join(root, 'spaces.txt'), 'a b\n');
  await put(path.join(root, 'conflict.txt'), 'base\n');
  // Over the window's budget, under the scan bound: read alone, its small change shown.
  const large = Array.from({ length: 100_000 }, (_, i) => `row ${i} of a large but ordinary text file`).join('\n') + '\n';
  await put(path.join(root, 'large.txt'), large);
  const odd = 'odd \t"name"\\ ü.txt';
  await put(path.join(root, odd), 'before\n');
  await put(path.join(root, 'from \t"q".txt'), 'renamed content line one\nline two\nline three\n');
  git('add', '.');
  git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', inner, 'vendor/inner');
  git('commit', '-q', '-m', 'first');
  git('checkout', '-q', '-b', 'other');
  await put(path.join(root, 'conflict.txt'), 'theirs\n');
  git('commit', '-q', '-am', 'theirs');
  git('checkout', '-q', 'main');
  await put(path.join(root, 'conflict.txt'), 'ours\n');
  git('commit', '-q', '-am', 'ours');
  try { git('merge', '-q', 'other'); } catch {}
  await put(path.join(root, 'code.js'), 'function main() {\n  const a = 1;\n  const b = 3;\n  return a + b;\n}');
  await put(path.join(root, 'image.bin'), Buffer.from([0, 9, 9, 9, 0]));
  await put(path.join(root, 'big.txt'), Array.from({ length: 30_000 }, (_, i) => `a fairly long line number ${i} to grow the patch`).join('\n'));
  await chmod(path.join(root, 'run.sh'), 0o755);
  await put(path.join(root, 'large.txt'), large.replace('row 50000 of', 'ROW 50000 OF'));
  await put(path.join(root, odd), 'after\n');
  git('mv', 'from \t"q".txt', 'to ü "q".txt');
  await put(path.join(root, 'spaces.txt'), 'a  b\n');
  // The submodule moves to a new commit; inside it a trap that must never run.
  const subRoot = path.join(root, 'vendor', 'inner');
  const subGit = (...args) => execFileSync('git', ['-c', 'user.name=ALP', '-c', 'user.email=alp@example.com', ...args], { cwd: subRoot, env: cleanEnv(), encoding: 'utf8' });
  await put(path.join(subRoot, 'x.txt'), 'y\n');
  subGit('commit', '-q', '-am', 'moved');
  const marker = path.join(base, 'submodule-trap');
  subGit('config', 'core.fsmonitor', `touch '${marker}'`);
  subGit('config', 'filter.evil.clean', `touch '${marker}'; cat`);
  await put(path.join(subRoot, '.gitattributes'), '* filter=evil\n');
  await put(path.join(subRoot, 'x.txt'), 'dirty inside\n');
  const reader = readerFor({ w: root });

  const status = checked('workspace.git.status', await reader.status('w'), base);
  const rows = byPath(status.files);
  assert.equal(rows['conflict.txt'].change, 'conflicted');
  assert.equal(rows['vendor/inner'].change, 'modified');
  const page = checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode: 'uncommitted' } }), base);
  const files = byPath(page.files);
  assert.deepEqual(files['code.js'].hunks, [{ oldStart: 1, oldCount: 5, newStart: 1, newCount: 5, lines: [
    { type: 'context', content: 'function main() {' }, { type: 'context', content: '  const a = 1;' }, { type: 'remove', content: '  const b = 2;' }, { type: 'add', content: '  const b = 3;' },
    { type: 'context', content: '  return a + b;' }, { type: 'remove', content: '}' }, { type: 'add', content: '}', noNewline: true }] }]);
  assert.deepEqual([files['code.js'].kind, files['code.js'].additions, files['code.js'].deletions], ['text', 2, 2]);
  assert.equal(files['image.bin'].kind, 'binary');
  assert.equal(files['big.txt'].kind, 'too_large');
  assert.deepEqual([files['run.sh'].kind, files['run.sh'].hunks], ['text', []], 'a mode change only');
  assert.equal(files['vendor/inner'].kind, 'submodule');
  assert.ok(large.length > GIT_READ.windowBytes && large.length < GIT_READ.maxScanBytes);
  assert.deepEqual([files['large.txt'].kind, files['large.txt'].additions, files['large.txt'].deletions], ['text', 1, 1]);
  assert.deepEqual(files[odd].hunks[0].lines.map(line => [line.type, line.content]), [['remove', 'before'], ['add', 'after']], 'a quoted header is matched');
  assert.deepEqual([files['to ü "q".txt'].oldPath, files['to ü "q".txt'].change, files['to ü "q".txt'].kind], ['from \t"q".txt', 'renamed', 'text']);
  assert.ok(files['conflict.txt'].hunks.length > 0);
  for (const file of page.files) if (file.kind !== 'text') assert.deepEqual([file.hunks, file.additions, file.deletions], [[], 0, 0], file.path);
  const unstaged = byPath(checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode: 'unstaged' } }), base).files);
  assert.equal(unstaged['conflict.txt'].change, 'conflicted');
  assert.ok(unstaged['conflict.txt'].hunks[0].lines.some(line => line.content.startsWith('<<<<<<<')), 'ours against the conflicted work tree');
  const stagedConflict = byPath(checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode: 'staged' } }), base).files)['conflict.txt'];
  assert.deepEqual([stagedConflict.change, stagedConflict.kind, stagedConflict.hunks], ['conflicted', 'text', []]);
  const whitespace = byPath(checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode: 'uncommitted', ignoreWhitespace: true } }), base).files)['spaces.txt'];
  assert.deepEqual(whitespace?.hunks ?? [], []);
  assert.equal(existsSync(marker), false, 'nothing ran inside the submodule');
});

test('what is sent is measured: short lines and non-UTF-8 text never take a page over its limit or the frame', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'work');
  const git = await repository(root);
  await put(path.join(root, 'latin1.txt'), 'caf\xe9\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  // 600 KB of 0xE9: text to Git and alpd, 1.8 MB once each byte is decoded as U+FFFD.
  await writeFile(path.join(root, 'latin1.txt'), Buffer.alloc(600 * 1024, 0xe9));
  // Two files of 500 000 empty lines: 0.5 MB each, about 14 MB each as {type, content} JSON.
  await put(path.join(root, 'empty-a.txt'), '\n'.repeat(500_000));
  await put(path.join(root, 'empty-b.txt'), '\n'.repeat(500_000));
  await put(path.join(root, 'small.txt'), 'small\n');
  const reader = readerFor({ w: root });
  const pages = await allPages(reader, { workspaceId: 'w', compare: { mode: 'uncommitted' } }, base);
  for (const page of pages) assert.ok(Buffer.byteLength(JSON.stringify(page)) <= WORKSPACE_GIT.maxTotalBytes, `a page of ${Buffer.byteLength(JSON.stringify(page))} bytes`);
  const files = byPath(pages.flatMap(page => page.files));
  assert.deepEqual(Object.keys(files).sort(), ['empty-a.txt', 'empty-b.txt', 'latin1.txt', 'small.txt']);
  for (const name of ['latin1.txt', 'empty-a.txt', 'empty-b.txt']) { assert.equal(files[name].kind, 'too_large', name); assert.deepEqual(files[name].hunks, []); assert.deepEqual([files[name].additions, files[name].deletions], [0, 0], name); }
  assert.equal(files['small.txt'].kind, 'text');
});

test('a filter driver added to the configuration while a read runs refuses the answer (fails closed)', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'work');
  const git = await repository(root);
  await put(path.join(root, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  await put(path.join(root, 'a.txt'), 'two\n');
  const reader = readerFor({ w: root }, { probe: async () => { git('config', 'filter.late.clean', 'cat'); } });
  assert.deepEqual(await refusal(reader.diff({ workspaceId: 'w', compare: { mode: 'uncommitted' } }), base), { code: 1000, reason: 'git_failed' });
  // The next read neutralizes the driver it now finds.
  assert.equal(byPath(checked('workspace.git.diff', await readerFor({ w: root }).diff({ workspaceId: 'w', compare: { mode: 'uncommitted' } }), base).files)['a.txt'].kind, 'text');
});

test('pages: at most 2 MiB of patch each, every file once, a stale snapshot and a forged cursor refused', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'work');
  const git = await repository(root);
  const body = Array.from({ length: 1_500 }, (_, i) => `original line ${i} with enough text to weigh something`).join('\n') + '\n';
  for (let i = 0; i < 60; i++) await put(path.join(root, `files/f${String(i).padStart(2, '0')}.txt`), body);
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  for (let i = 0; i < 60; i++) await put(path.join(root, `files/f${String(i).padStart(2, '0')}.txt`), body.replaceAll('original', 'changed'));
  const reader = readerFor({ w: root, v: root });
  const params = { workspaceId: 'w', compare: { mode: 'uncommitted' } };
  const pages = await allPages(reader, params, base);
  assert.ok(pages.length >= 2, `paged: ${pages.length}`);
  for (const page of pages.slice(0, -1)) assert.equal(page.truncated, true);
  assert.equal(pages.at(-1).truncated, false);
  assert.equal(pages.at(-1).nextCursor, undefined);
  for (const page of pages) {
    const bytes = page.files.reduce((sum, file) => sum + file.hunks.reduce((s, hunk) => s + hunk.lines.reduce((n, line) => n + Buffer.byteLength(line.content) + 1, 0), 0), 0);
    assert.ok(bytes <= WORKSPACE_GIT.maxTotalBytes, `page patch ${bytes}`);
  }
  const seen = pages.flatMap(page => page.files.map(file => file.path));
  assert.equal(seen.length, 60);
  assert.equal(new Set(seen).size, 60);
  assert.ok(pages.every(page => page.files.every(file => file.kind === 'text' && file.additions === 1_500)));
  const first = pages[0];
  // The cursor continues only the same workspace, comparison and path.
  for (const other of [{ ...params, workspaceId: 'v' }, { ...params, compare: { mode: 'unstaged' } }, { ...params, compare: { mode: 'uncommitted', ignoreWhitespace: true } }, { ...params, path: 'files/f00.txt' }]) {
    assert.deepEqual(await refusal(reader.diff({ ...other, cursor: first.nextCursor }), base), { code: -32602, reason: 'invalid_cursor' });
  }
  const forged = first.nextCursor.replace(/^c1\.(\d+)\./, (_, n) => `c1.${Number(n) + 1}.`);
  assert.notEqual(forged, first.nextCursor);
  assert.deepEqual(await refusal(reader.diff({ ...params, cursor: forged }), base), { code: -32602, reason: 'invalid_cursor' });
  assert.deepEqual(await refusal(reader.diff({ ...params, cursor: 'c1.garbage' }), base), { code: -32602, reason: 'invalid_cursor' });
  // The checkout changes: a cursor from before is stale.
  await put(path.join(root, 'files/f59.txt'), 'replaced\n');
  assert.deepEqual(await refusal(reader.diff({ ...params, cursor: first.nextCursor }), base), { code: 1004, reason: 'stale_snapshot' });
  // So is one after a commit, in any mode.
  const staged = await reader.diff({ workspaceId: 'w', compare: { mode: 'staged' } });
  git('add', '.');
  assert.equal(staged.nextCursor, undefined);
  const after = await reader.diff({ workspaceId: 'w', compare: { mode: 'staged' } });
  assert.notEqual(after.snapshot, staged.snapshot);
});

test('untracked files: at most 200 with content, then truncated', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'work');
  const git = await repository(root);
  await put(path.join(root, 'tracked.txt'), 't\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  for (let i = 0; i < WORKSPACE_GIT.maxUntracked + 5; i++) await put(path.join(root, `u/${String(i).padStart(3, '0')}.txt`), `u${i}\n`);
  await put(path.join(root, '.gitignore'), 'ignored.txt\n');
  await put(path.join(root, 'ignored.txt'), 'never\n');
  const reader = readerFor({ w: root });
  const pages = await allPages(reader, { workspaceId: 'w', compare: { mode: 'unstaged' } }, base);
  const files = pages.flatMap(page => page.files);
  assert.equal(files.filter(file => file.change === 'untracked').length, WORKSPACE_GIT.maxUntracked);
  assert.ok(!files.some(file => file.path === 'ignored.txt'));
  assert.equal(pages.at(-1).truncated, true, 'untracked files left out');
  const status = checked('workspace.git.status', await reader.status('w'), base);
  assert.equal(status.files.length, WORKSPACE_GIT.maxUntracked + 6);
});

test('compare and path are names, never Git arguments: options, revisions, pathspec magic', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'work');
  const git = await repository(root);
  await put(path.join(root, 'a.txt'), 'a\n');
  await put(path.join(root, 'b.txt'), 'b\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('checkout', '-q', '-b', 'feature');
  await put(path.join(root, 'a.txt'), 'a2\n');
  git('commit', '-q', '-am', 'second');
  await put(path.join(root, 'b.txt'), 'b2\n');
  git('mv', 'a.txt', 'moved.txt');
  const reader = readerFor({ w: root });
  const output = path.join(base, 'output-written');
  for (const baseRef of [`--output=${output}`, 'HEAD~1', 'main^{tree}', 'main..feature', '@{-1}', '-p']) {
    assert.deepEqual(await refusal(reader.diff({ workspaceId: 'w', compare: { mode: 'base', baseRef } }), base), { code: -32602, reason: 'invalid_compare' }, baseRef);
  }
  assert.deepEqual(await refusal(reader.diff({ workspaceId: 'w', compare: { mode: 'uncommitted', baseRef: 'main' } }), base), { code: -32602, reason: 'invalid_compare' }, 'baseRef with another mode');
  assert.deepEqual(await refusal(reader.diff({ workspaceId: 'w', compare: { mode: 'range' } }), base), { code: -32602, reason: 'invalid_compare' });
  assert.deepEqual(await refusal(reader.diff({ workspaceId: 'w', compare: { mode: 'base', baseRef: 'nope' } }), base), { code: 1001, reason: 'unknown_ref' });
  assert.equal(existsSync(output), false);
  const committed = checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode: 'base', baseRef: 'main' } }), base);
  assert.deepEqual(committed.files.map(file => [file.path, file.change]), [['a.txt', 'modified']], 'committed changes only');
  assert.deepEqual(checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode: 'base' } }), base).compare, { mode: 'base', baseRef: 'main', ignoreWhitespace: false });
  for (const magic of [':(glob)*.txt', '*.txt', ':!a.txt', ':/b.txt', 'b.*']) {
    assert.deepEqual(checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode: 'uncommitted' }, path: magic }), base).files, [], magic);
  }
  const one = checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode: 'uncommitted' }, path: 'b.txt' }), base);
  assert.deepEqual(one.files.map(file => file.path), ['b.txt']);
  const rename = checked('workspace.git.diff', await reader.diff({ workspaceId: 'w', compare: { mode: 'staged' }, path: 'a.txt' }), base);
  assert.deepEqual(rename.files.map(file => [file.path, file.oldPath, file.change]), [['moved.txt', 'a.txt', 'renamed']], 'a rename by its old path, both sides');
  for (const bad of ['../outside', '/etc/passwd', 'a//b', 'C:/x']) assert.deepEqual(await refusal(reader.diff({ workspaceId: 'w', compare: { mode: 'uncommitted' }, path: bad }), base), { code: -32602, reason: 'invalid_path' }, bad);
});

test('Git processes are bounded: concurrency, deadline (process group killed), output', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'work');
  const git = await repository(root);
  await put(path.join(root, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  await put(path.join(root, 'a.txt'), 'b\n');
  const reader = readerFor({ w: root });
  let peak = 0;
  const sampler = setInterval(() => { peak = Math.max(peak, gitReadsRunning()); }, 1);
  await Promise.all(Array.from({ length: 12 }, () => reader.diff({ workspaceId: 'w', compare: { mode: 'uncommitted' } })));
  clearInterval(sampler);
  assert.ok(peak <= GIT_READ.maxConcurrent, `at most ${GIT_READ.maxConcurrent} at once, saw ${peak}`);

  // A Git that hangs (with a child of its own): killed with its group at the deadline.
  const fake = path.join(base, 'fake-git');
  const pids = path.join(base, 'pids');
  await writeFile(fake, `#!${process.execPath}\nconst { spawn } = require('node:child_process');\nconst child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });\nrequire('node:fs').writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));\nsetTimeout(() => {}, 60000);\n`);
  await chmod(fake, 0o755);
  const hanging = readerFor({ w: root }, { binary: fake, timeoutMs: 800 });
  const started = Date.now();
  assert.deepEqual(await refusal(hanging.status('w'), base), { code: 1000, reason: 'git_failed' });
  assert.ok(Date.now() - started < 5_000);
  const [parent, child] = JSON.parse(await readFile(pids, 'utf8'));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && (alive(parent) || alive(child)); i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual([alive(parent), alive(child)], [false, false], 'the whole group is gone');

  // A Git that prints without end: stopped at its bound.
  const chatty = path.join(base, 'chatty-git');
  await writeFile(chatty, `#!${process.execPath}\nconst chunk = Buffer.alloc(1 << 20, 'x');\nconst write = () => { while (process.stdout.write(chunk)); process.stdout.once('drain', write); };\nwrite();\n`);
  await chmod(chatty, 0o755);
  const logged = [];
  const flooding = readerFor({ w: root }, { binary: chatty, log: (message, fields) => logged.push([message, fields]) });
  assert.deepEqual(await refusal(flooding.status('w'), base), { code: 1000, reason: 'git_failed' });
  assert.match(JSON.stringify(logged), /output over its bound/);
  assert.equal(gitReadsRunning(), 0);
});

test('a linked worktree is read through its checked .git; a forged .git link is refused', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'main');
  const git = await repository(root);
  await put(path.join(root, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const linked = path.join(base, 'linked');
  git('worktree', 'add', '-q', '-b', 'side', linked);
  await put(path.join(linked, 'a.txt'), 'changed in the worktree\n');
  const forged = path.join(base, 'forged');
  await mkdir(forged);
  await writeFile(path.join(forged, '.git'), `gitdir: ${path.join(root, '.git', 'worktrees', 'linked')}\n`);
  const reader = readerFor({ linked, forged });
  const status = checked('workspace.git.status', await reader.status('linked'), base);
  assert.deepEqual([status.branch, status.files.map(file => file.path)], ['side', ['a.txt']]);
  assert.deepEqual(await refusal(reader.status('forged'), base), { code: 1000, reason: 'git_failed' });
});

test('alpd answers workspace.git.status and workspace.git.diff by registry workspaceId and lists workspace.git', { skip }, async t => {
  const { createAlpRuntime } = await import('@anhlp/alp-runtime');
  const { createDaemonServer } = await import('@anhlp/alp-daemon');
  const { seedLibrary } = await import('@anhlp/alp-core/library');
  const { fakeTransport } = await import('../../../test/support/fake-agent.js');
  const base = await sandbox(t);
  const home = path.join(base, 'home');
  await seedLibrary(home);
  const root = path.join(base, 'work');
  const git = await repository(root);
  await put(path.join(root, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  await put(path.join(root, 'a.txt'), 'b\n');
  const runtime = createAlpRuntime({ libraryDir: home, supervisor: false, transport: fakeTransport([]) });
  const daemon = createDaemonServer({ runtime, home, socketPath: '', version: 'test' });
  const client = daemon.local();
  t.after(async () => { client.close(); await daemon.close(); await runtime.shutdown(); });
  assert.ok((await client.request('daemon.hello', { protocolVersion: 1 })).capabilities.includes('workspace.git'));
  await client.request('project.register', { directory: root, ifRevision: 0, requestId: 'r1' });
  const workspaceId = (await client.request('workspace.list', {})).workspaces.find(entry => entry.directory === root).id;
  const status = checked('workspace.git.status', await client.request('workspace.git.status', { workspaceId }), base);
  assert.deepEqual(status.files.map(file => file.path), ['a.txt']);
  const page = checked('workspace.git.diff', await client.request('workspace.git.diff', { workspaceId, compare: { mode: 'uncommitted' } }), base);
  assert.deepEqual(page.files[0].hunks[0].lines.map(line => line.type), ['remove', 'add']);
  const code = async promise => { try { await promise; } catch (error) { assert.ok(!String(error.message).includes(base)); return [error.code, error.data?.reason]; } assert.fail('expected a refusal'); };
  assert.deepEqual(await code(client.request('workspace.git.status', { workspaceId: 'wks_0000000000000000' })), [1001, 'not_found']);
  assert.equal((await code(client.request('workspace.git.status', { workspaceId, projectRoot: root })))[0], -32602, 'no host path parameter');
  assert.equal((await code(client.request('workspace.git.diff', { workspaceId, compare: { mode: 'uncommitted', args: ['--ext-diff'] } })))[0], -32602);
  assert.deepEqual(await code(client.request('workspace.git.diff', { workspaceId, compare: { mode: 'base', baseRef: '--output=x' } })), [-32602, 'invalid_compare']);
});
