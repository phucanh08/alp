// t-7679.10: finished/error attention from a root's turn end (question.watch { turns: true } and
// the open tree's own events), the command center's Workspaces section, and its file search
// (workspace.files.search: requests, debounce, stale answers, scope, errors).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller, FILES_FORBIDDEN, FILE_SEARCH_LIMIT, attentionReason } from '../src/lib/controller.js';
import { faviconStatus, newlyEnded, sessionBucket, turnNotification } from '../src/lib/attention.js';
import { commandResults, describeFilePath, rankWorkspaces, workspaceRows } from '../src/lib/command-center.js';
import { FILE_SEARCH_DEBOUNCE_MS, FileSearch } from '../src/lib/file-search.js';
import { FakeHost, until } from './support/fake-host.js';

function setup(t, hostOptions, controllerOptions = {}) {
  const host = new FakeHost(hostOptions);
  const controller = new Controller({ open: host.open, backoff: { initialMs: 5, maxMs: 20, jitter: 0 }, stableMs: 1, taskPollMs: 60_000, sessionPollMs: 60_000, attentionWatchPollMs: 60_000, requestTimeoutMs: 2_000, releaseTimeoutMs: 500, ...controllerOptions });
  t.after(() => controller.disconnect());
  const state = () => controller.getState();
  return { host, controller, state };
}

async function connected({ controller, state }, workspace = '/w/a') {
  controller.connect({ url: 'http://127.0.0.1:7434', token: 'alpgw1.0123456789abcdef.secret' });
  await until(() => state().connection.phase === 'open', 'open');
  controller.selectWorkspace(workspace);
  await until(() => state().sessions.status === 'ready', 'sessions');
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20));
const watchCalls = host => host.calls.filter(call => call.method === 'question.watch');

// ---- lib/attention.js ----------------------------------------------------------------------

test('attention: Paseo buckets for a turn that ended unseen; favicon running > attention > none', () => {
  assert.equal(sessionBucket({ status: 'idle', reason: 'finished' }), 'attention');
  assert.equal(sessionBucket({ status: 'idle', reason: 'error' }), 'failed');
  assert.equal(sessionBucket({ status: 'running', reason: 'finished' }), 'running', 'running outranks finished');
  assert.equal(sessionBucket({ status: 'running', reason: 'error' }), 'failed', 'error outranks running, as Paseo');
  assert.equal(sessionBucket({ status: 'idle', waiting: true, reason: 'error' }), 'needs_input', 'a question outranks both');
  assert.equal(sessionBucket({ status: 'idle' }), 'done');
  assert.equal(faviconStatus(['done', 'attention']), 'attention');
  assert.equal(faviconStatus(['failed'], true), 'attention', 'an error attention lights the favicon');
  assert.equal(faviconStatus(['failed']), 'none', 'a session merely in error does not');
  assert.equal(faviconStatus(['attention', 'running']), 'running');
});

test('attention: notifications say Paseo\'s titles and bodies, one tag per root and reason', () => {
  assert.deepEqual(turnNotification({ root: 'ses_a', name: 'Fix it', reason: 'finished' }), { title: 'Agent finished', body: 'Fix it: Finished working.', tag: 'alp-finished-ses_a' });
  assert.deepEqual(turnNotification({ root: 'ses_a', name: 'Fix it', reason: 'error' }), { title: 'Agent needs attention', body: 'Fix it: Encountered an error.', tag: 'alp-error-ses_a' });
  assert.equal(turnNotification({ root: 'ses_a', name: 'Fix it', reason: 'error', message: 'Model **refused**' }).body, 'Fix it: Model refused');
  assert.deepEqual(newlyEnded({ a: { at: 1 } }, { a: { at: 1 }, b: { at: 2 } }), ['b']);
  assert.deepEqual(newlyEnded({ a: { at: 1 } }, { a: { at: 3 } }), ['a'], 'ended again');
  assert.deepEqual(newlyEnded({ a: { at: 1 } }, {}), []);
});

// ---- controller: turn attention ------------------------------------------------------------

test('turn attention with question.watch.turns: other roots\' turn ends set finished/error, canceled nothing, never their projection', async t => {
  const w = setup(t);
  w.host.capabilities.push('question.watch', 'question.watch.turns');
  w.host.seed('ses_open', { title: 'Open' });
  w.host.seed('ses_b', { title: 'Bee' });
  w.host.seed('ses_c', { title: 'Sea' });
  await connected(w);
  await until(() => watchCalls(w.host).length >= 1, 'watched');
  assert.deepEqual(watchCalls(w.host)[0].params, { projectRoot: '/w/a', turns: true });
  w.controller.selectSession('ses_open');
  await until(() => w.state().tree?.status === 'attached', 'attached');
  const cursor = w.state().tree.projection.cursor;

  w.host.startTurn('ses_b');
  w.host.root('ses_b').summary.status = 'running';
  await w.controller.refreshSessions();
  assert.equal(w.state().sessions.list.find(row => row.id === 'ses_b').status, 'running');
  w.host.endTurn('ses_b', 'completed');
  await until(() => attentionReason(w.state(), 'ses_b') === 'finished', 'finished');
  assert.equal(w.state().sessions.list.find(row => row.id === 'ses_b').status, 'idle', 'its row stops running at once (running would outrank finished)');
  w.host.startTurn('ses_c');
  w.host.endTurn('ses_c', 'failed', { message: 'quota exceeded' });
  await until(() => attentionReason(w.state(), 'ses_c') === 'error', 'error');
  assert.equal(w.state().turnAttention.ses_c.message, 'quota exceeded');
  w.host.startTurn('ses_c');
  w.host.endTurn('ses_c', 'canceled');
  await until(() => !w.state().turnAttention.ses_c, 'a canceled turn asks for nothing (and clears the earlier one)');
  assert.equal(w.state().tree.projection.cursor, cursor, 'copies never move the open tree\'s cursor');
  assert.ok(!w.state().tree.projection.order.includes('ses_b'), 'nor reach its projection');

  // Opening it clears it.
  w.controller.selectSession('ses_b');
  assert.equal(attentionReason(w.state(), 'ses_b'), undefined);
});

test('turn attention on the open tree: only when the user does not see it; cleared on return, prompt and turn start', async t => {
  const w = setup(t);
  w.host.capabilities.push('question.watch', 'question.watch.turns');
  w.host.seed('ses_a', { title: 'Alpha' });
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => w.state().tree?.status === 'attached', 'attached');

  // Seen: visible, focused, in front.
  w.controller.setPresence({ visible: true, focused: true });
  w.host.startTurn('ses_a');
  w.host.endTurn('ses_a', 'completed');
  await until(() => !('ses_a' in w.state().tree.projection.running), 'ended');
  await settle();
  assert.equal(attentionReason(w.state(), 'ses_a'), undefined, 'the user saw it finish');

  // Hidden: it asks for a look.
  w.controller.setPresence({ visible: false, focused: false });
  w.host.startTurn('ses_a');
  w.host.endTurn('ses_a', 'completed');
  await until(() => attentionReason(w.state(), 'ses_a') === 'finished', 'finished while hidden');
  w.controller.setPresence({ visible: true, focused: true });
  assert.equal(attentionReason(w.state(), 'ses_a'), undefined, 'coming back clears it');

  // A new turn clears it.
  w.controller.setPresence({ visible: true, focused: false });
  w.host.startTurn('ses_a');
  w.host.endTurn('ses_a', 'failed');
  await until(() => attentionReason(w.state(), 'ses_a') === 'error', 'error while unfocused');
  w.host.startTurn('ses_a');
  await until(() => attentionReason(w.state(), 'ses_a') === undefined, 'turn.started clears it');
  w.host.endTurn('ses_a', 'completed');
  await until(() => attentionReason(w.state(), 'ses_a') === 'finished', 'finished again');
  // Sending a message clears it.
  await w.controller.sendPrompt('again [hold]');
  assert.equal(attentionReason(w.state(), 'ses_a'), undefined);
});

test('turn attention without question.watch.turns: the watch is sent as before; only the open tree\'s own turn end counts', async t => {
  const w = setup(t);
  w.host.capabilities.push('question.watch');
  w.host.seed('ses_a', { title: 'Alpha' });
  w.host.seed('ses_b', { title: 'Bee' });
  await connected(w);
  await until(() => watchCalls(w.host).length >= 1, 'watched');
  assert.deepEqual(watchCalls(w.host)[0].params, { projectRoot: '/w/a' });
  w.controller.selectSession('ses_a');
  await until(() => w.state().tree?.status === 'attached', 'attached');
  w.controller.setPresence({ visible: false, focused: false });
  w.host.startTurn('ses_b');
  w.host.endTurn('ses_b', 'completed');
  w.host.startTurn('ses_a');
  w.host.endTurn('ses_a', 'completed');
  await until(() => attentionReason(w.state(), 'ses_a') === 'finished', 'open tree finished');
  assert.equal(attentionReason(w.state(), 'ses_b'), undefined, 'no copies without the capability');
});

test('turn attention: a replayed turn end (attach after a reconnect) is not a new one', async t => {
  const w = setup(t);
  w.host.capabilities.push('question.watch', 'question.watch.turns');
  w.host.seed('ses_a', { title: 'Alpha' });
  w.host.startTurn('ses_a');
  w.host.endTurn('ses_a', 'completed');
  await connected(w);
  w.controller.setPresence({ visible: false, focused: false });
  w.controller.selectSession('ses_a');
  await until(() => w.state().tree?.status === 'attached', 'attached with the replay');
  await settle();
  assert.equal(attentionReason(w.state(), 'ses_a'), undefined);
});

test('turn attention: switching workspace forgets it', async t => {
  const w = setup(t);
  w.host.capabilities.push('question.watch', 'question.watch.turns');
  w.host.seed('ses_b', { title: 'Bee' });
  await connected(w);
  await until(() => watchCalls(w.host).length >= 1, 'watched');
  w.host.startTurn('ses_b');
  w.host.endTurn('ses_b', 'completed');
  await until(() => attentionReason(w.state(), 'ses_b') === 'finished', 'finished');
  w.controller.selectWorkspace('/w/b');
  assert.deepEqual(w.state().turnAttention, {});
});

// ---- controller: workspace.files.search ------------------------------------------------------

test('file search: workspace.files.search in the open workspace; refusals in words', async t => {
  const w = setup(t);
  w.host.capabilities.push('workspace.files');
  w.host.files.set('/w/a', ['src/app.ts', 'README.md']);
  await connected(w);
  assert.equal(w.controller.filesSearchable, true);
  const answer = await w.controller.searchWorkspaceFiles({ query: 'app', limit: FILE_SEARCH_LIMIT });
  assert.deepEqual(answer, { files: [{ path: 'src/app.ts' }], truncated: false });
  assert.deepEqual(w.host.calls.find(call => call.method === 'workspace.files.search').params, { projectRoot: '/w/a', query: 'app', limit: 100 });
  // The gateway refuses a token without project.read (1003).
  w.host.principal.permissions = ['session.read'];
  await assert.rejects(w.controller.searchWorkspaceFiles({ query: 'x' }), { message: FILES_FORBIDDEN });
});

test('file search: a token without project.read is told without asking; a host without the capability too', async t => {
  const w = setup(t, { principal: { id: 'p', label: 'ro', permissions: ['session.read'], workspaces: ['/w/a'], workspaceRoots: [{ path: '/w/a', canonical: '/w/a' }] } });
  w.host.capabilities.push('workspace.files');
  await connected(w);
  await assert.rejects(w.controller.searchWorkspaceFiles({ query: 'x' }), { message: FILES_FORBIDDEN });
  assert.equal(w.host.count('workspace.files.search'), 0);
  w.host.capabilities.splice(w.host.capabilities.indexOf('workspace.files'), 1);
  const v = setup(t);
  await connected(v);
  assert.equal(v.controller.filesSearchable, false);
  await assert.rejects(v.controller.searchWorkspaceFiles({ query: 'x' }), /does not offer file search/);
});

// ---- lib/file-search.js --------------------------------------------------------------------

function engine(search, debounceMs = 30) {
  const seen = [];
  const files = new FileSearch({ search, debounceMs, onChange: state => seen.push(state) });
  return { files, seen };
}

test('file search engine: Paseo\'s 100 ms debounce, at once for an empty query; one request for the last keystroke', async () => {
  assert.equal(FILE_SEARCH_DEBOUNCE_MS, 100);
  const asked = [];
  const { files } = engine(async query => { asked.push(query); return { files: [{ path: `src/${query || 'index'}.ts` }] }; });
  files.update({ enabled: true, source: '/w/a', query: '' });
  assert.equal(files.state.loading, true);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.deepEqual(asked, [''], 'empty query: no wait');
  files.update({ enabled: true, source: '/w/a', query: 'a' });
  files.update({ enabled: true, source: '/w/a', query: 'ap' });
  files.update({ enabled: true, source: '/w/a', query: 'app' });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(asked, [''], 'still waiting for the typing to stop');
  assert.deepEqual(files.state.entries.map(entry => entry.path), ['src/index.ts'], 'the earlier answer stays on screen while loading');
  await until(() => !files.state.loading, 'answered');
  assert.deepEqual(asked, ['', 'app']);
  assert.deepEqual(files.state.entries, [{ path: 'src/app.ts', title: 'app.ts', subtitle: 'src' }]);
  files.dispose();
});

test('file search engine: a stale answer is dropped; another workspace starts empty; errors and disabling', async () => {
  const pending = new Map();
  const { files } = engine(query => new Promise((resolve, reject) => pending.set(query, { resolve, reject })), 0);
  files.update({ enabled: true, source: '/w/a', query: 'old' });
  await until(() => pending.has('old'), 'old asked');
  files.update({ enabled: true, source: '/w/a', query: 'new' });
  await until(() => pending.has('new'), 'new asked');
  pending.get('new').resolve({ files: [{ path: 'new.txt' }], truncated: true });
  await until(() => !files.state.loading, 'new answered');
  pending.get('old').resolve({ files: [{ path: 'old.txt' }] });
  await settle();
  assert.deepEqual(files.state.entries.map(entry => entry.path), ['new.txt'], 'the older answer that came later is dropped');
  assert.equal(files.state.truncated, true);

  files.update({ enabled: true, source: '/w/b', query: 'new' });
  assert.deepEqual(files.state.entries, [], 'another workspace: nothing of the last one');
  assert.equal(files.state.loading, true);
  files.update({ enabled: false, source: '/w/b', query: 'new' });
  assert.deepEqual(files.state, { entries: [], loading: false, error: null, truncated: false }, 'disabled shows nothing');
  files.dispose();

  const failing = engine(async () => { throw new Error(FILES_FORBIDDEN); }, 0).files;
  failing.update({ enabled: true, source: '/w/a', query: '' });
  await until(() => !failing.state.loading, 'failed');
  assert.equal(failing.state.error, FILES_FORBIDDEN);
  failing.dispose();
});

// ---- lib/command-center.js: workspaces and files -------------------------------------------

test('command center: Workspaces are the granted folders, by name, five with an empty query, ranked by Paseo\'s matching', () => {
  const rows = workspaceRows(['/w/zeta', '/w/alpha', '/srv/app2', '/srv/app10', '/home/x/notes', '/w/beta/'], '/w/alpha');
  assert.deepEqual(rows[1], { path: '/w/alpha', title: 'alpha', subtitle: '/w/alpha', current: true });
  assert.equal(rows[5].title, 'beta', 'a trailing slash is not the name');
  assert.deepEqual(rankWorkspaces(rows, '').map(row => row.title), ['alpha', 'app2', 'app10', 'beta', 'notes'], 'by name with numbers in order, five');
  assert.deepEqual(rankWorkspaces(rows, 'app').map(row => row.title), ['app2', 'app10'], 'prefix of the name');
  // "w" is a whole word of the path of three; "zeta" an exact name.
  assert.deepEqual(rankWorkspaces(rows, 'zeta').map(row => row.title), ['zeta']);
  assert.deepEqual(rankWorkspaces(rows, 'srv').map(row => row.title), ['app2', 'app10'], 'matched on the path shown as the subtitle');
  assert.deepEqual(rankWorkspaces(rows, 'nothing-here'), []);
});

test('command center: sections in Paseo\'s order, Files with a query or alone in their scope', () => {
  const actions = [{ id: 'settings', label: 'Settings', group: 'actions', always: true }];
  const sessions = [{ id: 'ses_a', title: 'Alpha', bucket: 'done' }, { id: 'ses_f', title: 'Finished one', bucket: 'attention', attention: true }];
  const workspaces = workspaceRows(['/w/a', '/w/b']);
  const files = ['src/a.ts', 'a.md'].map(describeFilePath);
  assert.deepEqual(describeFilePath('src\\lib\\x.js'), { path: 'src/lib/x.js', title: 'x.js', subtitle: 'src/lib' });
  const empty = commandResults({ actions, sessions, query: '', workspaces, files: [] });
  assert.deepEqual(empty.map(section => section.id), ['actions', 'workspaces', 'sessions']);
  assert.deepEqual(empty[2].rows.map(row => row.item.id), ['ses_f', 'ses_a'], 'a session that ended unseen comes first, as Paseo\'s requiresAttention');
  const typed = commandResults({ actions, sessions, query: 'a', workspaces, files });
  assert.deepEqual(typed.map(section => section.id), ['actions', 'workspaces', 'sessions', 'files'].filter(id => typed.some(section => section.id === id)));
  assert.equal(typed.at(-1).id, 'files');
  assert.deepEqual(typed.at(-1).rows.map(row => row.item.path), ['src/a.ts', 'a.md'], 'the host\'s order kept');
  assert.ok(!commandResults({ actions, sessions, query: 'a', workspaces }).some(section => section.id === 'files'), 'no Files without the capability');
  assert.deepEqual(commandResults({ actions, sessions, query: '', workspaces, files, scope: 'files' }).map(section => section.id), ['files'], 'the Files scope shows only files');
  assert.deepEqual(commandResults({ actions, sessions, query: '', workspaces, scope: 'files' }), []);
});

test('shortcuts: Cmd+P on a Mac, Ctrl+P elsewhere is Paseo\'s Search files, listed under General', async () => {
  const { helpSections, matchShortcut } = await import('../src/lib/shortcuts.js');
  const press = mods => ({ code: 'KeyP', key: 'p', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(matchShortcut(press({ metaKey: true }), { mac: true })?.binding.action, 'command-center.files');
  assert.equal(matchShortcut(press({ ctrlKey: true }), { mac: false })?.binding.action, 'command-center.files');
  assert.equal(matchShortcut(press({ ctrlKey: true }), { mac: true }), null);
  const general = helpSections(true).find(section => section.id === 'general');
  assert.ok(general?.rows.some(row => row.label === 'Search files' && row.keys === '⌘P'));
  assert.ok(helpSections(false).find(section => section.id === 'general')?.rows.some(row => row.label === 'Search files' && row.keys === 'Ctrl+P'));
});

// ---- review fixes (t-7679.10 round 1) --------------------------------------------------------

test('turn attention: a root the list does not show (archived, unlisted) asks for nothing', async t => {
  const w = setup(t);
  w.host.capabilities.push('question.watch', 'question.watch.turns');
  w.host.seed('ses_listed', { title: 'Listed' });
  w.host.seed('ses_gone', { title: 'Gone' });
  w.host.root('ses_gone').summary.archived = true;
  await connected(w);
  await until(() => watchCalls(w.host).length >= 1, 'watched');
  assert.ok(!w.state().sessions.list.some(row => row.id === 'ses_gone'), 'archived roots are not listed');
  w.host.startTurn('ses_gone');
  w.host.endTurn('ses_gone', 'completed');
  w.host.startTurn('ses_listed');
  w.host.endTurn('ses_listed', 'completed');
  await until(() => attentionReason(w.state(), 'ses_listed') === 'finished', 'the listed root');
  await settle();
  assert.equal(attentionReason(w.state(), 'ses_gone'), undefined);
  assert.deepEqual(Object.keys(w.state().turnAttention), ['ses_listed']);
});

test('turn attention: a root the list finds running again is over (a new turn started elsewhere)', async t => {
  const w = setup(t);
  w.host.capabilities.push('question.watch', 'question.watch.turns');
  w.host.seed('ses_b', { title: 'Bee' });
  await connected(w);
  await until(() => watchCalls(w.host).length >= 1, 'watched');
  w.host.startTurn('ses_b');
  w.host.endTurn('ses_b', 'failed');
  await until(() => attentionReason(w.state(), 'ses_b') === 'error', 'error');
  await w.controller.refreshSessions();
  assert.equal(attentionReason(w.state(), 'ses_b'), 'error', 'an idle row keeps it');
  await new Promise(resolve => setTimeout(resolve, 2));
  w.host.startTurn('ses_b');
  w.host.root('ses_b').summary.status = 'running';
  await w.controller.refreshSessions();
  assert.equal(attentionReason(w.state(), 'ses_b'), undefined, 'running again: the failed turn is over');
});

test('turn attention: the open root\'s turn end is seen while one of its agents is in front', async t => {
  const w = setup(t);
  w.host.capabilities.push('question.watch', 'question.watch.turns');
  w.host.seed('ses_a', { title: 'Alpha' });
  await connected(w);
  w.controller.selectSession('ses_a');
  await until(() => w.state().tree?.status === 'attached', 'attached');
  w.controller.setPresence({ visible: true, focused: true });
  w.host.startTurn('ses_a');
  w.host.openChild('ses_a', 'child-1');
  await until(() => !!w.state().tree.projection.sessions['child-1'], 'child');
  w.controller.focusSession('child-1');
  assert.equal(w.state().focus, 'child-1');
  w.host.endTurn('ses_a', 'completed');
  await until(() => !('ses_a' in w.state().tree.projection.running), 'ended');
  await settle();
  assert.equal(attentionReason(w.state(), 'ses_a'), undefined);
});
