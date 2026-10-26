// The Tasks pill above the composer (lib/tracks.js), as ALP's Paseo plugin shows it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { stateOf, tasksTrack } from '../src/lib/tracks.js';

const rows = [
  { id: 't-1', title: 'Ship', status: 'open', ready: true, priority: 2 },
  { id: 't-2', title: 'Gate', status: 'open', approvals: [{ gate: 'g' }], priority: 3 },
  { id: 't-3', title: 'Done', status: 'closed' },
  { id: 't-4', title: 'Blocked', status: 'open', ready: false, priority: 1 },
  { id: 't-5', title: 'Epic', type: 'epic', status: 'open' },
];

test('stateOf follows the Tasks panel', () => {
  assert.deepEqual(rows.map(stateOf), ['ready', 'approve', 'closed', 'blocked', 'ready']);
  assert.equal(stateOf({ status: 'in_progress' }), 'progress');
  assert.equal(stateOf({ status: 'review' }), 'review');
});

test('without session work the pill counts open tasks, what waits for the user first, no epics', () => {
  const track = tasksTrack([], rows);
  assert.equal(track.label, 'Tasks · 3');
  assert.deepEqual(track.lines.map(line => line.id), ['t-2', 't-1', 't-4']);
  assert.equal(tasksTrack([], []).label, 'Tasks');
});

test('session work comes first and counts done of worked', () => {
  const track = tasksTrack([{ id: 't-3', text: 'Done', status: 'completed' }, { id: 't-9', text: 'Not listed', status: 'in_progress' }, { id: 't-1', text: 'Ship', status: 'pending' }], rows);
  assert.equal(track.label, 'Tasks · 1/3');
  assert.equal(track.mine, 3);
  assert.deepEqual(track.lines.map(line => `${line.id}:${line.state}`), ['t-3:closed', 't-9:progress', 't-1:ready', 't-2:approve', 't-4:blocked']);
  assert.match(track.title, /1 of 3 done in this session, 3 open/);
});
