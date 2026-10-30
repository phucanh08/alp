// The Workspaces section as Paseo 0.14 arranges it (lib/sidebar-model.js): sort newest first,
// status sections in Paseo's order, seven rows plus the unfinished ones, and the project filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { GROUP_LIMIT, STATUS_GROUPS, filterProjects, groupByStatus, limitRows, resolveProjectFilters, sortSessions } from '../src/lib/sidebar-model.js';

const session = (id, createdAt, updatedAt, status = 'idle') => ({ id, createdAt, updatedAt, status });

test('Created and Last prompt sort newest first; ties by id', () => {
  const list = [session('a', '2026-10-01T00:00:00Z', '2026-10-05T00:00:00Z'), session('b', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z'), session('c', '2026-10-02T00:00:00Z', undefined)];
  assert.deepEqual(sortSessions(list, 'created').map(row => row.id), ['b', 'c', 'a']);
  assert.deepEqual(sortSessions(list, 'lastPrompt').map(row => row.id), ['a', 'b', 'c']);
  assert.deepEqual(sortSessions([session('y', 'x'), session('x', 'x')], 'created').map(row => row.id), ['x', 'y']);
});

test('a group shows seven rows and every unfinished one past them; Show more shows all', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({ id: index, bucket: index === 9 ? 'running' : 'done' }));
  const limited = limitRows(rows, false, row => row.bucket);
  assert.equal(GROUP_LIMIT, 7);
  assert.deepEqual(limited.visible.map(row => row.id), [0, 1, 2, 3, 4, 5, 6, 9]);
  assert.equal(limited.canToggle, true);
  assert.equal(limitRows(rows, true, row => row.bucket).visible.length, 10);
  assert.equal(limitRows(rows.slice(0, 5), false, row => row.bucket).canToggle, false);
});

test('status sections in Paseo\'s order, empty ones left out', () => {
  assert.deepEqual(STATUS_GROUPS.map(([, label]) => label), ['Needs input', 'Failed', 'Ready to review', 'Working', 'Done']);
  const buckets = { a: 'done', b: 'running', c: 'needs_input', d: 'running' };
  const groups = groupByStatus(['a', 'b', 'c', 'd'].map(id => ({ id })), row => buckets[row.id]);
  assert.deepEqual(groups.map(group => [group.label, group.sessions.map(row => row.id)]), [['Needs input', ['c']], ['Working', ['b', 'd']], ['Done', ['a']]]);
});

test('the project filter keeps what it names; a filter naming no project left shows them all', () => {
  const projects = ['/a', '/b', '/c'];
  assert.deepEqual(filterProjects(projects, ['/b']), ['/b']);
  assert.deepEqual(filterProjects(projects, ['/gone']), projects);
  assert.deepEqual(resolveProjectFilters(['/gone', '/c'], projects), ['/c']);
  assert.deepEqual(filterProjects(projects, []), projects);
});
