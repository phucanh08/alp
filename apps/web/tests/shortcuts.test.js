// Paseo's workspace shortcuts as lib/shortcuts.js maps them, and the History grouping.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BINDINGS, formatShortcut, helpSections, isEditable, matchShortcut, shortcutKeys, shortcutLabel } from '../src/lib/shortcuts.js';
import { dateSection, groupHistory } from '../src/lib/history.js';

const press = (code, key, mods = {}) => ({ code, key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test('Mod is Cmd on a Mac and Ctrl elsewhere; other modifiers must match exactly', () => {
  assert.equal(matchShortcut(press('KeyN', 'n', { metaKey: true }), { mac: true })?.binding.action, 'session.new');
  assert.equal(matchShortcut(press('KeyN', 'n', { ctrlKey: true }), { mac: true }), null);
  assert.equal(matchShortcut(press('KeyN', 'n', { ctrlKey: true }), { mac: false })?.binding.action, 'session.new');
  assert.equal(matchShortcut(press('KeyN', 'n', { ctrlKey: true, shiftKey: true }), { mac: false }), null);
  assert.equal(matchShortcut(press('Backspace', 'Backspace', { metaKey: true, shiftKey: true }), { mac: true })?.binding.action, 'session.archive');
});

test('Alt combos match the physical key, whatever character Alt types', () => {
  const jump = matchShortcut(press('Digit3', '£', { altKey: true }), { mac: true });
  assert.equal(jump?.binding.action, 'session.index');
  assert.equal(jump?.index, 3);
  const tab = matchShortcut(press('Digit2', '€', { altKey: true, shiftKey: true }), { mac: true });
  assert.equal(tab?.binding.action, 'tab.index');
  assert.equal(tab?.index, 2);
  assert.equal(matchShortcut(press('Digit0', 'º', { altKey: true }), { mac: true }), null);
  const previous = matchShortcut(press('BracketLeft', '“', { altKey: true }), { mac: true });
  assert.deepEqual([previous?.binding.action, previous?.binding.delta], ['session.relative', -1]);
  const nextTab = matchShortcut(press('BracketRight', '’', { altKey: true, shiftKey: true }), { mac: true });
  assert.deepEqual([nextTab?.binding.action, nextTab?.binding.delta], ['tab.relative', 1]);
  assert.equal(matchShortcut(press('KeyW', '„', { altKey: true, shiftKey: true }), { mac: true })?.binding.action, 'tab.close');
});

test('Shift+? only outside text fields; the composer keys are left to the composer', () => {
  assert.equal(matchShortcut(press('Slash', '?', { shiftKey: true }), { mac: true })?.binding.action, 'shortcuts.toggle');
  assert.equal(matchShortcut(press('Slash', '?', { shiftKey: true }), { mac: true, editable: true }), null);
  assert.equal(matchShortcut(press('KeyL', 'l', { metaKey: true }), { mac: true }), null);
  assert.equal(matchShortcut(press('Escape', 'Escape'), { mac: true }), null);
  assert.equal(matchShortcut(press('Backquote', '`', { ctrlKey: true }), { mac: true })?.binding.action, 'sidebar.right');
});

test('keys display as Paseo shows them', () => {
  const archive = BINDINGS.find(binding => binding.action === 'session.archive');
  assert.ok(archive);
  assert.equal(formatShortcut(shortcutKeys(archive, true), true), '⇧⌘⌫');
  assert.equal(formatShortcut(shortcutKeys(archive, false), false), 'Ctrl+Shift+⌫');
  assert.equal(shortcutLabel('session.new', true), '⌘N');
  assert.equal(shortcutLabel('session.index', false), 'Alt+1-9');
  assert.equal(shortcutLabel('shortcuts.toggle', true), '?');
  const sections = helpSections(true);
  assert.deepEqual(sections.map(section => section.title), ['General', 'Projects & Workspaces', 'Tabs & Panes', 'Layout', 'Agent Input']);
  assert.equal(sections.flatMap(section => section.rows).filter(row => row.label === 'Toggle Explorer sidebar').length, 1);
  assert.deepEqual(helpSections(true, 'previous').flatMap(section => section.rows.map(row => row.label)), ['Previous session', 'Previous tab']);
});

test('ALP.app uses Paseo\'s desktop set; a browser keeps the web set', () => {
  const desktop = { mac: true, desktop: true };
  // Cmd+W closes the tab in ALP.app; a browser keeps Cmd+W for itself and closes with Alt+Shift+W.
  assert.equal(matchShortcut(press('KeyW', 'w', { metaKey: true }), desktop)?.binding.action, 'tab.close');
  assert.equal(matchShortcut(press('KeyW', 'w', { metaKey: true }), { mac: true }), null);
  assert.equal(matchShortcut(press('KeyW', '„', { altKey: true, shiftKey: true }), desktop), null);
  assert.equal(matchShortcut(press('KeyW', 'w', { ctrlKey: true }), { mac: false, desktop: true })?.binding.action, 'tab.close');
  // Cmd+1-9 jumps to a session, Cmd+Alt+1-9 to a tab (Alt+1-9 off a Mac); Cmd+[ ] steps sessions.
  const session = matchShortcut(press('Digit4', '4', { metaKey: true }), desktop);
  assert.deepEqual([session?.binding.action, session?.index], ['session.index', 4]);
  const tab = matchShortcut(press('Digit2', '™', { metaKey: true, altKey: true }), desktop);
  assert.deepEqual([tab?.binding.action, tab?.index], ['tab.index', 2]);
  const otherTab = matchShortcut(press('Digit2', '2', { altKey: true }), { mac: false, desktop: true });
  assert.deepEqual([otherTab?.binding.action, otherTab?.index], ['tab.index', 2]);
  assert.equal(matchShortcut(press('Digit2', '™', { altKey: true }), desktop), null);
  assert.equal(matchShortcut(press('Digit2', '€', { altKey: true, shiftKey: true }), desktop), null);
  assert.deepEqual(matchShortcut(press('BracketRight', ']', { metaKey: true }), desktop)?.binding.delta, 1);
  assert.equal(matchShortcut(press('BracketLeft', '“', { altKey: true }), desktop), null);
  // The browser set does not take Cmd+1-9 (the browser's own tab keys).
  assert.equal(matchShortcut(press('Digit4', '4', { metaKey: true }), { mac: true }), null);
  // Labels and the dialog follow the set in use.
  assert.equal(shortcutLabel('tab.close', true, true), '⌘W');
  assert.equal(shortcutLabel('tab.close', true), '⌥⇧W');
  assert.equal(shortcutLabel('session.index', true, true), '⌘1-9');
  assert.equal(shortcutLabel('session.relative', true, true, -1), '⌘[');
  const rows = (/** @type {boolean} */ isDesktop) => helpSections(true, '', isDesktop).flatMap(section => section.rows);
  assert.deepEqual(rows(true).filter(row => row.label === 'Jump to tab').map(row => row.keys), ['⌥⌘1-9']);
  assert.deepEqual(rows(false).filter(row => row.label === 'Jump to tab').map(row => row.keys), ['⌥⇧1-9']);
  assert.deepEqual(helpSections(false, '', true).flatMap(section => section.rows).filter(row => row.label === 'Jump to tab').map(row => row.keys), ['Alt+1-9']);
  assert.equal(rows(true).filter(row => row.label === 'Close current tab').length, 1);
  assert.equal(rows(true).find(row => row.label === 'Close pane')?.note, undefined);
  assert.ok(rows(false).find(row => row.label === 'Close pane')?.note);
});

test('text fields are editable; buttons and checkboxes are not', () => {
  const element = (tagName, extra = {}) => ({ tagName, closest: () => null, ...extra });
  assert.equal(isEditable(element('TEXTAREA')), true);
  assert.equal(isEditable(element('INPUT', { type: 'search' })), true);
  assert.equal(isEditable(element('INPUT', { type: 'checkbox' })), false);
  assert.equal(isEditable(element('DIV', { isContentEditable: true })), true);
  assert.equal(isEditable(element('BUTTON')), false);
  assert.equal(isEditable(null), false);
});

test('History groups by the calendar day of the last activity, newest first, and filters by title', () => {
  const now = new Date(2026, 9, 17, 10, 0);
  const at = (days, hours = 9) => new Date(2026, 9, 17 - days, hours).toISOString();
  assert.equal(dateSection(at(0, 0), now), 'today');
  assert.equal(dateSection(at(1, 23), now), 'yesterday');
  assert.equal(dateSection(at(5), now), 'thisWeek');
  assert.equal(dateSection(at(20), now), 'thisMonth');
  assert.equal(dateSection(at(90), now), 'older');
  assert.equal(dateSection(undefined, now), 'older');
  const sessions = [
    { id: 'a', title: 'Ship the release', updatedAt: at(0) },
    { id: 'b', title: 'Fix login', updatedAt: at(1) },
    { id: 'c', title: 'Old release notes', createdAt: at(40) },
  ];
  assert.deepEqual(groupHistory(sessions, '', now).map(section => [section.label, section.sessions.map(session => session.id)]), [['Today', ['a']], ['Yesterday', ['b']], ['Older', ['c']]]);
  assert.deepEqual(groupHistory(sessions, 'RELEASE', now).flatMap(section => section.sessions.map(session => session.id)), ['a', 'c']);
  // Every word, in any order, as a host that searches matches.
  assert.deepEqual(groupHistory(sessions, ' notes  release ', now).flatMap(section => section.sessions.map(session => session.id)), ['c']);
});
