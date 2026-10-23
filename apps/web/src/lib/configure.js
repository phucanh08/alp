// @ts-check

/**
 * Changing a live root's model, thinking or team (docs/protocol/alp-json-rpc-v1.md §12.9, issue #121
 * D) as the web app offers it: pure helpers the controller and the session's agent controls share.
 *
 * - Labels show what the host says the root runs with (its summary, session.updated, the answer's
 *   `configured.effective`), never a choice made here before the host took it.
 * - Gating: a control is offered with the capability `session.configure.live` and the root's summary
 *   saying `conversation.configure`; it is disabled, with a reason, while the tree works, offline,
 *   before a history generation is known, or when the token may not (session.write for model and
 *   thinking, session.team.write too for the team, the session's mode within the token's modes).
 * - Models: only the session's own runtime's (library.models ids are `runtime:model`); another
 *   runtime's models are never sent, a session keeps its runtime (start a new session instead).
 * - Refusals: one sentence per reason (the gateway's fixed ones); another runtime or main agent says
 *   to start a new session.
 */

import { describeConversationError } from './conversation.js';

/** @typedef {import('@anhlp/alp-protocol/session').SessionSummary} SessionSummary */
/** @typedef {import('@anhlp/alp-protocol/session').EffectiveConfig} EffectiveConfig */
/** @typedef {import('./new-session.js').ModelRow} ModelRow */
/** @typedef {{ model?: string, thinking?: string, team?: string }} LiveChange */
/** @typedef {{ enabled: boolean, reason?: string }} Control */

/** The capability a host lists when session.configure changes a live root's model, thinking or team. */
export const CONFIGURE_LIVE = 'session.configure.live';

/** The words of a refusal of a live configure, by data.reason (as the gateway's fixed messages say them). */
export const CONFIGURE_MESSAGES = Object.freeze(/** @type {Record<string, string>} */ ({
  session_busy: 'The session or one of its agents is working. Wait until everything is idle, then try again.',
  session_closed: 'The session is closed. Send it a message to open it, then change its configuration.',
  not_root: 'Only the main agent of a session can be changed; an agent keeps the team and model it started with.',
  not_persistent: 'This session is not kept, so it cannot continue its conversation with a new configuration.',
  runtime_unsupported: 'The host cannot change this session\'s model or team while it runs. Start a new session instead.',
  runtime_mismatch: 'A session keeps its runtime. To use another runtime\'s model, start a new session with it.',
  agent_mismatch: 'That team runs another main agent. Start a new session with that team.',
  permission_escalation: 'The change would give the session more permissions or new commands than it has. Start a new session for it.',
  team_not_found: 'The host defines no such team for this project.',
  invalid_params: 'The host does not offer this model or thinking for this session.',
  native_refused: 'The agent\'s runtime did not take the new configuration. The session keeps its own.',
  stale_generation: 'The conversation changed since this view loaded. It was reloaded; try again.',
  key_conflict: 'That request id was already used for something else. Try again.',
  outcome_unknown: 'The host cannot tell whether the change happened. Check the session before trying again.',
  persistence_failed: 'The host could not store the change. Check the session before trying again.',
  turn_in_progress: 'A turn of this conversation has not ended. Try again when it has.',
}));

/** Refusals whose way on is a new session (data.action 'session.create'). */
export const NEW_SESSION_REFUSALS = new Set(['runtime_mismatch', 'agent_mismatch', 'permission_escalation', 'runtime_unsupported']);

/**
 * A refusal of a live configure for people: its words, whether a new session is the way on, whether
 * the view must reload its history first and whether the same requestId may go again (a lost answer).
 * @param {unknown} error
 * @returns {{ message: string, reason?: string, code?: number, newSession: boolean, retrySame: boolean, reload: boolean }}
 */
export function describeConfigureError(error) {
  const described = describeConversationError(error);
  const any = /** @type {any} */ (error);
  const action = any?.data?.action === 'session.create';
  const words = described.reason ? CONFIGURE_MESSAGES[described.reason] : undefined;
  const message = described.reason === 'grant' ? described.message : words ?? described.message;
  return { ...described, message, newSession: action || (!!described.reason && NEW_SESSION_REFUSALS.has(described.reason)) };
}

/** The runtime of a library.models id (`codex:gpt-5.6-sol`), if it names one. @param {string} id */
export const runtimeOfModel = id => /^([a-z]+)[:/]/.exec(id)?.[1];

/**
 * The model rows a live root may switch to: its runtime's only, and the row of the model it runs.
 * @param {ModelRow[]} models @param {{ runtime?: string, model?: string }} session
 */
export function liveModels(models, session) {
  const runtime = session.runtime;
  const same = runtime ? models.filter(row => runtimeOfModel(row.id) === runtime) : [];
  const current = session.model ? same.find(row => row.id === `${runtime}:${session.model}`) ?? same.find(row => row.id === session.model) : undefined;
  return { same, current, others: models.length - same.length };
}

/**
 * Whether the live root's model, thinking and team controls are offered now, and why not.
 * Hidden only without the capability (an older host: the labels stay read-only).
 * @param {{ capabilities: string[], canWrite: boolean, canTeam: boolean, summary?: Partial<SessionSummary> | null, closed?: boolean, busy?: boolean, configuring?: boolean, generation?: string | null, online?: boolean, driveBlock?: string }} input
 * @returns {{ shown: boolean, reason?: string, model: Control, thinking: Control, team: Control }}
 */
export function liveConfigureGate({ capabilities, canWrite, canTeam, summary, closed = false, busy = false, configuring = false, generation, online = true, driveBlock }) {
  const off = (/** @type {string} */ reason) => ({ enabled: false, reason });
  if (!capabilities.includes(CONFIGURE_LIVE)) {
    const reason = 'Set when the session started: this host cannot change it on a running session.';
    return { shown: false, reason, model: off(reason), thinking: off(reason), team: off(reason) };
  }
  const conversation = summary?.conversation;
  /** @returns {string | undefined} what holds back every control */
  const shared = () => {
    if (conversation?.configure !== true) return conversation?.reason === 'not_persistent' ? CONFIGURE_MESSAGES.not_persistent : conversation?.reason === 'not_root' ? CONFIGURE_MESSAGES.not_root : CONFIGURE_MESSAGES.runtime_unsupported;
    if (!canWrite) return 'Your access token cannot change this session (it needs session.write).';
    if (driveBlock) return driveBlock;
    if (closed) return CONFIGURE_MESSAGES.session_closed;
    if (!capabilities.includes('session.history') || !generation) return 'The conversation is still loading.';
    if (!online) return 'Reconnecting…';
    if (configuring) return 'Applying the last change…';
    if (busy) return 'Wait until main and its agents are idle.';
    return undefined;
  };
  const why = shared();
  const both = why ? off(why) : { enabled: true };
  const team = why ? off(why) : canTeam ? { enabled: true } : off('Your access token cannot change the team (it needs session.team.write).');
  return { shown: true, model: both, thinking: both, team };
}

/**
 * The root's summary as the answer of a live configure leaves it: the session alpd answered, with
 * what the runtime took (`configured.effective`) over it, so the labels show exactly that.
 * @param {any} session @param {EffectiveConfig | undefined} effective
 */
export function configuredSummary(session, effective) {
  if (!effective) return session;
  const workflow = session?.workflow && typeof session.workflow === 'object' ? session.workflow : {};
  return {
    ...session,
    model: effective.model, thinking: effective.thinking, mode: effective.mode, runtime: effective.runtime,
    workflow: { ...workflow, mode: effective.team, supervisor: effective.supervisor, ...(typeof effective.maxPeers === 'number' ? { maxPeers: effective.maxPeers } : {}) },
    // A team without a label (custom) has none: an old label must not stay.
    teamLabel: effective.teamLabel ?? session?.teamLabel ?? (effective.team === 'custom' ? undefined : effective.team),
  };
}

/** What a done change says, from what the host answered. @param {{ status: string, effective: EffectiveConfig, restarted: boolean }} configured @param {(effort: string) => string} effortLabel @param {string} [modelLabel] */
export function configuredNotice(configured, effortLabel, modelLabel) {
  const effective = configured.effective;
  const team = effective.teamLabel ?? effective.team;
  const runs = `${team} · main runs ${modelLabel ?? effective.model}${effective.thinking ? ` · ${effortLabel(effective.thinking)}` : ''}`;
  if (configured.status === 'unchanged') return `Nothing to change: ${runs}.`;
  return `Changed: ${runs}.${configured.restarted ? ' The agent restarted on the same conversation.' : ''}`;
}
