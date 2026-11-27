import { createRegistry, RegistryError } from './workspaces/registry.ts';
import { createWorkspaceWorktrees } from './workspaces/worktrees.ts';
import { randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir, unlink, lstat, rename } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import { assertPrivateDirectory, assertPrivateSocket } from '@anhlp/alp-client/index';
import path from 'node:path';
import { createLogger } from '@anhlp/alp-core/log';
import { AGENT_NAME, AlpRpcError, CAPABILITY, MAX_FRAME, PROTOCOL_VERSION, ERROR, RPC_ERROR, RPC_METHODS, encodeFrame } from '@anhlp/alp-protocol';
import { validateParams } from '@anhlp/alp-protocol/contract';
export { ERROR } from '@anhlp/alp-protocol';
import { type ModelCatalog, type AlpEvent, type AlpRuntime, type Envelope, type SessionSnapshot } from '@anhlp/alp-runtime/index';
import { replayedNotice } from '@anhlp/alp-runtime/mailbox';
import type { Receipt, SessionRecord, SessionStatus, Store, UnreadableReceipt } from './persistence/store.ts';
import type { PromptContent, SessionSummary } from '@anhlp/alp-protocol/session';
import type { ScheduleJob, TurnAttention } from '@anhlp/alp-protocol/index';
import { RpcError } from './rpc/rpc-error.ts';
import { agentRefused, digest, frameBytes, invalidParams, persistenceFailed, validId } from './rpc/helpers.ts';
import type { Connection } from './rpc/connection.ts';
import { createOperations, type OperationsOptions } from './operations/operations.ts';
import { createFindPages } from './workspaces/files.ts';
import { createGitReader } from './workspaces/git.ts';
import { createScheduleStore, projectKey } from './schedules/schedules.ts';
import { createScheduleHandlers } from './schedules/rpc/handlers.ts';
import { createSessionHandlers } from './sessions/rpc/handlers.ts';
import { createWorkspaceHandlers } from './workspaces/rpc/handlers.ts';
import { createTerminalHandlers } from './terminals/rpc/handlers.ts';
import { createAttachmentHandlers } from './attachments/rpc/handlers.ts';
import { createCatalogHandlers } from './catalog/rpc/handlers.ts';
import { createAttachmentStore, type AttachmentRuntime, type AttachmentStoreOptions } from './attachments/attachments.ts';
import { clientMessageId as scheduleMessageId, createScheduler, SCHEDULE_TICK_MS, type ScheduleDelivery } from './schedules/scheduler.ts';
import { createLifecycleJournal, LIFECYCLE_RETENTION_MS } from './persistence/lifecycle.ts';
import { createConversation } from './sessions/conversation.ts';
import { createTerminalService, type TerminalServiceOptions } from './terminals/terminals.ts';

/**
 * alpd's JSON-RPC surface over one shared runtime (plans/reference/ALPD.md §3, §6, §14).
 * Clients attach to root sessions to receive the events of the whole tree. A root
 * with no attached client is closed as soon as it is idle, so work started by a
 * viewer finishes even after the viewer goes away. With a store, every session is
 * recorded and every tree's events are kept, so a closed root can be resumed later.
 */



const log = createLogger({ component: 'alpd.ipc' });
const recoveryLog = createLogger({ component: 'alpd.recovery' });


/**
 * Crash points for the crash-recovery tests (ALPD §66): with ALP_TEST_CRASH_AT naming one,
 * alpd kills itself there as a crash would. Unset, they do nothing.
 */
function crashPoint(name: string) {
  if (process.env.ALP_TEST_CRASH_AT !== name) return;
  createLogger({ component: 'alpd' }).error(`ALP_TEST_CRASH_AT=${name}: killing alpd`, { code: 'ALP_TEST_CRASH' });
  process.kill(process.pid, 'SIGKILL');
}

/** Retained events per live tree, for attach and replay. */
const TREE_LOG_LIMIT = 20_000;
/** The daemon.hello capability a process an ALP agent started announces (t-ca1f; the client's handshake sends it). */
const AGENT_CAPABILITY = 'principal.agent';
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** How often a running alpd applies retention, besides at start (ALPD §68). */
const RETENTION_SWEEP_MS = 6 * 60 * 60 * 1000;
const LIVE: SessionStatus[] = ['initializing', 'idle', 'running'];
const PROMPT_TITLE_CHARS = 60;

/**
 * A root's name from its first prompt, as Paseo names an agent (server/agent/create-agent-title.ts
 * at b63a325): the first non-blank line, whitespace folded, at most 60 characters, no ellipsis.
 * Counted in code points, where Paseo counts UTF-16 units, so a cut never splits a character.
 */
function titleFromPrompt(text: string): string | undefined {
  const line = text.split(/\r?\n/).map(entry => entry.replace(/\s+/g, ' ').trim()).find(Boolean);
  return line ? [...line].slice(0, PROMPT_TITLE_CHARS).join('').trim() || undefined : undefined;
}

/**
 * Whether a message is the user's own words, which alone may name a root: ALP's mail, briefs,
 * resumes and scheduled jobs (`alp-` ids) never do. A runtime says who wrote it in `origin`;
 * without it, only a message a client sent (its clientMessageId) counts, so a replayed message
 * nobody can place does not.
 */
function fromUser(item: { origin?: string; clientMessageId?: string }) {
  if (item.clientMessageId?.startsWith('alp-')) return false;
  return item.origin !== undefined ? item.origin === 'user' : item.clientMessageId !== undefined;
}

/** What clients need from a daemon connection; AlpClient implements it over the socket. */
import type { DaemonConnection } from '@anhlp/alp-protocol/connection';
export type { DaemonConnection } from '@anhlp/alp-protocol/connection';

export type DaemonServer = {
  listen(): Promise<void>;
  /** An in-process connection that delivers events synchronously, for embedding. */
  local(): DaemonConnection;
  /**
   * A connection over another transport, such as the web app's WebSocket (ALPD §61):
   * it says daemon.hello first, as a socket client does, and gets JSON-RPC messages back through `send`.
   */
  accept(send: (message: unknown) => void): { receive(message: unknown): void; close(): void };
  /** Adds a method that lives outside the runtime, such as the web app's pairing link (ALPD §64). */
  extend(method: string, handler: (params: any) => Promise<unknown> | unknown): void;
  close(): Promise<void>;
};

/** A session as clients list it: its last snapshot plus lifecycle (ALPD §18). The protocol owns the
 * shape so every viewer agrees; re-exported here to keep `@anhlp/alp-daemon/server`'s API. */
export type { SessionSummary };

export function createDaemonServer({ runtime, socketPath, version, onShutdown, store, runLogDir, previousExit, retentionSweepMs = RETENTION_SWEEP_MS, home, templates, scheduleTickMs = SCHEDULE_TICK_MS, scheduleDeliveryTimeoutMs, attachmentOptions, terminalOptions, modelCatalog, restoreOnListen = false }: {
  /** The live model catalog (t-e5ee); without it catalog.get answers the static rows and catalog.refresh is unavailable. */
  modelCatalog?: ModelCatalog;
  runtime: AlpRuntime;
  socketPath: string;
  version: string;
  onShutdown?: () => void;
  /** Durable records and timelines; without it sessions live only in memory. */
  store?: Store;
  /** Where crash reconciliation reports assignments it ends, as the runtime does. */
  runLogDir?: string;
  /** How the previous alpd ended, for daemon.status. */
  previousExit?: { kind: 'clean' | 'crash'; at?: string };
  /**
   * True starts the recovery (restore()) only once listen() has bound the endpoint, as alpd itself
   * asks: a start that cannot listen then settles no session record and reopens nothing, so the next
   * start still finds what the alpd before it left (t-11c7). Default false: at construction, for
   * hosts that never listen (an embedded server, tests on local()).
   */
  restoreOnListen?: boolean;
  /** How often retention runs while alpd runs (ALPD §68); tests shorten it. */
  retentionSweepMs?: number;
  /** The daemon user's ALP_HOME, for the library, team and settings methods; without it alpd does not serve them. */
  home?: OperationsOptions['home'];
  /** ALP's built-in agents and teams, for the library and team methods. */
  templates?: OperationsOptions['templates'];
  /** How often the scheduler looks for jobs whose time has come; tests shorten it. */
  scheduleTickMs?: number;
  /** How long a job's delivery may take; tests shorten it. */
  scheduleDeliveryTimeoutMs?: number;
  /** Lower attachment limits (an operator's, never higher than ATTACHMENTS) and test hooks. */
  attachmentOptions?: Partial<Pick<AttachmentStoreOptions, 'limits' | 'now' | 'io' | 'sweepMs'>>;
  /** Lower terminal limits (never higher than TERMINAL or the operator's) and test hooks. */
  terminalOptions?: Partial<Pick<TerminalServiceOptions, 'limits' | 'now' | 'spawn' | 'processes' | 'sweepMs' | 'killGraceMs' | 'maxBufferedBytes' | 'platform'>>;
}): DaemonServer {
  const connections = new Set<Connection>();
  // Every helloed connection learns that the catalog changed, and re-reads it (catalog.updated).
  const unsubscribeCatalog = modelCatalog?.onUpdated(snapshot => {
    for (const connection of connections) if (connection.helloed) { try { connection.send({ jsonrpc: '2.0', method: 'catalog.updated', params: { fetchedAt: snapshot.fetchedAt } }); } catch { /* a gone connection */ } }
  });
  /** Root of every live session. */
  const rootOf = new Map<string, string>();
  const attached = new Map<string, Set<Connection>>();
  const logs = new Map<string, Envelope[]>();
  const records = new Map<string, SessionRecord & { activeTurnId?: string }>();
  /** Prompt deliveries in flight, so a repeated clientMessageId waits for the first. */
  const delivering = new Map<string, Promise<object>>();
  /** Completed deliveries whose receipt could not be written; this process still answers them. */
  const unsaved = new Map<string, Receipt>();
  /** The last timeline cursor of each tree (ALPD §66). */
  const cursors = new Map<string, number>();
  let closing = false;
  let socketIdentity: { dev: number; ino: number } | undefined;
  /** Roots alpd reopens after a restart; they stay open until their recovery has started. */
  const recovering = new Map<string, Promise<void>>();
  const startedAt = new Date().toISOString();
  /** The clock of this daemon: the job store and the scheduler share it. */
  const clock = () => Date.now();
  /**
   * The scheduled continuations of this host; their own directory, beside the state.
   * They need the prompt receipt (the store) to deliver a job at most once, so a
   * daemon without a store serves no jobs at all.
   */
  const schedules = home && store ? createScheduleStore(path.join(home, 'schedules'), { now: clock }) : undefined;
  /**
   * Non-image attachments (§12.6): with a home and a store (prompt receipts pin their references),
   * never on Windows (no O_NOFOLLOW, no POSIX modes: not a supported platform for them).
   */
  const attachments = home && store && process.platform !== 'win32' ? createAttachmentStore({
    root: path.join(home, 'state', 'attachments'),
    sessionProject: sessionId => runtime.snapshot(sessionId)?.projectRoot ?? records.get(sessionId)?.session?.projectRoot,
    crashPoint,
    log: { warn: (message, fields) => log.warn(message, fields), info: (message, fields) => log.info(message, fields) },
    // A collected object's staged copy goes with it.
    onDiscard: attachmentId => (runtime as AlpRuntime & AttachmentRuntime).dropAttachment?.(attachmentId),
    ...attachmentOptions,
  }) : undefined;
  // The runtime side of the seam (issue #121 branch J): a runtime that takes attachment parts reads them through this.
  (runtime as AlpRuntime & AttachmentRuntime).bindAttachments?.(attachments?.reader);
  /**
   * Gates of roots whose conversation a lifecycle operation changes (a rewind): prompts, scheduled
   * deliveries and reopens of the root wait until it is through (§12.7).
   */
  const holds = new Map<string, { count: number; open: Promise<void>; release: () => void }>();
  // Conservatively invalidate in-flight attach reads even when a lifecycle hold ends during I/O.
  let holdRevision = 0;
  function holdPrompts(root: string) {
    holdRevision++;
    let gate = holds.get(root);
    if (!gate) {
      let release!: () => void;
      const open = new Promise<void>(resolve => { release = resolve; });
      gate = { count: 0, open, release };
      holds.set(root, gate);
    }
    gate.count++;
    const held = gate;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--held.count === 0) { if (holds.get(root) === held) holds.delete(root); held.release(); }
    };
  }
  /** Prompt deliveries in flight per root: a rewind refuses while one is on its way. */
  const promptsInFlight = new Map<string, number>();
  const rootIdOf = (sessionId: string) => rootOf.get(sessionId) ?? records.get(sessionId)?.rootId ?? sessionId;
  /** Waits while the root's conversation is being changed, then counts a delivery in flight until `run` settles. */
  async function gated<T>(sessionId: string, run: () => Promise<T>): Promise<T> {
    const root = rootIdOf(sessionId);
    while (holds.has(root)) await holds.get(root)!.open;
    refuseFenced(root);
    promptsInFlight.set(root, (promptsInFlight.get(root) ?? 0) + 1);
    try { return await run(); }
    finally {
      const left = (promptsInFlight.get(root) ?? 1) - 1;
      if (left > 0) promptsInFlight.set(root, left); else promptsInFlight.delete(root);
    }
  }
  /** A root whose rewind is applied but not committed takes no prompt or reopen until that rewind is sent again. */
  function fencedRoot(root: string): string | undefined { return conversation?.fenced(root); }
  function refuseFenced(root: string) {
    const requestId = fencedRoot(root);
    if (requestId !== undefined) throw new RpcError(ERROR.conflict, `A rewind of this session is not finished; send session.rewind again with requestId ${requestId}`, { reason: 'session_busy' });
  }
  /** Forks and rewinds of Codex and Claude conversations (§12.7): with a store, through the lifecycle journal. */
  const journal = store ? createLifecycleJournal(path.join(store.root, 'lifecycle')) : undefined;
  const conversation: ReturnType<typeof createConversation> | undefined = store && journal ? createConversation({
    runtime, store, journal, records, cursors, logs, treeLogLimit: TREE_LOG_LIMIT,
    summary: id => summary(id), digest,
    unsettled: (root): string | undefined => fencedRoot(root) ? 'a rewind of it is not finished; send that rewind again'
      : recovering.has(root) ? 'it is being reopened after a restart'
      : openingSessions.has(root) ? 'it is opening'
        : promptsInFlight.get(root) ? 'a prompt is being delivered' : undefined,
    holdPrompts,
    broadcast: (root, envelope) => { for (const connection of attached.get(root) ?? []) deliver(connection, envelope); },
    get registry() { return registry; },
    get worktrees() { return worktrees; },
    attachments,
    crashPoint,
    log: { warn: (message, fields) => log.warn(message, fields), info: (message, fields) => log.info(message, fields) },
    startedAt,
  }) : undefined;
  /** The daemon's own start-up; the scheduler waits for it before it delivers. */
  let restored: Promise<unknown> = Promise.resolve();
  /**
   * The sessions the recovery is opening again, and the ones it could not open. A job
   * that waits for such a session waits for it, and a session that could not be opened
   * fails the job with the reason.
   */
  const openingSessions = new Map<string, number>();
  const recoveryErrors = new Map<string, string>();
  /** A session is being opened again; two opens at once are counted, not overwritten. */
  const markOpening = (sessionId: string) => openingSessions.set(sessionId, (openingSessions.get(sessionId) ?? 0) + 1);
  /** The session is open again (or was never open): the next open is counted anew. */
  const clearOpening = (sessionId: string) => {
    const count = (openingSessions.get(sessionId) ?? 0) - 1;
    if (count > 0) openingSessions.set(sessionId, count);
    else openingSessions.delete(sessionId);
  };
  /**
   * The reason a session could not be opened again belongs to the jobs that wait for
   * that session: a reason no job needs is no reason at all, and the map of them must
   * not grow with the number of sessions.
   */
  function keepRecoveryError(sessionId: string, message: string) {
    if (scheduler?.holds(sessionId)) recoveryErrors.set(sessionId, message);
  }
  /** The reason is dropped when the last job that needed it is through. */
  function dropRecoveryError(sessionId: string) {
    if (!scheduler?.holds(sessionId)) recoveryErrors.delete(sessionId);
  }
  /**
   * The tick that delivers the jobs whose time has come.
   */
  const scheduler = schedules ? createScheduler({
    store: schedules,
    runtime,
    deliver: deliverJob,
    ready: () => restored,
    session: sessionId => openingSessions.has(sessionId)
      ? { opening: true }
      : recoveryErrors.has(sessionId)
        ? { error: { message: `The session this job continues could not be opened again: ${recoveryErrors.get(sessionId)}`, code: 'session_open_failed' } }
        : undefined,
    settled: sessionId => dropRecoveryError(sessionId),
    stopping: () => closing,
    now: clock,
    ...(scheduleDeliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs: scheduleDeliveryTimeoutMs }),
  }) : undefined;
  /** With restoreOnListen: starts the recovery, once; listen() calls it when the endpoint is bound. */
  let beginRestore: (() => void) | undefined;
  restored = !store ? Promise.resolve()
    : restoreOnListen ? new Promise<void>((resolve, reject) => { beginRestore = () => { beginRestore = undefined; restore().then(resolve, reject); }; })
    : restore();

  const deliver = (connection: Connection, envelope: Envelope) => {
    const message = { jsonrpc: '2.0', method: 'event', params: envelope };
    // Stable events too large for transport still advance the replay position explicitly.
    const bytes = frameBytes(message);
    if (bytes > 512 * 1024 && envelope.cursor !== undefined) message.params = {
      ...envelope, event: { type: 'item', item: { kind: 'notice', id: `oversized:${envelope.cursor}`, level: 'warning', text: `History event ${envelope.cursor} is too large to display (${bytes} bytes).` } },
    };
    connection.send(message);
  };
  /** Connections that called question.watch, with the projectRoot they asked for and whether they want roots' turn ends and attention. */
  const watchers = new Map<Connection, { projectRoot?: string; turns: boolean; attention: boolean }>();

  /** The project of a tree, live or recorded. */
  function projectOf(root: string) {
    return runtime.snapshot(root)?.projectRoot ?? records.get(root)?.session?.projectRoot;
  }

  const sameProject = (a?: string, b?: string) => {
    if (a === undefined || b === undefined) return a === b;
    return a === b || projectKey(a) === projectKey(b);
  };

  /**
   * Tells watchers not attached to the tree of a question asked or resolved there, or, for those
   * that asked for `turns`, of the end of a root's turn. Their copy has no `cursor`: it is not part
   * of a timeline they replay (docs/protocol/alp-json-rpc-v1.md §8.1, §12.2).
   */
  function tellWatchers(root: string, envelope: Envelope, turn = false) {
    if (!watchers.size) return;
    const { cursor: _cursor, ...announced } = envelope;
    const project = projectOf(root);
    for (const [connection, { projectRoot, turns }] of watchers) {
      if (turn && !turns) continue;
      if (attached.get(root)?.has(connection)) continue;
      if (projectRoot !== undefined && !sameProject(project, projectRoot)) continue;
      deliver(connection, announced);
    }
  }

  /**
   * Tells the connections watching attention that a root's changed: `attention` when set, none when
   * cleared. Never kept: a client reads the current ones from question.watch (§12.2), so a change
   * missed while it was away is not lost.
   */
  function tellAttention(root: string, attention: TurnAttention | undefined) {
    if (!watchers.size) return;
    const project = projectOf(root);
    const envelope: Envelope = { sessionId: root, epoch: `attention-${startedAt}`, seq: 0, ts: new Date().toISOString(), event: { type: 'attention', ...(attention ? { attention } : {}) } };
    for (const [connection, watch] of watchers) {
      if (!watch.attention) continue;
      if (watch.projectRoot !== undefined && !sameProject(project, watch.projectRoot)) continue;
      deliver(connection, envelope);
    }
  }

  /**
   * The acknowledgement of each root whose write is on its way. Whatever else can change a root's
   * attention (a turn of the root starting or ending, archiving) drops it, so a failed write brings
   * the attention back only when nothing changed it meanwhile; it lives no longer than the write.
   */
  const pendingAcks = new Map<string, object>();

  /** The attention of the roots of `projectRoot` (every project when absent): archived roots never ask. */
  function attentionOf(projectRoot?: string) {
    const found: Array<{ sessionId: string; attention: TurnAttention }> = [];
    for (const record of records.values()) {
      if (record.id !== record.rootId || !record.attention || record.archived) continue;
      if (projectRoot !== undefined && !sameProject(projectOf(record.id), projectRoot)) continue;
      found.push({ sessionId: record.id, attention: record.attention });
    }
    return found;
  }

  /** Records a change; the write is queued, and a failure is logged and counted in daemon.status. */
  function save(record: SessionRecord & { activeTurnId?: string }, changes: Partial<SessionRecord & { activeTurnId?: string }> = {}) {
    Object.assign(record, changes, { updatedAt: new Date().toISOString() });
    records.set(record.id, record);
    return store?.put(record).catch(() => {}) ?? Promise.resolve();
  }

  /** Gives an envelope of a tree its next cursor and queues it for the tree's timeline. */
  function keep(root: string, envelope: Envelope): Envelope {
    const cursor = (cursors.get(root) ?? 0) + 1;
    cursors.set(root, cursor);
    const kept = { ...envelope, cursor };
    void store?.append(root, kept).catch(() => {});
    return kept;
  }

  /** Continues a tree's cursors after what its stored timeline already holds. */
  function seen(root: string, log: Envelope[]) {
    const last = log.at(-1)?.cursor ?? 0;
    if (last > (cursors.get(root) ?? 0)) cursors.set(root, last);
  }

  /** Lifecycle bookkeeping for one event; returns true when it named the root. */
  function track(sessionId: string, root: string, event: AlpEvent): boolean {
    const now = new Date().toISOString();
    let record = records.get(sessionId);
    if (event.type === 'session.opened') {
      record ??= { version: 1, id: sessionId, rootId: root, status: 'initializing', createdAt: now, updatedAt: now };
      // A reopened session keeps its last usage until its runtime reports again.
      const usage = event.session.usage ?? record.session?.usage;
      // Recovery has not yet restored runtime parking when session.opened arrives.
      const parked = recovering.has(root) ? record.session?.parked : event.session.parked;
      save(record, { rootId: root, session: { ...event.session, ...(usage ? { usage } : {}), ...(parked ? { parked } : {}) }, status: 'idle', lastError: undefined, activeTurnId: undefined });
      return false;
    }
    if (!record) return false;
    if (event.type === 'session.updated') save(record, { session: { ...record.session, ...event.session, ...(event.session.parked ? {} : { parked: undefined }) } });
    // Work on an archived session brings it back.
    // A root's new turn ends the attention of its last one, as Paseo clears it then.
    else if (event.type === 'turn.started') save(record, { status: 'running', activeTurnId: event.turnId, archived: undefined, ...(sessionId === root ? { attention: undefined } : {}) });
    else if (event.type === 'turn.ended') save(record, { status: 'idle', activeTurnId: undefined,
      // A root's turn that completed or failed asks every client for a look until one acknowledges it (Paseo's checkAndSetAttention).
      ...(sessionId === root ? { attention: turnAttention(event) } : {}),
      ...(record.session ? { session: { ...record.session, parked: event.state === 'failed' ? runtime.snapshot(sessionId)?.parked : undefined } } : {}),
      ...(event.state === 'failed' ? { lastError: { message: event.error?.message ?? 'Turn failed' } } : {}) });
    // The latest usage, for a closed session's summary; written with the record's next change.
    else if (event.type === 'usage' && record.session) record.session = { ...record.session, usage: event.usage };
    else if (event.type === 'session.failed') save(record, { status: 'error', lastError: event.error });
    else if (event.type === 'session.closed') save(record, { status: record.status === 'error' ? 'error' : 'closed', activeTurnId: undefined });
    else if (event.type === 'item' && sessionId === root && !record.title && event.item.kind === 'user_message' && fromUser(event.item)) {
      // The user's first message names an unnamed root, as Paseo names an agent (ALPD §15).
      const title = titleFromPrompt(event.item.text);
      if (title) { save(record, { title }); return true; }
    }
    return false;
  }

  /** What a root's ended turn asks of the user: a look when it completed, attention when it failed, nothing when canceled. */
  function turnAttention(event: Extract<AlpEvent, { type: 'turn.ended' }>): TurnAttention | undefined {
    if (event.state === 'canceled') return undefined;
    const message = event.error?.message?.trim();
    return { reason: event.state === 'completed' ? 'finished' : 'error', at: new Date().toISOString(), turnId: event.turnId, ...(event.state === 'failed' && message ? { message: event.error!.message } : {}) };
  }

  /**
   * Tells the viewers of a live root its name, as a `session.updated` kept in its timeline, so a
   * viewer attached later replays it. Nothing is sent for a root that is not open.
   */
  function announceTitle(root: string, title: string) {
    const session = runtime.snapshot(root);
    if (!session || rootOf.get(root) !== root) return;
    const envelope = keep(root, { sessionId: root, epoch: `title-${startedAt}`, seq: 0, ts: new Date().toISOString(), event: { type: 'session.updated', session: { ...session, title } } });
    const log = logs.get(root) ?? [];
    log.push(envelope);
    if (log.length > TREE_LOG_LIMIT) log.splice(0, log.length - TREE_LOG_LIMIT);
    logs.set(root, log);
    for (const connection of attached.get(root) ?? []) deliver(connection, envelope);
  }

  runtime.onEvent(original => {
    // While alpd stops, records keep what was running, so the next alpd continues it (ALPD §31).
    if (closing) return;
    let envelope = original;
    const { sessionId, event } = envelope;
    if (event.type === 'session.opened') {
      const parent = event.session.parentId;
      rootOf.set(sessionId, parent ? rootOf.get(parent) ?? parent : sessionId);
    }
    const root = rootOf.get(sessionId) ?? sessionId;
    let named = false;
    if (rootOf.has(sessionId)) {
      envelope = keep(root, envelope);
      const log = logs.get(root) ?? [];
      log.push(envelope);
      if (log.length > TREE_LOG_LIMIT) log.splice(0, log.length - TREE_LOG_LIMIT);
      logs.set(root, log);
      const before = records.get(root)?.attention;
      named = track(sessionId, root, event);
      const after = records.get(root)?.attention;
      // A root's turn starting or ending decides its attention, even when it was already none.
      if (sessionId === root && (event.type === 'turn.started' || event.type === 'turn.ended')) pendingAcks.delete(root);
      if (after !== before) tellAttention(root, after);
    }
    for (const connection of attached.get(root) ?? []) deliver(connection, envelope);
    if (event.type === 'question' || event.type === 'question.resolved') tellWatchers(root, envelope);
    else if (event.type === 'turn.ended' && sessionId === root) tellWatchers(root, envelope, true);
    // After the message that named it, so its cursor follows the message's.
    if (named) announceTitle(root, records.get(root)!.title!);
    if (event.type === 'session.closed' && sessionId === root) {
      setImmediate(() => forget(root));
    } else {
      setImmediate(() => void reap(root));
    }
  });

  /**
   * Loads records, settles sessions a crash or a stop left working, and prunes expired
   * trees. Trees with assignments the runtime can continue, whose root was working, or
   * whose root a scheduled job waits for, are reopened afterwards (ALPD §31).
   */
  async function restore() {
    await store!.pruneReceipts(RECEIPT_RETENTION_MS, { temporaries: true });
    await journal?.prune(LIFECYCLE_RETENTION_MS, { temporaries: true }).catch(error => recoveryLog.warn('could not prune the lifecycle journal', { code: 'ALPD_LIFECYCLE_PRUNE_FAILED', error }));
    const loaded = await store!.list();
    await reconcileReceipts(loaded);
    const now = Date.now();
    const ended = { code: 'daemon_restarted', message: 'alpd stopped while this session was working' };
    const epoch = `restart-${startedAt}`;
    const continuing = new Set(runtime.recoverable().map(entry => entry.assignmentId));
    // The roots a job waits for: they are reopened, so the job finds its session.
    // Every project of the host is read here: the daemon serves them all.
    const pending = await schedules?.all({ status: 'pending' }) ?? [];
    for (const job of pending) scheduler?.hold(job);
    const scheduled = new Set(pending.map(job => job.sessionId));
    const reopen: Array<{ record: SessionRecord; working: boolean }> = [];
    const byRoot = trees(loaded);
    const removed = await expire(byRoot, now);
    for (const [root, tree] of byRoot) {
      const head = tree.find(record => record.id === root);
      if (removed.has(root)) continue;
      // A root that was closed is not opened again for a job: a job continues a session
      // that is alive, and a closed one fails with the reason.
      if (head && resumable(head) && (head.status === 'running' || (head.status === 'idle' && head.session?.parked) || tree.some(record => continuing.has(record.id)) || (scheduled.has(head.id) && head.status !== 'closed') || runtime.pendingApprovalRoots?.().includes(head.id))) reopen.push({ record: head, working: head.status === 'running' });
      if (tree.some(record => LIVE.includes(record.status))) seen(root, await store!.timeline(root));
      for (const record of tree as Array<SessionRecord & { activeTurnId?: string }>) {
        records.set(record.id, record);
        if (!LIVE.includes(record.status)) continue;
        const envelope = (event: AlpEvent): Envelope => ({ sessionId: record.id, epoch, seq: 0, ts: new Date().toISOString(), event });
        // The turn a crash or a stop cut off is reported interrupted, never continued as if nothing happened.
        if (record.activeTurnId) keep(root, envelope({ type: 'turn.ended', turnId: record.activeTurnId, state: 'failed', error: { message: ended.message, code: ended.code } }));
        if (record.id === root) {
          if (!(record.status === 'idle' && record.session?.parked)) save(record, record.status === 'idle' ? { status: 'closed', activeTurnId: undefined } : { status: 'error', lastError: ended, activeTurnId: undefined });
        } else if (continuing.has(record.id) && reopen.some(entry => entry.record.id === root)) {
          // The runtime reopens it under the same id; until then it is closed.
          save(record, { status: 'closed', activeTurnId: undefined });
        } else {
          // Children never survive their runtime; their requester learns the assignment failed.
          keep(root, envelope({ type: 'session.closed' }));
          save(record, { status: 'closed', lastError: ended, activeTurnId: undefined });
          if (runLogDir && !continuing.has(record.id)) {
            const line = JSON.stringify({ ts: new Date().toISOString(), rootSessionId: root, event: 'assignment.finished', assignmentId: record.id, agent: record.session?.agent, sessionId: record.id, status: 'failed', error: ended.message, reconciled: true }) + '\n';
            await mkdir(runLogDir, { recursive: true }).then(() => appendFile(path.join(runLogDir, `${root.replace(/[^\w.-]/g, '_')}.jsonl`), line)).catch(() => {});
          }
        }
      }
    }
    // Forks and rewinds a crash cut off: finished from their journal, or settled unknown, before any tree reopens.
    if (conversation) await conversation.recover().catch(error => recoveryLog.error('could not recover lifecycle operations', { code: 'ALPD_LIFECYCLE_RECOVERY_FAILED', error }));
    // Assignments whose tree cannot be reopened end now, and their tasks go back to open.
    const reopened = new Set(reopen.map(entry => entry.record.id));
    for (const rootId of new Set([...runtime.recoverable().map(entry => entry.rootId), ...(runtime.pendingApprovalRoots?.() ?? [])])) {
      if (!reopened.has(rootId)) await runtime.abandon(rootId, 'its root session cannot be reopened').catch(() => {});
    }
    for (const { record, working } of reopen) {
      // A root whose rewind could not be finished stays closed: it would reopen on the old conversation.
      if (fencedRoot(record.id)) { recoveryLog.warn(`${record.id} is not reopened: a rewind of it is not finished`, { code: 'ALPD_REWIND_FENCED', sessionId: record.id }); continue; }
      // The session is opened again: a job that waits for it waits, it does not fail.
      markOpening(record.id);
      recovering.set(record.id, recoverTree(record, working, () => { clearOpening(record.id); }));
    }
  }

  function trees(list: Iterable<SessionRecord>) {
    const byRoot = new Map<string, SessionRecord[]>();
    for (const record of list) byRoot.set(record.rootId, [...(byRoot.get(record.rootId) ?? []), record]);
    return byRoot;
  }

  /**
   * Retention (ALPD §68): deletes trees nobody needs any more, with their records, timeline and
   * run log. A tree stays while any of its sessions is live or was written in the last 30 days,
   * while a receipt of one of its sessions is still honoured (7 days from its last write, so a
   * retried prompt is answered from it), while the runtime can continue one of its assignments,
   * and while it is open, attached or being recovered. Timelines are never trimmed while their
   * tree stays, so every cursor a client holds for it replays.
   */
  async function expire(byRoot: Map<string, SessionRecord[]>, now = Date.now()) {
    const removed = new Set<string>();
    const receiptWritten = new Map<string, number>();
    // Receipts age as the store prunes them: by when their file was written, and by what they say.
    for (const { receipt, writtenAt } of await store!.receipts()) {
      const at = Date.parse(receipt.updatedAt);
      receiptWritten.set(receipt.sessionId, Math.max(receiptWritten.get(receipt.sessionId) ?? 0, Number.isNaN(at) ? now : at, writtenAt));
    }
    const continuing = new Set(runtime.recoverable().map(entry => entry.rootId));
    for (const [root, tree] of byRoot) {
      const remove = async () => {
        if (!tree.some(record => record.id === root)) return;
        if (tree.some(record => LIVE.includes(record.status))) return;
        if (now - Math.max(...tree.map(record => Date.parse(record.updatedAt) || now)) <= RETENTION_MS) return;
        if (tree.some(record => now - (receiptWritten.get(record.id) ?? 0) <= RECEIPT_RETENTION_MS)) return;
        if (continuing.has(root) || rootOf.has(root) || attached.get(root)?.size || recovering.has(root)) return;
        // A tree a job waits for stays: the job is to continue that very session.
        if (scheduler?.holds(root)) return;
        const ids = tree.map(record => record.id);
        // A tree restored from a backup counts from its restore: its files were written then.
        if (now - await store!.writtenAt(ids) <= RETENTION_MS) return;
        if (rootOf.has(root) || attached.get(root)?.size || recovering.has(root)) return;
        if (await conversation?.retainsFork(root)) return;
        // Forgotten before the files go, so a resume arriving meanwhile finds nothing to reopen.
        for (const id of ids) records.delete(id);
        cursors.delete(root);
        await store!.remove(root, ids);
        // The history is gone: what its prompts pinned is released (kept releasedGraceMs more).
        await attachments?.releaseSessions(ids).catch(error => recoveryLog.warn('could not release the attachments of removed sessions', { code: 'ALPD_ATTACHMENT_RELEASE_FAILED', error }));
        if (runLogDir) await unlink(path.join(runLogDir, `${root.replace(/[^\w.-]/g, '_')}.jsonl`)).catch(() => {});
        removed.add(root);
      };
      // A source cannot start a native fork between the dependency check and deletion.
      if (conversation) await conversation.lifecycle.serial(root, remove);
      else await remove();
    }
    if (removed.size) recoveryLog.info(`retention removed ${removed.size} session tree${removed.size > 1 ? 's' : ''} unused for ${RETENTION_MS / 86_400_000} days`, { code: 'ALP_RETENTION_REMOVED', trees: removed.size });
    return removed;
  }

  /** Retention while alpd runs: receipts past their window, then expired trees; temporary files stay, as writes may be under way. */
  let sweeping = false;
  async function sweep() {
    if (closing || !store || sweeping) return;
    sweeping = true;
    try {
      await restored;
      await store.pruneReceipts(RECEIPT_RETENTION_MS, { temporaries: false });
      await journal?.prune(LIFECYCLE_RETENTION_MS);
      await expire(trees(records.values()));
    } catch (error) {
      recoveryLog.warn('retention sweep failed', { code: 'ALP_RETENTION_FAILED', error });
    } finally {
      sweeping = false;
    }
  }
  const sweeper = store ? setInterval(() => void sweep(), retentionSweepMs) : undefined;
  sweeper?.unref();

  /**
   * The scheduler's tick. It runs as long as alpd runs, so a job that comes due is
   * delivered even when nobody is watching: the tick is not the runtime's watchdog,
   * which stops as soon as no assignment is left.
   */
  scheduler?.start(scheduleTickMs);

  /**
   * Completes receipts a crash left pending when the tree's timeline shows how the runtime
   * answered; the rest stay pending, so their prompt answers outcome_unknown and is never
   * sent again by itself.
   */
  async function reconcileReceipts(loaded: SessionRecord[]) {
    const rootOfRecord = new Map(loaded.map(record => [record.id, record.rootId]));
    const timelines = new Map<string, Envelope[]>();
    for (const { key, receipt } of await store!.receipts()) {
      if (receipt.state !== 'pending') continue;
      const root = rootOfRecord.get(receipt.sessionId);
      if (!root) continue;
      if (!timelines.has(root)) timelines.set(root, await store!.timeline(root).catch(() => []));
      const answer = timelines.get(root)!.find(({ sessionId, event }) => sessionId === receipt.sessionId
        && (event.type === 'prompt.accepted' || event.type === 'prompt.failed') && event.clientMessageId === receipt.clientMessageId);
      if (!answer) continue;
      const event = answer.event as Extract<AlpEvent, { type: 'prompt.accepted' | 'prompt.failed' }>;
      const outcome = event.type === 'prompt.accepted' ? 'accepted' : event.error.code === 'outcome_unknown' ? 'unknown' : 'failed';
      await store!.putReceipt(key, { ...receipt, state: 'completed', outcome, ...(event.type === 'prompt.failed' ? { error: event.error } : {}), reconciled: true, updatedAt: new Date().toISOString() })
        .catch(() => {});
    }
  }

  function resumable(record: SessionRecord) {
    return record.rootId === record.id && !!record.spec && !!record.session?.persistent && !!record.session.threadId;
  }

  /** Reopens a root nobody watches yet and continues what it and its assignments were doing. */
  async function recoverTree(record: SessionRecord, working: boolean, opened?: () => void) {
    const session = record.session!;
    // The open of this session is counted once: the flag is cleared when the open is
    // over, whether it succeeded or not, and a second open of the same session keeps
    // its own count.
    let openedOnce = false;
    const open = () => { if (openedOnce) return; openedOnce = true; opened?.(); };
    try {
      if (worktrees && record.spec?.cwd) await worktrees.assertAvailable(record.spec.cwd);
      const stored = await treeLog(record.id);
      seen(record.id, stored);
      logs.set(record.id, [...stored]);
      await runtime.open(record.id, {
        ...record.spec!,
        persist: true,
        restore: { agent: session.agent, threadId: session.threadId, runtime: session.runtime, model: session.model, workflow: session.workflow, ...(record.base ? { base: record.base } : {}) },
      }, { history: 'skip', delegation: record.delegation ?? true });
      // The session is open again: a job that waits for it may be delivered.
      open();
      const outcomes = await runtime.recover(record.id, { continueRoot: working, parkedRoot: session.parked });
      recoveryLog.info(`recovered ${record.id}: ${outcomes.map(outcome => `${outcome.agent} ${outcome.outcome}`).join(', ') || 'root'}`, { event: 'recovered', sessionId: record.id, rootId: record.rootId });
    } catch (error: any) {
      // The session is not open: a job that waits for it fails with the reason.
      open();
      keepRecoveryError(record.id, error?.message ?? String(error));
      recoveryLog.error(`could not recover ${record.id}`, { code: 'ALP_RECOVERY_FAILED', sessionId: record.id, rootId: record.rootId, error });
      await runtime.abandon(record.id, error?.message ?? String(error)).catch(() => {});
    } finally {
      recovering.delete(record.id);
      setImmediate(() => void reap(record.id));
    }
  }

  /**
   * Sends a prompt at most once per (session, clientMessageId), as Paseo's MessageReceipts
   * (ALPD §15, §66). The answer comes only after the receipt holds the runtime's outcome
   * and the tree's timeline holds its events. A repeat with the same content answers what
   * the first delivery did, with other content a conflict; a receipt left pending by a
   * crash, or a delivery the provider may or may not have received, is outcome_unknown.
   */
  function deliverOnce(sessionId: string, clientMessageId: string, fingerprint: string, send: () => Promise<void>, { requireReceipt = false, prepare, abandon }: {
    requireReceipt?: boolean;
    /** Before the pending receipt, once no receipt answers: refusals here record nothing; attachments are pinned here. */
    prepare?: (key: string) => Promise<void>;
    /** The prompt certainly did not reach the runtime: what prepare pinned may go. */
    abandon?: (key: string) => Promise<void>;
  } = {}) {
    const key = digest(['prompt', sessionId, clientMessageId]);
    const unknown = () => new RpcError(ERROR.conflict, `alpd cannot tell whether message ${clientMessageId} reached the agent; check the session, then send it again with a new id`, { reason: 'outcome_unknown' });
    const answer = (receipt: Receipt, extra: object = {}) => ({ outcome: receipt.outcome ?? 'accepted', ...(receipt.error ? { error: receipt.error } : {}), ...extra });
    const attempt = async () => {
      let existing: Receipt | UnreadableReceipt | undefined = unsaved.get(key);
      if (!existing) {
        try { existing = await store!.receipt(key); }
        catch (error) { throw persistenceFailed(`message ${clientMessageId}`, error); }
      }
      if (existing) {
        if (existing.state === 'unreadable') throw unknown();
        if (existing.fingerprint !== fingerprint) throw new RpcError(ERROR.conflict, `Message ${clientMessageId} was already sent with different content`, { reason: 'key_conflict' });
        if (existing.state === 'pending' || existing.outcome === 'unknown') throw unknown();
        return answer(existing, { duplicate: true, durable: !unsaved.has(key) });
      }
      // Scheduler replays fail closed when a prior attempt's receipt was pruned,
      // lost or never committed. Absence cannot prove that nothing was sent.
      if (requireReceipt) throw unknown();
      const receipt = (state: Receipt['state'], changes: Partial<Receipt> = {}): Receipt => ({ version: 1, sessionId, clientMessageId, fingerprint, state, ...changes, updatedAt: new Date().toISOString() });
      live(sessionId);
      // Attachments are pinned before anything is sent: a crash from here on keeps them.
      await prepare?.(key);
      crashPoint('prompt.before-receipt');
      // Nothing is sent unless the pending receipt is on disk: a crash from here on answers outcome_unknown.
      try { await store!.putReceipt(key, receipt('pending')); }
      catch (error) {
        await abandon?.(key).catch(() => {});
        throw persistenceFailed(`message ${clientMessageId}; it was not sent`, error);
      }
      crashPoint('prompt.after-receipt');
      // The runtime reports how the provider answered as an event, before prompt() resolves.
      let reply: { outcome: 'accepted' | 'failed' | 'unknown'; error?: { message: string; code?: string } } = { outcome: 'accepted' };
      const stop = runtime.onEvent(({ sessionId: from, event }) => {
        if (from !== sessionId) return;
        if (event.type === 'prompt.accepted' && event.clientMessageId === clientMessageId) reply = { outcome: 'accepted' };
        if (event.type === 'prompt.failed' && event.clientMessageId === clientMessageId) reply = { outcome: event.error.code === 'outcome_unknown' ? 'unknown' : 'failed', error: event.error };
      });
      try {
        await send();
      } catch (error) {
        // The runtime refused it before reaching the provider (the session closed meanwhile): not sent.
        await store!.removeReceipt(key).catch(() => {});
        await abandon?.(key).catch(() => {});
        throw error;
      } finally {
        stop();
      }
      const root = rootOf.get(sessionId) ?? sessionId;
      const lost = await store!.drain({ records: [sessionId], timelines: [root] });
      crashPoint('prompt.after-send');
      const done = receipt('completed', reply);
      let durable = lost.length === 0;
      try { await store!.putReceipt(key, done); }
      catch {
        unsaved.set(key, done);
        durable = false;
      }
      crashPoint('prompt.after-completed');
      if (reply.outcome === 'unknown') throw unknown();
      return answer(done, { durable });
    };
    const previous = delivering.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() => gated(sessionId, attempt));
    delivering.set(key, result);
    void result.finally(() => { if (delivering.get(key) === result) delivering.delete(key); }).catch(() => {});
    return result;
  }

  /**
   * The delivery of a scheduled job: the prompt path a client uses, with a
   * clientMessageId of the job's own. The receipt of that message is what keeps a job
   * from running twice: a retry after a crash reads the receipt instead of sending.
   */
  async function deliverJob(job: ScheduleJob, content: PromptContent, messageId: string, send: AlpRuntime['prompt'] = (id, input) => runtime.prompt(id, input)): Promise<ScheduleDelivery> {
    // The id is the job's own, so it is the same in every attempt of this job.
    const clientMessageId = messageId || scheduleMessageId(job);
    return deliverOnce(job.sessionId, clientMessageId, digest({ delivery: 'auto', content }), async () => {
      live(job.sessionId);
      await send(job.sessionId, { clientMessageId, delivery: 'auto', content });
    }, { requireReceipt: job.attempts > 1 });
  }

  /**
   * Waits for an opened root's record and timeline (its native thread) to be written, so a
   * crash after the answer can still resume it (ALPD §66); `durable: false` when they were not.
   */
  async function persisted(root: string) {
    if (!store) return {};
    return { durable: (await store.drain({ records: [root], timelines: [root] })).length === 0 };
  }

  function forget(root: string) {
    if (runtime.snapshot(root)) return;
    for (const [id, candidate] of rootOf) if (candidate === root) { rootOf.delete(id); recoveryErrors.delete(id); }
    recoveryErrors.delete(root);
    logs.delete(root);
  }

  /** Closes an idle root that no client watches. */
  async function reap(root: string) {
    if (closing || attached.get(root)?.size || recovering.has(root)) return false;
    // A root a job waits for stays open: the job is to continue that very session.
    if (scheduler?.holds(root)) return false;
    // So does a root whose approval waits for the user (t-43ed), until it is decided or expires.
    if (runtime.pendingApprovalRoots?.().includes(root)) return false;
    const session = runtime.snapshot(root);
    if (!session || session.busy) return false;
    await runtime.close(root).catch(() => {});
    return true;
  }

  function attach(connection: Connection, root: string) {
    const set = attached.get(root) ?? new Set();
    set.add(connection);
    attached.set(root, set);
    connection.roots.add(root);
  }

  function detach(connection: Connection, root: string) {
    attached.get(root)?.delete(connection);
    if (!attached.get(root)?.size) attached.delete(root);
    connection.roots.delete(root);
  }

  function summary(id: string): SessionSummary | undefined {
    const record = records.get(id);
    const live = runtime.snapshot(id);
    const session = live ?? record?.session;
    if (!session) return undefined;
    const status: SessionStatus = live ? (live.activeTurnId ? 'running' : 'idle') : record?.status === 'error' ? 'error' : 'closed';
    return { ...session, ...(live ? {} : { busy: false, activeTurnId: undefined }), status, title: record?.title, ...(record?.archived ? { archived: true } : {}), ...(record?.attention && !record.archived ? { attention: record.attention } : {}), ...(record?.pinnedAt ? { pinnedAt: record.pinnedAt } : {}), ...labelsOf(record), lastError: record?.lastError, createdAt: record?.createdAt, updatedAt: record?.updatedAt, ...(record && conversation ? conversation.fields(record, session) : {}) };
  }

  /** The record of a root the user acts on. */
  function rootRecord(sessionId: string) {
    if (typeof sessionId !== 'string') throw new RpcError(-32602, 'sessionId is required');
    const record = records.get(sessionId);
    if (!record) throw new RpcError(ERROR.notFound, `No session ${sessionId}`);
    if (record.rootId !== record.id) throw new RpcError(-32602, 'Only a root session can be renamed or archived');
    return record;
  }

  /**
   * The registry's label catalog by lower-cased name, as alpd last read it (capability `session.meta`);
   * undefined until read or when the registry cannot be read. Every registry.owner call refreshes it.
   */
  let labelCatalog: Map<string, { name: string; color: string }> | undefined;
  const keepCatalog = (catalog: Array<{ name: string; color: string }>) => { labelCatalog = new Map(catalog.map(label => [label.name.toLowerCase(), { name: label.name, color: label.color }])); };
  /** A root's labels still in the catalog, in its spelling; a deleted label leaves every session at once. */
  function labelsOf(record: SessionRecord | undefined): { labels?: string[] } {
    if (!record?.labels?.length) return {};
    // Strings only: a record edited by hand never breaks every summary of its session.
    const names = record.labels.filter((name): name is string => typeof name === 'string');
    const labels = labelCatalog ? names.flatMap(name => labelCatalog!.get(name.toLowerCase())?.name ?? []) : names;
    return labels.length ? { labels } : {};
  }
  /** Session label writes and the follow-up of a catalog rename or delete, one at a time. */
  let labelWrites: Promise<unknown> = Promise.resolve();
  const serialLabels = <T>(run: () => Promise<T>): Promise<T> => { const next = labelWrites.then(run, run); labelWrites = next.catch(() => {}); return next; };
  /**
   * A catalog label renamed or deleted (registry.owner label.update, label.delete): the roots that
   * carry it follow at once, so a rename keeps the label on them. The read-time filter of labelsOf
   * still hides a deleted name if this write fails or alpd stops before it.
   */
  function followLabel(previousName: string, newName: string | undefined) {
    return serialLabels(async () => {
      const key = previousName.toLowerCase();
      for (const record of records.values()) {
        // Strings only, as labelsOf reads them: a record edited by hand never stops the follow-up of the others.
        const names = (record.labels ?? []).filter((name): name is string => typeof name === 'string');
        if (!names.some(name => name.toLowerCase() === key)) continue;
        const next = [...new Map(names.flatMap(name => name.toLowerCase() === key ? (newName ? [newName] : []) : [name]).map(name => [name.toLowerCase(), name])).values()];
        const before = record.labels;
        record.labels = next.length ? next : undefined;
        // Once more on a failed write; then memory goes back to what the disk holds, so the session
        // shows after a restart what it shows now: a renamed label it could not keep is gone from it
        // either way (labelsOf hides a name the catalog no longer has), never there until a restart.
        let saved = false;
        for (let attempt = 0; attempt < 2 && !saved; attempt++) {
          try { await store?.put(record); saved = true; }
          catch (error) { if (attempt === 1) { record.labels = before; log.error('could not keep a session\'s labels after a catalog change; the label is no longer shown on it', { code: 'ALPD_SESSION_LABELS_FAILED', sessionId: record.id, error }); } }
        }
      }
    });
  }

  function known(sessionId: string) {
    const found = summary(sessionId);
    if (!found) throw new RpcError(ERROR.notFound, 'Session is not open');
    return found;
  }

  function live(sessionId: string) {
    const session = runtime.snapshot(sessionId);
    if (!session) throw new RpcError(ERROR.notFound, 'Session is not open');
    return session;
  }

  async function treeLog(root: string) {
    return logs.get(root) ?? await store?.timeline(root) ?? [];
  }

  /**
   * An envelope as history shows it (t-2e23). A notice read from the timeline is not news: its text is
   * given `[issued <time>, replayed]` in front, the time its envelope was written, so a warning from two
   * days ago does not read as one of now. Every way history reaches a client goes through here (a reopened
   * root's replay, session.attach, session.history); an event sent as it happens does not. What is stored
   * stays as it was written, so nothing is marked twice. The markers of a rewind and of a fork
   * (`rewind:`, `fork:`) are places in the conversation, not news, and stay as they are.
   */
  function replayed(envelope: Envelope): Envelope {
    const event = envelope.event;
    if (event.type !== 'item' || event.item.kind !== 'notice' || /^(?:rewind|fork):/.test(event.item.id)) return envelope;
    return { ...envelope, event: { ...event, item: { ...event.item, text: replayedNotice(event.item.text, envelope.ts) } } };
  }

  /**
   * Delivers a tree's history: the root's latest items, then the children's events in their
   * original order, so a grandchild opens while its parent is still open.
   */
  function replayHistory(connection: Connection, root: string, log: Envelope[], { children = true } = {}) {
    const items = new Map<string, Envelope>();
    for (const envelope of log) {
      if (envelope.sessionId === root && envelope.event.type === 'item') items.set(envelope.event.item.id, envelope);
    }
    for (const item of items.values()) deliver(connection, replayed(item));
    if (children) for (const envelope of log) if (envelope.sessionId !== root && current(envelope)) deliver(connection, replayed(envelope));
  }

  /** Questions in a log are history; announceQuestions delivers the ones still waiting. */
  function current(envelope: Envelope) {
    return envelope.event.type !== 'question' && envelope.event.type !== 'question.resolved';
  }

  function announceQuestions(connection: Connection, root: string) {
    for (const question of runtime.questions()) {
      if (question.rootId !== root) continue;
      deliver(connection, { sessionId: question.sessionId, epoch: `announce-${startedAt}`, seq: 0, ts: new Date().toISOString(), event: { type: 'question', question } });
    }
  }

  /**
   * Re-announces a live tree to a client that reopens its root: the root as it is now,
   * its timeline when asked, then live children and running turns.
   */
  function announce(connection: Connection, root: string, history: 'replay' | 'skip') {
    const log = logs.get(root) ?? [];
    const sessions = runtime.list().filter(session => (rootOf.get(session.id) ?? session.id) === root);
    for (const session of sessions) {
      const opened = log.find(envelope => envelope.sessionId === session.id && envelope.event.type === 'session.opened');
      if (!opened || opened.event.type !== 'session.opened') continue;
      const seq = Math.max(...log.filter(envelope => envelope.sessionId === session.id).map(envelope => envelope.seq));
      const envelope = (event: Envelope['event']): Envelope => ({ sessionId: session.id, epoch: opened.epoch, seq, ts: new Date().toISOString(), event });
      deliver(connection, envelope({ ...opened.event, session }));
      if (history === 'replay' && session.id === root) replayHistory(connection, root, log, { children: false });
      deliver(connection, envelope({ type: 'session.ready' }));
      if (session.activeTurnId) deliver(connection, envelope({ type: 'turn.started', turnId: session.activeTurnId, origin: 'user' }));
    }
    announceQuestions(connection, root);
  }

  /** Reopens a closed root from its record: the native thread resumes, alpd replays the history. */
  async function resume(connection: Connection, record: SessionRecord, spec: any, history: 'replay' | 'skip', delegation: boolean) {
    const session = record.session;
    if (record.rootId !== record.id) throw new RpcError(ERROR.failed, 'Only root sessions can be resumed');
    if (!session?.persistent || !session.threadId || !record.spec) throw new RpcError(ERROR.failed, 'This session cannot be resumed');
    const agent = spec.agent ?? spec.restore?.agent;
    if (agent !== undefined && agent !== session.agent) throw new RpcError(ERROR.failed, 'Cannot resume a session as a different ALP agent');
    // The session is opened again from the first moment: a job that waits for it waits
    // for the open, it does not fail with 'the session is closed'.
    markOpening(record.id);
    // The reason of an earlier failure is not true while the session opens again.
    recoveryErrors.delete(record.id);
    let applied = false;
    try {
      if (worktrees) await worktrees.assertAvailable(record.spec.cwd);
      const stored = await treeLog(record.id);
      seen(record.id, stored);
      logs.set(record.id, [...stored]);
      attach(connection, record.id);
      const opened = await runtime.open(record.id, {
        ...record.spec,
        ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
        ...(spec.thinking !== undefined ? { thinking: spec.thinking } : {}),
        persist: true,
        restore: { agent: session.agent, threadId: session.threadId, runtime: session.runtime, model: session.model, workflow: session.workflow, ...(record.base ? { base: record.base } : {}) },
      }, { history: stored.length ? 'skip' : history, delegation: record.delegation ?? delegation });
      applied = true;
      await persistAcceptedSpec(record.id, opened, { mode: spec.mode !== undefined, thinking: spec.thinking !== undefined });
      if (history === 'replay') replayHistory(connection, record.id, stored);
      return opened;
    } catch (error: any) {
      // A durable-write failure does not undo a successful open or abandon its viewer.
      if (applied) throw error;
      detach(connection, record.id);
      // The session could not be opened: a job that waits for it says why.
      keepRecoveryError(record.id, error?.message ?? String(error));
      throw error;
    } finally {
      clearOpening(record.id);
    }
  }

  /** Causal successful apply/open only: never infer requested configuration from later events. */
  async function persistAcceptedSpec(id: string, accepted: SessionSnapshot, fields: { mode?: boolean; thinking?: boolean }) {
    const record = records.get(id);
    if (!record?.spec || (!fields.mode && !fields.thinking)) return;
    record.spec = {
      ...record.spec,
      ...(fields.mode ? { mode: accepted.mode } : {}),
      ...(fields.thinking ? { thinking: accepted.thinking } : {}),
    };
    record.updatedAt = new Date().toISOString();
    try { await store?.put(record); }
    catch (error) { throw persistenceFailed(`the configuration of ${id}; the runtime already applied it`, error); }
  }

  /** Projects, tasks, library and settings (docs/protocol/alp-json-rpc-v1.md §15); a team save syncs the projects sessions ran in. */
  const registry = home ? createRegistry(home) : undefined;
  const registryCall = async (run: () => Promise<any>) => {
    if (!registry) throw new RpcError(ERROR.unavailable, 'Registry needs ALP_HOME');
    try { return await run(); } catch (e) {
      if (e instanceof RegistryError) throw new RpcError(e.code, e.message, e.data);
      throw new RpcError(ERROR.failed, e instanceof Error ? e.message : String(e), { reason: 'persistence_failed' });
    }
  };
  /** The catalog as the registry holds it now, kept for session rows (capability `session.meta`). */
  const labelList = () => registryCall(async () => { keepCatalog((await registry!.snapshot()).labels.catalog); return labelCatalog!; });
  // Session rows filter their labels by the catalog: read it before the first request is served.
  if (registry) restored = Promise.all([restored, registry.snapshot().then(r => keepCatalog(r.labels.catalog), error => log.warn('could not read the label catalog', { code: 'ALPD_LABELS_UNREADABLE', error }))]);
  const worktrees = home && registry && process.platform !== 'win32' ? createWorkspaceWorktrees(home, registry, async (directory, run) => {
    if (!runtime.withWorkspaceMutation) throw new RegistryError(1005, 'Runtime cannot prove safe worktree removal', { reason: 'guard_unavailable' });
    try { return await runtime.withWorkspaceMutation(directory, run); } catch (error: any) { if (error?.data?.reason) throw new RegistryError(1004, 'Workspace is in use or has retained assignment results', error.data); throw error; }
  }, async directory => { if (!runtime.registerWorkspace) throw new RegistryError(1005, 'Runtime cannot register safe workspace ownership', { reason: 'guard_unavailable' }); await runtime.registerWorkspace(directory); },
  // Owner-audited adoption (t-c1ba); no RPC exposes it yet, so the default stays refusal.
  runtime.adoptWorkspace ? async (directory, verify) => {
    try { await runtime.adoptWorkspace!(directory, verify); } catch (error: any) { if (error?.data?.reason && !(error instanceof RegistryError)) throw new RegistryError(1004, 'Workspace is in use, has retained assignment results or changed identity', error.data); throw error; }
  } : undefined) : undefined;
  const workspaceDescriptor = async (w: any) => worktrees ? worktrees.describe(w) : w;
  // workspace.git.status and workspace.git.diff (§12.5): read-only, by registry workspaceId.
  const gitReader = registry ? createGitReader({ registry, log: (message, fields) => log.warn(message, { code: 'ALPD_GIT_READ_FAILED', ...fields }) }) : undefined;
  // workspace.git.facts (§12.5): the owner's host directory, registered or not; no registry, so
  // never a gateway's (prohibited there) nor an agent's connection's.
  const gitFacts = createGitReader({ log: (message, fields) => log.warn(message, { code: 'ALPD_GIT_READ_FAILED', ...fields }) });
  // Terminals (§12.10): a real PTY shell as the daemon's account, only while the host opted in
  // (<ALP_HOME>/terminal.json); bound to the caller's principal and the workspace's directory.
  const terminals = home && registry ? createTerminalService({
    home,
    resolveWorkspace: workspaceId => registry.resolve(workspaceId),
    log: { warn: (message, fields) => log.warn(message, fields), info: (message, fields) => log.info(message, fields) },
    ...terminalOptions,
  }) : undefined;
  const operations = createOperations({ home, templates, knownProjects: () => new Set([...records.values()].flatMap(record => record.session?.projectRoot ? [record.session.projectRoot] : [])), onGateChange: root => runtime.syncGates?.(root),
    // A provider file saved: reread the ACP rows; one the user just enabled is probed for its models (t-d0b0).
    learnedModels: id => modelCatalog?.acpModels(id) ?? [],
    onProviderSaved: (id, enabled) => { if (!modelCatalog) return; void (enabled ? modelCatalog.refreshAcp([id]) : modelCatalog.loadAcp()).catch(() => {}); } });
  const extensionOwners = new Map<string, Connection>();
  /** workspace.files.find's snapshots, each for the connection that asked. */
  const findPages = createFindPages();
  const catalogHandlers = createCatalogHandlers({ modelCatalog });
  const attachmentHandlers = createAttachmentHandlers({ attachments, log });
  const terminalHandlers = createTerminalHandlers({ terminals });
  const workspaceHandlers = createWorkspaceHandlers({ registry, worktrees, workspaceDescriptor, registryCall, gitReader, gitFacts, findPages, keepCatalog, labelCatalog: () => labelCatalog, followLabel, log });
  const sessionHandlers = createSessionHandlers({ runtime, store, runLogDir, registry, worktrees, conversation, attachments, records, rootOf, logs, cursors, holds, holdRevision: () => holdRevision, recovering, watchers, pendingAcks, registryCall, sameProject, projectOf, attentionOf, tellAttention, refuseFenced, attach, detach, announce, resume, persisted, reap, known, live, summary, rootIdOf, replayed, current, deliver, announceQuestions, gated, deliverOnce, persistAcceptedSpec, rootRecord, announceTitle, serialLabels, labelList });
  const scheduleHandlers = createScheduleHandlers({ schedules, scheduler, runtime, log });
  const handlers: Record<string, (connection: Connection, params: any) => Promise<unknown> | unknown> = {
    'extension.register': async (connection, params) => {
      // An agent could claim a user's method (web.pairing) while its owner is down (t-d08b).
      agentRefused(connection, 'extension.register');
      const method = params?.method;
      if (typeof method !== 'string' || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(method) || method === '__proto__' || method === 'constructor' || method === 'toString') throw new RpcError(ERROR.protocol, 'extension.register requires a safe method name');
      if (method.length > 128 || (reservedNamespaces.has(method.split('.')[0]) && !originalMethods.has(method))) throw new RpcError(ERROR.protocol, 'extension.register requires an extension namespace and a name of at most 128 characters');
      if (originalMethods.has(method) || extensionOwners.has(method) || Object.hasOwn(handlers, method)) throw new RpcError(ERROR.conflict, `${method} is already registered`);
      if ((methodOwners.get(connection)?.size ?? 0) >= 128 || extensionOwners.size >= 1024) throw new RpcError(ERROR.conflict, 'too many registered extension methods');
      extensionOwners.set(method, connection);
      if (!methodOwners.has(connection)) methodOwners.set(connection, new Set());
      methodOwners.get(connection).add(method);
      handlers[method] = async (_connection, invokeParams) => {
        const owner = extensionOwners.get(method);
        if (!owner || !connections.has(owner)) { delete handlers[method]; extensionOwners.delete(method); throw new RpcError(ERROR.notFound, `${method} is not available`); }
        return invokeExtended(owner, _connection, method, invokeParams ?? {});
      };
      return { registered: method };
    },
    'extension.unregister': async (connection, params) => {
      const method = params?.method;
      if (typeof method !== 'string' || !method.trim()) throw new RpcError(ERROR.protocol, 'extension.unregister requires a method name');
      const owner = extensionOwners.get(method);
      if (!owner) throw new RpcError(ERROR.notFound, `${method} is not registered`);
      if (owner !== connection) throw new RpcError(ERROR.conflict, `${method} is owned by another connection`);
      delete handlers[method];
      extensionOwners.delete(method);
      const owned = methodOwners.get(connection);
      owned?.delete(method);
      return { unregistered: method };
    },
    'daemon.status': async () => ({ pid: process.pid, startedAt, version, protocolVersion: PROTOCOL_VERSION, sessions: runtime.list().length, questions: runtime.questions().length, ...(previousExit ? { previousExit } : {}), ...(store ? { persistence: store.health() } : {}), health: await health() }),

    ...sessionHandlers,
    ...workspaceHandlers,
    /** The project board: live claims, decisions and findings (ALPD §18). */
    async 'board.list'(_connection, { projectRoot } = {}) {
      if (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot)) throw new RpcError(-32602, 'An absolute projectRoot is required');
      return { pins: await runtime.board(projectRoot) };
    },

    /** Pauses delegation and wakes on a runtime, or everywhere (ALPD §29). */
    'daemon.pause'(_connection, { runtime: kind, now = false, reason } = {}) {
      try { return runtime.pause({ ...(kind === undefined ? {} : { runtime: kind }), now: now === true, ...(reason === undefined ? {} : { reason }) }); }
      catch (error: any) { throw new RpcError(-32602, error?.message ?? String(error)); }
    },

    'daemon.resume'(_connection, { runtime: kind } = {}) {
      try { return runtime.resume(kind === undefined ? {} : { runtime: kind }); }
      catch (error: any) { throw new RpcError(-32602, error?.message ?? String(error)); }
    },

    'daemon.pauses'() {
      return runtime.pauses();
    },
    // The account email only for a caller that asks (alp dashboard's owner handler, t-9116): the Paseo
    // bridge and other local clients pass the answer on to devices and get account: null.
    'daemon.usage': (_connection, { refresh = false, account = false } = {}) => runtime.usage(refresh === true, account === true),

    /** Asks a finished assignment, or the last one on a task, about its work (ALPD §27). */
    async 'assignment.recall'(_connection, { assignmentId, taskId, projectRoot, question } = {}) {
      if (projectRoot !== undefined && (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot))) throw new RpcError(-32602, 'projectRoot must be absolute');
      try {
        return await runtime.recall({ assignmentId, taskId, projectRoot }, question);
      } catch (error: any) {
        throw new RpcError(ERROR.failed, error?.message ?? String(error));
      }
    },

    'daemon.shutdown': () => {
      setImmediate(() => onShutdown?.());
      return {};
    },

    ...catalogHandlers,
    ...terminalHandlers,
    ...attachmentHandlers,
    // schedule.create/list/get/cancel (schedules/rpc/handlers.ts); runtime.bindSchedules below reaches them here too.
    ...scheduleHandlers,
  };
  runtime.bindSchedules?.(async (action, params) => handlers[`schedule.${action}`](undefined as any, params));
  for (const [method, handler] of Object.entries(operations.handlers)) handlers[method] = (connection, params) => handler(params, { agent: connection.agent === true });
  Object.setPrototypeOf(handlers, null);
  // Every v1 method name stays the daemon's, served here or not, so no extension takes one.
  const originalMethods = new Set([...Object.keys(handlers), ...RPC_METHODS]);
  const reservedNamespaces = new Set([...originalMethods].map(method => method.split('.')[0]));

  async function invokeExtended(owner: Connection, caller: Connection, method: string, params: any) {
    if (owner.pending.size >= 128) throw new RpcError(ERROR.conflict, 'too many pending extension calls');
    const id = ++owner.nextId;
    const invocation = { jsonrpc: '2.0', id, method: 'extension.invoke', params: { method, params, caller: { agent: caller.agent === true, ...(caller.agentName !== undefined ? { agentName: caller.agentName } : {}) } } };
    if (Buffer.byteLength(encodeFrame(invocation), 'utf8') > MAX_FRAME) throw new RpcError(-32600, 'ALP daemon frame exceeds size limit');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        owner.pending.delete(id);
        reject(new RpcError(ERROR.failed, `${method} timed out`));
      }, 30_000);
      owner.pending.set(id, { resolve, reject, timer, caller });
      try { owner.send(invocation); }
      catch (error) { clearTimeout(timer); owner.pending.delete(id); reject(error); }
    });
  }

  /**
   * Liveness is that alpd answers at all. Readiness is that it can do its work: it accepts
   * connections, and its state directory can be read and written now with no write failing.
   * Not ready is a state to fix, not a reason to stop: the checks say what and the codes
   * match alpd's log.
   */
  async function health() {
    const checks: Array<{ id: string; ok: boolean; code?: string; message?: string }> = [{ id: 'accepting', ok: !closing, ...(closing ? { code: 'ALP_SHUTTING_DOWN', message: 'alpd is shutting down' } : {}) }];
    if (store) {
      const probe = await store.probe();
      checks.push({ id: 'state', ...probe });
      const failing = store.failing();
      checks.push({ id: 'persistence', ok: failing === 0, ...(failing ? { code: 'ALP_PERSISTENCE_FAILING', message: `${failing} write${failing > 1 ? 's' : ''} of sessions or timelines failed and have not been written since` } : {}) });
    }
    return { live: true, ready: checks.every(check => check.ok), checks };
  }

  /** What this daemon lists in daemon.hello: only features it serves now (docs/protocol/alp-json-rpc-v1.md §6). */
  const capabilities = [...(runtime.interruptTurn ? [CAPABILITY.sessionInterruptTurn] : []), ...(runtime.commands ? [CAPABILITY.sessionCommands] : []), CAPABILITY.attachAfter, CAPABILITY.extensionMethods, CAPABILITY.sessionListPage, CAPABILITY.questionWatch, CAPABILITY.questionWatchTurns, CAPABILITY.sessionAttention, CAPABILITY.sessionAttentionMark, CAPABILITY.workspaceFiles, CAPABILITY.workspaceFilesRead, CAPABILITY.workspaceFilesBrowse, CAPABILITY.hostDirectories, CAPABILITY.promptImages, ...(store ? [CAPABILITY.promptReceipts, CAPABILITY.sessionHistory] : []), ...(schedules ? [CAPABILITY.schedule] : []), ...(registry ? ['workspace.registry', CAPABILITY.workspaceGit, CAPABILITY.sessionMeta] : []), CAPABILITY.workspaceGitFacts, ...(worktrees ? ['workspace.worktree'] : []), ...(attachments ? [CAPABILITY.attachments] : []), ...(conversation?.enabled ? [CAPABILITY.sessionFork, CAPABILITY.sessionRewind] : []), ...(conversation?.reloads ? [CAPABILITY.sessionReload] : []), ...(conversation?.configures ? [CAPABILITY.sessionConfigureLive] : []), ...(conversation ? [CAPABILITY.sessionResumeCommand] : []), ...(modelCatalog ? [CAPABILITY.catalogLive] : []), ...operations.capabilities];

  /** A response too large for the wire becomes an error the client can read. */
  function fits(response: { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: unknown }) {
    if (frameBytes(response) <= MAX_FRAME) return response;
    log.warn('a response exceeded the frame size limit', { code: 'ALP_IPC_RESPONSE_TOO_LARGE', requestId: String(response.id) });
    return { jsonrpc: '2.0', id: response.id, error: { code: ERROR.failed, message: 'The response exceeds the ALP frame size limit', data: { reason: 'response_too_large' } } };
  }

  /**
   * One incoming message, in the order docs/protocol/alp-json-rpc-v1.md §5 fixes: a message that is
   * not a single JSON-RPC 2.0 object, a frame over the limit, a notification, an invalid id or params,
   * the handshake, an unknown method, then the method's own params. Nothing runs before all of them pass.
   */
  async function dispatch(connection: Connection, message: any, receivedBytes?: number) {
    const single = !!message && typeof message === 'object' && !Array.isArray(message);
    const { id, method, params } = single ? message : {} as any;
    const respond = (body: object) => connection.send(fits({ jsonrpc: '2.0', id: validId(id) ? id : null, ...body }));
    try {
      if (Array.isArray(message)) throw new RpcError(RPC_ERROR.invalidRequest, 'Batch requests are not supported', { reason: 'batch_unsupported' });
      // Validate the envelope before anything else: a frame that is not JSON-RPC 2.0 must never be
      // correlated against (or consume) a pending extension call, however it is shaped.
      if (!single || message.jsonrpc !== '2.0') throw new RpcError(RPC_ERROR.invalidRequest, 'Invalid request');
      const oversized = (receivedBytes ?? frameBytes(message)) > MAX_FRAME;
      // A frame with no `method` property is a response to an outgoing extension.invoke. It must carry
      // exactly one of result/error and an id; a malformed or unknown one is dropped, leaving any
      // pending invocation intact (never mis-correlated, never leaked).
      if (!Object.prototype.hasOwnProperty.call(message, 'method')) {
        const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
        const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
        if (id === undefined || id === null || hasResult === hasError) return;
        const waiter = connection.pending.get(id);
        if (!waiter) return;
        connection.pending.delete(id);
        clearTimeout(waiter.timer);
        if (oversized) { waiter.reject(new RpcError(RPC_ERROR.invalidRequest, 'ALP daemon frame exceeds size limit')); return; }
        if (hasError) waiter.reject(new RpcError(message.error?.code ?? ERROR.failed, message.error?.message ?? 'extension call failed', message.error?.data));
        else waiter.resolve(message.result);
        return;
      }
      if (oversized) throw new RpcError(RPC_ERROR.invalidRequest, 'ALP daemon frame exceeds size limit', { reason: 'frame_too_large' });
      if (typeof method !== 'string') throw new RpcError(RPC_ERROR.invalidRequest, 'Invalid request');
      // v1 defines no notifications to the daemon: one is dropped unrun, and JSON-RPC forbids answering it.
      if (id === undefined) { log.debug('ignored a notification', { code: 'ALP_IPC_NOTIFICATION_IGNORED', method }); return; }
      if (!validId(id)) throw new RpcError(RPC_ERROR.invalidRequest, 'A request id must be a string of at most 128 characters or a safe integer', { reason: 'invalid_id' });
      if (params !== undefined && (params === null || typeof params !== 'object' || Array.isArray(params))) throw new RpcError(RPC_ERROR.invalidParams, 'params must be an object', { reason: 'invalid_params' });
      if (method === 'daemon.hello') {
        if (params?.protocolVersion !== PROTOCOL_VERSION) throw new RpcError(ERROR.protocol, `ALP daemon speaks protocol ${PROTOCOL_VERSION}; restart it after upgrading (alp daemon restart)`, { reason: 'protocol_version', supported: [PROTOCOL_VERSION] });
        const issues = validateParams(method, params)!;
        if (issues.length) throw invalidParams(issues);
        // Checked before the connection changes, so a refused hello changes nothing. The gateway checks a credential's agent with the same AGENT_NAME.
        const named = params?.principal?.agent;
        if (named !== undefined && (typeof named !== 'string' || !AGENT_NAME.test(named))) throw new RpcError(RPC_ERROR.invalidParams, 'principal.agent must be an agent name', { reason: 'invalid_params' });
        connection.helloed = true;
        // Sticky: a later hello never sheds it.
        connection.agent = connection.agent === true || (Array.isArray(params?.capabilities) && params.capabilities.includes(AGENT_CAPABILITY));
        if (typeof params?.client?.name === 'string') connection.client = params.client.name;
        // A named principal (t-1c59: the gateway sends a named agent credential's name) is an agent's
        // too: naming one only ever takes away. The name is a label for the logs, not a credential.
        if (named !== undefined) {
          connection.agent = true;
          if (connection.agentName === undefined) {
            connection.agentName = named;
            log.info('an agent connection named itself', { code: 'ALP_AGENT_CONNECTION', agentName: named, client: connection.client });
          } else if (connection.agentName !== named) log.warn('an agent connection gave a second name; the first stays', { code: 'ALP_AGENT_CONNECTION_RENAME', agentName: connection.agentName, refused: named });
        }
        // Terminals are listed only while the host's switch is on (and the PTY module loads).
        const terminalLimits = await terminals?.advertised();
        respond({ result: { protocolVersion: PROTOCOL_VERSION, daemonVersion: version, pid: process.pid, hostname: os.hostname(), capabilities: terminalLimits ? [...capabilities, CAPABILITY.terminal, CAPABILITY.terminalCapture, CAPABILITY.terminalWatch] : capabilities, ...(attachments ? { attachmentLimits: attachments.limits } : {}), ...(terminalLimits ? { terminalLimits } : {}) } });
        return;
      }
      if (!connection.helloed) throw new RpcError(ERROR.protocol, 'daemon.hello is required first', { reason: 'hello_required' });
      await restored;
      if (!connections.has(connection)) return;
      const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
      if (!handler) throw new RpcError(RPC_ERROR.methodNotFound, `Unknown method '${method}'`);
      // Built-in methods are checked against the v1 schema; extension methods own their params.
      const issues = validateParams(method, params);
      if (issues?.length) throw invalidParams(issues);
      respond({ result: await handler(connection, params ?? {}) });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : /is not open/.test(String((error as Error)?.message)) ? ERROR.notFound : ERROR.failed;
      const data = error instanceof RpcError && error.data !== undefined ? { data: error.data } : {};
      // Plain errors are mostly refusals of bad input; logged so an unexpected one can be traced by its request.
      if (!(error instanceof RpcError) && code === ERROR.failed) log.warn(`${method} failed`, { code: 'ALP_RPC_FAILED', requestId: id, sessionId: params?.sessionId, method, error });
      else if (error instanceof RpcError && (error.data as { reason?: string } | undefined)?.reason === 'persistence_failed') log.warn(`${method} failed`, { code: 'ALP_PERSISTENCE_FAILED', requestId: id, sessionId: params?.sessionId, method, error });
      respond({ error: { code, message: error instanceof Error ? error.message : String(error), ...data } });
    }
  }

  const methodOwners = new Map();
  function disconnect(connection: Connection) {
    const owned = methodOwners.get(connection);
    if (owned) for (const method of owned) { delete handlers[method]; extensionOwners.delete(method); }
    methodOwners.delete(connection);
    for (const [id, waiting] of connection.pending) { clearTimeout(waiting.timer); waiting.reject(new Error('ALP daemon connection closed')); }
    connection.pending.clear();
    for (const owner of connections) for (const [id, waiting] of owner.pending) {
      if (waiting.caller !== connection) continue;
      clearTimeout(waiting.timer);
      owner.pending.delete(id);
      waiting.reject(new Error('ALP daemon caller connection closed'));
    }
    connections.delete(connection);
    watchers.delete(connection);
    terminals?.disconnect(connection);
    for (const root of [...connection.roots]) {
      detach(connection, root);
      void reap(root);
    }
  }

  const server = net.createServer(socket => {
    if (closing) { socket.destroy(); return; }
    const connection: Connection = {
      socket,
      helloed: false,
      roots: new Set(),
      send(message) { if (!socket.destroyed) socket.write(encodeFrame(message)); },
      nextId: 0,
      pending: new Map(),
    };
    connections.add(connection);
    let buffer = '';
    /** UTF-8 bytes of `buffer`, kept as chunks arrive so a large frame costs linear time. */
    let bytes = 0;
    socket.setEncoding('utf8');
    // A frame over MAX_FRAME bytes, its newline included, ends the connection: nothing after it can be trusted to align.
    const tooLarge = () => { log.warn('closed a connection that sent a frame over the size limit', { code: 'ALP_IPC_FRAME_TOO_LARGE' }); buffer = ''; bytes = 0; socket.destroy(); };
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      bytes += Buffer.byteLength(chunk, 'utf8');
      // Only the new chunk can hold a newline: the buffer before it had none.
      if (!chunk.includes('\n')) {
        if (bytes >= MAX_FRAME) tooLarge();
        return;
      }
      let start = 0;
      for (let index = buffer.indexOf('\n', buffer.length - chunk.length); index >= 0; index = buffer.indexOf('\n', start)) {
        const line = buffer.slice(start, index);
        start = index + 1;
        if (Buffer.byteLength(line, 'utf8') + 1 > MAX_FRAME) { tooLarge(); return; }
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { log.warn('a client sent a line that is not JSON', { code: 'ALP_IPC_PARSE_ERROR', bytes: line.length }); connection.send({ jsonrpc: '2.0', id: null, error: { code: RPC_ERROR.parseError, message: 'Parse error' } }); continue; }
        void dispatch(connection, message, Buffer.byteLength(line, 'utf8') + 1);
      }
      // What is left has no newline yet; with one it would already be over the limit.
      buffer = buffer.slice(start);
      bytes = Buffer.byteLength(buffer, 'utf8');
      if (bytes >= MAX_FRAME) tooLarge();
    });
    // A client that goes away mid-write resets its connection; that alone is no trouble.
    socket.on('error', (error: NodeJS.ErrnoException) => log[error.code === 'ECONNRESET' || error.code === 'EPIPE' ? 'debug' : 'warn']('a client connection failed', { code: 'ALP_IPC_SOCKET_ERROR', error }));
    socket.on('close', () => disconnect(connection));
  });

  return {
    extend(method, handler, owner = null) {
      if (typeof method !== 'string' || !method.trim()) throw new Error('extend needs a method name');
      if (originalMethods.has(method)) throw new Error(`${method} is a built-in method and cannot be overridden`);
      if (Object.hasOwn(handlers, method)) throw new Error(`${method} is already registered`);
      handlers[method] = async (_connection, params) => {
        try {
          const result = await handler(params ?? {});
          return result === undefined ? {} : result;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(message.length > 2000 ? `${message.slice(0, 2000)}...` : message);
        }
      };
      if (owner) {
        if (!methodOwners.has(owner)) methodOwners.set(owner, new Set());
        methodOwners.get(owner).add(method);
      }
    },

    async listen() {
      if (process.platform !== 'win32') {
        await assertPrivateDirectory(path.dirname(socketPath), { create: true });
        const existing = await lstat(socketPath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (existing) {
          await assertPrivateSocket(socketPath);
          // Never unlink a live daemon; only ECONNREFUSED proves a stale Unix socket.
          const active = await new Promise<boolean>((resolve, reject) => {
            const probe = net.createConnection(socketPath);
            probe.once('connect', () => { probe.destroy(); resolve(true); });
            probe.once('error', error => { probe.destroy(); if ((error as NodeJS.ErrnoException).code === 'ECONNREFUSED') resolve(false); else reject(error); });
            probe.setTimeout(1000, () => { probe.destroy(); reject(new Error('IPC endpoint probe timed out')); });
          });
          if (active) throw new Error('IPC endpoint already in use by a running daemon');
          const current = await assertPrivateSocket(socketPath);
          if (!current || current.dev !== existing.dev || current.ino !== existing.ino) throw new Error('IPC endpoint changed during validation');
          await unlink(socketPath);
        }
      }
      // libuv unlinks its bind path on close without checking inode identity. Bind at an
      // unpublished sibling, then publish; cleanup of the public endpoint is ours alone.
      const bindPath = process.platform === 'win32' ? socketPath : path.join(path.dirname(socketPath), `.s${randomBytes(3).toString('hex')}`);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(bindPath, () => { server.off('error', reject); resolve(); });
      });
      if (process.platform !== 'win32') {
        try {
          await chmod(bindPath, 0o600);
          const info = await lstat(bindPath);
          await rename(bindPath, socketPath);
          socketIdentity = { dev: info.dev, ino: info.ino };
        }
        catch (error) { await new Promise<void>(resolve => server.close(() => resolve())); throw error; }
      }
      // The endpoint is bound: only now does a start that asked to wait settle records and reopen trees.
      beginRestore?.();
    },

    local() {
      const events = new Set<(envelope: Envelope) => void>();
      const notifications = new Set<(method: string, params: any) => void>();
      const closes = new Set<(error: Error) => void>();
      const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
      let sequence = 0;
      let ended = false;
      const connection: Connection = {
        helloed: true,
        roots: new Set(),
        nextId: 0,
        pending: new Map(),
        send(message: any) {
          if (message.method === 'event') {
            for (const listener of events) listener(message.params);
            return;
          }
          // Other notifications (terminal.event, §12.10) carry a method and no id.
          if (typeof message.method === 'string' && message.id === undefined) {
            for (const listener of notifications) listener(message.method, message.params);
            return;
          }
          const waiter = pending.get(message.id);
          if (!waiter) return;
          pending.delete(message.id);
          if (message.error) waiter.reject(new AlpRpcError(message.error));
          else waiter.resolve(message.result);
        },
      };
      connections.add(connection);
      return {
        request(method, params = {}) {
          if (ended) return Promise.reject(new Error('ALP daemon connection closed'));
          const id = ++sequence;
          return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            void dispatch(connection, { jsonrpc: '2.0', id, method, params });
          });
        },
        onEvent(listener) { events.add(listener); return () => events.delete(listener); },
        onNotification(listener) { notifications.add(listener); return () => notifications.delete(listener); },
        onClose(listener) { closes.add(listener); return () => closes.delete(listener); },
        close() {
          if (ended) return;
          ended = true;
          disconnect(connection);
          // Match the socket client's teardown: in-flight requests fail and close listeners fire.
          const error = new Error('ALP daemon connection closed');
          for (const waiter of pending.values()) waiter.reject(error);
          pending.clear();
          for (const listener of closes) listener(error);
          closes.clear();
        },
      };
    },

    accept(send) {
      const connection: Connection = { helloed: false, roots: new Set(), send, nextId: 0, pending: new Map() };
      connections.add(connection);
      let ended = false;
      return {
        receive(message) { if (!ended) void dispatch(connection, message); },
        close() {
          if (ended) return;
          ended = true;
          disconnect(connection);
        },
      };
    },

    async close() {
      unsubscribeCatalog?.();
      closing = true;
      if (sweeper) clearInterval(sweeper);
      await attachments?.close();
      // Every terminal ends with alpd, its whole process tree killed.
      await terminals?.shutdown();
      // The tick that runs now is waited for: a delivery under way finishes, so its
      // receipt is written and the job is not left half delivered.
      await scheduler?.stop();
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      for (const connection of connections) connection.socket?.destroy();
      await stopped;
      if (socketIdentity) {
        const current = await lstat(socketPath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
        if (current?.isSocket() && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) await unlink(socketPath);
        socketIdentity = undefined;
      }
      await store?.flush();
    },
  };
}
