import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '@anhlp/alp-core/atomic';

export type AssignmentResultOwner = { assignmentId: string; checkout: string; worktree?: string };
type Ledger = { version: 1; workspaces: string[]; results: AssignmentResultOwner[] };
const empty = (): Ledger => ({ version: 1, workspaces: [], results: [] });
const absolute = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value);
const valid = (value: any): value is Ledger => value?.version === 1 && Array.isArray(value.workspaces) && value.workspaces.every(absolute) &&
  Array.isArray(value.results) && value.results.every((entry: any) => entry && typeof entry.assignmentId === 'string' && absolute(entry.checkout) && (entry.worktree === undefined || absolute(entry.worktree)));

/** Permanent ownership, independent of native-thread recall expiry. Missing initialized data is never recreated. */
export function createAssignmentResults(file?: string) {
  let memory = empty();
  let queue = Promise.resolve();
  const marker = file ? `${file}.initialized` : undefined;
  async function load(initialize = false): Promise<Ledger> {
    if (!file) return memory;
    let value: unknown;
    try { value = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !initialize) throw new Error(`Cannot inspect assignment result ledger ${file}`);
      try { await readFile(marker!, 'utf8'); }
      catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === 'ENOENT') return empty();
        throw missing;
      }
      throw new Error(`Assignment result ledger ${file} was lost; restore it before managing workspaces`);
    }
    if (!valid(value)) throw new Error(`Invalid assignment result ledger ${file}`);
    return value;
  }
  async function save(value: Ledger) {
    if (!file) { memory = value; return; }
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeAtomic(file, JSON.stringify(value) + '\n');
    // The marker survives a lost ledger; registration must never silently reset ownership.
    await writeFile(marker!, '1\n', { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  }
  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run);
    queue = result.then(() => {}, () => {});
    return result;
  }
  return {
    register(directory: string) { return serialize(async () => {
      const value = await load(true);
      if (!value.workspaces.includes(directory)) value.workspaces.push(directory);
      await save(value);
    }); },
    put(entry: AssignmentResultOwner) { return serialize(async () => {
      // Initial assignment activity can establish the index, but never certify old workspaces.
      const value = await load(true);
      value.results = [...value.results.filter(existing => existing.assignmentId !== entry.assignmentId), entry];
      await save(value);
    }); },
    remove(assignmentId: string) { return serialize(async () => {
      const value = await load();
      value.results = value.results.filter(entry => entry.assignmentId !== assignmentId);
      await save(value);
    }); },
    inspect() { return serialize(() => load()); },
  };
}
