// The app's preferences in browser storage (lib/preferences.js): versioned, read tolerantly field
// by field, written with known fields only (never the token), and a storage that throws.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PREFERENCES, PREFERENCES_KEY, PREFERENCES_VERSION, loadPreferences, parsePreferences, rememberChoices, savePreferences, serializePreferences } from '../src/lib/preferences.js';

// The display defaults every parsed value carries besides what a test sets.
const DISPLAY = { contentWidth: 'default', toolCalls: 'collapsed' };

const memory = (initial = {}) => {
  const entries = new Map(Object.entries(initial));
  return { entries, getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, String(value)); } };
};

test('nothing stored, garbage, another version or a non-object give the defaults', () => {
  const defaults = { sendBehavior: 'steer', theme: 'system', ...DISPLAY, newSession: {}, terminal: { fontSize: 13, fontFamily: 'mono', theme: 'dark' } };
  for (const raw of [null, undefined, '', 'not json', '[]', 'null', '42', '"steer"', JSON.stringify({ v: 2, sendBehavior: 'queue' }), JSON.stringify({ sendBehavior: 'queue' })]) {
    assert.deepEqual(parsePreferences(raw), defaults, String(raw));
  }
  assert.deepEqual({ ...DEFAULT_PREFERENCES, newSession: {}, terminal: { fontSize: 13, fontFamily: 'mono', theme: 'dark' } }, defaults);
});

test('each field falls back on its own; unknown fields are dropped', () => {
  const raw = JSON.stringify({ v: PREFERENCES_VERSION, sendBehavior: 'queue', theme: 'purple', extra: 'x', newSession: { team: 'cafe', mode: 42, model: ' ', thinkingByModel: { 'codex:a': 'high', 'codex:b': 7, '': 'low' } } });
  assert.deepEqual(parsePreferences(raw), { sendBehavior: 'queue', theme: 'system', ...DISPLAY, newSession: { team: 'cafe', thinkingByModel: { 'codex:a': 'high' } }, terminal: { fontSize: 13, fontFamily: 'mono', theme: 'dark' } });
  assert.deepEqual(parsePreferences(JSON.stringify({ v: 1, sendBehavior: 'interrupt', theme: 'light', newSession: 'cafe' })), { sendBehavior: 'steer', theme: 'light', ...DISPLAY, newSession: {}, terminal: { fontSize: 13, fontFamily: 'mono', theme: 'dark' } });
  // Over-long ids are not kept.
  assert.deepEqual(parsePreferences(JSON.stringify({ v: 1, newSession: { team: 'x'.repeat(201) } })).newSession, {});
});

test('serialize writes the version and known fields only: a token on the object never reaches storage', () => {
  const stored = serializePreferences({ sendBehavior: 'queue', theme: 'dark', newSession: { model: 'codex:gpt', thinkingByModel: { 'codex:gpt': 'high' } }, token: 'alpgw1.secret', gateway: 'https://h' });
  assert.deepEqual(JSON.parse(stored), { v: 1, sendBehavior: 'queue', theme: 'dark', ...DISPLAY, newSession: { model: 'codex:gpt', thinkingByModel: { 'codex:gpt': 'high' } }, terminal: { fontSize: 13, fontFamily: 'mono', theme: 'dark' } });
  assert.doesNotMatch(stored, /secret|gateway|https/);
  assert.deepEqual(parsePreferences(stored), { sendBehavior: 'queue', theme: 'dark', ...DISPLAY, newSession: { model: 'codex:gpt', thinkingByModel: { 'codex:gpt': 'high' } }, terminal: { fontSize: 13, fontFamily: 'mono', theme: 'dark' } });
});

test('load and save through a storage; one that throws gives the defaults and reports the failed save', () => {
  const storage = memory();
  assert.equal(savePreferences(storage, { sendBehavior: 'queue', theme: 'light', newSession: {}, terminal: { fontSize: 13, fontFamily: 'mono', theme: 'dark' } }), true);
  assert.equal(JSON.parse(storage.entries.get(PREFERENCES_KEY)).sendBehavior, 'queue');
  assert.deepEqual(loadPreferences(storage), { sendBehavior: 'queue', theme: 'light', ...DISPLAY, newSession: {}, terminal: { fontSize: 13, fontFamily: 'mono', theme: 'dark' } });
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
  assert.deepEqual(loadPreferences(broken), { sendBehavior: 'steer', theme: 'system', ...DISPLAY, newSession: {}, terminal: { fontSize: 13, fontFamily: 'mono', theme: 'dark' } });
  assert.equal(savePreferences(broken, { sendBehavior: 'queue', theme: 'light', newSession: {}, terminal: { fontSize: 13, fontFamily: 'mono', theme: 'dark' } }), false);
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


test('terminal preferences tolerate old/malformed values and persist only known settings', () => {
  const clean = value => parsePreferences(JSON.stringify({ v: 1, terminal: value })).terminal;
  assert.deepEqual(clean(undefined), { fontSize: 13, fontFamily: 'mono', theme: 'dark' });
  assert.deepEqual(clean({ fontSize: 999, fontFamily: 'url(evil)', theme: 'evil' }), clean(null));
  assert.deepEqual(clean({ fontSize: 16, fontFamily: 'consolas', theme: 'light' }), { fontSize: 16, fontFamily: 'consolas', theme: 'light' });
  const stored = serializePreferences({ ...DEFAULT_PREFERENCES, terminal: { fontSize: 15, fontFamily: 'menlo', theme: 'light', secret: 'no' } });
  assert.deepEqual(JSON.parse(stored).terminal, { fontSize: 15, fontFamily: 'menlo', theme: 'light' });
  assert.doesNotMatch(stored, /secret/);
});

test('content width and tool call display: known values kept, anything else the default, both stored', () => {
  const clean = value => parsePreferences(JSON.stringify({ v: 1, ...value }));
  assert.deepEqual(clean({ contentWidth: 'wide', toolCalls: 'expanded' }), { ...parsePreferences(null), contentWidth: 'wide', toolCalls: 'expanded' });
  assert.equal(clean({ contentWidth: 'full' }).contentWidth, 'full');
  for (const bad of ['huge', 42, null, '100%', 'calc(1px)']) {
    assert.equal(clean({ contentWidth: bad }).contentWidth, 'default', String(bad));
    assert.equal(clean({ toolCalls: bad }).toolCalls, 'collapsed', String(bad));
  }
  const stored = JSON.parse(serializePreferences({ ...DEFAULT_PREFERENCES, contentWidth: 'wide', toolCalls: 'expanded' }));
  assert.equal(stored.contentWidth, 'wide');
  assert.equal(stored.toolCalls, 'expanded');
});
