// The center column's split panes (lib/panes.js), as Paseo's workspace layout splits, closes,
// navigates and keeps them; and the pane keys of lib/shortcuts.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TREE_DEPTH, adjacentPane, clampSizes, dropPosition, moveToPane, nearestPane, paneIds, paneOf, parsePanes, removePane, resizeGroup, singlePane, splitPane, tabsByPane, treeDepth } from '../src/lib/panes.js';
import { LAYOUT_KEY, loadLayout, updateLayout } from '../src/lib/layout.js';
import { helpSections, matchShortcut, shortcutLabel } from '../src/lib/shortcuts.js';

const id = key => key;

test('panes: split right then down, as Paseo nests and halves them', () => {
  const one = singlePane();
  const two = splitPane(one, { target: 'main', position: 'right', key: 'draft:new' });
  assert.ok(two);
  assert.deepEqual(paneIds(two.root), ['main', 'pane-1']);
  assert.equal(two.focused, 'pane-1');
  assert.equal(two.root.kind === 'group' && two.root.direction, 'horizontal');
  assert.deepEqual(two.root.kind === 'group' && two.root.sizes, [0.5, 0.5]);
  // Same direction: the new pane takes half of the target's share.
  const three = splitPane(two, { target: 'pane-1', position: 'right', key: 'panel:diff' });
  assert.deepEqual(paneIds(three.root), ['main', 'pane-1', 'pane-2']);
  assert.deepEqual(three.root.kind === 'group' && three.root.sizes, [0.5, 0.25, 0.25]);
  // Another direction nests a group; left/top put the new pane first.
  const four = splitPane(three, { target: 'main', position: 'top', key: 'panel:terminal' });
  assert.deepEqual(paneIds(four.root), ['pane-3', 'main', 'pane-1', 'pane-2']);
  assert.equal(treeDepth(four.root), 3);
  assert.equal(paneOf(four, 'panel:terminal'), 'pane-3');
  // Unassigned tabs sit in the focused pane.
  assert.equal(paneOf(four, 'agent:x'), 'pane-3');
  assert.deepEqual(tabsByPane(four, ['agent:x', 'panel:diff', 'draft:new'], id), { 'pane-3': ['agent:x'], main: [], 'pane-1': ['draft:new'], 'pane-2': ['panel:diff'] });
  assert.equal(splitPane(four, { target: 'nope', position: 'right' }), null);
});

test('panes: never deeper than Paseo allows', () => {
  let panes = singlePane();
  let target = 'main';
  for (let n = 0; n < MAX_TREE_DEPTH - 1; n += 1) {
    panes = splitPane(panes, { target, position: n % 2 ? 'right' : 'bottom' });
    target = panes.focused;
  }
  assert.equal(treeDepth(panes.root), MAX_TREE_DEPTH);
  assert.equal(splitPane(panes, { target, position: 'bottom' }), null);
});

test('panes: closing one gives its share back and the focus to its neighbour; the last stays', () => {
  const two = splitPane(singlePane(), { target: 'main', position: 'right', key: 'a' });
  const three = splitPane(two, { target: 'pane-1', position: 'right', key: 'b' });
  assert.equal(nearestPane(three.root, 'pane-1'), 'main');
  assert.equal(nearestPane(three.root, 'main'), 'pane-1');
  const closed = removePane(three, 'pane-2');
  assert.deepEqual(paneIds(closed.root), ['main', 'pane-1']);
  assert.deepEqual(closed.root.kind === 'group' && closed.root.sizes, [2 / 3, 1 / 3]);
  assert.equal(closed.focused, 'pane-1');
  assert.equal(closed.assign.b, undefined);
  const back = removePane(closed, 'pane-1');
  assert.deepEqual(back.root, { kind: 'pane', id: 'main' });
  assert.equal(back.focused, 'main');
  assert.equal(removePane(back, 'main'), null);
});

test('panes: adjacent panes by direction, moves and sizes', () => {
  // main | (pane-1 over pane-2)
  const two = splitPane(singlePane(), { target: 'main', position: 'right' });
  const three = splitPane(two, { target: 'pane-1', position: 'bottom' });
  assert.equal(adjacentPane(three.root, 'main', 'right'), 'pane-1');
  assert.equal(adjacentPane(three.root, 'pane-2', 'left'), 'main');
  assert.equal(adjacentPane(three.root, 'pane-2', 'up'), 'pane-1');
  assert.equal(adjacentPane(three.root, 'pane-1', 'down'), 'pane-2');
  assert.equal(adjacentPane(three.root, 'main', 'left'), null);
  const moved = moveToPane(three, 'panel:diff', 'main');
  assert.equal(moved.focused, 'main');
  assert.equal(paneOf(moved, 'panel:diff'), 'main');
  assert.equal(moved.actives.main, 'panel:diff');
  assert.deepEqual(clampSizes([0.97, 0.03]).map(size => Math.round(size * 100)), [90, 10]);
  assert.deepEqual(clampSizes([0, 0]), [0.5, 0.5]);
  const group = three.root.kind === 'group' ? three.root.id : '';
  const resized = resizeGroup(three, group, [0.3, 0.7]);
  assert.deepEqual(resized.root.kind === 'group' && resized.root.sizes.map(size => Math.round(size * 10)), [3, 7]);
});

test('panes: Paseo drop zones', () => {
  const box = { width: 1000, height: 600 };
  assert.equal(dropPosition({ ...box, x: 500, y: 300 }), 'center');
  assert.equal(dropPosition({ ...box, x: 50, y: 300 }), 'left');
  assert.equal(dropPosition({ ...box, x: 950, y: 300 }), 'right');
  assert.equal(dropPosition({ ...box, x: 500, y: 40 }), 'top');
  assert.equal(dropPosition({ ...box, x: 500, y: 580 }), 'bottom');
  // Between the center and an edge band: the nearest edge.
  assert.equal(dropPosition({ ...box, x: 250, y: 300 }), 'left');
});

test('panes: kept in the layout, checked when read back', () => {
  const store = new Map();
  const storage = { getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) };
  const panes = splitPane(singlePane(), { target: 'main', position: 'right', key: 'panel:diff' });
  updateLayout(storage, layout => ({ ...layout, workspaces: { s: { agents: [], tasks: [], panels: ['diff'], order: [], panes, at: 1 } } }));
  assert.deepEqual(loadLayout(storage).workspaces.s.panes, panes);
  // Garbage, a lone pane, unknown panes and duplicate ids are dropped.
  const raw = JSON.parse(store.get(LAYOUT_KEY));
  raw.workspaces.s.panes.assign['panel:x'] = 'ghost';
  raw.workspaces.s.panes.focused = 'ghost';
  store.set(LAYOUT_KEY, JSON.stringify(raw));
  const read = loadLayout(storage).workspaces.s.panes;
  assert.equal(read.assign['panel:x'], undefined);
  assert.equal(read.focused, 'main');
  assert.equal(parsePanes({ root: { kind: 'pane', id: 'main' } }), undefined);
  assert.equal(parsePanes({ root: { kind: 'group', id: 'g', direction: 'horizontal', children: [{ kind: 'pane', id: 'a' }, { kind: 'pane', id: 'a' }], sizes: [1, 1] } }), undefined);
  assert.equal(parsePanes({ root: { kind: 'group', id: 'g', direction: 'diagonal', children: [], sizes: [] } }), undefined);
  assert.equal(parsePanes('nope'), undefined);
});

test('pane keys: Paseo binds them on a Mac only', () => {
  const press = (code, key, mods = {}) => ({ code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });
  assert.equal(matchShortcut(press('Backslash', '\\', { metaKey: true }), { mac: true })?.binding.action, 'pane.split.right');
  assert.equal(matchShortcut(press('Backslash', '|', { metaKey: true, shiftKey: true }), { mac: true })?.binding.action, 'pane.split.down');
  assert.equal(matchShortcut(press('ArrowLeft', 'ArrowLeft', { metaKey: true, shiftKey: true }), { mac: true })?.binding.action, 'pane.focus.left');
  // Cmd+Shift+Arrow selects text in a text field: left to the field.
  assert.equal(matchShortcut(press('ArrowLeft', 'ArrowLeft', { metaKey: true, shiftKey: true }), { mac: true, editable: true }), null);
  assert.equal(matchShortcut(press('ArrowDown', 'ArrowDown', { metaKey: true, shiftKey: true, altKey: true }), { mac: true })?.binding.action, 'pane.move.down');
  assert.equal(matchShortcut(press('Backslash', '\\', { ctrlKey: true }), { mac: false }), null);
  assert.equal(shortcutLabel('pane.split.down', true), '⇧⌘\\');
  assert.equal(shortcutLabel('pane.focus.up', true), '⇧⌘↑');
  assert.equal(shortcutLabel('pane.split.right', false), '');
  const rows = mac => helpSections(mac).flatMap(section => section.rows.map(row => row.label));
  assert.ok(rows(true).includes('Split pane right'));
  assert.ok(!rows(false).includes('Split pane right'));
});

test("command center: ALP's commands in a section of their own, after the app's actions", async () => {
  const { commandResults } = await import('../src/lib/command-center.js');
  const actions = [
    { id: 'alp-open-tasks', label: 'Open ALP tasks', group: 'alp', always: true },
    { id: 'history', label: 'History', group: 'actions', always: true },
    { id: 'new', label: 'New session', group: 'workspace', always: true },
    { id: 'split', label: 'Split pane right', group: 'workspace', keywords: ['split', 'pane'] },
  ];
  assert.deepEqual(commandResults({ actions, sessions: [], query: '' }).map(section => [section.title, section.rows.map(row => row.item.id)]),
    [['Workspace actions', ['new']], ['Actions', ['history']], ['ALP', ['alp-open-tasks']]]);
  assert.deepEqual(commandResults({ actions, sessions: [], query: 'tasks' }).map(section => section.title), ['ALP']);
  assert.deepEqual(commandResults({ actions, sessions: [], query: 'split' }).flatMap(section => section.rows.map(row => row.item.id)), ['split']);
});
