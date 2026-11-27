import { ERROR, RPC_ERROR } from '@anhlp/alp-protocol';
import type { AlpRuntime, ConfigureChanges, EffectiveConfig, Envelope, NativeBinding, SessionSnapshot } from '@anhlp/alp-runtime/index';
import type { ConfigureOutcome, ForkProvenance, SessionSummary } from '@anhlp/alp-protocol/session';
import type { RpcMethodMap } from '@anhlp/alp-protocol/rpc';
import type { SessionRecord, Store } from '../persistence/store.ts';
import type { RegistryService } from '../workspaces/registry.ts';
import type { Principal } from '../attachments/attachments.ts';
import type { LifecycleJournal } from '../persistence/lifecycle.ts';
import { RpcError } from '../rpc/rpc-error.ts';

/** Events of a conversation; a fork's timeline holds these of the source root only. */
export const CONVERSATION = new Set(['item', 'turn.started', 'turn.ended', 'prompt.accepted', 'prompt.failed']);
/** Runtimes whose native conversations alpd forks and rewinds (Codex and Claude, macOS and Linux). */
export const SUPPORTED = new Set(['codex', 'claude']);
/** How many branches a summary lists; all stay recoverable by id. */
export const LISTED_BRANCHES = 100;

export type Turn = { id: string; start: number; end?: number; state?: 'completed' | 'failed' | 'canceled' };

/**
 * A fork's title when its creator gave none: the source's with " (fork)" where the fork stays in the
 * source's workspace (the same grants see both); a neutral one in another workspace, whose viewers may
 * not see the source (main's decision, 2026-10-23).
 */
export function defaultForkTitle(sourceTitle: string | undefined, sameWorkspace: boolean) {
  return sameWorkspace ? `${sourceTitle ?? 'Session'} (fork)`.slice(0, 200) : 'Fork of a session';
}

/** The turns of `root` in a timeline, in order: where each begins and how it ended. */
export function turnsOf(log: Envelope[], root: string): Turn[] {
  const prompts = new Map<string, number>();
  const turns = new Map<string, Turn>();
  const order: Turn[] = [];
  for (const envelope of log) {
    if (envelope.sessionId !== root || envelope.cursor === undefined) continue;
    const { event } = envelope;
    const cursor = envelope.cursor;
    if (event.type === 'item' && event.item.kind === 'user_message' && event.item.clientMessageId && !prompts.has(event.item.clientMessageId)) prompts.set(event.item.clientMessageId, cursor);
    else if ((event.type === 'prompt.accepted' && event.result === 'turn') || event.type === 'turn.started') {
      if (turns.has(event.turnId)) continue;
      const start = event.type === 'prompt.accepted' ? Math.min(prompts.get(event.clientMessageId) ?? cursor, cursor) : cursor;
      const turn: Turn = { id: event.turnId, start };
      turns.set(turn.id, turn);
      order.push(turn);
    } else if (event.type === 'turn.ended') {
      const turn = turns.get(event.turnId);
      if (turn && turn.state === undefined) Object.assign(turn, { state: event.state, end: cursor });
    }
  }
  return order;
}

type Busy = { rootId: string } & Record<string, unknown>;

export type ConversationContext = {
  runtime: AlpRuntime;
  store: Store;
  journal: LifecycleJournal;
  records: Map<string, SessionRecord>;
  cursors: Map<string, number>;
  logs: Map<string, Envelope[]>;
  treeLogLimit: number;
  summary(sessionId: string): SessionSummary | undefined;
  /** A stable digest of JSON data (the prompt receipt key's). */
  digest(value: unknown): string;
  /** Why a root cannot be mutated now (opening, recovering, prompts in flight), or undefined. */
  unsettled(rootId: string): string | undefined;
  /** Holds prompts, schedule deliveries and reopens of a root until `release` is called. */
  holdPrompts(rootId: string): () => void;
  /** Envelopes to every connection attached to a root's tree, live only. */
  broadcast(rootId: string, envelope: Envelope): void;
  registry?: RegistryService;
  worktrees?: { assertAvailable(directory: string): Promise<void> };
  attachments?: {
    heldBy(holders: string[]): Promise<string[]>;
    authorize(principal: Principal, attachmentIds: string[], forks?: string[]): Promise<void>;
    pin(holder: string, sessionId: string, attachmentIds: string[], kind?: string): Promise<void>;
  };
  crashPoint(name: string): void;
  log: { warn(message: string, fields?: Record<string, unknown>): void; info(message: string, fields?: Record<string, unknown>): void };
  startedAt: string;
};

export type ForkParams = RpcMethodMap['session.fork']['params'];
export type RewindParams = RpcMethodMap['session.rewind']['params'];
export type ReloadParams = RpcMethodMap['session.reload']['params'];
export type ReloadPlan = { root: string; threadId: string; at: string };
export type ConfigureParams = RpcMethodMap['session.configure']['params'];
export type ConfigurePreviewParams = RpcMethodMap['session.configure.preview']['params'];
export type ConfigurePlan = {
  root: string; requested: ConfigureChanges;
  /** No turn yet: the restart starts a new conversation, there is none to keep. */
  fresh: boolean;
  /** What the root ran with, and what prepare resolved it would run with (journal audit). */
  previous: EffectiveConfig; proposed: EffectiveConfig;
  at: string;
};
export type ConfigureNative = {
  status: 'applied' | 'unchanged'; restarted: boolean; effective: EffectiveConfig; threadId: string;
  workflow: SessionSnapshot['workflow']; teamLabel?: string; native?: { model?: string; reasoningEffort?: string };
};
export type ConfigureAnswer = { session: SessionSummary; configured: ConfigureOutcome };

export type RewindPlan = {
  root: string; beforeTurnId: string; cut: number; branchId: string; turns: number; at: string;
  previous: NativeBinding; cwd: string; marker?: number;
  /** The root's turn ids prepare checked, in order: the native step cuts against these, never a later read. */
  turnIds: string[];
};
export type ForkPlan = {
  /** New attempts distinguish recoverable pre-record crashes from ambiguous legacy absence. */
  recoveryVersion?: 1;
  source: string; newSessionId: string; branchId?: string; cut: number; boundary: ForkProvenance['boundary']; turnId?: string;
  cwd: string; workspaceId?: string; title: string; at: string; attachmentIds: string[];
  /** The source's turn ids prepare checked, and the runtime cut (a whole fork is cut through its last turn). */
  turnIds: string[]; cutoff?: { throughTurnId: string } | { beforeTurnId: string };
};

export const busy = (rootId: string, why: string) => new RpcError(ERROR.conflict, `Session ${rootId} is busy: ${why}; try again when it is idle`, { reason: 'session_busy' } satisfies { reason: string });

/** A runtime's refusal as a protocol error; an unknown outcome stays marked so the journal records it. */
export function refusal(error: any) {
  if (error instanceof RpcError) return error;
  const reason = error?.data?.reason;
  const message = error instanceof Error ? error.message : String(error);
  if (error?.outcomeUnknown === true) return Object.assign(new RpcError(ERROR.conflict, message, { reason: 'outcome_unknown' }), { outcomeUnknown: true });
  if (reason === 'session_busy') return new RpcError(ERROR.conflict, message, { reason });
  if (reason === 'runtime_unsupported' || reason === 'boundary_unmapped' || reason === 'empty_prefix' || reason === 'native_refused') return new RpcError(ERROR.unavailable, message, { reason });
  return new RpcError(ERROR.unavailable, `The runtime refused it: ${message}`, { reason: 'native_refused' });
}

/**
 * A refusal of a live configure as a protocol error (§12.9): another runtime or agent is unavailable with
 * a way on (a new session), more permissions forbidden, an unknown team not found, a malformed change
 * invalid; the rest as refusal() maps them.
 */
export function configureRefusal(error: any) {
  if (error instanceof RpcError) return error;
  const reason = error?.data?.reason;
  const message = error instanceof Error ? error.message : String(error?.message ?? error);
  if (error?.outcomeUnknown === true) return refusal(error);
  if (reason === 'runtime_mismatch' || reason === 'agent_mismatch') return new RpcError(ERROR.unavailable, message, { reason, action: 'session.create' });
  if (reason === 'permission_escalation') return new RpcError(ERROR.forbidden, message, { reason });
  if (reason === 'team_not_found') return new RpcError(ERROR.notFound, message, { reason });
  if (reason === 'invalid_params' || reason === 'not_root') return new RpcError(RPC_ERROR.invalidParams, message, { reason: 'invalid_params' });
  if (reason === 'session_busy' && /not open/.test(message)) return new RpcError(ERROR.unavailable, 'The session is not open; open it (session.create { resume: true }), then change its configuration', { reason: 'session_closed' });
  return refusal(error);
}
