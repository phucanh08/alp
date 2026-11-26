import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { exportBeads, importBeads, parseJsonl } from '@anhlp/alp-core/beads';
import { loadTasks } from '@anhlp/alp-core/tasks';
import { taskProject } from '../_shared/project.ts';
import { UsageError } from '../_shared/usage.ts';
import { warnUnreadable } from './format.ts';

/** alp tasks export / import: interchange with beads through its JSONL issue format. */

export async function beads(command: string, args: string[]) {
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
