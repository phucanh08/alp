
/**
 * ALP's Tasks pill above the composer, as ALP's Paseo plugin shows it (integrations/paseo/client/
 * task-pills.ts): the label counts the tasks this session worked on (done of them) or else the
 * project's open tasks; the menu lists the session's tasks first, then the other open ones,
 * what waits for the user first. Pure functions over the session's todo and task.list rows.
 */

export type TaskState = 'approve' | 'review' | 'progress' | 'ready' | 'blocked' | 'closed';
export type TrackLine = { id: string; title: string; state: TaskState; };

const ORDER: TaskState[] = ['approve', 'review', 'progress', 'ready', 'blocked'];

/** A task row's state as the ALP Tasks panel shows it. */
// any: alpd's or the gateway's answer (untrusted JSON); each field is checked where it is read.
export function stateOf(task: any): TaskState {
  if (task.status === 'closed') return 'closed';
  if (task.approvals?.length) return 'approve';
  if (task.status === 'review') return 'review';
  if (task.status === 'in_progress') return 'progress';
  // An epic waits on its own tasks, which is its work rather than a blocker.
  if (task.type === 'epic') return task.progress?.done ? 'progress' : 'ready';
  return task.ready ? 'ready' : 'blocked';
}

/**
 * @param worked the session's latest todo
 * @param rows task.list rows
 */
// any: host rows (untrusted JSON); each field is checked where it is read.
export function tasksTrack(worked: Array<{ id: string; text: string; status: string; }>, rows: any[]) {
  const index = new Map(rows.map(row => [row.id, row]));
  const mine: TrackLine[] = worked.map(item => {
    const row = index.get(item.id);
    const state: TaskState = row ? stateOf(row) : item.status === 'completed' ? 'closed' : item.status === 'in_progress' ? 'progress' : 'ready';
    return { id: item.id, title: row?.title ?? item.text, state };
  });
  const ids = new Set(mine.map(line => line.id));
  const open: TrackLine[] = rows.filter(row => row.status !== 'closed' && row.type !== 'epic')
    .map(row => ({ id: String(row.id), title: String(row.title ?? row.id), state: stateOf(row), priority: typeof row.priority === 'number' ? row.priority : 9 }))
    .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.priority - b.priority || a.id.localeCompare(b.id))
    .map(({ id, title, state }) => ({ id, title, state }));
  const done = mine.filter(line => line.state === 'closed').length;
  const label = mine.length ? `Tasks · ${done}/${mine.length}` : open.length ? `Tasks · ${open.length}` : 'Tasks';
  const title = mine.length ? `ALP tasks: ${done} of ${mine.length} done in this session, ${open.length} open` : open.length ? `ALP tasks: ${open.length} open` : 'ALP tasks';
  return { label, title, mine: mine.length, lines: [...mine, ...open.filter(line => !ids.has(line.id))] };
}
