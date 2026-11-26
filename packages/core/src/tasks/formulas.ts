import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AlpError } from '../errors.ts';
import { DESCRIPTION_CHARS, TASK_TYPES, batch } from './records/tasks.ts';
import type { Task, TaskType } from './records/tasks.ts';

export type FormulaStep = { id: string; title: string; description?: string; type: string; needs: string[]; priority?: number; labels?: string[]; paths?: string[] };
export type Formula = {
  formula: string;
  title?: string;
  description?: string;
  version?: number;
  priority?: number;
  vars: Record<string, { description?: string; required: boolean; default?: string }>;
  steps: FormulaStep[];
};
/** Parses TOML text; the core has none of its own (e.g. smol-toml's parse). */
export type TomlParser = (text: string) => unknown;
export type Parsers = { toml?: TomlParser };
export type FormulaEntry = { name: string; file: string; formula?: Formula; error?: string };

/**
 * Formulas, after beads: a workflow template whose steps become tasks. A
 * formula file is <name>.formula.toml or <name>.formula.json in the project's
 * .alp/formulas, the user's $ALP_HOME/formulas, or the project's .beads/formulas
 * (searched in that order; the first of a name wins). Pouring it creates an
 * epic and one child task per step, with `needs` as blockedBy between them. A
 * `human` step is the user's: it waits on a human gate, and approving it completes it.
 * The core has no TOML parser of its own; callers pass one as `toml`.
 */

const fail: (message: string) => never = (message) => { throw new AlpError('INVALID_FORMULA', message); };
const NAME = /^[\w.-]{1,64}$/;
const STEP_ID = /^[\w-]{1,64}$/;
const VAR = /\{\{\s*([\w-]+)\s*\}\}/g;
export const MAX_STEPS: number = 50;

export function formulaDirs(projectRoot: string, home?: string): string[] {
  return [
    path.join(path.resolve(projectRoot), '.alp', 'formulas'),
    ...(home ? [path.join(home, 'formulas')] : []),
    path.join(path.resolve(projectRoot), '.beads', 'formulas'),
  ];
}

const FILE = /^(.+)\.formula\.(toml|json)$/;

/** Every formula file found, first of each name, with what parsing it reported. */
export async function listFormulas(projectRoot: string, home?: string, { toml }: Parsers = {}): Promise<FormulaEntry[]> {
  const found = new Map<string, FormulaEntry>();
  for (const dir of formulaDirs(projectRoot, home)) {
    let names;
    try { names = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    for (const name of names.sort()) {
      const match = FILE.exec(name);
      if (!match || found.has(match[1])) continue;
      const file = path.join(dir, name);
      try {
        const formula = await loadFormula(file, { toml });
        found.set(match[1], { name: match[1], file, formula });
      } catch (error) {
        found.set(match[1], { name: match[1], file, error: (error as Error).message });
      }
    }
  }
  return [...found.values()];
}

export async function findFormula(projectRoot: string, home: string | undefined, name: string, { toml }: Parsers = {}): Promise<FormulaEntry & { formula: Formula }> {
  if (!NAME.test(name ?? '')) fail('A formula name has letters, digits, dots, dashes and underscores');
  const entry = (await listFormulas(projectRoot, home, { toml })).find(candidate => candidate.name === name);
  if (!entry) fail(`No formula ${name} in ${formulaDirs(projectRoot, home).join(', ')}`);
  if (entry.error) fail(`${entry.file}: ${entry.error}`);
  return entry as FormulaEntry & { formula: Formula };
}

export async function loadFormula(file: string, { toml }: Parsers = {}): Promise<Formula> {
  const text = await readFile(file, 'utf8');
  if (!file.endsWith('.json') && !toml) fail('reading TOML formulas needs a TOML parser');
  let data: unknown;
  try { data = file.endsWith('.json') ? JSON.parse(text) : toml!(text); }
  catch (error) { fail(`cannot parse: ${(error as Error).message.split('\n')[0]}`); }
  return validateFormula(data);
}

const optionalText = (value: unknown, name: string, limit: number) => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > limit) fail(`${name} must be text of at most ${limit} characters`);
  return value;
};

/** Checks a parsed formula and returns it normalized. */
export function validateFormula(data: any): Formula { // any: a parsed TOML or JSON document of unknown shape, checked field by field below
  if (!data || typeof data !== 'object' || Array.isArray(data)) fail('A formula is an object');
  if (typeof data.formula !== 'string' || !NAME.test(data.formula)) fail('formula must name it: letters, digits, dots, dashes and underscores');
  const vars: Formula['vars'] = {};
  if (data.vars !== undefined) {
    if (!data.vars || typeof data.vars !== 'object' || Array.isArray(data.vars)) fail('vars must be a table of variables');
    for (const [name, spec] of Object.entries(data.vars)) {
      if (!/^[\w-]{1,64}$/.test(name)) fail(`Variable ${name} has an invalid name`);
      const value: any = spec && typeof spec === 'object' ? spec : {}; // any: an unchecked table from the parsed document
      vars[name] = {
        ...(typeof value.description === 'string' ? { description: value.description } : {}),
        required: value.required === true,
        ...(value.default !== undefined ? { default: String(value.default) } : {}),
      };
    }
  }
  if (!Array.isArray(data.steps) || !data.steps.length || data.steps.length > MAX_STEPS) fail(`steps must list 1 to ${MAX_STEPS} steps`);
  const ids = new Set<string>();
  const steps: FormulaStep[] = data.steps.map((step: any, index: number) => { // any: an unchecked step from the parsed document
    if (!step || typeof step !== 'object') fail(`Step ${index + 1} is not a table`);
    if (typeof step.id !== 'string' || !STEP_ID.test(step.id)) fail(`Step ${index + 1} needs an id of letters, digits, dashes and underscores`);
    if (ids.has(step.id)) fail(`Two steps have id ${step.id}`);
    ids.add(step.id);
    if (typeof step.title !== 'string' || !step.title.trim()) fail(`Step ${step.id} needs a title`);
    const needs = step.needs === undefined ? [] : step.needs;
    if (!Array.isArray(needs) || !needs.every(need => typeof need === 'string')) fail(`Step ${step.id}: needs must list step ids`);
    if (step.priority !== undefined && (!Number.isInteger(step.priority) || step.priority < 0 || step.priority > 4)) fail(`Step ${step.id}: priority must be 0 to 4`);
    return {
      id: step.id,
      title: step.title,
      ...(optionalText(step.description, `Step ${step.id} description`, DESCRIPTION_CHARS) ? { description: step.description } : {}),
      type: typeof step.type === 'string' ? step.type : 'task',
      needs: [...new Set(needs)],
      ...(step.priority !== undefined ? { priority: step.priority } : {}),
      ...(Array.isArray(step.labels) ? { labels: step.labels.filter((label: unknown) => typeof label === 'string') } : {}),
      ...(Array.isArray(step.paths) ? { paths: step.paths.filter((entry: unknown) => typeof entry === 'string') } : {}),
    };
  });
  for (const step of steps) for (const need of step.needs) if (!ids.has(need)) fail(`Step ${step.id} needs unknown step ${need}`);
  // Steps must form no cycle.
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'open') fail(`Steps form a cycle: ${[...trail, id].join(' → ')}`);
    state.set(id, 'open');
    for (const need of steps.find(step => step.id === id)!.needs) visit(need, [...trail, id]);
    state.set(id, 'done');
  };
  for (const step of steps) visit(step.id, []);
  return {
    formula: data.formula,
    ...(optionalText(data.title, 'title', 200) ? { title: data.title } : {}),
    ...(optionalText(data.description, 'description', DESCRIPTION_CHARS) ? { description: data.description } : {}),
    ...(Number.isInteger(data.version) ? { version: data.version } : {}),
    ...(Number.isInteger(data.priority) && data.priority >= 0 && data.priority <= 4 ? { priority: data.priority } : {}),
    vars,
    steps,
  };
}

/** The variables a pour uses: given values over defaults; unknown or missing required ones refuse it. */
export function resolveVars(formula: Formula, given: Record<string, string> = {}): Record<string, string> {
  const unknown = Object.keys(given).filter(name => !(name in formula.vars));
  if (unknown.length) fail(`${formula.formula} has no variable ${unknown.join(', ')}; it takes ${Object.keys(formula.vars).join(', ') || 'none'}`);
  const values: Record<string, string> = {};
  for (const [name, spec] of Object.entries(formula.vars)) {
    const value = given[name] ?? spec.default;
    if (value === undefined && spec.required) fail(`${formula.formula} needs --var ${name}=…${spec.description ? ` (${spec.description})` : ''}`);
    if (value !== undefined) values[name] = String(value);
  }
  return values;
}

function fill(text: string, values: Record<string, string>, where: string): string {
  return text.replace(VAR, (whole, name) => {
    if (!(name in values)) fail(`${where} uses {{${name}}}, which has no value`);
    return values[name];
  });
}

/**
 * Pours a formula: an epic for the run and a child task per step, in step order,
 * so step n is <epic>.n. Returns the epic and its steps' tasks.
 */
export async function pourFormula(projectRoot: string, formula: Formula, given: Record<string, string> | undefined, by: string, { dryRun = false, parent }: { dryRun?: boolean; parent?: string } = {}): Promise<{ epic: Task; tasks: Task[] }> {
  const values = resolveVars(formula, given);
  const summary = Object.entries(values).map(([name, value]) => `${name}=${value}`).join(', ');
  const title = formula.title ? fill(formula.title, values, 'title') : `${formula.formula}${summary ? ` (${summary})` : ''}`;
  const steps = formula.steps.map(step => ({
    ...step,
    title: fill(step.title, values, `Step ${step.id}`),
    ...(step.description ? { description: fill(step.description, values, `Step ${step.id}`) } : {}),
  }));
  return batch(projectRoot, ({ add, link }) => {
    const epic = add({
      title: title.slice(0, 200), type: 'epic', priority: formula.priority ?? 2, labels: [`formula:${formula.formula}`.slice(0, 50)],
      ...(formula.description ? { description: fill(formula.description, values, 'description') } : {}),
      ...(parent ? { parent } : {}),
    }, by, { event: 'poured', details: { formula: formula.formula }, extra: { formula: { name: formula.formula, ...(formula.version ? { version: formula.version } : {}), vars: values } } });
    const made = new Map<string, Task>();
    for (const step of steps) {
      const human = step.type === 'human';
      const type = TASK_TYPES.includes(step.type as TaskType) && step.type !== 'epic' ? step.type as TaskType : 'task';
      const task = add({
        title: step.title.slice(0, 200), type, priority: step.priority ?? formula.priority ?? 2, parent: epic.id,
        ...(step.description ? { description: step.description } : {}),
        ...(step.labels ? { labels: step.labels } : {}),
        ...(step.paths ? { paths: step.paths } : {}),
      }, by, {
        event: 'poured', details: { formula: formula.formula, step: step.id },
        extra: {
          step: { formula: formula.formula, id: step.id, ...(human ? { human: true } : {}) },
          ...(human ? { gates: [{ id: 'g1', kind: 'human', note: `Your step: ${step.title}`.slice(0, 2000), at: new Date().toISOString(), by }] } : {}),
        },
      });
      made.set(step.id, task);
    }
    for (const step of steps) {
      for (const need of step.needs) {
        const refused = link(made.get(step.id)!, 'blockedBy', made.get(need)!.id);
        if (refused) fail(`Step ${step.id} cannot need ${need}: ${refused}`);
      }
    }
    return { epic, tasks: [...made.values()] };
  }, { dryRun });
}
