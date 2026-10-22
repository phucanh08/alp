import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { replaceFile } from './lock.js';
import { RpcError } from './rpc-error.js';

/**
 * The lifecycle journal (docs/protocol/alp-json-rpc-v1.md §12.7): one record per mutation of a session's
 * native conversation (fork, rewind; later reload and live configure), keyed by resource, operation and
 * the client's requestId. A mutation crosses the native runtime and alpd's own files, which no rename
 * makes atomic, so it is journaled before the native step and replayed from the journal:
 *
 *   prepared  → written before the native step; nothing native happened yet, or it is in flight.
 *   applied   → the native step answered; `native` holds what it made. alpd's own commit may follow.
 *   committed → alpd's commit is on disk; `result` answers every repeat of the request.
 *   failed    → the native runtime refused it for certain; `error` answers every repeat.
 *   unknown   → the native runtime may or may not have acted (a crash or a lost answer after prepared).
 *
 * A start of alpd turns `prepared` into `unknown` (never sends the native step again) and rolls `applied`
 * forward with the operation's commit, which must therefore be idempotent. Refusals before `prepared`
 * (validation, busy, stale) record nothing, so the same requestId may be tried again. As the rest of
 * alpd's store, a resolved write survives a crash of alpd, not a power loss (no fsync).
 */

export type LifecycleState = 'prepared' | 'applied' | 'committed' | 'failed' | 'unknown';

export type LifecycleEntry<Plan = any, Native = any, Result = any> = {
  version: 1;
  key: string;
  /** The resource the operation changes or reads: a root session id. */
  resource: string;
  operation: string;
  requestId: string;
  /** A digest of the request; another payload under the same requestId is a conflict. */
  fingerprint: string;
  state: LifecycleState;
  /** What prepare decided; everything commit needs, so a restart can roll the operation forward. */
  plan: Plan;
  native?: Native;
  result?: Result;
  error?: { code: number; message: string; data?: unknown };
  createdAt: string;
  updatedAt: string;
};

/** Terminal entries are kept this long after their last write, as prompt receipts are (§10). */
export const LIFECYCLE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

const keyOf = (resource: string, operation: string, requestId: string) =>
  createHash('sha256').update(JSON.stringify(['lifecycle', resource, operation, requestId])).digest('hex');

export type LifecycleJournal = ReturnType<typeof createLifecycleJournal>;

export function createLifecycleJournal(directory: string) {
  const writes = new Map<string, Promise<void>>();
  let ready: Promise<void> | undefined;
  const prepare = () => ready ??= mkdir(directory, { recursive: true, mode: 0o700 }).then(() => {}, error => { ready = undefined; throw error; });
  const file = (key: string) => path.join(directory, `${key}.json`);

  async function read(name: string): Promise<LifecycleEntry | undefined> {
    let text: string;
    try { text = await readFile(path.join(directory, name), 'utf8'); }
    catch (error: any) { if (error?.code === 'ENOENT') return undefined; throw error; }
    const entry = JSON.parse(text);
    if (entry?.version !== 1 || typeof entry.key !== 'string' || typeof entry.state !== 'string') throw new Error(`unreadable lifecycle entry ${name}`);
    return entry;
  }

  return {
    keyOf,
    async get(resource: string, operation: string, requestId: string): Promise<LifecycleEntry | undefined> {
      const key = keyOf(resource, operation, requestId);
      await writes.get(key);
      await prepare();
      return read(`${key}.json`);
    },
    /** Writes an entry atomically; writes of one key never land out of order. */
    put(entry: LifecycleEntry) {
      const body = JSON.stringify({ ...entry, updatedAt: new Date().toISOString() });
      const next = (writes.get(entry.key) ?? Promise.resolve()).catch(() => {}).then(prepare).then(async () => {
        const temporary = `${file(entry.key)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
        try {
          await writeFile(temporary, body, { mode: 0o600 });
          await replaceFile(temporary, file(entry.key));
        } catch (error) {
          await rm(temporary, { force: true }).catch(() => {});
          throw error;
        }
      });
      writes.set(entry.key, next);
      void next.finally(() => { if (writes.get(entry.key) === next) writes.delete(entry.key); }).catch(() => {});
      return next;
    },
    /** Every readable entry; an unreadable one is skipped (and named), never deleted. */
    async list(onUnreadable?: (name: string, error: unknown) => void): Promise<LifecycleEntry[]> {
      await prepare();
      const entries: LifecycleEntry[] = [];
      for (const name of await readdir(directory)) {
        if (!name.endsWith('.json')) continue;
        try { const entry = await read(name); if (entry) entries.push(entry); }
        catch (error) { onUnreadable?.(name, error); }
      }
      return entries;
    },
    /** Removes terminal entries not written for `maxAgeMs`, and temporary files a crash left (only at start). */
    async prune(maxAgeMs = LIFECYCLE_RETENTION_MS, { temporaries = false } = {}) {
      await prepare();
      const now = Date.now();
      for (const name of await readdir(directory)) {
        const target = path.join(directory, name);
        if (name.endsWith('.tmp')) { if (temporaries) await rm(target, { force: true }); continue; }
        if (!name.endsWith('.json')) continue;
        const entry = await read(name).catch(() => undefined);
        if (!entry || !['committed', 'failed', 'unknown'].includes(entry.state)) continue;
        const info = await stat(target).catch(() => undefined);
        if (info && now - info.mtimeMs > maxAgeMs) await rm(target, { force: true });
      }
    },
    async flush() { await Promise.all([...writes.values()].map(write => write.catch(() => {}))); },
  };
}

/** A failure the journal keeps as the answer of every repeat: its code, message and data. */
const answerOf = (error: unknown): { code: number; message: string; data?: unknown } =>
  error instanceof RpcError ? { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) }
    : { code: 1000, message: error instanceof Error ? error.message : String(error) };

export const outcomeUnknown = (operation: string, requestId: string) =>
  new RpcError(1004, `alpd cannot tell whether ${operation} ${requestId} reached the runtime; check the session, then try again with a new requestId`, { reason: 'outcome_unknown' });

export type LifecycleSteps<Plan, Native, Result> = {
  /** Validates and decides; may refuse (nothing is recorded). Runs inside the resource's queue. */
  prepare(): Promise<Plan>;
  /** The native step; a thrown error with `outcomeUnknown: true` records unknown, any other records failed. */
  apply(plan: Plan): Promise<Native>;
  /** alpd's own, idempotent commit from the entry alone (a restart replays it). */
  commit(entry: LifecycleEntry<Plan, Native, Result>): Promise<Result>;
  /** How a repeat answers from a committed entry (e.g. with a fresh session summary). */
  repeat?(entry: LifecycleEntry<Plan, Native, Result>): Result | Promise<Result>;
};

/**
 * Runs journaled operations: one at a time per resource, at most once per (resource, operation,
 * requestId). The seam later lifecycle operations (live configure, reload) reuse with their own steps.
 */
export function createLifecycle(journal: LifecycleJournal, { crashPoint = (_name: string) => {} }: { crashPoint?: (name: string) => void } = {}) {
  const queues = new Map<string, Promise<unknown>>();
  const inflight = new Map<string, Promise<unknown>>();

  /** Runs `work` after every earlier operation of `resource` settled. */
  function serial<T>(resource: string, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(resource) ?? Promise.resolve()).catch(() => {}).then(work);
    queues.set(resource, run);
    void run.finally(() => { if (queues.get(resource) === run) queues.delete(resource); }).catch(() => {});
    return run;
  }

  async function run<Plan, Native, Result>(
    request: { resource: string; operation: string; requestId: string; fingerprint: string },
    steps: LifecycleSteps<Plan, Native, Result>,
  ): Promise<{ result: Result; duplicate: boolean; entry: LifecycleEntry<Plan, Native, Result> }> {
    const key = journal.keyOf(request.resource, request.operation, request.requestId);
    const earlier = inflight.get(key);
    if (earlier) await earlier.catch(() => {});
    const attempt = serial(request.resource, async () => {
      let entry: LifecycleEntry<Plan, Native, Result> | undefined;
      try { entry = await journal.get(request.resource, request.operation, request.requestId); }
      catch (error) { throw new RpcError(1000, `alpd cannot read the journal of ${request.operation} ${request.requestId}`, { reason: 'persistence_failed' }); }
      if (entry) {
        if (entry.fingerprint !== request.fingerprint) throw new RpcError(1004, `${request.operation} ${request.requestId} was already requested with other parameters`, { reason: 'key_conflict' });
        if (entry.state === 'committed') return { result: steps.repeat ? await steps.repeat(entry) : entry.result as Result, duplicate: true, entry };
        if (entry.state === 'failed') throw new RpcError(entry.error?.code ?? 1000, entry.error?.message ?? `${request.operation} failed`, entry.error?.data);
        // A commit that failed earlier finishes now; this is its first answer.
        if (entry.state === 'applied') { const done = await commit(entry, steps); return { result: done.result as Result, duplicate: false, entry: done }; }
        throw outcomeUnknown(request.operation, request.requestId);
      }
      const plan = await steps.prepare();
      const now = new Date().toISOString();
      entry = { version: 1, key, ...request, state: 'prepared', plan, createdAt: now, updatedAt: now };
      try { await journal.put(entry); }
      catch (error) { throw new RpcError(1000, `alpd could not record ${request.operation} ${request.requestId}; nothing was changed`, { reason: 'persistence_failed' }); }
      crashPoint(`${request.operation}.after-prepared`);
      let native: Native;
      try {
        native = await steps.apply(plan);
      } catch (error: any) {
        const unknown = error?.outcomeUnknown === true;
        entry = { ...entry, state: unknown ? 'unknown' : 'failed', ...(unknown ? {} : { error: answerOf(error) }) };
        await journal.put(entry).catch(() => {});
        if (unknown) throw outcomeUnknown(request.operation, request.requestId);
        throw error;
      }
      entry = { ...entry, state: 'applied', native };
      try { await journal.put(entry); }
      catch {
        // The native step happened but its record did not: what a repeat finds is `prepared`, answered unknown.
        throw outcomeUnknown(request.operation, request.requestId);
      }
      crashPoint(`${request.operation}.after-applied`);
      const done = await commit(entry, steps);
      return { result: done.result as Result, duplicate: false, entry: done };
    });
    inflight.set(key, attempt);
    void attempt.finally(() => { if (inflight.get(key) === attempt) inflight.delete(key); }).catch(() => {});
    return attempt;
  }

  async function commit<Plan, Native, Result>(entry: LifecycleEntry<Plan, Native, Result>, steps: Pick<LifecycleSteps<Plan, Native, Result>, 'commit'>) {
    let result: Result;
    try { result = await steps.commit(entry); }
    catch (error) {
      if (error instanceof RpcError) throw error;
      throw new RpcError(1000, `alpd could not finish ${entry.operation} ${entry.requestId}; it finishes when tried again or when alpd starts`, { reason: 'persistence_failed' });
    }
    crashPoint(`${entry.operation}.before-committed`);
    const done = { ...entry, state: 'committed' as const, result };
    await journal.put(done).catch(() => {});
    crashPoint(`${entry.operation}.after-committed`);
    return done;
  }

  return {
    run,
    serial,
    /**
     * At start, before any request: `prepared` becomes `unknown` (the native step is never sent again),
     * `applied` rolls forward through the operation's commit (left `applied` when that fails, to be
     * finished by a repeat or the next start; such entries are answered).
     */
    async recover(commits: Record<string, (entry: LifecycleEntry) => Promise<unknown>>, log?: (message: string, fields: Record<string, unknown>) => void) {
      const entries = await journal.list((name, error) => log?.(`unreadable lifecycle entry ${name}`, { error }));
      const unfinished: LifecycleEntry[] = [];
      for (const entry of entries) {
        if (entry.state === 'prepared') {
          await journal.put({ ...entry, state: 'unknown' }).catch(() => {});
          log?.(`${entry.operation} ${entry.requestId} of ${entry.resource} may or may not have reached the runtime`, { code: 'ALPD_LIFECYCLE_UNKNOWN', operation: entry.operation, resource: entry.resource });
        } else if (entry.state === 'applied') {
          const committer = commits[entry.operation];
          if (!committer) continue;
          await serial(entry.resource, () => commit(entry, { commit: committer })).catch(error => {
            unfinished.push(entry);
            log?.(`could not finish ${entry.operation} ${entry.requestId} of ${entry.resource}`, { code: 'ALPD_LIFECYCLE_ROLLFORWARD_FAILED', error });
          });
        }
      }
      /** Entries still applied: their resources wait for a repeat to finish them. */
      return unfinished;
    },
  };
}
