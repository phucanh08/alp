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

// ---- Settings › Shortcuts: the user's keys (Paseo's ShortcutOverrides) ---------------------------

import { NOT_SET, bindingId, checkCapture, combosCollide, comboFromEvent, effectiveBindings, isRebindable, normalizeCombo, parseShortcutOverrides, setShortcutOverrides, shortcutSections } from '../src/lib/shortcuts.js';

test('every rebindable row has one id per platform; aliases and the composer keys are not rebindable', () => {
  for (const mac of [true, false]) for (const desktop of [true, false]) {
    const ids = BINDINGS.filter(binding => isRebindable(binding) && (binding.mac === undefined || binding.mac === mac) && (binding.desktop === undefined || binding.desktop === desktop)).map(bindingId);
    assert.equal(new Set(ids).size, ids.length, `${mac} ${desktop}`);
  }
  assert.deepEqual(BINDINGS.filter(binding => binding.action === 'session.relative').map(bindingId), ['session.relative:previous@desktop', 'session.relative:next@desktop', 'session.relative:previous@browser', 'session.relative:next@browser']);
  for (const action of ['composer.focus', 'composer.mode', 'agent.interrupt', 'pane.find']) assert.equal(isRebindable(BINDINGS.find(binding => binding.action === action)), false, action);
  assert.equal(isRebindable(BINDINGS.find(binding => binding.combo === 'Ctrl+`')), false);
});

test('stored overrides are parsed tolerantly: known ids, valid combos or null, digits only for 1-9 rows', () => {
  assert.deepEqual(parseShortcutOverrides(null), {});
  assert.deepEqual(parseShortcutOverrides([['sidebar.left', 'Mod+J']]), {});
  assert.deepEqual(parseShortcutOverrides({
    'sidebar.left': 'Mod+j', 'sidebar.right': null, 'composer.focus': 'Mod+J', unknown: 'Mod+J', 'sidebar.both': 'Mod+Hyper+J',
    'session.new': 'Mod+Digit', 'session.index@browser': 'Alt+J', 'session.index@desktop': 'Mod+Shift+Digit', 'settings.toggle': 42, 'tab.menu': 'x'.repeat(200),
  }), { 'sidebar.left': 'Mod+J', 'sidebar.right': null, 'session.index@desktop': 'Mod+Shift+Digit' });
  assert.deepEqual(parseShortcutOverrides(JSON.parse('{"__proto__":"Mod+J","constructor":null,"tab.menu":"Mod+Y"}')), { 'tab.menu': 'Mod+Y' });
  assert.equal(normalizeCombo('Shift+Alt+Mod+k'), 'Mod+Alt+Shift+K');
  assert.equal(normalizeCombo('Mod+Mod+K'), null);
  assert.equal(normalizeCombo('Mod+'), null);
  const many = Object.fromEntries(BINDINGS.filter(isRebindable).map(binding => [bindingId(binding), null]));
  assert.ok(Object.keys(parseShortcutOverrides(many)).length <= 64);
});

test('a rebound shortcut fires on its new keys only; a cleared one fires on none and shows Not set', () => {
  try {
    setShortcutOverrides({ 'sidebar.left': 'Mod+J', 'sidebar.right': null, 'session.index@browser': 'Ctrl+Alt+Digit' });
    assert.equal(matchShortcut(press('KeyJ', 'j', { metaKey: true }), { mac: true })?.binding.action, 'sidebar.left');
    assert.equal(matchShortcut(press('KeyB', 'b', { metaKey: true }), { mac: true }), null);
    assert.equal(matchShortcut(press('KeyE', 'e', { metaKey: true }), { mac: true }), null);
    // The alias follows its row: Ctrl+` no longer toggles the cleared Explorer sidebar.
    assert.equal(matchShortcut(press('Backquote', '`', { ctrlKey: true }), { mac: true }), null);
    const jump = matchShortcut(press('Digit5', '5', { ctrlKey: true, altKey: true }), { mac: true });
    assert.deepEqual([jump?.binding.action, jump?.index], ['session.index', 5]);
    assert.equal(matchShortcut(press('Digit5', '∞', { altKey: true }), { mac: true }), null);
    assert.equal(shortcutLabel('sidebar.left', true), '⌘J');
    assert.equal(shortcutLabel('sidebar.right', true), '');
    assert.equal(shortcutLabel('session.index', true), '⌃⌥1-9');
    const rows = helpSections(true).flatMap(section => section.rows);
    assert.equal(rows.find(row => row.label === 'Toggle left sidebar')?.keys, '⌘J');
    assert.equal(rows.find(row => row.label === 'Toggle Explorer sidebar')?.keys, NOT_SET);
    // The desktop build's own row keeps its default.
    assert.equal(shortcutLabel('session.index', true, true), '⌘1-9');
    const settingsRows = shortcutSections(true).flatMap(section => section.rows);
    assert.deepEqual(settingsRows.filter(row => row.overridden).map(row => [row.id, row.keys, row.defaultKeys]),
      [['session.index@browser', '⌃⌥1-9', '⌥1-9'], ['sidebar.left', '⌘J', '⌘B'], ['sidebar.right', '', '⌘E']]);
  } finally {
    setShortcutOverrides({});
  }
  assert.equal(shortcutLabel('sidebar.left', true), '⌘B');
  assert.equal(effectiveBindings().length, BINDINGS.length);
});

test('capture reads the physical key with Mod for the platform\'s main modifier', () => {
  assert.equal(comboFromEvent(press('MetaLeft', 'Meta', { metaKey: true }), true), '');
  assert.equal(comboFromEvent(press('KeyJ', 'j', { metaKey: true }), true), 'Mod+J');
  assert.equal(comboFromEvent(press('KeyJ', 'j', { ctrlKey: true }), false), 'Mod+J');
  assert.equal(comboFromEvent(press('KeyJ', 'j', { ctrlKey: true }), true), 'Ctrl+J');
  assert.equal(comboFromEvent(press('KeyJ', 'j', { metaKey: true }), false), 'Cmd+J');
  assert.equal(comboFromEvent(press('Digit3', '£', { altKey: true }), true), 'Alt+3');
  assert.equal(comboFromEvent(press('BracketLeft', '“', { altKey: true, shiftKey: true }), true), 'Alt+Shift+[');
  assert.equal(comboFromEvent(press('F5', 'F5'), true), 'F5');
  assert.equal(comboFromEvent(press('IntlBackslash', '§', { metaKey: true }), true), null);
});

test('capture refuses keys that would type, keys taken by another shortcut, and a 1-9 row without a number', () => {
  const mac = { mac: true };
  assert.deepEqual(checkCapture('sidebar.left', 'Mod+J', mac), { combo: 'Mod+J' });
  assert.match(/** @type {any} */ (checkCapture('sidebar.left', 'J', mac)).error, /Add ⌘/);
  assert.match(/** @type {any} */ (checkCapture('sidebar.left', 'Shift+J', { mac: false })).error, /Add Ctrl or Alt/);
  assert.deepEqual(checkCapture('sidebar.left', 'F6', mac), { combo: 'F6' });
  // Outside text fields only: Shift+? may be any typing key.
  assert.deepEqual(checkCapture('shortcuts.toggle', 'Shift+/', mac), { combo: 'Shift+/' });
  assert.equal(/** @type {any} */ (checkCapture('sidebar.left', 'Mod+E', mac)).error, '⌘E is already used by Toggle Explorer sidebar.');
  assert.equal(/** @type {any} */ (checkCapture('sidebar.left', 'Mod+L', mac)).error, '⌘L is already used by Focus message input.');
  assert.equal(/** @type {any} */ (checkCapture('sidebar.left', 'Ctrl+`', mac)).error, '⌃` is already used by Toggle Explorer sidebar.');
  // A number collides with the 1-9 wildcard; the desktop build's Mod+1-9 is not in a browser's set.
  assert.match(/** @type {any} */ (checkCapture('sidebar.left', 'Alt+4', mac)).error, /Jump to session/);
  assert.deepEqual(checkCapture('sidebar.left', 'Mod+4', mac), { combo: 'Mod+4' });
  assert.match(/** @type {any} */ (checkCapture('sidebar.left', 'Mod+4', { mac: true, desktop: true })).error, /Jump to session/);
  // A cleared shortcut frees its keys; a shortcut moved away frees its default.
  assert.deepEqual(checkCapture('sidebar.left', 'Mod+E', { mac: true, overrides: { 'sidebar.right': null } }), { combo: 'Mod+E' });
  assert.match(/** @type {any} */ (checkCapture('sidebar.right', 'Mod+J', { mac: true, overrides: { 'sidebar.left': 'Mod+J' } })).error, /Toggle left sidebar/);
  assert.deepEqual(checkCapture('session.index@browser', 'Ctrl+Alt+7', mac), { combo: 'Ctrl+Alt+Digit' });
  assert.equal(/** @type {any} */ (checkCapture('session.index@browser', 'Ctrl+Alt+K', mac)).error, 'End with a number from 1 to 9.');
  assert.equal(/** @type {any} */ (checkCapture('composer.focus', 'Mod+J', mac)).error, 'This shortcut cannot be changed.');
  assert.equal(/** @type {any} */ (checkCapture('tab.close@desktop', 'Mod+J', mac)).error, 'This shortcut cannot be changed.');
  assert.equal(combosCollide('Shift+?', 'Shift+/', true), true);
  assert.equal(combosCollide('Mod+K', 'Ctrl+K', true), false);
  assert.equal(combosCollide('Mod+K', 'Ctrl+K', false), true);
});
