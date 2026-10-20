/**
 * A scheduled continuation: a one-shot job that opens a new turn on a root session at a
 * given time, without a user message. The protocol owns the shape so every
 * client (the CLI, a viewer, an agent tool) reads the same state.
 */

/** Where a job stands: waiting for its time, delivered, failed, or cancelled before it fired. */
export type ScheduleStatus = 'pending' | 'delivered' | 'failed' | 'cancelled';

/** Why a job failed or still waits; failed may mean execution is unknown. */
export type ScheduleError = { message: string; code?: string };

/** One job as `schedule.list` and `schedule.get` answer it. */
export type ScheduleJob = {
  /** The job's own id, `sch_` and sixteen hex digits. */
  id: string;
  /** The project whose root session the job continues. */
  projectRoot: string;
  /** The root session the job opens a turn on. */
  sessionId: string;
  /** The continuation the job delivers. */
  prompt: string;
  /** When the job is due, in UTC (ISO 8601). */
  dueAt: string;
  status: ScheduleStatus;
  /**
   * How many times alpd tried to deliver the job. A job delivered once may have been
   * tried twice: a retry after a crash reads the receipt of the first delivery.
   */
  attempts: number;
  createdAt: string;
  updatedAt: string;
  /** When the job was delivered, failed or cancelled. */
  deliveredAt?: string;
  failedAt?: string;
  cancelledAt?: string;
  /** When the first delivery was tried. */
  attemptedAt?: string;
  /** How late the delivery was, in milliseconds; 0 when it was on time. */
  lateByMs?: number;
  /** The last error of the job: why it failed, or why it still waits. */
  lastError?: ScheduleError;
};
