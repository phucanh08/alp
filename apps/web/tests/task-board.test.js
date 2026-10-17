// t-7679.17: the task board's filters, search and List / Board / Epics grouping, as the
// alp-provider plugin's (integrations/paseo/client/tasks-panel.tsx, shared/tasks.ts).
import test from 'node:test';
import assert from 'node:assert/strict';
import { age, boardColumns, epicGroups, filterCounts, filterTasks, listSections, stateOf } from '../src/lib/task-board.js';

const at = '2026-10-01T00:00:00.000Z';
const task = (id, extra = {}) => ({ id, title: `Task ${id}`, type: 'task', priority: 2, status: 'open', ready: false, updatedAt: at, ...extra });

const rows = [
  task('t-1', { ready: true, priority: 3, labels: ['web'] }),
  task('t-2', { ready: true, priority: 1, assignee: 'peer' }),
  task('t-3', { blockedBy: ['t-1'] }),
  task('t-4', { status: 'in_progress', assignee: 'lead' }),
  task('t-5', { status: 'review' }),
  task('t-6', { approvals: [{ gate: 'g1', note: 'Legal' }], status: 'in_progress' }),
  task('t-7', { status: 'closed', closed: { at: '2026-10-02T00:00:00.000Z', reason: 'done' } }),
  task('t-8', { status: 'closed', closed: { at: '2026-10-03T00:00:00.000Z', reason: 'done' } }),
  task('t-9', { type: 'epic', title: 'Release', progress: { done: 1, total: 3 } }),
  task('t-9.1', { parent: 't-9', status: 'closed', closed: { at, reason: 'done' } }),
  task('t-9.2', { parent: 't-9', ready: true }),
  task('t-9.3', { parent: 't-9' }),
];

test('stateOf: what the user acts on first; an epic is never blocked by its own tasks', () => {
  assert.deepEqual(['t-1', 't-3', 't-4', 't-5', 't-6', 't-7', 't-9'].map(id => stateOf(rows.find(row => row.id === id))),
    ['ready', 'blocked', 'progress', 'review', 'approve', 'closed', 'progress']);
  assert.equal(stateOf(task('e', { type: 'epic', progress: { done: 0, total: 2 } })), 'ready');
});

test('filters and their counts: Open, Ready (open and ready), Closed, All', () => {
  assert.deepEqual(filterCounts(rows), { open: 9, ready: 3, closed: 3, all: 12 });
  assert.deepEqual(filterTasks(rows, 'ready').map(row => row.id), ['t-1', 't-2', 't-9.2']);
  assert.deepEqual(filterTasks(rows, 'closed').map(row => row.id), ['t-7', 't-8', 't-9.1']);
  assert.equal(filterTasks(rows, 'all').length, 12);
  // A closed task that still says ready is not in Ready.
  assert.deepEqual(filterTasks([task('x', { ready: true, status: 'closed' })], 'ready'), []);
});

test('search: every word, in id, title, type, assignee or labels, case aside', () => {
  assert.deepEqual(filterTasks(rows, 'all', 'WEB').map(row => row.id), ['t-1']);
  assert.deepEqual(filterTasks(rows, 'all', 'peer').map(row => row.id), ['t-2']);
  assert.deepEqual(filterTasks(rows, 'all', 'epic release').map(row => row.id), ['t-9']);
  assert.deepEqual(filterTasks(rows, 'all', 't-9.').map(row => row.id), ['t-9.1', 't-9.2', 't-9.3']);
  assert.deepEqual(filterTasks(rows, 'open', 'task t-7'), []);
  assert.equal(filterTasks(rows, 'all', '   ').length, 12);
});

test('List: the groups in order, each task once, by priority (closed: newest first)', () => {
  const sections = listSections(rows);
  assert.deepEqual(sections.map(section => [section.key, section.tasks.map(row => row.id)]), [
    ['approve', ['t-6']],
    ['review', ['t-5']],
    ['progress', ['t-4']],
    ['ready', ['t-2', 't-9.2', 't-1']],
    ['waiting', ['t-3', 't-9.3']],
    ['epics', ['t-9']],
    ['closed', ['t-8', 't-7', 't-9.1']],
  ]);
  const ids = sections.flatMap(section => section.tasks.map(row => row.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(listSections([]), []);
});

test('Board: a column per state without epics; Blocked, Ready and In progress always show', () => {
  const columns = boardColumns(rows);
  assert.deepEqual(columns.map(column => [column.key, column.tasks.map(row => row.id)]), [
    ['approve', ['t-6']],
    ['blocked', ['t-3', 't-9.3']],
    ['ready', ['t-2', 't-9.2', 't-1']],
    ['progress', ['t-4']],
    ['review', ['t-5']],
    ['closed', ['t-8', 't-7', 't-9.1']],
  ]);
  assert.deepEqual(boardColumns([task('only', { ready: true })]).map(column => column.key), ['blocked', 'ready', 'progress']);
});

test('Epics: shown epics with progress and every child, even ones the filter hides', () => {
  const groups = epicGroups(rows, filterTasks(rows, 'open'));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].epic.id, 't-9');
  assert.deepEqual(groups[0].children.map(row => row.id), ['t-9.1', 't-9.2', 't-9.3']);
  assert.deepEqual([groups[0].done, groups[0].total, groups[0].percent], [1, 3, 33]);
  // Without progress from the host, the children count.
  const bare = [task('e', { type: 'epic' }), task('c1', { parent: 'e', status: 'closed' }), task('c2', { parent: 'e' })];
  assert.deepEqual(epicGroups(bare, bare).map(group => [group.done, group.total, group.percent]), [[1, 2, 50]]);
  assert.deepEqual(epicGroups(rows, filterTasks(rows, 'all', 'nothing')), []);
});

test('age: the largest unit', () => {
  const now = Date.parse(at);
  assert.equal(age(at, now + 5 * 60_000), '5m');
  assert.equal(age(at, now + 3 * 3_600_000), '3h');
  assert.equal(age(at, now + 2 * 86_400_000), '2d');
  assert.equal(age(at, now + 42 * 86_400_000), '6w');
  assert.equal(age(undefined, now), '');
  assert.equal(age('nope', now), '');
});
