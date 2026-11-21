// The sidebar's workspace facts and usage line (lib/sidebar-facts.js, t-ff83): batches of at most
// 50 ids, well-formed fields only (an icon only as a data:image URL), Paseo's diff counts and PR
// labels, the one row that carries the facts, the 5h/wk usage parts, and the schedules order.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FACTS_BATCH, batches, cleanFacts, excerpt, formatDiffCount, mostRecentSession, prLabel, readFacts, scheduleRows, usageLine } from '../src/lib/sidebar-facts.js';

test('facts are read 50 workspace ids per call, duplicates once, a failed batch left out', async () => {
  const ids = Array.from({ length: 120 }, (_, index) => `ws_${index}`);
  assert.deepEqual(batches(ids).map(batch => batch.length), [50, 50, 20]);
  assert.equal(FACTS_BATCH, 50);
  const calls = [];
  const controller = {
    async ownerRequest(method, params) {
      calls.push({ method, params });
      if (params.workspaceIds.includes('ws_60')) throw new Error('boom');
      return { workspaces: Object.fromEntries(params.workspaceIds.map(id => [id, { additions: 1 }])).valueOf() };
    },
  };
  const facts = await readFacts(controller, [...ids, 'ws_0', ''], { refresh: true });
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.method === 'host.workspace.facts' && call.params.workspaceIds.length <= 50 && call.params.refresh === true));
  assert.equal(Object.keys(facts).length, 70);
  assert.equal(facts.ws_60, undefined);
  assert.deepEqual(facts.ws_0, { additions: 1 });
});

test('only well-formed facts survive; an icon must be a base64 data:image URL', () => {
  assert.deepEqual(cleanFacts({ branch: 'main', additions: 2600, deletions: -1, pr: { number: 2, state: 'open' }, ci: 'failed', icon: 'data:image/png;base64,iVBORw0KGgo=', fetchedAt: 't' }),
    { branch: 'main', additions: 2600, pr: { number: 2, state: 'open' }, ci: 'failed', icon: 'data:image/png;base64,iVBORw0KGgo=', fetchedAt: 't' });
  for (const icon of ['javascript:alert(1)', 'https://example.test/x.png', 'data:text/html;base64,PHNjcmlwdD4=', 'data:image/png;base64,<svg>']) assert.equal(cleanFacts({ icon }).icon, undefined, icon);
  assert.deepEqual(cleanFacts({ pr: { number: 0, state: 'open' }, ci: 'weird' }), {});
  assert.deepEqual(cleanFacts(null), {});
});

test('diff counts and pull request labels read as Paseo\'s', () => {
  assert.deepEqual([0, 672, 999, 1000, 2600, 36_500, 125_400, 1_200_000].map(formatDiffCount), ['0', '672', '999', '1k', '2.6k', '36.5k', '125k', '1.2m']);
  assert.equal(prLabel({ number: 2, state: 'open' }), '2');
  assert.equal(prLabel({ number: 344, state: 'merged' }), '344 Merged');
  assert.equal(prLabel({ number: 7, state: 'draft' }), '7 Draft');
  assert.equal(prLabel({ number: 9, state: 'closed' }), '9 Closed');
});

test('the most recent session carries the facts: last update, else creation; ties by id', () => {
  const rows = [
    { id: 'b', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z' },
    { id: 'a', createdAt: '2026-11-02T00:00:00Z' },
    { id: 'c', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z' },
  ];
  assert.equal(mostRecentSession(rows)?.id, 'b');
  assert.equal(mostRecentSession([])?.id, undefined);
});

test('the usage line shows each provider\'s 5h and weekly windows, leaving out what is missing', () => {
  const providers = [
    { runtime: 'claude', windows: [{ name: 'five_hour', usedPercent: 97.6 }, { name: 'seven_day', usedPercent: 61 }, { name: 'seven_day_opus', usedPercent: 5 }] },
    { runtime: 'codex', windows: [{ name: 'Codex · 5 hour window', usedPercent: 82 }, { name: 'Codex · 7 day window', usedPercent: null }] },
    { runtime: 'other', windows: [] },
    { runtime: 'down', available: false, windows: [{ name: 'five_hour', usedPercent: NaN }] },
  ];
  assert.deepEqual(usageLine(providers), [
    { runtime: 'claude', parts: [{ key: '5h', used: 98 }, { key: 'wk', used: 61 }] },
    { runtime: 'codex', parts: [{ key: '5h', used: 82 }] },
  ]);
  assert.deepEqual(usageLine([]), []);
});

test('schedules: pending first by due time, then the rest newest first; prompts cut to one line', () => {
  const rows = scheduleRows({
    '/a': [{ id: 's1', status: 'delivered', dueAt: '2026-11-01T00:00:00Z' }, { id: 's2', status: 'pending', dueAt: '2026-11-30T00:00:00Z' }],
    '/b': [{ id: 's3', status: 'pending', dueAt: '2026-11-22T00:00:00Z' }, { id: 's4', status: 'failed', dueAt: '2026-11-10T00:00:00Z' }, null],
  });
  assert.deepEqual(rows.map(row => row.id), ['s3', 's2', 's4', 's1']);
  assert.equal(excerpt('  check\n the   build  '), 'check the build');
  assert.equal(excerpt('x'.repeat(200), 10), `${'x'.repeat(9)}…`);
});
