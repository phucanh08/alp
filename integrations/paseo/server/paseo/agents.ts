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

export function createAgents({ clientFactory, home, broadcast, directory, log = () => {} }: {
  clientFactory?: (onEvent: (envelope: any) => void) => Promise<DaemonConnection>;
  home?: string;
  broadcast(message: Outbound): void;
  directory: Directory;
  log?: (message: string) => void;
}) {
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
  const connectAgentClient = async () => { alp = await openAgentClient(); };
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
  const durable = new Map<string, { page: HistoryPage; events: Map<number, Envelope> }>();
  let sourceCursor: number | undefined;
  const timelines = new InMemoryAgentTimelineStore();
  const deltas = new Map<string, TimelineDeltas>();
  /** The alpd epoch of the last event seen for each root, to notice a daemon restart. */
  const epochs = new Map<string, string>();
  /** Roots whose history is being replayed into their timeline; nothing of it is broadcast. */
  const replaying = new Set<string>();
  const attaching = new Map<string, Promise<void>>();
  const turns = new Map<string, string>();
  /** Paseo's attention: a finished turn the user has not looked at yet. */
  const attention = new Map<string, { reason: 'finished' | 'error' | 'permission'; at: string }>();
  /** Questions waiting for the user, and the answers the app gave, until alpd says they are resolved. */
  const questions = new Map<string, UserQuestion>();
  const answered = new Map<string, AgentPermissionResponse>();
  let started: Promise<void> | undefined;
  /** Team members of each root's tree, as Paseo's provider subagents. */
  type Child = { id: string; root: string; parentId: string; agent: string; subtitle: string; toolCallId: string | null; cwd: string; status: 'running' | 'completed' | 'failed' | 'canceled'; createdAt: string; updatedAt: string; description: string | null };
  const children = new Map<string, Child>();
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
  const rootOf = (sessionId: string) => roots.has(sessionId) || replaying.has(sessionId) || timelines.has(sessionId) ? sessionId : children.get(sessionId)?.root;

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
    const child = children.get(session.id) ?? { id: session.id, root, parentId: session.parentId!, agent: session.agent, subtitle: `${session.runtime}:${session.model}`, toolCallId: session.toolCallId ?? null, cwd, status: 'running' as const, createdAt: envelope.ts, updatedAt: envelope.ts, description: null };
    Object.assign(child, { status: 'running', updatedAt: envelope.ts });
    children.set(child.id, child);
    if (!childTimelines.has(child.id)) { childTimelines.initialize(child.id); childDeltas.set(child.id, new TimelineDeltas()); }
    publishChild(child);
  }

  function childEvent(child: Child, envelope: Envelope) {
    const { event } = envelope;
    if (event.type === 'item') {
      if (event.item.kind === 'user_message' && child.description === null) { child.description = event.item.text.slice(0, 500); publishChild(child); }
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
    sourceCursor = envelope.cursor;
    const cached = durable.get(historyRoot ?? rootOf(envelope.sessionId) ?? envelope.sessionId);
    if (cached && envelope.cursor !== undefined) {
      if (cached.events.has(envelope.cursor)) return;
      cached.events.set(envelope.cursor, envelope);
    }
    // A question may come from any session of a tree; it belongs to the tree's root.
    if (envelope.event.type === 'question') { asked(envelope.event.question); return; }
    if (envelope.event.type === 'question.resolved') { resolved(envelope.event.questionId, resolutionOf(envelope.event.questionId, envelope.event.outcome)); return; }
    if (envelope.event.type === 'session.opened' && envelope.event.session.parentId) { childOpened(envelope as Envelope & { event: { type: 'session.opened' } }); return; }
    const child = children.get(envelope.sessionId);
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
        attention.delete(root);
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
  function ensureTimeline(root: string) {
    const active = attaching.get(root);
    if (active) return active;
    if (timelines.has(root)) return Promise.resolve();
    let pending = attaching.get(root);
    if (!pending) {
      // Without a connection there is nothing to attach to, and no failed attach is kept for the root.
      const connection = alp;
      if (!connection) return Promise.reject(new Error('ALP daemon is not connected'));
      pending = (async () => {
        timelines.initialize(root);
        deltas.set(root, new TimelineDeltas());
        epochs.delete(root);
        replaying.add(root);
        // An attach a later one replaced (a reconnect, a root removed and back) leaves the later one's state alone.
        const current = () => attaching.get(root) === pending;
        try {
          let page: HistoryPage | undefined;
          try { if (connection.capabilities?.includes('session.history')) page = await connection.request('session.history', { sessionId: root }); }
          catch (error: any) { if (error.code !== -32601 && error.code !== 1005) throw error; }
          if (page) {
            durable.set(root, { page, events: new Map() });
            await seedHistoryChildren(connection, root, page.items);
            for (const item of page.items) { const event = historyEvent(root, item); if (event.event.type !== 'question' && event.event.type !== 'question.resolved') onEvent(event, root); }
          }
          await connection.request('session.attach', { sessionId: root, replay: true, ...(page ? { after: page.tipCursor, generation: page.generation } : {}) });
        }
        catch (error) { if (current()) timelines.delete(root); throw error; }
        finally { if (current()) { replaying.delete(root); attaching.delete(root); } }
      })();
      attaching.set(root, pending);
    }
    return pending;
  }

  async function seedHistoryChildren(connection: DaemonConnection, root: string, items: HistoryPage['items']) {
    const pending = new Set<string>();
    async function seed(id: string, depth = 0): Promise<void> {
      if (id === root || children.has(id)) return;
      if (depth >= 32 || pending.has(id)) throw new Error('Invalid history ancestry');
      pending.add(id);
      const { session } = await connection.request<{ session: SessionSummary }>('session.get', { sessionId: id });
      if (!session?.parentId) throw new Error('History child is outside its tree');
      await seed(session.parentId, depth + 1);
      childOpened({ sessionId: id, epoch: 'history', seq: 0, ts: session.createdAt ?? '', event: { type: 'session.opened', session, cwd: session.projectRoot, effective: { model: session.model, thinking: session.thinking } } });
      const child = children.get(id)!;
      child.status = session.status === 'closed' ? 'completed' : session.status === 'error' ? 'failed' : 'running';
      pending.delete(id);
    }
    for (const item of items) if (!('oversized' in item)) await seed(item.sessionId);
  }

  function historyEvent(root: string, item: HistoryPage['items'][number]): Envelope {
    return 'oversized' in item ? { sessionId: root, epoch: 'history', seq: item.cursor, cursor: item.cursor, ts: '', event: { type: 'item', item: { kind: 'notice', id: `oversized:${item.cursor}`, level: 'warning', text: `History event ${item.cursor} is too large to display (${item.oversized.bytes} bytes).` } } } : item;
  }

  async function olderTimeline(root: string) {
    const cached = durable.get(root);
    if (!cached?.page.hasOlder || !alp) return;
    const page = await alp.request('session.history', { sessionId: root, before: cached.page.olderCursor }) as HistoryPage;
    if (durable.get(root) !== cached) return;
    await seedHistoryChildren(alp, root, page.items);
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
  }

  /**
   * Re-subscribes a known root on a fresh connection. The timeline is dropped first so the
   * replay seeds a new epoch and snapshot deltas are not deduplicated against the previous
   * connection's state; clients see the epoch change and reset instead of duplicating history.
   */
  function reattachRoot(root: string) {
    timelines.delete(root);
    deltas.set(root, new TimelineDeltas());
    durable.delete(root);
    attaching.delete(root);
    epochs.delete(root);
    replaying.delete(root);
    turns.delete(root);
    for (const child of children.values()) {
      if (child.root !== root) continue;
      childTimelines.delete(child.id);
      childDeltas.set(child.id, new TimelineDeltas());
    }
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
    epochs.delete(root);
    turns.delete(root);
    attention.delete(root);
    for (const child of [...children.values()]) {
      if (child.root !== root) continue;
      children.delete(child.id);
      childTimelines.delete(child.id);
      childDeltas.delete(child.id);
    }
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
    const sessionId = `web-${randomUUID()}`;
    await alp!.request('session.create', { sessionId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), spec: { cwd: config.cwd, persist: true, ...(config.model ? { workflow: config.model } : {}), ...(config.modeId ? { mode: config.modeId } : {}) } });
    if (config.title) await alp!.request('session.rename', { sessionId, title: config.title });
    await refresh();
    await ensureTimeline(sessionId);
    const prompt = input.initialPrompt?.trim();
    if (prompt) await alp!.request('session.prompt', { sessionId, clientMessageId: input.clientMessageId ?? randomUUID(), content: [{ type: 'text', text: prompt }] });
    return agentOf(known(sessionId));
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
        if (direction === 'before' && durable.get(session.id)?.page.hasOlder) await olderTimeline(session.id);
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
            hasOlder: page.hasOlder || !!durable.get(session.id)?.page.hasOlder,
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
        if (direction === 'before' && durable.get(message.parentAgentId)?.page.hasOlder) await olderTimeline(message.parentAgentId);
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
            hasOlder: page.hasOlder || !!durable.get(message.parentAgentId)?.page.hasOlder,
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
        const agent = await create({ config, ...(workspaceId ? { workspaceId } : {}), ...(message.initialPrompt ? { initialPrompt: message.initialPrompt } : {}), ...(message.clientMessageId ? { clientMessageId: message.clientMessageId } : {}) });
        client.emit({ type: 'status', payload: { status: 'agent_created', requestId: message.requestId, agentId: agent.id, agent } });
      } catch (error) {
        return fail(error);
      }
    },

    async send_agent_message_request(message: Inbound<'send_agent_message_request'>) {
      const reply = (error: string | null): Outbound => ({ type: 'send_agent_message_response', payload: { requestId: message.requestId, agentId: message.agentId, accepted: !error, error } });
      try {
        const session = known(message.agentId);
        await open(session);
        await ensureTimeline(session.id);
        const running = session.status === 'running' || session.busy;
        // Paseo's interrupt stops the turn and starts a new one; its steer (the default) goes into the turn.
        if (running && message.activeTurnBehavior === 'interrupt') await alp!.request('session.interrupt', { sessionId: session.id });
        await alp!.request('session.prompt', {
          sessionId: session.id,
          clientMessageId: message.messageId ?? randomUUID(),
          delivery: running && message.activeTurnBehavior !== 'interrupt' ? 'steer' : 'auto',
          content: [{ type: 'text', text: message.text }],
        });
        attention.delete(session.id);
        return reply(null);
      } catch (error: any) {
        return reply(error?.message ?? String(error));
      }
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
      clearRefresh();
      alp?.close();
      alp = undefined;
    },
  };
}
