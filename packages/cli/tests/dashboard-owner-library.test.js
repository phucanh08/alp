// alp dashboard's host owner methods for the library and workspace files (t-a95b group C,
// src/dashboard/owner/library.js; docs/alp/dashboard.md §4.8). The gateway lets only the owner's
// connection reach them (apps/gateway/tests/owner-library.test.js); here each handler's own checks:
// every refusal writes nothing, a stale base is a conflict, a hidden value is never written as its mask.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MASK_TEXT, OWNER_LIBRARY_KINDS, TEST_OUTPUT_CHARS, libraryTest, listWorkspaceFiles, maskIn, methods, readWorkspaceFile, writeWorkspaceFile } from '../src/dashboard/owner/library.js';
import { teardown } from '../../../test/support/teardown.js';

const sha = text => createHash('sha256').update(text).digest('hex');

/** A stand-in for alpd on the owner's connection: records requests, answers from `answers`. */
function fakeDaemon(answers = {}) {
  const calls = [];
  return {
    calls,
    request: async (method, params = {}) => {
      calls.push([method, params]);
      const answer = answers[method];
      return typeof answer === 'function' ? answer(params) : answer ?? { ok: true };
    },
  };
}

async function workspace(t) {
  const defer = teardown(t);
  const scratch = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-owner-files-')));
  defer(() => rm(scratch, { recursive: true, force: true }));
  const root = path.join(scratch, 'shop');
  const outside = path.join(scratch, 'outside');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  await writeFile(path.join(root, '.git', 'config'), '[core]\n');
  await writeFile(path.join(root, '.env'), 'TOKEN=1\n');
  await writeFile(path.join(outside, 'notes.txt'), 'outside\n');
  const daemon = fakeDaemon({ 'workspace.list': { workspaces: [{ id: 'w1', directory: root }], nextCursor: null } });
  return { scratch, root, outside, daemon };
}

const write = (daemon, params) => writeWorkspaceFile({ daemon, params });
const refused = (code, reason) => error => error.code === code && error.data?.reason === reason;

test('host.files.write: saves an edited file atomically, keeping its mode, when the base still matches', async t => {
  const { root, daemon } = await workspace(t);
  const file = path.join(root, 'src', 'a.ts');
  await chmod(file, 0o640);
  const before = await readFile(file, 'utf8');
  const result = await write(daemon, { projectRoot: root, path: 'src/a.ts', content: 'export const a = 2;\n', baseSha256: sha(before) });
  assert.equal(await readFile(file, 'utf8'), 'export const a = 2;\n');
  assert.deepEqual({ path: result.path, sha256: result.sha256, size: result.size }, { path: 'src/a.ts', sha256: sha('export const a = 2;\n'), size: 20 });
  assert.equal((await stat(file)).mode & 0o777, 0o640);
  assert.deepEqual((await readdir(path.join(root, 'src'))).sort(), ['a.ts'], 'no temporary file left');
  assert.deepEqual(daemon.calls.map(([method]) => method), ['workspace.list'], 'the workspace was checked against alpd\'s registry');
});

test('host.files.write: a file changed since it was read is a conflict and is not written', async t => {
  const { root, daemon } = await workspace(t);
  const file = path.join(root, 'src', 'a.ts');
  const read = await readFile(file, 'utf8');
  await writeFile(file, 'export const a = 99; // an agent edit\n');
  await assert.rejects(write(daemon, { projectRoot: root, path: 'src/a.ts', content: 'mine\n', baseSha256: sha(read) }), refused(1004, 'revision_conflict'));
  assert.equal(await readFile(file, 'utf8'), 'export const a = 99; // an agent edit\n');
  assert.deepEqual(await readdir(path.join(root, 'src')), ['a.ts']);
});

test('host.files.write: each rejection writes nothing', async t => {
  const { root, outside, daemon } = await workspace(t);
  const base = sha('export const a = 1;\n');
  const attempt = params => write(daemon, { projectRoot: root, content: 'x', baseSha256: base, ...params });
  // .. and other segments, absolute paths, backslashes.
  for (const bad of ['../outside/notes.txt', 'src/../../outside/notes.txt', './src/a.ts', 'src//a.ts', 'src/', '..']) await assert.rejects(attempt({ path: bad }), refused(-32602, 'invalid_path'), bad);
  for (const bad of [path.join(outside, 'notes.txt'), '/etc/hosts', 'C:/x.txt', 'src\\a.ts']) await assert.rejects(attempt({ path: bad }), refused(-32602, 'invalid_path'), bad);
  // Anything under .git, .alp, a .env file, keys: the blockedFilePath set.
  for (const bad of ['.git/config', '.git/hooks/pre-commit', '.alp/settings.json', '.env', 'src/.env.local', 'id_rsa', 'deploy/server.pem', 'config/secrets.yaml']) await assert.rejects(attempt({ path: bad }), refused(1003, 'blocked_path'), bad);
  // A symbolic link out of the workspace: as the file, and as a directory on the way.
  await symlink(path.join(outside, 'notes.txt'), path.join(root, 'src', 'link.txt'));
  await assert.rejects(attempt({ path: 'src/link.txt', baseSha256: sha('outside\n') }), refused(1003, 'linked'));
  await symlink(outside, path.join(root, 'out'));
  await assert.rejects(attempt({ path: 'out/notes.txt', baseSha256: sha('outside\n') }), refused(1003, 'linked'));
  // A hard link (a second name of a file elsewhere).
  await link(path.join(outside, 'notes.txt'), path.join(root, 'src', 'hard.txt'));
  await assert.rejects(attempt({ path: 'src/hard.txt', baseSha256: sha('outside\n') }), refused(1003, 'linked'));
  assert.equal(await readFile(path.join(outside, 'notes.txt'), 'utf8'), 'outside\n');
  // A missing file (edits only), a directory.
  await assert.rejects(attempt({ path: 'src/new.ts' }), refused(1001, 'not_found'));
  await assert.rejects(attempt({ path: 'src' }), refused(-32602, 'not_file'));
  // Over the read limit (1 MiB, as workspace.files.read).
  await assert.rejects(attempt({ path: 'src/a.ts', content: 'x'.repeat(1024 * 1024 + 1) }), refused(1000, 'too_large'));
  // A directory alpd's registry does not know as a workspace, even an existing one.
  await assert.rejects(write(daemon, { projectRoot: outside, path: 'notes.txt', content: 'x', baseSha256: sha('outside\n') }), refused(1003, 'outside_workspace'));
  // Malformed params.
  await assert.rejects(attempt({ path: 'src/a.ts', baseSha256: 'nope' }), refused(-32602, 'invalid_params'));
  await assert.rejects(attempt({ path: 'src/a.ts', content: 1 }), refused(-32602, 'invalid_params'));
  await assert.rejects(write(daemon, { projectRoot: 'relative/root', path: 'src/a.ts', content: 'x', baseSha256: base }), refused(-32602, 'invalid_params'));
  // Nothing changed anywhere.
  assert.equal(await readFile(path.join(root, 'src', 'a.ts'), 'utf8'), 'export const a = 1;\n');
  assert.equal(await readFile(path.join(root, '.git', 'config'), 'utf8'), '[core]\n');
  assert.equal(await readFile(path.join(root, '.env'), 'utf8'), 'TOKEN=1\n');
  assert.deepEqual((await readdir(path.join(root, 'src'))).sort(), ['a.ts', 'hard.txt', 'link.txt']);
});

test('host.files.list and host.files.read: alpd answers on the owner\'s connection, for a registry workspace and a checked path only', async t => {
  const { root, outside } = await workspace(t);
  const daemon = fakeDaemon({
    'workspace.list': { workspaces: [{ id: 'w1', directory: root }], nextCursor: null },
    'workspace.files.list': { entries: [] },
    'workspace.files.read': params => ({ path: params.path, content: 'export const a = 1;\n', size: 20, modifiedAt: '2026-11-21T00:00:00.000Z' }),
  });
  assert.deepEqual(await listWorkspaceFiles({ daemon, params: { projectRoot: root, path: 'src', includeIgnored: true } }), { entries: [] });
  const read = await readWorkspaceFile({ daemon, params: { projectRoot: root, path: 'src/a.ts' } });
  assert.equal(read.sha256, sha('export const a = 1;\n'), 'the base host.files.write takes');
  assert.deepEqual(daemon.calls.filter(([method]) => method.startsWith('workspace.files')), [['workspace.files.list', { projectRoot: root, path: 'src', includeIgnored: true }], ['workspace.files.read', { projectRoot: root, path: 'src/a.ts' }]]);
  const mark = daemon.calls.length;
  await assert.rejects(readWorkspaceFile({ daemon, params: { projectRoot: root, path: '.git/config' } }), refused(1003, 'blocked_path'));
  await assert.rejects(readWorkspaceFile({ daemon, params: { projectRoot: root, path: '../outside/notes.txt' } }), refused(-32602, 'invalid_path'));
  await assert.rejects(listWorkspaceFiles({ daemon, params: { projectRoot: root, path: '.alp' } }), refused(1003, 'blocked_path'));
  await assert.rejects(readWorkspaceFile({ daemon, params: { projectRoot: outside, path: 'notes.txt' } }), refused(1003, 'outside_workspace'));
  assert.deepEqual(daemon.calls.slice(mark).filter(([method]) => method.startsWith('workspace.files')), [], 'nothing refused reached alpd\'s file methods');
});

test('host.library.save: the keep marker goes to alpd as is; the app\'s mask text is refused and never written', async t => {
  // The app's HIDDEN (apps/web/src/lib/library.js; apps/web/tests/owner-library.test.js checks the same text).
  const HIDDEN = '‹hidden on the host›';
  assert.equal(MASK_TEXT, HIDDEN, 'the handler refuses exactly what the app shows');
  const daemon = fakeDaemon({ 'library.save': { revision: 'r2' } });
  const save = params => methods['host.library.save']({ method: 'host.library.save', params, principal: 'p', daemon, home: '/h', socket: '/s' });
  const content = { server: { command: 'npx', args: ['-y', 'search'], env: { TOKEN: { $secret: 'keep' }, MODE: 'fast' } } };
  assert.deepEqual(await save({ kind: 'mcp', name: 'search', scope: 'library', content, revision: 'r1' }), { revision: 'r2' });
  assert.deepEqual(daemon.calls, [['library.save', { kind: 'mcp', name: 'search', scope: 'library', content, revision: 'r1' }]]);
  daemon.calls.length = 0;
  // The mask, typed back or left in a field, anywhere in the content.
  for (const bad of [
    { server: { command: 'npx', env: { TOKEN: HIDDEN } } },
    { server: { url: 'https://x', headers: { Authorization: `Bearer ${HIDDEN}` } } },
    { hook: { event: 'turn.end', command: `curl -H ${HIDDEN}` } },
  ]) await assert.rejects(save({ kind: bad.hook ? 'hooks' : 'mcp', name: 'search', scope: 'library', content: bad, revision: 'r1' }), refused(-32602, 'secret_marker'));
  assert.equal(maskIn({ a: [{ b: HIDDEN }] }), '/a/0/b');
  // Other refusals: kind (providers are group B's), scope, name, revision, project without a root.
  await assert.rejects(save({ kind: 'providers', name: 'x', scope: 'library', content: {}, revision: null }), refused(-32602, 'invalid_params'));
  await assert.rejects(save({ kind: 'mcp', name: 'x', scope: 'builtin', content: {}, revision: null }), refused(-32602, 'invalid_params'));
  await assert.rejects(save({ kind: 'mcp', name: '../x', scope: 'library', content: {}, revision: null }), refused(-32602, 'invalid_params'));
  await assert.rejects(save({ kind: 'mcp', name: 'x', scope: 'library', content: {} }), refused(-32602, 'invalid_params'));
  await assert.rejects(save({ kind: 'mcp', name: 'x', scope: 'project', content: {}, revision: null }), refused(-32602, 'invalid_params'));
  await assert.rejects(save({ kind: 'mcp', name: 'x', scope: 'library', content: [], revision: null }), refused(-32602, 'invalid_params'));
  assert.deepEqual(daemon.calls, [], 'no refused save reached alpd');
  assert.deepEqual([...OWNER_LIBRARY_KINDS].sort(), ['agents', 'hooks', 'mcp', 'skills', 'teams']);
});

test('host.library.get and host.library.delete: alpd\'s methods with checked params', async t => {
  const daemon = fakeDaemon({ 'library.get': { content: {} }, 'library.delete': { removed: true } });
  const context = params => ({ method: 'm', params, principal: 'p', daemon, home: '/h', socket: '/s' });
  await methods['host.library.get'](context({ kind: 'hooks', name: 'notify', projectRoot: '/w' }));
  await methods['host.library.delete'](context({ kind: 'hooks', name: 'notify', scope: 'project', projectRoot: '/w', revision: 'r1' }));
  await assert.rejects(methods['host.library.delete'](context({ kind: 'hooks', name: 'notify', scope: 'library' })), refused(-32602, 'invalid_params'), 'a delete names the revision read');
  assert.deepEqual(daemon.calls, [['library.get', { kind: 'hooks', name: 'notify', projectRoot: '/w' }], ['library.delete', { kind: 'hooks', name: 'notify', scope: 'project', projectRoot: '/w', revision: 'r1' }]]);
});

test('host.library.test: runs testEntry as alp hook test does, output clipped; only MCP servers and hooks', async t => {
  const runs = [];
  const run = async (kind, name, options) => { runs.push([kind, name, options]); return { ok: true, exitCode: 0, stdout: 'y'.repeat(TEST_OUTPUT_CHARS + 10), stderr: '' }; };
  const result = await libraryTest({ params: { kind: 'hooks', name: 'notify', scope: 'library' }, home: '/alp/home' }, { run });
  assert.equal(result.ok, true);
  assert.ok(result.stdout.length < TEST_OUTPUT_CHARS + 100 && result.stdout.endsWith(`(cut at ${TEST_OUTPUT_CHARS} characters)`));
  assert.deepEqual(runs, [['hooks', 'notify', { root: undefined, library: '/alp/home', scope: 'library', timeoutMs: 30_000 }]]);
  await assert.rejects(libraryTest({ params: { kind: 'agents', name: 'main' }, home: '/h' }, { run }), refused(-32602, 'invalid_params'));
  assert.equal(runs.length, 1);
});

test('host.library.test: a real hook runs once through core testEntry', async t => {
  const defer = teardown(t);
  const home = await mkdtemp(path.join(tmpdir(), 'alp-owner-hook-'));
  defer(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'hooks'), { recursive: true });
  await writeFile(path.join(home, 'hooks', 'hello.json'), JSON.stringify({ event: 'turn.end', command: 'echo hello-from-hook' }));
  const result = await libraryTest({ params: { kind: 'hooks', name: 'hello', scope: 'library' }, home });
  assert.equal(result.ok, true);
  assert.match(result.stdout, /hello-from-hook/);
});
