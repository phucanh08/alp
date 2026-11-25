/**
 * The four schedule RPC handlers (schedule.create/list/get/cancel): the adapter from a request to
 * the job store and the scheduler. alpd registers them in its handler table (server.ts), and
 * runtime.bindSchedules reaches them through that same table, so IPC and agent calls share them.
 */
import path from 'node:path';
import { ERROR, RPC_ERROR } from '@anhlp/alp-protocol';
import type { AlpRuntime } from '@anhlp/alp-runtime/index';
import type { createLogger } from '@anhlp/alp-core/log';
import { RpcError } from '../../rpc-error.js';
import { projectKey, type ScheduleStore } from '../schedules.js';
import type { Scheduler } from '../scheduler.js';

/** A job store's refusal as a protocol error: what it refused, and why. */
// any: whatever the store threw; only its `code` and `message` are read.
const scheduleFailed = (error: any) => {
  if (error instanceof RpcError) return error;
  switch (error?.code) {
    case 'SCHEDULE_NOT_FOUND': return new RpcError(ERROR.notFound, error.message, { reason: 'not_found' });
    case 'SCHEDULE_NOT_PENDING': return new RpcError(ERROR.conflict, error.message, { reason: 'task_state' });
    case 'INVALID_SCHEDULE': return new RpcError(RPC_ERROR.invalidParams, error.message, { reason: 'invalid_params' });
  }
  return error;
};

/**
 * The project of a request: an absolute path, or nothing. The three methods that read
 * or change a job refuse a missing project the same way, so a client that names no
 * project is told what is wrong, not shown the jobs of the host.
 */
const requestedProject = (projectRoot: unknown): string => {
  if (typeof projectRoot !== 'string' || !projectRoot) throw new RpcError(RPC_ERROR.invalidParams, 'projectRoot is required');
  // A relative path would be read against the daemon's own directory, which is another
  // project.
  if (!path.isAbsolute(projectRoot)) throw new RpcError(RPC_ERROR.invalidParams, 'projectRoot must be an absolute path');
  return projectRoot;
};

// any: params arrive as JSON; each handler checks the fields it reads, as it did inline in server.ts.
type ScheduleHandler = (connection: unknown, params: any) => Promise<unknown>;

/**
 * The handlers over this daemon's job store and scheduler. Without a store (a daemon with no
 * home or no session store) every method answers that alpd does not serve scheduled jobs.
 */
export function createScheduleHandlers({ schedules, scheduler, runtime, log }: {
  schedules: ScheduleStore | undefined;
  scheduler: Scheduler | undefined;
  runtime: Pick<AlpRuntime, 'snapshot'>;
  log: ReturnType<typeof createLogger>;
}): Record<'schedule.create' | 'schedule.list' | 'schedule.get' | 'schedule.cancel', ScheduleHandler> {
  /**
   * The job of that id in that project: the store keeps the project boundary, and a
   * refusal of the store is answered like one of the daemon's own.
   */
  const storeJob = async (id: string, projectRoot: string) => {
    if (!schedules) return undefined;
    try { return await schedules.get(id, { projectRoot }); }
    catch (error) { throw scheduleFailed(error); }
  };
  return {
    /**
     * A scheduled continuation of a root session: alpd opens the turn itself
     * when the time comes, without a user message. The target is a live root session of
     * the project; a session that is closed when the job is due fails the job, and the
     * reason is kept.
     */
    async 'schedule.create'(_connection, { projectRoot, sessionId, dueAt, prompt, keepsSession } = {}) {
      if (!schedules) throw new RpcError(ERROR.failed, 'alpd does not serve scheduled jobs');
      if (typeof projectRoot !== 'string' || typeof sessionId !== 'string' || typeof dueAt !== 'string' || typeof prompt !== 'string') {
        throw new RpcError(RPC_ERROR.invalidParams, 'projectRoot, sessionId, dueAt and prompt are required');
      }
      if (keepsSession !== undefined && typeof keepsSession !== 'boolean') throw new RpcError(RPC_ERROR.invalidParams, 'keepsSession must be true or false');
      if (!path.isAbsolute(projectRoot)) throw new RpcError(RPC_ERROR.invalidParams, 'projectRoot must be an absolute path');
      const snapshot = runtime.snapshot(sessionId);
      if (!snapshot) throw new RpcError(ERROR.notFound, `Session ${sessionId} is not open`);
      if (snapshot.parentId) throw new RpcError(RPC_ERROR.invalidParams, 'A scheduled job continues a root session');
      // The project is compared as a path, not as a spelling: a client that names the
      // same directory with a trailing slash means the same project.
      if (projectKey(snapshot.projectRoot) !== projectKey(projectRoot)) throw new RpcError(RPC_ERROR.invalidParams, 'That session does not belong to that project');
      if (!snapshot.persistent || !snapshot.threadId) log.warn(`a job on ${sessionId} cannot survive a restart of alpd: the session keeps no thread to resume`, { code: 'ALP_SCHEDULE_SESSION_NOT_RESUMABLE', sessionId });
      // The session waits for the job before the job is written, so it is not closed
      // in between; the job's own hold takes over once it exists.
      scheduler?.holdSession(sessionId);
      try {
        const job = await schedules.create({ projectRoot, sessionId, dueAt, prompt, keepsSession });
        scheduler?.hold(job);
        return { job };
      } catch (error) {
        throw scheduleFailed(error);
      } finally {
        scheduler?.releaseSession(sessionId);
      }
    },

    /** The jobs of this project, oldest first by the time they are due. */
    async 'schedule.list'(_connection, { projectRoot, status } = {}) {
      if (!schedules) throw new RpcError(ERROR.failed, 'alpd does not serve scheduled jobs');
      // The jobs of every project live in one directory: the project is the boundary.
      requestedProject(projectRoot);
      try {
        return { jobs: await schedules.list({ projectRoot, status }) };
      } catch (error) {
        throw scheduleFailed(error);
      }
    },

    /** One job, with what became of it. */
    async 'schedule.get'(_connection, { id, projectRoot } = {}) {
      if (!schedules) throw new RpcError(ERROR.failed, 'alpd does not serve scheduled jobs');
      if (typeof id !== 'string') throw new RpcError(RPC_ERROR.invalidParams, 'id is required');
      requestedProject(projectRoot);
      // The store keeps the project boundary itself: a job of another project is not
      // there for this one, whatever the caller asked for.
      const job = await storeJob(id, projectRoot);
      if (!job) throw new RpcError(ERROR.notFound, `No scheduled job ${id}`);
      return { job };
    },

    /** A job that will not run: cancelled before its time. */
    async 'schedule.cancel'(_connection, { id, projectRoot } = {}) {
      if (!schedules) throw new RpcError(ERROR.failed, 'alpd does not serve scheduled jobs');
      if (typeof id !== 'string') throw new RpcError(RPC_ERROR.invalidParams, 'id is required');
      requestedProject(projectRoot);
      const job = await storeJob(id, projectRoot);
      if (!job) throw new RpcError(ERROR.notFound, `No scheduled job ${id}`);
      // A job that is being delivered now is not cancelled: the delivery is under way.
      if (scheduler?.delivering(id)) throw new RpcError(ERROR.conflict, `Job ${id} is being delivered now`, { reason: 'key_conflict' });
      try {
        const cancelled = await schedules.cancel(id, { projectRoot });
        scheduler?.release(cancelled);
        return { job: cancelled };
      } catch (error) {
        throw scheduleFailed(error);
      }
    },
  };
}
