// The workspace P1 slice's pure parts (t-7679.5): the kept layout (lib/layout.js), the command
// center's matching and sections (lib/command-center.js) and the page's attention (lib/attention.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DOCK_WIDTH, LAYOUT_KEY, SIDEBAR_WIDTH, clampWidth, loadLayout, moveKey, orderTabs, parseLayout, serializeLayout, updateLayout, workspaceScope } from '../src/lib/layout.js';
import { commandResults, matchScore, matchTier, sortSessions } from '../src/lib/command-center.js';
import { faviconStatus, newlyWaiting, notificationBody, userSees } from '../src/lib/attention.js';

const memory = (initial = {}) => {
  const entries = new Map(Object.entries(initial));
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, String(value)); } };
};

test('layout: garbage, another version or nothing give an empty layout', () => {
  for (const raw of [null, '', 'nope', '[]', '42', JSON.stringify({ v: 2, sidebarWidth: 400 })]) assert.deepEqual(parseLayout(raw), { workspaces: {} });
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.deepEqual(loadLayout(throwing), { workspaces: {} });
  assert.equal(updateLayout(throwing, layout => layout), false);
  assert.equal(updateLayout(undefined, layout => layout), false);
});

test('layout: fields validated one by one; widths clamped; panels known; unknown fields dropped', () => {
  const scope = workspaceScope('https://gw', '/repo');
  const raw = JSON.stringify({ v: 1, sidebarWidth: 5000, dockWidth: 'wide', token: 'alpgw1.secret', workspaces: {
    [scope]: { session: 's1', agents: ['s1', 's2', 7, 's2'], tasks: ['t-1', ''], panels: ['terminal', 'bogus'], order: ['agent:s1', 'panel:terminal'], active: 'panel:terminal', at: 5, extra: 1 },
    other: 'nope',
  } });
  const layout = parseLayout(raw);
  assert.deepEqual(layout, { sidebarWidth: SIDEBAR_WIDTH.max, workspaces: { [scope]: { session: 's1', agents: ['s2'], tasks: ['t-1'], panels: ['terminal'], order: ['agent:s1', 'panel:terminal'], active: 'panel:terminal', at: 5 } } });
  assert.ok(!serializeLayout({ ...layout, token: 'alpgw1.secret' }).includes('secret'));
  // No session: no agent tabs kept.
  assert.deepEqual(parseLayout(JSON.stringify({ v: 1, workspaces: { a: { agents: ['x'] } } })).workspaces.a.agents, []);
});

test('layout: at most 20 workspaces, the most recent kept; updates keep the other fields', () => {
  const workspaces = Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`w${index}`, { at: index }]));
  const parsed = parseLayout(JSON.stringify({ v: 1, workspaces }));
  assert.equal(Object.keys(parsed.workspaces).length, 20);
  assert.ok(!('w0' in parsed.workspaces) && 'w24' in parsed.workspaces);
  const storage = memory();
  updateLayout(storage, layout => ({ ...layout, sidebarWidth: 400 }));
  updateLayout(storage, layout => ({ ...layout, workspaces: { w: { agents: [], tasks: ['t'], panels: [], order: [], at: 1 } } }));
  const stored = JSON.parse(storage.entries.get(LAYOUT_KEY));
  assert.equal(stored.v, 1);
  assert.equal(stored.sidebarWidth, 400);
  assert.deepEqual(stored.workspaces.w.tasks, ['t']);
});

test('layout: widths clamp to the bounds; tab order and moves', () => {
  assert.equal(clampWidth(10, SIDEBAR_WIDTH), 200);
  assert.equal(clampWidth(333.4, DOCK_WIDTH), 333);
  assert.equal(clampWidth(Number.NaN, DOCK_WIDTH), undefined);
  const tabs = ['a', 'b', 'c', 'd'];
  // Ordered keys first, as ordered; the others after, in their own order.
  assert.deepEqual(orderTabs(tabs, tab => tab, ['c', 'x', 'a']), ['c', 'a', 'b', 'd']);
  assert.deepEqual(orderTabs(tabs, tab => tab, []), tabs);
  assert.deepEqual(moveKey(tabs, 'd', 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveKey(tabs, 'a', 9), ['b', 'c', 'd', 'a']);
  assert.deepEqual(moveKey(tabs, 'z', 0), tabs);
});

test('command center: tiers of a match, every word must match, hidden words rank last', () => {
  assert.equal(matchTier('settings', 'Settings'), 0);
  assert.equal(matchTier('tab', 'Close current tab'), 1);
  assert.equal(matchTier('clo', 'Close current tab'), 2);
  assert.equal(matchTier('cur', 'Close current tab'), 3);
  assert.equal(matchTier('rren', 'Close current tab'), 4);
  assert.equal(matchTier('cct', 'Close current tab'), 6);
  assert.equal(matchTier('xyz', 'Close current tab'), undefined);
  assert.equal(matchScore('close tab', ['Close current tab']), 2);
  assert.equal(matchScore('close zebra', ['Close current tab']), undefined);
  assert.ok(matchScore('agent', ['New session'], ['new agent']) > matchScore('agent', ['Open Agents']));
});

test('command center: empty query shows the always actions and five sessions; a query filters and ranks', () => {
  const actions = [
    { id: 'history', label: 'History', group: 'actions', always: true },
    { id: 'new', label: 'New session', group: 'workspace', always: true },
    { id: 'term', label: 'New terminal', group: 'workspace' },
    { id: 'side', label: 'Toggle left sidebar', group: 'actions' },
  ];
  const sessions = Array.from({ length: 7 }, (_, index) => ({ id: `s${index}`, title: `Session ${index}`, bucket: 'done', updatedAt: new Date(2026, 0, index + 1).toISOString() }));
  sessions[2].bucket = 'needs_input';
  sessions[3].bucket = 'running';
  const empty = commandResults({ actions, sessions, query: '' });
  assert.deepEqual(empty.map(section => section.title), ['Workspace actions', 'Actions', 'Sessions']);
  assert.deepEqual(empty[0].rows.map(row => row.item.id), ['new']);
  assert.deepEqual(empty[2].rows.map(row => row.item.id), ['s2', 's3', 's6', 's5', 's4']);
  // The best match's section first.
  const sidebar = commandResults({ actions, sessions, query: 'sidebar' });
  assert.deepEqual(sidebar.map(section => section.title), ['Actions']);
  const session = commandResults({ actions, sessions, query: 'session 5' });
  assert.deepEqual(session.at(-1).rows.map(row => row.item.id), ['s5']);
  assert.deepEqual(commandResults({ actions, sessions, query: 'qqq' }), []);
  assert.deepEqual(sortSessions([{ id: 'a', title: 'a', bucket: 'done' }, { id: 'b', title: 'b', bucket: 'running' }]).map(entry => entry.id), ['b', 'a']);
});

test('attention: favicon status, new waits, the notification body, quiet when the user sees it', () => {
  assert.equal(faviconStatus(['done', 'needs_input', 'running']), 'running');
  assert.equal(faviconStatus(['done', 'needs_input']), 'attention');
  assert.equal(faviconStatus([]), 'none');
  assert.deepEqual(newlyWaiting({ a: 1, b: 0 }, { a: 1, b: 1, c: 2 }), ['b', 'c']);
  assert.deepEqual(newlyWaiting({ a: 2 }, { a: 1 }), []);
  assert.equal(notificationBody('**Deploy** `now`?\n\n```js\nx\n```'), 'Deploy now?');
  const long = notificationBody('x'.repeat(300));
  assert.equal(long.length, 220);
  assert.ok(long.endsWith('...'));
  assert.equal(userSees({ visible: true, focused: true, shown: 'a' }, 'a'), true);
  assert.equal(userSees({ visible: true, focused: false, shown: 'a' }, 'a'), false);
  assert.equal(userSees({ visible: true, focused: true, shown: 'b' }, 'a'), false);
});

import { closeRange, planClose } from '../src/lib/tab-close.js';

const T = (kind, id) => ({ kind, id });
const keys = list => list.map(tab => `${tab.kind}:${tab.id}`);

test('tab close: ranges, and the session tab stays for one of its agents', () => {
  const tabs = [T('agent', 'S'), T('panel', 'terminal'), T('agent', 'C'), T('task', 't1')];
  assert.deepEqual(keys(closeRange(tabs, tabs[1], 'left', 'S')), ['agent:S']);
  assert.deepEqual(keys(closeRange(tabs, tabs[1], 'right', 'S')), ['agent:C', 'task:t1']);
  assert.deepEqual(keys(closeRange(tabs, tabs[1], 'others', 'S')), ['agent:S', 'agent:C', 'task:t1']);
  // Kept: the child agent C. The session's tab S is not closed with the others.
  assert.deepEqual(keys(closeRange(tabs, tabs[2], 'others', 'S')), ['panel:terminal', 'task:t1']);
  assert.deepEqual(keys(closeRange(tabs, tabs[2], 'left', 'S')), ['panel:terminal']);
  assert.deepEqual(closeRange([T('agent', 'S'), T('agent', 'C')], T('agent', 'C'), 'left', 'S'), []);
  assert.deepEqual(closeRange(tabs, T('panel', 'diff'), 'others', 'S'), []);
});

test('tab close: the tab in front after closing', () => {
  const tabs = [T('agent', 'S'), T('panel', 'terminal'), T('agent', 'C'), T('task', 't1')];
  // Active closed: the next one, else the previous one.
  assert.deepEqual(planClose({ tabs, active: tabs[2], selected: 'S', closing: [tabs[2]] }), { closingRoot: false, next: tabs[3] });
  assert.deepEqual(planClose({ tabs, active: tabs[3], selected: 'S', closing: [tabs[3]] }), { closingRoot: false, next: tabs[2] });
  // Close to the right of Terminal while C is active: Terminal (the kept tab) comes forward.
  assert.deepEqual(planClose({ tabs, active: tabs[2], selected: 'S', closing: [tabs[2], tabs[3]], keep: tabs[1] }).next, tabs[1]);
  // The session's tab closed: every agent tab goes; the active panel stays in front.
  assert.deepEqual(planClose({ tabs, active: tabs[1], selected: 'S', closing: [tabs[0]] }), { closingRoot: true, next: tabs[1] });
  // …and an active child agent gives way to the first tab left.
  assert.deepEqual(planClose({ tabs, active: tabs[2], selected: 'S', closing: [tabs[0]] }), { closingRoot: true, next: tabs[1] });
  assert.deepEqual(planClose({ tabs: [tabs[0]], active: tabs[0], selected: 'S', closing: [tabs[0]] }), { closingRoot: true, next: null });
});
