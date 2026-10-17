// The context meter's numbers (t-7679.12), as Paseo's composer shows them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contextOf, formatSessionCost, formatTokenCount, meterLabel, meterLevel, responseTokens, ringShare } from '../src/lib/usage.js';
import { emptyProjection, project } from '../src/lib/timeline.js';

const env = (cursor, event, sessionId = 'r') => ({ sessionId, epoch: 'e', seq: cursor, cursor, ts: '2026-10-17T00:00:00.000Z', event });

test('how full the window is needs both the context and the window', () => {
  assert.deepEqual(contextOf({ contextWindowUsedTokens: 54_000, contextWindowMaxTokens: 258_400 }), { percentage: 21, share: (54_000 / 258_400) * 100, usedTokens: 54_000, maxTokens: 258_400 });
  // The colour follows the exact share, as Paseo's: 90.4% is red though it shows 90%.
  const nearlyFull = contextOf({ contextWindowUsedTokens: 904, contextWindowMaxTokens: 1000 });
  assert.deepEqual([nearlyFull.percentage, meterLevel(nearlyFull.share)], [90, 'danger']);
  assert.equal(meterLevel(contextOf({ contextWindowUsedTokens: 696, contextWindowMaxTokens: 1000 }).share), 'normal');
  assert.equal(contextOf({ contextWindowUsedTokens: 54_000 }), null);
  assert.equal(contextOf({ contextWindowMaxTokens: 200_000 }), null);
  assert.equal(contextOf({ contextWindowUsedTokens: 1, contextWindowMaxTokens: 0 }), null);
  assert.equal(contextOf(undefined), null);
  assert.equal(contextOf({ contextWindowUsedTokens: 250_000, contextWindowMaxTokens: 200_000 }).percentage, 125);
  assert.equal(ringShare(125), 100);
  assert.equal(ringShare(-3), 0);
  assert.equal(meterLabel({ contextWindowUsedTokens: 54_000, contextWindowMaxTokens: 258_400 }), 'Context window 21% used');
  assert.equal(meterLabel(undefined), 'Context window: No context data');
});

test('Paseo\'s colours, token counts and session cost', () => {
  assert.deepEqual([69, 70, 90, 91].map(meterLevel), ['normal', 'warning', 'warning', 'danger']);
  assert.deepEqual([950, 54_321, 258_400, 1_000_000, 1_600_000].map(formatTokenCount), ['950', '54k', '258k', '1m', '2m']);
  assert.equal(formatSessionCost(0.0042), '$0.0042');
  assert.equal(formatSessionCost(1.234), '$1.23');
  assert.equal(formatSessionCost(0), null);
  assert.equal(formatSessionCost(undefined), null);
  assert.equal(responseTokens({ inputTokens: 25_000, cachedInputTokens: 20_000, outputTokens: 1000 }), '25k input (20k cached) · 1k output');
  assert.equal(responseTokens({ inputTokens: 900, cachedInputTokens: 0 }), '900 input');
  assert.equal(responseTokens({ contextWindowUsedTokens: 5 }), null);
});

test('a usage event becomes the session\'s usage in the projection, whole, and replays once', () => {
  let state = project(emptyProjection('r'), env(1, { type: 'session.opened', session: { id: 'r', agent: 'main', busy: false }, cwd: '/w', effective: { model: 'm', thinking: 'low' } }));
  state = project(state, env(2, { type: 'usage', usage: { contextWindowUsedTokens: 1000, contextWindowMaxTokens: 200_000, totalCostUsd: 0.5 } }));
  assert.deepEqual(state.sessions.r.usage, { contextWindowUsedTokens: 1000, contextWindowMaxTokens: 200_000, totalCostUsd: 0.5 });
  assert.equal(state.sessions.r.agent, 'main');
  state = project(state, env(3, { type: 'usage', usage: { contextWindowUsedTokens: 3000, contextWindowMaxTokens: 200_000, totalCostUsd: 0.6 } }));
  assert.equal(state.sessions.r.usage.contextWindowUsedTokens, 3000);
  assert.equal(project(state, env(2, { type: 'usage', usage: { contextWindowUsedTokens: 1 } })), state, 'a replayed usage changes nothing');
  // A child's usage is its own; a malformed one is ignored.
  state = project(state, env(4, { type: 'usage', usage: { contextWindowUsedTokens: 7 } }, 'c'));
  assert.equal(state.sessions.c.usage.contextWindowUsedTokens, 7);
  assert.equal(state.sessions.r.usage.contextWindowUsedTokens, 3000);
  assert.equal(project(state, env(5, { type: 'usage', usage: null })).sessions, state.sessions);
  // A session.updated snapshot carries the usage as of then.
  state = project(state, env(6, { type: 'session.updated', session: { id: 'r', agent: 'main', busy: true, usage: { contextWindowUsedTokens: 4000, contextWindowMaxTokens: 200_000 } } }));
  assert.equal(state.sessions.r.usage.contextWindowUsedTokens, 4000);
});
