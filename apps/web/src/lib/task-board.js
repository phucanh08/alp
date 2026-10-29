// ALP's task board as the alp-provider plugin shows it in Paseo's app (integrations/paseo,
// client/tasks-panel.tsx and shared/tasks.ts): the filters Open/Ready/Closed/All, a search on id,
// title, type, assignee and labels, and the List (grouped by what the user acts on), Board (a
// column per state) and Epics (with their progress and their tasks) views. Pure, so the views
// render from task.list's rows alone.

/** @typedef {'list' | 'board' | 'epics'} TaskView */
/** @typedef {'open' | 'ready' | 'closed' | 'all'} TaskFilter */
/** @typedef {'approve' | 'review' | 'progress' | 'ready' | 'blocked' | 'closed'} TaskState */
/**
 * @typedef {{ id: string, title: string, type?: string, priority: number, status: string, ready?: boolean, parent?: string,
 *   assignee?: string, labels?: string[], blockedBy?: string[], waits?: string[], approvals?: Array<{ gate: string, note: string, options?: string[], rejected?: { at: string, reason?: string } }>,
 *   progress?: { done: number, total: number }, closed?: { at: string, reason?: string }, updatedAt?: string }} TaskRow
 */

/** @type {Array<{ key: TaskView, label: string }>} */
export const TASK_VIEWS = [{ key: 'list', label: 'List' }, { key: 'board', label: 'Board' }, { key: 'epics', label: 'Epics' }];
/** @type {TaskFilter[]} */
export const TASK_FILTERS = ['open', 'ready', 'closed', 'all'];

/** @param {TaskRow} a @param {TaskRow} b */
const rank = (a, b) => a.priority - b.priority || a.id.localeCompare(b.id);
/** The newest close first. @param {TaskRow} a @param {TaskRow} b */
const recent = (a, b) => (b.closed?.at ?? b.updatedAt ?? '').localeCompare(a.closed?.at ?? a.updatedAt ?? '') || a.id.localeCompare(b.id);

/** A task's state for its dot and board column: what the user acts on first. @param {TaskRow} task @returns {TaskState} */
export function stateOf(task) {
  if (task.status === 'closed') return 'closed';
  if (task.approvals?.length) return 'approve';
  if (task.status === 'review') return 'review';
  if (task.status === 'in_progress') return 'progress';
  // An epic waits on its own tasks, which is its work rather than a blocker.
  if (task.type === 'epic') return task.progress?.done ? 'progress' : 'ready';
  return task.ready ? 'ready' : 'blocked';
}

/** @type {Record<TaskState, string>} */
export const STATE_LABELS = { approve: 'Needs approval', review: 'In review', progress: 'In progress', ready: 'Ready', blocked: 'Blocked', closed: 'Closed' };

/** Whether the Ready filter keeps a task: task.list's ready, open. @param {TaskRow} task */
const isReady = task => !!task.ready && task.status !== 'closed';

/** How many tasks each filter keeps, before the search. @param {TaskRow[]} tasks @returns {Record<TaskFilter, number>} */
export function filterCounts(tasks) {
  const closed = tasks.filter(task => task.status === 'closed').length;
  return { open: tasks.length - closed, ready: tasks.filter(isReady).length, closed, all: tasks.length };
}

/**
 * The tasks a filter and a search keep: by state, then every word of the query in the id, title,
 * type, assignee or labels (case aside).
 * @param {TaskRow[]} tasks @param {TaskFilter} filter @param {string} [query]
 */
export function filterTasks(tasks, filter, query = '') {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return tasks.filter(task => {
    if (filter === 'open' && task.status === 'closed') return false;
    if (filter === 'ready' && !isReady(task)) return false;
    if (filter === 'closed' && task.status !== 'closed') return false;
    if (!words.length) return true;
    const text = [task.id, task.title, task.type ?? '', task.assignee ?? '', ...(task.labels ?? [])].join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  });
}

/** @type {Array<{ key: string, title: string }>} */
const SECTIONS = [
  { key: 'approve', title: 'Waiting for your approval' }, { key: 'review', title: 'In review' }, { key: 'progress', title: 'In progress' },
  { key: 'ready', title: 'Ready' }, { key: 'waiting', title: 'Blocked or waiting' }, { key: 'epics', title: 'Epics' }, { key: 'closed', title: 'Closed' },
];

/** The List view's group of a task. Each task is in one group: the first that applies. @param {TaskRow} task */
function sectionOf(task) {
  if (task.status === 'closed') return 'closed';
  if (task.approvals?.length) return 'approve';
  if (task.status === 'review') return 'review';
  if (task.status === 'in_progress') return 'progress';
  if (task.type === 'epic') return 'epics';
  return task.ready ? 'ready' : 'waiting';
}

/**
 * The List view: the plugin's groups (what waits for the user first, then what waits for main,
 * what runs, what is ready, what waits, the epics, what closed), empty groups left out. Unlike
 * the plugin's boardSections a task shows once, in the first group that applies.
 * @param {TaskRow[]} tasks @returns {Array<{ key: string, title: string, tasks: TaskRow[] }>}
 */
export function listSections(tasks) {
  return SECTIONS.map(section => {
    const members = tasks.filter(task => sectionOf(task) === section.key);
    return { ...section, tasks: members.sort(section.key === 'closed' ? recent : rank) };
  }).filter(section => section.tasks.length);
}

/** @type {Array<{ key: TaskState, title: string }>} */
const COLUMNS = [
  { key: 'approve', title: 'Needs approval' }, { key: 'blocked', title: 'Blocked' }, { key: 'ready', title: 'Ready' },
  { key: 'progress', title: 'In progress' }, { key: 'review', title: 'In review' }, { key: 'closed', title: 'Closed' },
];

/**
 * The Board view: a column per state, as the plugin's (beads-ui's); epics stay in the Epics view.
 * Blocked, Ready and In progress always show; the others when they hold a task.
 * @param {TaskRow[]} tasks @returns {Array<{ key: TaskState, title: string, tasks: TaskRow[] }>}
 */
export function boardColumns(tasks) {
  return COLUMNS.map(column => ({ ...column, tasks: tasks.filter(task => task.type !== 'epic' && stateOf(task) === column.key).sort(column.key === 'closed' ? recent : rank) }))
    .filter(column => column.tasks.length || column.key === 'blocked' || column.key === 'ready' || column.key === 'progress');
}

/**
 * The Epics view: the shown epics (and parents with progress), each with its progress and its
 * tasks from the whole list, so a filter on the epics does not hide their children.
 * @param {TaskRow[]} all @param {TaskRow[]} shown
 */
export function epicGroups(all, shown) {
  return shown.filter(task => task.type === 'epic' || task.progress).sort(rank).map(epic => {
    const children = all.filter(task => task.parent === epic.id).sort(rank);
    const done = epic.progress?.done ?? children.filter(task => task.status === 'closed').length;
    const total = epic.progress?.total ?? children.length;
    return { epic, children, done, total, percent: total ? Math.round((done / total) * 100) : 0 };
  });
}

/** How long ago, in the largest unit: 5m, 3h, 2d, 6w (the plugin's age). @param {string | undefined} iso @param {number} [now] */
export function age(iso, now = Date.now()) {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) return '';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.floor(minutes / 60)}h`;
  if (minutes < 60 * 24 * 14) return `${Math.floor(minutes / 1440)}d`;
  return `${Math.floor(minutes / 10080)}w`;
}
