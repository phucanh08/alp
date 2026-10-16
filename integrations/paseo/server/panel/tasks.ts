import { access } from 'node:fs/promises';
import path from 'node:path';
import { closeTask, createTask, epicReport, loadTasks, reopenTask, resolveGate } from '@anhlp/alp-core/tasks';
import { taskRows } from '@anhlp/alp-core/task-rows';
import { alpHome } from '@anhlp/alp-client/index';
import type { PluginServerContext } from './compat.js';
import { tasksAdd, tasksChange, tasksList, type TaskRow } from '../../shared/tasks.js';
import { sessionTasks } from './session-tasks.js';

/**
 * The nearest directory at or above `directory` that holds an ALP project. The user's library,
 * `~/.alp` by default, is not one: otherwise every folder under the home would be a project.
 */
export async function projectOf(directory: string) {
  // Windows paths compare without case.
  const key = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file;
  const library = key(alpHome());
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    const alp = path.join(current, '.alp');
    if (key(alp) !== library) try { await access(alp); return current; } catch {}
    if (path.dirname(current) === current) return null;
  }
}

async function requireProject(directory: string) {
  const root = await projectOf(directory);
  if (!root) throw new Error(`${directory} is not in an ALP project; run alp init`);
  return root;
}

/** The Tasks panel's server side: reads and changes .alp/tasks as the user, without alpd. */
export function registerTaskRpc(server: PluginServerContext) {
  server.handle(tasksList, async ({ directory }) => {
    const projectRoot = await projectOf(directory);
    if (!projectRoot) return { projectRoot: null, tasks: [], unreadable: [] };
    const { tasks: rows, unreadable } = await taskRows(projectRoot);
    // The tasks each session worked on, of this project only.
    const known = new Set(rows.map(task => task.id));
    const sessions = Object.fromEntries([...sessionTasks].map(([id, worked]) => [id, worked.filter(task => known.has(task))]).filter(([, worked]) => worked.length));
    return { projectRoot, tasks: rows as TaskRow[], unreadable, sessions };
  });

  server.handle(tasksAdd, async ({ directory, title, priority }) => {
    const task = await createTask(await requireProject(directory), { title, ...(priority !== undefined ? { priority } : {}) }, 'user');
    return { id: task.id };
  });

  server.handle(tasksChange, async ({ directory, id, action, gate, note }) => {
    const root = await requireProject(directory);
    const task =
      action === 'close' ? await closeTask(root, id, { reason: 'done', ...(note ? { summary: note } : {}) }, 'user')
      : action === 'reopen' ? await reopenTask(root, id, { ...(note ? { note } : {}) }, 'user')
      : await resolveGate(root, id, gate ?? '', { by: 'user', ...(note ? { note } : {}) });
    if (action !== 'close') return { id: task.id, status: task.status };
    const { tasks } = await loadTasks(root);
    const landed = tasks.some(entry => entry.parent === task.id) ? epicReport(task.id, tasks).text.split('\n')[0] : undefined;
    return { id: task.id, status: task.status, ...(landed ? { landed } : {}) };
  });
}
