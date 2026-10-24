import { createLogger } from '@anhlp/alp-core/log';
import type { AlpRuntime } from '@anhlp/alp-runtime/index';
import type { PromptContent } from '@anhlp/alp-protocol/session';
import type { ScheduleJob } from '@anhlp/alp-protocol/index';
import type { ScheduleStore } from './schedules.js';
import { projectKey } from './schedules.js';

/**
 * The scheduler of alpd: a tick that finds the jobs whose time has come
 * and opens a turn on the session each of them names, without a user message.
 *
 * A job is delivered at most once. The daemon's prompt receipt is the guard: the
 * delivery of a job carries a clientMessageId of its own, so the receipt of that
 * message is what a retry after a crash reads. A job whose delivery the runtime
 * refused is failed with the reason; a job whose target session is gone is failed
 * too, never silently dropped.
 *
 * A job that comes due while its session is working waits for the turn to end
 * rather than steering it: the delivery is 'auto', so it queues behind the running
 * turn. Waiting is bounded; past the grace period the job fails and says why.
 */

const log = createLogger({ component: 'alpd.schedule' });

/** How long a job waits for a busy session before it fails; an hour by default. */
export const SCHEDULE_GRACE_MS = 60 * 60 * 1000;
/** How often alpd looks for jobs whose time has come. */
export const SCHEDULE_TICK_MS = 10_000;
/** How long a delivery may take; a session that never answers does not hold the tick. */
export const DELIVERY_TIMEOUT_MS = 2 * 60 * 1000;

/** What the daemon's prompt path answered. */
export type ScheduleDelivery = { outcome: 'accepted' | 'failed' | 'unknown'; error?: { message: string; code?: string } };

export type Scheduler = ReturnType<typeof createScheduler>;

/** A delay in words: "45 seconds", "7 minutes", "1 hour 3 minutes". */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hour = `${hours} hour${hours === 1 ? '' : 's'}`;
  return rest ? `${hour} ${rest} minute${rest === 1 ? '' : 's'}` : hour;
}

/**
 * The text a job delivers: the continuation, and what the session needs to know
 * about it — that it was asked for, and how late it is. The text is a function of
 * the job alone, so a retry after a crash sends the very same words.
 */
export function renderPrompt(job: ScheduleJob): string {
  const due = new Date(job.dueAt).toISOString();
  const late = job.lateByMs && job.lateByMs > 0 ? ` and running ${duration(job.lateByMs)} late` : '';
  return `This is a scheduled continuation (job ${job.id}), due ${due}${late}.\nBefore delegating a quota-reset continuation, recheck actual provider availability using the fresh runtime usage snapshot. The scheduled time does not guarantee quota; unavailable or missing usage data is not proof of availability.\n\n${job.prompt}`;
}

/**
 * The id of the message a job delivers under. It is the job's own, so the receipt
 * of that message is what keeps the job from running twice: a retry after a crash
 * reads the receipt of the first delivery instead of sending again.
 */
export function clientMessageId(job: ScheduleJob): string {
  return `alp-job-${job.id}`;
}

export function createScheduler({ store, runtime, deliver, ready, session, settled, stopping, now = () => Date.now(), graceMs = SCHEDULE_GRACE_MS, deliveryTimeoutMs = DELIVERY_TIMEOUT_MS }: {
  /** The job files, in `$ALP_HOME/schedules`. */
  store: ScheduleStore;
  /** The runtime that holds the sessions a job continues. */
  runtime: AlpRuntime;
  /** The daemon's prompt path: a delivery of this job, by its own clientMessageId. */
  deliver: (job: ScheduleJob, content: PromptContent, clientMessageId: string, send?: AlpRuntime['prompt']) => Promise<ScheduleDelivery>;
  /** The daemon's own start-up; a job waits for it, so a reopened session is ready. */
  ready?: () => Promise<unknown>;
  /**
   * What the daemon knows about the session of a job that the runtime does not show:
   * that it is being opened again, or that it could not be opened. A session that is
   * being opened is not closed: the job waits for it.
   */
  session?: (sessionId: string) => { opening?: boolean; error?: { message: string; code?: string } } | undefined;
  /**
   * Called when a job of that session waits for nothing any more. The daemon may keep
   * something for that job alone (the reason its session could not be opened again);
   * it is told the job is through, so it can drop it.
   */
  settled?: (sessionId: string) => void;
  /** Whether the daemon is stopping; a job is not failed because alpd is going away. */
  stopping?: () => boolean;
  now?: () => number;
  graceMs?: number;
  /** How long a delivery may take before the job is failed for it. */
  deliveryTimeoutMs?: number;
}) {
  /** The jobs that wait, by the session they continue. */
  const waiting = new Map<string, Set<string>>();
  /** Every job that waits, with the moment its wait began. */
  const held = new Map<string, { sessionId: string; at: number }>();
  /** The jobs that wait for a session to be opened again, with the moment the wait began. */
  const opening = new Map<string, number>();
  /** The sessions a job is being created for: they are held before the job is written. */
  const heldSessions = new Map<string, number>();
  /** The jobs being delivered right now; a cancel that arrives is refused. */
  const delivering = new Set<string>();
  /** Jobs whose final state could not be written; they are not tried again in this process. */
  const unwritten = new Set<string>();
  let sequence = 0;
  let ticking = false;
  /** The tick that runs now, so a stop can wait for it. */
  let running: ReturnType<typeof runTick> | undefined;
  let timer: NodeJS.Timeout | undefined;

  const hold = (job: ScheduleJob) => {
    if (!held.has(job.id)) held.set(job.id, { sessionId: job.sessionId, at: ++sequence });
    const ids = waiting.get(job.sessionId) ?? new Set<string>();
    ids.add(job.id);
    waiting.set(job.sessionId, ids);
  };
  const releaseId = (id: string) => {
    const entry = held.get(id);
    opening.delete(id);
    if (!entry) return;
    held.delete(id);
    const ids = waiting.get(entry.sessionId);
    if (!ids) return;
    ids.delete(id);
    if (!ids.size) waiting.delete(entry.sessionId);
  };
  /**
   * A job that waits for nothing any more. The daemon is told the job is through, so
   * what it kept for that job alone (the reason its session could not be opened again)
   * can be dropped.
   */
  const release = (job: ScheduleJob) => {
    releaseId(job.id);
    settled?.(job.sessionId);
  };

  /**
   * Reads the job files again, so the waits are what the files say. A wait that
   * began before the files were read and whose job no longer waits is released; a
   * wait that began while they were read (a job just created) is kept.
   */
  async function refresh(): Promise<void> {
    const at = sequence;
    const jobs = await store.all({ status: 'pending' });
    const pending = new Set(jobs.filter(job => !unwritten.has(job.id)).map(job => job.id));
    for (const job of jobs) if (!unwritten.has(job.id)) hold(job);
    for (const [id, entry] of [...held]) {
      if (entry.at > at || pending.has(id)) continue;
      releaseId(id);
      // The job is gone: nothing waits for that session any more.
      settled?.(entry.sessionId);
    }
  }

  /** A job that failed: the reason is kept, so nobody waits for a job that never ran. */
  async function fail(job: ScheduleJob, message: string, code?: string): Promise<'failed'> {
    const at = new Date(now()).toISOString();
    const reason = { message, ...(code ? { code } : {}) };
    // The final state is written under the store's own lock, and only onto a job that
    // still waits: a cancel that landed meanwhile is not overwritten.
    const saved = await store.change(job.id, current => current.status === 'pending' ? { status: 'failed' as const, failedAt: at, lastError: reason } : undefined)
      .catch(error => {
        // The file still says pending; the job is not tried again in this process.
        unwritten.add(job.id);
        log.warn(`could not record the failure of job ${job.id}; it stays pending on disk and is not tried again until the next alpd`, { code: 'ALP_SCHEDULE_WRITE_FAILED', jobId: job.id, error });
        return undefined;
      });
    if (!saved) {
      // The file still says pending, so the job waits for nothing in this process: it
      // is not tried again here, and the next alpd reads the file and finds it.
      release(job);
      log.warn(`job ${job.id} failed: ${message} (the job file was not changed)`, { code: 'ALP_SCHEDULE_FAILED', jobId: job.id, sessionId: job.sessionId, reason: code });
      return 'failed';
    }
    release(saved);
    log.warn(`job ${job.id} failed: ${message}`, { code: 'ALP_SCHEDULE_FAILED', jobId: job.id, sessionId: job.sessionId, reason: code });
    return 'failed';
  }

  /** A job that was delivered: the time it was delivered and how late it was. */
  async function done(job: ScheduleJob): Promise<'delivered'> {
    const at = new Date(now()).toISOString();
    // The final state is written under the store's own lock, and only onto a job that
    // still waits: a job file that is gone is not written again.
    const saved = await store.change(job.id, current => current.status === 'pending' ? { status: 'delivered' as const, deliveredAt: at, lastError: undefined } : undefined)
      .catch(error => {
        unwritten.add(job.id);
        log.warn(`could not record the delivery of job ${job.id}; it stays pending on disk and is not tried again until the next alpd`, { code: 'ALP_SCHEDULE_WRITE_FAILED', jobId: job.id, error });
        return undefined;
      });
    if (!saved) {
      // The file still says pending, so the job waits for nothing in this process: it
      // is not tried again here, and the next alpd reads the file and finds it.
      release(job);
      log.warn(`job ${job.id} was delivered, but its file was not changed`, { code: 'ALP_SCHEDULE_DELIVERED', jobId: job.id, sessionId: job.sessionId });
      return 'delivered';
    }
    release(saved);
    log.info(`job ${job.id} delivered to ${job.sessionId}${job.lateByMs ? ` (${duration(job.lateByMs)} late)` : ''}`, { code: 'ALP_SCHEDULE_DELIVERED', jobId: job.id, sessionId: job.sessionId });
    return 'delivered';
  }

  /**
   * Delivers one job. The target must be the live root session of the job's
   * project; a session that is gone, or is not a root, fails the job with the
   * reason rather than waking something else.
   */
  async function fire(job: ScheduleJob): Promise<'delivered' | 'failed' | 'waiting' | 'skipped'> {
    const current = await store.get(job.id);
    // A job that is not pending any more will not run: it waits for nothing.
    if (!current || current.status !== 'pending') { release(job); return 'skipped'; }
    // A daemon that is going away does not fail a job: the job waits for the next alpd.
    if (stopping?.()) return 'skipped';
    // A job whose final state could not be written is not tried again in this process,
    // and its session is not held for it either.
    if (unwritten.has(current.id)) { release(current); return 'skipped'; }
    /** The attempt as it was written, once it was: what a failure must keep. */
    let attempt: ScheduleJob | undefined;
    const snapshot = runtime.snapshot(current.sessionId);
    const known = session?.(current.sessionId);
    if (!snapshot) {
      // A session that is being opened again is not a closed one: the job waits for it.
      if (known?.opening) {
        // The wait is bounded from the moment it began: how late the job is says
        // nothing about how long the session takes to open again.
        const since = opening.get(current.id) ?? now();
        opening.set(current.id, since);
        const waited = now() - since;
        if (waited > graceMs) return fail(current, `The session was not open again within ${duration(waited)}`, 'session_not_open');
        const note = { message: 'The session is being opened again; the job waits for it', code: 'session_opening' };
        await store.change(current.id, job => job.status === 'pending' && job.lastError?.code !== note.code ? { lastError: note } : undefined)
          .catch(error => log.warn(`could not record the wait of job ${current.id}`, { code: 'ALP_SCHEDULE_WRITE_FAILED', jobId: current.id, error }));
        return 'waiting';
      }
      // A session that could not be opened again says why; the job fails with that reason.
      if (known?.error) return fail(current, known.error.message, known.error.code ?? 'session_open_failed');
      return fail(current, 'The session this job continues is closed', 'session_closed');
    }
    // The session is open: the wait for an opening is over, and the next opening gets
    // its own window.
    opening.delete(current.id);
    if (snapshot.parentId) return fail(current, 'The session this job continues is not a root session', 'not_a_root');
    if (projectKey(snapshot.projectRoot) !== projectKey(current.projectRoot)) return fail(current, 'The session this job continues belongs to another project', 'other_project');
    const waitBusy = async (): Promise<'waiting' | 'failed'> => {
      // The session is working. The job waits for the turn to end; it never steers it.
      const overdue = now() - Date.parse(current.dueAt);
      if (overdue > graceMs) return fail(current, `The session was still busy ${duration(overdue)} after the job was due`, 'session_busy');
      // Only the note is written, and only when it says something new: a cancel that
      // happened meanwhile is not overwritten, and the file is not rewritten every tick.
      const note = { message: 'The session is busy; the job waits for its turn to end', code: 'session_busy' };
      await store.change(current.id, job => job.status === 'pending' && job.lastError?.code !== note.code ? { lastError: note } : undefined)
        .catch(error => log.warn(`could not record the wait of job ${current.id}`, { code: 'ALP_SCHEDULE_WRITE_FAILED', jobId: current.id, error }));
      return 'waiting';
    };
    if (snapshot.activeTurnId || runtime.starting?.(current.sessionId)) return waitBusy();
    const dispatch = async (send?: AlpRuntime['prompt']): Promise<'delivered' | 'failed' | 'waiting' | 'skipped'> => {
      // From here the job is being delivered: a cancel that arrives now is refused, so
      // the job and the record cannot disagree about what happened.
      delivering.add(current.id);
      try {
        // The first attempt fixes when the job was tried and how late it is, and both are
        // written before the delivery: a retry after a crash sends the very same words.
        const attemptedAtMs = current.attemptedAt ? Date.parse(current.attemptedAt) : now();
        const lateByMs = current.lateByMs ?? Math.max(0, attemptedAtMs - Date.parse(current.dueAt));
        const fields = { attemptedAt: new Date(attemptedAtMs).toISOString(), lateByMs, attempts: (current.attempts ?? 0) + 1, lastError: undefined };
        // The attempt is written under the store's own lock: a cancel that landed while
        // the job was being prepared wins, and the job does not run.
        const persisted = await store.change(current.id, job => job.status === 'pending' ? fields : undefined);
        if (!persisted || persisted.status !== 'pending') {
          release(persisted ?? current);
          return 'skipped';
        }
        attempt = persisted;
        const written = attempt;
        const content: PromptContent = [{ type: 'text', text: renderPrompt(written) }];
        // A session that never answers does not hold the tick: the job fails for it.
        const delivery = deliver(written, content, clientMessageId(written), send);
        // A delivery that answers after the timeout is logged, not left unhandled.
        void delivery.catch(error => log.warn(`the delivery of job ${written.id} failed after it timed out`, { code: 'ALP_SCHEDULE_DELIVERY_FAILED', jobId: written.id, error }));
        let timer: NodeJS.Timeout | undefined;
        const answer = await Promise.race([
          delivery,
          new Promise<ScheduleDelivery>(resolve => {
            timer = setTimeout(() => resolve({ outcome: 'failed', error: { message: `The session did not acknowledge the prompt within ${duration(deliveryTimeoutMs)}; execution outcome is unknown. The outstanding request was not cancelled and may still start a turn. Do not recreate automatically`, code: 'delivery_timeout' } }), deliveryTimeoutMs);
            timer.unref?.();
          }),
        ]).finally(() => { if (timer) clearTimeout(timer); });
        if (answer.error?.code === 'delivery_timeout') {
          const result = await fail(attempt, answer.error.message, 'delivery_timeout');
          // The timeout bounds waiting, not provider execution. Keep the terminal job
          // (never resend it), but make a late acknowledgement observable on inspection.
          void delivery.then(async late => {
            const message = late.outcome === 'accepted'
              ? 'The provider acknowledged the prompt after the delivery timeout; a turn may have executed. No retry was sent.'
              : `The delivery answered after the timeout: ${late.error?.message ?? late.outcome}. No retry was sent.`;
            log.warn(`job ${written.id}: ${message}`, { code: 'ALP_SCHEDULE_LATE_ACK', jobId: written.id });
            await store.change(written.id, job => job.status === 'failed' && job.lastError?.code === 'delivery_timeout'
              ? { lastError: { code: late.outcome === 'accepted' ? 'delivery_accepted_late' : 'delivery_timeout', message } } : undefined);
          }).catch(error => log.warn(`could not record late acknowledgement for job ${written.id}`, { code: 'ALP_SCHEDULE_WRITE_FAILED', jobId: written.id, error }));
          return result;
        }
        if (answer.outcome === 'accepted') return done(attempt);
        if (answer.outcome === 'unknown') return fail(attempt, answer.error?.message ?? 'alpd cannot tell whether the prompt reached the agent', answer.error?.code ?? 'outcome_unknown');
        return fail(attempt, answer.error?.message ?? 'The session refused the prompt', answer.error?.code ?? 'refused');
      } catch (error: any) {
        // The attempt, when it was written, is what is failed: the times it fixed are kept.
        return fail(attempt ?? current, error?.message ?? String(error), error?.data?.reason ?? 'delivery_failed');
      } finally {
        delivering.delete(current.id);
      }
    };
    // Historical attempts only reconcile receipts; they must never send a fresh prompt.
    if (current.attempts || !runtime.withIdlePrompt) return dispatch();
    const admission = await runtime.withIdlePrompt(current.sessionId, send => dispatch((_id, input) => send(input)));
    return admission.busy ? waitBusy() : admission.value;
  }

  /**
   * One pass: every job whose time has come is delivered, in the order the jobs
   * are due. Two ticks never run at once.
   */
  async function runTick(): Promise<{ delivered: number; failed: number; waiting: number }> {
    if (ticking) return { delivered: 0, failed: 0, waiting: 0 };
    if (stopping?.()) return { delivered: 0, failed: 0, waiting: 0 };
    ticking = true;
    const outcome = { delivered: 0, failed: 0, waiting: 0 };
    try {
      await ready?.();
      for (const job of await store.due(now())) {
        // One broken job must not starve the others: each is delivered on its own.
        let result: 'delivered' | 'failed' | 'waiting' | 'skipped' = 'skipped';
        try { result = await fire(job); }
        catch (error) { log.error(`job ${job.id} could not be delivered`, { code: 'ALP_SCHEDULE_DELIVERY_FAILED', jobId: job.id, error }); }
        if (result === 'delivered') outcome.delivered++;
        else if (result === 'failed') outcome.failed++;
        else if (result === 'waiting') outcome.waiting++;
      }
      await refresh();
    } catch (error) {
      log.error('the scheduler could not deliver its jobs', { code: 'ALP_SCHEDULE_TICK_FAILED', error });
    } finally {
      ticking = false;
    }
    return outcome;
  }

  /** One pass of the tick; the pass that runs is remembered, so a stop can wait for it. */
  async function tick(): Promise<{ delivered: number; failed: number; waiting: number }> {
    // An interval firing during delivery joins the actual pass; it must not
    // replace the promise stop() needs with the no-op overlap guard.
    if (running) return running;
    const pass = runTick();
    running = pass;
    try { return await pass; }
    finally { if (running === pass) running = undefined; }
  }

  return {
    /** Whether a job waits for this session; such a session is kept open. */
    holds(sessionId: string): boolean {
      return (heldSessions.get(sessionId) ?? 0) > 0 || (waiting.get(sessionId)?.size ?? 0) > 0;
    },

    /** A job that is just being created waits for its session, before it is written. */
    holdSession(sessionId: string) {
      heldSessions.set(sessionId, (heldSessions.get(sessionId) ?? 0) + 1);
    },

    /** The job is written; its own hold takes over. */
    releaseSession(sessionId: string) {
      // Two jobs of one session may be created at once: the hold is counted, so the
      // first one that is through does not let go of the session the second one needs.
      const count = (heldSessions.get(sessionId) ?? 0) - 1;
      if (count > 0) heldSessions.set(sessionId, count);
      else heldSessions.delete(sessionId);
    },

    /** Whether a job is being delivered right now; a cancel of it is refused. */
    delivering(jobId: string): boolean {
      return delivering.has(jobId);
    },

    /** A job that was just created waits for its session. */
    hold,

    /** A job that will not run any more waits for nothing. */
    release,

    /** Reads the job files again. */
    refresh,

    /** One pass of the tick. */
    tick,

    /** The tick, every `everyMs`; the first pass waits for the daemon's start-up. */
    start(everyMs = SCHEDULE_TICK_MS) {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, everyMs);
      timer.unref();
      void refresh().catch(error => log.warn('could not read the job files', { code: 'ALP_SCHEDULE_READ_FAILED', error }));
    },

    /**
     * The tick stops, and the pass that runs now is waited for, up to a grace: a
     * delivery that outlives the grace is left to the next alpd, whose receipt of
     * the message says whether it went through.
     */
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (!running) return;
      let grace: NodeJS.Timeout | undefined;
      try { await Promise.race([running, new Promise(resolve => { grace = setTimeout(resolve, 5_000); })]); }
      finally { if (grace) clearTimeout(grace); }
    },
  };
}
