import test from 'node:test';
import assert from 'node:assert/strict';
import { renderLog } from '@anhlp/alp-client/render';
import { latestStrategies, renderStatus } from '../src/sessions.js';

// alp top and alp log show the strategy main and lead chose with alp_strategy (t-003a).

const session = (id, agent, parentId) => ({ id, agent, ...(parentId ? { parentId } : {}), state: 'running', idleMs: 0, runtime: 'claude', model: 'opus', mode: 'full-access', unreadMail: 0 });
const status = sessions => ({ rootId: 'root', sessions, assignments: [], questions: [], worktrees: [], leases: [], claims: [] });

test('latestStrategies keeps the last strategy entry of each session and ignores other events', () => {
  const latest = latestStrategies([
    { event: 'strategy', sessionId: 'root', agent: 'main', strategy: 'deep', reason: 'Race' },
    { event: 'mail', sessionId: 'root' },
    { event: 'strategy', sessionId: 'child', agent: 'lead', strategy: 'rush', reason: 'Small' },
    { event: 'strategy', sessionId: 'root', agent: 'main', strategy: 'large', reason: 'Many modules' },
    { event: 'strategy' },
    null,
  ]);
  assert.deepEqual([...latest.keys()], ['root', 'child']);
  assert.equal(latest.get('root').strategy, 'large');
  assert.equal(latest.get('child').strategy, 'rush');
});

test('alp top shows each strategy with its reason, smart for main and lead without one, nothing for a peer', () => {
  const sessions = [session('root', 'main'), session('child', 'lead', 'root'), session('peer-1', 'peer', 'child')];
  const none = renderStatus(status(sessions), { title: 'T' }).split('\n');
  assert.match(none[1], /main .*strategy smart$/);
  assert.match(none[2], /lead .*strategy smart$/);
  assert.doesNotMatch(none[3], /strategy/);
  const chosen = renderStatus(status(sessions), { title: 'T' }, latestStrategies([
    { event: 'strategy', sessionId: 'root', agent: 'main', strategy: 'deep', reason: 'Race in the scheduler\nsecond line' },
    { event: 'strategy', sessionId: 'child', agent: 'lead', strategy: 'rush', reason: 'One small fix' },
  ])).split('\n');
  assert.match(chosen[1], /main .*strategy deep: Race in the scheduler$/);
  assert.match(chosen[2], /lead .*strategy rush: One small fix$/);
  assert.doesNotMatch(chosen[3], /strategy/);
});

test('alp log renders a strategy line with the change and its reason', () => {
  const lines = renderLog('root', [{ ts: '2026-11-23T12:00:00.000Z', event: 'strategy', agent: 'main', sessionId: 'root', strategy: 'deep', previous: 'smart', reason: 'Race in the scheduler' }]);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /main strategy smart → deep: Race in the scheduler/);
});
