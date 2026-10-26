import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AgentPermissionRequest, AgentPermissionResponse } from '@getpaseo/protocol/agent-types';
import type { AgentSnapshotPayload, SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import { listTeams } from '@anhlp/alp-core/teams';
import { modes } from '@anhlp/alp-runtime/index';
import type { DaemonConnection, Envelope, UserQuestion } from '@anhlp/alp-protocol';
import type { HistoryPage } from '@anhlp/alp-protocol';
import type { SessionSummary } from '@anhlp/alp-protocol/session';
import { alpHome, connect, readLock } from '@anhlp/alp-client/index';
import type { ClientContext, Handler } from './gateway.js';
import type { AgentsView, CreateAgentInput, Placement } from './workspaces.js';
import { searchTimeline } from './chat-search.js';
import { TimelineDeltas } from './timeline-items.js';
import { InMemoryAgentTimelineStore } from './timeline-store.js';
import { agentUsage } from '../session-usage.js';
import { firstMessage, messageContent, type MessagePart } from './prompt-content.js';
import { attachments as attachmentStore } from '@anhlp/alp-client/portable';
import { createFacadeUploads } from './uploads.js';
import { uploadRequestId } from '../upload-names.js';
import { createCreationReceipts, creationDigest, type CreationReceipts, type CreationAttempt } from './create-receipts.js';

/**
 * ALP's roots as Paseo's agents (D31 step 3, ALPD §62). Each root session is one agent of the
 * provider "alp"; its team is the agent's model and its permission mode the agent's mode. The
 * timeline is the root's own events, kept in Paseo's timeline store; live changes go to every
 * client as agent_update and agent_stream, as a Paseo daemon does for clients without owned
 * subscriptions. What ALP asks the user (alp_ask, a permission, a trust or approval prompt) is
 * a question card on the root it belongs to (step 4). Each root sits in one of the workspaces
 * the bridge keeps (step 6, workspaces.ts). The team members a root's tree runs are its
 * provider subagents, each with its own timeline (step 7).
 */

/** Where the agents' workspaces are kept (workspaces.ts). */
export type Directory = {
  load(): Promise<void>;
  workspaceIdFor(session: SessionSummary): string;
  placement(session: SessionSummary): Placement;
  assign(sessionId: string, workspaceId: string): Promise<void>;
  prepare(sessions: SessionSummary[]): Promise<void>;
  changed(): void;
};

export const PROVIDER = 'alp';
const POLL_MS = 2_000;
/** Reads of a root's history before its attach gives up when alpd keeps answering that the read is stale. */
const ATTACH_ATTEMPTS = 3;

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;

const capabilities = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: true,
};
const availableModes = modes.map(mode => ({ id: mode.id, label: mode.label }));

/** A team's id stands for the model Paseo shows; a custom root shows its own runtime and model. */
const modelOf = (session: SessionSummary) => session.workflow.mode === 'custom' ? `${session.runtime}:${session.model}` : session.workflow.mode;

export function createAgents({ clientFactory, home, broadcast, directory, receipts = createCreationReceipts(home), log = () => {} }: {
  receipts?: CreationReceipts;
  clientFactory?: (onEvent: (envelope: any) => void) => Promise<DaemonConnection>;
  home?: string;
  broadcast(message: Outbound): void;
  directory: Directory;
  log?: (message: string) => void;
}) {
  const uploads = createFacadeUploads();
  type DeliveryState = { delivery: 'steer' | 'auto'; interrupted?: boolean };
  const deliveries = new WeakMap<ClientContext, Map<string, DeliveryState>>();
  // Upload request ids are daemon-wide for this owner. Serialize same-session/message conversions
  // across sockets too, so a failed duplicate cannot abort another attempt's active upload.
  const promptQueues = new Map<string, Promise<void>>();
  const queued = new WeakMap<ClientContext, number>();
  let queuedTotal = 0;
  async function serialPrompt<T>(client: ClientContext | undefined, key: string, run: () => Promise<T>) {
    if (queuedTotal >= 64 || (client && (queued.get(client) ?? 0) >= 8)) throw new Error('Too many attachment messages in flight; retry when a message finishes');
    queuedTotal++;
    if (client) queued.set(client, (queued.get(client) ?? 0) + 1);
    const previous = promptQueues.get(key);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    promptQueues.set(key, held);
    try { await previous; return await run(); }
    finally {
      queuedTotal--;
      if (client) queued.set(client, (queued.get(client) ?? 1) - 1);
      if (promptQueues.get(key) === held) promptQueues.delete(key);
      release();
    }
  }
  function prepare(content: MessagePart[] | undefined, client?: ClientContext) {
    const files = content?.filter(part => part.type === 'uploaded_file') ?? [];
    if (!files.length) return { content, release() {}, assertActive() { client?.assertActive?.(); } };
    const lease = uploads.lease(client, files);
    return { ...lease, content };
  }
  async function fileLimits(prepared: ReturnType<typeof prepare>, connection: DaemonConnection) {
    prepared.assertActive();
    if (!('files' in prepared)) return;
    const hello = await connection.request<any>('daemon.hello', { protocolVersion: 1, client: { name: 'alp-paseo-facade', version: '1' } });
    prepared.assertActive();
    const limits = hello.attachmentLimits;
    if (!(connection.capabilities ?? hello.capabilities)?.includes('attachments') || !limits || !['maxObjectBytes', 'maxPerPrompt', 'maxPromptBytes', 'maxChunkBytes'].every(k => Number.isSafeInteger(limits[k]) && limits[k] >= 0) || !limits.maxChunkBytes) throw new Error('This ALP daemon does not offer valid attachment limits');
    const files = prepared.files;
    if (files.length > limits.maxPerPrompt || files.reduce((n, f) => n + f.size, 0) > limits.maxPromptBytes || files.some(f => f.size > limits.maxObjectBytes)) throw new Error('Files exceed this ALP daemon’s attachment limits; nothing was sent');
    return limits;
  }
  async function translate(prepared: ReturnType<typeof prepare>, sessionId: string, messageId: string, connection: DaemonConnection) {
    prepared.assertActive();
    if (!('files' in prepared)) return prepared.content;
    const limits = await fileLimits(prepared, connection);
    const files = prepared.files;
    let pending: string | undefined;
    const store = attachmentStore({ request: async (method: any, params: any) => {
      prepared.assertActive();
      const answer = await connection.request<any>(method, params);
      if (method === 'attachment.begin' && answer.state !== 'committed') pending = answer.uploadId;
      if (method === 'attachment.commit') pending = undefined;
      prepared.assertActive();
      return answer;
    } } as DaemonConnection);
    try {
      let index = 0;
      const result: any[] = [];
      for (const [partIndex, part] of prepared.content!.entries()) {
        if (part.type !== 'uploaded_file') { result.push(part); continue; }
        const file = files[index++]!;
        const attachment = await store.upload({ sessionId, name: file.fileName, mimeType: file.mimeType, data: file.data, requestId: uploadRequestId(sessionId, messageId, partIndex), maxChunkBytes: limits.maxChunkBytes });
        prepared.assertActive();
        result.push({ type: 'attachment', attachmentId: attachment.attachmentId });
      }
      return result;
    } catch (error) {
      if (pending) await connection.request('attachment.abort', { uploadId: pending }).catch(() => {});
      throw error;
    }
  }
  let alp: DaemonConnection | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let reconnectScheduled = false;

  const clearRefresh = () => { if (timer) { clearInterval(timer); timer = undefined; } };
  const scheduleRefresh = () => { clearRefresh(); timer = setInterval(() => void refresh().catch(error => log(`agents refresh failed: ${error?.message ?? error}`)), POLL_MS); timer.unref(); };
  const scheduleReconnect = () => {
    if (stopped || reconnectScheduled) return;
    reconnectScheduled = true;
    setTimeout(() => { reconnectScheduled = false; void reconnectLoop(); }, 500).unref?.();
  };
  const openAgentClient = async (): Promise<DaemonConnection> => {
    if (clientFactory) {
      const client = await clientFactory(onEvent);
      if (typeof client?.onClose === 'function') client.onClose(() => { if (!stopped && alp === client) { alp = undefined; clearRefresh(); scheduleReconnect(); } });
      return client;
    }
    const lock = await readLock(home ?? alpHome());
    if (!lock?.ready) throw new Error('ALP daemon is not running');
    const connection = await connect(lock.socket);
    connection.onEvent(onEvent);
    connection.onClose(() => { if (!stopped && alp === connection) { alp = undefined; clearRefresh(); scheduleReconnect(); } });
    return connection;
  };
  const connectAgentClient = async () => {
    const connection = await openAgentClient();
    if (stopped) { connection.close(); throw new Error('ALP facade is closed'); }
    alp = connection;
  };
  /** Drops a connection, whether it is unusable (a failed refresh) or being replaced. */
  const resetConnection = () => { const connection = alp; alp = undefined; clearRefresh(); try { connection?.close(); } catch {} };
  const reconnectLoop = async () => {
    while (!stopped && !alp) {
      try {
        await connectAgentClient();
        await refresh();
        scheduleRefresh();
        // A new connection has its own subscription set. Re-attach every known root so its events
        // flow again, resetting the timeline first: the replayed snapshot is a new epoch rather
        // than duplicates of the history clients already had. `start` connects without this loop,
        // so this path only ever runs after a lost connection, and every known root must re-attach.
        for (const id of [...roots.keys()]) reattachRoot(id);
        return;
      } catch (error: any) {
        // A connection that connected but failed its first refresh is half-open: close it so the
        // next pass reconnects instead of spinning on a dead client.
        resetConnection();
        log(`agents reconnect failed: ${error?.message ?? error}`);
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
  };
  const roots = new Map<string, SessionSummary>();
  /**
   * What each attached root's timeline was built from: the history page read (none where alpd keeps no
   * history), the events applied by their cursor (each once), and the cursor the attach covered: an event
   * at or before it that comes afterwards is one the timeline has (a replay of an attach a later one replaced).
   */
  const durable = new Map<string, { page?: HistoryPage; events: Map<number, Envelope>; floor: number }>();
  let sourceCursor: number | undefined;
  const timelines = new InMemoryAgentTimelineStore();
  const deltas = new Map<string, TimelineDeltas>();
  /** The alpd epoch of the last event seen for each root, to notice a daemon restart. */
  const epochs = new Map<string, string>();
  /** Roots whose history is being replayed into their timeline; nothing of it is broadcast. */
  const replaying = new Set<string>();
  /**
   * The events of roots whose history is being read and attached, held from the read until the
   * attach's answer: alpd may send an attached connection live events meanwhile, before the replay
   * of earlier ones. They apply after the answer, in cursor order and once (as apps/web applyAttach).
   */
  const holding = new Map<string, Envelope[]>();
  /** Tree members a held root opened during its hold, not known yet: their events are the root's to hold (by the opened session's id). */
  const heldMembers = new Map<string, string>();
  const heldRootOf = (sessionId: string) => rootOf(sessionId) ?? heldMembers.get(sessionId);
  function release(root: string) {
    holding.delete(root);
    for (const [member, owner] of heldMembers) if (owner === root) heldMembers.delete(member);
  }
  const attaching = new Map<string, Promise<void>>();
  const turns = new Map<string, string>();
  /** Paseo's attention: a finished turn the user has not looked at yet. */
  const attention = new Map<string, { reason: 'finished' | 'error' | 'permission'; at: string }>();
  /** Questions waiting for the user, and the answers the app gave, until alpd says they are resolved. */
  const questions = new Map<string, UserQuestion>();
  const answered = new Map<string, AgentPermissionResponse>();
  let started: Promise<void> | undefined;
  /** Team members of each root's tree, as Paseo's provider subagents. */
  type Child = { id: string; root: string; parentId: string; agent: string; subtitle: string; toolCallId: string | null; cwd: string; status: 'running' | 'completed' | 'failed' | 'canceled'; createdAt: string; updatedAt: string; description: string | null; openedCursor?: number };
  const children = new Map<string, Child>();
  /**
   * Every session of each attached root's tree as alpd lists them (session.list) when the root attaches:
   * where a member's events go, one silent in the history page read too (t-b589 i). A member becomes a
   * subagent (children) once it works now or shows in the history the timeline holds (promote).
   */
  const members = new Map<string, { root: string; session: SessionSummary }>();
  /** The session list attaches that start together (the bridge's start, a reconnect) share, as each session's listed members. */
  let listing: { connection: DaemonConnection; below: Promise<Map<string, SessionSummary[]>> } | undefined;
  /**
   * Subagents a rewind set aside that clients were not told of yet, by root: the attach that settles next
   * tells them, whichever it is (the one that found them may be replaced or fail first).
   */
  const setAside = new Map<string, Set<string>>();
  const childTimelines = new InMemoryAgentTimelineStore();
  const childDeltas = new Map<string, TimelineDeltas>();

  function agentOf(session: SessionSummary): AgentSnapshotPayload {
    const status = session.status === 'running' || (session.status === 'idle' && session.busy) ? 'running'
      : session.status === 'idle' ? 'idle'
      : session.status === 'initializing' ? 'initializing'
      : session.status === 'error' ? 'error'
      // A closed root that kept its thread opens again on the next message.
      : session.persistent ? 'idle' : 'closed';
    const seen = attention.get(session.id);
    const updatedAt = session.updatedAt ?? new Date().toISOString();
    return {
      id: session.id,
      provider: PROVIDER,
      cwd: session.projectRoot,
      workspaceId: directory.workspaceIdFor(session),
      model: modelOf(session),
      thinkingOptionId: session.thinking,
      createdAt: session.createdAt ?? updatedAt,
      updatedAt,
      lastUserMessageAt: null,
      status,
      activeTurn: session.activeTurnId ? { turnId: session.activeTurnId, startedAt: null } : null,
      // Rewind is real only where alpd rewinds this session's conversation (§12.7); files never (ALP restores none).
      capabilities: { ...capabilities, supportsRewindConversation: rewinds(session), supportsRewindFiles: false, supportsRewindBoth: false },
      currentModeId: session.mode,
      availableModes,
      pendingPermissions: [...questions.values()].filter(question => question.rootId === session.id).map(permissionOf),
      persistence: session.persistent ? { provider: PROVIDER, sessionId: session.id } : null,
      runtimeInfo: { provider: PROVIDER, sessionId: session.id, model: `${session.runtime}:${session.model}`, modeId: session.mode },
      // Paseo's context meter reads the agent's last usage.
      ...(session.usage ? { lastUsage: agentUsage(session.usage) } : {}),
      ...(session.lastError ? { lastError: session.lastError.message } : {}),
      title: session.title ?? null,
      labels: {},
      requiresAttention: !!seen,
      attentionReason: seen?.reason ?? null,
      attentionTimestamp: seen?.at ?? null,
      archivedAt: session.archived ? updatedAt : null,
    };
  }

  const placement = (session: SessionSummary) => directory.placement(session);

  /**
   * An ALP question as Paseo's question card: its text, its choices, and a field for any other
   * answer, headed by the agent that asks. ALP takes the answer as text (the choice's label).
   */
  function permissionOf(question: UserQuestion): AgentPermissionRequest {
    return {
      id: question.id,
      provider: PROVIDER,
      name: 'alp_ask',
      kind: 'question',
      title: question.agent,
      input: { questions: [{ question: question.body, header: question.agent, options: (question.options ?? []).map(label => ({ label })), multiSelect: false, allowOther: true }] },
      metadata: { sessionId: question.sessionId, askedAt: question.askedAt },
    };
  }

  function asked(question: UserQuestion) {
    if (questions.has(question.id)) return;
    questions.set(question.id, question);
    broadcast({ type: 'agent_permission_request', payload: { agentId: question.rootId, request: permissionOf(question) } });
    attention.set(question.rootId, { reason: 'permission', at: question.askedAt });
    stream(question.rootId, { type: 'attention_required', provider: PROVIDER, reason: 'permission', timestamp: question.askedAt, shouldNotify: true }, question.askedAt);
    const root = roots.get(question.rootId);
    if (root) upsert(root);
  }

  function resolved(questionId: string, resolution: AgentPermissionResponse) {
    const question = questions.get(questionId);
    if (!question) return;
    questions.delete(questionId);
    answered.delete(questionId);
    broadcast({ type: 'agent_permission_resolved', payload: { agentId: question.rootId, requestId: questionId, resolution } });
    const waiting = [...questions.values()].some(other => other.rootId === question.rootId);
    if (!waiting && attention.get(question.rootId)?.reason === 'permission') attention.delete(question.rootId);
    const root = roots.get(question.rootId);
    if (root) upsert(root);
  }

  /** What the app shows for a question resolved in alpd: the app's own answer, or why it ended. */
  function resolutionOf(questionId: string, outcome: 'answered' | 'dismissed' | 'timeout' | 'canceled'): AgentPermissionResponse {
    if (outcome === 'answered') return answered.get(questionId) ?? { behavior: 'allow' };
    return answered.get(questionId) ?? { behavior: 'deny', message: outcome === 'dismissed' ? 'Dismissed' : outcome === 'timeout' ? 'No answer in time' : 'Canceled' };
  }

  function upsert(session: SessionSummary) {
    broadcast({ type: 'agent_update', payload: { kind: 'upsert', agent: agentOf(session), project: placement(session) } });
    directory.changed();
  }

  /** Reads alpd's roots again and tells clients what changed. */
  async function refresh() {
    if (!alp) return;
    const { sessions } = await alp.request<{ sessions: SessionSummary[] }>('session.list', { rootsOnly: true, includeClosed: true, includeArchived: true });
    await directory.prepare(sessions);
    const seen = new Set<string>();
    for (const session of sessions) {
      seen.add(session.id);
      const before = roots.get(session.id);
      roots.set(session.id, session);
      if (!before || JSON.stringify(before) !== JSON.stringify(session)) upsert(session);
      // A live root's events come to the bridge, so its timeline stays current.
      if ((session.status === 'idle' || session.status === 'running') && !timelines.has(session.id)) void ensureTimeline(session.id).catch(() => {});
    }
    for (const id of [...roots.keys()]) if (!seen.has(id)) { forget(id); broadcast({ type: 'agent_update', payload: { kind: 'remove', agentId: id } }); directory.changed(); }
    // Questions come as events from attached trees; the list catches any other and any missed end.
    const { questions: waiting } = await alp.request<{ questions: UserQuestion[] }>('question.list', {});
    for (const question of waiting) asked(question);
    const open = new Set(waiting.map(question => question.id));
    for (const id of [...questions.keys()]) if (!open.has(id)) resolved(id, resolutionOf(id, 'canceled'));
  }

  function append(root: string, item: ReturnType<TimelineDeltas['next']>, timestamp: string) {
    if (!item || !timelines.has(root)) return;
    const turnId = turns.get(root);
    const row = timelines.append(root, item, { timestamp, ...(sourceCursor !== undefined ? { seq: sourceCursor } : {}), ...(turnId ? { turnId } : {}) });
    if (replaying.has(root)) return;
    broadcast({ type: 'agent_stream', payload: { agentId: root, event: { type: 'timeline', provider: PROVIDER, item: row.item, ...(turnId ? { turnId } : {}) }, timestamp: row.timestamp, seq: row.seq, epoch: timelines.getEpoch(root) } });
  }

  function stream(root: string, event: Extract<Outbound, { type: 'agent_stream' }>['payload']['event'], timestamp: string) {
    if (replaying.has(root)) return;
    broadcast({ type: 'agent_stream', payload: { agentId: root, event, timestamp } });
  }

  /** The root a session's events belong to: itself, or the root of the tree a team member runs in. */
  const rootOf = (sessionId: string) => roots.has(sessionId) || replaying.has(sessionId) || timelines.has(sessionId) ? sessionId : children.get(sessionId)?.root ?? members.get(sessionId)?.root;

  function subagentOf(child: Child) {
    return {
      id: child.id,
      parentAgentId: child.root,
      parentSubagentId: child.parentId === child.root ? null : child.parentId,
      provider: PROVIDER,
      title: child.agent,
      description: child.description,
      status: child.status,
      createdAt: child.createdAt,
      updatedAt: child.updatedAt,
      toolCallId: child.toolCallId,
      cwd: child.cwd,
      subtitle: child.subtitle,
    };
  }

  function publishChild(child: Child) {
    if (replaying.has(child.root)) return;
    broadcast({ type: 'agent.provider_subagents.update', payload: { kind: 'upsert', subagent: subagentOf(child) } });
  }

  /** A team member opened (or opened again) in a tree the bridge follows. */
  function childOpened(envelope: Envelope & { event: { type: 'session.opened' } }) {
    const { session, cwd } = envelope.event;
    const root = rootOf(session.parentId!);
    if (!root) return;
    if (session.parentId !== root) promote(session.parentId!);
    const child = children.get(session.id) ?? promote(session.id, false) ?? { id: session.id, root, parentId: session.parentId!, agent: session.agent, subtitle: `${session.runtime}:${session.model}`, toolCallId: session.toolCallId ?? null, cwd, status: 'running' as const, createdAt: envelope.ts, updatedAt: envelope.ts, description: null };
    Object.assign(child, { status: 'running', updatedAt: envelope.ts });
    // Where the member first opened in the tree's history: a rewind that cut there set it aside (learnTree).
    if (envelope.cursor !== undefined && (child.openedCursor === undefined || envelope.cursor < child.openedCursor)) child.openedCursor = envelope.cursor;
    children.set(child.id, child);
    childTimeline(child.id);
    publishChild(child);
  }

  /** A member's timeline, started when it has none. */
  function childTimeline(id: string) {
    if (!childTimelines.has(id)) { childTimelines.initialize(id); childDeltas.set(id, new TimelineDeltas()); }
  }

  /** A listed member of a followed tree as a subagent, with the members above it: once it works or shows in the history read. */
  function promote(id: string, publish = true): Child | undefined {
    const known = children.get(id);
    if (known) return known;
    const entry = members.get(id);
    if (!entry) return undefined;
    const { root, session } = entry;
    if (session.parentId && session.parentId !== root) promote(session.parentId, publish);
    const at = session.updatedAt ?? session.createdAt ?? '';
    const child: Child = { id, root, parentId: session.parentId ?? root, agent: session.agent, subtitle: `${session.runtime}:${session.model}`, toolCallId: session.toolCallId ?? null, cwd: session.projectRoot, status: statusOf(session), createdAt: session.createdAt ?? at, updatedAt: at, description: null };
    children.set(id, child);
    childTimeline(id);
    if (publish) publishChild(child);
    return child;
  }

  const statusOf = (session: SessionSummary): Child['status'] => session.status === 'closed' ? 'completed' : session.status === 'error' ? 'failed' : 'running';

  function childEvent(child: Child, envelope: Envelope) {
    const { event } = envelope;
    if (event.type === 'item') {
      if (event.item.kind === 'user_message' && child.description === null) { child.description = event.item.text.slice(0, 500); publishChild(child); }
      childTimeline(child.id);
      const item = childDeltas.get(child.id)?.next(event.item);
      if (!item) return;
      const row = childTimelines.append(child.id, item, { timestamp: envelope.ts, ...(envelope.cursor !== undefined ? { seq: envelope.cursor } : {}) });
      if (!replaying.has(child.root)) broadcast({ type: 'agent.provider_subagents.update', payload: { kind: 'timeline', parentAgentId: child.root, subagentId: child.id, provider: PROVIDER, item: row.item, timestamp: row.timestamp, seq: row.seq, epoch: childTimelines.getEpoch(child.id) } });
      return;
    }
    const status = event.type === 'turn.started' ? 'running'
      : event.type === 'turn.ended' ? (event.state === 'completed' ? 'completed' : event.state === 'failed' ? 'failed' : 'canceled')
      : event.type === 'session.failed' ? 'failed'
      : event.type === 'session.closed' && child.status === 'running' ? 'completed'
      : undefined;
    if (!status) return;
    Object.assign(child, { status, updatedAt: envelope.ts });
    publishChild(child);
  }

  function onEvent(envelope: Envelope, historyRoot?: string) {
    if (!historyRoot && holding.size && envelope.event.type !== 'question' && envelope.event.type !== 'question.resolved') {
      const member = envelope.event.type === 'session.opened' && envelope.event.session.parentId ? envelope.event.session : undefined;
      const owner = heldRootOf(envelope.sessionId) ?? (member ? heldRootOf(member.parentId!) : undefined) ?? envelope.sessionId;
      const held = holding.get(owner);
      if (held) { if (member && !rootOf(member.id)) heldMembers.set(member.id, owner); held.push(envelope); return; }
    }
    sourceCursor = envelope.cursor;
    const cached = durable.get(historyRoot ?? rootOf(envelope.sessionId) ?? envelope.sessionId);
    if (cached && envelope.cursor !== undefined) {
      if (!historyRoot && envelope.cursor <= cached.floor) return;
      if (cached.events.has(envelope.cursor)) return;
      cached.events.set(envelope.cursor, envelope);
    }
    // A question may come from any session of a tree; it belongs to the tree's root.
    if (envelope.event.type === 'question') { asked(envelope.event.question); return; }
    if (envelope.event.type === 'question.resolved') { resolved(envelope.event.questionId, resolutionOf(envelope.event.questionId, envelope.event.outcome)); return; }
    if (envelope.event.type === 'session.opened' && envelope.event.session.parentId) { childOpened(envelope as Envelope & { event: { type: 'session.opened' } }); return; }
    const child = children.get(envelope.sessionId) ?? promote(envelope.sessionId);
    if (child) { childEvent(child, envelope); return; }
    const root = envelope.sessionId;
    const session = roots.get(root);
    if (!session && !replaying.has(root) && !timelines.has(root)) { if (envelope.event.type === 'session.opened' && !envelope.event.session.parentId) void refresh().catch(() => {}); return; }
    const { event } = envelope;
    switch (event.type) {
      case 'item': {
        // Daemon restarts change alpd's epoch: reset the delta state so history is not de-duplicated against stale
        // snapshots. Compare with the last alpd epoch seen for this root, never the bridge's own timeline epoch.
        const seenEpoch = epochs.get(root);
        if (envelope.epoch) epochs.set(root, envelope.epoch);
        if (envelope.epoch && seenEpoch && envelope.epoch !== seenEpoch) deltas.set(root, new TimelineDeltas());
        let maker = deltas.get(root);
        if (!maker) deltas.set(root, maker = new TimelineDeltas());
        append(root, maker.next(event.item), envelope.ts);
        return;
      }
      case 'turn.started':
        turns.set(root, event.turnId);
        // A replayed start is of a turn the attention already knows of (settle sees one in the attach window).
        if (!replaying.has(root)) attention.delete(root);
        stream(root, { type: 'turn_started', provider: PROVIDER, turnId: event.turnId }, envelope.ts);
        break;
      case 'turn.ended': {
        turns.delete(root);
        if (event.state === 'completed') {
          const usage = roots.get(root)?.usage;
          stream(root, { type: 'turn_completed', provider: PROVIDER, turnId: event.turnId, ...(usage ? { usage: agentUsage(usage) } : {}) }, envelope.ts);
        }
        else if (event.state === 'canceled') stream(root, { type: 'turn_canceled', provider: PROVIDER, turnId: event.turnId, reason: event.error?.message ?? 'Stopped' }, envelope.ts);
        else stream(root, { type: 'turn_failed', provider: PROVIDER, turnId: event.turnId, error: event.error?.message ?? 'The turn failed' }, envelope.ts);
        if (!replaying.has(root) && event.state !== 'canceled') {
          const reason = event.state === 'completed' ? 'finished' as const : 'error' as const;
          attention.set(root, { reason, at: envelope.ts });
          stream(root, { type: 'attention_required', provider: PROVIDER, reason, timestamp: envelope.ts, shouldNotify: true }, envelope.ts);
        }
        break;
      }
      case 'usage': {
        // The root's whole latest usage. Paseo's daemon takes a provider's usage_updated into the
        // agent's lastUsage and sends clients the agent again (agent_stream has no usage event on
        // the wire); so does the bridge. A team member's usage stays its own (childEvent). A
        // replayed report is older than the usage alpd lists with the root now: it changes nothing.
        if (replaying.has(root) || !session) return;
        const next = { ...session, usage: event.usage };
        roots.set(root, next);
        upsert(next);
        return;
      }
      case 'session.opened': case 'session.updated': case 'session.closed': case 'session.failed':
        break;
      // A rewind (by any client) replaced the root's conversation: its timeline starts over from alpd's history.
      case 'history.reset':
        if (!replaying.has(root)) { reattachRoot(root); void refresh().catch(() => {}); }
        return;
      default:
        return;
    }
    if (!replaying.has(root)) void refresh().catch(() => {});
  }

  /** The root's timeline, from its history in alpd the first time; afterwards alpd sends its events here. */
  function ensureTimeline(root: string): Promise<void> {
    const active = attaching.get(root);
    if (active) return active;
    if (timelines.has(root)) return Promise.resolve();
    // Without a connection there is nothing to attach to, and no failed attach is kept for the root.
    const connection = alp;
    if (!connection) return Promise.reject(new Error('ALP daemon is not connected'));
    const pending: Promise<void> = (async () => {
      // An attach a later one replaced (a reconnect, a reload, a rewind, a root removed and back) changes
      // nothing more from its next step on, and its awaiters wait for the later one instead (t-b589 c, h).
      const current = () => attaching.get(root) === pending;
      const later = () => attaching.get(root);
      try {
        for (let attempt = 1; ; attempt++) {
          timelines.initialize(root);
          deltas.set(root, new TimelineDeltas());
          durable.delete(root);
          epochs.delete(root);
          turns.delete(root);
          // Each read builds every member's timeline anew with the root's (t-b589 a).
          for (const child of children.values()) if (child.root === root) { childTimelines.initialize(child.id); childDeltas.set(child.id, new TimelineDeltas()); }
          replaying.add(root);
          const held: Envelope[] = [];
          release(root);
          holding.set(root, held);
          const tree = await treeOf(connection, root);
          if (!current()) return later();
          let page: HistoryPage | undefined;
          try { if (connection.capabilities?.includes('session.history')) page = await connection.request('session.history', { sessionId: root }); }
          catch (error: any) { if (error.code !== -32601 && error.code !== 1005) throw error; }
          if (!current()) return later();
          learnTree(root, tree, page);
          // Without a page too, the replay and live events apply once each by their cursor (t-b589 g).
          durable.set(root, { ...(page ? { page } : {}), events: new Map(), floor: 0 });
          if (page) {
            await seedHistoryChildren(connection, root, page.items, current);
            if (!current()) return later();
            for (const item of page.items) { const event = historyEvent(root, item); if (event.event.type !== 'question' && event.event.type !== 'question.resolved') onEvent(event, root); }
          }
          let answer: { reset?: true; cursor?: number } | undefined;
          try { answer = await connection.request('session.attach', { sessionId: root, replay: true, ...(page ? { after: page.tipCursor, generation: page.generation } : {}) }); }
          catch (error: any) {
            if (!current()) return later();
            // The history read is no longer alpd's (a rewind between the read and the attach), or alpd's
            // history advanced past what it can replay after it (history_gap, t-b589 b): read it again.
            const again = (error?.code === 1004 && error?.data?.reason === 'stale_cursor') || (error?.code === 1005 && error?.data?.reason === 'history_gap');
            if (page && again && attempt < ATTACH_ATTEMPTS) continue;
            throw error;
          }
          if (!current()) return later();
          release(root);
          // alpd replayed the whole timeline from its start over the page it no longer holds, or a rewind
          // told of a newer history before the answer: read it again.
          if (page && (answer?.reset || held.some(envelope => envelope.event.type === 'history.reset' && envelope.event.generation !== page.generation))) {
            if (attempt < ATTACH_ATTEMPTS) continue;
            throw new Error('The agent\'s history kept changing while it was read; try again');
          }
          // What came after the page (the replay and live events) in cursor order, each once by its cursor
          // (durable.events); then what has no cursor.
          const tip = page?.tipCursor ?? 0;
          const after = held.filter(envelope => envelope.cursor !== undefined && envelope.cursor > tip).sort((a, b) => a.cursor! - b.cursor!);
          for (const envelope of after) onEvent(envelope);
          for (const envelope of held) if (envelope.cursor === undefined) onEvent(envelope);
          durable.get(root)!.floor = Math.max(tip, typeof answer?.cursor === 'number' ? answer.cursor : 0);
          replaying.delete(root);
          // What came after the page is what happened since the read; without a page all of it is history.
          settle(root, page ? after : []);
          return;
        }
      }
      catch (error) {
        if (!current()) return later();
        timelines.delete(root);
        throw error;
      }
      finally { if (current()) { replaying.delete(root); release(root); attaching.delete(root); } }
    })();
    attaching.set(root, pending);
    return pending;
  }

  /** The members of a root's tree among alpd's sessions (session.list, closed and archived ones too). */
  async function treeOf(connection: DaemonConnection, root: string) {
    if (listing?.connection !== connection) {
      const below = connection.request<{ sessions: SessionSummary[] }>('session.list', { includeClosed: true, includeArchived: true }).then(answer => {
        const index = new Map<string, SessionSummary[]>();
        for (const session of answer.sessions ?? []) if (session.parentId) index.set(session.parentId, [...index.get(session.parentId) ?? [], session]);
        return index;
      });
      const entry = { connection, below };
      listing = entry;
      // Attaches that start while the list is read share it; a later one reads again.
      void below.then(() => {}, () => {}).then(() => { if (listing === entry) listing = undefined; });
    }
    const below = await listing.below;
    const tree = new Map<string, SessionSummary>();
    const next = [root];
    for (let depth = 0; next.length && depth < 32; depth++) {
      for (const parent of next.splice(0)) for (const session of below.get(parent) ?? []) if (!tree.has(session.id)) { tree.set(session.id, session); next.push(session.id); }
    }
    return tree;
  }

  /**
   * The root's members as alpd lists them now; which of its subagents a rewind set aside (kept in setAside
   * for clients to drop: t-b589 d); and the members at work, which are subagents whether or not the history
   * read shows them (an idle or closed one becomes one at its first event, or where the history shows it). A subagent was set aside when the page covers where it opened but holds no event
   * there (a rewind keeps the cursors of what it keeps), or when the page is the whole history and holds
   * none of its events.
   */
  function learnTree(root: string, tree: Map<string, SessionSummary>, page: HistoryPage | undefined) {
    for (const [id, entry] of members) if (entry.root === root) members.delete(id);
    for (const [id, session] of tree) members.set(id, { root, session });
    if (page) {
      const cursors = new Set(page.items.map(item => item.cursor));
      const sessions = new Set(page.items.flatMap(item => 'oversized' in item ? [] : [item.sessionId]));
      const first = page.hasOlder ? page.items[0]?.cursor ?? Number.POSITIVE_INFINITY : 0;
      for (const child of [...children.values()]) {
        if (child.root !== root) continue;
        const cut = child.openedCursor !== undefined && child.openedCursor >= first && !cursors.has(child.openedCursor);
        if (!cut && (page.hasOlder || sessions.has(child.id) || page.items.some(item => 'oversized' in item))) continue;
        children.delete(child.id); childTimelines.delete(child.id); childDeltas.delete(child.id);
        setAside.set(root, (setAside.get(root) ?? new Set()).add(child.id));
      }
    }
    for (const [id, session] of tree) if (session.status === 'running' || session.busy || session.activeTurnId) promote(id, false);
  }

  /**
   * After an attach, what clients must know now: the subagents a rewind set aside, every subagent as it is,
   * and what the root's own turns did since the history read (`window`): a turn that ended there asks for
   * attention, one that started clears it, as live events would. Nothing of the replay is sent as new.
   */
  function settle(root: string, window: Envelope[]) {
    for (const id of setAside.get(root) ?? []) if (!children.has(id)) broadcast({ type: 'agent.provider_subagents.update', payload: { kind: 'remove', parentAgentId: root, subagentId: id } });
    setAside.delete(root);
    for (const child of children.values()) if (child.root === root) publishChild(child);
    let raised: { reason: 'finished' | 'error'; at: string } | undefined;
    let changed = false;
    let refreshing = false;
    for (const { sessionId, ts, event } of window) {
      if (sessionId !== root) continue;
      if (event.type === 'turn.started') { if (attention.delete(root)) changed = true; raised = undefined; }
      else if (event.type === 'turn.ended' && event.state !== 'canceled') { raised = { reason: event.state === 'completed' ? 'finished' : 'error', at: ts }; attention.set(root, raised); changed = true; }
      if (event.type === 'turn.started' || event.type === 'turn.ended' || event.type === 'usage' || event.type.startsWith('session.')) refreshing = true;
    }
    if (raised) stream(root, { type: 'attention_required', provider: PROVIDER, reason: raised.reason, timestamp: raised.at, shouldNotify: true }, raised.at);
    const session = roots.get(root);
    if (changed && session) upsert(session);
    if (refreshing) void refresh().catch(() => {});
  }

  /** The members a history page shows, as subagents; it stops once `current` says the read was replaced. */
  async function seedHistoryChildren(connection: DaemonConnection, root: string, items: HistoryPage['items'], current: () => boolean) {
    const pending = new Set<string>();
    async function seed(id: string, depth = 0): Promise<void> {
      if (!current() || id === root || children.has(id) || promote(id, false)) return;
      if (depth >= 32 || pending.has(id)) throw new Error('Invalid history ancestry');
      pending.add(id);
      // A member alpd did not list yet (it opened after the list was read).
      const { session } = await connection.request<{ session: SessionSummary }>('session.get', { sessionId: id });
      if (!session?.parentId) throw new Error('History child is outside its tree');
      await seed(session.parentId, depth + 1);
      if (!current()) return;
      childOpened({ sessionId: id, epoch: 'history', seq: 0, ts: session.createdAt ?? '', event: { type: 'session.opened', session, cwd: session.projectRoot, effective: { model: session.model, thinking: session.thinking } } });
      const child = children.get(id)!;
      child.status = statusOf(session);
      pending.delete(id);
    }
    for (const item of items) if (!('oversized' in item) && current()) await seed(item.sessionId);
  }

  function historyEvent(root: string, item: HistoryPage['items'][number]): Envelope {
    return 'oversized' in item ? { sessionId: root, epoch: 'history', seq: item.cursor, cursor: item.cursor, ts: '', event: { type: 'item', item: { kind: 'notice', id: `oversized:${item.cursor}`, level: 'warning', text: `History event ${item.cursor} is too large to display (${item.oversized.bytes} bytes).` } } } : item;
  }

  async function olderTimeline(root: string) {
    const cached = durable.get(root);
    if (!cached?.page?.hasOlder || !alp) return;
    const connection = alp;
    const page = await connection.request('session.history', { sessionId: root, before: cached.page.olderCursor }) as HistoryPage;
    if (durable.get(root) !== cached) return;
    const known = new Set(children.keys());
    await seedHistoryChildren(connection, root, page.items, () => durable.get(root) === cached);
    if (durable.get(root) !== cached) return;
    for (const item of page.items) { const event = historyEvent(root, item); cached.events.set(event.cursor!, event); }
    cached.page = page;
    const epoch = timelines.getEpoch(root);
    const events = [...cached.events.values()].sort((a, b) => a.cursor! - b.cursor!);
    timelines.initialize(root, { epoch });
    deltas.set(root, new TimelineDeltas()); epochs.delete(root); turns.delete(root);
    for (const child of children.values()) if (child.root === root) {
      const childEpoch = childTimelines.has(child.id) ? childTimelines.getEpoch(child.id) : undefined;
      childTimelines.initialize(child.id, { epoch: childEpoch });
      childDeltas.set(child.id, new TimelineDeltas());
    }
    cached.events.clear(); replaying.add(root);
    try { for (const event of events) if (event.event.type !== 'question' && event.event.type !== 'question.resolved') onEvent(event, root); }
    finally { replaying.delete(root); }
    // Members the older history showed are subagents now.
    for (const child of children.values()) if (child.root === root && !known.has(child.id)) publishChild(child);
  }

  /**
   * Re-subscribes a known root on a fresh connection. The timeline is dropped first so the
   * replay seeds a new epoch and snapshot deltas are not deduplicated against the previous
   * connection's state; clients see the epoch change and reset instead of duplicating history.
   * The members' timelines start over with the attach's first read (ensureTimeline).
   */
  function reattachRoot(root: string) {
    timelines.delete(root);
    deltas.set(root, new TimelineDeltas());
    durable.delete(root);
    attaching.delete(root);
    epochs.delete(root);
    replaying.delete(root);
    release(root);
    turns.delete(root);
    void ensureTimeline(root).catch(error => log(`agents reattach failed: ${error?.message ?? error}`));
  }

  /**
   * A root alpd no longer lists: everything kept for it goes. Its timeline goes too, not only its
   * delta state: a delta state reset under a kept timeline would append a fully streamed message
   * again (the t-d858 review). Without a timeline, late events of the root are dropped, and a root
   * that reappears attaches again with a replay into a new timeline epoch, as on first sight.
   */
  function forget(root: string) {
    roots.delete(root);
    timelines.delete(root);
    deltas.delete(root);
    durable.delete(root);
    attaching.delete(root);
    replaying.delete(root);
    release(root);
    epochs.delete(root);
    turns.delete(root);
    attention.delete(root);
    for (const child of [...children.values()]) {
      if (child.root !== root) continue;
      children.delete(child.id);
      childTimelines.delete(child.id);
      childDeltas.delete(child.id);
    }
    for (const [id, entry] of [...members]) if (entry.root === root) members.delete(id);
    setAside.delete(root);
  }

  /** Whether alpd rewinds this root's conversation now (capability session.rewind and the root's own support). */
  function rewinds(session: SessionSummary) {
    return !!alp?.capabilities?.includes('session.rewind') && session.conversation?.rewind === true;
  }

  /**
   * The turn a Paseo user message started, and the history generation it was found in: alpd's history
   * read backwards from its tail. A message steered into a running turn started none, so it is refused.
   */
  async function turnOfMessage(root: string, messageId: string) {
    const clientMessageId = messageId.startsWith('user:') ? messageId.slice('user:'.length) : messageId;
    let page = await alp!.request<HistoryPage>('session.history', { sessionId: root });
    const generation = page.generation;
    for (let pages = 0; pages < 100; pages++) {
      for (const item of page.items) {
        if ('oversized' in item || item.sessionId !== root || item.event.type !== 'prompt.accepted' || item.event.clientMessageId !== clientMessageId) continue;
        if (item.event.result !== 'turn') throw new Error('This message was sent into a running turn; rewind to before the message that started it');
        return { turnId: item.event.turnId, generation };
      }
      if (!page.hasOlder || !page.olderCursor) break;
      page = await alp!.request<HistoryPage>('session.history', { sessionId: root, before: page.olderCursor });
    }
    throw new Error('ALP cannot find the turn this message started in the session\'s history');
  }

  function known(agentId: string) {
    const session = roots.get(agentId);
    if (!session) throw Object.assign(new Error(`No agent ${agentId}`), { code: 'agent_not_found' });
    return session;
  }

  /** A root that closed opens again, as ALP does for any viewer's message. */
  async function open(session: SessionSummary) {
    if (session.status === 'idle' || session.status === 'running' || session.status === 'initializing') return;
    await alp!.request('session.create', { sessionId: session.id, spec: { cwd: session.projectRoot }, resume: true });
  }

  /**
   * A live change of a root's model, effort or team (session.configure, §12.9): the root is opened first
   * when closed (configure needs it running), then changed with the bridge's own requestId under the
   * conversation's current generation. alpd refuses what it cannot apply now; nothing is half applied.
   */
  async function configureLive(session: SessionSummary, changes: { model?: string; thinking?: string; team?: string }, requestId?: string) {
    if (!alp!.capabilities?.includes('session.configure.live')) throw new Error('This ALP daemon cannot change a running agent\'s team or model; start a new agent');
    if (session.conversation?.configure !== true) throw new Error('ALP cannot change this agent\'s team or model while it runs; start a new agent');
    await open(session);
    const { generation } = await alp!.request<HistoryPage>('session.history', { sessionId: session.id, limit: 1 });
    await alp!.request('session.configure', { sessionId: session.id, ...changes, requestId: `paseo:${requestId ?? randomUUID()}`, ifGeneration: generation });
  }

  async function teams(cwd?: string) {
    // Host settings have no project; the daemon library settings are not project settings.
    if (!cwd) return { teams: (await listTeams(undefined, { library: home })).filter(team => !team.error).map(team => ({ id: team.id, label: team.label ?? team.id, ...(team.description ? { description: team.description } : {}) })), team: 'pho', mode: 'workspace-write' };
    const { preview } = await alp!.request<{ preview: { teams: Array<{ id: string; label: string; description?: string }>; team: string; mode: string } }>('session.preview', { spec: { cwd } });
    return preview;
  }

  /** A new root of the chosen team, in the workspace the app names (or its directory's), with its first prompt. */
  async function create(input: Omit<CreateAgentInput, 'workspaceId'> & { workspaceId?: string }) {
    const { config } = input;
    if (config.provider !== PROVIDER) throw new Error(`ALP runs its own teams; ${config.provider} is not one of them`);
    // Built and checked before anything is made: an agent is never created without what its first
    // message carried, nor with a first message the facade can already tell is malformed.
    const prepared = prepare(firstMessage(input.initialPrompt, input.images, input.attachments), input.client);
    try {
      prepared.assertActive();
      const { client: _client, creationKey: _key, creationIntent: _intent, attempt: _attempt, ...intent } = input;
      const execute = async ({ state, checkpoint }: CreationAttempt) => {
        prepared.assertActive();
        if (!state.phase || state.phase === 'workspace_created') await checkpoint({ phase: 'create_ready', sessionId: `web-${randomUUID()}`, messageId: input.clientMessageId ?? randomUUID() });
        const sessionId = state.sessionId!;
        if (!/^web-[a-f0-9-]{36}$/.test(sessionId ?? '') || !state.messageId) throw new Error('Invalid reserved creation identity');
        if (state.phase === 'create_pending' || state.phase === 'rename_pending' || state.phase === 'prompt_pending' || state.phase === 'failed') throw new Error(state.error ?? `Creation outcome is unknown for agent ${sessionId}; inspect it before retrying`);
        if (!['create_ready', 'native_created', 'native_ready', 'done'].includes(state.phase!)) throw new Error('Invalid agent creation receipt; inspect it before retrying');
        const connection = alp!;
        if (state.phase === 'create_ready') {
          await fileLimits(prepared, connection); prepared.assertActive();
          await checkpoint({ phase: 'create_pending' });
          try { prepared.assertActive(); }
          catch (error) { await checkpoint({ phase: 'create_ready' }); throw error; }
          try {
            await connection.request('session.create', { sessionId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), spec: { cwd: config.cwd, persist: true, ...(config.model ? { workflow: config.model } : {}), ...(config.modeId ? { mode: config.modeId } : {}) } });
          } catch (error: any) {
            // Only this method's received pre-open parameter refusal proves no native create.
            if (error?.code === -32602) await checkpoint({ phase: 'create_ready' });
            throw error;
          }
          await checkpoint({ phase: 'native_created' });
        }
        if (state.phase === 'native_created') {
          if (config.title) {
            await checkpoint({ phase: 'rename_pending' });
            try { prepared.assertActive(); }
            catch (error) { await checkpoint({ phase: 'native_created' }); throw error; }
            await connection.request('session.rename', { sessionId, title: config.title });
          }
          await checkpoint({ phase: 'native_ready' });
        }
        await refresh(); await ensureTimeline(sessionId); prepared.assertActive();
        if (state.phase !== 'done' && prepared.content) {
          const clientMessageId = state.messageId!;
          await checkpoint({ phase: 'prompt_pending' });
          try {
            const content = await translate(prepared, sessionId, clientMessageId, connection);
            prepared.assertActive();
            const answer = await connection.request('session.prompt', { sessionId, clientMessageId, content });
            // The native no-store contract resolves with {}; receipt-capable daemons return an outcome.
            const failed = answer?.outcome !== undefined && answer.outcome !== 'accepted';
            if (failed || (connection.capabilities?.includes('prompt.receipts') && answer?.outcome !== 'accepted')) {
              const error = `ALP created the agent, but its first message failed: ${answer?.error?.message ?? 'outcome unknown; inspect the agent before retrying'} (agent ${sessionId})`;
              await checkpoint({ phase: 'failed', error }); throw new Error(error);
            }
          } catch (error: any) {
            if (state.phase === 'failed') throw error;
            throw new Error(`ALP created the agent, but its first message failed: ${error?.message ?? error} (agent ${sessionId}; outcome unknown)`);
          }
        }
        if (state.phase !== 'done') await checkpoint({ phase: 'done', agentId: sessionId });
        return agentOf(known(sessionId));
      };
      return await (input.attempt ? execute(input.attempt) : receipts.run('agent', input.creationKey ?? randomUUID(), input.creationIntent ?? intent, !!prepared.content?.some(p => p.type === 'uploaded_file'), (state, checkpoint) => execute({ state, checkpoint })));
    } finally { prepared.release(); }
  }

  const view: AgentsView = {
    roots: () => [...roots.values()],
    snapshot: agentOf,
    async archive(sessionId) {
      await alp!.request('session.archive', { sessionId });
      await refresh();
    },
    markUnread(sessionId) {
      attention.set(sessionId, { reason: 'finished', at: new Date().toISOString() });
      const session = roots.get(sessionId);
      if (session) upsert(session);
    },
    clearAttention(sessionIds) {
      const cleared = sessionIds.filter(id => attention.delete(id));
      for (const id of cleared) { const session = roots.get(id); if (session) upsert(session); }
      return cleared;
    },
    validateFirst(input) { if (input.config.provider !== PROVIDER) throw new Error(`ALP runs its own teams; ${input.config.provider} is not one of them`); const p = prepare(firstMessage(input.initialPrompt, input.images, input.attachments), input.client); p.release(); },
    create: input => create(input),
  };

  const handlers: Record<string, Handler> = {
    async fetch_agents_request(message: Inbound<'fetch_agents_request'>) {
      await started;
      const sessions = [...roots.values()].filter(session => !session.archived)
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
      const offset = Number(message.page?.cursor ?? 0) || 0;
      const limit = message.page?.limit ?? sessions.length;
      const page = sessions.slice(offset, offset + limit);
      const more = offset + limit < sessions.length;
      return {
        type: 'fetch_agents_response',
        payload: {
          requestId: message.requestId,
          subscriptionId: message.subscribe?.subscriptionId ?? null,
          entries: page.map(session => ({ agent: agentOf(session), project: placement(session) })),
          pageInfo: { nextCursor: more ? String(offset + limit) : null, prevCursor: offset ? String(Math.max(0, offset - limit)) : null, hasMore: more },
        },
      } satisfies Outbound;
    },

    /** History: every root, archived ones too unless the filter says, searched, sorted and paged. */
    async fetch_agent_history_request(message: Inbound<'fetch_agent_history_request'>) {
      await started;
      const filter = message.filter ?? {};
      const search = message.search?.trim().toLowerCase();
      const rows = [...roots.values()]
        .filter(session => filter.includeArchived !== false || !session.archived)
        .filter(session => !filter.projectKeys?.length || filter.projectKeys.includes(placement(session).projectKey) || filter.projectKeys.includes(session.projectRoot))
        .map(session => ({ session, agent: agentOf(session) }))
        .filter(({ agent }) => !filter.statuses?.length || filter.statuses.includes(agent.status))
        .filter(({ agent }) => filter.requiresAttention === undefined || !!agent.requiresAttention === filter.requiresAttention)
        .filter(({ session }) => !search || [session.title, session.projectRoot, path.basename(session.projectRoot)].some(text => text?.toLowerCase().includes(search)));
      const busy = (status: string) => status === 'running' ? 0 : status === 'initializing' ? 1 : status === 'error' ? 2 : 3;
      const sort = message.sort?.length ? message.sort : [{ key: 'updated_at' as const, direction: 'desc' as const }];
      rows.sort((a, b) => {
        for (const { key, direction } of sort) {
          const order = key === 'status_priority' ? busy(a.agent.status) - busy(b.agent.status)
            : key === 'created_at' ? a.agent.createdAt.localeCompare(b.agent.createdAt)
            : key === 'title' ? (a.agent.title ?? '').localeCompare(b.agent.title ?? '')
            : a.agent.updatedAt.localeCompare(b.agent.updatedAt);
          if (order) return direction === 'asc' ? order : -order;
        }
        return 0;
      });
      const offset = Number(message.page?.cursor ?? 0) || 0;
      const limit = message.page?.limit ?? rows.length;
      const more = offset + limit < rows.length;
      return {
        type: 'fetch_agent_history_response',
        payload: {
          requestId: message.requestId,
          entries: rows.slice(offset, offset + limit).map(({ session, agent }) => ({ agent, project: placement(session) })),
          pageInfo: { nextCursor: more ? String(offset + limit) : null, prevCursor: offset ? String(Math.max(0, offset - limit)) : null, hasMore: more },
        },
      } satisfies Outbound;
    },

    async fetch_agent_request(message: Inbound<'fetch_agent_request'>) {
      await started;
      const session = roots.get(message.agentId);
      return { type: 'fetch_agent_response', payload: { requestId: message.requestId, agent: session ? agentOf(session) : null, project: session ? placement(session) : null, error: null } } satisfies Outbound;
    },

    async fetch_agent_timeline_request(message: Inbound<'fetch_agent_timeline_request'>) {
      await started;
      const direction = message.direction ?? (message.cursor ? 'after' : 'tail');
      const empty = { requestId: message.requestId, agentId: message.agentId, direction, projection: 'projected' as const, reset: false, staleCursor: false, gap: false, hasOlder: false, hasNewer: false, ...(message.mergeWindow ? { mergeWindow: true } : {}) };
      try {
        const session = known(message.agentId);
        await ensureTimeline(session.id);
        if (direction === 'before' && durable.get(session.id)?.page?.hasOlder) await olderTimeline(session.id);
        const page = timelines.fetch(session.id, { direction, ...(message.cursor ? { cursor: message.cursor } : {}), limit: message.limit ?? (direction === 'after' ? 0 : 200) });
        return {
          type: 'fetch_agent_timeline_response',
          payload: {
            ...empty,
            agent: agentOf(session),
            epoch: page.epoch,
            reset: page.reset,
            staleCursor: page.staleCursor,
            gap: page.gap,
            window: page.window,
            startCursor: page.startSeq !== null ? { epoch: page.epoch, seq: page.startSeq } : null,
            endCursor: page.endSeq !== null ? { epoch: page.epoch, seq: page.endSeq } : null,
            hasOlder: page.hasOlder || !!durable.get(session.id)?.page?.hasOlder,
            hasNewer: page.hasNewer,
            entries: page.rows.map(row => ({ provider: PROVIDER, item: row.item, ...(row.turnId ? { turnId: row.turnId } : {}), timestamp: row.timestamp, seqStart: row.seqStart, seqEnd: row.seqEnd, sourceSeqRanges: row.sourceSeqRanges, collapsed: row.collapsed })),
            error: null,
          },
        } satisfies Outbound;
      } catch (error: any) {
        return { type: 'fetch_agent_timeline_response', payload: { ...empty, agent: null, epoch: '', window: { minSeq: 0, maxSeq: 0, nextSeq: 0 }, startCursor: null, endCursor: null, entries: [], error: error?.message ?? String(error) } } satisfies Outbound;
      }
    },

    /** Find in chat: the user and assistant messages that match, as Paseo's daemon finds them. */
    async 'agent.timeline.search.request'(message: Inbound<'agent.timeline.search.request'>) {
      const reply = (fields: Partial<Extract<Outbound, { type: 'agent.timeline.search.response' }>['payload']>): Outbound =>
        ({ type: 'agent.timeline.search.response', payload: { requestId: message.requestId, agentId: message.agentId, epoch: '', locations: [], nextCursor: null, error: null, ...fields } });
      try {
        await started;
        const session = known(message.agentId);
        await ensureTimeline(session.id);
        const epoch = timelines.getEpoch(session.id);
        return reply({ epoch, ...searchTimeline({ rows: timelines.getRows(session.id), query: message.query, cursor: message.cursor }) });
      } catch (error: any) {
        return reply({ error: error?.message ?? String(error) });
      }
    },

    async 'agent.provider_subagents.list.request'(message: Inbound<'agent.provider_subagents.list.request'>) {
      const reply = (subagents: ReturnType<typeof subagentOf>[], error: string | null): Outbound => ({ type: 'agent.provider_subagents.list.response', payload: { requestId: message.requestId, parentAgentId: message.parentAgentId, subagents, error } });
      try {
        await started;
        const session = known(message.parentAgentId);
        await ensureTimeline(session.id);
        return reply([...children.values()].filter(child => child.root === session.id).map(subagentOf), null);
      } catch (error: any) {
        return reply([], error?.message ?? String(error));
      }
    },

    /** A team member's own conversation, paged as a root's is. */
    async 'agent.provider_subagents.timeline.get.request'(message: Inbound<'agent.provider_subagents.timeline.get.request'>) {
      const direction = message.direction ?? (message.cursor ? 'after' : 'tail');
      const base = { requestId: message.requestId, parentAgentId: message.parentAgentId, subagentId: message.subagentId, provider: PROVIDER, direction, projection: 'projected' as const };
      try {
        await started;
        await ensureTimeline(known(message.parentAgentId).id);
        if (direction === 'before' && durable.get(message.parentAgentId)?.page?.hasOlder) await olderTimeline(message.parentAgentId);
        const child = children.get(message.subagentId);
        if (!child || child.root !== message.parentAgentId) throw new Error(`No subagent ${message.subagentId}`);
        const page = childTimelines.fetch(child.id, { direction, ...(message.cursor ? { cursor: message.cursor } : {}), limit: message.limit ?? (direction === 'after' ? 0 : 200) });
        return {
          type: 'agent.provider_subagents.timeline.get.response',
          payload: {
            ...base,
            epoch: page.epoch,
            startCursor: page.startSeq !== null ? { epoch: page.epoch, seq: page.startSeq } : null,
            endCursor: page.endSeq !== null ? { epoch: page.epoch, seq: page.endSeq } : null,
            reset: page.reset,
            staleCursor: page.staleCursor,
            gap: page.gap,
            window: page.window,
            hasOlder: page.hasOlder || !!durable.get(message.parentAgentId)?.page?.hasOlder,
            hasNewer: page.hasNewer,
            rows: page.rows.map(row => ({ item: row.item, timestamp: row.timestamp, seq: row.seqEnd, seqStart: row.seqStart, seqEnd: row.seqEnd, sourceSeqRanges: row.sourceSeqRanges })),
            error: null,
          },
        } satisfies Outbound;
      } catch (error: any) {
        return { type: 'agent.provider_subagents.timeline.get.response', payload: { ...base, epoch: '', reset: false, staleCursor: false, gap: false, window: { minSeq: 0, maxSeq: 0, nextSeq: 0 }, hasOlder: false, hasNewer: false, rows: [], error: error?.message ?? String(error) } } satisfies Outbound;
      }
    },

    async create_agent_request(message: Inbound<'create_agent_request'>, client: ClientContext) {
      const { config } = message;
      const fail = (error: unknown): Outbound => ({ type: 'status', payload: { status: 'agent_create_failed', requestId: message.requestId, error: error instanceof Error ? error.message : String(error) } });
      try {
        await started;
        const workspaceId = message.workspaceId;
        // Fingerprint the complete received intent, including fields this facade does not interpret.
        const { requestId: _requestId, idempotencyKey, ...intent } = message as typeof message & { idempotencyKey?: string };
        view.validateFirst?.({ ...message, client }); client.assertActive?.();
        const agent = await create({ config, client, creationIntent: intent, creationKey: `request:${creationDigest(idempotencyKey ?? message.requestId)}`, ...(workspaceId ? { workspaceId } : {}), ...(message.initialPrompt ? { initialPrompt: message.initialPrompt } : {}), ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}), ...(message.images ? { images: message.images } : {}), ...(message.attachments ? { attachments: message.attachments } : {}) });
        client.emit({ type: 'status', payload: { status: 'agent_created', requestId: message.requestId, agentId: agent.id, agent } });
      } catch (error) {
        return fail(error);
      }
    },

    'file.upload.request': (message, client) => uploads.request(message, client),

    async send_agent_message_request(message: Inbound<'send_agent_message_request'>, client: ClientContext) {
      const reply = (error: string | null): Outbound => ({ type: 'send_agent_message_response', payload: { requestId: message.requestId, agentId: message.agentId, accepted: !error, error } });
      let prepared: ReturnType<typeof prepare> | undefined;
      try {
        prepared = prepare(messageContent(message.text, message.images, message.attachments), client);
        await started;
        prepared.assertActive();
        const connection = alp!;
        const session = known(message.agentId);
        const messageId = message.messageId ?? randomUUID();
        const run = async () => {
          // Validate the socket grant before every retry, including an already committed daemon upload.
          const content = await translate(prepared!, session.id, messageId, connection);
          prepared!.assertActive();
          await open(session);
          prepared!.assertActive();
          await ensureTimeline(session.id);
          prepared!.assertActive();
          const running = session.status === 'running' || session.busy;
          let delivery: 'auto' | 'steer' = running && message.activeTurnBehavior !== 'interrupt' ? 'steer' : 'auto';
          let deliveryState: DeliveryState | undefined;
          if (client && message.messageId) {
            let cache = deliveries.get(client);
            if (!cache) { cache = new Map(); deliveries.set(client, cache); }
            const key = JSON.stringify([session.id, messageId]);
            deliveryState = cache.get(key) ?? { delivery };
            delivery = deliveryState.delivery;
            cache.set(key, deliveryState);
            if (cache.size > 128) cache.delete(cache.keys().next().value!);
          }
          if (running && message.activeTurnBehavior === 'interrupt' && !deliveryState?.interrupted) {
            await connection.request('session.interrupt', { sessionId: session.id });
            if (deliveryState) deliveryState.interrupted = true;
          }
          prepared!.assertActive();
          if (deliveryState) deliveryState.interrupted = true;
          const answer = await connection.request('session.prompt', { sessionId: session.id, clientMessageId: messageId, delivery, content });
          if (answer?.outcome === 'failed') return reply(answer.error?.message ?? 'ALP could not deliver the message');
          attention.delete(session.id);
          return reply(null);
        };
        return 'files' in prepared ? await serialPrompt(client, JSON.stringify([session.id, messageId]), run) : await run();
      } catch (error: any) { return reply(error?.message ?? String(error)); }
      finally { prepared?.release(); }
    },

    async send_agent_message(message: Omit<Inbound<'send_agent_message_request'>, 'type' | 'requestId'> & { type: 'send_agent_message' }, client: ClientContext) {
      const response = await handlers.send_agent_message_request({ ...message, type: 'send_agent_message_request', requestId: '' }, client) as Extract<Outbound, { type: 'send_agent_message_response' }>;
      if (response.payload.error) client.emit({ type: 'agent_stream', payload: { agentId: message.agentId, event: { type: 'turn_failed', provider: PROVIDER, error: response.payload.error }, timestamp: new Date().toISOString() } } as Outbound);
    },

    /**
     * Paseo's rewind, as ALP's session.rewind (docs/protocol/alp-json-rpc-v1.md §12.7): the conversation
     * goes back to before the message, under the same agent; the later turns stay a recoverable branch.
     * Files are never restored or changed, so the files and both modes are refused.
     */
    async 'agent.rewind.request'(message: Inbound<'agent.rewind.request'>) {
      const reply = (error: string | null): Outbound => ({ type: 'agent.rewind.response', payload: { requestId: message.requestId, agentId: message.agentId, ok: !error, error } });
      try {
        await started;
        if (message.mode !== 'conversation') return reply('ALP rewinds the conversation only; it never restores or changes files');
        const session = known(message.agentId);
        if (!rewinds(session)) return reply('This agent\'s conversation cannot be rewound');
        const { turnId, generation } = await turnOfMessage(session.id, message.messageId);
        await alp!.request('session.rewind', { sessionId: session.id, requestId: `paseo:${message.requestId}`, ifGeneration: generation, beforeTurnId: turnId });
        reattachRoot(session.id);
        void refresh().catch(() => {});
        return reply(null);
      } catch (error: any) {
        return reply(error?.message ?? String(error));
      }
    },

    /**
     * Paseo's Reload agent (refresh_agent_request): a live root restarts its native process on its own
     * conversation and configuration (session.reload, §12.8), refused while it or its agents work; a
     * closed one opens again on its conversation, as any message would open it; an archived one is
     * unarchived first, as Paseo's refresh does. Then the timeline attaches again.
     */
    async refresh_agent_request(message: Inbound<'refresh_agent_request'>) {
      await started;
      let session = known(message.agentId);
      if (session.archived) {
        await alp!.request('session.archive', { sessionId: session.id, archived: false });
        await refresh();
        session = roots.get(session.id) ?? session;
      }
      if (session.status === 'idle' || session.status === 'running' || session.status === 'initializing') {
        if (!alp!.capabilities?.includes('session.reload') || session.conversation?.reload !== true) throw Object.assign(new Error('ALP cannot reload this agent\'s runtime'), { code: 'agent_refresh_failed' });
        const { generation } = await alp!.request<HistoryPage>('session.history', { sessionId: session.id, limit: 1 });
        await alp!.request('session.reload', { sessionId: session.id, requestId: `paseo:${message.requestId ?? randomUUID()}`, ifGeneration: generation });
      } else {
        await open(session);
      }
      reattachRoot(session.id);
      void refresh().catch(() => {});
      if (!message.requestId) return;
      return { type: 'status', payload: { status: 'agent_refreshed', agentId: session.id, requestId: message.requestId } } satisfies Outbound;
    },

    async cancel_agent_request(message: Inbound<'cancel_agent_request'>) {
      const session = known(message.agentId);
      const failed = await alp!.request('session.interrupt', { sessionId: session.id }).then(() => null, (error: Error) => error.message);
      if (!message.requestId) return;
      return { type: 'cancel_agent_response', payload: { requestId: message.requestId, agentId: session.id, agent: agentOf(roots.get(session.id) ?? session), error: failed } } satisfies Outbound;
    },

    async archive_agent_request(message: Inbound<'archive_agent_request'>) {
      const session = known(message.agentId);
      await alp!.request('session.archive', { sessionId: session.id });
      await refresh();
      const archived = roots.get(session.id) ?? session;
      return { type: 'agent_archived', payload: { agentId: session.id, archivedAt: agentOf(archived).archivedAt ?? new Date().toISOString(), requestId: message.requestId } } satisfies Outbound;
    },

    async update_agent_request(message: Inbound<'update_agent_request'>) {
      const reply = (error: string | null): Outbound => ({ type: 'update_agent_response', payload: { requestId: message.requestId, agentId: message.agentId, accepted: !error, error } });
      try {
        const session = known(message.agentId);
        if (typeof message.name === 'string' && message.name.trim()) await alp!.request('session.rename', { sessionId: session.id, title: message.name });
        await refresh();
        return reply(null);
      } catch (error: any) {
        return reply(error?.message ?? String(error));
      }
    },

    /**
     * Paseo's model picker on an existing agent (set_agent_model_request): an ALP root's "model" is its
     * team (a custom root's, its runtime:model), so the choice is session.configure { team } (or
     * { model }) on the live root, at the idle barrier through a restart on the same conversation
     * (§12.9). Refused while it or its agents work, for another runtime or more permissions; the agent
     * keeps what it ran with then, and the answer says why.
     */
    async set_agent_model_request(message: Inbound<'set_agent_model_request'>) {
      const reply = (error: string | null): Outbound => ({ type: 'set_agent_model_response', payload: { requestId: message.requestId, agentId: message.agentId, accepted: !error, error } });
      try {
        const session = known(message.agentId);
        if (!message.modelId) throw new Error(session.workflow.mode === 'custom' ? 'Choose a model' : 'Choose a team');
        if (message.modelId === modelOf(session)) return reply(null);
        // Paseo lists ALP's teams as the models of the provider: a team id changes the team; only a
        // runtime-prefixed model (a custom root's own) changes the model.
        const listed = (await teams(session.projectRoot)).teams.some(team => team.id === message.modelId);
        const change = listed ? { team: message.modelId } : /^(codex|claude|acp|antigravity)[:/]/.test(message.modelId) ? { model: message.modelId } : undefined;
        if (!change) throw new Error(`ALP has no team or model '${message.modelId}' for this agent`);
        await configureLive(session, change, message.requestId);
        await refresh();
        return reply(null);
      } catch (error: any) {
        return reply(error?.message ?? String(error));
      }
    },

    /** Paseo's thinking picker on an existing agent: session.configure { thinking } on the live root (§12.9). */
    async set_agent_thinking_request(message: Inbound<'set_agent_thinking_request'>) {
      const reply = (error: string | null): Outbound => ({ type: 'set_agent_thinking_response', payload: { requestId: message.requestId, agentId: message.agentId, accepted: !error, error } });
      try {
        const session = known(message.agentId);
        if (!message.thinkingOptionId) throw new Error('ALP runs an agent at a named effort; choose one');
        if (message.thinkingOptionId === session.thinking) return reply(null);
        await configureLive(session, { thinking: message.thinkingOptionId }, message.requestId);
        await refresh();
        return reply(null);
      } catch (error: any) {
        return reply(error?.message ?? String(error));
      }
    },

    async set_agent_mode_request(message: Inbound<'set_agent_mode_request'>) {
      const reply = (error: string | null): Outbound => ({ type: 'set_agent_mode_response', payload: { requestId: message.requestId, agentId: message.agentId, accepted: !error, error } });
      try {
        const session = known(message.agentId);
        await open(session);
        await alp!.request('session.configure', { sessionId: session.id, mode: message.modeId });
        await refresh();
        return reply(null);
      } catch (error: any) {
        return reply(error?.message ?? String(error));
      }
    },

    /** The user's answer on a question card: a choice or other text, or dismissing it. */
    async agent_permission_response(message: Inbound<'agent_permission_response'>) {
      const question = questions.get(message.requestId);
      // Answered elsewhere already: its resolution has gone to every client.
      if (!question) return;
      const { response } = message;
      const answers = response.behavior === 'allow' ? response.updatedInput?.answers : undefined;
      const text = answers && typeof answers === 'object'
        ? Object.values(answers as Record<string, unknown>).find((value): value is string => typeof value === 'string' && !!value.trim())?.trim()
        : undefined;
      answered.set(question.id, response);
      try {
        await alp!.request('question.answer', text
          ? { questionId: question.id, text }
          : { questionId: question.id, dismiss: true, ...(response.behavior === 'deny' && response.message ? { reason: response.message } : {}) });
      } catch (error: any) {
        log(`paseo answer to ${question.id} failed: ${error?.message ?? error}`);
        answered.delete(question.id);
        resolved(question.id, { behavior: 'deny', message: error?.message ?? String(error) });
      }
    },

    clear_agent_attention(message: Inbound<'clear_agent_attention'>) {
      const ids = Array.isArray(message.agentId) ? message.agentId : [message.agentId];
      for (const id of ids) if (attention.delete(id)) { const session = roots.get(id); if (session) upsert(session); }
      if (!message.requestId) return;
      const agents = ids.map(id => roots.get(id)).filter((session): session is SessionSummary => !!session).map(agentOf);
      return { type: 'clear_agent_attention_response', payload: { requestId: message.requestId, agentId: message.agentId, agents } } satisfies Outbound;
    },
  };

  return {
    uploads,
    handlers,
    view,
    /** ALP itself as the app lists providers: its teams are the models (ALPD §62 step 3). */
    async providerEntry(cwd?: string) {
      const preview = await teams(cwd);
      return {
        provider: PROVIDER,
        status: 'ready' as const,
        enabled: true,
        source: 'builtin' as const,
        label: 'ALP',
        description: 'Agent teams with Codex, Claude Code, and ACP providers',
        models: preview.teams.map(team => ({ provider: PROVIDER, id: team.id, label: team.label, ...(team.description ? { description: team.description } : {}), isDefault: team.id === preview.team })),
        modes: availableModes,
        defaultModeId: preview.mode,
      };
    },
    request: (method: string, params: any) => { if (!alp) return Promise.reject(new Error('ALP daemon is not connected')); return alp.request(method, params); },
    features: { providersSnapshot: true, providerSubagents: true, projectedSubagentTimeline: true, providerSubagentNesting: true },
    start() {
      started ??= (async () => {
        try {
          await connectAgentClient();
          await directory.load();
          await refresh();
          scheduleRefresh();
        } catch (error) {
          // A failed first factory must not poison every later handler: drop the rejected memo and
          // the half-open connection, and schedule the initial reconnect, so the next attempt recovers.
          started = undefined;
          resetConnection();
          scheduleReconnect();
          throw error;
        }
      })();
      return started;
    },
    close() {
      stopped = true;
      uploads.close();
      clearRefresh();
      alp?.close();
      alp = undefined;
      return receipts.close();
    },
  };
}
