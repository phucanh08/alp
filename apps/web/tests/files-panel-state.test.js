// The Files panel's kept choices (t-81b0.13), as Paseo's panel-store keeps explorerSortOption,
// explorerShowHiddenFiles and expandedPathsByWorkspace: read tolerantly, bounded, per workspace,
// these fields only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FILES_PANEL_KEY, MAX_EXPANDED, MAX_PATH_CHARS, MAX_WORKSPACES, expandedFor, loadFilesPanelState, parseFilesPanelState,
  serializeFilesPanelState, updateFilesPanelState, withExpanded,
} from '../src/lib/files-panel-state.js';
import { workspaceScope } from '../src/lib/layout.js';

const DEFAULTS = { sort: 'name', showHidden: false, workspaces: {} };
const A = workspaceScope('https://host-a.example', '/Users/me/project');
const B = workspaceScope('https://host-b.example', '/Users/me/project');

function memory() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), map };
}

test('defaults: sorted by name, hidden files off, no folders; garbage and other versions give them', () => {
  for (const raw of [null, undefined, '', '{', '[]', '42', 'null', JSON.stringify({ v: 2, sort: 'size', showHidden: true })]) {
    assert.deepEqual(parseFilesPanelState(raw), DEFAULTS, String(raw));
  }
  assert.deepEqual(loadFilesPanelState(undefined), DEFAULTS);
  assert.deepEqual(loadFilesPanelState({ getItem() { throw new Error('denied'); }, setItem() {} }), DEFAULTS);
});

test('a bad field falls back on its own', () => {
  const raw = JSON.stringify({ v: 1, sort: 'random', showHidden: 'yes', workspaces: { [A]: { expanded: ['src'], at: 5 } } });
  assert.deepEqual(parseFilesPanelState(raw), { sort: 'name', showHidden: false, workspaces: { [A]: { expanded: ['src'], at: 5 } } });
  for (const sort of ['name', 'modified', 'size']) assert.equal(parseFilesPanelState(JSON.stringify({ v: 1, sort })).sort, sort);
  assert.equal(parseFilesPanelState(JSON.stringify({ v: 1, showHidden: true })).showHidden, true);
  assert.deepEqual(parseFilesPanelState(JSON.stringify({ v: 1, workspaces: [] })).workspaces, {});
});

test('folders: workspace-relative, clean, never blocked, bounded; a workspace without any is dropped', () => {
  const long = `${'a/'.repeat(MAX_PATH_CHARS)}x`;
  const raw = JSON.stringify({ v: 1, workspaces: {
    [A]: { expanded: ['src', 'src', 'src/lib', '/etc', '../up', 'a/../b', './src', 'C:/x', 'a\\b', '', 7, null, '.git', '.alp/state', long, 'docs'], at: 1 },
    [B]: { expanded: ['/abs', '..'], at: 2 },
    [workspaceScope('g', 'w')]: 'not an object',
    ['x'.repeat(5000)]: { expanded: ['src'], at: 3 },
  } });
  assert.deepEqual(parseFilesPanelState(raw).workspaces, { [A]: { expanded: ['src', 'src/lib', 'docs'], at: 1 } });

  const many = Array.from({ length: MAX_EXPANDED + 10 }, (_, index) => `d${index}`);
  const kept = expandedFor(parseFilesPanelState(JSON.stringify({ v: 1, workspaces: { [A]: { expanded: many, at: 1 } } })), A);
  assert.equal(kept.length, MAX_EXPANDED);
  assert.equal(kept.at(-1), `d${MAX_EXPANDED + 9}`, 'the folders opened last are the ones kept');
});

test('workspaces: at most MAX_WORKSPACES, the least recently changed dropped first', () => {
  let state = parseFilesPanelState(null);
  for (let index = 0; index < MAX_WORKSPACES + 5; index++) state = withExpanded(state, workspaceScope('g', `/w${index}`), ['src'], 1000 + index);
  const stored = parseFilesPanelState(serializeFilesPanelState(state));
  assert.equal(Object.keys(stored.workspaces).length, MAX_WORKSPACES);
  assert.deepEqual(expandedFor(stored, workspaceScope('g', '/w0')), []);
  assert.deepEqual(expandedFor(stored, workspaceScope('g', `/w${MAX_WORKSPACES + 4}`)), ['src']);
});

test('per workspace: the same path on another gateway keeps its own folders; none forgets the workspace', () => {
  let state = withExpanded(parseFilesPanelState(null), A, ['src', 'src/lib'], 10);
  state = withExpanded(state, B, ['docs'], 11);
  assert.deepEqual(expandedFor(state, A), ['src', 'src/lib']);
  assert.deepEqual(expandedFor(state, B), ['docs']);
  assert.deepEqual(expandedFor(state, workspaceScope('https://host-a.example', '/elsewhere')), []);
  state = withExpanded(state, A, [], 12);
  assert.deepEqual(Object.keys(state.workspaces), [B]);
  // expandedFor hands out a copy: changing it leaves the state alone.
  expandedFor(state, B).push('x');
  assert.deepEqual(expandedFor(state, B), ['docs']);
});

test('stored: these fields only, re-validated, round-trip; update reads, changes and writes in one go', () => {
  const storage = memory();
  const next = updateFilesPanelState(storage, state => ({ ...withExpanded(state, A, ['src', '../x'], 7), sort: 'size', showHidden: true, token: 'secret', gateway: 'g' }));
  assert.deepEqual(next, { sort: 'size', showHidden: true, workspaces: { [A]: { expanded: ['src'], at: 7 } } });
  const text = storage.map.get(FILES_PANEL_KEY);
  assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['showHidden', 'sort', 'v', 'workspaces']);
  assert.ok(!text.includes('secret') && !text.includes('../x'));
  assert.deepEqual(loadFilesPanelState(storage), next);

  // Another tab's change since is kept: the update starts from what storage holds now.
  storage.setItem(FILES_PANEL_KEY, serializeFilesPanelState(withExpanded(next, B, ['lib'], 8)));
  const after = updateFilesPanelState(storage, state => ({ ...state, sort: 'modified' }));
  assert.equal(after.sort, 'modified');
  assert.deepEqual(expandedFor(after, B), ['lib']);
  assert.deepEqual(expandedFor(after, A), ['src']);

  assert.equal(updateFilesPanelState(undefined, state => state), null);
  assert.equal(updateFilesPanelState({ getItem: () => null, setItem() { throw new Error('full'); } }, state => state), null);
});
