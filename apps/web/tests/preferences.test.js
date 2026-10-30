// The app's preferences in browser storage (lib/preferences.js): Paseo 0.14's app settings that
// apply in a browser, versioned, read tolerantly field by field (clamped to Paseo's limits),
// written with known fields only (never the token), and a storage that throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, LIMITS, PREFERENCES_KEY, PREFERENCES_VERSION, loadPreferences, parsePreferences, rememberChoices, savePreferences, serializePreferences } from '../src/lib/preferences.js';

const memory = (initial = {}) => {
  const entries = new Map(Object.entries(initial));
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, String(value)); } };
};
const parse = value => parsePreferences(JSON.stringify({ v: PREFERENCES_VERSION, ...value }));

/** Paseo 0.14's defaults (hooks/use-settings/storage.ts DEFAULT_CLIENT_SETTINGS) as ALP keeps them. */
const DEFAULTS = {
  sendBehavior: 'steer', sendShortcut: 'enter', theme: 'system',
  uiFontFamily: '', monoFontFamily: '', uiFontSize: 14, contentFontSize: 15, codeFontSize: 12,
  contentMaxWidth: null, syntaxTheme: 'one',
  chatDisplay: 'collapseTurns', chatOutline: true, terminalScrollback: 10_000,
  sidebar: {
    header: [{ id: 'new-session', visible: true }, { id: 'history', visible: true }, { id: 'search', visible: true }],
    footer: [{ id: 'tasks', visible: false }],
  },
  sidebarDisplay: { grouping: 'project', sort: 'created', titleSource: 'title', rowItems: { branch: false, project: false, host: true, labels: true }, trailing: 'timestamp', projectFilters: [] },
  newSession: {},
};

test('nothing stored, garbage, another version or a non-object give Paseo\'s defaults', () => {
  for (const raw of [null, undefined, '', 'not json', '[]', 'null', '42', '"steer"', JSON.stringify({ v: 2, sendBehavior: 'queue' }), JSON.stringify({ sendBehavior: 'queue' })]) {
    assert.deepEqual(parsePreferences(raw), DEFAULTS, String(raw));
  }
  assert.deepEqual(JSON.parse(JSON.stringify(DEFAULT_PREFERENCES)), DEFAULTS);
});

test('each field falls back on its own; unknown and retired fields are dropped', () => {
  const parsed = parse({ sendBehavior: 'interrupt', sendShortcut: 'mod-enter', theme: 'purple', extra: 'x', contentWidth: 'wide', toolCalls: 'expanded', terminal: { fontSize: 16 },
    newSession: { team: 'cafe', mode: 42, model: ' ', thinkingByModel: { 'codex:a': 'high', 'codex:b': 7, '': 'low' } } });
  assert.deepEqual(parsed, { ...DEFAULTS, sendBehavior: 'interrupt', sendShortcut: 'mod-enter', newSession: { team: 'cafe', thinkingByModel: { 'codex:a': 'high' } } });
  assert.deepEqual(parse({ sendBehavior: 'sideways', theme: 'claude', newSession: 'cafe' }), { ...DEFAULTS, theme: 'claude' });
  assert.deepEqual(parse({ newSession: { team: 'x'.repeat(201) } }).newSession, {});
});

test('every theme, chat display and syntax theme Paseo offers is kept', () => {
  for (const theme of ['system', 'light', 'dark', 'zinc', 'midnight', 'claude', 'ghostty', 'pureBlack']) assert.equal(parse({ theme }).theme, theme);
  for (const chatDisplay of ['full', 'collapseToolCalls', 'collapseTurns']) assert.equal(parse({ chatDisplay }).chatDisplay, chatDisplay);
  for (const syntaxTheme of ['github', 'catppuccin', 'dracula', 'tokyo-night', 'one', 'nord', 'gruvbox', 'solarized']) assert.equal(parse({ syntaxTheme }).syntaxTheme, syntaxTheme);
  assert.equal(parse({ chatDisplay: 'overview', syntaxTheme: 'monokai', chatOutline: 'yes' }).chatDisplay, 'collapseTurns');
  assert.equal(parse({ chatOutline: false }).chatOutline, false);
  assert.equal(parse({ chatOutline: 'no' }).chatOutline, true);
});

test('sizes, scrollback and content width are clamped to Paseo\'s limits; non-numbers give the default', () => {
  assert.deepEqual(LIMITS, { uiFontSize: [10, 21, 14], contentFontSize: [10, 21, 15], codeFontSize: [9, 22, 12], contentMaxWidth: [600, 4000, 820], terminalScrollback: [0, 1_000_000, 10_000] });
  const low = parse({ uiFontSize: 2, contentFontSize: 0, codeFontSize: -4, contentMaxWidth: 10, terminalScrollback: -1 });
  assert.deepEqual([low.uiFontSize, low.contentFontSize, low.codeFontSize, low.contentMaxWidth, low.terminalScrollback], [10, 10, 9, 600, 0]);
  const high = parse({ uiFontSize: 99, contentFontSize: 99, codeFontSize: 99, contentMaxWidth: 99_999, terminalScrollback: 5e9 });
  assert.deepEqual([high.uiFontSize, high.contentFontSize, high.codeFontSize, high.contentMaxWidth, high.terminalScrollback], [21, 21, 22, 4000, 1_000_000]);
  assert.equal(parse({ uiFontSize: 16.6 }).uiFontSize, 17);
  const junk = parse({ uiFontSize: '16', codeFontSize: null, contentMaxWidth: 'wide', terminalScrollback: Infinity });
  assert.deepEqual([junk.uiFontSize, junk.codeFontSize, junk.contentMaxWidth, junk.terminalScrollback], [14, 12, null, 10_000]);
  assert.equal(parse({ contentMaxWidth: null }).contentMaxWidth, null);
});

test('font families are kept as typed (trimmed, up to 200 characters), never CSS-breaking text', () => {
  assert.equal(parse({ uiFontFamily: '  "IBM Plex Sans", sans-serif ' }).uiFontFamily, '"IBM Plex Sans", sans-serif');
  assert.equal(parse({ monoFontFamily: 'Fira Code' }).monoFontFamily, 'Fira Code');
  for (const bad of ['x'.repeat(201), 'Inter; color: red', 'a{b}', '</style>', 'a\\b', 42]) assert.equal(parse({ uiFontFamily: bad }).uiFontFamily, '', String(bad));
});

test('sidebar sections keep the stored order and switches; unknown rows are dropped, missing ones added', () => {
  const sidebar = parse({ sidebar: { header: [{ id: 'search', visible: false }, { id: 'nope' }, { id: 'search', visible: true }, { id: 'new-session', visible: true }], footer: [{ id: 'tasks', visible: true }, { id: 'history', visible: true }] } }).sidebar;
  assert.deepEqual(sidebar, {
    header: [{ id: 'search', visible: false }, { id: 'new-session', visible: true }, { id: 'history', visible: true }],
    footer: [{ id: 'tasks', visible: true }],
  });
  assert.deepEqual(parse({ sidebar: 'compact' }).sidebar, DEFAULTS.sidebar);
});

test('serialize writes the version and known fields only: a token on the object never reaches storage', () => {
  const stored = serializePreferences({ ...DEFAULT_PREFERENCES, sendBehavior: 'queue', theme: 'dark', newSession: { model: 'codex:gpt', thinkingByModel: { 'codex:gpt': 'high' } }, token: 'alpgw1.secret', gateway: 'https://h' });
  const object = JSON.parse(stored);
  assert.deepEqual(Object.keys(object), ['v', ...Object.keys(DEFAULTS)]);
  assert.equal(object.v, 1);
  assert.doesNotMatch(stored, /secret|gateway|https/);
  assert.deepEqual(parsePreferences(stored), { ...DEFAULTS, sendBehavior: 'queue', theme: 'dark', newSession: { model: 'codex:gpt', thinkingByModel: { 'codex:gpt': 'high' } } });
});

test('load and save through a storage; one that throws gives the defaults and reports the failed save', () => {
  const storage = memory();
  assert.equal(savePreferences(storage, { ...DEFAULT_PREFERENCES, sendBehavior: 'queue', theme: 'light' }), true);
  assert.equal(JSON.parse(storage.entries.get(PREFERENCES_KEY)).sendBehavior, 'queue');
  assert.deepEqual(loadPreferences(storage), { ...DEFAULTS, sendBehavior: 'queue', theme: 'light' });
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(loadPreferences(broken), DEFAULTS);
  assert.equal(savePreferences(broken, DEFAULT_PREFERENCES), false);
  assert.deepEqual(loadPreferences(undefined).sendBehavior, 'steer');
  // Garbage in storage is replaced by the next save.
  const dirty = memory({ [PREFERENCES_KEY]: '{oops' });
  assert.equal(loadPreferences(dirty).theme, 'system');
  savePreferences(dirty, loadPreferences(dirty));
  assert.equal(JSON.parse(dirty.entries.get(PREFERENCES_KEY)).v, 1);
});

test('remembered New session choices: thinking per model, the team default under "default", empty choices forgotten', () => {
  let choices = rememberChoices({}, { team: 'cafe', mode: 'workspace-write', model: 'codex:gpt', thinking: 'high' });
  assert.deepEqual(choices, { team: 'cafe', mode: 'workspace-write', model: 'codex:gpt', thinkingByModel: { 'codex:gpt': 'high' } });
  choices = rememberChoices(choices, { mode: 'full-access', thinking: 'medium' });
  assert.deepEqual(choices, { mode: 'full-access', thinkingByModel: { 'codex:gpt': 'high', default: 'medium' } });
  choices = rememberChoices(choices, { model: 'codex:gpt' });
  assert.deepEqual(choices, { model: 'codex:gpt', thinkingByModel: { default: 'medium' } });
});

test('thinking per model never keeps a model named after an Object.prototype member', () => {
  const raw = `{"v":${PREFERENCES_VERSION},"newSession":{"thinkingByModel":{"__proto__":"high","constructor":"low","toString":"medium","codex:a":"high"}}}`;
  const thinking = parsePreferences(raw).newSession.thinkingByModel;
  assert.deepEqual(thinking, { 'codex:a': 'high' });
  for (const key of ['__proto__', 'constructor', 'toString']) assert.equal(Object.hasOwn(thinking, key), false, key);
  assert.equal(Object.getPrototypeOf(thinking), Object.prototype);
  assert.deepEqual(parsePreferences(`{"v":${PREFERENCES_VERSION},"newSession":{"model":"codex:a","thinkingByModel":{"constructor":"low","toString":"low"}}}`).newSession, { model: 'codex:a' });
  for (const model of ['__proto__', 'constructor', 'toString']) {
    const remembered = rememberChoices({ thinkingByModel: { 'codex:a': 'high' } }, { model, thinking: 'low' });
    assert.deepEqual(remembered.thinkingByModel, { 'codex:a': 'high' }, model);
    assert.equal(Object.getPrototypeOf(remembered.thinkingByModel), Object.prototype, model);
  }
  assert.equal(({}).polluted, undefined);
});

test('sidebar display preferences: Paseo\'s choices kept, anything else its default, filters de-duplicated and bounded', () => {
  const display = parse({ sidebarDisplay: { grouping: 'status', sort: 'lastPrompt', titleSource: 'branch', rowItems: { branch: true, host: false, checks: true, labels: 'yes' }, trailing: 'none', projectFilters: ['/a', '/a', '', 7, '/b'] } }).sidebarDisplay;
  assert.deepEqual(display, { grouping: 'status', sort: 'lastPrompt', titleSource: 'branch', rowItems: { branch: true, project: false, host: false, labels: true }, trailing: 'none', projectFilters: ['/a', '/b'] });
  assert.deepEqual(parse({ sidebarDisplay: { grouping: 'labels', sort: 'manual', trailing: 'diff' } }).sidebarDisplay, DEFAULTS.sidebarDisplay);
  assert.equal(parse({ sidebarDisplay: { projectFilters: Array.from({ length: 100 }, (_, index) => `/p${index}`) } }).sidebarDisplay.projectFilters.length, 64);
});
