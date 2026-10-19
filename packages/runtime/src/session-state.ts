import type { RuntimeTransport } from './contracts.js';
import type { RuntimeKind, SessionSpec, ResolvedSession } from './resolve.js';
import type { MailEvent } from './mailbox.js';
import type { Worktree, WorktreeChange, Copy } from './workspace.js';
import type { Verification } from '@anhlp/alp-core/verify';
import type { Handoff } from './handoff.js';
import type { SessionUsage } from './events.js';

export type Session = {
  runtimeKind: RuntimeKind;
  runtime: RuntimeTransport;
  mapping: ResolvedSession;
  threadId: string;
  active?: string;

  pending: boolean;
  buffered: Array<[string, any]>;
  closed: boolean;

  seen: Set<string>;
  text: Map<string, string>;

  spec: SessionSpec;
  delegation: boolean;
  graph: Record<string, string[]>;
  ancestry: string[];

  parent?: string;
  toolCallId?: string;
  children: Set<string>;

  peerCount: number;
  /** Live assignments this session requested, keyed by child session id. */
  assignments: Map<string, Assignment>;
  /** Root-tree implementation starts since the last new root user turn. */
  calls: number;
  /** Separate finite budget for mandatory read-only reviewer/oracle starts. */
  advisorCalls: number;

  mail: MailEvent[];
  waiters: Waiter[];
  lastActivity: number;
  /** Auto-wakes since the last user prompt or new result/question; check-ins do not count. */
  wakes: number;
  /** Failed wake starts since fresh result/question/check-in mail or a user prompt. */
  wakeFailures: number;
  /** When it last got a check-in, or when its assignments started running. */
  checkInAt?: number;
  /** Set by interrupt: pending mail waits for the next user prompt. */
  wakeBlocked: boolean;
  /** An assignment a usage limit or a pause stopped: it waits, open, until its runtime resumes. prompt is what continues it. */
  parked?: { reason: string; since: number; prompt?: string };
  /** What the requester of a session parked by its turn's end is told happens next, instead of waiting for alp resume. */
  parkThen?: string;
  /** When ALP restarted this session's native process, within the last RESTART_WINDOW_MS. */
  restarts?: number[];
  /** The last completed native item: progress that keeps the restart breaker closed. */
  progressAt?: number;
  /** A digest of the instructions the session runs with. */
  instructionsSha?: string;
  /** The latest usage its runtime reported, shown in viewers' context meters (ALPD §57). */
  usage?: SessionUsage;
  /** The context advisory was given since the context last emptied (ALPD §57). */
  contextLevel?: number;
  /** An assignment's brief as its requester gave it, repeated after a compaction. */
  brief?: string;
  /** The skills it has used, each logged once (ALPD §59). */
  skillsUsed?: Set<string>;
  /** Why the running turn is being stopped, so its end parks the assignment instead of ending it. */
  parkReason?: string;
  /** Mail arrived while its runtime was paused; it is delivered on resume. */
  wakeHeld?: boolean;
  /** Permission questions to the user, one at a time. */
  permissionQueue?: Promise<unknown>;

  toolCalls: Map<string, Promise<unknown>>;
  acknowledged: Promise<void>;

  /** Finished isolated assignments whose change waits for alp_merge or alp_discard. */
  /** Finished worktree assignments waiting for alp_merge or alp_discard; verification holds a failed check. */
  worktrees: Map<string, { agent: string; worktree: Worktree; change: WorktreeChange; taskId?: string; verification?: Verification }>;

  settle?: (state: string, error?: unknown) => void;

  /** This session is the supervisor of its parent, not an assignment. */
  role?: 'supervisor';
  /** A root's supervisor session. */
  supervisor?: string;
  /** What happened in the tree during this root's turn, for its supervisor. */
  journal: string[];
  /** A root: when the user wrote and has had no reply yet. */
  userWaiting?: number;
  /** The turn answers only the supervisor's questions; it is not reviewed again. */
  supervisorWake?: boolean;
  /** The user stopped the current turn: there is nothing of main's to review. */
  userStopped?: boolean;
  /** A digest waits for the supervisor: queued, or behind its current review. */
  reviewPending?: boolean;
  /** A review start is queued behind client operations. */
  reviewQueued?: boolean;
  /** Tasks this root's tree created or worked on, in order, for its todo list. */
  tasks: string[];
  /** The todo list last shown, to show it again only when it changed. */
  tasksShown?: string;

  /** Requesting agent for a child assignment; enables alp_handoff and alp_ask. */
  parentAgent?: string;
  /** The user wrote to this assignment, so it may ask the user too. */
  userOpened?: boolean;
  handoff?: Handoff;
};

export type Assignment = {
  id: string;
  agent: string;
  mode: string;
  /** shared: the requester's checkout; worktree: its own git worktree. */
  isolation: 'shared' | 'worktree';
  worktree?: Worktree;
  /** A disposable copy of the requester's tree the assignment works in; removed when it ends. */
  copy?: Copy;
  /** Commands it ran in the requester's tree instead of its copy. */
  escapes?: string[];
  /** The checkout this assignment holds the write lease of. */
  lease?: string;
  /** Repository/check-out this writer changes, including when an ancestor holds its lease. */
  writeCheckout?: string;
  /** The task this assignment took with alp_delegate { taskId }. */
  taskId?: string;
  /** For a writer in the shared checkout: checkoutFingerprint when it started, to tell whether it changed anything. */
  fingerprint?: string;
  startedAt: number;
  warned: boolean;
  finished: boolean;
  rootId: string;
  /** When the requester expected it done (alp_delegate etaMinutes); a check-in reports passing it, once. */
  eta?: number;
  overdue?: boolean;
  /** The last note it sent its requester, for check-ins. */
  lastNote?: string;
  ask?: { id: string; resolve: (result: unknown) => void };
};

/** 'user': the user wrote to the waiting session, which answers before it waits again. */
export type Waiter = {
  accept: (event: MailEvent) => boolean;
  resolve: (events: MailEvent[] | null | 'user') => void;
  timer?: NodeJS.Timeout;
};
