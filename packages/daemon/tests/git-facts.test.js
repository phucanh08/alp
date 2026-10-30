import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { validateResult } from '@anhlp/alp-protocol/contract';
import { connect, daemonPaths } from '@anhlp/alp-client';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { createGitReader } from '@anhlp/alp-daemon/git';

/**
 * workspace.git.facts (docs/protocol/alp-json-rpc-v1.md §12.5): the owner's checkout facts of a
 * host directory that need not be a registry workspace, over real, disposable repositories. Each
 * root kind answers its own `kind`, each refusal its own code and reason, never a silent default.
 */

const posix = process.platform !== 'win32';
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const skip = !hasGit ? 'git is not installed' : !posix ? 'the traps are POSIX shell scripts' : false;

const cleanEnv = () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' };
};

async function sandbox(t) {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-git-facts-')));
  t.after(() => rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return base;
}

async function repository(root, branch = 'main') {
  await mkdir(root, { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=ALP', '-c', 'user.email=alp@example.com', ...args], { cwd: root, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', branch);
  return git;
}

async function committed(root) {
  const git = await repository(root);
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  return git;
}

/** A result checked against the v1 schema. */
function checked(result) {
  const issues = validateResult('workspace.git.facts', result);
  assert.deepEqual(issues, [], `workspace.git.facts result matches the schema: ${JSON.stringify(issues)}`);
  return result;
}

/** The refusal of a promise: code and reason, its message naming no host path. */
async function refusal(promise, base) {
  try { await promise; } catch (error) {
    if (base) assert.ok(!String(error.message).includes(base), `no host path in "${error.message}"`);
    return { code: error.code, reason: error.data?.reason };
  }
  assert.fail('expected a refusal');
}

test('a repository\'s top level is ok: branch, HEAD, a scrubbed origin, dirty from the first change row', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'repo');
  const git = await committed(root);
  git('config', 'remote.origin.url', 'https://user:token@example.com/acme/shop.git?x=1');
  const head = git('rev-parse', 'HEAD').trim();
  const reader = createGitReader({});
  assert.deepEqual(checked(await reader.facts(root)), { kind: 'ok', repoRoot: root, branch: 'main', detached: false, head, hasRemote: true, remoteUrl: 'https://example.com/acme/shop.git', dirty: false });
  await writeFile(path.join(root, 'new.txt'), 'fresh\n');
  assert.equal((await reader.facts(root)).dirty, true, 'an untracked file');
  await rm(path.join(root, 'new.txt'));
  await writeFile(path.join(root, 'a.txt'), 'two\n');
  assert.equal((await reader.facts(root)).dirty, true, 'a modified file');
  // A local path remote is a remote, with no URL to show.
  git('config', 'remote.origin.url', path.join(base, 'elsewhere'));
  const local = await reader.facts(root);
  assert.deepEqual([local.hasRemote, local.remoteUrl], [true, null]);
  assert.ok(!JSON.stringify(local).includes('elsewhere'));
});

test('empty roots: an empty directory is unknown, a repository before its first commit is ok without HEAD', { skip }, async t => {
  const base = await sandbox(t);
  const empty = path.join(base, 'empty');
  await mkdir(empty);
  // No Git is needed to know there is no repository: a missing binary still answers.
  assert.deepEqual(checked(await createGitReader({ binary: path.join(base, 'no-git') }).facts(empty)), { kind: 'unknown' });
  const fresh = path.join(base, 'fresh');
  await repository(fresh, 'trunk');
  assert.deepEqual(checked(await createGitReader({}).facts(fresh)), { kind: 'ok', repoRoot: fresh, branch: 'trunk', detached: false, head: null, hasRemote: false, remoteUrl: null, dirty: false });
});

test('a nested folder is not_repository_root with its enclosing repository\'s facts; inside .git is unsupported', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'repo');
  const git = await committed(root);
  const nested = path.join(root, 'src', 'deep');
  await mkdir(nested, { recursive: true });
  const reader = createGitReader({});
  const head = git('rev-parse', 'HEAD').trim();
  assert.deepEqual(checked(await reader.facts(nested)), { kind: 'not_repository_root', repoRoot: root, branch: 'main', detached: false, head, hasRemote: false, remoteUrl: null, dirty: false });
  await writeFile(path.join(root, 'a.txt'), 'changed\n');
  assert.equal((await reader.facts(nested)).dirty, true, 'the repository\'s change, outside the folder');
  // A nested repository is its own top level.
  const inner = path.join(root, 'vendor', 'lib');
  await committed(inner);
  assert.deepEqual([(await reader.facts(inner)).kind, (await reader.facts(inner)).repoRoot], ['ok', inner]);
  for (const inside of [path.join(root, '.git'), path.join(root, '.git', 'objects'), path.join(inner, '.git', 'refs')]) {
    assert.deepEqual(checked(await reader.facts(inside)), { kind: 'unsupported', reason: 'inside_git_dir' }, inside);
  }
});

test('detached HEAD has no branch; a work tree configured elsewhere is unsupported', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'repo');
  const git = await committed(root);
  const head = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', '--detach');
  const reader = createGitReader({});
  const detached = checked(await reader.facts(root));
  assert.deepEqual([detached.kind, detached.branch, detached.detached, detached.head], ['ok', null, true, head]);
  const other = path.join(base, 'other');
  await mkdir(other);
  git('config', 'core.worktree', other);
  assert.deepEqual(checked(await reader.facts(root)), { kind: 'unsupported', reason: 'worktree_elsewhere' });
});

test('a link is read at its real path: repoRoot names the real directory', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'repo');
  await committed(root);
  const link = path.join(base, 'link');
  await symlink(root, link);
  assert.equal((await createGitReader({}).facts(link)).repoRoot, root);
  await mkdir(path.join(root, 'sub'));
  const nested = checked(await createGitReader({}).facts(path.join(link, 'sub')));
  assert.deepEqual([nested.kind, nested.repoRoot], ['not_repository_root', root]);
});

test('paths: not absolute, not normalised, traversal, missing and not a directory are refused, each with its code', async t => {
  const base = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-git-facts-')));
  t.after(() => rm(base, { recursive: true, force: true }));
  await writeFile(path.join(base, 'file.txt'), 'x');
  const reader = createGitReader({});
  for (const directory of [undefined, null, 7, '', 'relative/dir', './dir', `${base}/`, `${base}//x`, `${base}/./x`, `${base}/../x`, `${base}/x/..`, `${base}\0x`, `/${'a'.repeat(4096)}`]) {
    assert.deepEqual(await refusal(reader.facts(directory), base), { code: -32602, reason: 'invalid_path' }, JSON.stringify(directory));
  }
  assert.deepEqual(await refusal(reader.facts(path.join(base, 'missing')), base), { code: 1001, reason: 'not_found' });
  assert.deepEqual(await refusal(reader.facts(path.join(base, 'missing', 'deeper')), base), { code: 1001, reason: 'not_found' });
  assert.deepEqual(await refusal(reader.facts(path.join(base, 'file.txt', 'x')), base), { code: 1001, reason: 'not_found' });
  assert.deepEqual(await refusal(reader.facts(path.join(base, 'file.txt')), base), { code: 1001, reason: 'not_directory' });
  // The filesystem root is normalised; it is answered, not refused.
  assert.ok(['unknown', 'ok', 'unsupported', 'not_repository_root'].includes((await reader.facts(path.parse(base).root).catch(error => ({ kind: `error ${error.code}` }))).kind));
});

test('Git errors are explicit: no Git, an unusable .git; status and diff need a registry this reader lacks', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'repo');
  await committed(root);
  const logged = [];
  assert.deepEqual(await refusal(createGitReader({ binary: path.join(base, 'no-git') }).facts(root), base), { code: 1005, reason: 'git_unavailable' });
  const broken = path.join(base, 'broken');
  await mkdir(broken);
  await writeFile(path.join(broken, '.git'), 'not a gitdir line\n');
  const reader = createGitReader({ log: (message, fields) => logged.push({ message, ...fields }) });
  assert.deepEqual(await refusal(reader.facts(broken), base), { code: 1000, reason: 'git_failed' });
  assert.equal(logged.at(-1)?.message, 'workspace.git.facts failed', 'the cause is logged, not answered');
  assert.equal((await refusal(reader.status('w'))).code, 1005);
  assert.equal((await refusal(reader.diff({ workspaceId: 'w', compare: { mode: 'uncommitted' } }))).code, 1005);
});

test('nothing the repository names runs, at the top level or for a nested folder', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'repo');
  const traps = path.join(base, 'traps');
  await mkdir(traps);
  const trap = async (name, body = '') => {
    const file = path.join(base, `${name}.sh`);
    await writeFile(file, `#!/bin/sh\necho "$*" >> '${path.join(traps, name)}'\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  };
  const git = await repository(root);
  await writeFile(path.join(root, '.gitattributes'), '* filter=evil\n');
  await writeFile(path.join(root, 'a.txt'), 'one\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  for (const [key, value] of Object.entries({
    'core.fsmonitor': await trap('fsmonitor'), 'core.pager': await trap('pager', 'cat'), 'pager.status': await trap('pager-status', 'cat'),
    'filter.evil.clean': await trap('filter-clean', 'cat'), 'filter.evil.process': await trap('filter-process'), 'filter.evil.required': 'true',
  })) git('config', key, value);
  await writeFile(path.join(root, '.git', 'hooks', 'post-index-change'), `#!/bin/sh\necho hook >> '${path.join(traps, 'hook')}'\n`);
  await chmod(path.join(root, '.git', 'hooks', 'post-index-change'), 0o755);
  // Only touched: a naive status would run the clean filter to hash it again.
  const later = new Date(Date.now() + 5_000);
  await utimes(path.join(root, 'a.txt'), later, later);
  // A git planted in the repository, ahead on PATH: never the one that runs.
  const nested = path.join(root, 'tools', 'bin');
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, 'git'), `#!/bin/sh\necho planted >> '${path.join(traps, 'planted')}'\nexit 1\n`);
  await chmod(path.join(nested, 'git'), 0o755);
  await writeFile(path.join(root, '.git', 'info', 'exclude'), 'tools/\n');
  const savedPath = process.env.PATH;
  process.env.PATH = [nested, savedPath].join(path.delimiter);
  t.after(() => { process.env.PATH = savedPath; });
  const indexBefore = await readFile(path.join(root, '.git', 'index'));
  const reader = createGitReader({});
  assert.deepEqual([(await reader.facts(root)).kind, (await reader.facts(root)).dirty], ['ok', false]);
  assert.deepEqual([(await reader.facts(nested)).kind, (await reader.facts(nested)).repoRoot], ['not_repository_root', root]);
  assert.deepEqual(await readdir(traps), [], 'no trap ran');
  assert.ok((await readFile(path.join(root, '.git', 'index'))).equals(indexBefore), 'the index is not rewritten');
  // The traps are armed: Git run naively in the repository runs them.
  try { execFileSync('git', ['status'], { cwd: root, env: { ...cleanEnv(), PATH: savedPath }, stdio: 'ignore' }); } catch {}
  const ran = await readdir(traps);
  assert.ok(ran.length > 0 && !ran.includes('planted'), `a naive status runs a trap: ${ran}`);
});

function fakeTransport() {
  return () => ({
    async initialize() {}, onNotification() {}, onFailure() {}, onRequest() {}, async close() {},
    async request(method) { return method.startsWith('thread/') ? { thread: { id: 'thread-1' } } : {}; },
  });
}

async function connectAs(socket, agent) {
  const saved = process.env.ALP_AGENT_SESSION;
  if (agent) process.env.ALP_AGENT_SESSION = '1'; else delete process.env.ALP_AGENT_SESSION;
  try { return await connect(socket, { name: 'facts-test', version: '0' }); }
  finally { if (saved === undefined) delete process.env.ALP_AGENT_SESSION; else process.env.ALP_AGENT_SESSION = saved; }
}

test('alpd: listed without a home, the owner\'s connection answers, an agent\'s is refused 1003 user_only, extra params -32602', { skip }, async t => {
  const base = await sandbox(t);
  const root = path.join(base, 'repo');
  await committed(root);
  const library = path.join(base, 'library');
  await mkdir(library, { mode: 0o700 });
  const runtime = createAlpRuntime({ transport: fakeTransport(), libraryDir: library });
  // No home: no registry, so no workspace.git; the facts need none.
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(base).socket, version: 'test' });
  await server.listen();
  t.after(async () => { await server.close(); await runtime.shutdown(); });
  const owner = await connectAs(daemonPaths(base).socket, false);
  t.after(() => owner.close());
  const hello = await owner.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(hello.capabilities.includes('workspace.git.facts'));
  assert.ok(!hello.capabilities.includes('workspace.git'));
  assert.equal((await owner.request('workspace.git.facts', { directory: root })).kind, 'ok');
  assert.equal((await owner.request('workspace.git.facts', { directory: path.join(root, '.git') })).kind, 'unsupported');
  await assert.rejects(owner.request('workspace.git.facts', { directory: root, principalId: 'cred', authorizedRoots: [root] }), error => error.code === -32602);
  await assert.rejects(owner.request('workspace.git.facts', { directory: 'repo' }), error => error.code === -32602 && error.data?.reason === 'invalid_path');
  await assert.rejects(owner.request('workspace.git.status', { workspaceId: 'w' }), error => error.code === 1005);
  const agent = await connectAs(daemonPaths(base).socket, true);
  t.after(() => agent.close());
  await assert.rejects(agent.request('workspace.git.facts', { directory: root }), error => error.code === 1003 && error.data?.reason === 'user_only');
});
