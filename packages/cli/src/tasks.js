import { spawn } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { exportBeads, importBeads, parseJsonl } from '@anhlp/alp-core/beads';
import { findFormula, formulaDirs, listFormulas, pourFormula } from '@anhlp/alp-core/formulas';
import { describeVerification } from '@anhlp/alp-core/verify';
import { ago } from '@anhlp/alp-client/render';
import { parse as toml } from 'smol-toml';
import { addGate, blockersOf, checkGates, childrenOf, closeTask, compactTasks, createTask, describeGate, gateOpen, epicReport, gatesOf, linkTask, listTasks, loadTasks, readyTasks, reopenTask, resolveGate, summarize, TASKS_DIR, updateTask } from '@anhlp/alp-core/tasks';
import { alpHome } from '@anhlp/alp-client/index';
import { UsageError } from './usage.js';

const STATUS_MARK = { open: '○', in_progress: '◐', review: '◑', closed: '●' };

/** The ALP project a task command works on: --project, or the current directory. */
/** alp permissions: the profile each agent runs with, from .alp/settings.json and $ALP_HOME/settings.json. */

async function taskProject(directory) {
  const root = path.resolve(directory ?? process.cwd());
  try { await access(path.join(root, '.alp')); }
  catch { throw new Error(`${root} is not an ALP project (no .alp directory); run alp init, or pass --project`); }
  return root;
}

function taskRow(task, tasks) {
  const row = summarize(task, tasks);
  const extra = [
    row.blockedBy ? `blocked by ${row.blockedBy.join(', ')}` : '',
    row.gates ? `waits on ${row.gates.join('; ')}` : '',
    row.assignee ? `@${row.assignee}` : '',
    row.labels ? row.labels.map(label => `#${label}`).join(' ') : '',
  ].filter(Boolean).join('  ');
  return `${STATUS_MARK[task.status]} ${task.id.padEnd(10)} P${task.priority} ${task.type.padEnd(7)} ${task.status.padEnd(11)} ${task.title}${extra ? `  ${extra}` : ''}`;
}

function warnUnreadable(errors) {
  for (const { file, error } of errors) console.error(`alp: skipped ${file}: ${error}`);
}

/** The project's tasks: open, in progress and in review by default; ready lists what nothing blocks. */

async function tasksCommand(args) {
  if (args[0] === 'gates' || args[0] === 'compact') return taskMaintenance([args[0]], args.slice(1));
  if (args[0] === 'export' || args[0] === 'import') return beads(args[0], args.slice(1));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    all: { type: 'boolean' }, status: { type: 'string' }, label: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' },
  } });
  if (positionals.length > 1 || (positionals.length && positionals[0] !== 'ready')) throw new UsageError();
  const root = await taskProject(values.project);
  const { tasks, errors } = await loadTasks(root);
  warnUnreadable(errors);
  const rows = positionals[0] === 'ready' ? readyTasks(tasks) : listTasks(tasks, { status: values.status, label: values.label, all: values.all });
  if (values.json) { console.log(JSON.stringify(rows)); return; }
  if (!rows.length) { console.log(positionals[0] === 'ready' ? 'No task is ready' : `No tasks in ${path.join(root, TASKS_DIR)}`); return; }
  for (const task of rows) console.log(taskRow(task, tasks));
}

/** The GitHub CLI, for gh:pr and gh:run gates. */

const gh = (args, { cwd }) => new Promise((resolve, reject) => {
  const bin = process.env.ALP_GH_BIN ?? 'gh';
  // Windows cannot exec a script by its shebang (the tests' stand-in for gh); a JavaScript one runs under this Node.
  const script = process.platform === 'win32' && /\.[cm]?js$/i.test(bin);
  const child = spawn(script ? process.execPath : bin, script ? [bin, ...args] : args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => reject(error.code === 'ENOENT' ? new Error('gh is not installed or not on PATH') : error));
  child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `gh exited with ${code}`)));
});

/** alp tasks gates: clears GitHub gates that are done and lists the open ones. alp tasks compact: shrinks old closed tasks. */

async function taskMaintenance([command], args) {
  const { values, positionals: rest } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, json: { type: 'boolean' }, days: { type: 'string' }, 'dry-run': { type: 'boolean' },
  } });
  if (rest.length) throw new UsageError();
  const root = await taskProject(values.project);
  if (command === 'compact') {
    const days = values.days === undefined ? 30 : Number(values.days);
    const changed = await compactTasks(root, { days, dryRun: values['dry-run'] }, 'user');
    if (values.json) { console.log(JSON.stringify(changed)); return; }
    if (!changed.length) { console.log(`No task closed more than ${days} days ago is left to compact`); return; }
    for (const { id, before, after } of changed) console.log(`${id}  ${before} → ${after} characters`);
    console.log(`${values['dry-run'] ? 'Would compact' : 'Compacted'} ${changed.length} closed ${changed.length === 1 ? 'task' : 'tasks'}`);
    return;
  }
  const checked = await checkGates(root, gh);
  const { tasks } = await loadTasks(root);
  const open = tasks.filter(task => task.status !== 'closed').flatMap(task => task.gates.filter(gate => gateOpen(gate)).map(gate => ({ task, gate })));
  if (values.json) { console.log(JSON.stringify({ ...checked, open: open.map(({ task, gate }) => ({ task: task.id, ...gate })) })); return; }
  for (const { task, gate, detail } of checked.cleared) console.log(`✓ ${task} ${gate} cleared: ${detail}`);
  for (const { task, gate, error } of checked.errors) console.error(`alp: could not check ${task} ${gate}: ${error}`);
  if (!open.length) { console.log('No open gates'); return; }
  for (const { task, gate } of open) {
    const state = checked.pending.find(entry => entry.task === task.id && entry.gate === gate.id)?.detail;
    console.log(`⏸ ${task.id} ${describeGate(gate)}${state ? ` (${state})` : ''}  ${task.title}`);
  }
}

/** alp tasks export / import: interchange with beads through its JSONL issue format. */

async function beads(command, args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, output: { type: 'string', short: 'o' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
  } });
  const root = await taskProject(values.project);
  if (command === 'export') {
    if (positionals.length || values['dry-run']) throw new UsageError();
    const { tasks, errors } = await loadTasks(root);
    warnUnreadable(errors);
    const text = exportBeads(tasks).map(record => JSON.stringify(record)).join('\n') + (tasks.length ? '\n' : '');
    if (values.output) {
      await writeFile(values.output, text);
      console.error(`Exported ${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} to ${values.output}`);
    } else {
      process.stdout.write(text);
    }
    return;
  }
  if (positionals.length > 1 || values.output) throw new UsageError();
  const file = positionals[0] ?? path.join(root, '.beads', 'issues.jsonl');
  const { records, errors } = parseJsonl(await readFile(file, 'utf8'));
  const report = await importBeads(root, records, { dryRun: values['dry-run'], by: 'user' });
  report.skipped.push(...errors);
  if (values.json) { console.log(JSON.stringify(report)); return; }
  const verb = values['dry-run'] ? 'Would import' : 'Imported';
  for (const { id, from } of report.created) console.log(`+ ${id}${id !== from ? ` (from ${from})` : ''}`);
  for (const { id, from } of report.updated) console.log(`~ ${id}${id !== from ? ` (from ${from})` : ''}`);
  for (const { line, reason } of report.skipped.sort((a, b) => a.line - b.line)) console.error(`alp: skipped line ${line}: ${reason}`);
  for (const warning of report.warnings) console.error(`alp: ${warning}`);
  console.log(`${verb} ${file}: ${report.created.length} created, ${report.updated.length} updated, ${report.skipped.length} skipped`);
}

/** alp formula: workflow templates that pour into an epic with a task per step. */

async function formulaCommand([action, ...args]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    project: { type: 'string' }, var: { type: 'string', multiple: true }, parent: { type: 'string' }, 'dry-run': { type: 'boolean' }, json: { type: 'boolean' },
  } });
  const root = await taskProject(values.project);
  const home = alpHome();
  if (action === 'list') {
    if (positionals.length) throw new UsageError();
    const found = await listFormulas(root, home, { toml });
    if (values.json) { console.log(JSON.stringify(found)); return; }
    if (!found.length) { console.log(`No formulas in ${formulaDirs(root, home).join(', ')}`); return; }
    for (const entry of found) console.log(entry.error ? `✗ ${entry.name}  ${entry.file}: ${entry.error}` : `${entry.name}  ${entry.formula.steps.length} steps${entry.formula.description ? `  ${entry.formula.description.split('\n')[0]}` : ''}`);
    return;
  }
  if (positionals.length !== 1) throw new UsageError();
  const { formula, file } = await findFormula(root, home, positionals[0], { toml });
  if (action === 'show') {
    if (values.json) { console.log(JSON.stringify(formula)); return; }
    console.log(`${formula.formula}${formula.version ? ` v${formula.version}` : ''}  ${file}`);
    if (formula.description) console.log(`  ${formula.description}`);
    for (const [name, spec] of Object.entries(formula.vars)) console.log(`  --var ${name}=…${spec.required ? ' (required)' : spec.default !== undefined ? ` (default ${spec.default})` : ''}${spec.description ? `  ${spec.description}` : ''}`);
    for (const step of formula.steps) console.log(`  ${step.id}${step.type === 'human' ? ' [you]' : step.type !== 'task' ? ` [${step.type}]` : ''}: ${step.title}${step.needs.length ? `  after ${step.needs.join(', ')}` : ''}`);
    return;
  }
  if (action !== 'pour') throw new UsageError();
  const given = {};
  for (const entry of values.var ?? []) {
    const at = entry.indexOf('=');
    if (at < 1) throw new UsageError();
    given[entry.slice(0, at)] = entry.slice(at + 1);
  }
  const { epic, tasks } = await pourFormula(root, formula, given, 'user', { dryRun: values['dry-run'], ...(values.parent ? { parent: values.parent } : {}) });
  if (values.json) { console.log(JSON.stringify({ epic, tasks })); return; }
  console.log(`${values['dry-run'] ? 'Would pour' : 'Poured'} ${formula.formula} as ${epic.id}  ${epic.title}`);
  const all = [epic, ...tasks];
  for (const task of tasks) console.log(`  ${taskRow(task, all)}`);
}

const repeated = { type: 'string', multiple: true };

async function taskCommand([action, ...args]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    description: { type: 'string', short: 'd' }, priority: { type: 'string', short: 'p' }, type: { type: 'string', short: 't' },
    label: { ...repeated, short: 'l' }, path: repeated, parent: { type: 'string' }, after: repeated, related: repeated, from: { type: 'string' },
    title: { type: 'string' }, message: { type: 'string', short: 'm' }, reason: { type: 'string' }, unverified: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' },
    human: { type: 'string' }, timer: { type: 'string' }, pr: { type: 'string' }, run: { type: 'string' },
  } });
  const root = await taskProject(values.project);
  const fields = {
    ...(values.description !== undefined ? { description: values.description } : {}),
    ...(values.priority !== undefined ? { priority: values.priority } : {}),
    ...(values.type !== undefined ? { type: values.type } : {}),
    ...(values.label ? { labels: values.label } : {}),
    ...(values.path ? { paths: values.path } : {}),
  };
  let task;
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
    task = await closeTask(root, positionals[0], { reason: values.reason, summary: values.message, unverified: values.unverified }, 'user');
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
    const kinds = ['human', 'timer', 'pr', 'run'].filter(kind => values[kind] !== undefined);
    if (change === 'add' && id && !gate && kinds.length === 1) {
      const kind = kinds[0];
      task = await addGate(root, id, kind === 'human' ? { kind, note: values.human } : kind === 'timer' ? { kind, until: values.timer } : { kind: `gh:${kind}`, ref: values[kind] }, 'user');
    } else if ((change === 'clear' || change === 'rm') && id && gate && !rest.length && !kinds.length) {
      task = await resolveGate(root, id, gate, { by: 'user', note: values.message, remove: change === 'rm' });
    } else {
      throw new UsageError();
    }
  } else {
    throw new UsageError();
  }
  if (values.json) { console.log(JSON.stringify(task)); return; }
  const { tasks } = await loadTasks(root);
  console.log(`${{ add: 'Created', close: 'Closed', reopen: 'Reopened' }[action] ?? 'Updated'} ${TASKS_DIR}/${task.id}.json`);
  if (action === 'gate') for (const gate of task.gates.filter(entry => gateOpen(entry))) console.log(`  ⏸ ${describeGate(gate)}`);
  console.log(taskRow(task, tasks));
  if (action === 'close' && tasks.some(entry => entry.parent === task.id)) console.log(`\n${epicReport(task.id, tasks).text}`);
}

function printTask(task, tasks) {
  console.log(`${STATUS_MARK[task.status]} ${task.id}  ${task.title}`);
  console.log(`  ${task.type}, P${task.priority}, ${task.status}${task.assignee ? ` with ${task.assignee.agent}` : ''}; created by ${task.createdBy} ${ago(task.createdAt)} ago, rev ${task.rev}`);
  if (task.description) console.log(`\n  ${task.description.replace(/\n/g, '\n  ')}\n`);
  const blockers = task.status === 'closed' ? [] : blockersOf(task, tasks);
  const relations = [
    task.parent && `parent ${task.parent}`,
    task.blockedBy.length && `after ${task.blockedBy.join(', ')}${blockers.length ? ` (open: ${blockers.join(', ')})` : ''}`,
    task.discoveredFrom && `found during ${task.discoveredFrom}`,
    task.related.length && `related ${task.related.join(', ')}`,
  ].filter(Boolean);
  if (relations.length) console.log(`  ${relations.join('; ')}`);
  for (const gate of task.gates) console.log(`  ${gateOpen(gate) ? '⏸' : '✓'} gate ${describeGate(gate)}${gate.resolved ? ` (cleared by ${gate.resolved.by}${gate.resolved.note ? `: ${gate.resolved.note}` : ''})` : ''}`);
  const inherited = gatesOf(task, tasks).filter(label => label.startsWith('t-'));
  if (task.status !== 'closed' && inherited.length) console.log(`  waits on its parent's gates: ${inherited.join('; ')}`);
  if (task.compacted) console.log(`  compacted ${task.compacted.at.slice(0, 10)} from ${task.compacted.chars} characters`);
  if (task.labels.length) console.log(`  labels: ${task.labels.join(', ')}`);
  if (task.paths.length) console.log(`  paths: ${task.paths.join(', ')}`);
  for (const child of childrenOf(task.id, tasks)) console.log(`  ${taskRow(child, tasks)}`);
  if (task.verified) console.log(`  ${task.verified.skipped ? '–' : task.verified.passed ? '✓' : '✗'} ${describeVerification(task.verified)}${task.verified.where ? ` in the ${task.verified.where}` : ''}, ${ago(task.verified.at)} ago`);
  if (task.closed) console.log(`  closed ${task.closed.reason} by ${task.closed.by}${task.closed.summary ? `: ${task.closed.summary}` : ''}${task.closed.unverified ? ` (unverified: ${task.closed.unverified})` : ''}`);
  for (const entry of task.log.slice(-10)) {
    const { at, by, event, ...detail } = entry;
    const text = Object.entries(detail).map(([key, value]) => `${key} ${Array.isArray(value) ? value.join(', ') : value}`).join('; ');
    console.log(`  ${at.slice(0, 16).replace('T', ' ')}  ${by} ${event}${text ? `: ${text}` : ''}`);
  }
}

/** Pauses and parked assignments, one line each; `always` also says when nothing is paused. */

export { STATUS_MARK, taskProject, taskRow, warnUnreadable, tasksCommand, gh, taskMaintenance, beads, formulaCommand, repeated, taskCommand, printTask };
