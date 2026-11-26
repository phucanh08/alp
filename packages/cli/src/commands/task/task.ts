import path from 'node:path';
import { parseArgs } from 'node:util';
import { addGate, closeTask, createTask, describeGate, gateOpen, epicReport, linkTask, loadTasks, rejectGate, reopenTask, resolveGate, TASKS_DIR, updateTask, isAgentProcess, AGENT_MARKER } from '@anhlp/alp-core/tasks';
import { AlpError } from '@anhlp/alp-core/errors';
import type { CloseReason, Task, TaskType } from '@anhlp/alp-core/tasks';
import { taskProject } from '../_shared/project.ts';
import { UsageError } from '../_shared/usage.ts';
import { printTask, taskRow, warnUnreadable } from './format.ts';

export const repeated = { type: 'string', multiple: true } as const;

export async function taskCommand([action, ...args]: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    description: { type: 'string', short: 'd' }, priority: { type: 'string', short: 'p' }, type: { type: 'string', short: 't' },
    label: { ...repeated, short: 'l' }, path: repeated, parent: { type: 'string' }, after: repeated, related: repeated, from: { type: 'string' },
    title: { type: 'string' }, message: { type: 'string', short: 'm' }, reason: { type: 'string' }, unverified: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' },
    human: { type: 'string' }, timer: { type: 'string' }, pr: { type: 'string' }, run: { type: 'string' }, option: repeated, choice: { type: 'string' },
  } });
  const root = await taskProject(values.project);
  const fields = {
    ...(values.description !== undefined ? { description: values.description } : {}),
    ...(values.priority !== undefined ? { priority: values.priority } : {}),
    ...(values.type !== undefined ? { type: values.type as TaskType } : {}),
    ...(values.label ? { labels: values.label } : {}),
    ...(values.path ? { paths: values.path } : {}),
  };
  let task: Task | undefined;
  if (action === 'add') {
    const title = positionals.join(' ').trim();
    if (!title) throw new UsageError();
    task = await createTask(root, { title, ...fields, parent: values.parent, blockedBy: values.after, related: values.related, discoveredFrom: values.from }, 'user');
  } else if (action === 'show') {
    if (positionals.length !== 1) throw new UsageError();
    const { tasks, errors } = await loadTasks(root);
    warnUnreadable(errors);
    task = tasks.find(candidate => candidate.id === positionals[0]);
    if (!task) throw new Error(`No task ${positionals[0]} in ${path.join(root, TASKS_DIR)}`);
    if (values.json) { console.log(JSON.stringify(task)); return; }
    printTask(task, tasks);
    return;
  } else if (action === 'report') {
    if (positionals.length !== 1) throw new UsageError();
    const { tasks, errors } = await loadTasks(root);
    warnUnreadable(errors);
    const report = epicReport(positionals[0], tasks);
    console.log(values.json ? JSON.stringify(report) : report.text);
    return;
  } else if (action === 'edit') {
    if (positionals.length !== 1) throw new UsageError();
    task = await updateTask(root, positionals[0], { ...fields, ...(values.title !== undefined ? { title: values.title } : {}), note: values.message }, 'user');
  } else if (action === 'close') {
    if (positionals.length !== 1) throw new UsageError();
    task = await closeTask(root, positionals[0], { reason: values.reason as CloseReason | undefined, summary: values.message, unverified: values.unverified, agent: isAgentProcess(), channel: 'cli' }, 'user');
  } else if (action === 'reopen') {
    if (positionals.length !== 1) throw new UsageError();
    task = await reopenTask(root, positionals[0], { note: values.message }, 'user');
  } else if (action === 'dep') {
    const [change, id, ...rest] = positionals;
    if (!['add', 'rm'].includes(change) || !id || rest.length || !(values.after || values.parent || values.related)) throw new UsageError();
    const links = { ...(values.after ? { blockedBy: values.after } : {}), ...(values.parent ? { parent: values.parent } : {}), ...(values.related ? { related: values.related } : {}) };
    task = await linkTask(root, id, change === 'add' ? { add: links } : { remove: links }, 'user');
  } else if (action === 'gate') {
    const [change, id, gate, ...rest] = positionals;
    const kinds = (['human', 'timer', 'pr', 'run'] as const).filter(kind => values[kind] !== undefined);
    // Only the user decides a human gate: never from a process an ALP agent started (t-ca1f).
    if (['clear', 'reject', 'rm'].includes(change) && id && gate && isAgentProcess()) {
      const { tasks: current } = await loadTasks(root);
      if (current.find(entry => entry.id === id)?.gates.find(entry => entry.id === gate)?.kind === 'human') throw new AlpError('GATE_USER_ONLY', `Only the user clears a human gate; this process runs under an ALP agent (${AGENT_MARKER}). Ask the user to decide it`);
    }
    if (change === 'add' && id && !gate && kinds.length === 1) {
      const kind = kinds[0];
      if (values.option && kind !== 'human') throw new UsageError();
      task = await addGate(root, id, kind === 'human' ? { kind, note: values.human, ...(values.option ? { options: values.option } : {}) } : kind === 'timer' ? { kind, until: values.timer } : { kind: `gh:${kind}`, ref: values[kind] }, 'user');
    } else if (change === 'clear' && id && gate && !rest.length && !kinds.length && !values.option) {
      // A decision made here reaches main as mail, as one made in Paseo or ALP web does.
      task = await resolveGate(root, id, gate, { by: 'user', note: values.message, channel: 'cli', ...(values.choice !== undefined ? { choice: values.choice } : {}) });
    } else if (change === 'reject' && id && gate && !rest.length && !kinds.length && !values.option && values.choice === undefined) {
      task = await rejectGate(root, id, gate, { by: 'user', reason: values.message, channel: 'cli' });
    } else if (change === 'rm' && id && gate && !rest.length && !kinds.length && !values.option && values.choice === undefined) {
      task = await resolveGate(root, id, gate, { by: 'user', note: values.message, remove: true, channel: 'cli' });
    } else {
      throw new UsageError();
    }
  } else {
    throw new UsageError();
  }
  if (values.json) { console.log(JSON.stringify(task)); return; }
  const { tasks } = await loadTasks(root);
  console.log(`${({ add: 'Created', close: 'Closed', reopen: 'Reopened' } as Record<string, string | undefined>)[action] ?? 'Updated'} ${TASKS_DIR}/${task.id}.json`);
  if (action === 'gate') for (const gate of task.gates.filter(entry => gateOpen(entry))) console.log(`  ⏸ ${describeGate(gate)}`);
  console.log(taskRow(task, tasks));
  if (action === 'close' && tasks.some(entry => entry.parent === task.id)) console.log(`\n${epicReport(task.id, tasks).text}`);
}
