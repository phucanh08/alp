/**
 * The session methods of alpd (session.*, question.*, label.list): opening, attaching to,
 * prompting, configuring and listing roots, and the questions and attention they raise. alpd
 * spreads them into its handler table (server.ts); the state they read and change (records, live
 * logs, holds, watchers) stays alpd's and reaches them through the context below.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ERROR, PROMPT_IMAGES, RPC_ERROR, base64Bytes } from '@anhlp/alp-protocol';
import type { PromptContent, RuntimeAttachment, SessionSummary } from '@anhlp/alp-protocol/session';
import type { TurnAttention } from '@anhlp/alp-protocol/index';
import type { AlpRuntime, Envelope, SessionSnapshot } from '@anhlp/alp-runtime/index';
import { RpcError } from '../../rpc/rpc-error.ts';
import { agentRefused, digest, listCursor, persistenceFailed, principalOf } from '../../rpc/helpers.ts';
import type { Connection } from '../../rpc/connection.ts';
import { HistoryError } from '../../persistence/history.ts';
import type { SessionRecord, Store } from '../../persistence/store.ts';
import { fromCore } from '../../operations/operations.ts';
import { RegistryError, type createRegistry } from '../../workspaces/registry.ts';
import type { createWorkspaceWorktrees } from '../../workspaces/worktrees.ts';
import { projectKey } from '../../schedules/schedules.ts';
import type { AttachmentRuntime, createAttachmentStore } from '../../attachments/attachments.ts';
import type { createConversation } from '../conversation.ts';

/** The most labels one root carries (capability `session.meta`). */
const SESSION_LABELS_MAX = 20;
const SESSION_ID = /^[\w.:-]{1,128}$/;

// any: params arrive as JSON; each handler checks the fields it reads, as it did inline in server.ts.
type SessionHandler = (connection: Connection, params: any) => Promise<unknown> | unknown;
type SessionMethod = 'session.status' | 'session.message' | 'session.log' | 'question.list' | 'question.watch' | 'session.attention.clear' | 'session.attention.mark'
  | 'question.answer' | 'session.create' | 'session.preview' | 'session.history' | 'session.attach' | 'session.release' | 'session.prompt'
  | 'session.fork' | 'session.rewind' | 'session.reload' | 'session.compact' | 'session.commands' | 'session.resumeCommand' | 'session.interrupt'
  | 'session.configure' | 'session.configure.preview' | 'session.close' | 'session.rename' | 'session.update' | 'label.list' | 'session.archive'
  | 'session.get' | 'session.list';
type KeptRecord = SessionRecord & { activeTurnId?: string };

/**
 * What the session methods share with the rest of alpd. The maps are alpd's own (shared, never
 * copied); `holdRevision` reads the counter alpd reassigns, so a handler always sees its value now.
 */
export type SessionHandlerContext = {
  runtime: AlpRuntime;
  store: Store | undefined;
  runLogDir: string | undefined;
  registry: ReturnType<typeof createRegistry> | undefined;
  worktrees: ReturnType<typeof createWorkspaceWorktrees> | undefined;
  conversation: ReturnType<typeof createConversation> | undefined;
  attachments: ReturnType<typeof createAttachmentStore> | undefined;
  records: Map<string, KeptRecord>;
  rootOf: Map<string, string>;
  logs: Map<string, Envelope[]>;
  cursors: Map<string, number>;
  holds: Map<string, { count: number; open: Promise<void>; release: () => void }>;
  holdRevision: () => number;
  recovering: Map<string, Promise<void>>;
  watchers: Map<Connection, { projectRoot?: string; turns: boolean; attention: boolean }>;
  pendingAcks: Map<string, object>;
  // any: whatever the registry call answers.
  registryCall: (run: () => Promise<any>) => Promise<any>;
  sameProject: (a?: string, b?: string) => boolean;
  projectOf: (root: string) => string | undefined;
  attentionOf: (projectRoot?: string) => Array<{ sessionId: string; attention: TurnAttention }>;
  tellAttention: (root: string, attention: TurnAttention | undefined) => void;
  refuseFenced: (root: string) => void;
  attach: (connection: Connection, root: string) => void;
  detach: (connection: Connection, root: string) => void;
  announce: (connection: Connection, root: string, history: 'replay' | 'skip') => void;
  // any: the spec a client sent, as session.create passes it on.
  resume: (connection: Connection, record: SessionRecord, spec: any, history: 'replay' | 'skip', delegation: boolean) => Promise<SessionSnapshot>;
  persisted: (root: string) => Promise<{ durable?: boolean }>;
  reap: (root: string) => Promise<boolean>;
  known: (sessionId: string) => SessionSummary;
  live: (sessionId: string) => SessionSnapshot;
  summary: (id: string) => SessionSummary | undefined;
  rootIdOf: (sessionId: string) => string;
  replayed: (envelope: Envelope) => Envelope;
  current: (envelope: Envelope) => boolean;
  deliver: (connection: Connection, envelope: Envelope) => void;
  announceQuestions: (connection: Connection, root: string) => void;
  gated: <T>(sessionId: string, run: () => Promise<T>) => Promise<T>;
  deliverOnce: (sessionId: string, clientMessageId: string, fingerprint: string, send: () => Promise<void>, options?: {
    requireReceipt?: boolean;
    prepare?: (key: string) => Promise<void>;
    abandon?: (key: string) => Promise<void>;
  }) => Promise<object>;
  persistAcceptedSpec: (id: string, accepted: SessionSnapshot, fields: { mode?: boolean; thinking?: boolean }) => Promise<void>;
  rootRecord: (sessionId: string) => KeptRecord;
  announceTitle: (root: string, title: string) => void;
  serialLabels: <T>(run: () => Promise<T>) => Promise<T>;
  labelList: () => Promise<Map<string, { name: string; color: string }>>;
};

export function createSessionHandlers({ runtime, store, runLogDir, registry, worktrees, conversation, attachments, records, rootOf, logs, cursors, holds, holdRevision, recovering, watchers, pendingAcks, registryCall, sameProject, projectOf, attentionOf, tellAttention, refuseFenced, attach, detach, announce, resume, persisted, reap, known, live, summary, rootIdOf, replayed, current, deliver, announceQuestions, gated, deliverOnce, persistAcceptedSpec, rootRecord, announceTitle, serialLabels, labelList }: SessionHandlerContext): Record<SessionMethod, SessionHandler> {
  return {
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
      return { questions: runtime.questions().filter(question => projectRoot === undefined || sameProject(projectOf(question.rootId), projectRoot)) };
    },

    /**
     * The questions waiting now; from then on this connection is told of `question` and
     * `question.resolved` in every tree, or those of `projectRoot`, attached or not. Calling it
     * again replaces the filter; it lasts as long as the connection (ALPD §15). With `turns`, also
     * of `turn.ended` of every root; with `attention`, also of each root's attention, now and as it
     * changes (docs/protocol/alp-json-rpc-v1.md §12.2).
     */
    'question.watch'(connection, { projectRoot, turns, attention } = {}) {
      // No await between registering and listing: an event either is in the list or follows it.
      watchers.set(connection, { projectRoot, turns: turns === true, attention: attention === true });
      return {
        questions: runtime.questions().filter(question => projectRoot === undefined || sameProject(projectOf(question.rootId), projectRoot)),
        ...(attention === true ? { attention: attentionOf(projectRoot) } : {}),
      };
    },

    /**
     * Acknowledges a root's attention for every client, as Paseo's clear_agent_attention; with `at`,
     * only the attention set then, so a look at an older turn end never hides a newer one (§12.2).
     */
    async 'session.attention.clear'(_connection, { sessionId, at }) {
      if (typeof sessionId !== 'string') throw new RpcError(-32602, 'sessionId is required');
      if (at !== undefined && typeof at !== 'string') throw new RpcError(-32602, 'at must be a string');
      const record = records.get(sessionId);
      if (!record) throw new RpcError(ERROR.notFound, `No session ${sessionId}`);
      const attention = record.attention;
      if (!attention || (at !== undefined && attention.at !== at)) return { cleared: false };
      // Not a change of the session: its place in session.list stays.
      const ack = {};
      pendingAcks.set(record.id, ack);
      record.attention = undefined;
      try { await store?.put(record); }
      catch (error) {
        // Brought back only if nothing decided its attention meanwhile: a turn that started since, or
        // archiving, ended it anyway. Nobody was told of the clear, so nobody is told of this.
        if (pendingAcks.get(record.id) === ack && !record.attention) record.attention = attention;
        throw persistenceFailed(`the attention of ${record.id}`, error);
      }
      finally { if (pendingAcks.get(record.id) === ack) pendingAcks.delete(record.id); }
      // What holds now: a turn that ended while the write was on its way set a newer one, which stays.
      tellAttention(record.id, record.attention);
      return { cleared: true };
    },

    /**
     * Paseo's Mark as unread (its daemon's markUnread): a finished attention on an idle root that has
     * none, kept for every client as a turn ending unseen would be (§12.2). `marked: false` for a root
     * that is running, archived or already asks, and for a session that is not a root.
     */
    async 'session.attention.mark'(_connection, { sessionId }) {
      if (typeof sessionId !== 'string') throw new RpcError(-32602, 'sessionId is required');
      const record = records.get(sessionId);
      if (!record) throw new RpcError(ERROR.notFound, `No session ${sessionId}`);
      if (record.id !== record.rootId || record.archived || record.attention || record.status === 'running' || runtime.snapshot(record.id)?.busy) return { marked: false };
      const attention: TurnAttention = { reason: 'finished', at: new Date().toISOString() };
      // It decides the attention, so an acknowledgement on its way can no longer bring an older one back.
      pendingAcks.delete(record.id);
      // Not a change of the session: its place in session.list stays.
      record.attention = attention;
      try { await store?.put(record); }
      catch (error) {
        if (record.attention === attention) record.attention = undefined;
        throw persistenceFailed(`the attention of ${record.id}`, error);
      }
      if (record.attention !== attention) return { marked: false };
      tellAttention(record.id, attention);
      return { marked: true, attention };
    },

    async 'question.answer'(connection, { questionId, text, dismiss = false, reason }) {
      // An answer speaks for the user (a gate card's answer decides the gate): never from a connection an ALP agent opened (t-ca1f).
      if (connection.agent) throw new RpcError(ERROR.forbidden, 'Only the user answers a question; this connection was opened by an ALP agent', { reason: 'user_only' });
      if (typeof questionId !== 'string') throw new RpcError(-32602, 'questionId is required');
      if (dismiss !== true && typeof text !== 'string') throw new RpcError(-32602, 'text or dismiss is required');
      // A unique prefix is enough, as in the CLI.
      const matches = runtime.questions().filter(question => question.id === questionId || question.id.startsWith(questionId));
      if (matches.length !== 1) throw new RpcError(ERROR.notFound, matches.length ? `Question id ${questionId} is ambiguous` : `No question ${questionId} waits for an answer`);
      const channel = connection.client?.startsWith('alp-paseo') ? 'paseo' as const : 'web' as const;
      // A gate card's answer settles once its decision is written; one that decides nothing is refused (t-595d).
      const decided = runtime.answer(matches[0].id, dismiss === true ? { dismiss: true, reason, channel } : { text, channel });
      if (decided) await decided.catch((error: any) => {
        // Another answer is being recorded, or another channel decided first: as task.gate.resolve says it.
        if (error?.code === 'GATE_BUSY' || error?.code === 'GATE_DECIDED') throw new RpcError(ERROR.conflict, error.message, { reason: 'task_state' });
        throw fromCore(error);
      });
      return { questionId: matches[0].id };
    },

    async 'session.create'(connection, { sessionId, workspaceId, spec, history = 'skip', delegation = true, resume: resuming = false }) {
      if (workspaceId !== undefined) {
        if (!registry || typeof workspaceId !== 'string') throw new RpcError(-32602, 'Invalid workspaceId');
        try { spec = { ...spec, cwd: await registry.resolve(workspaceId, spec?.cwd) }; } catch (e) { if (e instanceof RegistryError) throw new RpcError(e.code, e.message, e.data); throw e; }
        const placements = (await registryCall(() => registry!.snapshot())).sessions;
        const prior = Object.hasOwn(placements, sessionId) ? placements[sessionId] : undefined;
        if (prior && prior !== workspaceId) throw new RpcError(ERROR.conflict, 'Session belongs to another workspace', { reason: 'workspace_mismatch' });
      }
      if (!spec || typeof spec !== 'object' || typeof spec.cwd !== 'string') throw new RpcError(-32602, 'spec.cwd is required');
      // spec.restore opens a named native thread (or a Claude base) as this root's conversation: the
      // owner's alone. A connection an ALP agent opened never passes it on (a gateway refuses it).
      if (connection.agent && spec.restore !== undefined) {
        const { restore: _restore, ...owned } = spec;
        spec = owned;
      }
      if (worktrees) await registryCall(() => worktrees.assertAvailable(spec.cwd));
      if (sessionId !== undefined && (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId))) throw new RpcError(-32602, 'Invalid session id');
      if (history !== 'replay' && history !== 'skip') throw new RpcError(-32602, 'history must be replay or skip');
      const id = sessionId ?? `ses_${randomBytes(8).toString('hex')}`;
      // A root alpd is reopening after a restart: attach once it is open, rather than open it twice.
      await recovering.get(id);
      // A root whose conversation is being rewound opens once the rewind is through, on its new conversation.
      while (holds.has(id)) await holds.get(id)!.open;
      refuseFenced(id);
      let reservedWorkspaceId: string | undefined;
      const reserve = async () => {
        if (!registry) return;
        const directory = runtime.snapshot(id)?.projectRoot ?? records.get(id)?.session?.projectRoot ?? records.get(id)?.spec?.cwd ?? spec.cwd;
        if (workspaceId) await registryCall(() => registry!.resolve(workspaceId, directory));
        if (Object.hasOwn((await registry.snapshot()).sessions, id)) return;
        if (workspaceId) await registryCall(() => registry!.mutate('placement.assign', { sessionId: id, workspaceId }, { requestId: `reserve:${randomBytes(12).toString('hex')}` }));
        else await registryCall(() => registry!.mutate('placement.prepare', { sessions: [{ id, projectRoot: directory }] }, { requestId: `prepare:${randomBytes(12).toString('hex')}` }));
        reservedWorkspaceId = (await registry.snapshot()).sessions[id];
      };
      const rollback = async () => {
        if (!registry || !reservedWorkspaceId) return;
        await registryCall(() => registry!.mutate('placement.remove', { sessionId: id, workspaceId: reservedWorkspaceId }, { requestId: `rollback:${randomBytes(12).toString('hex')}` }));
      };
      const existing = runtime.snapshot(id);
      if (existing) {
        // Reopening a root that kept working after its viewer left: attach to it.
        const agent = spec.agent ?? spec.restore?.agent;
        if (existing.parentId || (agent !== undefined && agent !== existing.agent)) throw new RpcError(ERROR.failed, 'Session is already open');
        await reserve();
        attach(connection, id);
        announce(connection, id, history);
        return { session: existing, attached: true };
      }
      const record = records.get(id);
      if (!record && resuming) throw new RpcError(ERROR.notFound, `ALP session ${id} no longer exists in alpd`);
      if (record) {
        await reserve();
        try {
          const session = await resume(connection, record, spec, history, delegation);
          return { session, attached: false, resumed: true, ...await persisted(id) };
        } catch (error) { if (!runtime.snapshot(id)) await rollback(); throw error; }
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
      try {
        await reserve();
        attach(connection, id);
        const session = await runtime.open(id, spec, { history, delegation });
        return { session, attached: false, ...await persisted(id) };
      } catch (error) {
        detach(connection, id);
        records.delete(id);
        await store?.remove(id, [id]);
        await rollback();
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
    async 'session.history'(_connection, { sessionId, before, limit, maxBytes }) {
      known(sessionId);
      if (!store) throw new RpcError(1005, 'Durable history unavailable');
      const root = rootOf.get(sessionId) ?? records.get(sessionId)?.rootId ?? sessionId;
      try { const page = await store.history(root, sessionId, { before, limit, maxBytes }); return { ...page, items: page.items.map(item => 'oversized' in item ? item : replayed(item)) }; }
      catch (error) { if (error instanceof HistoryError) throw new RpcError(error.reason === 'stale_cursor' ? 1004 : -32602, error.message, { reason: error.reason }); throw error; }
    },

    async 'session.attach'(connection, { sessionId, replay = true, after, generation }) {
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) throw new RpcError(-32602, 'after must be a cursor');
      known(sessionId);
      const root = rootIdOf(sessionId);
      for (;;) {
        // A rewind reserves its marker cursor before publishing it. Wait through afterRewind,
        // including if it began while a history read awaited, so replay owns every cursor <= tip.
        while (holds.has(root)) await holds.get(root)!.open;
        refuseFenced(root);
        const revision = holdRevision();
        const found = known(sessionId);
        let stored: Envelope[] = [];
        if (replay || (store && !cursors.has(root))) {
          // The in-memory log keeps a live tree's latest events only; older ones come from the store.
          const memory = logs.get(root);
          const covered = !!memory?.length && (memory[0].cursor ?? 1) <= (after ?? 0) + 1;
          if (!covered) stored = store ? await store.timeline(root) : memory ?? [];
        }
        if (holds.has(root) || revision !== holdRevision()) continue;
        if (generation !== undefined) {
          const checkpoint = await store?.history(root, sessionId, { limit: 1 });
          if (holds.has(root) || revision !== holdRevision()) continue;
          if (checkpoint?.generation !== generation) throw new RpcError(1004, 'History generation changed', { reason: 'stale_cursor' });
        }
        // From here to the return nothing awaits, so no live event slips between replay and attach.
        const live = logs.get(root) ?? [];
        const tip = Math.max(cursors.get(root) ?? 0, stored.at(-1)?.cursor ?? 0, live.at(-1)?.cursor ?? 0);
        if (generation !== undefined && replay) {
          const covered = Math.max(after ?? 0, stored.at(-1)?.cursor ?? 0);
          const next = live.find(envelope => (envelope.cursor ?? 0) > covered)?.cursor;
          if ((next !== undefined && next > covered + 1) || (next === undefined && tip > covered)) {
            throw new RpcError(1005, 'History advanced beyond replay coverage; retry attach', { reason: 'history_gap' });
          }
        }
        // Without a store the in-memory log keeps only the latest events: a cursor before them cannot continue either.
        const first = replay ? [...stored, ...live].find(envelope => envelope.cursor !== undefined)?.cursor : undefined;
        // A cursor in history a rewind set aside starts over too: what the client holds after it is not this conversation.
        const reset = after !== undefined && (after > tip || (replay && after < tip && (first === undefined || first > after + 1)) || !!conversation?.discarded(records.get(root), after));
        const from = reset ? 0 : after ?? 0;
        attach(connection, root);
        if (replay) {
          let last = from;
          for (const envelope of stored) if ((envelope.cursor ?? 0) > last) { if (current(envelope)) deliver(connection, replayed(envelope)); last = envelope.cursor ?? last; }
          for (const envelope of live) if ((envelope.cursor ?? 0) > last) { if (current(envelope)) deliver(connection, replayed(envelope)); last = envelope.cursor ?? last; }
        }
        announceQuestions(connection, root);
        // Gate cards are rebuilt from the project's tasks: one changed while nobody watched shows or settles now.
        const gateProject = runtime.snapshot(root)?.projectRoot;
        if (gateProject) void runtime.syncGates?.(gateProject)?.catch(() => {});
        return { session: root === found.id ? found : summary(root), cursor: tip, ...(reset ? { reset: true } : {}) };
      }
    },

    async 'session.release'(connection, { sessionId }) {
      const root = rootOf.get(sessionId) ?? sessionId;
      detach(connection, root);
      return { closed: await reap(root) };
    },

    async 'session.prompt'(_connection, { sessionId, clientMessageId, delivery = 'auto', content, ...context }) {
      if (typeof clientMessageId !== 'string' || !Array.isArray(content)) throw new RpcError(-32602, 'clientMessageId and content are required');
      if (delivery !== 'auto' && delivery !== 'steer') throw new RpcError(-32602, 'delivery must be auto or steer');
      // t-e906: a native command ALP cannot follow (Claude's /clear) is refused here, never sent.
      const refused = runtime.refusesPrompt?.(sessionId, content);
      if (refused) throw new RpcError(-32602, refused, { reason: 'native_command_unsupported' });
      // Images are inline only (the schema refuses a path or URL); here their number and decoded size.
      const images = content.filter((part: { type?: string }) => part?.type === 'image');
      if (images.length > PROMPT_IMAGES.maxCount) throw new RpcError(-32602, `A prompt takes at most ${PROMPT_IMAGES.maxCount} images`);
      let total = 0;
      for (const image of images) {
        const bytes = base64Bytes(image.data);
        total += bytes;
        if (bytes > PROMPT_IMAGES.maxBytes) throw new RpcError(-32602, `An image in a prompt is at most ${PROMPT_IMAGES.maxBytes} bytes`);
        if (total > PROMPT_IMAGES.maxTotalBytes) throw new RpcError(-32602, `The images of a prompt are at most ${PROMPT_IMAGES.maxTotalBytes} bytes together`);
      }
      // Attachments (§12.6): resolved for this principal, project and session, in order. The runtime
      // gets their descriptors (ids, names, digests), never a path; the fingerprint their digests.
      const attached = content.filter((part: { type?: string }) => part?.type === 'attachment');
      let resolved: RuntimeAttachment[] = [];
      if (attached.length) {
        if (!attachments || !store) throw new RpcError(ERROR.unavailable, 'This alpd does not store attachments', { reason: 'attachment_unsupported' });
        resolved = await attachments.resolve(principalOf(context), sessionId, attached.map((part: { attachmentId?: unknown }) => part.attachmentId));
      }
      let index = 0;
      const delivered: PromptContent = attached.length ? content.map((part: { type?: string }) => part?.type === 'attachment' ? resolved[index++] : part) : content;
      const fingerprinted = attached.length ? content.map((part: any) => part?.type === 'attachment' ? { type: 'attachment', attachmentId: part.attachmentId, sha256: resolved.find(entry => entry.attachmentId === part.attachmentId)!.sha256 } : part) : content;
      const send = async () => {
        // Failures of an open session arrive as prompt.failed events; an unknown session has no watcher.
        live(sessionId);
        await runtime.prompt(sessionId, { clientMessageId, delivery, content: delivered });
      };
      if (!store) {
        await gated(sessionId, send);
        return {};
      }
      if (!attached.length) return deliverOnce(sessionId, clientMessageId, digest({ delivery, content }), send);
      return deliverOnce(sessionId, clientMessageId, digest({ delivery, content: fingerprinted }), send, {
        prepare: async key => {
          // Never dropped, never turned into a path: a runtime that cannot read them refuses the prompt here.
          if (!(runtime as AlpRuntime & AttachmentRuntime).takesAttachments?.(sessionId)) throw new RpcError(ERROR.unavailable, 'This session\'s runtime cannot read attachments yet; they stay stored and the prompt was not sent', { reason: 'attachment_unsupported' });
          await attachments!.pin(`prompt:${key}`, sessionId, resolved.map(entry => entry.attachmentId));
        },
        abandon: key => attachments!.release(`prompt:${key}`),
      });
    },

    /** A new root from a root's conversation cut at a turn, or from a branch a rewind set aside (§12.7). */
    async 'session.fork'(connection, params) {
      agentRefused(connection, 'session.fork');
      if (!conversation?.enabled) throw new RpcError(RPC_ERROR.methodNotFound, 'This alpd does not fork conversations (capability session.fork is not listed)');
      return conversation.fork({ ...params, principal: principalOf(params) });
    },

    /** The root's conversation from before a turn on, same id; the later turns stay a recoverable branch, files untouched (§12.7). */
    async 'session.rewind'(connection, params) {
      agentRefused(connection, 'session.rewind');
      if (!conversation?.enabled) throw new RpcError(RPC_ERROR.methodNotFound, 'This alpd does not rewind conversations (capability session.rewind is not listed)');
      return conversation.rewind(params);
    },

    /** Restarts a live root's native process on its own conversation at the idle barrier (§12.8). */
    async 'session.reload'(connection, params) {
      agentRefused(connection, 'session.reload');
      if (!conversation?.reloads) throw new RpcError(RPC_ERROR.methodNotFound, 'This alpd does not reload sessions (capability session.reload is not listed)');
      return conversation.reload(params);
    },

    /** Compacts a live root's context now or at its next turn boundary (t-0e56). */
    async 'session.compact'(connection, { sessionId }) {
      // Compaction rewrites the user's conversation context; an agent's connection may not (t-de1a review).
      agentRefused(connection, 'session.compact');
      if (typeof sessionId !== 'string' || !sessionId) throw new RpcError(-32602, 'sessionId is required');
      if (!runtime.compact) throw new RpcError(RPC_ERROR.methodNotFound, 'This alpd does not compact sessions');
      try { return runtime.compact(sessionId); }
      catch (error) {
        // A refusal keeps its reason (session_busy, runtime_unsupported), so a client can word it (t-de1a).
        const reason = (error as { data?: { reason?: unknown } })?.data?.reason;
        throw new RpcError(ERROR.unavailable, error instanceof Error ? error.message : String(error), typeof reason === 'string' ? { reason } : undefined);
      }
    },

    /** The slash commands and skills a live session's composer offers after "/" (t-f628). */
    async 'session.commands'(_connection, { sessionId }) {
      if (typeof sessionId !== 'string' || !sessionId) throw new RpcError(-32602, 'sessionId is required');
      if (!runtime.commands) throw new RpcError(RPC_ERROR.methodNotFound, 'This alpd lists no commands (capability session.commands is not listed)');
      if (!runtime.snapshot(sessionId)) throw new RpcError(ERROR.notFound, `No session ${sessionId}`, { reason: 'not_found' });
      try {
        const listed = await runtime.commands(sessionId);
        const seen = new Set<string>();
        const commands = listed.filter(command => /^[^\s\u0000-\u001f\u007f]{1,256}$/.test(command.name) && !seen.has(command.name) && seen.add(command.name)).slice(0, 1000)
          .map(command => ({ name: command.name, description: command.description.slice(0, 4096), ...(command.argumentHint ? { argumentHint: command.argumentHint.slice(0, 256) } : {}), kind: command.kind }));
        return { commands };
      } catch (error) { throw new RpcError(ERROR.unavailable, error instanceof Error ? error.message : String(error)); }
    },

    /** The ALP CLI command that follows a session in a terminal, for the clipboard (§12.8). */
    async 'session.resumeCommand'(_connection, { sessionId }) {
      if (!conversation) throw new RpcError(RPC_ERROR.methodNotFound, 'This alpd has no resume command (capability session.resumeCommand is not listed)');
      return conversation.resumeCommand(sessionId);
    },

    async 'session.interrupt'(_connection, { sessionId, turnId }) {
      if (turnId !== undefined) {
        if (typeof turnId !== 'string' || !turnId) throw new RpcError(-32602, 'turnId must be a nonempty string');
        if (!runtime.interruptTurn) throw new RpcError(ERROR.unavailable, 'This runtime cannot interrupt a specific turn');
        return { interrupted: await runtime.interruptTurn(sessionId, turnId) };
      }
      await runtime.interrupt(sessionId);
      return {};
    },

    /**
     * A session's permissions mode while idle; with model, thinking or team, a live root's configuration
     * at the idle barrier through a restart on the same conversation (§12.9, capability session.configure.live).
     */
    async 'session.configure'(_connection, params) {
      const { sessionId, mode } = params;
      if (params.model !== undefined || params.thinking !== undefined || params.team !== undefined) {
        if (!conversation?.configures) throw new RpcError(RPC_ERROR.invalidParams, 'This alpd changes only the mode of a session (capability session.configure.live is not listed)', { reason: 'invalid_params' });
        return conversation.configure(params);
      }
      return { session: await runtime.configure(sessionId, { mode }, {
        onApplied: accepted => persistAcceptedSpec(sessionId, accepted, { mode: true }),
      }) };
    },

    /** What a change of model, thinking, team or mode would run a live root with (§12.9). */
    async 'session.configure.preview'(_connection, params) {
      if (!conversation?.configures) throw new RpcError(RPC_ERROR.methodNotFound, 'This alpd does not preview configurations (capability session.configure.live is not listed)');
      return { preview: await conversation.configurePreview(params) };
    },

    async 'session.close'(_connection, { sessionId }) {
      await runtime.close(sessionId);
      return {};
    },

    /** The user's name for a root, in place of its first prompt (ALPD §61). */
    async 'session.rename'(_connection, { sessionId, title }) {
      if (typeof title !== 'string' || !title.trim() || [...title].length > 200) throw new RpcError(-32602, 'title must be 1 to 200 characters');
      const record = rootRecord(sessionId);
      // A name is not activity: the record keeps its time.
      const before = record.title;
      Object.assign(record, { title: title.replace(/\s+/g, ' ').trim() });
      try { await store?.put(record); }
      catch (error) { record.title = before; throw persistenceFailed(`the name of ${record.id}`, error); }
      announceTitle(record.id, record.title!);
      return { session: summary(record.id) };
    },

    /**
     * Paseo's Pin to top and labels on a root (capability `session.meta`): `pinned` sets or clears
     * pinnedAt, `labels` replaces the root's labels with names of the registry's catalog. Not
     * activity, as a name: updatedAt and the place in session.list stay.
     */
    async 'session.update'(_connection, { sessionId, pinned, labels }) {
      if (pinned === undefined && labels === undefined) throw new RpcError(-32602, 'pinned or labels is required');
      if (pinned !== undefined && typeof pinned !== 'boolean') throw new RpcError(-32602, 'pinned must be a boolean');
      if (labels !== undefined && (!Array.isArray(labels) || labels.length > SESSION_LABELS_MAX || labels.some(name => typeof name !== 'string' || !name.trim()))) throw new RpcError(-32602, `labels must be at most ${SESSION_LABELS_MAX} names`);
      const record = rootRecord(sessionId);
      return serialLabels(async () => {
        let names: string[] | undefined;
        if (labels !== undefined) {
          const catalog = await labelList();
          names = [];
          for (const name of labels as string[]) {
            const label = catalog.get(name.trim().replace(/\s+/g, ' ').toLowerCase());
            if (!label) throw new RpcError(-32602, `No label ${name} in the label catalog`, { reason: 'unknown_label' });
            if (!names.includes(label.name)) names.push(label.name);
          }
        }
        const before = { pinnedAt: record.pinnedAt, labels: record.labels };
        if (pinned !== undefined) record.pinnedAt = pinned ? record.pinnedAt ?? new Date().toISOString() : undefined;
        if (names) record.labels = names.length ? names : undefined;
        try { await store?.put(record); }
        catch (error) { Object.assign(record, before); throw persistenceFailed(`the pin and labels of ${record.id}`, error); }
        return { session: summary(record.id) };
      });
    },

    /** The registry's label catalog, the names session.update takes (capability `session.meta`). */
    async 'label.list'() {
      return { labels: [...(await labelList()).values()] };
    },

    /** Sets a root aside: it closes, with its tree, and leaves the lists until unarchived (ALPD §61). */
    async 'session.archive'(_connection, { sessionId, archived = true }) {
      const record = rootRecord(sessionId);
      if (archived && runtime.snapshot(record.id)) await runtime.close(record.id);
      const before = { archived: record.archived, attention: record.attention };
      // An archived root never asks for attention, nor does an acknowledgement on its way bring one back.
      Object.assign(record, { archived: archived === true ? true : undefined }, archived === true ? { attention: undefined } : {});
      if (archived === true) pendingAcks.delete(record.id);
      try { await store?.put(record); }
      catch (error) { Object.assign(record, before); throw persistenceFailed(`the archive state of ${record.id}`, error); }
      if (before.attention && !record.attention) tellAttention(record.id, undefined);
      return { session: summary(record.id) };
    },

    'session.get'(_connection, { sessionId }) {
      return { session: known(sessionId) };
    },

    /**
     * Roots first, then newest first, by id last. With `limit` a page, and `nextCursor` while more
     * follow; `cursor` continues after the session it names; `query` keeps the sessions whose title
     * or id holds every word of it; `projectRoots` those of any of these projects, as a gateway lists
     * a grant's workspaces (docs/protocol/alp-json-rpc-v1.md §12.1).
     */
    'session.list'(_connection, { projectRoot, projectRoots, rootsOnly = false, includeClosed = false, includeArchived = false, limit, cursor, query } = {}): { sessions: SessionSummary[]; nextCursor?: string } {
      const cache = new Map<string, string>();
      const keyOf = (root: string) => {
        let key = cache.get(root);
        if (key === undefined) {
          key = projectKey(root);
          cache.set(root, key);
        }
        return key;
      };
      // Projects are matched by their canonical identity (projectKey), so sessions created
      // under a symlink (or /var -> /private/var on macOS) are listed when queried by their
      // canonical path, and vice versa.
      const wantedKey = projectRoot === undefined ? undefined : keyOf(projectRoot);
      const allowedKeys = Array.isArray(projectRoots) ? new Set<string>(projectRoots.map(keyOf)) : undefined;
      const after = cursor === undefined ? undefined : listCursor.decode(cursor);
      const words = typeof query === 'string' ? query.toLowerCase().split(/\s+/).filter(Boolean) : [];
      const live = runtime.list();
      const liveChildren = rootsOnly ? new Set(live.filter(session => !!session.parentId).map(session => session.id)) : undefined;
      const ids = new Set<string>();
      for (const session of live) {
        if (!rootsOnly || !session.parentId) ids.add(session.id);
      }
      for (const [id, record] of records) {
        if (!rootsOnly) {
          ids.add(id);
        } else if (record.id === record.rootId && !record.session?.parentId && !liveChildren!.has(id)) {
          ids.add(id);
        }
      }
      const sessions = [...ids].map(summary).filter((session): session is SessionSummary => !!session)
        .filter(session => includeClosed || session.status === 'idle' || session.status === 'running')
        .filter(session => includeArchived || !session.archived)
        .filter(session => !rootsOnly || !session.parentId)
        .filter(session => wantedKey === undefined || keyOf(session.projectRoot) === wantedKey)
        .filter(session => !allowedKeys || allowedKeys.has(keyOf(session.projectRoot)))
        .filter(session => !words.length || words.every(word => `${session.title ?? ''}\n${session.id}`.toLowerCase().includes(word)))
        .sort((a, b) => listCursor.compare(listCursor.key(a), listCursor.key(b)))
        .filter(session => !after || listCursor.compare(listCursor.key(session), after) > 0);
      if (limit === undefined || sessions.length <= limit) return { sessions };
      const page = sessions.slice(0, limit);
      return { sessions: page, nextCursor: listCursor.encode(listCursor.key(page.at(-1)!)) };
    },
  };
}
