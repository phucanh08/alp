import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { scriptCommand } from '@anhlp/alp-core/packaged';
import { checkGates, compactTasks, describeGate, gateOpen, loadTasks } from '@anhlp/alp-core/tasks';
import { taskProject } from '../_shared/project.js';
import { UsageError } from '../_shared/usage.js';

/** The GitHub CLI, for gh:pr and gh:run gates. */

export const gh = (args: string[], { cwd }: { cwd: string }) => new Promise<string>((resolve, reject) => {
  const bin = process.env.ALP_GH_BIN ?? 'gh';
  // Windows cannot exec a script by its shebang (the tests' stand-in for gh); a JavaScript one runs under this Node.
  const script = process.platform === 'win32' && /\.[cm]?js$/i.test(bin);
  const run: { command: string; args: string[]; env?: Record<string, string> } = script ? scriptCommand(bin, args) : { command: bin, args };
  const child = spawn(run.command, run.args, { cwd, ...(run.env ? { env: { ...process.env, ...run.env } } : {}), stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', (error: NodeJS.ErrnoException) => reject(error.code === 'ENOENT' ? new Error('gh is not installed or not on PATH') : error));
  child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `gh exited with ${code}`)));
});

/** alp tasks gates: clears GitHub gates that are done and lists the open ones. alp tasks compact: shrinks old closed tasks. */

export async function taskMaintenance([command]: string[], args: string[]) {
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
