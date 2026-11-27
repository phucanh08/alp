import { z } from 'zod';
import { BOARD_KINDS_INPUT, PIN_BODY_CHARS, PIN_KINDS, PIN_PATH_CHARS, PIN_PATHS, PIN_PATHS_INPUT } from '../../board/board.ts';
import { RESULT_OUTCOMES } from '../../assignments/completion/assignment-results.ts';
import { inputLimitError, POUR_VARS, VAR_NAME, type InputLimits } from '../../_shared/input-limits.ts';
import { CLOSE_REASONS, GATE_KINDS, TASK_STATUSES, TASK_TYPES } from '@anhlp/alp-core/tasks';

/**
 * A field whose size is checked before zod walks it; its JSON Schema is the inner schema's
 * (input-limits.ts).
 *
 * Needed for any field zod's own cap does not protect. zod's GHSA-mrhx-c7xc-m3w5 fix (4.6.6) refuses
 * a collection over its `.max()` before reading an element for `array`, `map` and `set` — and for
 * NOTHING ELSE. `z.record` is NOT covered: a capped record is still read element by element, one
 * issue kept per failure (t-5294.4). So a limited record must go through `bounded` (as `vars` below
 * does), and turning a capped `z.array` field into a `z.record` silently drops that protection.
 * docs/alp/zod-advisory.md has the repository-wide survey.
 */
const bounded = <T extends z.ZodType>(schema: T, limits: InputLimits) => z.preprocess((value, ctx) => {
  const error = inputLimitError(value, limits);
  if (error) ctx.addIssue({ code: 'custom', message: error });
  return value;
}, schema);

// Zod mirrors of the provider's dynamic tool schemas; the provider validates again.
const handoffList = z.array(z.string().min(1)).max(100).optional();
const taskIds = z.array(z.string().min(1)).max(50).optional();
const taskLinks = z.object({ blockedBy: taskIds, related: taskIds, parent: z.string().min(1).optional() }).strict().optional();
export const toolShapes: Record<string, Record<string, z.ZodType>> = {
  alp_delegate: {
    agent: z.string().min(1),
    task: z.string().min(1).max(32_000),
    model: z.string().min(1).optional(),
    thinking: z.string().min(1).optional(),
    modelReason: z.string().min(1).optional(),
    mode: z.enum(['read-only', 'workspace-write', 'full-access']).optional(),
    isolation: z.enum(['shared', 'worktree']).optional(),
    writeRoot: z.string().min(1).optional(),
    wait: z.boolean().optional(),
    etaMinutes: z.number().int().min(1).max(1440).optional(),
    taskId: z.string().min(1).optional(),
    continueFrom: z.string().min(1).optional(),
  },
  alp_merge: {
    assignmentId: z.string().min(1),
    skipVerify: z.string().min(1).max(2000).optional(),
  },
  alp_verify: {
    taskId: z.string().min(1).optional(),
  },
  alp_recall: {
    assignmentId: z.string().min(1).optional(),
    taskId: z.string().min(1).optional(),
    question: z.string().min(1).max(4000),
  },
  alp_lesson: {
    scope: z.enum(['project', 'user']),
    lesson: z.string().min(1).max(600),
  },
  alp_lesson_curate: {
    changes: z.array(z.object({
      scope: z.enum(['project', 'user']),
      remove: z.array(z.string().min(1).max(600)).min(1).max(50),
      add: z.string().min(1).max(600).optional(),
      reason: z.string().max(300).optional(),
    }).strict()).min(1).max(50),
    requestId: z.string().min(1).max(100).optional(),
  },
  alp_skill: {
    name: z.string().min(1),
    description: z.string().min(1).max(300),
    body: z.string().min(1).max(20_000),
    roles: z.array(z.string().min(1)).min(1).max(10),
    lessons: z.array(z.string().min(1).max(600)).max(50).optional(),
    replace: z.boolean().optional(),
    requestId: z.string().min(1).max(100).optional(),
  },
  alp_skill_retire: {
    name: z.string().min(1).max(64),
    reason: z.string().min(1).max(300),
    requestId: z.string().min(1).max(100).optional(),
  },
  alp_issue: {
    action: z.enum(['search', 'create', 'comment']),
    target: z.enum(['project', 'alp']),
    query: z.string().min(1).max(200).optional(),
    requestId: z.string().min(1).max(100).optional(),
    title: z.string().min(1).max(200).optional(),
    body: z.string().min(1).max(20_000).optional(),
    issue: z.number().int().positive().optional(),
    labels: z.array(z.string().min(1).max(50)).max(10).optional(),
  },
  alp_strategy: {
    strategy: z.enum(['rush', 'smart', 'deep', 'large']),
    reason: z.string().min(1).max(300),
  },
  alp_schedule: {
    action: z.enum(['create', 'list', 'get', 'cancel']),
    dueAt: z.string().min(1).max(80).optional(),
    prompt: z.string().min(1).max(8000).optional(),
    requestId: z.string().min(1).max(200).optional(),
    id: z.string().min(1).optional(),
    status: z.enum(['pending', 'delivered', 'failed', 'cancelled']).optional(),
  },
  alp_task: {
    action: z.enum(['create', 'update', 'link', 'start', 'close', 'reopen', 'gate', 'clear', 'pour', 'formulas', 'show', 'list', 'ready']),
    id: z.string().min(1).optional(),
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(8000).optional(),
    type: z.enum(TASK_TYPES as [string, ...string[]]).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    labels: z.array(z.string().min(1).max(50)).max(10).optional(),
    paths: z.array(z.string().min(1)).max(50).optional(),
    parent: z.string().min(1).optional(),
    blockedBy: taskIds,
    discoveredFrom: z.string().min(1).optional(),
    add: taskLinks,
    remove: taskLinks,
    reason: z.enum(CLOSE_REASONS as [string, ...string[]]).optional(),
    kind: z.enum(GATE_KINDS as [string, ...string[]]).optional(),
    until: z.string().min(1).optional(),
    ref: z.string().min(1).optional(),
    options: z.array(z.string().min(1).max(200)).max(10).optional(),
    gate: z.string().min(1).optional(),
    formula: z.string().min(1).optional(),
    vars: bounded(z.record(z.string().regex(VAR_NAME), z.string().max(POUR_VARS.string)), POUR_VARS).optional(),
    summary: z.string().min(1).max(2000).optional(),
    unverified: z.string().min(1).max(2000).optional(),
    note: z.string().min(1).max(2000).optional(),
    status: z.enum(TASK_STATUSES as [string, ...string[]]).optional(),
    label: z.string().min(1).optional(),
    limit: z.number().int().positive().optional(),
  },
  alp_discard: {
    assignmentId: z.string().min(1),
  },
  alp_resolve: {
    assignmentId: z.string().min(1),
    outcome: z.enum(RESULT_OUTCOMES),
    note: z.string().min(1).max(2000).optional(),
  },
  alp_cancel: {
    assignmentId: z.string().min(1),
    reason: z.string().optional(),
  },
  alp_pin: {
    kind: z.enum(PIN_KINDS),
    body: z.string().min(1).max(PIN_BODY_CHARS),
    paths: bounded(z.array(z.string().min(1).max(PIN_PATH_CHARS)).max(PIN_PATHS), PIN_PATHS_INPUT).optional(),
  },
  alp_board: {
    kinds: bounded(z.array(z.enum(PIN_KINDS)).max(PIN_KINDS.length), BOARD_KINDS_INPUT).optional(),
    limit: z.number().int().positive().optional(),
  },
  alp_unpin: {
    pinId: z.string().min(1),
  },
  alp_wait: {
    assignments: z.array(z.string().min(1)).max(32).optional(),
    timeoutMs: z.number().int().positive().optional(),
  },
  alp_send: {
    to: z.string().min(1),
    kind: z.enum(['answer', 'note', 'steer']),
    body: z.string().min(1).max(8000),
    replyTo: z.string().min(1).optional(),
  },
  alp_ask: {
    question: z.string().min(1).max(8000),
    to: z.enum(['parent', 'user']).optional(),
    options: z.array(z.string().min(1).max(200)).max(10).optional(),
  },
  alp_handoff: {
    outcome: z.enum(['complete', 'partial', 'blocked', 'reconsider']),
    summary: z.string().min(1),
    candidate: handoffList,
    scope: handoffList,
    verification: handoffList,
    risks: handoffList,
    discovered: handoffList,
    ownership: z.string().optional(),
    // ALP checks that the result follows from the criteria and findings (ALPD §38).
    verdict: z.object({
      result: z.enum(['pass', 'pass_with_findings', 'fail', 'blocked']),
      criteria: z.array(z.object({ criterion: z.string().min(1), result: z.enum(['pass', 'fail', 'not_checked']), evidence: z.string().min(1) }).strict()).min(1).max(50),
      findings: z.array(z.object({ severity: z.enum(['critical', 'high', 'medium', 'low']), where: z.string().min(1), problem: z.string().min(1), fix: z.string().min(1).optional() }).strict()).max(100).optional(),
    }).strict().optional(),
  },
};
