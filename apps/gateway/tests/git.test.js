// workspace.git.status and workspace.git.diff through the gateway (docs/protocol/alp-json-rpc-v1.md
// §12.5, docs/alp/remote-gateway.md §5.13, issue #121 G1): read only, by a registry workspace the
// grant names exactly; status with project.read, diff with project.read and files.read; paths
// refused before alpd; answers projected field by field, blocked or non-relative paths dropped
// and counted hidden, oversize files passed on as too_large, pages cut to the client's frame. Every refusal is
// checked to have caused no request of the method at alpd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WORKSPACE_GIT } from '@anhlp/alp-protocol';
import { DEFAULT_PERMISSIONS, EXPOSURE, FORWARDED_CAPABILITIES, gitPath, gitRemoteUrl, projectGitDiff, projectGitStatus } from '../src/policy.js';
import { fakeDaemon } from './support/fake-daemon.js';
import { startGateway } from './support/harness.js';

const CAPABILITIES = ['attach.after', 'prompt.receipts', 'workspace.registry', 'workspace.git'];

const status = (extra = {}) => ({
  state: 'repository', branch: 'main', detached: false, head: 'a'.repeat(40),
  upstream: { ref: 'origin/main', ahead: 1, behind: 0 }, baseRef: 'main', aheadBehind: null,
  hasRemote: true, remoteUrl: 'https://github.com/acme/shop.git', dirty: true,
  files: [{ path: 'src/app.ts', change: 'modified', staged: false, unstaged: true }],
  hiddenCount: 0, truncated: false, snapshot: 's1', ...extra,
});
const line = (type, content) => ({ type, content });
const textFile = (file, extra = {}) => ({ path: file, change: 'modified', kind: 'text', additions: 1, deletions: 1, hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [line('remove', 'old'), line('add', 'new')] }], ...extra });
const diff = (files, extra = {}) => ({ compare: { mode: 'uncommitted', ignoreWhitespace: false }, snapshot: 's1', files, hiddenCount: 0, truncated: false, ...extra });

async function world(t, { maxFrame } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-git-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = path.join(directory, 'a');
  const b = path.join(directory, 'b');
  await mkdir(a);
  await mkdir(b);
  const canonicalA = await realpath(a);
  const canonicalB = await realpath(b);
  const daemon = fakeDaemon({ capabilities: CAPABILITIES });
  const rows = { wks_a: { id: 'wks_a', projectId: 'prj_a', directory: canonicalA, canonical: canonicalA, createdAt: 'old', labels: [] }, wks_b: { id: 'wks_b', projectId: 'prj_b', directory: canonicalB, canonical: canonicalB, createdAt: 'old', labels: [] } };
  daemon.state.handlers['workspace.get'] = ({ workspaceId }) => {
    if (!Object.hasOwn(rows, workspaceId)) throw { code: 1001, message: `No workspace ${workspaceId}`, data: { reason: 'not_found' } };
    return { workspace: rows[workspaceId], revision: 1 };
  };
  daemon.state.handlers['workspace.git.status'] = () => status();
  daemon.state.handlers['workspace.git.diff'] = () => diff([textFile('src/app.ts')]);
  const gw = await startGateway(t, {
    daemon, ...(maxFrame ? { config: { limits: { maxFrame } } } : {}), credentials: {
      reader: { workspaces: [a], permissions: ['project.read', 'files.read'] },
      defaults: { workspaces: [a] },
      filesOnly: { workspaces: [a], permissions: ['files.read'] },
      sessions: { workspaces: [a], permissions: ['session.read', 'session.write'] },
    },
  });
  return { daemon, a, b, canonicalA, canonicalB, ...gw };
}

const reached = (daemon, mark, prefix = 'workspace.git.') => daemon.calls().slice(mark).filter(call => call.method.startsWith(prefix));

test('the matrix: status needs project.read, diff project.read and files.read; the capability is forwarded; files.read is never a default', () => {
  assert.equal(EXPOSURE['workspace.git.status'].permission, 'project.read');
  assert.equal(EXPOSURE['workspace.git.status'].alsoRequires, undefined);
  assert.equal(EXPOSURE['workspace.git.diff'].permission, 'project.read');
  assert.deepEqual(EXPOSURE['workspace.git.diff'].alsoRequires, ['files.read']);
  assert.deepEqual(EXPOSURE['workspace.git.diff'].params, ['workspaceId', 'compare', 'path', 'cursor']);
  assert.ok(FORWARDED_CAPABILITIES.includes('workspace.git'));
  assert.ok(!DEFAULT_PERMISSIONS.includes('files.read'));
});

test('workspace.git.facts is owner-only: prohibited, its capability withheld, -32601 for every grant and never at alpd', async t => {
  assert.equal(EXPOSURE['workspace.git.facts'].status, 'prohibited');
  assert.ok(!FORWARDED_CAPABILITIES.includes('workspace.git.facts'));
  const daemon = fakeDaemon({ capabilities: [...CAPABILITIES, 'workspace.git.facts'] });
  daemon.state.handlers['workspace.git.facts'] = () => ({ kind: 'unknown' });
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-facts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { sdk } = await startGateway(t, { daemon, credentials: { reader: { workspaces: [directory], permissions: ['project.read', 'files.read'] } } });
  const { client, hello } = await sdk('reader');
  assert.ok(!hello.capabilities.includes('workspace.git.facts'), 'the capability is not forwarded');
  const mark = daemon.calls().length;
  for (const params of [{ directory }, { directory: await realpath(directory) }, { directory: '/' }]) {
    await assert.rejects(client.request('workspace.git.facts', params), error => error.code === -32601, JSON.stringify(params));
  }
  assert.deepEqual(reached(daemon, mark), [], 'nothing reached alpd');
});

test('permissions: refused with 1003 grant naming what is missing, before alpd hears of the workspace', async t => {
  const { daemon, sdk } = await world(t);
  const diffParams = { workspaceId: 'wks_a', compare: { mode: 'uncommitted' } };
  const cases = [
    ['defaults', 'workspace.git.diff', diffParams, 'files.read'],
    ['filesOnly', 'workspace.git.status', { workspaceId: 'wks_a' }, 'project.read'],
    ['filesOnly', 'workspace.git.diff', diffParams, 'project.read'],
    ['sessions', 'workspace.git.status', { workspaceId: 'wks_a' }, 'project.read'],
    ['sessions', 'workspace.git.diff', diffParams, 'project.read'],
  ];
  for (const [label, method, params, permission] of cases) {
    const { client } = await sdk(label);
    const mark = daemon.calls().length;
    await assert.rejects(client.request(method, params), error => error.code === 1003 && error.data?.reason === 'grant' && error.data.permission === permission, `${label} ${method}`);
    assert.deepEqual(daemon.calls().slice(mark).filter(call => call.method !== 'daemon.hello'), [], `${label} ${method} reached alpd`);
  }
  // The default credential (project.read without files.read) still reads the status.
  const { client, hello } = await sdk('defaults');
  assert.ok(hello.capabilities.includes('workspace.git'));
  assert.equal((await client.request('workspace.git.status', { workspaceId: 'wks_a' })).branch, 'main');
});

test('scope: an unknown or foreign workspaceId is refused 1003 and the Git method never runs', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('reader');
  for (const workspaceId of ['wks_missing', 'wks_b']) {
    for (const [method, params] of [['workspace.git.status', { workspaceId }], ['workspace.git.diff', { workspaceId, compare: { mode: 'uncommitted' } }]]) {
      const mark = daemon.calls().length;
      await assert.rejects(client.request(method, params), error => error.code === 1003 && error.data?.reason === 'outside_workspace', `${method} ${workspaceId}`);
      assert.deepEqual(reached(daemon, mark), [], `${method} ${workspaceId} reached alpd`);
    }
  }
});

test('diff paths: blocked, absolute, `..` or backslash paths are refused before alpd', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('reader');
  const mark = daemon.calls().length;
  for (const file of ['.env', '.git/config', 'config/.env.local', '.ssh/id_rsa', 'keys/server.pem']) {
    await assert.rejects(client.request('workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'uncommitted' }, path: file }), error => error.code === 1003 && error.data?.reason === 'blocked_path', file);
  }
  for (const file of ['/etc/passwd', '../b/x', 'src/../../x', './src/app.ts', 'src\\app.ts', 'C:/x', 'src//app.ts']) {
    await assert.rejects(client.request('workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'uncommitted' }, path: file }), error => error.code === -32602 && error.data?.reason === 'invalid_path', file);
  }
  assert.deepEqual(daemon.calls().slice(mark).filter(call => call.method !== 'daemon.hello'), [], 'nothing reached alpd, not even the workspace lookup');
});

test('params: unknown keys fail the schema before alpd; what is forwarded is the allow-list only', async t => {
  const { daemon, sdk } = await world(t);
  const { client } = await sdk('reader');
  const mark = daemon.calls().length;
  for (const params of [
    { workspaceId: 'wks_a', compare: { mode: 'uncommitted', args: ['--output=/tmp/x'] } },
    { workspaceId: 'wks_a', compare: { mode: 'HEAD~1..HEAD' } },
    { workspaceId: 'wks_a', compare: { mode: 'uncommitted' }, projectRoot: '/' },
  ]) await assert.rejects(client.request('workspace.git.diff', params), error => error.code === -32602, JSON.stringify(params));
  await assert.rejects(client.request('workspace.git.status', { workspaceId: 'wks_a', projectRoot: '/' }), error => error.code === -32602);
  assert.deepEqual(reached(daemon, mark), []);
  await client.request('workspace.git.status', { workspaceId: 'wks_a' });
  assert.deepEqual(daemon.calls('workspace.git.status').at(-1).params, { workspaceId: 'wks_a' });
  await client.request('workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'base', baseRef: 'main', ignoreWhitespace: true }, path: 'src/app.ts', cursor: 'c1' });
  assert.deepEqual(daemon.calls('workspace.git.diff').at(-1).params, { workspaceId: 'wks_a', compare: { mode: 'base', baseRef: 'main', ignoreWhitespace: true }, path: 'src/app.ts', cursor: 'c1' });
});

test('status: fields allow-listed, out-of-scope or blocked rows dropped and counted hidden, a local remote answered null', async t => {
  const { daemon, sdk, canonicalA, lines } = await world(t);
  const { client } = await sdk('defaults');
  daemon.state.handlers['workspace.git.status'] = () => status({
    root: canonicalA, gitDir: `${canonicalA}/.git`, remoteUrl: canonicalA, hiddenCount: 2,
    files: [
      { path: 'src/app.ts', change: 'modified', staged: true, unstaged: false, absolute: `${canonicalA}/src/app.ts` },
      { path: 'docs/new.md', oldPath: 'docs/old.md', change: 'renamed', staged: true, unstaged: false },
      { path: `${canonicalA}/x.ts`, change: 'modified', staged: false, unstaged: true },
      { path: '../outside.ts', change: 'modified', staged: false, unstaged: true },
      { path: '.env', change: 'modified', staged: false, unstaged: true },
      { path: 'public.txt', oldPath: '.env', change: 'renamed', staged: true, unstaged: false },
      { path: 'src\\win.ts', change: 'modified', staged: false, unstaged: true },
      { path: 'weird.ts', change: 'exploded', staged: false, unstaged: true },
    ],
  });
  const answer = await client.request('workspace.git.status', { workspaceId: 'wks_a' });
  assert.deepEqual(answer, {
    state: 'repository', branch: 'main', detached: false, head: 'a'.repeat(40),
    upstream: { ref: 'origin/main', ahead: 1, behind: 0 }, baseRef: 'main', aheadBehind: null,
    hasRemote: true, remoteUrl: null, dirty: true,
    files: [{ path: 'src/app.ts', change: 'modified', staged: true, unstaged: false }, { path: 'docs/new.md', oldPath: 'docs/old.md', change: 'renamed', staged: true, unstaged: false }],
    hiddenCount: 8, truncated: false, snapshot: 's1',
  });
  assert.ok(!JSON.stringify(answer).includes(canonicalA), 'no host path');
  assert.ok(lines.some(entry => entry.includes('ALP_GATEWAY_FILE_OUT_OF_SCOPE')), 'the drop is logged');
  // Not a status at all: refused, alpd's text never passes.
  daemon.state.handlers['workspace.git.status'] = () => ({ state: 'repository', note: canonicalA });
  await assert.rejects(client.request('workspace.git.status', { workspaceId: 'wks_a' }), error => error.code === 1000 && !error.message.includes(canonicalA));
});

test('remote URLs: http(s), ssh and git URLs without credentials, scp-like host:path; never a local path', () => {
  for (const kept of ['https://github.com/acme/shop.git', 'ssh://git.example.com/acme/shop', 'git://example.com/x', 'github.com:acme/shop.git']) assert.equal(gitRemoteUrl(kept), kept, kept);
  for (const refused of ['/srv/git/shop.git', 'file:///srv/git/shop.git', 'C:/repos/shop', 'C:\\repos\\shop', '../shop', '~/shop', 'https://user:pw@github.com/x', 'https://github.com/x?token=1', 'git@github.com:acme/shop.git', 'ext::sh -c evil', '', 42, null]) assert.equal(gitRemoteUrl(refused), null, String(refused));
  assert.ok(gitPath('src/a.ts') && !gitPath('.git/HEAD') && !gitPath('/abs') && !gitPath('a/./b') && !gitPath('a\\b'));
});

test('diff: fields allow-listed, blocked or out-of-scope files dropped and counted hidden, other paths left out, non-text kinds without hunks', async t => {
  const { daemon, sdk, canonicalA } = await world(t);
  const { client } = await sdk('reader');
  daemon.state.handlers['workspace.git.diff'] = () => diff([
    { ...textFile('src/app.ts'), absolute: `${canonicalA}/src/app.ts`, hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, header: `diff --git ${canonicalA}`, context: 'function main()', lines: [{ ...line('remove', 'old'), raw: '-old' }, { type: 'add', content: 'new', noNewline: true }] }] },
    textFile('.env'),
    { ...textFile('public.txt'), oldPath: '.env', change: 'renamed' },
    textFile(`${canonicalA}/x.ts`),
    { path: 'logo.png', change: 'added', kind: 'binary', additions: 0, deletions: 0, hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, lines: [line('add', 'PNG')] }] },
  ], { hiddenCount: 1, root: canonicalA });
  const answer = await client.request('workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'uncommitted' } });
  assert.deepEqual(answer, {
    compare: { mode: 'uncommitted', ignoreWhitespace: false }, snapshot: 's1', hiddenCount: 4, truncated: false,
    files: [
      { path: 'src/app.ts', change: 'modified', kind: 'text', additions: 1, deletions: 1, hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, context: 'function main()', lines: [line('remove', 'old'), { type: 'add', content: 'new', noNewline: true }] }] },
      { path: 'logo.png', change: 'added', kind: 'binary', additions: 0, deletions: 0, hunks: [] },
    ],
  });
  // A path asked for: a file naming neither side is not passed on.
  daemon.state.handlers['workspace.git.diff'] = () => diff([textFile('src/app.ts'), textFile('src/other.ts'), { ...textFile('src/moved.ts'), oldPath: 'src/app.ts', change: 'renamed' }]);
  const focused = await client.request('workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'uncommitted' }, path: 'src/app.ts' });
  assert.deepEqual(focused.files.map(file => file.path), ['src/app.ts', 'src/moved.ts']);
});

test('diff: content over the per-file or page limit is passed on as too_large; a field of the wrong shape refuses the answer', async t => {
  const { daemon, sdk, canonicalA } = await world(t);
  const { client } = await sdk('reader');
  const big = n => ({ ...textFile('big.txt'), hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, lines: [line('add', 'x'.repeat(n))] }] });
  // Decoded non-UTF-8 text: each invalid byte became U+FFFD (3 bytes), so content outgrew Git's bytes.
  const replaced = { ...textFile('latin1.txt'), hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, lines: [line('add', '\uFFFD'.repeat(400 * 1024))] }] };
  for (const [label, answer, kinds] of [
    ['file over maxFileBytes', diff([big(WORKSPACE_GIT.maxFileBytes + 1)]), ['too_large']],
    ['decoded content over maxFileBytes', diff([replaced, { ...textFile('b.ts') }]), ['too_large', 'text']],
    ['page over maxTotalBytes', diff([{ ...big(WORKSPACE_GIT.maxFileBytes), path: 'a.txt' }, { ...big(WORKSPACE_GIT.maxFileBytes), path: 'b.txt' }, { ...big(10), path: 'c.txt' }]), ['text', 'text', 'too_large']],
  ]) {
    daemon.state.handlers['workspace.git.diff'] = () => answer;
    const page = await client.request('workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'uncommitted' } }).catch(error => assert.fail(`${label}: ${error.message}`));
    const files = [];
    let cursor;
    for (let current = page; ; current = await client.request('workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'uncommitted' }, cursor })) {
      files.push(...current.files);
      cursor = current.nextCursor;
      if (!cursor) break;
    }
    assert.deepEqual(files.map(file => file.kind), kinds, label);
    for (const file of files) if (file.kind === 'too_large') assert.deepEqual(file.hunks, [], label);
  }
  for (const [label, answer] of [
    ['a line of an unknown type', diff([{ ...textFile('a.ts'), hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [{ type: 'header', content: canonicalA }] }] }])],
    ['an unknown kind', diff([{ ...textFile('a.ts'), kind: 'host_file' }])],
    ['no snapshot', { ...diff([]), snapshot: undefined }],
  ]) {
    daemon.state.handlers['workspace.git.diff'] = () => answer;
    await assert.rejects(client.request('workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'uncommitted' } }), error => error.code === 1000 && error.data?.reason === 'git_failed' && !error.message.includes(canonicalA), label);
  }
  // At the limits exactly: passed on (the default 4 MiB frame holds two 1 MiB files).
  daemon.state.handlers['workspace.git.diff'] = () => diff([{ ...big(WORKSPACE_GIT.maxFileBytes), path: 'a.txt' }]);
  assert.equal((await client.request('workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'uncommitted' } })).files[0].kind, 'text');
});

test('errors: alpd\'s refusals keep code and reason with the gateway\'s fixed text; nothing else of alpd passes', async t => {
  const { daemon, sdk, canonicalA } = await world(t);
  const { client } = await sdk('reader');
  for (const [code, reason] of [[1001, 'not_repository'], [1001, 'unknown_ref'], [-32602, 'invalid_compare'], [1004, 'stale_snapshot'], [-32602, 'invalid_cursor'], [1005, 'git_unavailable'], [1000, 'git_failed'], [1000, undefined]]) {
    daemon.state.handlers['workspace.git.diff'] = () => { throw { code, message: `fatal: ${canonicalA}/.git/index: SENTINEL`, data: { ...(reason ? { reason } : {}), file: `${canonicalA}/.git/index` } }; };
    const caught = await client.request('workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'base', baseRef: 'main' } }).then(() => assert.fail(String(reason)), failure => failure);
    assert.equal(caught.code, code, String(reason));
    assert.deepEqual(caught.data, reason ? { reason } : undefined, String(reason));
    assert.ok(!caught.message.includes('SENTINEL') && !caught.message.includes(canonicalA), caught.message);
    daemon.state.handlers['workspace.git.status'] = daemon.state.handlers['workspace.git.diff'];
    const status = await client.request('workspace.git.status', { workspaceId: 'wks_a' }).then(() => assert.fail(String(reason)), failure => failure);
    assert.ok(status.code === code && !status.message.includes('SENTINEL'), String(reason));
  }
});

test('pages: an answer over the client\'s frame is cut, continued from a cursor of this connection; a file that cannot fit answers too_large', async t => {
  const maxFrame = 256 * 1024;
  const { daemon, sdk } = await world(t, { maxFrame });
  const { client } = await sdk('reader');
  const sized = (name, bytes) => ({ ...textFile(name), additions: 1, deletions: 0, hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 1, lines: [line('add', 'y'.repeat(bytes))] }] });
  let snapshot = 's1';
  daemon.state.handlers['workspace.git.diff'] = ({ cursor }) => cursor === undefined
    ? diff([sized('a.txt', 120 * 1024), sized('b.txt', 120 * 1024), sized('huge.txt', 400 * 1024), sized('c.txt', 10)], { snapshot, hiddenCount: 1, truncated: true, nextCursor: 'alpd-2' })
    : diff([sized('d.txt', 10)], { snapshot });
  const params = { workspaceId: 'wks_a', compare: { mode: 'uncommitted' } };
  const first = await client.request('workspace.git.diff', params);
  assert.deepEqual([first.files.map(file => file.path), first.truncated, first.hiddenCount], [['a.txt'], true, 1]);
  assert.match(first.nextCursor, /^alp-gateway-page:/);
  const second = await client.request('workspace.git.diff', { ...params, cursor: first.nextCursor });
  assert.equal(daemon.calls('workspace.git.diff').at(-1).params.cursor, undefined, 'the same alpd page asked for again');
  assert.deepEqual(second.files.map(file => [file.path, file.kind, file.hunks.length, file.additions]), [['b.txt', 'text', 1, 1], ['huge.txt', 'too_large', 0, 1], ['c.txt', 'text', 1, 1]]);
  assert.deepEqual([second.hiddenCount, second.truncated, second.nextCursor], [0, true, 'alpd-2'], 'alpd\'s own cursor once its page is sent; hidden counted once');
  const third = await client.request('workspace.git.diff', { ...params, cursor: second.nextCursor });
  assert.equal(daemon.calls('workspace.git.diff').at(-1).params.cursor, 'alpd-2');
  assert.deepEqual([third.files.map(file => file.path), third.nextCursor, third.truncated], [['d.txt'], undefined, false]);
  for (const frame of [first, second, third]) assert.ok(Buffer.byteLength(JSON.stringify(frame)) < maxFrame);
  // A gateway cursor continues only the same comparison, and only the same snapshot.
  const again = await client.request('workspace.git.diff', params);
  await assert.rejects(client.request('workspace.git.diff', { ...params, compare: { mode: 'staged' }, cursor: again.nextCursor }), error => error.code === -32602 && error.data?.reason === 'invalid_cursor');
  await assert.rejects(client.request('workspace.git.diff', { ...params, cursor: 'alp-gateway-page:forged' }), error => error.code === -32602 && error.data?.reason === 'invalid_cursor');
  snapshot = 's2';
  await assert.rejects(client.request('workspace.git.diff', { ...params, cursor: again.nextCursor }), error => error.code === 1004 && error.data?.reason === 'stale_snapshot');
  // Another connection of the same credential has none of this one's cursors.
  const other = (await sdk('reader')).client;
  snapshot = 's1';
  const mine = await client.request('workspace.git.diff', params);
  await assert.rejects(other.request('workspace.git.diff', { ...params, cursor: mine.nextCursor }), error => error.code === -32602 && error.data?.reason === 'invalid_cursor');
});

test('projection helpers agree with the schema limits', () => {
  const many = Array.from({ length: WORKSPACE_GIT.maxStatusFiles + 5 }, (_, index) => ({ path: `f${index}.txt`, change: 'untracked', staged: false, unstaged: true }));
  const projected = projectGitStatus(status({ files: many }));
  assert.equal(projected.status.files.length, WORKSPACE_GIT.maxStatusFiles);
  assert.equal(projected.status.truncated, true);
  assert.equal(projectGitStatus(status({ state: 'not_repository', reason: 'not_repository_root', branch: 'x', files: [] })).status.branch, null);
  assert.deepEqual(projectGitDiff(diff([textFile('a.ts')]), { path: 'b.ts' }).page.files, []);
  assert.equal(projectGitDiff(null).refused, 'shape');
});
