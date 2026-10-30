import { CLOSE_REASONS, GATE_KINDS, TASK_STATUSES, TASK_TYPES, TASKS_DIR, type Task } from '@anhlp/alp-core/tasks';
import { READ_ONLY_AGENTS, type ResolvedSession } from './resolve.js';

import { PIN_KINDS, PIN_PATH_CHARS, PIN_PATHS } from './board.js';
import { POUR_VARS } from './input-limits.js';
import { RECALL_KEEP_MS } from './recall.js';
import { RESULT_OUTCOMES } from './assignment-results.js';
import { HANDOFF_OUTCOMES, VERDICT_RESULTS, CRITERION_RESULTS, SEVERITIES } from './handoff.js';

export const handoffList = (description: string) => ({ type: 'array', items: { type: 'string' }, description });

export const HANDOFF_TOOL = {
  type: 'function',
  name: 'alp_handoff',
  description: 'File the structured handoff for your current assignment. The requesting agent receives it when your turn ends. A partial handoff stops your parked children, preserves their changes, and returns unfinished work to your requester.',
  inputSchema: {
    type: 'object',
    properties: {
      outcome: { type: 'string', enum: HANDOFF_OUTCOMES, description: 'complete, partial, blocked, or reconsider (the premise needs reconsideration).' },
      summary: { type: 'string', description: 'Result, answer, or findings the requester needs.' },
      candidate: handoffList('Artifacts or files produced; base and candidate SHA when applicable.'),
      scope: handoffList('Paths changed or read.'),
      verification: handoffList('Commands run with actual results, and checks not run.'),
      risks: handoffList('Unresolved findings, assumptions, and decisions needed.'),
      discovered: handoffList('Work you found outside your scope that should be tracked; your requester records it as a task.'),
      ownership: { type: 'string', description: 'Resources released or retained.' },
      verdict: {
        type: 'object',
        description: 'For a review: required of reviewer when the outcome is complete. Judge each acceptance criterion of the brief (or the ones you derived, said so), then give the result they lead to: fail when a criterion failed or a finding is critical or high; pass_with_findings when only medium or low findings remain; pass when there is nothing to fix; blocked when the review could not be done.',
        properties: {
          result: { type: 'string', enum: VERDICT_RESULTS },
          criteria: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                criterion: { type: 'string', description: 'What the change must do or respect.' },
                result: { type: 'string', enum: CRITERION_RESULTS },
                evidence: { type: 'string', description: 'What you observed or ran, with file:line; for not_checked, why.' },
              },
              required: ['criterion', 'result', 'evidence'],
              additionalProperties: false,
            },
          },
          findings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                severity: { type: 'string', enum: SEVERITIES, description: 'critical: security, data loss, crash; high: bug or real performance problem; medium: maintainability or minor bug; low: style.' },
                where: { type: 'string', description: 'file:lines in the new version.' },
                problem: { type: 'string', description: 'What is wrong and why it matters.' },
                fix: { type: 'string', description: 'The recommended fix.' },
              },
              required: ['severity', 'where', 'problem'],
              additionalProperties: false,
            },
          },
        },
        required: ['result', 'criteria'],
        additionalProperties: false,
      },
    },
    required: ['outcome', 'summary'],
    additionalProperties: false,
  },
};

export const WAIT_TOOL = {
  type: 'function',
  name: 'alp_wait',
  description: 'Wait for mail from your assignments: results, questions, notes, and stall reports. Returns as soon as any arrives, a check-in comes or the user writes to you; otherwise with an empty list and a status snapshot after timeoutMs (default 5 minutes, at most 15). Ending your turn instead never cancels your assignments.',
  inputSchema: {
    type: 'object',
    properties: {
      assignments: { type: 'array', items: { type: 'string' }, description: 'Assignment ids to wait for; omit for all of yours.' },
      timeoutMs: { type: 'integer', description: 'Maximum wait. Default 300000, maximum 900000.' },
    },
    additionalProperties: false,
  },
};

export const SEND_TOOL = {
  type: 'function',
  name: 'alp_send',
  description: 'Send mail to one of your live assignments, or to "parent", your requester. Siblings are not addressable.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'An assignment id you started (or its agent name when only one is live), or "parent".' },
      kind: { type: 'string', enum: ['answer', 'note', 'steer'], description: 'answer replies to a question (needs replyTo); steer changes an instruction (requester only); note is information.' },
      body: { type: 'string' },
      replyTo: { type: 'string', description: 'Question id, for example #4.' },
    },
    required: ['to', 'kind', 'body'],
    additionalProperties: false,
  },
};

export const MERGE_TOOL = {
  type: 'function',
  name: 'alp_merge',
  description: 'Apply the change of a finished worktree assignment to your checkout, uncommitted. Conflicts are left as conflict markers for you to resolve. When the project configures verify commands, ALP runs them in the worktree first and applies nothing if they fail.',
  inputSchema: {
    type: 'object',
    properties: {
      assignmentId: { type: 'string' },
      skipVerify: { type: 'string', description: 'Merge without running the verify commands; say why. It is recorded on the task.' },
    },
    required: ['assignmentId'],
    additionalProperties: false,
  },
};

export const VERIFY_TOOL = {
  type: 'function',
  name: 'alp_verify',
  description: "Run the project's verify commands (setup, typecheck, test from .alp/settings.json) in your checkout, for example after resolving merge conflicts. Main may pass taskId to record the result on the task.",
  inputSchema: {
    type: 'object',
    properties: { taskId: { type: 'string', description: 'Main only: the task the result counts for.' } },
    additionalProperties: false,
  },
};

export const DISCARD_TOOL = {
  type: 'function',
  name: 'alp_discard',
  description: 'Drop the change of a finished worktree assignment, deleting its worktree and branch.',
  inputSchema: {
    type: 'object',
    properties: { assignmentId: { type: 'string' } },
    required: ['assignmentId'],
    additionalProperties: false,
  },
};

export const RESOLVE_TOOL = {
  type: 'function',
  name: 'alp_resolve',
  description: "Record how you handled a finished writer's change in your checkout: applied (you kept or committed it), discarded (you reverted it) or acknowledged (you reviewed it; nothing to do). Until then ALP keeps its result and will not let that checkout be removed; then it archives the result.",
  inputSchema: {
    type: 'object',
    properties: {
      assignmentId: { type: 'string' },
      outcome: { type: 'string', enum: RESULT_OUTCOMES },
      note: { type: 'string', description: 'What you did with it, for the archive and the run log.' },
    },
    required: ['assignmentId', 'outcome'],
    additionalProperties: false,
  },
};

export const CANCEL_TOOL = {
  type: 'function',
  name: 'alp_cancel',
  description: 'Stop one of your running or parked assignments, with its own assignments. Its changes stay where it made them (your checkout, or its worktree for alp_merge or alp_discard) and its task goes back to open. Use it to hand the rest to another agent or runtime, for example when one is parked on a usage limit.',
  inputSchema: {
    type: 'object',
    properties: {
      assignmentId: { type: 'string' },
      reason: { type: 'string', description: 'Why, for the run log and its result.' },
    },
    required: ['assignmentId'],
    additionalProperties: false,
  },
};

export const RECALL_TOOL = {
  type: 'function',
  name: 'alp_recall',
  description: `Ask a finished assignment about its work: why it chose an approach, what it tried, where it got stuck. ALP forks its session read-only, asks your question, and returns the answer. Assignments stay recallable for ${RECALL_KEEP_MS / 86_400_000} days.`,
  inputSchema: {
    type: 'object',
    properties: {
      assignmentId: { type: 'string', description: 'The finished assignment to ask, from its result.' },
      taskId: { type: 'string', description: 'Instead of assignmentId: the last assignment that worked on this task.' },
      question: { type: 'string', description: 'What you want to know.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

export const PIN_TOOL = {
  type: 'function',
  name: 'alp_pin',
  description: 'Pin to the project board that every agent on this project reads. claim: paths you are about to change (refused if another agent holds an overlapping claim); decision: the approach others should follow; finding: something others need to know.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: PIN_KINDS },
      body: { type: 'string', description: 'For a claim, what you are changing; otherwise the decision or finding itself.' },
      paths: { type: 'array', items: { type: 'string', maxLength: PIN_PATH_CHARS }, maxItems: PIN_PATHS, description: `Project-relative files or directories, at most ${PIN_PATHS}. Required for a claim.` },
    },
    required: ['kind', 'body'],
    additionalProperties: false,
  },
};

export const BOARD_TOOL = {
  type: 'function',
  name: 'alp_board',
  description: 'Read the project board: live claims, decisions and findings pinned by agents working on this project.',
  inputSchema: {
    type: 'object',
    properties: {
      kinds: { type: 'array', items: { type: 'string', enum: PIN_KINDS }, maxItems: PIN_KINDS.length },
      limit: { type: 'integer', description: 'Most recent decisions and findings to return. Default 30.' },
    },
    additionalProperties: false,
  },
};

export const UNPIN_TOOL = {
  type: 'function',
  name: 'alp_unpin',
  description: 'Take down one of your pins, such as a claim you no longer need. Claims also end with your session.',
  inputSchema: {
    type: 'object',
    properties: { pinId: { type: 'string' } },
    required: ['pinId'],
    additionalProperties: false,
  },
};

export const ASK_TOOL = {
  type: 'function',
  name: 'alp_ask',
  description: 'Ask a question and wait for the answer: your requester, or the user. Only main talks to the user, unless the user has written to you. Holds your turn until answered; returns unanswered after the ask timeout (15 minutes for a requester, 30 for the user), and user_wrote when the user writes in the chat instead of answering.',
  inputSchema: {
    type: 'object',
    properties: {
      question: { type: 'string' },
      to: { type: 'string', enum: ['parent', 'user'], description: 'parent (default for assignments) or user (the default without a requester; for an assignment, only after the user has written to it).' },
      options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers for the user; they may answer otherwise.' },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

export const LESSON_TOOL = {
  type: 'function',
  name: 'alp_lesson',
  description: 'Record a lesson about your process, so you follow it in later sessions. Write it as a rule: what to do, and when. scope project: this project only; user: every project of this user.',
  inputSchema: {
    type: 'object',
    properties: {
      scope: { type: 'string', enum: ['project', 'user'] },
      lesson: { type: 'string', description: 'One rule, at most 600 characters.' },
    },
    required: ['scope', 'lesson'],
    additionalProperties: false,
  },
};

export const LESSON_CURATE_TOOL = {
  type: 'function',
  name: 'alp_lesson_curate',
  description: 'Merge, shorten or remove recorded lessons. Each change removes the exact text of lessons from one scope and may add one rule in their place (a merge or a shortening); a change without add removes them. ALP shows every change to the user at once and applies them only when the user approves. Returns pending_approval with approvalId immediately; the result (applied, lessons not found, or the user\'s feedback) arrives once by mail. Never edit lessons files any other way.',
  inputSchema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        description: 'At most 50 changes.',
        items: {
          type: 'object',
          properties: {
            scope: { type: 'string', enum: ['project', 'user'] },
            remove: { type: 'array', items: { type: 'string' }, description: 'The exact text of each lesson to remove, with or without its date.' },
            add: { type: 'string', description: 'One rule, at most 600 characters, that replaces them.' },
            reason: { type: 'string', description: 'Why, in one line.' },
          },
          required: ['scope', 'remove'],
          additionalProperties: false,
        },
      },
      requestId: { type: 'string', description: 'Optional session-scoped idempotency key (1-100 characters).' },
    },
    required: ['changes'],
    additionalProperties: false,
  },
};

export const SKILL_TOOL = {
  type: 'function',
  name: 'alp_skill',
  description: 'Propose a skill distilled from your lessons. ALP shows the whole skill to the user, and saves it to the user\'s skill library and gives it to the roles only when the user approves. Returns pending_approval with approvalId immediately; the decision (saved, or not saved with the user\'s feedback) arrives once by mail, even after your turn ends. Continue other work. A retry of the same draft returns its existing pending/result in this session; use a fresh requestId only to propose an identical draft again.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Directory name: lowercase letters, digits and hyphens.' },
      description: { type: 'string', description: 'One line: what the skill is for and when to use it.' },
      body: { type: 'string', description: 'The SKILL.md body in Markdown, without frontmatter: when to use it, the method as steps, and the checks.' },
      roles: { type: 'array', items: { type: 'string' }, description: 'The roles whose work the skill guides, and only those: any of main (yourself), lead, peer, oracle, reviewer, supervisor, or a custom agent of this project.' },
      lessons: { type: 'array', items: { type: 'string' }, description: 'The exact text of the lessons this skill replaces; they leave the lessons files once it is saved.' },
      replace: { type: 'boolean', description: 'Propose a new version of an existing skill of this name.' },
      requestId: { type: 'string', description: 'Optional session-scoped idempotency key (1-100 characters). Reuse with the same draft on retries; a fresh key explicitly proposes a new operation.' },
    },
    required: ['name', 'description', 'body', 'roles'],
    additionalProperties: false,
  },
};

export const ISSUE_TOOL = {
  type: 'function',
  name: 'alp_issue',
  description: 'GitHub issues of this project (target project, from its origin remote) or of ALP itself (target alp). search needs no approval. create and comment show the whole draft to the user and post it only when the user approves; create/comment return pending_approval with approvalId immediately, then send one decision/posting result by mail, even after your turn ends. Continue other work. Draft retries return the existing pending/result in this session. Use a fresh requestId only to intentionally propose an identical draft again; reuse one requestId with the exact draft to replay safely.',
  inputSchema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['search', 'create', 'comment'] },
      target: { type: 'string', enum: ['project', 'alp'] },
      query: { type: 'string', description: 'For search: GitHub search terms.' },
      title: { type: 'string', description: 'For create.' },
      body: { type: 'string', description: 'For create and comment: Markdown. Facts, reproduction and evidence; no secrets.' },
      issue: { type: 'integer', description: 'For comment: the issue number.' },
      requestId: { type: 'string', description: 'Optional session-scoped idempotency key (1-100 characters). Reuse with the same draft on retries; a fresh key explicitly proposes a new operation.' },
      labels: { type: 'array', items: { type: 'string' }, description: 'For create: existing labels of the repository.' },
    },
    required: ['action', 'target'],
    additionalProperties: false,
  },
};

export const TASK_ACTIONS = ['create', 'update', 'link', 'start', 'close', 'reopen', 'gate', 'clear', 'pour', 'formulas', 'show', 'list', 'ready'] as const;
export type TaskAction = typeof TASK_ACTIONS[number];
export const TASK_PAST: Record<string, string> = { create: 'created', update: 'updated', link: 'linked', start: 'started', close: 'closed', reopen: 'reopened', gate: 'gated', clear: 'cleared a gate of', delegate: 'delegated', submit: 'submitted', release: 'released', pour: 'poured', orphaned: 'reopened (its assignment ended with alpd)' };
export const TASK_FIELDS: Record<TaskAction, string[]> = {
  create: ['title', 'description', 'type', 'priority', 'labels', 'paths', 'parent', 'blockedBy', 'discoveredFrom'],
  update: ['id', 'title', 'description', 'type', 'priority', 'labels', 'paths', 'note'],
  link: ['id', 'add', 'remove'],
  start: ['id'],
  close: ['id', 'reason', 'summary', 'unverified'],
  reopen: ['id', 'note'],
  gate: ['id', 'kind', 'note', 'until', 'ref', 'options'],
  clear: ['id', 'gate', 'note'],
  pour: ['formula', 'vars', 'parent'],
  formulas: [],
  show: ['id'],
  list: ['status', 'label', 'limit'],
  ready: ['limit'],
};

/** The agent a session's team has as main (ALPD §42); `main` outside a team. */
export const mainOf = (mapping: Pick<ResolvedSession, 'team'>) => mapping.team?.main ?? 'main';

/** A member's role in the session's team; without a team, the built-in agents' roles by name. */
export const roleOf = (mapping: Pick<ResolvedSession, 'team'>, agent: string) =>
  mapping.team ? mapping.team.members[agent]?.role : ({ lead: 'lead', peer: 'peer', oracle: 'advisor', reviewer: 'reviewer' } as Record<string, string>)[agent];

/** What each role may do with the task graph: main changes it, the others read it. */
export function taskActions(mapping: Pick<ResolvedSession, 'agent' | 'team'>, parentAgent?: string, role?: 'supervisor'): TaskAction[] {
  if (role === 'supervisor') return ['show', 'list'];
  if (!parentAgent && mapping.agent.name === mainOf(mapping)) return [...TASK_ACTIONS];
  return READ_ONLY_AGENTS.includes(mapping.agent.name) ? ['show'] : ['show', 'ready'];
}

export const taskLinks = (description: string) => ({
  type: 'object',
  description,
  properties: {
    blockedBy: { type: 'array', items: { type: 'string' }, description: 'Tasks that must close first.' },
    related: { type: 'array', items: { type: 'string' } },
    parent: { type: 'string', description: 'An epic or larger task this one belongs to.' },
  },
  additionalProperties: false,
});

export function taskTool(actions: TaskAction[]) {
  const edits = actions.includes('create');
  return {
    type: 'function',
    name: 'alp_task',
    description: edits
      ? `The project's task graph in ${TASKS_DIR}, shared with the user. ready lists open tasks nothing blocks or gates, most urgent first. gate holds a task back until the user approves (human), a time passes (timer), a pull request merges (gh:pr) or a workflow run succeeds (gh:run); ALP checks GitHub gates at the start of your turns, and clear clears one by hand. formulas lists workflow templates; pour turns one into an epic with a task per step, the steps ordered by blockedBy. create records work to track (discoveredFrom: the task during which you found it); start takes a ready task for yourself; close it with a reason and summary once verified; link adds or removes blockedBy, related and parent; reopen puts a task back to open.`
      : `Read the project's task graph in ${TASKS_DIR}. Only main and the user create or change tasks; report work you find outside your scope to your requester.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: actions },
        id: { type: 'string', description: 'Task id, such as t-a3f8; for every action except create, list and ready.' },
        ...(edits ? {
          title: { type: 'string', description: 'For create and update: at most 200 characters.' },
          description: { type: 'string', description: 'For create and update: what done means, context, and how to verify.' },
          type: { type: 'string', enum: TASK_TYPES },
          priority: { type: 'integer', description: '0 urgent, 1 high, 2 normal (default), 3 low, 4 backlog.' },
          labels: { type: 'array', items: { type: 'string' } },
          paths: { type: 'array', items: { type: 'string' }, description: 'Project-relative files or directories the work changes.' },
          parent: { type: 'string', description: 'For create: the parent task.' },
          blockedBy: { type: 'array', items: { type: 'string' }, description: 'For create: tasks that must close first.' },
          discoveredFrom: { type: 'string', description: 'For create: the task during which this work was found.' },
          add: taskLinks('For link: relations to add.'),
          remove: taskLinks('For link: relations to remove.'),
          reason: { type: 'string', enum: CLOSE_REASONS, description: 'For close. Default done.' },
          kind: { type: 'string', enum: GATE_KINDS, description: 'For gate: human (the user approves; give the question as note), timer (until), gh:pr (until a pull request merges; ref), gh:run (until a workflow run succeeds; ref).' },
          until: { type: 'string', description: 'For a timer gate: an ISO time, or +30m, +2h, +3d.' },
          ref: { type: 'string', description: 'For a gh:pr or gh:run gate: 123, or owner/repo#123.' },
          options: { type: 'array', items: { type: 'string', maxLength: 200 }, maxItems: 10, description: 'For a human gate: up to 10 answers the user picks from, each at most 200 characters; picking any approves it, and you get the choice by mail. Default approve or reject.' },
          gate: { type: 'string', description: 'For clear: the gate id, such as g1. You cannot clear a human gate; the user does.' },
          formula: { type: 'string', description: 'For pour: the formula name, from action formulas.' },
          vars: { type: 'object', additionalProperties: { type: 'string', maxLength: POUR_VARS.string }, description: `For pour: values of the formula variables (at most ${POUR_VARS.items}), each at most ${POUR_VARS.string} characters.` },
          summary: { type: 'string', description: 'For close: the outcome and its evidence.' },
          unverified: { type: 'string', description: "For close as done when the task's last verification failed: why it is done anyway. Recorded on the task." },
          note: { type: 'string', description: 'For update and reopen: why.' },
        } : {}),
        ...(actions.includes('list') ? {
          status: { type: 'string', enum: TASK_STATUSES, description: 'For list. Default: every task not closed.' },
          label: { type: 'string', description: 'For list.' },
        } : {}),
        ...(actions.includes('ready') || actions.includes('list') ? { limit: { type: 'integer', description: 'For ready and list. Default 20.' } } : {}),
      },
      required: ['action'],
      additionalProperties: false,
    },
  };
}

/** The task an assignment takes, as the start of its brief. */
export function taskBrief(task: Task, writing: boolean) {
  return [
    `Task ${task.id} (${task.type}, P${task.priority}): ${task.title}`,
    ...(task.description ? [task.description] : []),
    ...(task.paths.length ? [`Paths: ${task.paths.join(', ')}${writing ? ' (ALP claimed them for you on the project board)' : ''}`] : []),
    'Your handoff moves this task to review for your requester to accept. List work you found outside the task under discovered; only main and the user create tasks.',
  ].join('\n');
}

/** Only the project's main root may schedule a future continuation. */
export const SCHEDULE_TOOL = {
  type: 'function', name: 'alp_schedule',
  description: 'Create, list, inspect or cancel a one-shot continuation of this main/root session. create proposes the exact prompt and ISO time with UTC offset for user approval. Jobs wake an idle main without a user message; timer gates only unblock tasks, and assignment notes do not schedule a wake. Scheduling a quota-reset continuation never guarantees provider availability: recheck actual availability before delegating.',
  inputSchema: {
    type: 'object', properties: {
      action: { type: 'string', enum: ['create', 'list', 'get', 'cancel'] },
      dueAt: { type: 'string', description: 'For create: ISO timestamp with Z or an explicit UTC offset.' },
      prompt: { type: 'string', description: 'For create: the exact continuation, at most 8000 characters.' },
      requestId: { type: 'string', description: 'For create: stable id for this approval proposal; reuse only for an identical draft.' },
      id: { type: 'string', description: 'For get/cancel: the scheduled job id.' },
      status: { type: 'string', enum: ['pending', 'delivered', 'failed', 'cancelled'] },
    }, required: ['action'], additionalProperties: false,
  },
};
