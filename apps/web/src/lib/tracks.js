// @ts-check

/**
 * ALP's Tasks pill above the composer, as paseo-web shows it (integrations/paseo/client/
 * task-pills.ts): the label counts the tasks this session worked on (done of them) or else the
 * project's open tasks; the menu lists the session's tasks first, then the other open ones,
 * what waits for the user first. Pure functions over the session's todo and task.list rows.
 */

/** @typedef {'approve' | 'review' | 'progress' | 'ready' | 'blocked' | 'closed'} TaskState */
/** @typedef {{ id: string, title: string, state: TaskState }} TrackLine */

/** @type {TaskState[]} */
const ORDER = ['approve', 'review', 'progress', 'ready', 'blocked'];

/** A task row's state as the ALP Tasks panel shows it. @param {any} task @returns {TaskState} */
export function stateOf(task) {
  if (task.status === 'closed') return 'closed';
  if (task.approvals?.length) return 'approve';
  if (task.status === 'review') return 'review';
  if (task.status === 'in_progress') return 'progress';
  // An epic waits on its own tasks, which is its work rather than a blocker.
  if (task.type === 'epic') return task.progress?.done ? 'progress' : 'ready';
  return task.ready ? 'ready' : 'blocked';
}

/**
 * @param {Array<{ id: string, text: string, status: string }>} worked the session's latest todo
 * @param {any[]} rows task.list rows
 */
export function tasksTrack(worked, rows) {
  const index = new Map(rows.map(row => [row.id, row]));
  /** @type {TrackLine[]} */
  const mine = worked.map(item => {
    const row = index.get(item.id);
    /** @type {TaskState} */
    const state = row ? stateOf(row) : item.status === 'completed' ? 'closed' : item.status === 'in_progress' ? 'progress' : 'ready';
    return { id: item.id, title: row?.title ?? item.text, state };
  });
  const ids = new Set(mine.map(line => line.id));
  /** @type {TrackLine[]} */
  const open = rows.filter(row => row.status !== 'closed' && row.type !== 'epic')
    .map(row => ({ id: String(row.id), title: String(row.title ?? row.id), state: stateOf(row), priority: typeof row.priority === 'number' ? row.priority : 9 }))
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.priority - b.priority || a.id.localeCompare(b.id))
    .map(({ id, title, state }) => ({ id, title, state }));
  const done = mine.filter(line => line.state === 'closed').length;
  const label = mine.length ? `Tasks · ${done}/${mine.length}` : open.length ? `Tasks · ${open.length}` : 'Tasks';
  const title = mine.length ? `ALP tasks: ${done} of ${mine.length} done in this session, ${open.length} open` : open.length ? `ALP tasks: ${open.length} open` : 'ALP tasks';
  return { label, title, mine: mine.length, lines: [...mine, ...open.filter(line => !ids.has(line.id))] };
}
