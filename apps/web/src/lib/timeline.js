// @ts-check

/**
 * One tree's view, built only from alpd's events (docs/protocol/alp-json-rpc-v1.md §8): the
 * timeline of every session in the tree, their snapshots, running turns, waiting questions and
 * prompt outcomes. Pure functions over plain objects, kept in memory only.
 *
 * The replay cursor (§8.1) advances from kept envelopes alone: an envelope without `cursor` is a
 * synthetic announcement and never moves it, and a kept envelope at or below it has been applied
 * already, so it is dropped (one envelope, one application, across reattaches).
 */

/**
 * @typedef {import('@anhlp/alp-protocol/events').Envelope} Envelope
 * @typedef {import('@anhlp/alp-protocol/events').TimelineItem} TimelineItem
 * @typedef {import('@anhlp/alp-protocol/events').SessionSnapshot} SessionSnapshot
 * @typedef {import('@anhlp/alp-protocol/events').UserQuestion} UserQuestion
 * @typedef {import('@anhlp/alp-protocol/session').SessionSummary} SessionSummary
 * @typedef {{ key: string, sessionId: string, ts: string, item: TimelineItem }
 *   | { key: string, sessionId: string, ts: string, item: { kind: 'turn_end', id: string, state: 'failed' | 'canceled', error?: string } }
 *   | { key: string, sessionId: string, ts: string, item: { kind: 'session_event', id: string, level: 'info' | 'warning' | 'error', text: string } }} Entry
 * @typedef {{
 *   rootId: string,
 *   cursor: number,
 *   entries: Entry[],
 *   positions: Record<string, number>,
 *   sessions: Record<string, Partial<SessionSummary> & { id: string }>,
 *   order: string[],
 *   running: Record<string, string>,
 *   closed: Record<string, boolean>,
 *   questions: Record<string, UserQuestion>,
 *   prompts: Record<string, { state: 'accepted' | 'failed', error?: string, turnId?: string, result?: 'turn' | 'steer' }>,
 *   turns: Record<string, 'running' | 'ended'>,
 *   turnOrder: string[],
 *   historyUnavailable: boolean,
 *   reset: number,
 * }} Projection
 *   turnOrder: the root's own turns in the order they began (prompt.accepted { result: 'turn' } or
 *   turn.started), the turns fork and rewind name (§12.7).
 */

/** @param {string} rootId @returns {Projection} */
export function emptyProjection(rootId) {
  return { rootId, cursor: 0, entries: [], positions: {}, sessions: {}, order: [], running: {}, closed: {}, questions: {}, prompts: {}, turns: {}, turnOrder: [], historyUnavailable: false, reset: 0 };
}

/** @param {Projection} state @param {Entry} entry @returns {Projection} */
function upsert(state, entry) {
  const at = state.positions[entry.key];
  if (at !== undefined) {
    const entries = state.entries.slice();
    entries[at] = entry;
    return { ...state, entries };
  }
  return { ...state, entries: [...state.entries, entry], positions: { ...state.positions, [entry.key]: state.entries.length } };
}

/** @param {Record<string, any>} record @param {string} key */
const without = (record, key) => {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
};

/** The root's turn order with `turnId` added (once). @param {Projection} state @param {unknown} turnId */
function beginTurn(state, turnId) {
  if (typeof turnId !== 'string' || !turnId) return state;
  const order = state.turnOrder ?? [];
  return order.includes(turnId) ? state : { ...state, turnOrder: [...order, turnId] };
}

/**
 * Applies one envelope. Unknown event types and item kinds are ignored (§7).
 * @param {Projection} state @param {Envelope} envelope @returns {Projection}
 */
export function project(state, envelope) {
  if (!envelope || typeof envelope !== 'object' || !envelope.event || typeof envelope.sessionId !== 'string') return state;
  const kept = typeof envelope.cursor === 'number';
  if (kept && /** @type {number} */ (envelope.cursor) <= state.cursor) return state;
  /** @type {Projection} */
  let next = kept ? { ...state, cursor: /** @type {number} */ (envelope.cursor) } : state;
  const id = envelope.sessionId;
  const ts = typeof envelope.ts === 'string' ? envelope.ts : '';
  const event = /** @type {any} */ (envelope.event);
  if (event.type === 'item' && !next.sessions[id]) next = { ...next, sessions: { ...next.sessions, [id]: { id } }, order: next.order.includes(id) ? next.order : [...next.order, id] };
  const mark = () => `${id}:${event.type}:${envelope.cursor ?? `${envelope.epoch}:${envelope.seq}`}`;
  switch (event.type) {
    case 'session.opened':
    case 'session.updated': {
      const snapshot = event.session && typeof event.session === 'object' ? event.session : {};
      const previous = next.sessions[id];
      next = {
        ...next,
        sessions: { ...next.sessions, [id]: { ...previous, ...snapshot, id, ...(event.type === 'session.opened' ? { status: snapshot.busy ? 'running' : 'idle' } : {}) } },
        order: next.order.includes(id) ? next.order : [...next.order, id],
      };
      if (event.type === 'session.opened') next = { ...next, closed: without(next.closed, id) };
      return next;
    }
    case 'session.closed': {
      const previous = next.sessions[id];
      return {
        ...next,
        closed: { ...next.closed, [id]: true },
        running: without(next.running, id),
        questions: Object.fromEntries(Object.entries(next.questions).filter(([, question]) => question.sessionId !== id)),
        sessions: previous ? { ...next.sessions, [id]: { ...previous, status: 'closed', busy: false } } : next.sessions,
      };
    }
    case 'session.failed':
      return upsert(next, { key: mark(), sessionId: id, ts, item: { kind: 'session_event', id: mark(), level: 'error', text: event.error?.message ? `The session failed: ${event.error.message}` : 'The session failed.' } });
    case 'prompt.accepted': {
      if (typeof event.clientMessageId !== 'string') return next;
      const result = event.result === 'turn' || event.result === 'steer' ? event.result : undefined;
      next = { ...next, prompts: { ...next.prompts, [event.clientMessageId]: { state: 'accepted', ...(typeof event.turnId === 'string' ? { turnId: event.turnId } : {}), ...(result ? { result } : {}) } } };
      return result === 'turn' && id === next.rootId ? beginTurn(next, event.turnId) : next;
    }
    case 'prompt.failed':
      return typeof event.clientMessageId === 'string' ? { ...next, prompts: { ...next.prompts, [event.clientMessageId]: { state: 'failed', ...(event.error?.message ? { error: event.error.message } : {}) } } } : next;
    case 'turn.started': {
      if (id === next.rootId) next = beginTurn(next, event.turnId);
      const previous = next.sessions[id];
      const turns = next.turns[event.turnId] === 'ended' ? next.turns : { ...next.turns, [String(event.turnId)]: /** @type {const} */ ('running') };
      return { ...next, turns, running: { ...next.running, [id]: String(event.turnId) }, ...(previous ? { sessions: { ...next.sessions, [id]: { ...previous, status: 'running', busy: true } } } : {}) };
    }
    case 'turn.ended': {
      const previous = next.sessions[id];
      next = { ...next, running: without(next.running, id), turns: { ...next.turns, [String(event.turnId)]: 'ended' }, ...(previous && previous.status !== 'closed' ? { sessions: { ...next.sessions, [id]: { ...previous, status: 'idle' } } } : {}) };
      if (event.state === 'failed' || event.state === 'canceled') {
        next = upsert(next, { key: mark(), sessionId: id, ts, item: { kind: 'turn_end', id: mark(), state: event.state, ...(event.error?.message ? { error: event.error.message } : {}) } });
      }
      return next;
    }
    case 'item': {
      const item = event.item;
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || typeof item.kind !== 'string') return next;
      if (!['user_message', 'assistant_message', 'notice', 'tool_call', 'todo', 'compaction'].includes(item.kind)) return next;
      return upsert(next, { key: `${id}:${item.id}`, sessionId: id, ts, item });
    }
    case 'usage': {
      // The whole latest usage of the session, for its context meter (t-7679.12).
      const previous = next.sessions[id];
      if (!event.usage || typeof event.usage !== 'object' || Array.isArray(event.usage)) return next;
      return { ...next, sessions: { ...next.sessions, [id]: { ...previous, id, usage: event.usage } } };
    }
    case 'question': {
      const question = event.question;
      if (!question || typeof question.id !== 'string') return next;
      return { ...next, questions: { ...next.questions, [question.id]: question } };
    }
    case 'question.resolved':
      return typeof event.questionId === 'string' ? { ...next, questions: without(next.questions, event.questionId) } : next;
    default:
      return next;
  }
}

/**
 * The end of a `session.attach` (§8.3): the envelopes that arrived while it was pending, and its
 * answer. With `reset` the old projection goes first; then the buffered envelopes apply in cursor
 * order (a live envelope may overtake the replay when the connection was already attached, as
 * after session.create), announcements last. Waiting questions are announced afresh by every
 * attach, so the old ones are dropped first. The root's summary corrects what a crash may have
 * left without an event (a closed root, a turn that never ended).
 * @param {Projection} previous
 * @param {{ session?: Partial<SessionSummary> & { id?: string }, cursor?: number, reset?: boolean }} response
 * @param {Envelope[]} buffered
 * @returns {Projection}
 */
export function applyAttach(previous, response, buffered) {
  let next = response.reset ? { ...emptyProjection(previous.rootId), reset: previous.reset + 1 } : { ...previous, questions: {} };
  const kept = buffered.filter(envelope => typeof envelope?.cursor === 'number').sort((a, b) => /** @type {number} */ (a.cursor) - /** @type {number} */ (b.cursor));
  const announced = buffered.filter(envelope => typeof envelope?.cursor !== 'number');
  const before = next.cursor;
  for (const envelope of kept) next = project(next, envelope);
  for (const envelope of announced) next = project(next, envelope);
  const summary = response.session;
  const root = next.rootId;
  if (summary && (summary.id === undefined || summary.id === root)) {
    const known = next.sessions[root];
    next = { ...next, sessions: { ...next.sessions, [root]: { ...known, ...summary, id: root } }, order: next.order.includes(root) ? next.order : [root, ...next.order] };
    if (summary.status === 'closed') next = { ...next, closed: { ...next.closed, [root]: true }, running: without(next.running, root) };
    else if (summary.status === 'idle' && !summary.busy) next = { ...next, running: without(next.running, root) };
  }
  if (response.reset) next = { ...next, historyUnavailable: next.cursor === before };
  return next;
}

/** Sessions of the tree, root first, in the order they opened. @param {Projection} state */
export function members(state) {
  const ids = state.order.includes(state.rootId) ? state.order : [state.rootId, ...state.order];
  return ids.map(id => ({ id, session: state.sessions[id], running: id in state.running, closed: !!state.closed[id] }));
}

/** The timeline of one session. @param {Projection} state @param {string} sessionId */
export function entriesOf(state, sessionId) {
  return state.entries.filter(entry => entry.sessionId === sessionId);
}

/** Whether the tree has work going on: a running turn or a busy snapshot. @param {Projection} state */
export function treeBusy(state) {
  return Object.keys(state.running).length > 0;
}

/**
 * Whether the turn a message of ours went into is over, so the next queued message may start a
 * turn of its own. Unknown (no prompt.accepted yet, or accepted before its turn.started) is not
 * over; a turn seen running that is no longer running is (a crash can end one without turn.ended).
 * Accepted by a host that names no turn: over once the tree runs nothing.
 * @param {Projection} state @param {string} clientMessageId
 */
export function promptTurnOver(state, clientMessageId) {
  const outcome = state.prompts[clientMessageId];
  if (!outcome) return false;
  if (outcome.state === 'failed') return true;
  const running = Object.values(state.running);
  if (!outcome.turnId) return running.length === 0;
  const turn = state.turns[outcome.turnId];
  return turn === 'ended' || (turn === 'running' && !running.includes(outcome.turnId));
}

/** Client message ids already in the timeline as user messages. @param {Projection} state */
export function deliveredPrompts(state) {
  const ids = new Set();
  for (const entry of state.entries) if (entry.item.kind === 'user_message' && typeof (/** @type {any} */ (entry.item)).clientMessageId === 'string') ids.add(/** @type {any} */ (entry.item).clientMessageId);
  return ids;
}

/** Oversized history records have an explicit visible placeholder and stable cursor identity.
 * @param {any} item @param {string} root
 * @returns {Envelope}
 */
export function historyEnvelope(item, root) {
  return item.oversized ? { sessionId: root, epoch: 'history', seq: item.cursor, cursor: item.cursor, ts: '', event: { type: 'item', item: { kind: 'notice', id: `oversized:${item.cursor}`, level: 'warning', text: `History event ${item.cursor} is too large to display (${item.oversized.bytes} bytes).` } } } : item;
}

/** Prepend older snapshots, keeping the newer version of every stable item and all live state.
 * @param {Projection} current @param {any[]} items @returns {Projection}
 */
export function prependHistory(current, items) {
  let older = emptyProjection(current.rootId);
  for (const item of items) older = project(older, historyEnvelope(item, current.rootId));
  const entries = older.entries.slice();
  const positions = { ...older.positions };
  for (const entry of current.entries) {
    const at = positions[entry.key];
    if (at !== undefined) entries[at] = entry;
    else { positions[entry.key] = entries.length; entries.push(entry); }
  }
  const sessions = { ...older.sessions };
  for (const [id, session] of Object.entries(current.sessions)) sessions[id] = { ...sessions[id], ...session };
  // The older page's prompt outcomes and turns name the turns of its user messages (fork and rewind).
  return {
    ...current, entries, positions, sessions, order: [...new Set([...older.order, ...current.order])],
    prompts: { ...older.prompts, ...current.prompts },
    turns: { ...older.turns, ...current.turns },
    turnOrder: [...new Set([...older.turnOrder, ...(current.turnOrder ?? [])])],
  };
}
