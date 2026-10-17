// t-7679.18: reading workspace files remotely, as Paseo (b63a325) — the controller's
// workspace.files.list / workspace.files.read (capability workspace.files.read, permission
// files.read), their refusals, the Files panel's tree, file links in agents' replies and the file
// tabs kept in the layout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WORKSPACE_FILES } from '@anhlp/alp-protocol';
import { Controller, FILES_READ_FORBIDDEN, FILES_READ_UNAVAILABLE } from '../src/lib/controller.js';
import { FILE_MESSAGES, FileAccessError, describeFileError } from '../src/lib/errors.js';
import { cleanListing, flattenTree, formatSize, lineCount, nextSort, relativeFilePath, sortEntries, toggleExpanded } from '../src/lib/file-tree.js';
import { parseFileLink } from '../src/lib/file-links.js';
import { parseLayout, workspaceScope } from '../src/lib/layout.js';
import { FakeHost, until } from './support/fake-host.js';

const READER = { id: 'p1', label: 'tests', permissions: ['session.read', 'session.write', 'project.read', 'files.read'], workspaces: ['/w/a'], workspaceRoots: [{ path: '/w/a', canonical: '/w/a' }] };
const NO_FILES = { ...READER, permissions: ['session.read', 'session.write', 'project.read'] };

function setup(t, { principal = READER, capability = true } = {}) {
  const host = new FakeHost({ principal });
  if (capability) host.capabilities.push('workspace.files.read');
  host.tree.set('/w/a', {
    'README.md': { content: '# Hello\n\nworld\n', modifiedAt: '2026-10-01T00:00:00.000Z' },
    'src/app.ts': { content: 'export const a = 1;\n', modifiedAt: '2026-10-02T00:00:00.000Z' },
    'src/lib/util.ts': { content: 'export {};\n' },
    '.prettierrc': { content: '{}\n' },
    'dist/out.js': { content: 'x', ignored: true },
    'dist': { kind: 'directory', ignored: true },
    'logo.png': { binary: true, size: 2048 },
    'big.log': { tooLarge: true, size: 2 * 1024 * 1024 },
    'link.ts': { linked: true },
    '.env': { content: 'SECRET=1', blocked: true },
  });
  const controller = new Controller({ open: host.open, backoff: { initialMs: 5, maxMs: 20, jitter: 0 }, stableMs: 1, taskPollMs: 60_000, sessionPollMs: 60_000, attentionWatchPollMs: 60_000, requestTimeoutMs: 2_000, releaseTimeoutMs: 500 });
  t.after(() => controller.disconnect());
  return { host, controller, state: () => controller.getState() };
}

async function connected({ controller, state }) {
  controller.connect({ url: 'http://127.0.0.1:7434', token: 'alpgw1.0123456789abcdef.secret' });
  await until(() => state().connection.phase === 'open', 'open');
  controller.selectWorkspace('/w/a');
  await until(() => state().sessions.status === 'ready', 'sessions');
}

const fileCalls = host => host.calls.filter(call => call.method.startsWith('workspace.files.'));

/** The FileAccessError a promise rejects with. */
async function refusal(promise) {
  try { await promise; } catch (error) { assert.ok(error instanceof FileAccessError, `a FileAccessError, not ${error?.name}: ${error?.message}`); return error; }
  assert.fail('expected a refusal');
}

// ---- controller ------------------------------------------------------------------------------

test('files: list and read send the open workspace, the relative path and includeIgnored only when asked', async t => {
  const w = setup(t);
  await connected(w);
  assert.equal(w.controller.filesReadable, true);
  assert.equal(w.controller.canReadFiles, true);
  const root = await w.controller.listWorkspaceFiles();
  assert.deepEqual(root.entries.map(entry => `${entry.kind}:${entry.path}`), ['directory:src', 'file:.prettierrc', 'file:README.md', 'file:big.log', 'file:logo.png'], 'ignored, linked and blocked entries are not listed');
  assert.equal(root.truncated, false);
  await w.controller.listWorkspaceFiles({ path: 'src' });
  await w.controller.listWorkspaceFiles({ includeIgnored: true });
  const read = await w.controller.readWorkspaceFile({ path: './src/app.ts' });
  assert.deepEqual(read, { path: 'src/app.ts', content: 'export const a = 1;\n', size: 20, modifiedAt: '2026-10-02T00:00:00.000Z' });
  await w.controller.readWorkspaceFile({ path: 'dist/out.js', includeIgnored: true });
  assert.deepEqual(fileCalls(w.host).map(call => [call.method, call.params]), [
    ['workspace.files.list', { projectRoot: '/w/a' }],
    ['workspace.files.list', { projectRoot: '/w/a', path: 'src' }],
    ['workspace.files.list', { projectRoot: '/w/a', includeIgnored: true }],
    ['workspace.files.read', { projectRoot: '/w/a', path: 'src/app.ts' }],
    ['workspace.files.read', { projectRoot: '/w/a', path: 'dist/out.js', includeIgnored: true }],
  ]);
});

test('files: without files.read nothing is sent and the token is told what it needs', async t => {
  const w = setup(t, { principal: NO_FILES });
  await connected(w);
  assert.equal(w.controller.canReadFiles, false);
  const listed = await refusal(w.controller.listWorkspaceFiles());
  assert.equal(listed.message, FILES_READ_FORBIDDEN);
  assert.equal(listed.reason, 'grant');
  assert.equal((await refusal(w.controller.readWorkspaceFile({ path: 'README.md' }))).message, FILES_READ_FORBIDDEN);
  assert.equal(fileCalls(w.host).length, 0);
});

test('files: a host without workspace.files.read is not asked', async t => {
  const w = setup(t, { capability: false });
  await connected(w);
  assert.equal(w.controller.filesReadable, false);
  const error = await refusal(w.controller.readWorkspaceFile({ path: 'README.md' }));
  assert.equal(error.message, FILES_READ_UNAVAILABLE);
  assert.equal(error.reason, 'capability');
  assert.equal(fileCalls(w.host).length, 0);
});

test('files: the gateway\'s grant refusal (1003 grant) says files.read is needed', async t => {
  const w = setup(t);
  await connected(w);
  // The token's principal says files.read, but the gateway refuses (a rotated credential, say).
  w.host.principal = NO_FILES;
  const error = await refusal(w.controller.readWorkspaceFile({ path: 'README.md' }));
  assert.equal(error.message, FILES_READ_FORBIDDEN);
  assert.equal(error.failure.code, 1003);
  assert.equal(error.reason, 'grant');
});

test('files: each refusal reason has its own message', async t => {
  const w = setup(t);
  await connected(w);
  const reasonOf = async path => {
    const error = await refusal(w.controller.readWorkspaceFile({ path }));
    return [error.failure.code, error.reason, error.message];
  };
  assert.deepEqual(await reasonOf('logo.png'), [1000, 'binary', 'Binary preview unavailable']);
  assert.deepEqual(await reasonOf('big.log'), [1000, 'too_large', 'This file is too large to display']);
  assert.deepEqual(await reasonOf('dist/out.js'), [1003, 'ignored', FILE_MESSAGES.ignored]);
  assert.deepEqual(await reasonOf('link.ts'), [1003, 'linked', FILE_MESSAGES.linked]);
  assert.deepEqual(await reasonOf('nope.ts'), [1001, 'not_found', FILE_MESSAGES.not_found]);
  // The host's invalid_path (a path this app would have sent, which the host still refuses).
  w.host.intercept.set('workspace.files.read', (_params, _connection, { fail }) => { fail(-32602, 'bad', { reason: 'invalid_path' }); return 'handled'; });
  assert.deepEqual(await reasonOf('ok.ts'), [-32602, 'invalid_path', FILE_MESSAGES.invalid_path]);
  w.host.intercept.set('workspace.files.read', (_params, _connection, { fail }) => { fail(1003, 'blocked', { reason: 'blocked_path' }); return 'handled'; });
  assert.deepEqual(await reasonOf('ok.ts'), [1003, 'blocked_path', FILE_MESSAGES.blocked_path]);
});

test('files: blocked and malformed paths are refused here, without a request', async t => {
  const w = setup(t);
  await connected(w);
  for (const path of ['.env', '.env.local', 'config/.env', '.git/config', '.alp/settings.json', 'id_rsa', 'keys/server.pem', 'secrets.json', '.ssh/known_hosts']) {
    const error = await refusal(w.controller.readWorkspaceFile({ path }));
    assert.equal(error.reason, 'blocked_path', path);
    assert.equal(error.failure.sent, 'no');
  }
  for (const path of ['/etc/passwd', '../outside.ts', 'a/../../b', 'a//b', 'C:/x', 'a\\b', '']) {
    assert.equal((await refusal(w.controller.readWorkspaceFile({ path }))).reason, 'invalid_path', JSON.stringify(path));
  }
  assert.equal((await refusal(w.controller.listWorkspaceFiles({ path: '.git' }))).reason, 'blocked_path');
  assert.equal(fileCalls(w.host).length, 0);
});

test('files: a listing keeps only clean entries of that directory', async t => {
  const w = setup(t);
  await connected(w);
  w.host.extraEntries = [
    { name: 'passwd', path: '/etc/passwd', kind: 'file' },
    { name: 'up', path: '../up', kind: 'file' },
    { name: '.env', path: '.env', kind: 'file' },
    { name: 'deep', path: 'src/deep.ts', kind: 'file' },
    { name: 'weird', path: 'weird', kind: 'socket' },
    { name: 'README.md', path: 'README.md', kind: 'file' },
    null,
  ];
  const { entries } = await w.controller.listWorkspaceFiles();
  assert.deepEqual(entries.map(entry => entry.path), ['src', '.prettierrc', 'README.md', 'big.log', 'logo.png'], 'nothing outside, blocked, of another directory, unknown or repeated');
});

test('files: no workspace or connection: a refusal, no request', async t => {
  const w = setup(t);
  assert.equal((await refusal(w.controller.listWorkspaceFiles())).reason, 'workspace');
});

// ---- errors ----------------------------------------------------------------------------------

test('describeFileError: file reasons get their words; other failures as describe()', () => {
  const rpc = (code, reason) => Object.assign(new Error('x'), { code, data: { reason } });
  assert.equal(describeFileError(rpc(1000, 'too_large')).message, FILE_MESSAGES.too_large);
  assert.equal(describeFileError(rpc(1001, 'not_found')).message, FILE_MESSAGES.not_found);
  assert.equal(describeFileError(rpc(1003, 'outside_workspace')).message, 'That workspace is not granted to your access token.');
  assert.equal(describeFileError(rpc(1000, 'unreadable')).message, 'The host could not do that: x');
});

// ---- the tree ---------------------------------------------------------------------------------

const entries = [
  { name: 'b.ts', path: 'b.ts', kind: 'file', size: 10, modifiedAt: '2026-10-03T00:00:00.000Z' },
  { name: 'src', path: 'src', kind: 'directory', modifiedAt: '2026-10-01T00:00:00.000Z' },
  { name: '.hidden', path: '.hidden', kind: 'file', size: 1, modifiedAt: '2026-10-05T00:00:00.000Z' },
  { name: 'a.ts', path: 'a.ts', kind: 'file', size: 300, modifiedAt: '2026-10-01T00:00:00.000Z' },
  { name: '.github', path: '.github', kind: 'directory' },
];

test('file tree: directories first; name, modified and size sorts; the sort cycles as Paseo\'s', () => {
  assert.deepEqual(sortEntries(entries, 'name').map(entry => entry.name), ['.github', 'src', '.hidden', 'a.ts', 'b.ts']);
  assert.deepEqual(sortEntries(entries, 'modified').map(entry => entry.name), ['src', '.github', '.hidden', 'b.ts', 'a.ts']);
  assert.deepEqual(sortEntries(entries, 'size').map(entry => entry.name), ['.github', 'src', 'a.ts', 'b.ts', '.hidden']);
  assert.equal(nextSort('name'), 'modified');
  assert.equal(nextSort('modified'), 'size');
  assert.equal(nextSort('size'), 'name');
});

test('file tree: flatten shows open directories under their parent, hides dot-names unless asked', () => {
  const listings = {
    '': { status: 'ready', entries },
    src: { status: 'ready', entries: [{ name: 'x.ts', path: 'src/x.ts', kind: 'file' }], truncated: true },
    '.github': { status: 'loading' },
  };
  const rows = flattenTree(listings, ['src'], { sort: 'name', showHidden: false });
  assert.deepEqual(rows.map(row => row.kind === 'entry' ? `${row.depth}:${row.entry.path}${row.open ? '/' : ''}` : `${row.depth}:[${row.status}]`), ['0:src/', '1:src/x.ts', '1:[truncated]', '0:a.ts', '0:b.ts']);
  const hidden = flattenTree(listings, ['.github'], { sort: 'name', showHidden: true });
  assert.deepEqual(hidden.map(row => row.kind === 'entry' ? row.entry.path : `[${row.status}]`), ['.github', '[loading]', 'src', '.hidden', 'a.ts', 'b.ts']);
  assert.deepEqual(flattenTree({ '': { status: 'ready', entries: [] } }, [], { sort: 'name', showHidden: false }).map(row => row.kind === 'status' && row.status), ['empty']);
  assert.deepEqual(flattenTree({ '': { status: 'error', error: 'nope' } }, [], { sort: 'name', showHidden: false }), [{ kind: 'status', path: '', depth: 0, status: 'error', message: 'nope' }]);
  assert.deepEqual(toggleExpanded(['a'], 'b'), ['a', 'b']);
  assert.deepEqual(toggleExpanded(['a', 'b'], 'a'), ['b']);
});

test('file tree: cleanListing caps at maxListEntries; paths, sizes and line counts', () => {
  const many = Array.from({ length: WORKSPACE_FILES.maxListEntries + 5 }, (_, index) => ({ name: `f${index}`, path: `d/f${index}`, kind: 'file' }));
  const cleaned = cleanListing({ entries: many }, 'd');
  assert.equal(cleaned.entries.length, WORKSPACE_FILES.maxListEntries);
  assert.equal(cleaned.truncated, true);
  assert.equal(relativeFilePath('./a/b.ts'), 'a/b.ts');
  for (const bad of ['', '/a', 'a/../b', '..', 'a\\b', 'a//b', '.', 7]) assert.equal(relativeFilePath(bad), undefined, String(bad));
  assert.equal(formatSize(512), '512 B');
  assert.equal(formatSize(1536), '1.5 KB');
  assert.equal(formatSize(2 * 1024 * 1024), '2.0 MB');
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('a\nb\n'), 2);
  assert.equal(lineCount('a\nb'), 2);
});

// ---- file links -------------------------------------------------------------------------------

test('file links: workspace paths with lines are accepted, absolute ones under the root made relative', () => {
  const roots = ['/w/a', '/private/w/a'];
  const code = raw => parseFileLink(raw, { roots, kind: 'code' });
  const href = raw => parseFileLink(raw, { roots, kind: 'href' });
  assert.deepEqual(code('src/a.ts'), { path: 'src/a.ts' });
  assert.deepEqual(code('./a.ts'), { path: 'a.ts' });
  assert.deepEqual(code('src/a.ts:12'), { path: 'src/a.ts', line: 12 });
  assert.deepEqual(code('src/a.ts:12:4'), { path: 'src/a.ts', line: 12 });
  assert.deepEqual(code('src/a.ts:12-20'), { path: 'src/a.ts', line: 12, lineEnd: 20 });
  assert.deepEqual(code('src/a.ts#L12'), { path: 'src/a.ts', line: 12 });
  assert.deepEqual(code('/w/a/src/a.ts:3'), { path: 'src/a.ts', line: 3 });
  assert.deepEqual(code('/private/w/a/src/a.ts'), { path: 'src/a.ts' });
  assert.deepEqual(href('a.ts'), { path: 'a.ts' }, 'a Markdown link may name a file at the root');
  assert.deepEqual(href('a.ts:12'), { path: 'a.ts', line: 12 });
  assert.deepEqual(href('src/a%20b.ts#L5-L9'), { path: 'src/a b.ts', line: 5, lineEnd: 9 });
  assert.deepEqual(href('file:///w/a/docs/x.md'), { path: 'docs/x.md' });
});

test('file links: URLs, ~, .., outside the root, blocked paths and bare names are refused', () => {
  const roots = ['/w/a'];
  const code = raw => parseFileLink(raw, { roots, kind: 'code' });
  const href = raw => parseFileLink(raw, { roots, kind: 'href' });
  for (const raw of ['https://x.dev/a.ts', 'http://a/b.ts', 'mailto:a@b.c', 'javascript:alert(1)', '#top']) assert.equal(href(raw), undefined, raw);
  for (const raw of ['~/a.ts', '../a.ts', 'src/../../a.ts', '/etc/passwd', '/w/ab/x.ts', '/w/a', '.env', 'config/.env.local', '.git/config', '.alp/settings.json', 'keys/id_rsa', 'certs/a.pem']) {
    assert.equal(code(raw), undefined, raw);
    assert.equal(href(raw), undefined, raw);
  }
  // Inline code: a bare name is ambiguous (no search lookup); words and commands are not files.
  for (const raw of ['a.ts', 'a.ts:12', 'npm test', 'src/lib', 'and/or', 'v1.2.3', 'src/a.ts:0', 'src/a.ts:9-3']) assert.equal(code(raw), undefined, raw);
});

// ---- layout -----------------------------------------------------------------------------------

test('layout: file tabs are kept as relative paths; blocked or malformed ones are dropped', () => {
  const scope = workspaceScope('https://gw', '/repo');
  const raw = JSON.stringify({ v: 1, workspaces: { [scope]: { tasks: [], panels: [], files: ['src/a.ts', '.env', '../x', '/etc/passwd', '.git/config', 'README.md', 'src/a.ts'], order: ['file:src/a.ts'], active: 'file:src/a.ts', at: 1 } } });
  const kept = parseLayout(raw).workspaces[scope];
  assert.deepEqual(kept.files, ['src/a.ts', 'README.md']);
  assert.equal(kept.active, 'file:src/a.ts');
  assert.equal('files' in parseLayout(JSON.stringify({ v: 1, workspaces: { [scope]: { files: ['.env'], at: 1 } } })).workspaces[scope], false);
});
