// Settings › Usage's preferences and model (t-9116), as Paseo's usage/preferences.ts, pinned.ts,
// tone.ts and format.ts: stored tolerantly, default pins, the first pin edit, cards off, the
// sidebar summary, and the reset datapoints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_USAGE_PREFS, USAGE_PREFS_KEY, balanceText, displayPercent, effectivePins, formatDisplayPct, formatResetLabel, formatResetTime, isCardOn,
  loadUsagePrefs, parseUsagePrefs, pinnedSummary, resolveWindow, serializeUsagePrefs, setCardOn, togglePin, updateUsagePrefs, windowTone,
} from '../dist-lib/usage-prefs.js';

const CLAUDE = {
  runtime: 'claude', available: true, checkedAt: '2026-11-22T00:00:00Z', plan: 'max', planLabel: 'Max 5x', limited: false, pause: null, parked: 0,
  windows: [
    { name: 'five_hour', id: 'five_hour', label: 'Session', usedPercent: 4, resetsAt: null },
    { name: 'seven_day', id: 'weekly', label: 'Weekly', usedPercent: 20, resetsAt: null },
    { name: 'seven_day_fable', id: 'weekly:fable', label: 'Weekly · Fable', usedPercent: 2, resetsAt: null },
  ],
};
const CODEX = {
  runtime: 'codex', available: true, checkedAt: '2026-11-22T00:00:00Z', plan: 'plus', limited: false, pause: null, parked: 0,
  windows: [{ name: 'five_hour', id: 'five_hour', label: '5-hour', usedPercent: 4, resetsAt: null }, { name: 'weekly', id: 'weekly', label: 'Weekly', usedPercent: 66, resetsAt: null }],
};

function memory() {
  const map = new Map();
  return { getItem: key => map.get(key) ?? null, setItem: (key, value) => map.set(key, value), map };
}

test('defaults: used, source pins, every card on, the summary shown; garbage and other versions give them', () => {
  for (const raw of [null, '', '{', '[]', JSON.stringify({ v: 2, displayAs: 'remaining' })]) assert.deepEqual(parseUsagePrefs(raw), { ...DEFAULT_USAGE_PREFS });
  const parsed = parseUsagePrefs(JSON.stringify({ v: 1, displayAs: 'nope', pins: [{ runtime: 'claude', windowId: 'weekly' }, { runtime: 1 }, { runtime: 'claude', windowId: 'weekly' }], cardsOff: ['codex', 3, 'codex'], inSidebar: 'yes', token: 'secret' }));
  assert.deepEqual(parsed, { displayAs: 'used', pins: [{ runtime: 'claude', windowId: 'weekly' }], cardsOff: ['codex'], inSidebar: true });
  assert.ok(!serializeUsagePrefs({ ...parsed, token: 'secret' }).includes('secret'));
});

test('stored per browser under one key, read back as written', () => {
  const storage = memory();
  const next = updateUsagePrefs(storage, prefs => ({ ...prefs, displayAs: 'remaining', inSidebar: false }));
  assert.equal(next?.displayAs, 'remaining');
  assert.deepEqual(JSON.parse(storage.map.get(USAGE_PREFS_KEY)), { v: 1, displayAs: 'remaining', pins: null, cardsOff: [], inSidebar: false });
  assert.deepEqual(loadUsagePrefs(storage), next);
  assert.equal(updateUsagePrefs({ getItem: () => null, setItem: () => { throw new Error('quota'); } }, prefs => prefs), null);
});

test('windows: the host\'s id and label, else read from an older host\'s name; short labels for the sidebar', () => {
  assert.deepEqual(CLAUDE.windows.map(resolveWindow).map(window => [window.id, window.label, window.shortLabel]), [
    ['five_hour', 'Session', '5h'], ['weekly', 'Weekly', 'wk'], ['weekly:fable', 'Weekly · Fable', 'Fable wk'],
  ]);
  assert.deepEqual([{ name: 'five_hour' }, { name: 'seven_day' }, { name: 'Codex · 5 hour window' }, { name: 'monthly_credits' }].map(resolveWindow).map(window => [window.id, window.label, window.shortLabel]), [
    ['five_hour', '5-hour', '5h'], ['seven_day', 'Weekly', 'wk'], ['Codex · 5 hour window', 'Codex · 5 hour window', '5h'], ['monthly_credits', 'Monthly credits', 'Monthly credits'],
  ]);
});

test('percentages read as used or left; tone from the share used (Paseo: >90 danger, >=70 warning)', () => {
  assert.equal(displayPercent({ usedPercent: 34 }, 'used'), 34);
  assert.equal(displayPercent({ usedPercent: 34 }, 'remaining'), 66);
  assert.equal(displayPercent({ usedPercent: null }, 'remaining'), null);
  assert.equal(formatDisplayPct(96, 'remaining'), '96% left');
  assert.equal(formatDisplayPct(4.4, 'used'), '4% used');
  assert.deepEqual([null, 10, 69.9, 70, 90, 90.1].map(windowTone), ['default', 'default', 'default', 'warning', 'warning', 'danger']);
});

test('default pins: windows marked summary, else the 5-hour and weekly ones, else the first with a percent', () => {
  const prefs = parseUsagePrefs(null);
  assert.deepEqual(effectivePins(prefs, [CLAUDE, CODEX]), [
    { runtime: 'claude', windowId: 'five_hour' }, { runtime: 'claude', windowId: 'weekly' }, { runtime: 'codex', windowId: 'five_hour' }, { runtime: 'codex', windowId: 'weekly' },
  ]);
  const marked = { ...CLAUDE, windows: CLAUDE.windows.map(window => ({ ...window, summary: window.id === 'weekly:fable' })) };
  assert.deepEqual(effectivePins(prefs, [marked]), [{ runtime: 'claude', windowId: 'weekly:fable' }]);
  const other = { runtime: 'x', windows: [{ name: 'a', usedPercent: null }, { name: 'monthly', usedPercent: 3 }, { name: 'daily', usedPercent: 1 }] };
  assert.deepEqual(effectivePins(prefs, [other]), [{ runtime: 'x', windowId: 'monthly' }]);
});

test('the first pin edit keeps the defaults shown and toggles one; an empty selection stays empty', () => {
  let prefs = togglePin(parseUsagePrefs(null), { runtime: 'claude', windowId: 'weekly:fable' }, [CLAUDE]);
  assert.deepEqual(prefs.pins, [{ runtime: 'claude', windowId: 'five_hour' }, { runtime: 'claude', windowId: 'weekly' }, { runtime: 'claude', windowId: 'weekly:fable' }]);
  prefs = togglePin(prefs, { runtime: 'claude', windowId: 'five_hour' }, [CLAUDE]);
  prefs = togglePin(prefs, { runtime: 'claude', windowId: 'weekly' }, [CLAUDE]);
  prefs = togglePin(prefs, { runtime: 'claude', windowId: 'weekly:fable' }, [CLAUDE]);
  assert.deepEqual(prefs.pins, []);
  assert.deepEqual(pinnedSummary([CLAUDE], prefs), []);
});

test('sidebar summary: pinned windows of cards that are on, in Percentages, nothing while Summary in sidebar is off', () => {
  const prefs = parseUsagePrefs(null);
  const text = summary => summary.map(entry => [entry.runtime, entry.windows.map(window => `${window.text} ${window.shortLabel}`)]);
  assert.deepEqual(text(pinnedSummary([CLAUDE, CODEX], prefs)), [['claude', ['4% 5h', '20% wk']], ['codex', ['4% 5h', '66% wk']]]);
  assert.deepEqual(text(pinnedSummary([CLAUDE, CODEX], { ...prefs, displayAs: 'remaining' })), [['claude', ['96% 5h', '80% wk']], ['codex', ['96% 5h', '34% wk']]]);
  const off = setCardOn(prefs, 'claude', false);
  assert.equal(isCardOn(off, 'claude'), false);
  assert.deepEqual(text(pinnedSummary([CLAUDE, CODEX], off)), [['codex', ['4% 5h', '66% wk']]]);
  assert.equal(isCardOn(setCardOn(off, 'claude', true), 'claude'), true);
  assert.deepEqual(pinnedSummary([CLAUDE, CODEX], { ...prefs, inSidebar: false }), []);
});

test('reset datapoints: Paseo\'s two-unit countdown and the exact time (today, weekday, date)', () => {
  const now = new Date(2026, 10, 22, 8, 23).getTime();
  const at = (minutes) => new Date(now + minutes * 60_000).toISOString();
  assert.equal(formatResetLabel(at(226), now), 'resets in 3h 46m');
  assert.equal(formatResetLabel(at(37), now), 'resets in 37m');
  assert.equal(formatResetLabel(at(120), now), 'resets in 2h');
  assert.equal(formatResetLabel(at(24 * 60), now), 'resets in 24h');
  assert.equal(formatResetLabel(at(4 * 1440 + 6 * 60 + 5), now), 'resets in 4d 6h');
  assert.equal(formatResetLabel(at(-1), now), 'resetting now');
  assert.equal(formatResetLabel(null, now), null);
  assert.equal(formatResetTime(at(226), now, 'en-US'), '12:09 PM');
  assert.equal(formatResetTime(at(4 * 1440 + 6 * 60 + 36), now, 'en-US'), 'Thu 2:59 PM');
  assert.match(formatResetTime(at(9 * 1440), now, 'en-US') ?? '', /^Tue, Dec 1, 8:23 AM$/);
  assert.equal(formatResetTime(at(-5), now, 'en-US'), null);
});

test('balances: "0 left", unlimited, unknown', () => {
  assert.equal(balanceText({ remaining: 0, unlimited: false }), '0 left');
  assert.equal(balanceText({ remaining: null, unlimited: true }), 'Unlimited');
  assert.equal(balanceText({ remaining: null, unlimited: false }), '—');
});
