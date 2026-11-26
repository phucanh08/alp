import { parseArgs } from 'node:util';
import { findFormula, formulaDirs, listFormulas, pourFormula } from '@anhlp/alp-core/formulas';
import { parse as toml } from 'smol-toml';
import { alpHome } from '@anhlp/alp-client/index';
import { taskProject } from '../_shared/project.js';
import { UsageError } from '../_shared/usage.js';
import { taskRow } from './format.js';

/** alp formula: workflow templates that pour into an epic with a task per step. */

export async function formulaCommand([action, ...args]: string[]) {
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
    // An entry without an error carries its formula.
    for (const entry of found) console.log(entry.error ? `✗ ${entry.name}  ${entry.file}: ${entry.error}` : `${entry.name}  ${entry.formula!.steps.length} steps${entry.formula!.description ? `  ${entry.formula!.description.split('\n')[0]}` : ''}`);
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
  const given: Record<string, string> = {};
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
