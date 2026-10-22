// Issue #121 G1: Paseo's Changes and Diff panels, read only — the controller's workspace.git.status
// and workspace.git.diff (capability workspace.git; project.read, and files.read for hunks), what
// the panels show in each state (lib/git.js gitAccess), and the diff pages they keep.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/lib/controller.js';
import { GIT_ERROR_MESSAGES, GIT_MESSAGES, GitAccessError, appendDiffPage, baseLabel, branchLine, describeGitError, diffRows, diffTotals, formatDiffCount, gitAccess, gitCompare, gitRequestPath, registryWorkspaceOf, restartsDiff } from '../src/lib/git.js';
import { FakeHost, until } from './support/fake-host.js';

const READER = { id: 'p1', label: 'tests', permissions: ['session.read', 'session.write', 'project.read', 'files.read'], workspaces: ['/w/a'], workspaceRoots: [{ path: '/w/a', canonical: '/real/a' }] };
const NO_FILES = { ...READER, permissions: ['session.read', 'session.write', 'project.read'] };
const SESSIONS = { ...READER, permissions: ['session.read', 'session.write'] };

const STATUS = { state: 'repository', branch: 'feature', detached: false, head: 'abcdef1234567', upstream: { ref: 'origin/feature', ahead: 2, behind: 1 }, baseRef: 'main', aheadBehind: { ahead: 3, behind: 0 }, hasRemote: true, remoteUrl: null, dirty: true, files: [{ path: 'src/app.ts', change: 'modified', staged: false, unstaged: true }], hiddenCount: 0, truncated: false, snapshot: 's1' };
const hunk = (lines, at = 1) => ({ oldStart: at, oldCount: lines.filter(line => line.type !== 'add').length, newStart: at, newCount: lines.filter(line => line.type !== 'remove').length, lines });
const FILE = { path: 'src/app.ts', change: 'modified', kind: 'text', additions: 1, deletions: 1, hunks: [hunk([{ type: 'context', content: 'a' }, { type: 'remove', content: 'b' }, { type: 'add', content: 'c', noNewline: true }], 10)] };
const PAGE = { compare: { mode: 'uncommitted', ignoreWhitespace: false }, snapshot: 's1', files: [FILE], hiddenCount: 1, truncated: false };

function setup(t, { principal = READER, capabilities = ['workspace.registry', 'workspace.git'], rows = [{ id: 'wks_a', projectId: 'prj_a', directory: '/real/a', labels: [], createdAt: 'old' }] } = {}) {
  const host = new FakeHost({ principal });
  host.capabilities.push(...capabilities);
  host.intercept.set('workspace.list', (_params, _connection, { answer }) => { answer({ workspaces: rows, revision: 1, total: rows.length, nextCursor: null }); return 'handled'; });
  host.intercept.set('workspace.git.status', (_params, _connection, { answer }) => { answer(STATUS); return 'handled'; });
  host.intercept.set('workspace.git.diff', (_params, _connection, { answer }) => { answer(PAGE); return 'handled'; });
  const controller = new Controller({ open: host.open, backoff: { initialMs: 5, maxMs: 20, jitter: 0 }, stableMs: 1, taskPollMs: 60_000, sessionPollMs: 60_000, attentionWatchPollMs: 60_000, requestTimeoutMs: 2_000, releaseTimeoutMs: 500 });
  t.after(() => controller.disconnect());
  return { host, controller, state: () => controller.getState() };
}

async function connected({ controller, state }, { registry = true } = {}) {
  controller.connect({ url: 'http://127.0.0.1:7434', token: 'alpgw1.0123456789abcdef.secret' });
  await until(() => state().connection.phase === 'open', 'open');
  controller.selectWorkspace('/w/a');
  await until(() => state().sessions.status === 'ready', 'sessions');
  if (registry) await until(() => state().registry.workspaces.length > 0, 'registry');
}

const gitCalls = host => host.calls.filter(call => call.method.startsWith('workspace.git.')).map(call => [call.method, call.params]);

async function refusal(promise) {
  try { await promise; } catch (error) { assert.ok(error instanceof GitAccessError, `a GitAccessError, not ${error?.name}: ${error?.message}`); return error; }
  assert.fail('expected a refusal');
}

// ---- controller ------------------------------------------------------------------------------

test('git: status and diff name the registry workspace of the open path (its canonical directory), compare built from the mode', async t => {
  const w = setup(t);
  await connected(w);
  assert.deepEqual(w.controller.gitAccess, { status: true, workspaceId: 'wks_a', content: true });
  assert.equal((await w.controller.gitStatus()).branch, 'feature');
  await w.controller.gitDiff({ compare: { mode: 'uncommitted' } });
  await w.controller.gitDiff({ compare: { mode: 'base', baseRef: 'main', ignoreWhitespace: true }, path: './src/app.ts', cursor: 'c2' });
  await w.controller.gitDiff({ compare: { mode: 'uncommitted', baseRef: 'main' } });
  await w.controller.gitDiff({ compare: { mode: '--output=/tmp/x' } });
  assert.deepEqual(gitCalls(w.host), [
    ['workspace.git.status', { workspaceId: 'wks_a' }],
    ['workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'uncommitted' } }],
    ['workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'base', baseRef: 'main', ignoreWhitespace: true }, path: 'src/app.ts', cursor: 'c2' }],
    ['workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'uncommitted' } }],
    ['workspace.git.diff', { workspaceId: 'wks_a', compare: { mode: 'uncommitted' } }],
  ], 'a base branch only with base; an unknown mode is never sent');
});

test('git: without files.read the status is read but no diff is asked for, and the token is told what it needs', async t => {
  const w = setup(t, { principal: NO_FILES });
  await connected(w);
  assert.deepEqual(w.controller.gitAccess, { status: true, workspaceId: 'wks_a', content: false, contentMessage: GIT_MESSAGES.filesRead });
  assert.equal((await w.controller.gitStatus()).files.length, 1);
  const refused = await refusal(w.controller.gitDiff({ compare: { mode: 'uncommitted' } }));
  assert.equal(refused.message, GIT_MESSAGES.filesRead);
  assert.deepEqual(gitCalls(w.host).map(([method]) => method), ['workspace.git.status']);
});

test('git: no capability, no project.read, no registry or an unregistered workspace: an honest message and no request', async t => {
  for (const [label, options, reason, message] of [
    ['no capability', { capabilities: ['workspace.registry'] }, 'capability', GIT_MESSAGES.capability],
    ['no project.read', { principal: SESSIONS }, 'projectRead', GIT_MESSAGES.projectRead],
    ['no registry', { capabilities: ['workspace.git'] }, 'registry', GIT_MESSAGES.registry],
    ['unregistered', { rows: [{ id: 'wks_b', projectId: 'prj_b', directory: '/w/b', labels: [], createdAt: 'old' }] }, 'unregistered', GIT_MESSAGES.unregistered],
    ['archived', { rows: [{ id: 'wks_a', projectId: 'prj_a', directory: '/w/a', labels: [], createdAt: 'old', archivedAt: 'now' }] }, 'unregistered', GIT_MESSAGES.unregistered],
  ]) {
    await t.test(label, async t => {
      const w = setup(t, options);
      await connected(w, { registry: false });
      await until(() => !w.state().registry.loading, 'registry settled');
      assert.deepEqual(w.controller.gitAccess, { status: false, reason, message }, label);
      assert.equal((await refusal(w.controller.gitStatus())).message, message);
      assert.equal((await refusal(w.controller.gitDiff({ compare: { mode: 'uncommitted' } }))).message, message);
      assert.deepEqual(gitCalls(w.host), [], `${label}: nothing sent`);
    });
  }
});

test('git: a blocked or malformed path is refused without a request; host refusals get the words of §12.5', async t => {
  const w = setup(t);
  await connected(w);
  assert.equal((await refusal(w.controller.gitDiff({ compare: { mode: 'uncommitted' }, path: '.env' }))).reason, 'blocked_path');
  assert.equal((await refusal(w.controller.gitDiff({ compare: { mode: 'uncommitted' }, path: '../x' }))).reason, 'invalid_path');
  assert.deepEqual(gitCalls(w.host), []);
  for (const [code, reason] of [[1004, 'stale_snapshot'], [-32602, 'invalid_cursor'], [1001, 'not_repository'], [1001, 'unknown_ref'], [1005, 'git_unavailable'], [1000, 'git_failed']]) {
    w.host.intercept.set('workspace.git.diff', (_params, _connection, { fail }) => { fail(code, 'host text', { reason }); return 'handled'; });
    const refused = await refusal(w.controller.gitDiff({ compare: { mode: 'base' }, cursor: 'c' }));
    assert.deepEqual([refused.failure.code, refused.reason, refused.message], [code, reason, GIT_ERROR_MESSAGES[reason]]);
    assert.equal(restartsDiff(refused), reason === 'stale_snapshot' || reason === 'invalid_cursor', reason);
  }
  w.host.intercept.set('workspace.git.diff', (_params, _connection, { fail }) => { fail(1003, 'lacks', { reason: 'grant', permission: 'files.read' }); return 'handled'; });
  assert.equal((await refusal(w.controller.gitDiff({ compare: { mode: 'uncommitted' } }))).message, GIT_MESSAGES.filesRead);
  w.host.intercept.set('workspace.git.status', (_params, _connection, { answer }) => { answer({ nonsense: true }); return 'handled'; });
  assert.match((await refusal(w.controller.gitStatus())).message, /does not understand/);
});

// ---- what the panels show ------------------------------------------------------------------

test('registryWorkspaceOf: the path or its canonical directory, never archived, pinned then oldest', () => {
  const principal = READER;
  const rows = [
    { id: 'old', projectId: 'p', directory: '/real/a', labels: [], createdAt: '2026-01-01' },
    { id: 'pinned', projectId: 'p', directory: '/w/a', labels: [], createdAt: '2026-02-01', pinnedAt: 'x' },
    { id: 'gone', projectId: 'p', directory: '/w/a', labels: [], createdAt: '2025-01-01', archivedAt: 'y' },
    { id: 'other', projectId: 'p', directory: '/w/b', labels: [], createdAt: '2024-01-01' },
  ];
  assert.equal(registryWorkspaceOf({ principal, workspace: '/w/a', registry: { workspaces: rows } })?.id, 'pinned');
  assert.equal(registryWorkspaceOf({ principal, workspace: '/w/a', registry: { workspaces: rows.filter(row => row.id !== 'pinned') } })?.id, 'old');
  assert.equal(registryWorkspaceOf({ principal, workspace: null, registry: { workspaces: rows } }), undefined);
  const state = { connection: { capabilities: ['workspace.git', 'workspace.registry'] }, principal, workspace: '/w/a', registry: { workspaces: [], loading: true } };
  assert.deepEqual(gitAccess(state), { status: false, reason: 'loading', message: GIT_MESSAGES.loading });
  assert.deepEqual(gitAccess({ ...state, workspace: null }), { status: false, reason: 'workspace', message: GIT_MESSAGES.workspace });
});

test('diff pages: appended for the same snapshot with hidden counts summed; another snapshot starts again; the last cursor continues', () => {
  const first = appendDiffPage(undefined, { ...PAGE, truncated: true, nextCursor: 'c2' });
  assert.deepEqual([first.files.length, first.hiddenCount, first.nextCursor, first.truncated], [1, 1, 'c2', true]);
  const second = appendDiffPage(first, { ...PAGE, files: [{ ...FILE, path: 'b.ts' }], hiddenCount: 2 });
  assert.deepEqual([second.files.map(file => file.path), second.hiddenCount, second.nextCursor, second.truncated], [['src/app.ts', 'b.ts'], 3, undefined, false]);
  const fresh = appendDiffPage(second, { ...PAGE, snapshot: 's2', hiddenCount: 0 });
  assert.deepEqual([fresh.files.length, fresh.hiddenCount], [1, 0]);
  assert.deepEqual(diffTotals(second.files), { additions: 2, deletions: 2 });
});

test('diff rows: a hunk header, then lines with their old and new numbers; no newline marked', () => {
  assert.deepEqual(diffRows(FILE), [
    { type: 'hunk', text: '@@ -10,2 +10,2 @@' },
    { type: 'context', text: 'a', oldLine: 10, newLine: 10 },
    { type: 'remove', text: 'b', oldLine: 11 },
    { type: 'add', text: 'c', newLine: 11, noNewline: true },
  ]);
  assert.equal(diffRows({ ...FILE, hunks: [{ ...FILE.hunks[0], context: 'function main()' }] })[0].text, '@@ -10,2 +10,2 @@ function main()');
  assert.deepEqual(diffRows({ ...FILE, kind: 'binary', hunks: [] }), []);
});

test('labels: branch line, base, counts, comparisons and request paths', () => {
  assert.equal(branchLine(STATUS), 'feature · origin/feature (↑2 ↓1)');
  assert.equal(branchLine({ ...STATUS, branch: null, detached: true, upstream: null }), 'Detached at abcdef1');
  assert.equal(branchLine({ ...STATUS, branch: null, head: null, upstream: null }), 'No commits yet');
  assert.equal(baseLabel('refs/remotes/origin/main'), 'origin/main');
  assert.equal(baseLabel(null), 'base');
  assert.deepEqual([formatDiffCount(12), formatDiffCount(1234), formatDiffCount(45678)], ['12', '1.2k', '46k']);
  assert.deepEqual(gitCompare({ mode: 'staged', baseRef: 'main', ignoreWhitespace: false }), { mode: 'staged' });
  assert.deepEqual(gitCompare({ mode: 'base', baseRef: 'develop', ignoreWhitespace: true }), { mode: 'base', baseRef: 'develop', ignoreWhitespace: true });
  assert.deepEqual([gitRequestPath('./a/b.ts'), gitRequestPath('.git/config'), gitRequestPath('/etc/passwd'), gitRequestPath('')], ['a/b.ts', undefined, undefined, undefined]);
  assert.equal(describeGitError({ code: 1003, message: 'x', data: { reason: 'grant', permission: 'project.read' } }).message, GIT_MESSAGES.projectRead);
});
