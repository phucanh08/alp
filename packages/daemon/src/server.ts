import { createHash, randomBytes } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, unlink, lstat, rename } from 'node:fs/promises';
import net from 'node:net';
import { assertPrivateDirectory, assertPrivateSocket } from '@anhlp/alp-client/index';
import path from 'node:path';
import { AlpRpcError, MAX_FRAME, PROTOCOL_VERSION, ERROR, encodeFrame } from '@anhlp/alp-protocol';
export { ERROR } from '@anhlp/alp-protocol';
import { DEFAULT_MODEL, models, modes, thinkingOptions, type AlpEvent, type AlpRuntime, type Envelope, type SessionSnapshot } from '@anhlp/alp-runtime/index';
import type { Receipt, SessionRecord, SessionStatus, Store, UnreadableReceipt } from './store.js';
import type { SessionSummary } from '@anhlp/alp-protocol/session';

/**
 * alpd's JSON-RPC surface over one shared runtime (plans/reference/ALPD.md §3, §6, §14).
 * Clients attach to root sessions to receive the events of the whole tree. A root
 * with no attached client is closed as soon as it is idle, so work started by a
 * viewer finishes even after the viewer goes away. With a store, every session is
 * recorded and every tree's events are kept, so a closed root can be resumed later.
 */



class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) { super(message); }
}

/**
 * Crash points for the crash-recovery tests (ALPD §66): with ALP_TEST_CRASH_AT naming one,
 * alpd kills itself there as a crash would. Unset, they do nothing.
 */
function crashPoint(name: string) {
  if (process.env.ALP_TEST_CRASH_AT !== name) return;
  console.error(`${new Date().toISOString()} ALP_TEST_CRASH_AT=${name}: killing alpd`);
  process.kill(process.pid, 'SIGKILL');
}

const persistenceFailed = (what: string, error: unknown) =>
  new RpcError(ERROR.failed, `alpd could not record ${what}: ${error instanceof Error ? error.message : String(error)}`, { reason: 'persistence_failed' });

/** A stable hash of JSON data, independent of key order (as Paseo's receipts). */
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value, (_key, candidate) =>
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
      ? Object.fromEntries(Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)))
      : candidate)).digest('hex');
}

type Connection = {
  socket?: net.Socket;
  helloed: boolean;
  roots: Set<string>;
  send(message: unknown): void;
  nextId: number;
  pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout; caller: Connection }>;
};

/** Retained events per live tree, for attach and replay. */
const TREE_LOG_LIMIT = 20_000;
const SESSION_ID = /^[\w.:-]{1,128}$/;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const LIVE: SessionStatus[] = ['initializing', 'idle', 'running'];

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

export function createDaemonServer({ runtime, socketPath, version, onShutdown, store, runLogDir, previousExit }: {
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
}): DaemonServer {
  const connections = new Set<Connection>();
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
  const restored = store ? restore() : Promise.resolve();

  const deliver = (connection: Connection, envelope: Envelope) => connection.send({ jsonrpc: '2.0', method: 'event', params: envelope });

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

  /** Lifecycle bookkeeping for one event; returns true when the record changed. */
  function track(sessionId: string, root: string, event: AlpEvent) {
    const now = new Date().toISOString();
    let record = records.get(sessionId);
    if (event.type === 'session.opened') {
      record ??= { version: 1, id: sessionId, rootId: root, status: 'initializing', createdAt: now, updatedAt: now };
      save(record, { rootId: root, session: event.session, status: 'idle', lastError: undefined, activeTurnId: undefined });
      return;
    }
    if (!record) return;
    if (event.type === 'session.updated') save(record, { session: { ...record.session, ...event.session, ...(event.session.parked ? {} : { parked: undefined }) } });
    // Work on an archived session brings it back.
    else if (event.type === 'turn.started') save(record, { status: 'running', activeTurnId: event.turnId, archived: undefined });
    else if (event.type === 'turn.ended') save(record, { status: 'idle', activeTurnId: undefined, ...(event.state === 'failed' ? { lastError: { message: event.error?.message ?? 'Turn failed' } } : {}) });
    else if (event.type === 'session.failed') save(record, { status: 'error', lastError: event.error });
    else if (event.type === 'session.closed') save(record, { status: record.status === 'error' ? 'error' : 'closed', activeTurnId: undefined });
    else if (event.type === 'item' && sessionId === root && !record.title && event.item.kind === 'user_message' && !event.item.clientMessageId?.startsWith('alp-')) {
      save(record, { title: event.item.text.replace(/\s+/g, ' ').trim().slice(0, 80) });
    }
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
    if (rootOf.has(sessionId)) {
      envelope = keep(root, envelope);
      const log = logs.get(root) ?? [];
      log.push(envelope);
      if (log.length > TREE_LOG_LIMIT) log.splice(0, log.length - TREE_LOG_LIMIT);
      logs.set(root, log);
      track(sessionId, root, event);
    }
    for (const connection of attached.get(root) ?? []) deliver(connection, envelope);
    if (event.type === 'session.closed' && sessionId === root) {
      setImmediate(() => forget(root));
    } else {
      setImmediate(() => void reap(root));
    }
  });

  /**
   * Loads records, settles sessions a crash or a stop left working, and prunes expired
   * trees. Trees with assignments the runtime can continue, or whose root was working,
   * are reopened afterwards (ALPD §31).
   */
  async function restore() {
    await store!.pruneReceipts(RECEIPT_RETENTION_MS);
    const loaded = await store!.list();
    await reconcileReceipts(loaded);
    const now = Date.now();
    const ended = { code: 'daemon_restarted', message: 'alpd stopped while this session was working' };
    const epoch = `restart-${startedAt}`;
    const continuing = new Set(runtime.recoverable().map(entry => entry.assignmentId));
    const reopen: Array<{ record: SessionRecord; working: boolean }> = [];
    const byRoot = new Map<string, SessionRecord[]>();
    for (const record of loaded) byRoot.set(record.rootId, [...(byRoot.get(record.rootId) ?? []), record]);
    for (const [root, tree] of byRoot) {
      const head = tree.find(record => record.id === root);
      if (head && !LIVE.includes(head.status) && now - Date.parse(head.updatedAt) > RETENTION_MS) {
        await store!.remove(root, tree.map(record => record.id));
        continue;
      }
      if (head && resumable(head) && (head.status === 'running' || tree.some(record => continuing.has(record.id)))) reopen.push({ record: head, working: head.status === 'running' });
      if (tree.some(record => LIVE.includes(record.status))) seen(root, await store!.timeline(root));
      for (const record of tree as Array<SessionRecord & { activeTurnId?: string }>) {
        records.set(record.id, record);
        if (!LIVE.includes(record.status)) continue;
        const envelope = (event: AlpEvent): Envelope => ({ sessionId: record.id, epoch, seq: 0, ts: new Date().toISOString(), event });
        // The turn a crash or a stop cut off is reported interrupted, never continued as if nothing happened.
        if (record.activeTurnId) keep(root, envelope({ type: 'turn.ended', turnId: record.activeTurnId, state: 'failed', error: { message: ended.message, code: ended.code } }));
        if (record.id === root) {
          save(record, record.status === 'idle' ? { status: 'closed', activeTurnId: undefined } : { status: 'error', lastError: ended, activeTurnId: undefined });
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
    // Assignments whose tree cannot be reopened end now, and their tasks go back to open.
    const reopened = new Set(reopen.map(entry => entry.record.id));
    for (const rootId of new Set(runtime.recoverable().map(entry => entry.rootId))) {
      if (!reopened.has(rootId)) await runtime.abandon(rootId, 'its root session cannot be reopened').catch(() => {});
    }
    for (const { record, working } of reopen) recovering.set(record.id, recoverTree(record, working));
  }

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
  async function recoverTree(record: SessionRecord, working: boolean) {
    const session = record.session!;
    try {
      const stored = await treeLog(record.id);
      seen(record.id, stored);
      logs.set(record.id, [...stored]);
      await runtime.open(record.id, {
        ...record.spec!,
        persist: true,
        restore: { agent: session.agent, threadId: session.threadId, runtime: session.runtime, model: session.model, workflow: session.workflow },
      }, { history: 'skip', delegation: record.delegation ?? true });
      const outcomes = await runtime.recover(record.id, { continueRoot: working });
      console.log(`${new Date().toISOString()} recovered ${record.id}: ${outcomes.map(outcome => `${outcome.agent} ${outcome.outcome}`).join(', ') || 'root'}`);
    } catch (error: any) {
      console.error(`${new Date().toISOString()} could not recover ${record.id}`, error);
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
  function deliverOnce(sessionId: string, clientMessageId: string, fingerprint: string, send: () => Promise<void>) {
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
      const receipt = (state: Receipt['state'], changes: Partial<Receipt> = {}): Receipt => ({ version: 1, sessionId, clientMessageId, fingerprint, state, ...changes, updatedAt: new Date().toISOString() });
      live(sessionId);
      crashPoint('prompt.before-receipt');
      // Nothing is sent unless the pending receipt is on disk: a crash from here on answers outcome_unknown.
      try { await store!.putReceipt(key, receipt('pending')); }
      catch (error) { throw persistenceFailed(`message ${clientMessageId}; it was not sent`, error); }
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
    const result = previous.catch(() => {}).then(attempt);
    delivering.set(key, result);
    void result.finally(() => { if (delivering.get(key) === result) delivering.delete(key); }).catch(() => {});
    return result;
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
    for (const [id, candidate] of rootOf) if (candidate === root) rootOf.delete(id);
    logs.delete(root);
  }

  /** Closes an idle root that no client watches. */
  async function reap(root: string) {
    if (closing || attached.get(root)?.size || recovering.has(root)) return false;
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
    return { ...session, ...(live ? {} : { busy: false, activeTurnId: undefined }), status, title: record?.title, ...(record?.archived ? { archived: true } : {}), lastError: record?.lastError, createdAt: record?.createdAt, updatedAt: record?.updatedAt };
  }

  /** The record of a root the user acts on. */
  function rootRecord(sessionId: string) {
    if (typeof sessionId !== 'string') throw new RpcError(-32602, 'sessionId is required');
    const record = records.get(sessionId);
    if (!record) throw new RpcError(ERROR.notFound, `No session ${sessionId}`);
    if (record.rootId !== record.id) throw new RpcError(-32602, 'Only a root session can be renamed or archived');
    return record;
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
   * Delivers a tree's history: the root's latest items, then the children's events in their
   * original order, so a grandchild opens while its parent is still open.
   */
  function replayHistory(connection: Connection, root: string, log: Envelope[], { children = true } = {}) {
    const items = new Map<string, Envelope>();
    for (const envelope of log) {
      if (envelope.sessionId === root && envelope.event.type === 'item') items.set(envelope.event.item.id, envelope);
    }
    for (const item of items.values()) deliver(connection, item);
    if (children) for (const envelope of log) if (envelope.sessionId !== root && current(envelope)) deliver(connection, envelope);
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
    const stored = await treeLog(record.id);
    seen(record.id, stored);
    logs.set(record.id, [...stored]);
    attach(connection, record.id);
    try {
      const opened = await runtime.open(record.id, {
        ...record.spec,
        ...(spec.mode !== undefined ? { mode: spec.mode } : {}),
        ...(spec.thinking !== undefined ? { thinking: spec.thinking } : {}),
        persist: true,
        restore: { agent: session.agent, threadId: session.threadId, runtime: session.runtime, model: session.model, workflow: session.workflow },
      }, { history: stored.length ? 'skip' : history, delegation: record.delegation ?? delegation });
      if (history === 'replay') replayHistory(connection, record.id, stored);
      return opened;
    } catch (error) {
      detach(connection, record.id);
      throw error;
    }
  }

  const extensionOwners = new Map<string, Connection>();
  const handlers: Record<string, (connection: Connection, params: any) => Promise<unknown> | unknown> = {
    'extension.register': async (connection, params) => {
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
    'daemon.status': () => ({ pid: process.pid, startedAt, version, protocolVersion: PROTOCOL_VERSION, sessions: runtime.list().length, questions: runtime.questions().length, ...(previousExit ? { previousExit } : {}), ...(store ? { persistence: store.health() } : {}) }),

    'session.status'(_connection, { sessionId }) {
      if (typeof sessionId !== 'string') throw new RpcError(-32602, 'sessionId is required');
      const status = runtime.status(sessionId);
      if (!status) throw new RpcError(ERROR.notFound, `Session ${sessionId} is not live`);
      return { status };
    },

    'session.message'(_connection, { sessionId, text }) {
      runtime.message(sessionId, text);
      return {};
    },

    /** The assignment log of a session's tree, from the run log. */
    async 'session.log'(_connection, { sessionId }) {
      const root = rootOf.get(sessionId) ?? records.get(sessionId)?.rootId ?? sessionId;
      if (!runLogDir) return { rootId: root, entries: [] };
      const text = await readFile(path.join(runLogDir, `${root.replace(/[^\w.-]/g, '_')}.jsonl`), 'utf8').catch(() => '');
      const entries = text.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      return { rootId: root, entries };
    },

    'question.list'(_connection, { projectRoot } = {}) {
      const questions = runtime.questions().filter(question => projectRoot === undefined || runtime.snapshot(question.rootId)?.projectRoot === projectRoot);
      return { questions };
    },

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
    'daemon.usage': (_connection, { refresh = false } = {}) => runtime.usage(refresh === true),

    /** Asks a finished assignment, or the last one on a task, about its work (ALPD §27). */
    async 'assignment.recall'(_connection, { assignmentId, taskId, projectRoot, question } = {}) {
      if (projectRoot !== undefined && (typeof projectRoot !== 'string' || !path.isAbsolute(projectRoot))) throw new RpcError(-32602, 'projectRoot must be absolute');
      try {
        return await runtime.recall({ assignmentId, taskId, projectRoot }, question);
      } catch (error: any) {
        throw new RpcError(ERROR.failed, error?.message ?? String(error));
      }
    },

    'question.answer'(_connection, { questionId, text, dismiss = false, reason }) {
      if (typeof questionId !== 'string') throw new RpcError(-32602, 'questionId is required');
      if (dismiss !== true && typeof text !== 'string') throw new RpcError(-32602, 'text or dismiss is required');
      // A unique prefix is enough, as in the CLI.
      const matches = runtime.questions().filter(question => question.id === questionId || question.id.startsWith(questionId));
      if (matches.length !== 1) throw new RpcError(ERROR.notFound, matches.length ? `Question id ${questionId} is ambiguous` : `No question ${questionId} waits for an answer`);
      runtime.answer(matches[0].id, dismiss === true ? { dismiss: true, reason } : { text });
      return { questionId: matches[0].id };
    },

    'daemon.shutdown': () => {
      setImmediate(() => onShutdown?.());
      return {};
    },

    'catalog.get': () => ({ models, modes, thinkingOptions, defaultModel: `codex:${DEFAULT_MODEL}` }),

    async 'session.create'(connection, { sessionId, spec, history = 'skip', delegation = true, resume: resuming = false }) {
      if (!spec || typeof spec !== 'object' || typeof spec.cwd !== 'string') throw new RpcError(-32602, 'spec.cwd is required');
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId))) throw new RpcError(-32602, 'Invalid session id');
      if (history !== 'replay' && history !== 'skip') throw new RpcError(-32602, 'history must be replay or skip');
      const id = sessionId ?? `ses_${randomBytes(8).toString('hex')}`;
      // A root alpd is reopening after a restart: attach once it is open, rather than open it twice.
      await recovering.get(id);
      const existing = runtime.snapshot(id);
      if (existing) {
        // Reopening a root that kept working after its viewer left: attach to it.
        const agent = spec.agent ?? spec.restore?.agent;
        if (existing.parentId || (agent !== undefined && agent !== existing.agent)) throw new RpcError(ERROR.failed, 'Session is already open');
        attach(connection, id);
        announce(connection, id, history);
        return { session: existing, attached: true };
      }
      const record = records.get(id);
      if (!record && resuming) throw new RpcError(ERROR.notFound, `ALP session ${id} no longer exists in alpd`);
      if (record) {
        const session = await resume(connection, record, spec, history, delegation);
        return { session, attached: false, resumed: true, ...await persisted(id) };
      }
      const { restore: _restore, ...kept } = spec;
      const now = new Date().toISOString();
      const created: SessionRecord = { version: 1, id, rootId: id, spec: kept, delegation, status: 'initializing', createdAt: now, updatedAt: now };
      records.set(id, created);
      // A root is resumable only once its record is on disk; without it the create fails and nothing starts.
      try { await store?.put(created); }
      catch (error) {
        if (records.get(id) === created) records.delete(id);
        throw persistenceFailed(`session ${id}; it was not started`, error);
      }
      attach(connection, id);
      try {
        const session = await runtime.open(id, spec, { history, delegation });
        return { session, attached: false, ...await persisted(id) };
      } catch (error) {
        detach(connection, id);
        records.delete(id);
        await store?.remove(id, [id]);
        throw error;
      }
    },

    /** The team and main a new root would run with, and the teams it may choose (ALPD §60). */
    async 'session.preview'(_connection, { spec }) {
      if (!spec || typeof spec !== 'object' || typeof spec.cwd !== 'string') throw new RpcError(-32602, 'spec.cwd is required');
      return { preview: await runtime.preview(spec) };
    },

    /**
     * Watches a tree. With `after`, the cursor of the last event a client has, only later
     * events are replayed (ALPD §66); a cursor this tree never reached answers `reset: true`
     * with the whole timeline. The replay and the live events that follow are in cursor order.
     */
    async 'session.attach'(connection, { sessionId, replay = true, after }) {
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new RpcError(-32602, 'after must be a cursor');
      const found = known(sessionId);
      const root = rootOf.get(sessionId) ?? records.get(sessionId)?.rootId ?? sessionId;
      let stored: Envelope[] = [];
      if (replay) {
        // The in-memory log keeps a live tree's latest events only; older ones come from the store.
        const memory = logs.get(root);
        const covered = !!memory?.length && (memory[0].cursor ?? 1) <= (after ?? 0) + 1;
        if (!covered) stored = store ? await store.timeline(root) : memory ?? [];
      }
      // From here to the return nothing awaits, so no live event slips between replay and attach.
      const live = logs.get(root) ?? [];
      const tip = Math.max(cursors.get(root) ?? 0, stored.at(-1)?.cursor ?? 0, live.at(-1)?.cursor ?? 0);
      const reset = after !== undefined && after > tip;
      const from = reset ? 0 : after ?? 0;
      attach(connection, root);
      if (replay) {
        let last = from;
        for (const envelope of stored) if ((envelope.cursor ?? 0) > last) { if (current(envelope)) deliver(connection, envelope); last = envelope.cursor ?? last; }
        for (const envelope of live) if ((envelope.cursor ?? 0) > last) { if (current(envelope)) deliver(connection, envelope); last = envelope.cursor ?? last; }
      }
      announceQuestions(connection, root);
      return { session: root === found.id ? found : summary(root), cursor: tip, ...(reset ? { reset: true } : {}) };
    },

    async 'session.release'(connection, { sessionId }) {
      const root = rootOf.get(sessionId) ?? sessionId;
      detach(connection, root);
      return { closed: await reap(root) };
    },

    async 'session.prompt'(_connection, { sessionId, clientMessageId, delivery = 'auto', content }) {
      if (typeof clientMessageId !== 'string' || !Array.isArray(content)) throw new RpcError(-32602, 'clientMessageId and content are required');
      if (delivery !== 'auto' && delivery !== 'steer') throw new RpcError(-32602, 'delivery must be auto or steer');
      const send = async () => {
        // Failures of an open session arrive as prompt.failed events; an unknown session has no watcher.
        live(sessionId);
        await runtime.prompt(sessionId, { clientMessageId, delivery, content });
      };
      if (!store) {
        await send();
        return {};
      }
      return deliverOnce(sessionId, clientMessageId, digest({ delivery, content }), send);
    },

    async 'session.interrupt'(_connection, { sessionId }) {
      await runtime.interrupt(sessionId);
      return {};
    },

    async 'session.configure'(_connection, { sessionId, mode }) {
      return { session: await runtime.configure(sessionId, { mode }) };
    },

    async 'session.close'(_connection, { sessionId }) {
      await runtime.close(sessionId);
      return {};
    },

    /** The user's name for a root, in place of its first prompt (ALPD §61). */
    async 'session.rename'(_connection, { sessionId, title }) {
      if (typeof title !== 'string' || !title.trim() || title.length > 200) throw new RpcError(-32602, 'title must be 1 to 200 characters');
      const record = rootRecord(sessionId);
      // A name is not activity: the record keeps its time.
      const before = record.title;
      Object.assign(record, { title: title.replace(/\s+/g, ' ').trim() });
      try { await store?.put(record); }
      catch (error) { record.title = before; throw persistenceFailed(`the name of ${record.id}`, error); }
      return { session: summary(record.id) };
    },

    /** Sets a root aside: it closes, with its tree, and leaves the lists until unarchived (ALPD §61). */
    async 'session.archive'(_connection, { sessionId, archived = true }) {
      const record = rootRecord(sessionId);
      if (archived && runtime.snapshot(record.id)) await runtime.close(record.id);
      const before = record.archived;
      Object.assign(record, { archived: archived === true ? true : undefined });
      try { await store?.put(record); }
      catch (error) { record.archived = before; throw persistenceFailed(`the archive state of ${record.id}`, error); }
      return { session: summary(record.id) };
    },

    'session.get'(_connection, { sessionId }) {
      return { session: known(sessionId) };
    },

    'session.list'(_connection, { projectRoot, rootsOnly = false, includeClosed = false, includeArchived = false } = {}): { sessions: SessionSummary[] } {
      const ids = new Set([...runtime.list().map(session => session.id), ...records.keys()]);
      const sessions = [...ids].map(summary).filter((session): session is SessionSummary => !!session)
        .filter(session => includeClosed || session.status === 'idle' || session.status === 'running')
        .filter(session => includeArchived || !session.archived)
        .filter(session => !rootsOnly || !session.parentId)
        .filter(session => projectRoot === undefined || session.projectRoot === projectRoot)
        .sort((a, b) => Number(!!a.parentId) - Number(!!b.parentId) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      return { sessions };
    },
  };
  Object.setPrototypeOf(handlers, null);
  const originalMethods = new Set(Object.keys(handlers));
  originalMethods.add('daemon.hello');
  const reservedNamespaces = new Set([...originalMethods].map(method => method.split('.')[0]));

  async function invokeExtended(owner: Connection, caller: Connection, method: string, params: any) {
    if (owner.pending.size >= 128) throw new RpcError(ERROR.conflict, 'too many pending extension calls');
    const id = ++owner.nextId;
    const invocation = { jsonrpc: '2.0', id, method: 'extension.invoke', params: { method, params } };
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

  async function dispatch(connection: Connection, message: any) {
    const { id, method, params } = message ?? {};
    const respond = (body: object) => { if (id !== undefined && id !== null) connection.send({ jsonrpc: '2.0', id, ...body }); };
    try {
      // Validate the envelope before anything else: a frame that is not JSON-RPC 2.0 must never be
      // correlated against (or consume) a pending extension call, however it is shaped.
      if (!message || typeof message !== 'object' || Array.isArray(message) || message.jsonrpc !== '2.0') throw new RpcError(-32600, 'Invalid request');
      const oversized = Buffer.byteLength(encodeFrame(message), 'utf8') > MAX_FRAME;
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
        if (oversized) { waiter.reject(new RpcError(-32600, 'ALP daemon frame exceeds size limit')); return; }
        if (hasError) waiter.reject(new RpcError(message.error?.code ?? ERROR.failed, message.error?.message ?? 'extension call failed', message.error?.data));
        else waiter.resolve(message.result);
        return;
      }
      if (oversized) throw new RpcError(-32600, 'ALP daemon frame exceeds size limit');
      if (typeof method !== 'string') throw new RpcError(-32600, 'Invalid request');
      if (method === 'daemon.hello') {
        if (params?.protocolVersion !== PROTOCOL_VERSION) throw new RpcError(ERROR.protocol, `ALP daemon speaks protocol ${PROTOCOL_VERSION}; restart it after upgrading (alp daemon restart)`);
        connection.helloed = true;
        respond({ result: { protocolVersion: PROTOCOL_VERSION, daemonVersion: version, pid: process.pid } });
        return;
      }
      if (!connection.helloed) throw new RpcError(ERROR.protocol, 'daemon.hello is required first');
      await restored;
      if (!connections.has(connection)) return;
      const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
      if (!handler) throw new RpcError(-32601, `Unknown method '${method}'`);
      respond({ result: await handler(connection, params ?? {}) });
    } catch (error) {
      const code = error instanceof RpcError ? error.code : /is not open/.test(String((error as Error)?.message)) ? ERROR.notFound : ERROR.failed;
      const data = error instanceof RpcError && error.data !== undefined ? { data: error.data } : {};
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
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME) { socket.destroy(); return; }
      for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { connection.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); continue; }
        void dispatch(connection, message);
      }
    });
    socket.on('error', () => {});
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
    },

    local() {
      const events = new Set<(envelope: Envelope) => void>();
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
      closing = true;
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
