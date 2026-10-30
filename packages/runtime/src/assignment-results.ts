import { readFile, readdir, mkdir, writeFile, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '@anhlp/alp-core/atomic';

/** What a finished writer outside a worktree left in its checkout, kept until its requester handles it (recall entries expire, this does not). */
export type AssignmentResultEvidence = { agent: string; status: string; finishedAt: string; project: string; requesters: string[]; taskId?: string; brief: string; summary: string };
export const RESULT_OUTCOMES = ['applied', 'discarded', 'acknowledged'] as const;
export type AssignmentResultHandling = { outcome: typeof RESULT_OUTCOMES[number]; by: string; at: string; note?: string };
/** No `handled`: produced (or still running), and the removal guard refuses its paths. `handled`: the guard lets them go; archiving removes it from the ledger. */
export type AssignmentResultOwner = { assignmentId: string; checkout: string; worktree?: string; result?: AssignmentResultEvidence; handled?: AssignmentResultHandling };
export type ArchivedAssignmentResult = AssignmentResultOwner & { handled: AssignmentResultHandling; archivedAt: string };
type Ledger = { version: 1; workspaces: string[]; results: AssignmentResultOwner[] };
/** Archived results stay this long after the month they were archived in ends; ledger entries never expire. */
export const ARCHIVE_KEEP_MS = 365 * 24 * 60 * 60 * 1000;
const empty = (): Ledger => ({ version: 1, workspaces: [], results: [] });
const absolute = (value: unknown): value is string => typeof value === 'string' && path.isAbsolute(value);
const text = (value: unknown): value is string => typeof value === 'string';
const evidence = (value: any) => value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value) &&
  [value.agent, value.status, value.finishedAt, value.project, value.brief, value.summary].every(text) &&
  Array.isArray(value.requesters) && value.requesters.every(text) && (value.taskId === undefined || text(value.taskId)));
const handling = (value: any) => value === undefined || (!!value && typeof value === 'object' && !Array.isArray(value) &&
  RESULT_OUTCOMES.includes(value.outcome) && text(value.by) && text(value.at) && (value.note === undefined || text(value.note)));
const valid = (value: any): value is Ledger => value?.version === 1 && Array.isArray(value.workspaces) && value.workspaces.every(absolute) &&
  Array.isArray(value.results) && value.results.every((entry: any) => entry && typeof entry.assignmentId === 'string' && absolute(entry.checkout) && (entry.worktree === undefined || absolute(entry.worktree)) &&
    evidence(entry.result) && handling(entry.handled));
const MONTH = /^(\d{4})-(\d{2})\.jsonl$/;

/** Permanent ownership, independent of native-thread recall expiry. Missing initialized data is never recreated. */
export function createAssignmentResults(file?: string) {
  let memory = empty();
  let archivedInMemory: ArchivedAssignmentResult[] = [];
  let queue = Promise.resolve();
  const marker = file ? `${file}.initialized` : undefined;
  // One JSON line per handled result, in a file per month of archiving.
  const archiveDir = file ? path.join(path.dirname(file), 'assignment-archive') : undefined;
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
  /** Appends a record and syncs it before its ledger entry may go; a crash in between archives it again, never loses it. */
  async function append(record: ArchivedAssignmentResult) {
    if (!archiveDir) { archivedInMemory.push(record); return; }
    await mkdir(archiveDir, { recursive: true, mode: 0o700 });
    const handle = await open(path.join(archiveDir, `${record.archivedAt.slice(0, 7)}.jsonl`), 'a+', 0o600);
    try {
      const { size } = await handle.stat();
      const last = Buffer.alloc(1);
      // A line cut short by a crash must not swallow the next record.
      const torn = size > 0 && (await handle.read(last, 0, 1, size - 1)).bytesRead === 1 && last[0] !== 0x0a;
      await handle.appendFile(`${torn ? '\n' : ''}${JSON.stringify(record)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
  }
  async function archived(): Promise<ArchivedAssignmentResult[]> {
    if (!archiveDir) return archivedInMemory;
    let names: string[];
    try { names = (await readdir(archiveDir)).filter(name => MONTH.test(name)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    const records: ArchivedAssignmentResult[] = [];
    for (const name of names) {
      for (const line of (await readFile(path.join(archiveDir, name), 'utf8')).split('\n')) {
        try { const record = JSON.parse(line); if (typeof record?.assignmentId === 'string') records.push(record); } catch {}
      }
    }
    return records;
  }
  /** Deletes the archive months that ended more than ARCHIVE_KEEP_MS ago. */
  async function prune(now: number) {
    if (!archiveDir) { archivedInMemory = archivedInMemory.filter(record => now - Date.parse(record.archivedAt) < ARCHIVE_KEEP_MS); return; }
    for (const name of await readdir(archiveDir).catch(() => [] as string[])) {
      const month = MONTH.exec(name);
      if (month && now - Date.UTC(Number(month[1]), Number(month[2])) > ARCHIVE_KEEP_MS) await rm(path.join(archiveDir, name), { force: true });
    }
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
    /**
     * Records how a produced result was handled, then archives every handled entry and drops it from the ledger.
     * The mark is saved first: from then on the guard lets the checkout go, while the ledger still holds the evidence.
     */
    resolve(assignmentId: string, handled: AssignmentResultHandling) { return serialize(async () => {
      if (!handling(handled)) throw new Error('Invalid result handling');
      const value = await load();
      const entry = value.results.find(owner => owner.assignmentId === assignmentId);
      if (!entry) throw new Error(`No retained assignment result ${assignmentId}`);
      if (!entry.handled) {
        entry.handled = handled;
        await save(value);
      }
      const now = Date.now();
      const records: ArchivedAssignmentResult[] = [];
      for (const owner of value.results) {
        if (!owner.handled) continue;
        const record = { ...owner, handled: owner.handled, archivedAt: new Date(now).toISOString() };
        await append(record);
        records.push(record);
      }
      value.results = value.results.filter(owner => !owner.handled);
      await save(value);
      await prune(now).catch(() => {});
      return records.find(record => record.assignmentId === assignmentId)!;
    }); },
    /** The newest archived record of an assignment, if its archive month is still kept. */
    archived(assignmentId: string) { return serialize(async () => (await archived()).filter(record => record.assignmentId === assignmentId).at(-1)); },
    inspect() { return serialize(() => load()); },
  };
}
