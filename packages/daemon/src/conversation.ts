import { randomBytes } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { ERROR, RPC_ERROR } from '@anhlp/alp-protocol';
import type { AlpRuntime, Envelope, NativeBinding, SessionSnapshot } from '@anhlp/alp-runtime/index';
import type { ConversationBranch, ForkProvenance, SessionSummary } from '@anhlp/alp-protocol/session';
import type { RpcMethodMap } from '@anhlp/alp-protocol/rpc';
import type { SessionRecord, Store, StoredBranch } from './store.js';
import type { RegistryService } from './registry.js';
import { RegistryError } from './registry.js';
import type { Principal } from './attachments.js';
import { createLifecycle, type LifecycleEntry, type LifecycleJournal } from './lifecycle.js';
import { RpcError } from './rpc-error.js';

/**
 * session.fork and session.rewind (docs/protocol/alp-json-rpc-v1.md §12.7): a root's conversation cut
 * at a turn becomes a new root (fork), or the root itself continues from before a turn (rewind) while
 * the later turns stay a recoverable branch. Only the conversation changes: no file is copied, restored
 * or changed. Both run through the lifecycle journal (lifecycle.ts) and never send the native step twice.
 *
 * A turn of a root is what its timeline holds: `prompt.accepted` (result turn) or `turn.started`, from
 * the turn's user message on; its end is `turn.ended`. A cut keeps the timeline's lines before the
 * first line of the turn that is cut away.
 */

/** Events of a conversation; a fork's timeline holds these of the source root only. */
const CONVERSATION = new Set(['item', 'turn.started', 'turn.ended', 'prompt.accepted', 'prompt.failed']);
/** Runtimes whose native conversations alpd forks and rewinds (Codex and Claude, macOS and Linux). */
const SUPPORTED = new Set(['codex', 'claude']);
/** How many branches a summary lists; all stay recoverable by id. */
const LISTED_BRANCHES = 100;

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
    authorize(principal: Principal, attachmentIds: string[]): Promise<void>;
    pin(holder: string, sessionId: string, attachmentIds: string[], kind?: string): Promise<void>;
  };
  crashPoint(name: string): void;
  log: { warn(message: string, fields?: Record<string, unknown>): void; info(message: string, fields?: Record<string, unknown>): void };
  startedAt: string;
};

type ForkParams = RpcMethodMap['session.fork']['params'];
type RewindParams = RpcMethodMap['session.rewind']['params'];

type RewindPlan = {
  root: string; beforeTurnId: string; cut: number; branchId: string; turns: number; at: string;
  previous: NativeBinding; cwd: string; marker?: number;
  /** The root's turn ids prepare checked, in order: the native step cuts against these, never a later read. */
  turnIds: string[];
};
type ForkPlan = {
  source: string; newSessionId: string; branchId?: string; cut: number; boundary: ForkProvenance['boundary']; turnId?: string;
  cwd: string; workspaceId?: string; title: string; at: string; attachmentIds: string[];
  /** The source's turn ids prepare checked, and the runtime cut (a whole fork is cut through its last turn). */
  turnIds: string[]; cutoff?: { throughTurnId: string } | { beforeTurnId: string };
};

const busy = (rootId: string, why: string) => new RpcError(ERROR.conflict, `Session ${rootId} is busy: ${why}; try again when it is idle`, { reason: 'session_busy' } satisfies { reason: string });

/** A runtime's refusal as a protocol error; an unknown outcome stays marked so the journal records it. */
function refusal(error: any) {
  if (error instanceof RpcError) return error;
  const reason = error?.data?.reason;
  const message = error instanceof Error ? error.message : String(error);
  if (error?.outcomeUnknown === true) return Object.assign(new RpcError(ERROR.conflict, message, { reason: 'outcome_unknown' }), { outcomeUnknown: true });
  if (reason === 'session_busy') return new RpcError(ERROR.conflict, message, { reason });
  if (reason === 'runtime_unsupported' || reason === 'boundary_unmapped' || reason === 'empty_prefix' || reason === 'native_refused') return new RpcError(ERROR.unavailable, message, { reason });
  return new RpcError(ERROR.unavailable, `The runtime refused it: ${message}`, { reason: 'native_refused' });
}

export function createConversation(ctx: ConversationContext) {
  const { runtime, store, journal, records } = ctx;
  const lifecycle = createLifecycle(journal, { crashPoint: ctx.crashPoint });
  // Proven on macOS and Linux only (issue #121 closure scope); Windows does not list the capabilities.
  const enabled = typeof runtime.branch === 'function' && typeof runtime.rebind === 'function' && process.platform !== 'win32';

  /** A root alpd can fork or rewind, or the reason it cannot. */
  function support(record: SessionRecord, session: SessionSnapshot | undefined): SessionSummary['conversation'] {
    if (record.rootId !== record.id || session?.parentId) return { fork: false, rewind: false, reason: 'not_root' };
    if (!session || !SUPPORTED.has(session.runtime) || !enabled) return { fork: false, rewind: false, reason: 'runtime_unsupported' };
    if (!session.persistent || !session.threadId || !record.spec) return { fork: false, rewind: false, reason: 'not_persistent' };
    return { fork: true, rewind: true };
  }

  /** The record of a root alpd may fork or rewind, refused with the reason otherwise. */
  function rootOf(sessionId: string) {
    const record = records.get(sessionId);
    if (!record) throw new RpcError(ERROR.notFound, `No session ${sessionId}`, { reason: 'not_found' });
    const live = runtime.snapshot(sessionId);
    const allowed = support(record, live ?? record.session);
    if (allowed?.reason === 'not_root') throw new RpcError(RPC_ERROR.invalidParams, 'Only a root session\'s conversation can be forked or rewound', { reason: 'invalid_params' });
    if (allowed?.reason === 'runtime_unsupported') throw new RpcError(ERROR.unavailable, `alpd cannot fork or rewind a ${(live ?? record.session)?.runtime ?? 'session'} conversation`, { reason: 'runtime_unsupported' });
    if (allowed?.reason === 'not_persistent') throw new RpcError(ERROR.unavailable, 'This session keeps no native conversation to fork or rewind', { reason: 'runtime_unsupported' });
    return record;
  }

  /** The binding the root continues now: the live session's thread, else the record's. */
  function bindingOf(record: SessionRecord): NativeBinding {
    const threadId = runtime.snapshot(record.id)?.threadId || record.session!.threadId;
    return { threadId, ...(record.base ? { base: record.base } : {}) };
  }

  async function generationOf(root: string) {
    return (await store.history(root, root, { limit: 1 })).generation;
  }

  async function checkGeneration(root: string, expected: string) {
    if (await generationOf(root) !== expected) throw new RpcError(ERROR.conflict, 'The conversation changed since this view (history generation); refresh and try again', { reason: 'stale_generation' });
  }

  const turnNotFound = (turnId: string) => new RpcError(ERROR.notFound, `No turn ${turnId} in this conversation`, { reason: 'turn_not_found' });
  const inProgress = (turnId?: string) => new RpcError(ERROR.conflict, turnId ? `Turn ${turnId} has not ended` : 'A turn of this conversation has not ended', { reason: 'turn_in_progress' });
  const emptyPrefix = () => new RpcError(ERROR.unavailable, 'Nothing comes before the first turn; start a new session instead', { reason: 'empty_prefix' });

  /** The timeline a fork or rewind reads: the root's, or a branch's. */
  async function timelineOf(root: string, branch?: StoredBranch) {
    return branch ? store.branchTimeline(root, branch.branchId) : store.timeline(root);
  }

  // ------------------------------------------------------------------ rewind

  /**
   * Roots whose rewind answered from the runtime but whose commit alpd could not finish: the root's
   * timeline may already be cut while its record still names the old conversation. Prompts and reopens
   * are refused until the same request is sent again (or alpd's next start) finishes the commit.
   */
  const fences = new Map<string, string>();

  async function rewind(params: RewindParams) {
    const { sessionId, requestId, ifGeneration, beforeTurnId } = params;
    const fingerprint = ctx.digest({ beforeTurnId });
    const release = ctx.holdPrompts(sessionId);
    let releaseWakes: (() => void) | undefined;
    try {
      const { result, duplicate, entry } = await lifecycle.run<RewindPlan, NativeBinding, RpcMethodMap['session.rewind']['result']>(
        { resource: sessionId, operation: 'rewind', requestId, fingerprint }, {
          async prepare() {
            const record = rootOf(sessionId);
            const unsettled = ctx.unsettled(sessionId);
            if (unsettled) throw busy(sessionId, unsettled);
            const live = runtime.snapshot(sessionId);
            if (live?.busy) throw busy(sessionId, 'a turn, child, assignment, mail or parked work is in progress');
            if (runtime.questions().some(question => question.rootId === sessionId)) throw busy(sessionId, 'a question waits for an answer');
            await checkGeneration(sessionId, ifGeneration);
            const turns = turnsOf(await store.timeline(sessionId), sessionId);
            const index = turns.findIndex(turn => turn.id === beforeTurnId);
            if (index < 0) throw turnNotFound(beforeTurnId);
            if (index === 0) throw emptyPrefix();
            const running = turns.find(turn => turn.state === undefined);
            if (running) throw inProgress(running.id);
            // From here to the rebind the runtime starts no turn of its own on the root (mail waits).
            releaseWakes = runtime.hold?.(sessionId);
            return {
              root: sessionId, beforeTurnId, cut: turns[index].start, branchId: `br_${randomBytes(8).toString('hex')}`, turns: turns.length - index,
              at: new Date().toISOString(), previous: bindingOf(record), cwd: record.spec!.cwd, turnIds: turns.map(turn => turn.id),
            };
          },
          async apply(plan) {
            const record = records.get(plan.root)!;
            const session = runtime.snapshot(plan.root) ?? record.session!;
            try {
              return await runtime.branch!({ runtime: session.runtime, source: plan.previous, cwd: plan.cwd, model: session.model, thinking: session.thinking, mode: session.mode, cutoff: { beforeTurnId: plan.beforeTurnId }, turns: plan.turnIds });
            } catch (error) { throw refusal(error); }
          },
          commit: commitRewind,
          repeat: entry => ({ ...entry.result!, session: ctx.summary(entry.plan.root) ?? entry.result!.session }),
        });
      // Only the rewind that fenced the root lifts the fence: a repeat of an older one does not.
      if (fences.get(sessionId) === requestId) fences.delete(sessionId);
      if (!duplicate) await afterRewind(entry);
      // The session as it is now: after afterRewind a live root runs the new conversation.
      return { ...result, session: ctx.summary(sessionId) ?? result.session, ...(duplicate ? { duplicate: true as const } : {}) };
    } catch (error) {
      // The runtime answered but alpd's commit did not finish: no prompt may reach the old conversation now.
      if ((await journal.get(sessionId, 'rewind', requestId).catch(() => undefined))?.state === 'applied') await fence(sessionId, requestId);
      throw error;
    } finally {
      releaseWakes?.();
      release();
    }
  }

  /** Fences a root whose rewind commit is unfinished: a live root closes, prompts and reopens are refused. */
  async function fence(root: string, requestId: string) {
    fences.set(root, requestId);
    ctx.log.warn(`the rewind ${requestId} of ${root} is applied but not committed; the session waits for it to be sent again`, { code: 'ALPD_REWIND_FENCED', sessionId: root });
    if (runtime.snapshot(root)) await runtime.close(root).catch(() => {});
  }

  /** alpd's side of a rewind, from its journal entry alone: idempotent, so a restart finishes it. */
  async function commitRewind(entry: LifecycleEntry<RewindPlan, NativeBinding>) {
    const plan = entry.plan;
    const native = entry.native!;
    const record = records.get(plan.root);
    if (!record?.session) throw new Error(`session ${plan.root} is gone`);
    if (plan.marker === undefined) {
      // The marker's cursor follows every cursor this tree has had, and is journaled before the timeline
      // changes, so a crash in between finishes with the same one.
      const stored = await store.timeline(plan.root);
      plan.marker = Math.max(ctx.cursors.get(plan.root) ?? 0, stored.at(-1)?.cursor ?? 0) + 1;
      ctx.cursors.set(plan.root, plan.marker);
      await journal.put(entry);
    } else if ((ctx.cursors.get(plan.root) ?? 0) < plan.marker) ctx.cursors.set(plan.root, plan.marker);
    ctx.crashPoint('rewind.before-timeline');
    await store.rewind(plan.root, { cut: plan.cut, branchId: plan.branchId, marker: rewindMarker(plan) });
    ctx.crashPoint('rewind.after-timeline');
    const branch: StoredBranch = { branchId: plan.branchId, beforeTurnId: plan.beforeTurnId, turns: plan.turns, at: plan.at, threadId: plan.previous.threadId, ...(plan.previous.base ? { base: plan.previous.base } : {}), cut: plan.cut, marker: plan.marker };
    if (!(record.branches ?? []).some(candidate => candidate.branchId === plan.branchId)) record.branches = [...(record.branches ?? []), branch];
    record.session = { ...record.session, threadId: native.threadId };
    if (native.base) record.base = native.base; else delete record.base;
    record.updatedAt = new Date().toISOString();
    await store.put(record);
    if (ctx.logs.has(plan.root)) ctx.logs.set(plan.root, (await store.timeline(plan.root)).slice(-ctx.treeLogLimit));
    return { session: ctx.summary(plan.root)!, generation: await generationOf(plan.root), branch: publicBranch(branch) };
  }

  function rewindMarker(plan: RewindPlan): Envelope {
    return {
      sessionId: plan.root, epoch: `rewind-${plan.branchId}`, seq: 0, ts: plan.at, cursor: plan.marker!,
      event: { type: 'item', item: { kind: 'notice', id: `rewind:${plan.branchId}`, level: 'info', text: `Conversation rewound to before a message: ${plan.turns} later turn${plan.turns === 1 ? '' : 's'} moved to a recoverable branch. Files were not changed.` } },
    };
  }

  /** After a rewind is committed: attached clients reset their history; a live root moves to the new conversation. */
  async function afterRewind(entry: LifecycleEntry<RewindPlan, NativeBinding>) {
    const plan = entry.plan;
    const generation = (entry.result as any)?.generation as string | undefined;
    if (generation) ctx.broadcast(plan.root, { sessionId: plan.root, epoch: `rewind-${plan.branchId}`, seq: 0, ts: new Date().toISOString(), event: { type: 'history.reset', generation, reason: 'rewind', branchId: plan.branchId } });
    ctx.broadcast(plan.root, rewindMarker(plan));
    if (!runtime.snapshot(plan.root)) return;
    try {
      await runtime.rebind!(plan.root, entry.native!);
    } catch (error) {
      // The record already names the new conversation; a live session left on the old one would write
      // there, so it closes, and the next open continues the new conversation.
      ctx.log.warn(`could not move ${plan.root} to its rewound conversation; closing it`, { code: 'ALPD_REWIND_REBIND_FAILED', sessionId: plan.root, error });
      await runtime.close(plan.root).catch(() => {});
    }
  }

  // ------------------------------------------------------------------ fork

  async function fork(params: ForkParams & { principal: Principal }) {
    const { sessionId, requestId, ifGeneration, boundary, branchId, workspaceId, newSessionId, title, principal } = params;
    const fingerprint = ctx.digest({ boundary: boundary ?? null, branchId: branchId ?? null, workspaceId: workspaceId ?? null, newSessionId: newSessionId ?? null, title: title ?? null });
    // A fork that keeps the latest turn reads the source up to its end: from its prepare on, no prompt,
    // reopen or wake may land in between (released when it answers).
    let release: (() => void) | undefined;
    let releaseWakes: (() => void) | undefined;
    try {
    const { result, duplicate } = await lifecycle.run<ForkPlan, NativeBinding, RpcMethodMap['session.fork']['result']>(
      { resource: sessionId, operation: 'fork', requestId, fingerprint }, {
        async prepare() {
          const record = rootOf(sessionId);
          await checkGeneration(sessionId, ifGeneration);
          const branch = branchId === undefined ? undefined : record.branches?.find(candidate => candidate.branchId === branchId);
          if (branchId !== undefined && !branch) throw new RpcError(ERROR.notFound, `No branch ${branchId} of this session`, { reason: 'branch_not_found' });
          const log = await timelineOf(sessionId, branch);
          const turns = turnsOf(log, sessionId);
          const last = log.at(-1)?.cursor ?? 0;
          let cut: number;
          let kind: ForkProvenance['boundary'] = 'whole';
          let turnId: string | undefined;
          if (boundary && 'throughTurnId' in boundary) {
            const index = turns.findIndex(turn => turn.id === boundary.throughTurnId);
            if (index < 0) throw turnNotFound(boundary.throughTurnId);
            if (turns.slice(0, index + 1).some(turn => turn.state === undefined)) throw inProgress(boundary.throughTurnId);
            cut = turns[index + 1]?.start ?? last + 1;
            kind = 'through'; turnId = boundary.throughTurnId;
          } else if (boundary && 'beforeTurnId' in boundary) {
            const index = turns.findIndex(turn => turn.id === boundary.beforeTurnId);
            if (index < 0) throw turnNotFound(boundary.beforeTurnId);
            if (index === 0) throw emptyPrefix();
            if (turns.slice(0, index).some(turn => turn.state === undefined)) throw inProgress();
            cut = turns[index].start;
            kind = 'before'; turnId = boundary.beforeTurnId;
          } else {
            if (!turns.length) throw emptyPrefix();
            const running = turns.find(turn => turn.state === undefined);
            if (running) throw inProgress(running.id);
            cut = last + 1;
          }
          // The cut keeps the source's latest turn (a whole fork, or through its last one): the live source
          // must stay idle until the native step read it, as for a rewind.
          const latest = !branch && cut > (turns.at(-1)?.start ?? 0);
          if (latest) {
            release = ctx.holdPrompts(sessionId);
            const unsettled = ctx.unsettled(sessionId);
            if (unsettled) throw busy(sessionId, unsettled);
            if (runtime.snapshot(sessionId)?.activeTurnId) throw inProgress();
            // A turn that started and ended before the hold: the cut no longer keeps the latest turn.
            const now = turnsOf(await timelineOf(sessionId, branch), sessionId);
            if (now.length !== turns.length || now.some((turn, index) => turn.id !== turns[index].id)) throw busy(sessionId, 'its conversation changed while the fork was prepared');
            releaseWakes = runtime.hold?.(sessionId);
          }
          const latestTurn = turns.at(-1)?.id;
          const cutoff: ForkPlan['cutoff'] = kind === 'through' ? { throughTurnId: turnId! } : kind === 'before' ? { beforeTurnId: turnId! } : latestTurn ? { throughTurnId: latestTurn } : undefined;
          const id = newSessionId ?? `ses_${randomBytes(8).toString('hex')}`;
          if (records.has(id) || runtime.snapshot(id)) throw new RpcError(ERROR.conflict, `Session ${id} already exists`, { reason: 'request_conflict' });
          const cwd = await destinationOf(record, workspaceId);
          const attachmentIds = await reauthorize(sessionId, log, cut, principal);
          return {
            source: sessionId, newSessionId: id, ...(branchId ? { branchId } : {}), cut, boundary: kind, ...(turnId ? { turnId } : {}),
            cwd, ...(workspaceId ? { workspaceId } : {}), title: title ?? defaultForkTitle(record.title, cwd === record.spec!.cwd), at: new Date().toISOString(), attachmentIds,
            turnIds: turns.map(turn => turn.id), ...(cutoff ? { cutoff } : {}),
          };
        },
        async apply(plan) {
          const record = records.get(plan.source)!;
          const session = runtime.snapshot(plan.source) ?? record.session!;
          const branch = plan.branchId ? record.branches?.find(candidate => candidate.branchId === plan.branchId) : undefined;
          const source: NativeBinding = branch ? { threadId: branch.threadId, ...(branch.base ? { base: branch.base } : {}) } : bindingOf(record);
          try {
            return await runtime.branch!({ runtime: session.runtime, source, cwd: record.spec!.cwd, ...(plan.cwd !== record.spec!.cwd ? { targetCwd: plan.cwd } : {}), model: session.model, thinking: session.thinking, mode: session.mode, ...(plan.cutoff ? { cutoff: plan.cutoff } : {}), turns: plan.turnIds });
          } catch (error) { throw refusal(error); }
        },
        commit: commitFork,
        repeat: entry => ({ ...entry.result!, session: ctx.summary(entry.plan.newSessionId) ?? entry.result!.session }),
      });
    return { ...result, ...(duplicate ? { duplicate: true as const } : {}) };
    } finally {
      releaseWakes?.();
      release?.();
    }
  }

  /** Where a fork runs: the source's directory, or a registered workspace of the same project. */
  async function destinationOf(record: SessionRecord, workspaceId: string | undefined) {
    if (workspaceId === undefined) return record.spec!.cwd;
    const registry = ctx.registry;
    if (!registry) throw new RpcError(RPC_ERROR.invalidParams, 'This alpd keeps no workspace registry', { reason: 'invalid_params' });
    try {
      const cwd = await registry.resolve(workspaceId);
      const snapshot = await registry.snapshot();
      const target = snapshot.workspaces.find(candidate => candidate.id === workspaceId);
      const placed = snapshot.sessions[record.id];
      const from = placed ? snapshot.workspaces.find(candidate => candidate.id === placed) : undefined;
      if (from && target && from.projectId !== target.projectId) throw new RpcError(ERROR.conflict, 'A fork stays in the project of its source', { reason: 'workspace_mismatch' });
      await ctx.worktrees?.assertAvailable(cwd);
      return cwd;
    } catch (error) {
      if (error instanceof RegistryError) throw new RpcError(error.code, error.message, error.data);
      throw error;
    }
  }

  /**
   * The attachments the kept prompts pinned, re-authorized for the caller (each committed and bound to
   * this principal and an authorized project), so the fork may pin them too (§12.6). Refused otherwise.
   */
  async function reauthorize(source: string, log: Envelope[], cut: number, principal: Principal) {
    if (!ctx.attachments) return [];
    // A prompt copied into a fork keeps the receipt holder of the session it was first sent to: the kept
    // prompts are looked up under the source and every session it was forked from.
    const lineage: string[] = [];
    for (let id: string | undefined = source; id && !lineage.includes(id) && lineage.length < 32; id = records.get(id)?.forkedFrom?.sessionId) lineage.push(id);
    const holders: string[] = [];
    for (const { sessionId, cursor, event } of log) {
      if (sessionId !== source || (cursor ?? 0) >= cut || event.type !== 'item' || event.item.kind !== 'user_message' || !event.item.clientMessageId) continue;
      for (const id of lineage) holders.push(`prompt:${ctx.digest(['prompt', id, event.item.clientMessageId])}`);
    }
    const ids = await ctx.attachments.heldBy(holders);
    if (!ids.length) return [];
    try { await ctx.attachments.authorize(principal, ids); }
    catch { throw new RpcError(ERROR.forbidden, 'The conversation holds attachments this caller may not use', { reason: 'attachment_forbidden' }); }
    return ids;
  }

  /** alpd's side of a fork, from its journal entry alone: the new root's timeline, record, placement and attachment references. */
  async function commitFork(entry: LifecycleEntry<ForkPlan, NativeBinding>) {
    const plan = entry.plan;
    const native = entry.native!;
    const source = records.get(plan.source);
    if (!source?.session || !source.spec) throw new Error(`session ${plan.source} is gone`);
    const forkedFrom: ForkProvenance = { sessionId: plan.source, ...(plan.turnId ? { turnId: plan.turnId } : {}), boundary: plan.boundary, ...(plan.branchId ? { branchId: plan.branchId } : {}), at: plan.at };
    if (!records.has(plan.newSessionId)) {
      const branch = plan.branchId ? source.branches?.find(candidate => candidate.branchId === plan.branchId) : undefined;
      const kept = (await timelineOf(plan.source, branch)).filter(envelope => envelope.sessionId === plan.source && (envelope.cursor ?? 0) < plan.cut && CONVERSATION.has(envelope.event.type));
      const envelopes: Envelope[] = kept.map((envelope, index) => ({ ...envelope, sessionId: plan.newSessionId, cursor: index + 1 }));
      envelopes.push({
        sessionId: plan.newSessionId, epoch: `fork-${plan.newSessionId}`, seq: 0, ts: plan.at, cursor: envelopes.length + 1,
        // No source title or id here: a viewer granted the fork but not its source must not learn them.
        event: { type: 'item', item: { kind: 'notice', id: `fork:${plan.newSessionId}`, level: 'info', text: `Forked from another session${plan.boundary === 'whole' ? '' : plan.boundary === 'through' ? ' through a turn' : ' before a turn'}. Files were not copied or changed.` } },
      });
      ctx.crashPoint('fork.before-timeline');
      await store.createTimeline(plan.newSessionId, envelopes);
      const { activeTurnId: _active, parked: _parked, usage: _usage, toolCallId: _call, parentId: _parent, ...kept_ } = source.session;
      const moved = plan.cwd !== source.spec.cwd;
      const now = new Date().toISOString();
      const record: SessionRecord = {
        version: 1, id: plan.newSessionId, rootId: plan.newSessionId, spec: { ...source.spec, cwd: plan.cwd }, ...(source.delegation !== undefined ? { delegation: source.delegation } : {}),
        session: { ...kept_, id: plan.newSessionId, threadId: native.threadId, busy: false, ...(moved ? { projectRoot: await realpath(plan.cwd).catch(() => path.resolve(plan.cwd)) } : {}) },
        status: 'closed', title: plan.title, forkedFrom, ...(native.base ? { base: native.base } : {}), createdAt: now, updatedAt: now,
      };
      ctx.crashPoint('fork.before-record');
      await store.put(record);
      records.set(record.id, record);
    }
    await place(plan, entry.key);
    if (plan.attachmentIds.length) await ctx.attachments?.pin(`fork:${plan.newSessionId}`, plan.newSessionId, plan.attachmentIds, 'fork');
    return { session: ctx.summary(plan.newSessionId)!, forkedFrom };
  }

  /** The fork's place in the registry: the destination workspace, else its source's, else its directory's. */
  async function place(plan: ForkPlan, key: string) {
    const registry = ctx.registry;
    if (!registry) return;
    try {
      const snapshot = await registry.snapshot();
      if (Object.hasOwn(snapshot.sessions, plan.newSessionId)) return;
      const workspaceId = plan.workspaceId ?? (Object.hasOwn(snapshot.sessions, plan.source) ? snapshot.sessions[plan.source] : undefined);
      if (workspaceId) await registry.mutate('placement.assign', { sessionId: plan.newSessionId, workspaceId }, { requestId: `fork:${key}` });
      else await registry.mutate('placement.prepare', { sessions: [{ id: plan.newSessionId, projectRoot: plan.cwd }] }, { requestId: `fork:${key}` });
    } catch (error) {
      if (error instanceof RegistryError) throw new RpcError(error.code, error.message, error.data);
      throw error;
    }
  }

  function publicBranch({ branchId, beforeTurnId, turns, at }: StoredBranch): ConversationBranch {
    return { branchId, beforeTurnId, turns, at };
  }

  return {
    enabled,
    /** The fields session summaries carry for a record (§12.7). */
    fields(record: SessionRecord, session: SessionSnapshot | undefined): Partial<SessionSummary> {
      if (!enabled) return {};
      return {
        conversation: support(record, session),
        ...(record.forkedFrom ? { forkedFrom: record.forkedFrom } : {}),
        ...(record.branches?.length ? { branches: record.branches.slice(-LISTED_BRANCHES).map(publicBranch) } : {}),
      };
    },
    /** Whether `after` lies in history a rewind set aside: such a client must start over (attach reset). */
    discarded(record: SessionRecord | undefined, after: number) {
      return !!record?.branches?.some(branch => after >= branch.cut && after < branch.marker);
    },
    fork,
    rewind,
    /** The requestId of a rewind whose commit is unfinished for this root: prompts and reopens wait for it. */
    fenced: (root: string) => fences.get(root),
    /** At start, before requests: finish or settle what a crash left (lifecycle.recover); a rewind left applied fences its root. */
    async recover() {
      const unfinished = await lifecycle.recover({ rewind: entry => commitRewind(entry as LifecycleEntry<RewindPlan, NativeBinding>), fork: entry => commitFork(entry as LifecycleEntry<ForkPlan, NativeBinding>) },
        (message, fields) => ctx.log.warn(message, fields));
      for (const entry of unfinished) if (entry.operation === 'rewind') fences.set(entry.resource, entry.requestId);
    },
    lifecycle,
  };
}
