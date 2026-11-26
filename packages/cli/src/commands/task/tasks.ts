import path from 'node:path';
import { parseArgs } from 'node:util';
import { listTasks, loadTasks, readyTasks, TASKS_DIR } from '@anhlp/alp-core/tasks';
import type { TaskStatus } from '@anhlp/alp-core/tasks';
import { taskProject } from '../_shared/project.js';
import { UsageError } from '../_shared/usage.js';
import { beads } from './beads.js';
import { taskRow, warnUnreadable } from './format.js';
import { taskMaintenance } from './maintenance.js';

/** The project's tasks: open, in progress and in review by default; ready lists what nothing blocks. */

export async function tasksCommand(args: string[]) {
  if (args[0] === 'gates' || args[0] === 'compact') return taskMaintenance([args[0]], args.slice(1));
  if (args[0] === 'export' || args[0] === 'import') return beads(args[0], args.slice(1));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    all: { type: 'boolean' }, status: { type: 'string' }, label: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' },
  } });
  if (positionals.length > 1 || (positionals.length && positionals[0] !== 'ready')) throw new UsageError();
  const root = await taskProject(values.project);
  const { tasks, errors } = await loadTasks(root);
  warnUnreadable(errors);
  const rows = positionals[0] === 'ready' ? readyTasks(tasks) : listTasks(tasks, { status: values.status as TaskStatus | undefined, label: values.label, all: values.all });
  if (values.json) { console.log(JSON.stringify(rows)); return; }
  if (!rows.length) { console.log(positionals[0] === 'ready' ? 'No task is ready' : `No tasks in ${path.join(root, TASKS_DIR)}`); return; }
  for (const task of rows) console.log(taskRow(task, tasks));
}
