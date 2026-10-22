// @ts-check

/**
 * Conversation fork and rewind as the web app offers them (docs/protocol/alp-json-rpc-v1.md §12.7,
 * docs/alp/remote-gateway.md §5.15): pure helpers the controller and the UI share. Both change only
 * the conversation the runtime continues; no file is copied, restored or changed, and the UI says so
 * wherever it offers them.
 *
 * - Gating: a control shows only when the host lists the capability, the root's summary says
 *   `conversation.fork` / `conversation.rewind`, the token may (session.write, and session.read for
 *   a fork) and the host has a history generation for this view (capability session.history).
 * - Turns: a user message that started a turn (prompt.accepted { result: 'turn' }) is where a rewind
 *   goes back to; a finished turn is where a fork can end. A steer started no turn.
 * - Errors: each refusal reason has its own words; `retrySame` says whether the same requestId may
 *   be sent again (only when the answer was lost, never after outcome_unknown).
 */

import { describe } from './errors.js';

/** @typedef {import('./timeline.js').Projection} Projection */
/** @typedef {import('./timeline.js').Entry} Entry */
/** @typedef {import('@anhlp/alp-protocol/session').SessionSummary} SessionSummary */

/** What the UI says wherever a rewind is offered. */
export const REWIND_FILES_NOTE = 'Files in the workspace are not changed or restored: only the conversation goes back.';
/** What the UI says wherever a fork is offered. */
export const FORK_FILES_NOTE = 'Files are not copied: the fork works on the current files of where it runs.';

/** Why the root's own summary forbids fork and rewind (summary.conversation.reason). */
const REASONS = /** @type {Record<string, string>} */ ({
  runtime_unsupported: 'This session runs on a runtime that cannot fork or rewind its conversation.',
  not_persistent: 'This session keeps no native conversation to fork or rewind.',
  not_root: 'Only a main conversation can be forked or rewound; an agent\'s work belongs to its requester.',
});

/** The words of a refusal of session.fork / session.rewind, by data.reason. */
export const CONVERSATION_MESSAGES = Object.freeze(/** @type {Record<string, string>} */ ({
  session_busy: 'The session or one of its agents is still working. Wait until everything is idle, then try again.',
  stale_generation: 'The conversation changed since this view loaded. It was reloaded; check it and try again.',
  turn_not_found: 'That message is no longer part of this conversation. It was reloaded; try again.',
  turn_in_progress: 'A turn is still running. Wait until it ends, then try again.',
  empty_prefix: 'Nothing comes before the first message. Start a new session instead.',
  boundary_unmapped: 'The agent\'s runtime cannot go back to exactly this point (that turn was not started by ALP). Choose another message.',
  runtime_unsupported: REASONS.runtime_unsupported,
  native_refused: 'The agent\'s runtime refused it. Nothing changed.',
  outcome_unknown: 'The host cannot tell whether it happened. Check the session list and this conversation before trying again; a new attempt is a new request.',
  key_conflict: 'That request id was already used for something else. Try again.',
  branch_not_found: 'That branch is no longer kept on the host.',
  not_root: REASONS.not_root,
  outside_workspace: 'That workspace is not granted to your access token.',
  attachment_forbidden: 'This conversation holds an attachment your access token may not use.',
  request_conflict: 'A session with that id already exists.',
  persistence_failed: 'The host could not finish saving it. Trying again finishes it.',
}));

const reasonOf = (/** @type {any} */ error) => typeof error?.data?.reason === 'string' ? error.data.reason : undefined;

/**
 * A refusal of fork/rewind for people, and whether the same requestId may go again. A lost answer
 * (dropped connection, timeout, gateway lost the host) or persistence_failed: same id, the host
 * answers the first result. Every other answer: a new attempt takes a new id.
 * @param {unknown} error
 * @returns {{ message: string, reason?: string, code?: number, retrySame: boolean, reload: boolean }}
 */
export function describeConversationError(error) {
  const any = /** @type {any} */ (error);
  const reason = reasonOf(any);
  const code = typeof any?.code === 'number' ? any.code : undefined;
  const failure = describe(error);
  // Not answered (or never sent): the same id is safe, the host answers it at most once.
  const lostAnswer = failure.sent !== 'yes' && reason !== 'outcome_unknown';
  /** The view is behind the host: reload the timeline before another try. */
  const reload = reason === 'stale_generation' || reason === 'turn_not_found';
  if (reason === 'persistence_failed') return { message: CONVERSATION_MESSAGES.persistence_failed, reason, code, retrySame: true, reload: false };
  if (code === 1003 && reason === 'grant') {
    const permission = typeof any?.data?.permission === 'string' ? any.data.permission : 'session.write';
    return { message: `Your access token cannot do this (it needs ${permission}).`, reason, code, retrySame: false, reload: false };
  }
  if (reason && CONVERSATION_MESSAGES[reason]) {
    // The gateway answers a fixed sentence per reason, which says what CONVERSATION_MESSAGES says: nothing is appended.
    return { message: CONVERSATION_MESSAGES[reason], reason, code, retrySame: false, reload };
  }
  if (lostAnswer) {
    const tail = failure.sent === 'no' ? ' Trying again is safe.' : ' It may have happened: trying again sends the same request, which the host answers only once.';
    return { message: `${failure.message}${failure.terminal ? '' : tail}`, ...(reason ? { reason } : {}), code, retrySame: !failure.terminal, reload: false };
  }
  if (code === -32601) return { message: 'This host does not offer it. Update ALP on the host.', code, retrySame: false, reload: false };
  return { message: error instanceof Error && error.message ? error.message : 'Something went wrong.', ...(reason ? { reason } : {}), code, retrySame: false, reload };
}

/**
 * Whether fork and rewind are offered for a root now, and why not. Never offered (hidden) without
 * the capability or when the summary does not say so; disabled with a reason while busy.
 * @param {{ capabilities: string[], canRead: boolean, canWrite: boolean, summary?: Partial<SessionSummary> | null, busy?: boolean, generation?: string | null, online?: boolean, driveBlock?: string }} input
 * @returns {{ fork: { shown: boolean, reason?: string }, rewind: { shown: boolean, reason?: string } }}
 */
export function conversationGate({ capabilities, canRead, canWrite, summary, busy = false, generation, online = true, driveBlock }) {
  const conversation = summary?.conversation;
  const hidden = (/** @type {string | undefined} */ reason = undefined) => ({ shown: false, ...(reason ? { reason } : {}) });
  const why = conversation?.reason ? REASONS[conversation.reason] ?? `Not available here (${conversation.reason}).` : undefined;
  const history = capabilities.includes('session.history') && !!generation;
  /** @param {'fork' | 'rewind'} kind */
  const one = kind => {
    if (!capabilities.includes(`session.${kind}`)) return hidden();
    if (!conversation || conversation[kind] !== true) return hidden(why);
    if (!canWrite || (kind === 'fork' && !canRead)) return hidden('Your access token cannot change this conversation (it needs session.write).');
    // A token limited to modes forks or rewinds only what it may drive (the gateway checks it as for a prompt).
    if (driveBlock) return hidden(driveBlock);
    if (!history) return hidden('This host does not keep a history generation for this view.');
    if (!online) return { shown: true, reason: 'Reconnecting…' };
    if (kind === 'rewind' && busy) return { shown: true, reason: 'Wait until main and its agents are idle.' };
    return { shown: true };
  };
  return { fork: one('fork'), rewind: one('rewind') };
}

/** Reload agent's tooltip: what restarts and what stays (§12.8). */
export const RELOAD_NOTE = 'Restart the agent\'s process on the same conversation and settings, for example after a new sign-in. Its messages, history and files stay.';

/** The words of a refusal of session.reload, by data.reason; other reasons as describeConversationError. */
export const RELOAD_MESSAGES = Object.freeze(/** @type {Record<string, string>} */ ({
  session_busy: 'The agent or one of its agents is still working. Wait until everything is idle, then reload.',
  session_closed: 'The session is closed. Send it a message to open it again on its conversation.',
  no_history: 'The agent has no conversation to keep yet. Send it a message first, or start a new session.',
  native_refused: 'The agent could not be restarted on its conversation. The session was closed with its conversation kept; send it a message to open it again.',
  runtime_unsupported: 'This session runs on a runtime the host cannot reload.',
  not_root: 'Only the main agent of a session can be reloaded.',
}));

/** A refusal of session.reload for people. @param {unknown} error */
export function describeReloadError(error) {
  const described = describeConversationError(error);
  const words = described.reason ? RELOAD_MESSAGES[described.reason] : undefined;
  return words ? { ...described, message: words } : described;
}

/**
 * Whether a session tab offers Reload agent and Copy resume command now (§12.8), and why not. An item
 * is hidden without its capability (an older host); otherwise shown, disabled with a reason.
 * @param {{ capabilities: string[], canRead: boolean, canWrite: boolean, summary?: Partial<SessionSummary> | null, root: boolean, closed?: boolean, busy?: boolean, generation?: string | null, online?: boolean, driveBlock?: string }} input
 * @returns {{ reload: { shown: boolean, enabled: boolean, reason?: string }, resume: { shown: boolean, enabled: boolean, reason?: string } }}
 */
export function agentControlsGate({ capabilities, canRead, canWrite, summary, root, closed = false, busy = false, generation, online = true, driveBlock }) {
  const off = (/** @type {string} */ reason) => ({ shown: true, enabled: false, reason });
  const resume = !capabilities.includes('session.resumeCommand') ? { shown: false, enabled: false }
    : !canRead ? off('Your access token cannot read this session.')
      : !online ? off('Reconnecting…') : { shown: true, enabled: true };
  /** @returns {{ shown: boolean, enabled: boolean, reason?: string }} */
  const reload = () => {
    if (!capabilities.includes('session.reload')) return { shown: false, enabled: false };
    if (!root) return off(RELOAD_MESSAGES.not_root);
    const conversation = summary?.conversation;
    if (conversation?.reload !== true) return off(conversation?.reason === 'not_persistent' ? 'This session keeps no native conversation to reload.' : RELOAD_MESSAGES.runtime_unsupported);
    if (!canWrite) return off('Your access token cannot reload agents (it needs session.write).');
    if (driveBlock) return off(driveBlock);
    if (closed) return off(RELOAD_MESSAGES.session_closed);
    if (!capabilities.includes('session.history') || !generation) return off('The conversation is still loading.');
    if (!online) return off('Reconnecting…');
    if (busy) return off('Wait until main and its agents are idle.');
    return { shown: true, enabled: true };
  };
  return { reload: reload(), resume };
}

/**
 * The root's turns as the timeline shows them: for each user message that started a turn, its turn
 * id, its place in the turn order, how many turns from it on a rewind would set aside, whether a
 * rewind may go back before it (not the first turn, when the first turn is loaded) and whether it
 * ended (a fork through it needs that).
 * @param {Projection} projection @param {{ hasOlder?: boolean }} [page]
 * @returns {Map<string, { turnId: string, index: number, later: number, rewindable: boolean, ended: boolean, text: string }>}
 *   keyed by the user message's entry key
 */
export function turnsByMessage(projection, page = {}) {
  /** @type {Map<string, { turnId: string, index: number, later: number, rewindable: boolean, ended: boolean, text: string }>} */
  const map = new Map();
  const order = projection.turnOrder ?? [];
  for (const entry of projection.entries) {
    if (entry.sessionId !== projection.rootId) continue;
    const item = /** @type {any} */ (entry.item);
    if (item.kind !== 'user_message' || typeof item.clientMessageId !== 'string') continue;
    const outcome = projection.prompts[item.clientMessageId];
    if (!outcome || outcome.state !== 'accepted' || outcome.result !== 'turn' || !outcome.turnId) continue;
    const index = order.indexOf(outcome.turnId);
    if (index < 0) continue;
    map.set(entry.key, {
      turnId: outcome.turnId,
      index,
      later: order.length - index,
      // Before the first turn there is nothing (empty_prefix); a page not loaded may hold earlier ones.
      rewindable: index > 0 || !!page.hasOlder,
      ended: projection.turns[outcome.turnId] === 'ended',
      text: typeof item.text === 'string' ? item.text : '',
    });
  }
  return map;
}

/** Whether every turn of the root has ended (a fork of the whole conversation, a rewind). @param {Projection} projection */
export function allTurnsEnded(projection) {
  return (projection.turnOrder ?? []).every(id => projection.turns[id] === 'ended') && !(projection.rootId in projection.running);
}

/**
 * The conversation markers alpd writes into a timeline: a rewind's (`rewind:<branchId>`) and a
 * fork's (`fork:<sessionId>`). @param {any} item
 * @returns {{ kind: 'rewind', branchId: string } | { kind: 'fork', sessionId: string } | null}
 */
export function conversationMarker(item) {
  if (item?.kind !== 'notice' || typeof item.id !== 'string') return null;
  if (item.id.startsWith('rewind:') && item.id.length > 7) return { kind: 'rewind', branchId: item.id.slice(7) };
  if (item.id.startsWith('fork:') && item.id.length > 5) return { kind: 'fork', sessionId: item.id.slice(5) };
  return null;
}

/** "1 later turn" / "3 later turns". @param {number} count */
export const laterTurns = count => `${count} later turn${count === 1 ? '' : 's'}`;
/** "1 turn" / "3 turns". @param {number} count */
export const turnCount = count => `${count} turn${count === 1 ? '' : 's'}`;

/** The number of turns a rewind marker set aside: the summary's branch, else the marker's own text. @param {any} item @param {Array<{ branchId: string, turns: number }> | undefined} branches @param {string} branchId */
export function branchTurns(item, branches, branchId) {
  const known = branches?.find(branch => branch.branchId === branchId)?.turns;
  if (typeof known === 'number') return known;
  const match = /(\d+) later turn/.exec(String(item?.text ?? ''));
  return match ? Number(match[1]) : undefined;
}
