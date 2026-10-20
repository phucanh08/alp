import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeAtomic } from '@anhlp/alp-core/atomic';
import { createLogger } from '@anhlp/alp-core/log';
import type { ScheduleJob, ScheduleStatus } from '@anhlp/alp-protocol/index';

/**
 * alpd's scheduled continuations: one JSON file per job under
 * `$ALP_HOME/schedules`, written atomically. The directory is its own, beside the
 * state directory and not inside it: the state has a schema version of its own
 * (packages/core/src/state-schema.js), and a job is not part of that state, so an
 * ALP that does not know jobs keeps working beside one that does.
 *
 * A job is one-shot: it waits for its time, is delivered once, and then says what
 * became of it. Nothing here delivers anything; the daemon's scheduler does that.
 */

const log = createLogger({ component: 'alpd.schedule' });

/** The version of a job file; a file of another version is not read. */
export const SCHEDULE_VERSION = 1;
/** The id of a job: `sch_` and sixteen hex digits. */
export const SCHEDULE_ID = /^sch_[0-9a-f]{16}$/;
/** The most a job's prompt may hold, in characters. */
export const PROMPT_CHARS = 8000;

const STATUSES: ScheduleStatus[] = ['pending', 'delivered', 'failed', 'cancelled'];

export type ScheduleStore = ReturnType<typeof createScheduleStore>;

/**
 * The key a project is compared by: the directory it really names. A client that names
 * the same directory in another spelling (a trailing slash, a doubled separator, a
 * symlinked parent, a different case on a case-insensitive volume) must see the same
 * jobs; the job of a project is the job of that directory.
 */
export function projectKey(root: string): string {
  const resolved = path.resolve(root);
  // A path that is not there is compared as it was named: there is nothing to resolve.
  try { return realpathSync.native(resolved); }
  catch { return resolved; }
}

/**
 * The project a request names: an absolute path, or nothing. A relative path would be
 * read against the daemon's own directory, which is another project, so it is refused
 * here as well as in the daemon.
 */
function namedProject(root?: string): string | undefined {
  if (root === undefined) return undefined;
  if (!path.isAbsolute(root)) throw new ScheduleStoreError('INVALID_SCHEDULE', 'A project is named by its absolute path');
  return root;
}

/** A refusal of the job store: what it refused, and why. */
export class ScheduleStoreError extends Error {
  constructor(public code: 'INVALID_SCHEDULE' | 'SCHEDULE_NOT_FOUND' | 'SCHEDULE_NOT_PENDING', message: string) {
    super(message);
    this.name = 'ScheduleStoreError';
  }
}

/** A job as it is written and read back: the wire shape, and nothing else. */
export type ScheduleRecord = ScheduleJob;

const isStatus = (value: unknown): value is ScheduleStatus => typeof value === 'string' && (STATUSES as string[]).includes(value);

/** A job file that is not a job: it is skipped, and the reason is logged. */
function readJob(text: string, name: string): ScheduleRecord | undefined {
  let record: any;
  try { record = JSON.parse(text); } catch {
    log.warn(`skipped unreadable job ${name}`, { code: 'ALP_SCHEDULE_UNREADABLE', file: name });
    return undefined;
  }
  /** A time of the job, as the wire type writes it. */
  const isTime = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
  /** The time a job is due: the contract writes it as UTC, ISO 8601, and so does the store. */
  const isDueAt = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
  const isError = (value: unknown) => typeof value === 'object' && value !== null
    && typeof (value as any).message === 'string'
    && ((value as any).code === undefined || typeof (value as any).code === 'string');
  const sound = record?.version === SCHEDULE_VERSION
    && typeof record.id === 'string' && SCHEDULE_ID.test(record.id)
    && name === `${record.id}.json`
    && isStatus(record.status)
    && typeof record.projectRoot === 'string' && record.projectRoot
    && typeof record.sessionId === 'string' && record.sessionId
    && typeof record.prompt === 'string'
    && isDueAt(record.dueAt)
    && isTime(record.createdAt) && isTime(record.updatedAt)
    && (record.attemptedAt === undefined || isTime(record.attemptedAt))
    && (record.deliveredAt === undefined || isTime(record.deliveredAt))
    && (record.failedAt === undefined || isTime(record.failedAt))
    && (record.cancelledAt === undefined || isTime(record.cancelledAt))
    && (record.lateByMs === undefined || (Number.isSafeInteger(record.lateByMs) && record.lateByMs >= 0))
    && (record.attempts === undefined || (Number.isSafeInteger(record.attempts) && record.attempts >= 0))
    && (record.lastError === undefined || isError(record.lastError));
  if (!sound) {
    log.warn(`skipped invalid job ${name}`, { code: 'ALP_SCHEDULE_UNREADABLE', file: name });
    return undefined;
  }
  // Only the fields the wire type knows cross to it; a file with more is still a job.
  return {
    id: record.id,
    projectRoot: record.projectRoot,
    sessionId: record.sessionId,
    prompt: record.prompt,
    dueAt: record.dueAt,
    status: record.status,
    attempts: Number.isSafeInteger(record.attempts) ? record.attempts : 0,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(record.attemptedAt === undefined ? {} : { attemptedAt: record.attemptedAt }),
    ...(record.deliveredAt === undefined ? {} : { deliveredAt: record.deliveredAt }),
    ...(record.failedAt === undefined ? {} : { failedAt: record.failedAt }),
    ...(record.cancelledAt === undefined ? {} : { cancelledAt: record.cancelledAt }),
    ...(record.lateByMs === undefined ? {} : { lateByMs: record.lateByMs }),
    ...(record.lastError === undefined ? {} : { lastError: { message: record.lastError.message, ...(record.lastError.code === undefined ? {} : { code: record.lastError.code }) } }),
  };
}

/** A job without the empty fields a later step cleared. */
function without<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

export function createScheduleStore(root: string, { now = () => Date.now() } = {}) {
  const directory = root;
  let ready: Promise<void> | undefined;
  const prepare = () => ready ??= mkdir(directory, { recursive: true, mode: 0o700 }).then(() => {}, error => { ready = undefined; throw error; });
  /** alpd's writes to the job files go one at a time, so a later write never lands before an earlier one. */
  let writes: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = writes.catch(() => {}).then(work);
    writes = run;
    return run;
  };
  const fileOf = (id: string) => path.join(directory, `${id}.json`);
  /** The file of a job, when the id names one; nothing else is ever read or written. */
  const fileOfSafe = (id: string) => (typeof id === 'string' && SCHEDULE_ID.test(id) ? fileOf(id) : undefined);
  /** Writes a job file now; the caller holds the store's lock when it needs one. */
  const writeNow = async (job: ScheduleRecord) => {
    await prepare();
    // The project is written the one way it is compared, whatever the caller did:
    // every write of a job carries the canonical path, and a relative one is refused
    // here as well, so no writer can slip a project past the rule.
    if (!path.isAbsolute(job.projectRoot)) throw new ScheduleStoreError('INVALID_SCHEDULE', 'A project is named by its absolute path');
    const canonical = { ...job, projectRoot: projectKey(job.projectRoot) };
    await writeAtomic(fileOf(job.id), `${JSON.stringify({ version: SCHEDULE_VERSION, ...canonical })}\n`);
    return canonical;
  };
  const write = (job: ScheduleRecord) => serial(() => writeNow(job));
  const stamp = () => new Date(now()).toISOString();

  return {
    /** The directory the jobs live in. */
    directory() { return directory; },

    /**
     * A new job waiting for its time. The id is drawn here, so two jobs never
     * share one and a job's own id names its delivery.
     */
    async create({ projectRoot, sessionId, prompt, dueAt }: { projectRoot: string; sessionId: string; prompt: string; dueAt: string }): Promise<ScheduleRecord> {
      if (typeof projectRoot !== 'string' || !projectRoot) throw new ScheduleStoreError('INVALID_SCHEDULE', 'A job needs the project it continues');
      // A project is named by its absolute path: a relative one would be read against
      // the daemon's own directory, which is another project.
      if (!path.isAbsolute(projectRoot)) throw new ScheduleStoreError('INVALID_SCHEDULE', 'A job needs the absolute path of the project it continues');
      if (typeof sessionId !== 'string' || !sessionId) throw new ScheduleStoreError('INVALID_SCHEDULE', 'A job needs the session it continues');
      if (typeof prompt !== 'string' || !prompt.trim()) throw new ScheduleStoreError('INVALID_SCHEDULE', 'A job needs a prompt');
      // The count is in code points, as the v1 contract counts them (packages/protocol/src/validate.js).
      if ([...prompt].length > PROMPT_CHARS) throw new ScheduleStoreError('INVALID_SCHEDULE', `A job's prompt is at most ${PROMPT_CHARS} characters`);
      const due = new Date(dueAt);
      if (Number.isNaN(due.getTime())) throw new ScheduleStoreError('INVALID_SCHEDULE', 'A job needs the time it is due, as a timestamp');
      const id = `sch_${randomBytes(8).toString('hex')}`;
      const at = stamp();
      return write({
        id,
        projectRoot,
        sessionId,
        prompt,
        dueAt: due.toISOString(),
        status: 'pending',
        attempts: 0,
        createdAt: at,
        updatedAt: at,
      });
    },

    /** The job of that id, or undefined when there is none. */
    async get(id: string, { projectRoot }: { projectRoot?: string } = {}): Promise<ScheduleRecord | undefined> {
      const wanted = namedProject(projectRoot);
      const file = fileOfSafe(id);
      if (!file) return undefined;
      await prepare();
      let text: string;
      try { text = await readFile(file, 'utf8'); }
      catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error; }
      const job = readJob(text, `${id}.json`);
      // The project is the boundary, here as well as in the daemon: a job of another
      // project is not there for this one.
      if (job && wanted !== undefined && projectKey(job.projectRoot) !== projectKey(wanted)) return undefined;
      return job;
    },

    /** The jobs of one project, oldest first by the time they are due. */
    async list({ projectRoot, status }: { projectRoot: string; status?: ScheduleStatus }): Promise<ScheduleRecord[]> {
      await prepare();
      // The project is not optional here: the store keeps the boundary itself, and a
      // caller that wants the jobs of every project says so with all().
      const wanted = namedProject(projectRoot);
      // The status is one of the four the protocol names: an unknown one is refused,
      // not an empty answer.
      if (status !== undefined && !isStatus(status)) throw new ScheduleStoreError('INVALID_SCHEDULE', `Unknown job status ${String(status)}`);
      const key = projectKey(wanted!);
      const jobs: ScheduleRecord[] = [];
      for (const name of await readdir(directory).catch(error => { if (error?.code === 'ENOENT') return [] as string[]; throw error; })) {
        if (!name.endsWith('.json')) continue;
        let job: ScheduleRecord | undefined;
        try { job = readJob(await readFile(path.join(directory, name), 'utf8'), name); } catch { continue; }
        if (!job) continue;
        if (projectKey(job.projectRoot) !== key) continue;
        if (status !== undefined && job.status !== status) continue;
        jobs.push(job);
      }
      return jobs.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
    },

    /**
     * Every job of the host, of every project. Only the daemon's own tick reads them
     * all; a client reads the jobs of its own project (list).
     */
    async all({ status }: { status?: ScheduleStatus } = {}): Promise<ScheduleRecord[]> {
      await prepare();
      if (status !== undefined && !isStatus(status)) throw new ScheduleStoreError('INVALID_SCHEDULE', `Unknown job status ${String(status)}`);
      const jobs: ScheduleRecord[] = [];
      for (const name of await readdir(directory).catch(error => { if (error?.code === 'ENOENT') return [] as string[]; throw error; })) {
        if (!name.endsWith('.json')) continue;
        let job: ScheduleRecord | undefined;
        try { job = readJob(await readFile(path.join(directory, name), 'utf8'), name); } catch { continue; }
        if (!job) continue;
        if (status !== undefined && job.status !== status) continue;
        jobs.push(job);
      }
      return jobs.sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt) || a.id.localeCompare(b.id));
    },

    /** The jobs that are due at that time and still wait. */
    async due(at: number): Promise<ScheduleRecord[]> {
      const jobs = await this.all({ status: 'pending' });
      return jobs.filter(job => Date.parse(job.dueAt) <= at);
    },

    /**
     * Changes the fields of a job under the store's own lock: the job is read and
     * written in one step, so a change made elsewhere in between (a cancel) is not
     * overwritten. The change is skipped when it returns nothing, and nothing is
     * written then; undefined says the change was not made.
     */
    async change(id: string, change: (job: ScheduleRecord) => Partial<ScheduleRecord> | undefined): Promise<ScheduleRecord | undefined> {
      return serial(async () => {
        const job = await this.get(id);
        if (!job) return undefined;
        const patch = change(job);
        if (!patch) return undefined;
        const merged = { ...job, ...patch };
        return writeNow({ ...merged, updatedAt: stamp() });
      });
    },

    /** A job that will not run: cancelled before its time. */
    async cancel(id: string, { projectRoot }: { projectRoot?: string } = {}): Promise<ScheduleRecord> {
      return serial(async () => {
        // The project is the boundary here as well: a job of another project is not
        // cancelled by a client of this one.
        const job = await this.get(id, { projectRoot });
        if (!job) throw new ScheduleStoreError('SCHEDULE_NOT_FOUND', `No scheduled job ${id}`);
        if (job.status !== 'pending') throw new ScheduleStoreError('SCHEDULE_NOT_PENDING', `Job ${id} is already ${job.status}`);
        return writeNow(without({ ...job, status: 'cancelled' as ScheduleStatus, cancelledAt: stamp(), lastError: undefined }));
      });
    },

    /** Removes a job file outright; a job that is not there is not an error. */
    async remove(id: string): Promise<void> {
      const file = fileOfSafe(id);
      if (!file) return;
      await serial(async () => {
        await prepare();
        await rm(file, { force: true });
      });
    },
  };
}
