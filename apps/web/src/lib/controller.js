// @ts-check
import { attachments as attachmentApi, createReconnectingClient, hello, isAlpClientError, sha256Hex } from '@anhlp/alp-client/portable';
import { AuthenticationError, ConfigurationError, CreateOutcomeUnknownError, FILE_MESSAGES, FileAccessError, describe, describeFileError, endsRoot } from './errors.js';
import { cleanListing, relativeFilePath } from './file-tree.js';
import { WORKSPACE_FILES, blockedFilePath } from '@anhlp/alp-protocol';
import { can, gatewayUrl, grantedWorkspace, openGateway } from './gateway.js';
import { newConversationRequestId, newMessageId, newRequestId, newSessionId } from './ids.js';
import { RELOAD_MESSAGES, agentControlsGate, conversationGate, describeConversationError, describeReloadError } from './conversation.js';
import { GIT_ERROR_MESSAGES, GitAccessError, describeGitError, gitAccess, gitCompare, gitRequestPath, registryWorkspaceOf } from './git.js';
import { NO_FILES, abortUpload, fileLimits, fileRefusal, fitFiles, fitImages, imageLimits, messageContent, uploadRequestId } from './attachments.js';
import { applyAttach, historyEnvelope, prependHistory, deliveredPrompts, emptyProjection, members, project, promptTurnOver } from './timeline.js';
import { effortLabel, normalizeModels, parsePreview } from './new-session.js';
import { CONFIGURE_LIVE, CONFIGURE_MESSAGES, NEW_SESSION_REFUSALS, configuredNotice, configuredSummary, describeConfigureError, liveConfigureGate } from './configure.js';
import { loadPreferences, parsePreferences, rememberChoices, savePreferences } from './preferences.js';
import { TerminalSession, terminalGate, terminalLimits } from './terminal.js';

/** @typedef {{ messageId?: string, turnId?: string, observer?: ReconnectingClient, observed?: Projection, sending?: boolean, warned?: boolean, exhausted?: boolean, attempts?: number, retry?: ReturnType<typeof setTimeout>, done: () => void, promise: Promise<void> }} StopIntent */

/**
 * Everything the web app knows and does, without React: one connection to alpd through the
 * gateway, the workspace and session the user chose, and each request's fate. The UI renders
 * `getState()` and calls the methods; nothing here touches the DOM. The app's preferences (never
 * the token) go to the `storage` the page passes in (lib/preferences.js).
 *
 * Recovery follows docs/protocol/alp-json-rpc-v1.md §8.3 and the lessons of the Paseo remote mode
 * (docs/alp/paseo-remote.md §3.3):
 * - one tree is attached at a time; its events are buffered while an attach is pending, and the
 *   answer's `reset` clears the projection before the buffer is applied;
 * - a new connection is used only once the selected root is attached again on it and it is still
 *   up (the SDK's reconnecting client adopts it after onConnect); a dropped socket or a transient
 *   error during that attach retries with backoff and keeps every root, cursor and timeline;
 * - only a verdict on the session itself (1001, 1003, -32601, -32602) gives a root up;
 * - a root alpd closed while nobody watched stays listed and reopens with session.create
 *   { resume: true } before the next prompt;
 * - nothing the user asked for is sent again by itself: an unknown outcome is shown, reconciled
 *   with what the host reports, and left for the user to retry.
 */

/** Capabilities the app cannot work without (§6.2). */
export const REQUIRED_CAPABILITIES = ['attach.after', 'prompt.receipts'];
export const CLIENT = { name: 'alp-web', version: '0.10.0' };
const STOP_WAITING = 'Stop is waiting for this message’s outcome.';

/**
 * @typedef {import('./gateway.js').Principal} Principal
 * @typedef {import('./errors.js').Failure} Failure
 * @typedef {import('./timeline.js').Projection} Projection
 * @typedef {import('@anhlp/alp-protocol/session').SessionSummary} SessionSummary
 * @typedef {import('@anhlp/alp-client/portable').AlpRpcClient} AlpRpcClient
 * @typedef {import('@anhlp/alp-client/portable').ReconnectingClient} ReconnectingClient
 * @typedef {'idle' | 'connecting' | 'open' | 'reconnecting' | 'failed'} Phase
 * @typedef {{ status: 'idle' | 'loading' | 'ready' | 'error', error?: Failure }} Load
 * @typedef {{ id: string, label: string, description?: string }} Team
 * @typedef {{ id: string, label: string, description?: string }} Mode
 * @typedef {{ id: string, label: string, efforts: string[], effort?: string }} Model
 * @typedef {{
 *   id: string, rootId: string, text: string, delivery: 'auto' | 'steer',
 *   images?: import('./attachments.js').ImageAttachment[],
 *   files?: import('./attachments.js').FileAttachment[], uploadKey?: string, resumeUpload?: number,
 *   status: 'sending' | 'failed' | 'unknown', error?: string, retrySameId: boolean, accepted?: boolean, submitted?: boolean, at: number,
 * }} PendingPrompt
 *   failed: did not reach the host, or the runtime refused it. unknown: may have; retrySameId says
 *   whether resending under the same clientMessageId is safe (receipts dedupe it, §10) or the host
 *   asked for a new id (outcome_unknown).
 *   files (#121 J) are uploaded under `uploadKey` (the first clientMessageId, kept when the message
 *   is sent again under a new one) before session.prompt; each keeps its attachmentId once
 *   committed, so nothing is uploaded twice for the same message (unless the host lost the object:
 *   a prompt refused not_found or attachment_unavailable uploads it afresh on Retry). resumeUpload
 *   counts the times an upload a dropped connection interrupted is continued by itself once the
 *   connection is back. A discarded message's uploads that were begun and not committed are
 *   aborted, best effort.
 * @typedef {{ reason: 'finished' | 'error', at: number, turnId?: string, message?: string, hostAt?: string }} TurnAttention
 *   Paseo's requiresAttention with its reason, for a root whose turn ended while the user did not
 *   see it: completed is finished, failed is error. Cleared when the user opens or focuses it,
 *   sends it a message, or it starts another turn. `at` tells one ending from the next. With the
 *   capability `session.attention` the host keeps it for every client (`hostAt`, its time there,
 *   names it when this page acknowledges it); a root not listed yet keeps its entry until it is
 *   (visibleAttention), an archived one never has one.
 * @typedef {{ id: string, rootId: string, text: string }} QueuedPrompt
 *   A message held back while the root works (Paseo's queue): sent by itself, once, when the
 *   root is idle with nothing else in flight, or sooner when the user says send now.
 * @typedef {{
 *   requestId: string, title: string, priority: number,
 *   status: 'creating' | 'failed' | 'unknown', error?: string, match?: string,
 * }} TaskCreate
 * @typedef {{
 *   rootId: string,
 *   status: 'attaching' | 'attached' | 'detached' | 'gone' | 'error',
 *   error?: Failure,
 *   projection: Projection,
 *   older?: { generation: string, olderCursor?: string, hasOlder: boolean, loading?: boolean, error?: string },
 * }} TreeView
 * @typedef {{
 *   connection: { phase: Phase, gateway: string, attempt: number, error?: Failure, daemonVersion?: string, hostname?: string, promptImageLimits?: ReturnType<typeof imageLimits>, attachmentLimits?: import('./attachments.js').FileLimits, terminalLimits?: import('@anhlp/alp-protocol').TerminalLimits, capabilities: string[] },
 *   principal: Principal | null,
 *   workspace: string | null,
 *   catalog: Load & { teams: Team[], teamsKnown?: boolean, teamsUnavailable?: import('./new-session.js').TeamsUnavailable, modes: Mode[], models: Model[], defaultMode?: string },
 *   sessions: Load & { list: SessionSummary[] },
 *   registry: { workspaces: import('@anhlp/alp-protocol').RegistryWorkspace[], revision: number, error?: string, loading?: boolean },
 *   history: Load & { list: SessionSummary[], query: string, nextCursor?: string, more?: 'loading' | 'error' },
 *   attention: Record<string, number>,
 *   turnAttention: Record<string, TurnAttention>,
 *   selected: string | null,
 *   focus: string | null,
 *   tree: TreeView | null,
 *   prompts: PendingPrompt[],
 *   queued: QueuedPrompt[],
 *   busy: Record<string, boolean>,
 *   tasks: Load & { visible: boolean, rows: any[], revision?: string, unreadable: number, creates: TaskCreate[], busy: Record<string, boolean>, message?: { level: 'info' | 'error', text: string } },
 *   settings: Load & { language?: { language: string | null, applies: string, default: string }, models: Model[] },
 *   notice: { id: number, level: 'info' | 'error', text: string, action?: 'new-session' } | null,
 *   preferences: import('./preferences.js').Preferences,
 * }} State
 */

/** Modes the runtime knows, in order of how much they allow; labels for people. */
/** How long a message the host took counts as working while its turn has not been seen starting. */
const BUSY_UNSEEN_MS = 15_000;
/** Sessions per History page, as Paseo's AGENT_HISTORY_PAGE_LIMIT. */
const HISTORY_PAGE_SIZE = 200;
const MODE_LABELS = /** @type {Record<string, string>} */ ({ 'read-only': 'Read only', 'workspace-write': 'Workspace write', 'full-access': 'Full access' });

/**
 * Whether a root waits for the user's answer: the open tree's own questions while it is attached
 * (they change the moment one is answered), otherwise the workspace's question.list.
 * @param {State} state @param {string} root
 */
export function needsInput(state, root) {
  const tree = state.tree;
  const live = tree && tree.rootId === root ? Object.keys(tree.projection.questions).length > 0 : false;
  if (tree && tree.rootId === root && tree.status === 'attached') return live;
  return live || (state.attention[root] ?? 0) > 0;
}

/**
 * Why a root asks for the user's look besides a question: its last turn finished or failed while
 * they did not see it (Paseo's attentionReason). Questions outrank it (needsInput).
 * @param {State} state @param {string} root @returns {'finished' | 'error' | undefined}
 */
export function attentionReason(state, root) {
  return state.turnAttention[root]?.reason;
}

/**
 * A root's attention as the host keeps it (an ISO `at`), for this page; undefined when it is none.
 * @param {any} attention @returns {TurnAttention | undefined}
 */
function hostEntry(attention) {
  if (!attention || (attention.reason !== 'finished' && attention.reason !== 'error') || typeof attention.at !== 'string') return undefined;
  const at = Date.parse(attention.at);
  const message = attention.reason === 'error' && typeof attention.message === 'string' && attention.message.trim() ? attention.message : undefined;
  return { reason: attention.reason, at: Number.isFinite(at) ? at : Date.now(), hostAt: attention.at, ...(typeof attention.turnId === 'string' ? { turnId: attention.turnId } : {}), ...(message ? { message } : {}) };
}

/**
 * The turn attentions the page shows: of roots in the list (archived ones never are) or the open
 * tree. A root that ended before it was listed keeps its entry and shows once it is.
 * @param {State} state @returns {Record<string, TurnAttention>}
 */
export function visibleAttention(state) {
  const shown = Object.entries(state.turnAttention).filter(([id]) => state.tree?.rootId === id || state.sessions.list.some(session => session.id === id && !session.archived));
  return shown.length === Object.keys(state.turnAttention).length ? state.turnAttention : Object.fromEntries(shown);
}

/** The message shown when a token lacks project.read for workspace.files.search. */
export const FILES_FORBIDDEN = 'This access token cannot list files (needs project.read).';
/** The message shown when a token lacks files.read for workspace.files.list / read (never a default grant). */
export const FILES_READ_FORBIDDEN = 'This access token cannot read files (needs files.read).';
/** The message shown when the host does not offer workspace.files.read. */
export const FILES_READ_UNAVAILABLE = 'This host does not offer file reading. Update ALP on the host.';
/** Paseo's FILE_SEARCH_LIMIT. */
export const FILE_SEARCH_LIMIT = 100;

/**
 * The host's machine name from the hello (alpd's os.hostname(), passed on by the gateway), as
 * Paseo labels a host with it (patch 0017); undefined when there is none to show.
 * @param {unknown} value
 */
export function hostName(value) {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name && name.length <= 253 && !/[\p{Cc}\p{Cf}]/u.test(name) ? name : undefined;
}

/**
 * The roots of a session.list answer for History. The host orders a page itself (§12.1); a whole
 * list is sorted here, newest first.
 * @param {any} result @param {boolean} sort @returns {SessionSummary[]}
 */
function historyRows(result, sort) {
  const rows = (Array.isArray(result?.sessions) ? result.sessions : []).filter((/** @type {any} */ session) => session && typeof session.id === 'string' && !session.parentId);
  return sort ? rows.sort((/** @type {any} */ a, /** @type {any} */ b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? ''))) : rows;
}

/** The page's sessionStorage, when it has a usable one. */
function sessionStorageOf() {
  try { return globalThis.sessionStorage ?? undefined; } catch { return undefined; }
}

/** @returns {State} */
export function initialState(gateway = '') {
  return {
    connection: { phase: 'idle', gateway, attempt: 0, capabilities: [] },
    principal: null,
    workspace: null,
    catalog: { status: 'idle', teams: [], modes: [], models: [] },
    sessions: { status: 'idle', list: [] },
    registry: { workspaces: [], revision: 0 },
    history: { status: 'idle', list: [], query: '' },
    attention: {},
    turnAttention: {},
    selected: null,
    focus: null,
    tree: null,
    prompts: [],
    queued: [],
    busy: {},
    tasks: { status: 'idle', visible: false, rows: [], unreadable: 0, creates: [], busy: {} },
    settings: { status: 'idle', models: [] },
    notice: null,
    preferences: parsePreferences(null),
  };
}

/**
 * @typedef {{
 *   open?: typeof openGateway,
 *   reconnecting?: typeof createReconnectingClient,
 *   backoff?: import('@anhlp/alp-client/portable').Backoff,
 *   stableMs?: number,
 *   requestTimeoutMs?: number,
 *   createTimeoutMs?: number,
 *   taskPollMs?: number,
 *   sessionPollMs?: number,
 *   attentionPollMs?: number,
 *   releaseTimeoutMs?: number,
 *   busyUnseenMs?: number,
 *   storage?: import('./preferences.js').PreferenceStorage,
 *   terminalStorage?: import('./terminal.js').TerminalStorage | null,
 *   terminalOptions?: Partial<import('./terminal.js').TerminalOptions>,
 * }} ControllerOptions
 *   terminalStorage: where a terminal tab keeps its terminal's id for the page (sessionStorage), so a
 *   reload attaches the same terminal again.
 */

/** A message was discarded while its files were uploading: its upload stops, nothing is sent. */
class DiscardedError extends Error {
  constructor() {
    super('The message was discarded.');
    this.name = 'DiscardedError';
  }
}

/** A file of a message could not be uploaded (#121 J): which, and the failure. */
class UploadError extends Error {
  /** @param {string} fileName @param {Failure} failure @param {boolean} dropped the connection went away under it */
  constructor(fileName, failure, dropped) {
    super(failure.message);
    this.name = 'UploadError';
    this.fileName = fileName;
    this.failure = failure;
    this.dropped = dropped;
  }
}

export class Controller {
  /** @type {State} */ #state;
  /** @type {Set<() => void>} */ #listeners = new Set();
  #emitQueued = false;
  #options;
  /** The connection run: replaced on connect, cleared on disconnect, so late callbacks of an old one do nothing. @type {{ alp?: ReconnectingClient, principal?: Principal, opened: boolean } | null} */
  #run = null;
  /** The access token, in this object's memory only, for the life of one connection. */
  #token = '';
  /** Trees seen during this connection: projection and cursor survive reconnects and switches. @type {Map<string, { projection: Projection, attaching: { buffer: any[] } | null, gone: Failure | null, failed: Failure | null }>} */
  #trees = new Map();
  /** Session id → its root, for routing envelopes. @type {Map<string, string>} */
  #membership = new Map();
  /** The root whose events this connection takes. @type {string | null} */
  #watching = null;
  /** The root attached on a client, so a switch knows what to release. @type {{ client: AlpRpcClient, root: string } | null} */
  #attached = null;
  /** Old main subscriptions fencing receipt admission until a Stop observer owns them. @type {Map<string, { client: AlpRpcClient, root: string }>} */
  #stopLeases = new Map();
  /** @type {Map<string, { generation: string, olderCursor?: string, hasOlder: boolean, loading?: boolean, error?: string }>} */
  #older = new Map();
  /**
   * History resets of a root (a rewind, §12.7): how many this page has seen, and the generation the
   * last one named. An attach that began before the latest reset reloads once it is done.
   * @type {Map<string, number>}
   */
  #resets = new Map();
  /** @type {Map<string, string>} */
  #resetTo = new Map();
  /** Worktrees made for a fork, by the fork's request id: a retry forks into the same one. @type {Map<string, { id: string, directory: string }>} */
  #forkWorktrees = new Map();
  /** The worktree.create params of a fork, by its request id, sent unchanged again on a retry. @type {Map<string, any>} */
  #forkWorktreeRequests = new Map();
  /** Viewer operations are ordered per link; an old link cannot delay a new connection.
   * @type {WeakMap<AlpRpcClient, Promise<unknown>>} */
  #viewerTails = new WeakMap();

  /** @template T @param {AlpRpcClient} client @param {() => Promise<T>} operation @returns {Promise<T>} */
  #withViewer(client, operation) {
    const result = (this.#viewerTails.get(client) ?? Promise.resolve()).then(operation);
    this.#viewerTails.set(client, result.catch(() => {}));
    return result;
  }

  /** @type {WeakSet<AlpRpcClient>} */
  #syncing = new WeakSet();
  #retryingTeams = false;
  /** A first message whose start failed after the New session screen closed: the next one shows it again (memory only). */
  /** @type {{ workspace: string, text: string } | null} */
  #unsentDraft = null;
  /** New session screens open now: one takes a kept first message of its workspace at once. @type {Set<(kept: { workspace: string, text: string }) => boolean>} */
  #unsentTakers = new Set();
  /** Counts connections: a start begun on an earlier one keeps nothing for this one. */
  #generation = 0;
  #syncAgain = false;
  /** A root being created: the sync loop leaves it alone. @type {string | null} */
  #creating = null;
  /** Replaced whenever the workspace or the connection changes; async results check it. */
  #context = {};
  #registryContext = {};
  /** @type {Map<string, any>} */ #worktreeRequests = new Map();
  /** @type {ReturnType<typeof setInterval> | undefined} */ #taskTimer;
  /** @type {ReturnType<typeof setInterval> | undefined} */ #sessionTimer;
  /** @type {ReturnType<typeof setInterval> | undefined} */ #attentionTimer;
  /**
   * The workspace's waiting questions (id → root) after question.watch, kept current by the
   * question events that follow it; null without a watch (question.list is polled then).
   * @type {Map<string, string> | null}
   */
  #waiting = null;
  /**
   * Question events seen while a question.watch read is on its way: the answer is what the host
   * held when it read it, and the gateway may pass on events of later questions before it.
   * @type {{ read: number, events: Array<{ id: string, root?: string }> } | null}
   */
  #watchLog = null;
  /**
   * Attention events seen while a question.watch read with `attention` is on its way, applied after
   * its answer as the question events are (root → attention, or null when cleared).
   * @type {Array<[string, any]> | null}
   */
  #attentionLog = null;
  /** The acknowledgement of each root on its way to the host; what the host tells of the root since drops it. @type {Map<string, object>} */
  #acks = new Map();
  /** Latest question.list and History reads: an older answer that lands later is dropped. */
  #attentionRead = 0;
  #historyRead = 0;
  /**
   * Whether the page is visible and focused, as the page tells it (setPresence): a turn that ends
   * on the session in front of a user who looks at it asks for nothing. Seen until told otherwise.
   */
  #presence = { visible: true, focused: true };
  #noticeId = 0;
  /** The Terminal tab's terminal of each registry workspace (#121 H), for this connection. @type {Map<string, TerminalSession>} */
  #terminals = new Map();

  /** @param {ControllerOptions} [options] */
  constructor(options = {}) {
    this.#options = {
      open: openGateway,
      reconnecting: createReconnectingClient,
      backoff: { initialMs: 500, maxMs: 15_000 },
      stableMs: 5_000,
      requestTimeoutMs: 30_000,
      createTimeoutMs: 120_000,
      taskPollMs: 5_000,
      sessionPollMs: 15_000,
      attentionPollMs: 5_000,
      // With question.watch the events keep attention current; this read only repairs drift.
      attentionWatchPollMs: 60_000,
      historyPageSize: HISTORY_PAGE_SIZE,
      releaseTimeoutMs: 5_000,
      busyUnseenMs: BUSY_UNSEEN_MS,
      ...options,
    };
    this.#state = { ...initialState(), preferences: loadPreferences(options.storage) };
  }

  // ---- store -------------------------------------------------------------------------------

  /** @returns {State} */
  getState() { return this.#state; }

  /** @param {() => void} listener */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** @param {Partial<State> | ((state: State) => Partial<State>)} change */
  #set(change) {
    const patch = typeof change === 'function' ? change(this.#state) : change;
    this.#state = { ...this.#state, ...patch };
    this.#emit();
    if (this.#state.queued.length) this.#scheduleDrain();
  }

  /** Listeners hear once per microtask, so a burst of streamed events renders once. */
  #emit() {
    if (this.#emitQueued) return;
    this.#emitQueued = true;
    queueMicrotask(() => {
      this.#emitQueued = false;
      for (const listener of [...this.#listeners]) listener();
    });
  }

  /** @param {'info' | 'error'} level @param {string} text @param {{ action?: 'new-session' }} [extra] what the notice offers to do */
  #notify(level, text, extra) { this.#set({ notice: { id: ++this.#noticeId, level, text, ...(extra?.action ? { action: extra.action } : {}) } }); }

  dismissNotice() { this.#set({ notice: null }); }

  /** Shows a notice from a screen that cannot show it itself (it closed meanwhile). @param {'info' | 'error'} level @param {string} text */
  notify(level, text) { this.#notify(level, text); }

  // ---- connection --------------------------------------------------------------------------

  /** The open client of the current connection, or a failure saying why there is none. */
  #client() {
    const alp = this.#run?.alp;
    if (!alp || alp.state !== 'open' || !alp.client) throw new ConfigurationError(this.#state.connection.phase === 'reconnecting' ? 'Reconnecting to the host. Try again in a moment.' : 'Not connected to a host.');
    return alp.client;
  }

  /**
   * Connects to a gateway with an access token. The token stays in memory until disconnect().
   * @param {{ url: string, token: string }} input
   */
  connect({ url, token }) {
    this.disconnect();
    let gateway;
    try { gateway = gatewayUrl(url); } catch (error) {
      this.#set({ connection: { ...this.#state.connection, phase: 'failed', gateway: String(url), error: describe(error) } });
      return;
    }
    const secret = String(token ?? '').trim();
    if (!secret) {
      this.#set({ connection: { ...this.#state.connection, phase: 'failed', gateway, error: describe(new AuthenticationError('Enter an access token.')) } });
      return;
    }
    this.#token = secret;
    this.#state = { ...initialState(gateway), preferences: this.#state.preferences };
    this.#set({ connection: { phase: 'connecting', gateway, attempt: 1, capabilities: [] } });
    /** @type {{ alp?: ReconnectingClient, principal?: Principal, opened: boolean }} */
    const run = { opened: false };
    this.#run = run;
    const { open, reconnecting, backoff, stableMs, requestTimeoutMs } = this.#options;
    const alp = reconnecting({
      connect: async ({ signal }) => {
        const { transport, principal } = await open({ url: gateway, token: this.#token, signal: /** @type {AbortSignal} */ (signal) });
        if (this.#run !== run) { transport.close(); throw new Error('This connection was replaced.'); }
        run.principal = principal;
        return transport;
      },
      onConnect: (client, context) => this.#onConnect(run, client, /** @type {AbortSignal} */ (context.signal)),
      onDisconnect: () => {
        if (this.#run !== run) return;
        for (const terminal of this.#terminals.values()) terminal.disconnected();
        this.#attached = null;
        this.#stopLeases.clear();
        this.#watching = null;
        for (const tree of this.#trees.values()) tree.attaching = null;
      },
      shouldRetry: error => !describe(error).terminal,
      backoff,
      stableMs,
      client: { timeoutMs: requestTimeoutMs },
    });
    run.alp = alp;
    alp.onEvent(envelope => { if (this.#run === run && this.#onQuestionEvent(envelope)) this.#onEnvelope(envelope); });
    alp.onNotification((method, params) => {
      if (this.#run !== run || method !== 'terminal.event') return;
      for (const terminal of this.#terminals.values()) terminal.event(params);
    });
    alp.onState((state, error) => { if (this.#run === run) this.#onState(run, state, error); });
  }

  /**
   * Ends the connection and forgets the token and everything the host sent. Its terminals end too
   * (terminal.close), except when the page is going away (`keepTerminals`, a reload): the host keeps
   * them for reconnectMs, and the reloaded page attaches them again.
   * @param {{ keepTerminals?: boolean }} [options]
   */
  disconnect({ keepTerminals = false } = {}) {
    const run = this.#run;
    this.#run = null;
    this.#token = '';
    this.#stopTimers();
    this.#trees.clear();
    this.#older.clear();
    this.#membership.clear();
    this.#turnWaits.clear();
    this.#sentAt.clear();
    this.#taken.clear();
    this.#inflight.clear();
    this.#stopLeases.clear();
    const stops = [...this.#stops.values()];
    this.#stops.clear();
    for (const intent of stops) { clearTimeout(intent.retry); intent.observer?.stop(); intent.done(); }
    this.#stopCandidates.clear();
    this.#requesting.clear();
    if (this.#busyTimer !== undefined) { clearTimeout(this.#busyTimer); this.#busyTimer = undefined; }
    this.#watching = null;
    this.#attached = null;
    this.#unsentDraft = null;
    this.#generation += 1;
    this.#context = {};
    this.#waiting = null;
    const ending = this.#endTerminals(keepTerminals ? null : run);
    // The old connection stays up only for its terminals' close requests (a second at most).
    if (run?.alp) { const alp = run.alp; if (ending) void ending.then(() => alp.stop()); else alp.stop(); }
    if (run) this.#set({ ...initialState(this.#state.connection.gateway), preferences: this.#state.preferences });
  }

  /**
   * @param {{ alp?: ReconnectingClient, principal?: Principal, opened: boolean }} run
   * @param {import('@anhlp/alp-client/portable').ReconnectState} state @param {Error} [error]
   */
  #onState(run, state, error) {
    const connection = this.#state.connection;
    if (state === 'open') {
      run.opened = true;
      this.#set({ connection: { ...connection, phase: 'open', attempt: 0, error: undefined } });
      this.#afterOpen();
      return;
    }
    if (state === 'connecting') {
      this.#set({ connection: { ...connection, phase: run.opened ? 'reconnecting' : 'connecting', attempt: run.alp?.attempt ?? connection.attempt } });
      return;
    }
    if (state === 'waiting') {
      // The first connection gets one try: the person is looking at the form and wants to know.
      if (!run.opened) return this.#fail(error ?? new Error('Could not connect.'));
      this.#stopTimers();
      this.#set({ connection: { ...connection, phase: 'reconnecting', error: error ? describe(error) : undefined } });
      return;
    }
    if (state === 'stopped' && error) this.#fail(error);
  }

  /** The connection cannot go on: everything is dropped, the reason kept for the connect form. @param {Error} error */
  #fail(error) {
    const gateway = this.#state.connection.gateway;
    const failure = describe(error);
    this.disconnect();
    this.#set({ connection: { ...initialState(gateway).connection, phase: 'failed', error: failure } });
  }

  /**
   * Runs on each new connection before it is used: handshake, capabilities, the principal of the
   * ticket, and the selected root attached again after its cursor. A throw makes the SDK close
   * this connection and try another after a backoff, keeping all state.
   * @param {{ principal?: Principal }} run @param {AlpRpcClient} client @param {AbortSignal} signal
   */
  async #onConnect(run, client, signal) {
    const greeting = /** @type {any} */ (await hello(client, CLIENT, { signal, timeoutMs: 15_000 }));
    if (this.#run !== run) throw new Error('This connection was replaced.');
    const capabilities = Array.isArray(greeting?.capabilities) ? greeting.capabilities.filter((/** @type {unknown} */ name) => typeof name === 'string') : [];
    const missing = REQUIRED_CAPABILITIES.filter(name => !capabilities.includes(name));
    if (missing.length) throw new ConfigurationError(`The host behind this gateway is too old for this app (it lacks ${missing.join(', ')}). Update ALP on the host.`);
    this.#adopt(/** @type {Principal} */ (run.principal), capabilities, typeof greeting?.daemonVersion === 'string' ? greeting.daemonVersion : undefined, hostName(greeting?.hostname), imageLimits(greeting?.promptImageLimits, capabilities.includes('prompt.images')), fileLimits(greeting?.attachmentLimits, capabilities.includes('attachments')), capabilities.includes('terminal') ? terminalLimits(greeting?.terminalLimits) : undefined);
    this.#attached = null;
    this.#watching = null;
    const root = this.#state.selected;
    if (root && root !== this.#creating && !this.#trees.get(root)?.gone) {
      this.#ensureTree(root).failed = null;
      try {
        await this.#attachTree(client, root, signal);
        if (this.#run !== run || signal.aborted) throw new Error('This connection was replaced.');
        this.#attached = { client, root };
      } catch (error) {
        if (this.#run !== run || signal.aborted || !endsRoot(error)) throw error;
        this.#markGone(root, error);
      }
    }
  }

  /**
   * The principal and capabilities of a new connection. A workspace the grant no longer names is
   * left (with its session and tasks); with none chosen yet, the first granted one is opened.
   * @param {Principal} principal @param {string[]} capabilities @param {string | undefined} daemonVersion
   * @param {ReturnType<typeof imageLimits>} limits
   * @param {string | undefined} hostname the host's machine name from the hello, Paseo's host label (patch 0017)
   * @param {import('./attachments.js').FileLimits} [files] the hello's attachmentLimits (#121 J)
   * @param {import('@anhlp/alp-protocol').TerminalLimits} [terminals] the hello's terminalLimits (#121 H)
   */
  #adopt(principal, capabilities, daemonVersion, hostname, limits, files = { ...NO_FILES }, terminals = undefined) {
    this.#registryContext = {};
    const current = this.#state.workspace;
    const workspace = current && grantedWorkspace(principal, current) ? current : principal.workspaces[0] ?? null;
    const changed = JSON.stringify(principal) !== JSON.stringify(this.#state.principal);
    if (workspace !== current) { this.#context = {}; this.#waiting = null; }
    this.#set(state => ({
      principal,
      registry: changed ? initialState().registry : { ...state.registry, loading: false },
      connection: { ...state.connection, capabilities, ...(daemonVersion ? { daemonVersion } : {}), hostname, promptImageLimits: limits, attachmentLimits: files, terminalLimits: terminals },
      ...(workspace !== state.workspace ? { workspace, selected: null, focus: null, tree: null, sessions: initialState().sessions, history: initialState().history, attention: {}, turnAttention: {}, tasks: { ...initialState().tasks, visible: state.tasks.visible } } : {}),
      ...(changed || workspace !== state.workspace ? { catalog: initialState().catalog } : {}),
    }));
  }

  #afterOpen() {
    for (const terminal of this.#terminals.values()) terminal.connected();
    this.#sync();
    this.#resumeUploads();
    for (const [root, intent] of this.#stops) { intent.attempts = 0; intent.exhausted = false; this.#pumpStop(root); }
    void this.refreshRegistry();
    if (this.#state.workspace) {
      void this.refreshSessions();
      void this.refreshAttention();
      if (this.#state.history.status !== 'idle') void this.loadHistory({ quiet: true });
      if (this.#state.catalog.status !== 'ready') void this.#loadCatalog();
      if (this.#state.tasks.visible) void this.refreshTasks();
    }
    this.#startTimers();
  }

  #startTimers() {
    this.#stopTimers();
    this.#sessionTimer = setInterval(() => { if (this.#state.workspace && this.#state.connection.phase === 'open') void this.refreshSessions({ quiet: true }); }, this.#options.sessionPollMs);
    const attentionMs = this.hasCapability('question.watch') ? this.#options.attentionWatchPollMs : this.#options.attentionPollMs;
    this.#attentionTimer = setInterval(() => { if (this.#state.workspace && this.#state.connection.phase === 'open') void this.refreshAttention(); }, attentionMs);
    this.#taskTimer = setInterval(() => { if (this.#state.tasks.visible && this.#state.workspace && this.#state.connection.phase === 'open') void this.refreshTasks({ quiet: true }); }, this.#options.taskPollMs);
  }

  #stopTimers() {
    if (this.#sessionTimer !== undefined) clearInterval(this.#sessionTimer);
    if (this.#taskTimer !== undefined) clearInterval(this.#taskTimer);
    if (this.#attentionTimer !== undefined) clearInterval(this.#attentionTimer);
    this.#sessionTimer = this.#taskTimer = this.#attentionTimer = undefined;
  }

  /** @param {string} capability */
  hasCapability(capability) { return this.#state.connection.capabilities.includes(capability); }

  // ---- terminals (#121 H) --------------------------------------------------------------------

  /**
   * Whether the Terminal tab can offer a terminal in the open workspace (the host's switch, the
   * token's terminal.exec, a registry workspace), as lib/terminal.js terminalGate.
   */
  terminalGate() { return terminalGate(this.#state); }

  /**
   * The Terminal tab's terminal of a registry workspace on this connection: made (not started)
   * the first time. Only when the gate allows it.
   * @param {string} workspaceId
   */
  terminal(workspaceId) {
    let terminal = this.#terminals.get(workspaceId);
    if (terminal) return terminal;
    const gate = this.terminalGate();
    if (!gate.ok || gate.workspaceId !== workspaceId) throw new ConfigurationError(gate.ok ? 'That workspace is not the open one.' : gate.messages.join(' '));
    const storage = this.#options.terminalStorage === undefined ? sessionStorageOf() : this.#options.terminalStorage ?? undefined;
    terminal = new TerminalSession({
      workspaceId,
      request: (method, params) => this.#client().request(method, params, { timeoutMs: this.#options.requestTimeoutMs }),
      limits: this.#state.connection.terminalLimits ?? terminalLimits(undefined),
      ...(storage ? { storage, storageKey: `alp-web.terminal|${this.#state.connection.gateway}|${this.#state.principal?.id ?? ''}|${workspaceId}` } : {}),
      ...this.#options.terminalOptions,
    });
    this.#terminals.set(workspaceId, terminal);
    return terminal;
  }

  /**
   * The Terminal tab of a workspace (the open one by default) closed: its terminal ends on the host
   * (terminal.close).
   * @param {string} [workspaceId]
   */
  closeTerminal(workspaceId = registryWorkspaceOf(this.#state)?.id) {
    const terminal = workspaceId ? this.#terminals.get(workspaceId) : undefined;
    if (!workspaceId || !terminal) return Promise.resolve();
    this.#terminals.delete(workspaceId);
    return terminal.close();
  }

  /**
   * Disconnecting ends this page's terminals, best effort: their terminal.close requests, answered
   * (or given up after a second) before the old connection closes. One the request does not reach
   * ends when the host's reattach time runs out. Undefined when there is nothing to wait for.
   * @param {{ alp?: ReconnectingClient } | null} run
   */
  #endTerminals(run) {
    const client = run?.alp?.state === 'open' ? run.alp.client : undefined;
    const closing = [];
    for (const terminal of this.#terminals.values()) {
      const { terminalId, status } = terminal.getState();
      terminal.dispose();
      if (client && terminalId && status !== 'gone' && status !== 'closed') closing.push(client.request('terminal.close', { terminalId }, { timeoutMs: 1_000 }).catch(() => {}));
    }
    this.#terminals.clear();
    return closing.length ? Promise.allSettled(closing) : undefined;
  }

  // ---- events and trees --------------------------------------------------------------------

  /** @param {string} root */
  #ensureTree(root) {
    let tree = this.#trees.get(root);
    if (!tree) {
      tree = { projection: emptyProjection(root), attaching: null, gone: null, failed: null };
      this.#trees.set(root, tree);
      this.#membership.set(root, root);
    }
    return tree;
  }

  /** Index only identities established by this root's history or routed events. @param {Projection} projection */
  #indexProjection(projection) {
    for (const id of projection.order) this.#membership.set(id, projection.rootId);
    return projection;
  }

  /** The root an envelope belongs to when it is the watched tree's, else undefined. @param {any} envelope */
  #route(envelope) {
    const sessionId = envelope?.sessionId;
    if (typeof sessionId !== 'string') return undefined;
    let root = this.#membership.get(sessionId);
    if (!root) {
      const parent = envelope.event?.type === 'session.opened' ? envelope.event.session?.parentId : undefined;
      root = (typeof parent === 'string' && this.#membership.get(parent)) || undefined;
      // Learn parentage even while deselected: retained receipt subscriptions still emit.
      // Selection cannot establish an unknown session's root: another subscription may remain
      // after a release/attach timeout. Only parentage and known history establish membership.
      if (root) this.#membership.set(sessionId, root);
    }
    return root === this.#watching ? root : undefined;
  }

  /**
   * Keeps the workspace's waiting questions from question events, and tells whether the envelope
   * is the attached tree's: question.watch also sends, without a cursor, those of trees this
   * client is not attached to, which must not reach its projection.
   * @param {any} envelope
   */
  #onQuestionEvent(envelope) {
    const event = envelope?.event;
    if (event?.type === 'question') {
      const id = event.question?.id;
      const root = event.question?.rootId;
      if (typeof id === 'string' && typeof root === 'string') this.#watchLog?.events.push({ id, root });
      if (this.#waiting && typeof id === 'string' && typeof root === 'string' && this.#waiting.get(id) !== root) { this.#waiting.set(id, root); this.#publishAttention(); }
      return envelope.cursor !== undefined || (!!this.#watching && root === this.#watching);
    }
    if (event?.type === 'attention' && envelope.cursor === undefined) {
      // The host's attention of a root (capability session.attention): set, or cleared when absent.
      if (typeof envelope.sessionId === 'string') {
        if (this.#attentionLog) this.#attentionLog.push([envelope.sessionId, event.attention ?? null]);
        this.#hostAttention(envelope.sessionId, event.attention);
      }
      return false;
    }
    if (event?.type === 'turn.ended' && envelope.cursor === undefined) {
      // question.watch { turns: true }: a copy of a root's turn end in a tree this connection is
      // not attached to. Attention only: it never reaches a projection or moves a cursor.
      if (typeof envelope.sessionId === 'string') {
        // Its list row stops running now, not at the next session.list read.
        const id = envelope.sessionId;
        if (this.#state.sessions.list.some(row => row.id === id && (row.status === 'running' || row.busy))) {
          this.#set(state => ({ sessions: { ...state.sessions, list: state.sessions.list.map(row => row.id === id ? { ...row, busy: false, ...(row.status === 'running' ? { status: 'idle' } : {}) } : row) } }));
        }
        this.#turnEnded(id, event);
      }
      return false;
    }
    if (event?.type === 'question.resolved') {
      if (typeof event.questionId === 'string') this.#watchLog?.events.push({ id: event.questionId });
      if (this.#waiting?.delete(event.questionId)) this.#publishAttention();
      if (envelope.cursor !== undefined) return true;
      const tree = this.#watching ? this.#trees.get(this.#watching) : undefined;
      if (!tree) return false;
      return Object.hasOwn(tree.projection.questions, event.questionId)
        || !!tree.attaching?.buffer.some((/** @type {any} */ entry) => entry.event?.type === 'question' && entry.event.question?.id === event.questionId);
    }
    return true;
  }

  /** The attention counts per root from the watched questions. */
  #publishAttention() {
    if (!this.#waiting) return;
    /** @type {Record<string, number>} */
    const attention = {};
    for (const root of this.#waiting.values()) attention[root] = (attention[root] ?? 0) + 1;
    if (JSON.stringify(attention) !== JSON.stringify(this.#state.attention)) this.#set({ attention });
  }

  /** @param {any} envelope */
  #onEnvelope(envelope) {
    const root = this.#route(envelope);
    if (!root) return;
    const tree = this.#trees.get(root);
    if (!tree) return;
    // A rewind replaced the root's history (§12.7): never kept, never projected; the view reloads.
    if (envelope.event?.type === 'history.reset' && envelope.sessionId === root) { this.#historyReset(root, envelope.event.generation); return; }
    if (tree.attaching) { tree.attaching.buffer.push(envelope); return; }
    tree.projection = this.#indexProjection(project(tree.projection, envelope));
    this.#publishTree(root);
    // Live events of the root itself (a replay is buffered above and never counts).
    const type = envelope.event?.type;
    if (envelope.sessionId === root && type === 'turn.ended') this.#turnEnded(root, envelope.event);
    else if (envelope.sessionId === root && type === 'turn.started') { this.#acks.delete(root); this.#forgetAttention(root); }
  }

  /** Whether the host keeps turn attention for every client (docs/protocol/alp-json-rpc-v1.md §12.2). */
  get #sharedAttention() { return this.hasCapability('session.attention') && this.hasCapability('question.watch'); }

  /**
   * The host set or cleared a root's attention. One the user sees now is acknowledged at once, for
   * every client, as Paseo clears attention on focus.
   * @param {string} root @param {any} attention
   */
  #hostAttention(root, attention) {
    // What the host tells now outdates what this page acknowledged before.
    this.#acks.delete(root);
    const entry = hostEntry(attention);
    if (!entry) { this.#forgetAttention(root); return; }
    if (this.#seen(root)) { this.#forgetAttention(root); this.#acknowledge(root, entry); return; }
    if (this.#state.history.list.some(row => row.id === root && row.archived)) return;
    if (this.#state.turnAttention[root]?.hostAt === entry.hostAt) return;
    this.#set(state => ({ turnAttention: { ...state.turnAttention, [root]: entry } }));
  }

  /**
   * Tells the host the user looked at a root's attention. When the host could not keep that, the
   * page shows the attention again, as every other client still does, unless the host told of the
   * root since; it is not acknowledged again until the next look or watch read, so a host that
   * cannot write is not asked over and over.
   * @param {string} root @param {TurnAttention} entry
   */
  #acknowledge(root, entry) {
    if (!this.#sharedAttention || this.#state.connection.phase !== 'open') return;
    const ack = {};
    const context = this.#context;
    this.#acks.set(root, ack);
    const failed = () => {
      if (this.#acks.get(root) !== ack) return;
      this.#acks.delete(root);
      if (context !== this.#context || this.#state.turnAttention[root]) return;
      if (this.#state.history.list.some(row => row.id === root && row.archived)) return;
      this.#set(state => ({ turnAttention: { ...state.turnAttention, [root]: entry } }));
    };
    try {
      void this.#client().request('session.attention.clear', { sessionId: root, ...(entry.hostAt ? { at: entry.hostAt } : {}) })
        .then(() => { if (this.#acks.get(root) === ack) this.#acks.delete(root); }, failed);
    } catch {
      // No client now: the next watch read shows it again, and a look clears it then.
      failed();
    }
  }

  /** Drops a root's attention from this page only (the host cleared it, or a new turn started). @param {string} root */
  #forgetAttention(root) {
    if (!this.#state.turnAttention[root]) return;
    this.#set(state => {
      const { [root]: _gone, ...rest } = state.turnAttention;
      return { turnAttention: rest };
    });
  }

  /**
   * A root's turn ended (its own tree's live event, or a question.watch copy): as Paseo's
   * checkAndSetAttention, completed asks for a look ('finished'), failed for attention ('error'),
   * canceled for nothing; not when the user looks at that session now.
   * @param {string} root @param {any} event
   */
  #turnEnded(root, event) {
    // The host keeps it for every client and tells of it with an attention event.
    if (this.#sharedAttention) return;
    const reason = event?.state === 'completed' ? 'finished' : event?.state === 'failed' ? 'error' : undefined;
    if (!reason) { this.#forgetAttention(root); return; }
    if (this.#seen(root)) return;
    // A root not listed yet keeps it until it is (visibleAttention shows only listed rows and the
    // open tree, so the favicon never asks with nothing to click); an archived one never asks.
    if (this.#state.history.list.some(row => row.id === root && row.archived)) return;
    const message = typeof event?.error?.message === 'string' && event.error.message.trim() ? event.error.message : undefined;
    /** @type {TurnAttention} */
    const entry = { reason, at: Date.now(), ...(typeof event?.turnId === 'string' ? { turnId: event.turnId } : {}), ...(reason === 'error' && message ? { message } : {}) };
    this.#set(state => ({ turnAttention: { ...state.turnAttention, [root]: entry } }));
  }

  /**
   * Whether the user sees `id` now: the page visible and focused, and it is the session in front,
   * or the open tree's root while one of its agents is in front.
   * @param {string} id
   */
  #seen(id) {
    const shown = this.#state.focus ?? this.#state.selected;
    return this.#presence.visible && this.#presence.focused && (shown === id || this.#state.selected === id);
  }

  /**
   * The page tells whether it is visible and focused. Coming back to a session that asked for a
   * look clears it, as Paseo clears attention on focus.
   * @param {{ visible: boolean, focused: boolean }} presence
   */
  setPresence({ visible, focused }) {
    this.#presence = { visible: !!visible, focused: !!focused };
    const shown = this.#state.focus ?? this.#state.selected;
    if (shown && this.#seen(shown)) this.clearAttention(shown);
  }

  /**
   * The user looked at a root: its finished or error attention is over, on the host too, so every
   * other client stops asking (Paseo's clear_agent_attention). @param {string | null | undefined} root
   */
  clearAttention(root) {
    const entry = root ? this.#state.turnAttention[root] : undefined;
    if (!root || !entry) return;
    this.#forgetAttention(root);
    this.#acknowledge(root, entry);
  }

  /**
   * Attaches a root on `client` after its cursor, buffering its events until the answer (§8.3).
   * @param {AlpRpcClient} client @param {string} root @param {AbortSignal} [signal]
   * @param {number} [staleRetries]
   * @returns {Promise<void>}
   */
  async #attachTree(client, root, signal, staleRetries = 0) {
    const tree = this.#ensureTree(root);
    const operation = { buffer: /** @type {any[]} */ ([]) };
    tree.attaching = operation;
    this.#watching = root;
    const resets = this.#resets.get(root) ?? 0;
    if (this.#state.selected === root) this.#set(state => ({ tree: { rootId: root, status: 'attaching', projection: tree.projection, ...(state.tree?.rootId === root && state.tree.error ? {} : {}) } }));
    try {
      if (this.hasCapability('session.history') && !this.#older.has(root)) {
        const page = await client.request('session.history', { sessionId: root }, { timeoutMs: this.#options.requestTimeoutMs, ...(signal ? { signal } : {}) });
        if (tree.attaching !== operation) return;
        tree.projection = emptyProjection(root);
        for (const item of page.items) tree.projection = project(tree.projection, historyEnvelope(item, root));
        // Replay can emit existing children's events before the attach answer, without another
        // session.opened. Establish their identities from history before routing that replay.
        this.#indexProjection(tree.projection);
        tree.projection = { ...tree.projection, cursor: page.tipCursor };
        this.#older.set(root, { generation: page.generation, olderCursor: page.olderCursor, hasOlder: page.hasOlder });
      }
      const after = tree.projection.cursor;
      const page = this.#older.get(root);
      const response = await client.request('session.attach', { sessionId: root, ...(page ? { after, generation: page.generation } : after > 0 ? { after } : {}) }, { timeoutMs: this.#options.requestTimeoutMs, ...(signal ? { signal } : {}) });
      if (tree.attaching !== operation) return;
      tree.attaching = null;
      tree.gone = null;
      tree.failed = null;
      this.#finishAttach(root, tree, response, operation.buffer);
      // A reset seen while this attach read the old history: read it again.
      if ((this.#resets.get(root) ?? 0) !== resets && this.#older.get(root)?.generation !== this.#resetTo.get(root)) {
        this.#older.delete(root);
        queueMicrotask(() => void this.#reloadTree(client, root));
      }
    } catch (error) {
      if (tree.attaching !== operation) throw error;
      if (/** @type {any} */ (error)?.data?.reason === 'stale_cursor' && staleRetries < 1 && this.#older.has(root)) {
        this.#older.delete(root); tree.projection = emptyProjection(root);
        if (tree.attaching === operation) tree.attaching = null;
        return this.#attachTree(client, root, signal, staleRetries + 1);
      }
      if (tree.attaching === operation) tree.attaching = null;
      // Its events stop here: applied without the replay they could skip a gap. The next attach
      // replays from the cursor.
      if (client === this.#run?.alp?.client && this.#watching === root) this.#watching = null;
      throw error;
    }
  }

  /** @param {string} root @param {{ projection: Projection }} tree @param {any} response @param {any[]} buffer */
  #finishAttach(root, tree, response, buffer) {
    tree.projection = this.#indexProjection(applyAttach(tree.projection, response ?? {}, buffer));
    if (response?.reset && !tree.projection.historyUnavailable) this.#notify('info', 'The host restarted this conversation\'s history; it was loaded again from the beginning.');
    this.#publishTree(root, 'attached');
  }

  /**
   * The root's history was replaced (a rewind here or on another client, §12.7): the cached
   * timeline and older pages are dropped and a fresh tail is read and attached with the new
   * generation. The live event and this page's own rewind answer both call it; one reload is enough.
   * @param {string} root @param {unknown} generation
   */
  #historyReset(root, generation) {
    if (typeof generation !== 'string' || !generation) return;
    if (this.#older.get(root)?.generation === generation || this.#resetTo.get(root) === generation) return;
    this.#resetTo.set(root, generation);
    this.#resets.set(root, (this.#resets.get(root) ?? 0) + 1);
    this.#older.delete(root);
    const tree = this.#trees.get(root);
    // Messages whose turns ended are settled now, by the history that showed it: the new history
    // may no longer hold them (a cut turn), and they must not make the root look busy.
    if (tree) this.#turnsSettled(root, tree.projection);
    const client = this.#attached?.root === root ? this.#attached.client : undefined;
    // An attach on its way reloads by itself when it ends; a root not attached reads afresh when it is.
    if (tree && client && !tree.attaching) void this.#reloadTree(client, root);
  }

  /** Reads a root's history again and attaches after it, on the connection it is attached on. @param {AlpRpcClient} client @param {string} root */
  #reloadTree(client, root) {
    return this.#withViewer(client, () => this.#reloadViewer(client, root));
  }

  /** @param {AlpRpcClient} client @param {string} root */
  async #reloadViewer(client, root) {
    if (client !== this.#run?.alp?.client || this.#state.selected !== root) return;
    if (this.#attached?.client !== client || this.#attached.root !== root) return;
    this.#older.delete(root);
    try {
      await this.#attachTree(client, root);
    } catch (error) {
      this.#attachFailed(client, root, error);
    }
  }

  /** Load one older page; a failed page keeps its cursor so it can be retried. */
  async loadOlder() {
    const root = this.#state.selected;
    if (!root) return;
    const page = this.#older.get(root);
    const tree = this.#trees.get(root);
    const client = this.#attached?.root === root ? this.#attached.client : null;
    if (!page?.hasOlder || page.loading || !tree || !client) return;
    const loading = { ...page, loading: true, error: undefined };
    this.#older.set(root, loading); this.#publishTree(root);
    try {
      const result = await client.request('session.history', { sessionId: root, before: page.olderCursor }, { timeoutMs: this.#options.requestTimeoutMs });
      if (this.#older.get(root) !== loading) return;
      if (result.generation !== page.generation) throw new Error('History changed; reconnect to refresh it.');
      tree.projection = this.#indexProjection(prependHistory(tree.projection, result.items));
      this.#older.set(root, { generation: result.generation, olderCursor: result.olderCursor, hasOlder: result.hasOlder });
    } catch (error) {
      if (this.#older.get(root) === loading) this.#older.set(root, { ...page, error: describe(error).message });
    }
    this.#publishTree(root);
  }

  /** @param {string} root @param {unknown} error */
  #markGone(root, error) {
    const tree = this.#ensureTree(root);
    tree.gone = describe(error);
    tree.attaching = null;
    if (this.#watching === root) this.#watching = null;
    if (this.#state.selected === root) this.#set({ tree: { rootId: root, status: 'gone', error: tree.gone, projection: tree.projection } });
  }

  /** @param {string} root @param {TreeView['status']} [status] */
  #publishTree(root, status) {
    if (this.#state.selected !== root) { this.#pumpStop(root); return; }
    const tree = this.#trees.get(root);
    if (!tree) return;
    // A pending message is done once its user message is in the timeline, whatever its request
    // said; one the runtime refused later (prompt.failed) is shown as failed.
    const delivered = deliveredPrompts(tree.projection);
    const refused = tree.projection.prompts;
    for (const id of this.#stopCandidates.get(root) ?? []) {
      const outcome = refused[id];
      if ((outcome?.state === 'failed' && outcome.errorCode !== 'outcome_unknown')
        || (outcome?.turnId && tree.projection.turns[outcome.turnId] === 'ended')) this.#stopCandidates.get(root)?.delete(id);
    }
    let prompts = this.#state.prompts.filter(prompt => prompt.rootId !== root || !delivered.has(prompt.id));
    prompts = prompts.map(prompt => {
      const outcome = refused[prompt.id];
      if (prompt.rootId !== root || outcome?.state !== 'failed') return prompt;
      const unknown = outcome.errorCode === 'outcome_unknown';
      const status = unknown ? 'unknown' : 'failed';
      if (prompt.status === status) return prompt;
      const message = unknown ? 'The host cannot tell whether the agent took the message' : 'The agent did not take the message';
      return { ...prompt, status: /** @type {'unknown' | 'failed'} */ (status), error: outcome.error ? `${message}: ${outcome.error}` : `${message}.`, retrySameId: false };
    });
    this.#set(state => ({
      tree: { rootId: root, status: status ?? (state.tree?.rootId === root ? state.tree.status : 'attached'), projection: tree.projection, ...(this.#older.has(root) ? { older: this.#older.get(root) } : {}), ...(status === 'attached' ? {} : state.tree?.rootId === root && state.tree.error ? { error: state.tree.error } : {}) },
      ...(prompts.length !== state.prompts.length || prompts.some((prompt, index) => prompt !== state.prompts[index]) ? { prompts } : {}),
      sessions: this.#mergeSummary(state.sessions, root, tree.projection),
      busy: { ...state.busy, interrupt: this.#stops.has(root) && !this.#stops.get(root)?.exhausted },
    }));
    this.#pumpStop(root);
  }

  /** Keeps the list row of a root in step with its live status. @param {State['sessions']} sessions @param {string} root @param {Projection} projection */
  #mergeSummary(sessions, root, projection) {
    const index = sessions.list.findIndex(session => session.id === root);
    if (index < 0) return sessions;
    const row = sessions.list[index];
    const snapshot = projection.sessions[root];
    const status = projection.closed[root] ? 'closed' : root in projection.running ? 'running' : snapshot?.status === 'closed' ? 'closed' : row.status === 'closed' && !snapshot ? 'closed' : 'idle';
    if (row.status === status && (!snapshot?.title || snapshot.title === row.title)) return sessions;
    const list = sessions.list.slice();
    list[index] = { ...row, status, ...(snapshot?.title ? { title: snapshot.title } : {}) };
    return { ...sessions, list };
  }

  /**
   * Brings what is attached on the open connection in line with what is selected, one step at a
   * time: release the old tree, then attach the new one. Runs again when the selection changes
   * meanwhile. Only reads are sent here.
   */
  async #sync() {
    const client = this.#run?.alp?.client;
    if (!client) return;
    if (this.#syncing.has(client)) { this.#syncAgain = true; return; }
    this.#syncing.add(client);
    try {
      for (;;) {
        this.#syncAgain = false;
        const again = await this.#withViewer(client, () => this.#syncViewer(client));
        if (client !== this.#run?.alp?.client) break;
        if (!again && !this.#syncAgain) break;
      }
    } finally {
      this.#syncing.delete(client);
    }
  }

  /** One step of #sync; true when another step may be needed. @param {AlpRpcClient} client */
  async #syncViewer(client) {
    if (this.#run?.alp?.state !== 'open' || client !== this.#run.alp.client) return false;
    const want = this.#state.selected;
    if (this.#attached && this.#attached.client !== client) this.#attached = null;
    const have = this.#attached;
    if (have && have.root !== want) {
      // Keep the receipt fence independently of the selected viewer. An auxiliary link may
      // retry indefinitely; that must not prevent reads of another root on this healthy link.
      this.#attached = null;
      if (this.#watching === have.root) this.#watching = null;
      await this.#handoffViewer(have);
      return true;
    }
    if (!want || want === this.#creating || this.#attached?.root === want) return false;
    const tree = this.#ensureTree(want);
    if (tree.gone) {
      this.#set({ tree: { rootId: want, status: 'gone', error: tree.gone, projection: tree.projection } });
      return false;
    }
    // A failed attach waits for Retry, a reconnect or the user coming back to it: no loop.
    if (tree.failed) {
      this.#set({ tree: { rootId: want, status: 'error', error: tree.failed, projection: tree.projection } });
      return false;
    }
    const retained = this.#stopLeases.get(want);
    try {
      // Reclaim a retained subscription before any delayed observer handoff can release it.
      this.#stopLeases.delete(want);
      // Attach may subscribe before its response is lost: own that possibility too.
      this.#attached = { client, root: want };
      await this.#attachTree(client, want);
      if (client !== this.#run?.alp?.client) return true;
      this.#attached = { client, root: want };
      return this.#state.selected !== want;
    } catch (error) {
      // A failed re-selection still needs its receipt fence until observer ownership is safe.
      if (retained && client === this.#run?.alp?.client) {
        if (this.#attached?.client === client && this.#attached.root === want) this.#attached = null;
        await this.#handoffViewer(retained);
      }
      this.#attachFailed(client, want, error);
      return false;
    }
  }

  /** Release a main viewer only after transferring any pending Stop receipt fence.
   * @param {{ client: AlpRpcClient, root: string }} viewer
   */
  async #handoffViewer(viewer) {
    const observer = this.#stops.get(viewer.root)?.observer;
    if (observer && observer.state !== 'stopped') {
      this.#stopLeases.set(viewer.root, viewer);
      void observer.ready().catch(() => {}).then(() => this.#releaseStopLease(viewer.root, viewer));
    } else {
      // A failed re-selection may have restored a lease after its observer stopped.
      this.#stopLeases.delete(viewer.root);
      await viewer.client.request('session.release', { sessionId: viewer.root }, { timeoutMs: this.#options.releaseTimeoutMs }).catch(() => {});
    }
  }

  /** @param {string} root @param {{ client: AlpRpcClient, root: string }} [expected] */
  #releaseStopLease(root, expected) {
    const lease = this.#stopLeases.get(root);
    if (!lease || (expected && lease !== expected)) return;
    void this.#withViewer(lease.client, async () => {
      if (this.#stopLeases.get(root) !== lease) return;
      this.#stopLeases.delete(root);
      if (this.#run?.alp?.client !== lease.client) return;
      if (this.#attached?.client === lease.client && this.#attached.root === root) return;
      await lease.client.request('session.release', { sessionId: root }, { timeoutMs: this.#options.releaseTimeoutMs }).catch(() => {});
    });
  }

  /**
   * An attach that failed: a terminal answer gives the root up; otherwise, with the connection
   * still up (a timeout, a gateway refusal), the failure is shown with Retry, and a retry or the
   * next reconnect attaches again from the same cursor.
   * @param {AlpRpcClient} client @param {string} root @param {unknown} error
   */
  #attachFailed(client, root, error) {
    if (client !== this.#run?.alp?.client) return;
    if (endsRoot(error)) { this.#markGone(root, error); return; }
    const tree = this.#ensureTree(root);
    tree.failed = describe(error);
    if (this.#state.selected === root) this.#set({ tree: { rootId: root, status: 'error', error: tree.failed, projection: tree.projection } });
  }

  /** Attaches the selected root again after an attach error. */
  retryAttach() {
    const root = this.#state.selected;
    if (!root) return;
    const tree = this.#trees.get(root);
    if (tree) { tree.gone = null; tree.failed = null; }
    const client = this.#run?.alp?.client;
    if (!client) return;
    void this.#withViewer(client, async () => {
      const have = this.#attached;
      if (have?.client === client && have.root === root) {
        this.#attached = null;
        if (this.#watching === root) this.#watching = null;
        await this.#handoffViewer(have);
      }
    }).finally(() => this.#sync());
  }

  // ---- workspaces and sessions -------------------------------------------------------------

  /** @param {string | null} workspace */
  selectWorkspace(workspace) {
    const principal = this.#state.principal;
    const chosen = workspace && (grantedWorkspace(principal ?? undefined, workspace) || this.#state.registry.workspaces.some(w => w.managedWorktree && w.directory === workspace)) ? workspace : null;
    if (chosen === this.#state.workspace) return;
    this.#context = {};
    this.#waiting = null;
    this.#set(state => ({
      workspace: chosen, selected: null, focus: null, tree: null,
      sessions: initialState().sessions,
      history: initialState().history,
      attention: {},
      turnAttention: {},
      catalog: initialState().catalog,
      tasks: { ...initialState().tasks, visible: state.tasks.visible },
    }));
    this.#sync();
    if (chosen && this.#state.connection.phase === 'open') {
      void this.refreshSessions();
      void this.refreshAttention();
      void this.#loadCatalog();
      if (this.#state.tasks.visible) void this.refreshTasks();
    }
  }

  async refreshRegistry() {
    if (!this.hasCapability('workspace.registry') || !can(this.#state.principal ?? undefined, 'project.read') || this.#state.registry.loading) return;
    const context = this.#registryContext;
    const run = this.#run;
    this.#set(state => ({ registry: { ...state.registry, loading: true } }));
    try {
      const workspaces = []; let cursor; let revision = 0;
      do {
        /** @type {import('@anhlp/alp-protocol').RpcMethodMap['workspace.list']['result']} */
        const page = await this.#client().request('workspace.list', { limit: 500, ...(cursor ? { cursor } : {}) });
        workspaces.push(...page.workspaces); revision = page.revision; cursor = page.nextCursor;
      } while (cursor);
      if (context === this.#registryContext && run === this.#run) this.#set({ registry: { workspaces, revision } });
    } catch (error) {
      if (context === this.#registryContext && run === this.#run) this.#set(state => ({ registry: { ...state.registry, loading: false, error: error instanceof Error ? error.message : String(error) } }));
    }
  }
  /** @param {string} workspaceId @param {boolean} pinned */
  async pinWorkspace(workspaceId, pinned) {
    if (!can(this.#state.principal ?? undefined, 'workspace.write')) { this.#notify('error', 'Ask the host owner to add workspace.write to your credential to change shared pins.'); return; }
    try {
      await this.#client().request('workspace.update', { workspaceId, pinned, ifRevision: this.#state.registry.revision, requestId: globalThis.crypto.randomUUID() });
      await this.refreshRegistry();
    } catch (error) { this.#notify('error', `Pin was not saved. ${error instanceof Error ? error.message : String(error)} Refresh and try again.`); await this.refreshRegistry(); }
  }
  /** @param {string} workspaceId @returns {Promise<string[]>} */
  async worktreeOptions(workspaceId) {
    const result = await this.#client().request('workspace.worktree.options', {workspaceId});
    return result.mappingIds;
  }
  /** @param {'create'|'remove'} operation @param {string} workspaceId @param {string} [mappingId] */
  async mutateWorktree(operation, workspaceId, mappingId) {
    if (!this.hasCapability('workspace.worktree') || !can(this.#state.principal ?? undefined, 'workspace.manage')) return false;
    const key = operation + ':' + workspaceId + ':' + (mappingId ?? '');
    let params = this.#worktreeRequests.get(key);
    if (!params) { params = {workspaceId,...(mappingId ? {mappingId}:{}),ifRevision:this.#state.registry.revision,requestId:globalThis.crypto.randomUUID()}; this.#worktreeRequests.set(key,params); }
    try {
      await this.#client().request('workspace.worktree.'+operation, params);
      this.#worktreeRequests.delete(key);
      await this.refreshRegistry();
      return true;
    } catch (error) {
      if (/** @type {any} */ (error)?.data?.reason === 'stale_revision') this.#worktreeRequests.delete(key);
      this.#notify('error', `Worktree ${operation} was not confirmed. ${error instanceof Error ? error.message : String(error)} Retry the same operation to reconcile its outcome.`);
      await this.refreshRegistry(); return false;
    }
  }

  /** Register only a directory the credential already grants. @param {string} directory */
  async registerProject(directory) {
    if (!can(this.#state.principal ?? undefined, 'workspace.write')) { this.#notify('error', 'Ask the host owner to add workspace.write to your credential. To add another directory, the owner must grant it locally first.'); return; }
    try {
      await this.#client().request('project.register', { directory, ifRevision: this.#state.registry.revision, requestId: globalThis.crypto.randomUUID() });
      await this.refreshRegistry();
    } catch (error) { this.#notify('error', `Project was not added. ${error instanceof Error ? error.message : String(error)} Refresh and try again.`); await this.refreshRegistry(); }
  }

  /** @param {{ quiet?: boolean }} [options] */
  async refreshSessions({ quiet = false } = {}) {
    void this.refreshRegistry();
    const workspace = this.#state.workspace;
    if (!workspace) return;
    const context = this.#context;
    if (!quiet) this.#set(state => ({ sessions: { ...state.sessions, status: state.sessions.list.length ? state.sessions.status : 'loading', error: undefined } }));
    // A turn attention older than this read, of a root the read finds running again, is over: a
    // new turn started (Paseo clears it then); alpd tells no turn start of a tree not attached.
    const readAt = Date.now();
    try {
      const client = this.#client();
      const result = await client.request('session.list', { projectRoot: workspace, rootsOnly: true, includeClosed: true });
      if (context !== this.#context) return;
      const list = (Array.isArray(result?.sessions) ? result.sessions : []).filter((/** @type {any} */ session) => session && typeof session.id === 'string' && !session.parentId && !session.archived)
        .sort((/** @type {any} */ a, /** @type {any} */ b) => String(b.updatedAt ?? b.createdAt ?? '').localeCompare(String(a.updatedAt ?? a.createdAt ?? '')));
      this.#set(state => {
        let sessions = { status: /** @type {const} */ ('ready'), list };
        // A root this view follows knows its live status better than a list read a moment ago.
        for (const [root, tree] of this.#trees) sessions = /** @type {any} */ (this.#mergeSummary(sessions, root, tree.projection));
        // A root just created may not be listed yet; keep it visible.
        const selected = state.selected && !list.some((/** @type {any} */ session) => session.id === state.selected) ? state.sessions.list.find(session => session.id === state.selected) : undefined;
        // Without the host's attention (which ends it itself), one older than this read of a root
        // found running again is over.
        const shared = this.#sharedAttention;
        const over = shared ? [] : Object.keys(state.turnAttention).filter(root => state.turnAttention[root].at < readAt && list.some((/** @type {any} */ row) => row.id === root && (row.status === 'running' || row.busy)));
        const turnAttention = over.length ? Object.fromEntries(Object.entries(state.turnAttention).filter(([root]) => !over.includes(root))) : state.turnAttention;
        return { sessions: selected ? { ...sessions, list: [selected, ...sessions.list] } : sessions, turnAttention };
      });
    } catch (error) {
      if (context !== this.#context) return;
      if (!quiet) this.#set(state => ({ sessions: { ...state.sessions, status: 'error', error: describe(error) } }));
    }
  }

  /**
   * The questions waiting in the workspace, counted per root, so every session of the list shows
   * when it needs an answer, not only the one open. With question.watch (docs/protocol/alp-json-rpc-v1.md
   * §12.2) the host then tells of each question asked or resolved, and this read runs again only on
   * a new connection or workspace and as a slow repair; without it question.list is polled. Quiet:
   * a failed read keeps the last counts.
   */
  async refreshAttention() {
    const workspace = this.#state.workspace;
    if (!workspace || !can(this.#state.principal ?? undefined, 'session.read')) return;
    const context = this.#context;
    const read = ++this.#attentionRead;
    const watch = this.hasCapability('question.watch');
    const log = watch ? { read, events: /** @type {Array<{ id: string, root?: string }>} */ ([]) } : null;
    this.#watchLog = log;
    const shared = this.#sharedAttention;
    /** @type {Array<[string, any]> | null} */
    const attentionLog = shared ? [] : null;
    this.#attentionLog = attentionLog;
    try {
      const turns = watch && this.hasCapability('question.watch.turns');
      const result = await this.#client().request(watch ? 'question.watch' : 'question.list', { projectRoot: workspace, ...(turns ? { turns: true } : {}), ...(shared ? { attention: true } : {}) });
      if (context !== this.#context || read !== this.#attentionRead) return;
      // The host's attention of every root now, then what changed since it read it: a turn that
      // ended while this page was away or disconnected asks again here.
      if (shared && Array.isArray(result?.attention)) this.#applyHostAttention(result.attention, attentionLog ?? []);
      // The answer is every question waiting when the host read it; the events after it follow.
      const waiting = new Map();
      for (const question of Array.isArray(result?.questions) ? result.questions : []) {
        if (typeof question?.id === 'string' && typeof question.rootId === 'string') waiting.set(question.id, question.rootId);
      }
      // Events seen meanwhile, in order: one older than the read changes nothing it does not
      // also undo (asked then resolved), one newer brings the answer up to date.
      for (const entry of log?.events ?? []) {
        if (entry.root) waiting.set(entry.id, entry.root); else waiting.delete(entry.id);
      }
      this.#waiting = waiting;
      this.#publishAttention();
      if (!watch) this.#waiting = null;
    } catch {
      // The next read tries again.
    } finally {
      if (this.#watchLog === log) this.#watchLog = null;
      if (this.#attentionLog === attentionLog) this.#attentionLog = null;
    }
  }

  /**
   * Takes the host's attention as the whole set, with the events seen while it was read applied
   * after it. One the user sees now is acknowledged instead of shown.
   * @param {any[]} listed @param {Array<[string, any]>} changes
   */
  #applyHostAttention(listed, changes) {
    /** @type {Map<string, any>} */
    const host = new Map();
    for (const entry of listed) if (typeof entry?.sessionId === 'string' && hostEntry(entry.attention)) host.set(entry.sessionId, entry.attention);
    for (const [root, attention] of changes) host.set(root, attention);
    /** @type {Record<string, TurnAttention>} */
    const turnAttention = {};
    for (const [root, attention] of host) {
      const entry = hostEntry(attention);
      if (!entry || this.#state.history.list.some(row => row.id === root && row.archived)) continue;
      if (this.#seen(root)) { this.#acknowledge(root, entry); continue; }
      // The same ending keeps its local time, so it is not notified again.
      const known = this.#state.turnAttention[root];
      turnAttention[root] = known?.hostAt === entry.hostAt ? known : entry;
    }
    if (JSON.stringify(turnAttention) !== JSON.stringify(this.#state.turnAttention)) this.#set({ turnAttention });
  }

  /** Whether the host pages and searches History itself (session.list.page, docs/protocol/alp-json-rpc-v1.md §12.1). */
  get historyPaged() { return this.hasCapability('session.list.page'); }

  /**
   * Paseo's History: every root of the workspace, the archived ones too, newest first. Where the
   * host pages it, the first page of the sessions matching `query` (the last one asked for when
   * absent), and Load more reads the next; otherwise every session, `query` filtered by the screen.
   * @param {{ quiet?: boolean, query?: string }} [options]
   */
  async loadHistory({ quiet = false, query = this.#state.history.query } = {}) {
    const workspace = this.#state.workspace;
    if (!workspace) return;
    const context = this.#context;
    const read = ++this.#historyRead;
    const paged = this.historyPaged;
    const search = query.trim();
    if (!quiet) this.#set(state => ({ history: { ...state.history, status: 'loading', error: undefined, query } }));
    try {
      const result = await this.#client().request('session.list', { projectRoot: workspace, rootsOnly: true, includeClosed: true, includeArchived: true, ...(paged ? { limit: this.#options.historyPageSize, ...(search ? { query: search } : {}) } : {}) });
      if (context !== this.#context || read !== this.#historyRead) return;
      const nextCursor = paged && typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
      this.#set({ history: { status: 'ready', list: historyRows(result, !paged), query, ...(nextCursor ? { nextCursor } : {}) } });
    } catch (error) {
      if (context !== this.#context || read !== this.#historyRead) return;
      if (!quiet || this.#state.history.status !== 'ready') this.#set(state => ({ history: { ...state.history, status: 'error', error: describe(error), query } }));
    }
  }

  /** Paseo's Load more: the next History page after the last one read, with the same query. */
  async loadMoreHistory() {
    const workspace = this.#state.workspace;
    const { status, nextCursor, query, more } = this.#state.history;
    if (!workspace || status !== 'ready' || !nextCursor || more === 'loading') return;
    const context = this.#context;
    const read = this.#historyRead;
    const search = query.trim();
    this.#set(state => ({ history: { ...state.history, more: 'loading' } }));
    try {
      const result = await this.#client().request('session.list', { projectRoot: workspace, rootsOnly: true, includeClosed: true, includeArchived: true, limit: this.#options.historyPageSize, cursor: nextCursor, ...(search ? { query: search } : {}) });
      if (context !== this.#context) return;
      // A first page read meanwhile replaced the list this page continued.
      if (read !== this.#historyRead) { this.#settleMore(); return; }
      const next = typeof result?.nextCursor === 'string' ? result.nextCursor : undefined;
      this.#set(state => {
        const known = new Set(state.history.list.map(row => row.id));
        const { more: _more, nextCursor: _cursor, ...history } = state.history;
        return { history: { ...history, list: [...history.list, ...historyRows(result, false).filter(row => !known.has(row.id))], ...(next ? { nextCursor: next } : {}) } };
      });
    } catch {
      if (context !== this.#context) return;
      if (read !== this.#historyRead) { this.#settleMore(); return; }
      this.#set(state => ({ history: { ...state.history, more: 'error' } }));
    }
  }

  /** Ends a Load more whose list was replaced while it ran. */
  #settleMore() {
    if (this.#state.history.more !== 'loading') return;
    const { more: _more, ...history } = this.#state.history;
    this.#set({ history });
  }

  /** Whether the host lists the workspace's files (workspace.files, the command center's Files). */
  get filesSearchable() { return this.hasCapability('workspace.files'); }

  /**
   * Paseo's file search of the command center: workspace.files.search in the open workspace,
   * paths relative to it, ranked by the host. Throws a Failure-shaped error: a token without
   * project.read gets FILES_FORBIDDEN, whether the gateway or this app's grant says it.
   * @param {{ query?: string, limit?: number }} [input]
   * @returns {Promise<{ files: Array<{ path: string }>, truncated: boolean }>}
   */
  async searchWorkspaceFiles({ query = '', limit = FILE_SEARCH_LIMIT } = {}) {
    const workspace = this.#state.workspace;
    if (!workspace) throw new ConfigurationError('Choose a workspace first.');
    if (!this.filesSearchable) throw new ConfigurationError('The host does not offer file search. Update ALP on the host.');
    if (!can(this.#state.principal ?? undefined, 'project.read')) throw new ConfigurationError(FILES_FORBIDDEN);
    let result;
    try {
      result = await this.#client().request('workspace.files.search', { projectRoot: workspace, query: String(query).slice(0, 200), limit });
    } catch (error) {
      if (describe(error).code === 1003) throw new ConfigurationError(FILES_FORBIDDEN);
      throw error;
    }
    const files = (Array.isArray(result?.files) ? result.files : [])
      .filter((/** @type {any} */ file) => file && typeof file.path === 'string' && file.path)
      .map((/** @type {any} */ file) => ({ path: String(file.path) }));
    return { files, truncated: result?.truncated === true };
  }

  /** Whether the host lists directories and reads files (workspace.files.read). */
  get filesReadable() { return this.hasCapability('workspace.files.read'); }

  /** Whether this token may read files (files.read, granted per credential, never by default). */
  get canReadFiles() { return can(this.#state.principal ?? undefined, 'files.read'); }

  /**
   * The guards of a file request, in searchWorkspaceFiles' order (workspace, capability, grant),
   * then the path: a blocked or malformed path is refused here, without a request.
   * @param {string | undefined} path @param {boolean} required
   */
  #fileRequest(path, required) {
    const refuse = (/** @type {string} */ message, /** @type {string} */ reason, terminal = false) => new FileAccessError({ message, reason, sent: 'no', terminal });
    const workspace = this.#state.workspace;
    if (!workspace) throw refuse('Choose a workspace first.', 'workspace');
    if (!this.filesReadable) throw refuse(FILES_READ_UNAVAILABLE, 'capability', true);
    if (!this.canReadFiles) throw refuse(FILES_READ_FORBIDDEN, 'grant', true);
    if (path === undefined || path === '') {
      if (required) throw refuse(FILE_MESSAGES.invalid_path, 'invalid_path');
      return { workspace, path: undefined };
    }
    const relative = relativeFilePath(path);
    if (!relative) throw refuse(FILE_MESSAGES.invalid_path, 'invalid_path');
    if (blockedFilePath(relative)) throw refuse(FILE_MESSAGES.blocked_path, 'blocked_path');
    return { workspace, path: relative };
  }

  /** A file request's failure as a FileAccessError; a grant refusal says what is missing. @param {unknown} error */
  #fileFailure(error) {
    const failure = describeFileError(error);
    if (failure.code === 1003 && failure.reason === 'grant') return new FileAccessError({ ...failure, message: FILES_READ_FORBIDDEN });
    return new FileAccessError(failure);
  }

  /**
   * Paseo's list_directory: the entries of a directory of the open workspace (the root when `path`
   * is left out), through workspace.files.list. Only entries of that directory with a clean
   * relative path that is not blocked are kept, at most WORKSPACE_FILES.maxListEntries. Throws a
   * FileAccessError (its `reason` and `failure`).
   * @param {{ path?: string, includeIgnored?: boolean }} [input]
   * @returns {Promise<{ entries: import('./file-tree.js').FileEntry[], truncated: boolean }>}
   */
  async listWorkspaceFiles({ path, includeIgnored = false } = {}) {
    const request = this.#fileRequest(path, false);
    let result;
    try {
      result = await this.#client().request('workspace.files.list', { projectRoot: request.workspace, ...(request.path ? { path: request.path } : {}), ...(includeIgnored ? { includeIgnored: true } : {}) });
    } catch (error) {
      throw this.#fileFailure(error);
    }
    return cleanListing(result, request.path ?? '');
  }

  /**
   * Paseo's read_file: a UTF-8 text file of the open workspace (at most 1 MiB), through
   * workspace.files.read. Throws a FileAccessError: binary, too_large, ignored (ask again with
   * includeIgnored), blocked_path, linked, not_found, grant…
   * @param {{ path: string, includeIgnored?: boolean }} input
   * @returns {Promise<{ path: string, content: string, size: number, modifiedAt?: string }>}
   */
  async readWorkspaceFile({ path, includeIgnored = false }) {
    const request = this.#fileRequest(path, true);
    let result;
    try {
      result = await this.#client().request('workspace.files.read', { projectRoot: request.workspace, path: request.path, ...(includeIgnored ? { includeIgnored: true } : {}) });
    } catch (error) {
      throw this.#fileFailure(error);
    }
    const content = typeof result?.content === 'string' ? result.content : undefined;
    if (content === undefined || content.length > WORKSPACE_FILES.maxReadBytes) {
      throw new FileAccessError({ message: content === undefined ? 'The host sent something this app does not understand.' : FILE_MESSAGES.too_large, ...(content === undefined ? {} : { reason: 'too_large' }), sent: 'yes', terminal: false });
    }
    return {
      path: /** @type {string} */ (request.path),
      content,
      size: typeof result?.size === 'number' && Number.isFinite(result.size) ? result.size : content.length,
      ...(typeof result?.modifiedAt === 'string' ? { modifiedAt: result.modifiedAt } : {}),
    };
  }

  // ---- Git (Paseo's Changes and Diff panels, read only; §12.5) ----------------------------------

  /** What the Changes and Diff panels may show for the open workspace (lib/git.js gitAccess). */
  get gitAccess() { return gitAccess(this.#state); }

  /**
   * The open workspace's Git status (workspace.git.status by its registry id): branch, upstream,
   * changed files without content. Throws a GitAccessError, without a request when the host, the
   * token or the registry cannot serve it.
   * @returns {Promise<import('@anhlp/alp-protocol').GitStatus>}
   */
  async gitStatus() {
    const access = gitAccess(this.#state);
    if (!access.status) throw new GitAccessError({ message: access.message, reason: access.reason, sent: 'no', terminal: access.reason !== 'loading' });
    let result;
    try {
      result = await this.#client().request('workspace.git.status', { workspaceId: access.workspaceId });
    } catch (error) {
      throw new GitAccessError(describeGitError(error));
    }
    if (!result || typeof result !== 'object' || typeof result.state !== 'string' || !Array.isArray(result.files)) throw new GitAccessError({ message: 'The host sent something this app does not understand.', sent: 'yes', terminal: false });
    return result;
  }

  /**
   * One page of the open workspace's diff (workspace.git.diff): `compare` as lib/git.js
   * gitCompare builds it, `path` to focus one file, `cursor` the previous page's nextCursor with
   * the same comparison and path. Needs files.read too (hunks are file content); a blocked or
   * malformed path is refused here, without a request.
   * @param {{ compare: { mode: string, baseRef?: string | null, ignoreWhitespace?: boolean }, path?: string, cursor?: string }} input
   * @returns {Promise<import('@anhlp/alp-protocol').GitDiffPage>}
   */
  async gitDiff({ compare, path, cursor }) {
    const access = gitAccess(this.#state);
    if (!access.status) throw new GitAccessError({ message: access.message, reason: access.reason, sent: 'no', terminal: access.reason !== 'loading' });
    if (!access.content) throw new GitAccessError({ message: /** @type {string} */ (access.contentMessage), reason: 'grant', sent: 'no', terminal: true });
    const file = path === undefined ? undefined : gitRequestPath(path);
    if (path !== undefined && !file) {
      const reason = relativeFilePath(path) ? 'blocked_path' : 'invalid_path';
      throw new GitAccessError({ message: GIT_ERROR_MESSAGES[reason], reason, sent: 'no', terminal: false });
    }
    let result;
    try {
      result = await this.#client().request('workspace.git.diff', { workspaceId: access.workspaceId, compare: gitCompare(compare), ...(file ? { path: file } : {}), ...(cursor ? { cursor } : {}) });
    } catch (error) {
      throw new GitAccessError(describeGitError(error));
    }
    if (!result || typeof result !== 'object' || typeof result.snapshot !== 'string' || !Array.isArray(result.files)) throw new GitAccessError({ message: 'The host sent something this app does not understand.', sent: 'yes', terminal: false });
    return result;
  }

  /** Whether a root is archived, as far as the History read and this client's own actions know. @param {string | null | undefined} id */
  isArchived(id) {
    if (!id) return false;
    return !!this.#state.history.list.find(row => row.id === id)?.archived && !this.#state.sessions.list.some(row => row.id === id);
  }

  async #loadCatalog() {
    const workspace = this.#state.workspace;
    const principal = this.#state.principal;
    if (!workspace || !principal) return;
    const context = this.#context;
    this.#set(state => ({ catalog: { ...state.catalog, status: 'loading', error: undefined } }));
    try {
      const client = this.#client();
      const [teamList, catalog, models] = await Promise.all([
        this.#fetchTeams(client, principal, workspace),
        can(principal, 'session.read') ? client.request('catalog.get', {}).catch(() => undefined) : undefined,
        this.hasCapability('library') && can(principal, 'session.read') ? client.request('library.models', {}).catch(() => undefined) : undefined,
      ]);
      if (context !== this.#context) return;
      const allowed = principal.modes;
      const modeRows = Array.isArray(catalog?.modes) && catalog.modes.length ? catalog.modes : Object.keys(MODE_LABELS).map(id => ({ id }));
      const modes = modeRows.filter((/** @type {any} */ mode) => typeof mode?.id === 'string' && (!allowed || allowed.includes(mode.id)))
        .map((/** @type {any} */ mode) => ({ id: mode.id, label: typeof mode.label === 'string' ? mode.label : MODE_LABELS[mode.id] ?? mode.id, ...(typeof mode.description === 'string' ? { description: mode.description } : {}) }));
      const modelRows = normalizeModels(models?.models);
      const defaultMode = modes.some((/** @type {Mode} */ mode) => mode.id === 'full-access') ? 'full-access' : modes[0]?.id;
      this.#set({ catalog: { status: 'ready', ...teamList, modes, models: modelRows, ...(defaultMode ? { defaultMode } : {}) } });
    } catch (error) {
      if (context !== this.#context) return;
      this.#set(state => ({ catalog: { ...state.catalog, status: 'error', error: describe(error) } }));
    }
  }

  /**
   * The workspace's teams. teamsKnown: team.list answered, so an empty list means the host has no
   * team (not that it could not be asked); otherwise teamsUnavailable says why it was not asked or
   * did not answer.
   * @param {any} client @param {Principal} principal @param {string} workspace
   * @returns {Promise<{ teams: Team[], teamsKnown: boolean, teamsUnavailable?: import('./new-session.js').TeamsUnavailable }>}
   */
  async #fetchTeams(client, principal, workspace) {
    if (!this.hasCapability('team')) return { teams: [], teamsKnown: false, teamsUnavailable: { reason: 'capability' } };
    if (!can(principal, 'project.read')) return { teams: [], teamsKnown: false, teamsUnavailable: { reason: 'permission' } };
    try {
      const answer = await client.request('team.list', { projectRoot: workspace });
      if (!Array.isArray(answer?.teams)) return { teams: [], teamsKnown: false, teamsUnavailable: { reason: 'failed', message: 'The host answered team.list in a form this app does not read.' } };
      const teams = answer.teams.filter((/** @type {any} */ team) => typeof team?.id === 'string' && !team.error)
        .map((/** @type {any} */ team) => ({ id: team.id, label: typeof team.label === 'string' ? team.label : team.id, ...(typeof team.description === 'string' ? { description: team.description } : {}) }));
      return { teams, teamsKnown: true };
    } catch (error) {
      return { teams: [], teamsKnown: false, teamsUnavailable: { reason: 'failed', message: describe(error).message } };
    }
  }

  /**
   * Where a New session start begins: its workspace and connection, taken before it waits on the
   * host, so a failure keeps the first message for them (keepUnsentDraft).
   * @returns {{ workspace: string | null, connection: number }}
   */
  startOrigin() { return { workspace: this.#state.workspace, connection: this.#generation }; }

  /**
   * Keeps a first message that was not sent for the workspace it was written for: a New session
   * screen of that workspace open now takes it at once, otherwise the next one does (memory only;
   * a disconnect forgets it, and a start begun on an earlier connection keeps nothing).
   * @param {string} text @param {{ workspace: string | null, connection: number }} origin from startOrigin()
   */
  keepUnsentDraft(text, origin) {
    if (!text || !origin?.workspace || origin.connection !== this.#generation) return;
    const kept = { workspace: origin.workspace, text: String(text) };
    for (const take of this.#unsentTakers) if (take(kept)) { this.#unsentDraft = null; return; }
    this.#unsentDraft = kept;
  }

  /**
   * An open New session screen asks for first messages kept while it is open; `take` returns
   * whether it showed one. Returns the release.
   * @param {(kept: { workspace: string, text: string }) => boolean} take
   */
  takeUnsentDrafts(take) { this.#unsentTakers.add(take); return () => { this.#unsentTakers.delete(take); }; }

  /** The first message a failed start left in the open workspace, if any (read when a New session screen opens). */
  unsentDraft() { const kept = this.#unsentDraft; return kept && kept.workspace === this.#state.workspace ? kept.text : ''; }

  /**
   * The New session screen showed the kept message again. With `text`, only that message is
   * forgotten (one kept after the screen read it stays for the screen to take).
   * @param {string} [text]
   */
  clearUnsentDraft(text) { if (text === undefined || this.#unsentDraft?.text === text) this.#unsentDraft = null; }

  /** Asks team.list again after it failed (the New session preview's Retry); otherwise does nothing. */
  async retryTeams() {
    const { workspace, principal, catalog } = this.#state;
    if (!workspace || !principal || catalog.status !== 'ready' || catalog.teamsUnavailable?.reason !== 'failed' || this.#retryingTeams) return;
    const context = this.#context;
    this.#retryingTeams = true;
    try {
      const teamList = await this.#fetchTeams(this.#client(), principal, workspace);
      if (context !== this.#context || this.#state.workspace !== workspace || this.#state.catalog.status !== 'ready') return;
      this.#set(state => ({ catalog: { ...state.catalog, teams: teamList.teams, teamsKnown: teamList.teamsKnown, teamsUnavailable: teamList.teamsUnavailable } }));
    } catch {
      // Not connected: the next connection loads the catalog again.
    } finally {
      this.#retryingTeams = false;
    }
  }

  /** Opens a root of the list (or nothing). Its tree is attached after its cursor. @param {string | null} root */
  selectSession(root) {
    // Opened (or chosen again): the user looks at it now.
    this.clearAttention(root);
    if (root === this.#state.selected) return;
    const tree = root ? this.#ensureTree(root) : undefined;
    if (tree) tree.failed = null;
    this.#set({
      selected: root,
      focus: root,
      tree: root && tree ? { rootId: root, status: tree.gone ? 'gone' : 'detached', ...(tree.gone ? { error: tree.gone } : {}), projection: tree.projection } : null,
    });
    this.#sync();
  }

  /** Shows one session of the selected tree in the timeline. @param {string} sessionId */
  focusSession(sessionId) {
    const projection = this.#state.tree?.projection;
    if (!projection || (sessionId !== projection.rootId && !projection.sessions[sessionId])) return;
    this.clearAttention(sessionId);
    this.#set({ focus: sessionId });
  }

  /**
   * Starts a root in the workspace: an id chosen here (its first events may come before the
   * answer), session.create with history skipped, then session.attach for the whole timeline.
   * A first message (Paseo's initial prompt) is sent once attached, through the same path as
   * the composer's (receipts, retry). A title given is set before it; without one alpd names the
   * session after that message, as Paseo does, and announces it (session.updated).
   * Files of the first message (#121 J) were held here: they are uploaded only once the session
   * exists, under its id, never a guessed one; a runtime that cannot read them leaves the message
   * failed with the reason, never sent without them.
   * @param {{ team?: string, mode?: string, model?: string, thinking?: string, title?: string, prompt?: string, files?: import('./attachments.js').FileAttachment[] }} input
   */
  async createSession({ team, mode, model, thinking, title, prompt, files = [] } = {}) {
    const workspace = this.#state.workspace;
    if (!workspace) throw new ConfigurationError('Choose a workspace first.');
    // One create at a time: a second Enter or click while one is starting must not make a second
    // session. Claimed synchronously, before any await.
    if (this.#creating || this.#state.busy.create) throw new ConfigurationError('A new session is already starting.');
    const client = this.#client();
    const id = newSessionId();
    const context = this.#context;
    this.#creating = id;
    this.#set(state => ({ busy: { ...state.busy, create: true } }));
    // Claim selection before yielding: a later user choice must win over this create.
    const tree = this.#ensureTree(id);
    const placeholder = /** @type {SessionSummary} */ (/** @type {unknown} */ ({ id, projectRoot: workspace, status: 'initializing', ...(title ? { title } : {}), createdAt: new Date().toISOString() }));
    this.#set(state => ({
      selected: id, focus: id,
      tree: { rootId: id, status: 'attaching', projection: tree.projection },
      sessions: { ...state.sessions, list: [placeholder, ...state.sessions.list.filter(session => session.id !== id)] },
    }));
    const current = () => context === this.#context && client === this.#run?.alp?.client;
    const check = () => { if (!current()) throw new ConfigurationError('The connection or workspace changed while starting the session.'); };
    try {
      return await this.#withViewer(client, async () => {
        check();
        const previous = this.#attached;
        // Leave the tree shown now first, so its last events do not mix with the new one's.
        if (previous && previous.client === client) {
          this.#attached = null;
          this.#watching = null;
          await this.#handoffViewer(previous);
        }
        check();
        const operation = { buffer: /** @type {any[]} */ ([]) };
        tree.attaching = operation;
        this.#watching = id;
        const spec = { cwd: workspace, persist: true, ...(team ? { workflow: team } : {}), ...(mode ? { mode } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) };
        // Claim the implicit create subscription before sending: an unknown outcome may have
        // subscribed too, and still needs reconciliation when another root is selected.
        this.#attached = { client, root: id };
        try {
          await client.request('session.create', { sessionId: id, spec, history: 'skip' }, { timeoutMs: this.#options.createTimeoutMs });
          check();
          // session.create itself subscribes the client, even if the following attach fails.
          this.#attached = { client, root: id };
        } catch (error) {
          if (!current()) throw error;
          tree.attaching = null;
          const failure = describe(error);
          if (failure.sent !== 'unknown') {
            if (this.#attached?.client === client && this.#attached.root === id) {
              this.#attached = null;
              await this.#handoffViewer({ client, root: id });
            }
            if (!current()) throw error;
            this.#trees.delete(id);
            this.#older.delete(id);
            this.#membership.delete(id);
            if (this.#watching === id) this.#watching = null;
            this.#set(state => ({ ...(state.selected === id ? { selected: null, focus: null, tree: null } : {}), sessions: { ...state.sessions, list: state.sessions.list.filter(session => session.id !== id) } }));
            throw error;
          }
          // It may exist: keep it selected; the list and the next attach tell. Its first message
          // is not sent; the caller is told (it keeps the text), never a silent success.
          void this.refreshSessions();
          throw new CreateOutcomeUnknownError(`${failure.message} If the new session shows in the list, open it and send your message there; otherwise start again.`, id);
        }
        try {
          let generation;
          if (this.hasCapability('session.history')) {
            const checkpoint = await client.request('session.history', { sessionId: id, limit: 1 }, { timeoutMs: this.#options.requestTimeoutMs });
            check();
            generation = checkpoint.generation;
            this.#older.set(id, { generation, hasOlder: false });
          }
          const response = await client.request('session.attach', { sessionId: id, ...(generation ? { generation, after: 0 } : {}) }, { timeoutMs: this.#options.requestTimeoutMs });
          check();
          if (tree.attaching === operation) {
            tree.attaching = null;
            tree.failed = null;
            this.#finishAttach(id, tree, response, operation.buffer);
          }
        } catch (error) {
          if (!current()) throw error;
          if (tree.attaching === operation) tree.attaching = null;
          if (this.#watching === id) this.#watching = null;
          // Never session.create again: the session exists. A drop reattaches on reconnect; a
          // timeout or refusal on a live connection is shown with Retry (an attach is a read).
          this.#attachFailed(client, id, error);
        }
        if (title?.trim()) await this.renameSession(id, title.trim()).catch(() => {});
        check();
        this.#rememberNewSession({ team, mode, model, thinking });
        if (prompt?.trim() || files.length) {
          // Keep the new viewer until upload and prompt admission settle, so navigating away
          // cannot close this idle root before its first message reaches the host. This waits
          // for delivery, never for the runtime turn; failures retain the usual Retry entry.
          await this.sendPrompt(prompt ?? '', id, [], files, { keepRefused: true }).catch(error => this.#notify('error', describe(error).message));
        }
        void this.refreshSessions({ quiet: true });
        return id;
      });
    } finally {
      if (this.#creating === id) {
        this.#creating = null;
        this.#set(state => ({ busy: { ...state.busy, create: false } }));
      }
      this.#sync();
    }
  }

  /** @param {string} id @param {string} title */
  async renameSession(id, title) {
    const client = this.#client();
    const result = await client.request('session.rename', { sessionId: id, title });
    const session = result?.session;
    const update = (/** @type {SessionSummary} */ row) => row.id === id ? { ...row, ...(session && typeof session === 'object' ? session : {}), title } : row;
    this.#set(state => ({ sessions: { ...state.sessions, list: state.sessions.list.map(update) }, history: { ...state.history, list: state.history.list.map(update) } }));
    const tree = this.#trees.get(id);
    if (tree) {
      tree.projection = { ...tree.projection, sessions: { ...tree.projection.sessions, [id]: { ...tree.projection.sessions[id], id, title } } };
      this.#publishTree(id);
    }
  }

  /** Archives a root: alpd closes it and hides it from the list (data is kept). @param {string} id */
  async archiveSession(id) {
    const client = this.#client();
    const context = this.#context;
    await client.request('session.archive', { sessionId: id, archived: true });
    if (context !== this.#context) return;
    if (this.#state.selected === id) this.selectSession(null);
    const { [id]: _gone, ...attention } = this.#state.attention;
    const { [id]: _ended, ...turnAttention } = this.#state.turnAttention;
    this.#set(state => ({
      turnAttention,
      sessions: { ...state.sessions, list: state.sessions.list.filter(row => row.id !== id) },
      history: { ...state.history, list: state.history.list.map(row => row.id === id ? { ...row, archived: true } : row) },
      attention,
    }));
  }

  /** Brings an archived root back into the list (Paseo's Unarchive). @param {string} id */
  async restoreSession(id) {
    const client = this.#client();
    const context = this.#context;
    const result = await client.request('session.archive', { sessionId: id, archived: false });
    // The workspace changed meanwhile: its lists are not this session's.
    if (context !== this.#context) return;
    const session = result?.session && typeof result.session === 'object' ? result.session : undefined;
    this.#set(state => {
      const known = state.history.list.find(row => row.id === id);
      const row = /** @type {SessionSummary} */ ({ ...(known ?? {}), ...(session ?? {}), id, archived: false });
      return {
        history: { ...state.history, list: state.history.list.map(entry => entry.id === id ? row : entry) },
        sessions: { ...state.sessions, list: state.sessions.list.some(entry => entry.id === id) ? state.sessions.list : [row, ...state.sessions.list] },
      };
    });
    void this.refreshSessions({ quiet: true });
  }

  // ---- conversation fork and rewind (§12.7) ------------------------------------------------

  /** The open root's summary as known here: its list row, then what its tree said since. @param {string} root */
  #rootSummary(root) {
    const listed = this.#state.sessions.list.find(row => row.id === root) ?? this.#state.history.list.find(row => row.id === root);
    const projected = this.#trees.get(root)?.projection.sessions[root];
    return /** @type {Partial<SessionSummary>} */ ({ ...(listed ?? {}), ...(projected ?? {}), ...(projected?.conversation ? {} : listed?.conversation ? { conversation: listed.conversation } : {}) });
  }

  /**
   * Whether fork and rewind are offered for the open root now (lib/conversation.js
   * conversationGate): the host's capability, the root's summary, the token, the history generation.
   */
  conversationGate(root = this.#state.tree?.rootId) {
    const { principal, connection } = this.#state;
    const tree = root ? this.#trees.get(root) : undefined;
    const busy = !!root && !!tree && (this.rootBusy(root) || Object.keys(tree.projection.running).length > 0 || Object.keys(tree.projection.questions).length > 0);
    return conversationGate({
      capabilities: connection.capabilities,
      canRead: can(principal ?? undefined, 'session.read'),
      canWrite: can(principal ?? undefined, 'session.write'),
      summary: root ? this.#rootSummary(root) : null,
      busy,
      generation: root ? this.#older.get(root)?.generation ?? null : null,
      online: connection.phase === 'open',
      driveBlock: root && root === this.#state.tree?.rootId ? this.driveBlock() : undefined,
    });
  }

  /**
   * Reload agent and Copy resume command for a session's tab (§12.8, lib/conversation.js
   * agentControlsGate): reload only for the open root, idle, within the token's modes.
   * @param {string} sessionId
   */
  agentControls(sessionId) {
    const { principal, connection } = this.#state;
    const root = this.#state.tree?.rootId;
    const tree = root ? this.#trees.get(root) : undefined;
    const isRoot = !!root && sessionId === root;
    const busy = isRoot && !!tree && (this.rootBusy(root) || Object.keys(tree.projection.running).length > 0 || Object.keys(tree.projection.questions).length > 0);
    return agentControlsGate({
      capabilities: connection.capabilities,
      canRead: can(principal ?? undefined, 'session.read'),
      canWrite: can(principal ?? undefined, 'session.write'),
      summary: isRoot ? this.#rootSummary(root) : null,
      root: isRoot,
      closed: isRoot && !!tree?.projection.closed[root],
      busy,
      generation: isRoot ? this.#older.get(root)?.generation ?? null : null,
      online: connection.phase === 'open',
      driveBlock: isRoot ? this.driveBlock() : undefined,
    });
  }

  /**
   * Copy resume command: the ALP CLI command the host builds (session.resumeCommand) goes to the
   * clipboard; it is never run here. A notice says what was copied, or why nothing was.
   * @param {string} sessionId @param {(text: string) => Promise<void>} write the clipboard
   */
  async copyResumeCommand(sessionId, write) {
    try {
      /** @type {import('@anhlp/alp-protocol').RpcMethodMap['session.resumeCommand']['result']} */
      const command = await this.#client().request('session.resumeCommand', { sessionId });
      if (typeof command?.display !== 'string' || !command.display) throw new ConfigurationError('The host answered no command.');
      await write(command.display);
      this.#notify('info', `Copied the resume command: ${command.display}`);
      return command;
    } catch (error) {
      this.#notify('error', `Could not copy the resume command: ${describe(error).message}`);
      return undefined;
    }
  }

  /**
   * session.reload: the open root's native process restarts on its own conversation and settings at
   * the idle barrier; its id, history and receipts stay (§12.8). `requestId` is the user's action.
   * @param {{ sessionId: string, requestId: string }} input
   */
  async reloadAgent({ sessionId, requestId }) {
    const { root, generation, client } = this.#conversationTarget();
    if (sessionId !== root) throw new ConfigurationError(RELOAD_MESSAGES.not_root);
    this.#notify('info', 'Reloading the agent…');
    try {
      /** @type {import('@anhlp/alp-protocol').RpcMethodMap['session.reload']['result']} */
      const result = await client.request('session.reload', { sessionId: root, requestId, ifGeneration: generation }, { timeoutMs: this.#options.createTimeoutMs });
      this.#adoptSummary(result.session);
      void this.refreshSessions({ quiet: true });
      this.#notify('info', 'Reloaded the agent: it restarted on the same conversation.');
      return result;
    } catch (error) {
      this.#conversationRefused(root, error);
      this.#notify('error', describeReloadError(error).message);
      throw error;
    }
  }

  /** The open root's summary (fork provenance, branches). @param {string} [root] */
  rootSummary(root = this.#state.tree?.rootId) { return root ? this.#rootSummary(root) : {}; }

  /** The history generation this view holds for a root (session.history), if any. @param {string} root */
  historyGeneration(root) { return this.#older.get(root)?.generation; }

  /** Puts a summary alpd answered into the list rows and the open tree. @param {any} session */
  #adoptSummary(session) {
    if (!session || typeof session.id !== 'string') return;
    const id = session.id;
    const update = (/** @type {SessionSummary} */ row) => row.id === id ? { ...row, ...session } : row;
    this.#set(state => ({ sessions: { ...state.sessions, list: state.sessions.list.map(update) }, history: { ...state.history, list: state.history.list.map(update) } }));
    const tree = this.#trees.get(id);
    if (tree) {
      tree.projection = { ...tree.projection, sessions: { ...tree.projection.sessions, [id]: { ...tree.projection.sessions[id], ...session, id } } };
      this.#publishTree(id);
    }
  }

  /** The open root, its generation and a client, for a fork or rewind. */
  #conversationTarget() {
    const root = this.#state.tree?.rootId ?? this.#state.selected;
    if (!root) throw new ConfigurationError('Open a session first.');
    const generation = this.#older.get(root)?.generation;
    if (!generation) throw new ConfigurationError('The conversation is still loading. Try again in a moment.');
    return { root, generation, client: this.#client() };
  }

  /** A refusal that says this view is behind the host: read the history again. @param {string} root @param {unknown} error */
  #conversationRefused(root, error) {
    if (!describeConversationError(error).reload) return;
    const client = this.#attached?.root === root ? this.#attached.client : undefined;
    this.#older.delete(root);
    if (client) void this.#reloadTree(client, root);
  }

  /**
   * session.rewind: the open root's conversation goes back to before `beforeTurnId` under the same
   * session id; the later turns stay a branch (session.fork { branchId } restores it) and no file is
   * changed. `requestId` is the user's action: the caller sends the same one again only when the
   * answer was lost (describeConversationError().retrySame). The view then reloads the new history.
   * @param {{ beforeTurnId: string, requestId: string }} input
   */
  async rewindConversation({ beforeTurnId, requestId }) {
    const { root, generation, client } = this.#conversationTarget();
    try {
      /** @type {import('@anhlp/alp-protocol').RpcMethodMap['session.rewind']['result']} */
      const result = await client.request('session.rewind', { sessionId: root, requestId, ifGeneration: generation, beforeTurnId }, { timeoutMs: this.#options.createTimeoutMs });
      this.#adoptSummary(result.session);
      this.#historyReset(root, result.generation);
      void this.refreshSessions({ quiet: true });
      return result;
    } catch (error) {
      this.#conversationRefused(root, error);
      throw error;
    }
  }

  /**
   * session.fork: a new closed root whose conversation is the open root's through or before a turn
   * (`boundary`), or a branch a rewind set aside (`branchId`), in this workspace or another registry
   * workspace (`workspaceId`, whose `directory` the app then opens). Nothing is copied but the
   * conversation. The fork is opened (selected; its first message resumes it).
   * @param {{ requestId: string, boundary?: { throughTurnId: string } | { beforeTurnId: string }, branchId?: string, workspaceId?: string, directory?: string, title?: string }} input
   */
  async forkConversation({ requestId, boundary, branchId, workspaceId, directory, title }) {
    const { root, generation, client } = this.#conversationTarget();
    /** @type {import('@anhlp/alp-protocol').RpcMethodMap['session.fork']['result']} */
    let result;
    try {
      result = await client.request('session.fork', {
        sessionId: root, requestId, ifGeneration: generation,
        ...(boundary ? { boundary } : {}), ...(branchId ? { branchId } : {}), ...(workspaceId ? { workspaceId } : {}), ...(title?.trim() ? { title: title.trim() } : {}),
      }, { timeoutMs: this.#options.createTimeoutMs });
    } catch (error) {
      this.#conversationRefused(root, error);
      throw error;
    }
    this.#openFork(result.session, directory);
    return result;
  }

  /** Opens a fork alpd answered: in its workspace, listed at once, selected. @param {any} session @param {string} [directory] */
  #openFork(session, directory) {
    const id = session?.id;
    if (typeof id !== 'string') return;
    if (directory && directory !== this.#state.workspace) this.selectWorkspace(directory);
    // Listed at once; the next session.list read (below) brings the host's row.
    this.#set(state => ({ sessions: { ...state.sessions, list: [session, ...state.sessions.list.filter(row => row.id !== id)] } }));
    this.selectSession(id);
    void this.refreshSessions({ quiet: true });
  }

  /**
   * The registry workspace of the open workspace a worktree can be made from (Create worktree),
   * when the host and the token allow worktrees; else null.
   */
  worktreeForkSource() {
    const { workspace, principal, registry } = this.#state;
    if (!workspace || !this.hasCapability('workspace.worktree') || !this.hasCapability('workspace.registry') || !can(principal ?? undefined, 'workspace.manage')) return null;
    const canonical = principal?.workspaceRoots?.find(root => root.path === workspace)?.canonical;
    return registry.workspaces.find(row => !row.managedWorktree && !row.archivedAt && (row.directory === workspace || row.directory === canonical)) ?? null;
  }

  /**
   * A fork into a new managed worktree: the worktree first (workspace.worktree.create, as Create
   * worktree does; a retry under the same request id reuses it), then session.fork with its
   * workspaceId. The worktree is a clean checkout of the committed HEAD: no file of this workspace
   * is copied, and the conversation's past files are not restored.
   * `worktreeKey` names the worktree for the whole attempt (the dialog): a fork refused after its
   * worktree was made forks into that one next time, rather than making another.
   * @param {{ requestId: string, worktreeKey?: string, mappingId: string, boundary?: { throughTurnId: string } | { beforeTurnId: string }, branchId?: string, title?: string }} input
   */
  async forkIntoWorktree({ requestId, worktreeKey = requestId, mappingId, boundary, branchId, title }) {
    const source = this.worktreeForkSource();
    if (!source) throw new ConfigurationError('Worktrees are not available for this workspace.');
    let made = this.#forkWorktrees.get(worktreeKey);
    if (!made) {
      let params = this.#forkWorktreeRequests.get(worktreeKey);
      if (!params) { params = { workspaceId: source.id, mappingId, ifRevision: this.#state.registry.revision, requestId: `${worktreeKey}:worktree` }; this.#forkWorktreeRequests.set(worktreeKey, params); }
      /** @type {import('@anhlp/alp-protocol').RpcMethodMap['workspace.worktree.create']['result']} */
      let created;
      try {
        created = await this.#client().request('workspace.worktree.create', params, { timeoutMs: this.#options.createTimeoutMs });
      } catch (error) {
        if (/** @type {any} */ (error)?.data?.reason === 'stale_revision' || describe(error).sent === 'yes') this.#forkWorktreeRequests.delete(worktreeKey);
        throw error;
      }
      made = { id: created.workspace.id, directory: created.workspace.directory };
      this.#forkWorktrees.set(worktreeKey, made);
      this.#forkWorktreeRequests.delete(worktreeKey);
      await this.refreshRegistry();
    }
    return this.forkConversation({ requestId, boundary, branchId, workspaceId: made.id, directory: made.directory, title });
  }

  /** The worktree destinations of the open workspace (Create worktree's). */
  async worktreeForkDestinations() {
    const source = this.worktreeForkSource();
    return source ? this.worktreeOptions(source.id) : [];
  }

  // ---- prompts, questions, interrupt -------------------------------------------------------

  /** Whether this credential may drive the selected tree (backend authority: the gateway decides). */
  driveBlock() {
    const { principal, tree } = this.#state;
    if (!principal) return 'Not connected.';
    if (!can(principal, 'session.write')) return 'Your access token can view sessions but not send messages.';
    if (!tree) return undefined;
    const allowed = principal.modes;
    if (allowed) {
      const outside = members(tree.projection).find(member => member.session?.mode && !allowed.includes(member.session.mode));
      if (outside) return `Your access token can only drive sessions in ${allowed.join(', ')} mode; this conversation runs in ${outside.session?.mode}.`;
    }
    return undefined;
  }

  /**
   * Reopens a root alpd closed (nobody watched it when idle, or it was restarted), then attaches
   * after its cursor so what reopening emitted is replayed in order.
   * @param {AlpRpcClient} client @param {string} root
   */
  #wake(client, root) {
    return this.#withViewer(client, async () => {
      if (client !== this.#run?.alp?.client || this.#state.selected !== root) return;
      try { await this.#wakeViewer(client, root); }
      finally { this.#sync(); }
    });
  }

  /** @param {AlpRpcClient} client @param {string} root */
  async #wakeViewer(client, root) {
    const tree = this.#ensureTree(root);
    const snapshot = tree.projection.sessions[root];
    const listed = this.#state.sessions.list.find(row => row.id === root);
    const closed = tree.projection.closed[root] || snapshot?.status === 'closed' || (!snapshot && listed?.status === 'closed');
    if (!closed) return;
    const projectRoot = snapshot?.projectRoot ?? listed?.projectRoot ?? this.#state.workspace ?? '';
    const workspace = grantedWorkspace(this.#state.principal ?? undefined, projectRoot)?.path ?? this.#state.workspace ?? projectRoot;
    const mode = snapshot?.mode ?? listed?.mode;
    const operation = { buffer: /** @type {any[]} */ ([]) };
    tree.attaching = operation;
    this.#watching = root;
    try {
      await client.request('session.create', { sessionId: root, spec: { cwd: workspace, ...(mode ? { mode } : {}) }, resume: true, history: 'skip' }, { timeoutMs: this.#options.createTimeoutMs });
      if (client !== this.#run?.alp?.client) return;
      this.#attached = { client, root };
      if (this.hasCapability('session.history') && !this.#older.has(root)) {
        const page = await client.request('session.history', { sessionId: root }, { timeoutMs: this.#options.requestTimeoutMs });
        if (tree.attaching !== operation) return;
        tree.projection = emptyProjection(root);
        for (const item of page.items) tree.projection = project(tree.projection, historyEnvelope(item, root));
        this.#indexProjection(tree.projection);
        tree.projection = { ...tree.projection, cursor: page.tipCursor };
        this.#older.set(root, { generation: page.generation, olderCursor: page.olderCursor, hasOlder: page.hasOlder });
      }
      const after = tree.projection.cursor;
      const page = this.#older.get(root);
      const response = await client.request('session.attach', { sessionId: root, ...(page ? { after, generation: page.generation } : after > 0 ? { after } : {}) }, { timeoutMs: this.#options.requestTimeoutMs });
      if (tree.attaching === operation) {
        tree.attaching = null;
        this.#finishAttach(root, tree, response, operation.buffer);
      }
    } catch (error) {
      if (tree.attaching === operation) tree.attaching = null;
      throw error;
    }
  }

  /**
   * Sends a message to the selected root: a new turn when it is idle, a steer while it runs. It
   * carries a fresh clientMessageId; the host answers it at most once (§10).
   * @param {string} text @param {string | null} [root] the selected root by default
   * @param {import('./attachments.js').ImageAttachment[]} [images] sent inline after the text (t-7679.11)
   * @param {import('./attachments.js').FileAttachment[]} [files] uploaded under this session, then
   *   named by attachment id (#121 J)
   * @param {{ keepRefused?: boolean }} [options] keepRefused: files this session cannot take make a
   *   failed message (Retry, Discard) instead of a throw, for a first message whose session was
   *   only just created (the New session screen has nowhere else to keep it)
   */
  async sendPrompt(text, root = this.#state.selected, images = [], files = [], { keepRefused = false } = {}) {
    const body = String(text ?? '');
    if (!root || (!body.trim() && !images.length && !files.length)) return;
    const blocked = this.driveBlock();
    if (blocked) throw new ConfigurationError(blocked);
    const fitted = fitImages([], images, this.#state.connection.promptImageLimits);
    if (fitted.error) throw new ConfigurationError(fitted.error);
    const refused = files.length ? this.#filesRefusal(root, files) : null;
    if (refused && !keepRefused) throw new ConfigurationError(refused);
    const id = newMessageId();
    /** @type {PendingPrompt} */
    const prompt = { id, rootId: root, text: body, ...(images.length ? { images } : {}), ...(files.length ? { files: files.map(file => ({ ...file, received: 0, error: undefined })), uploadKey: id } : {}), delivery: this.rootBusy(root) ? 'steer' : 'auto', status: 'sending', retrySameId: true, at: Date.now() };
    this.clearAttention(root);
    if (refused) {
      // Kept as a message that failed before it left, as any other: Retry checks again.
      this.#set(state => ({ prompts: [...state.prompts, { ...prompt, status: 'failed', error: refused }] }));
      this.#awaitTurn(prompt);
      return;
    }
    this.#set(state => ({ prompts: [...state.prompts, prompt] }));
    this.#awaitTurn(prompt);
    await this.#deliverInTurn(prompt);
  }

  /**
   * Why files cannot go with a message to `root` (or a session not created yet, when null), or
   * null: the host's capability, the token's grant, the connection's limits and the runtime of
   * the root (its snapshot's promptAttachments), as fileRefusal says.
   * @param {string | null} [root]
   */
  fileGate(root = this.#state.selected) {
    const { connection, principal } = this.#state;
    const snapshot = root ? (this.#trees.get(root)?.projection.sessions[root] ?? this.#state.sessions.list.find(row => row.id === root)) : undefined;
    return fileRefusal({
      capable: connection.capabilities.includes('attachments'),
      permitted: can(principal ?? undefined, 'attachments.write'),
      writable: can(principal ?? undefined, 'session.write'),
      limits: connection.attachmentLimits,
      session: /** @type {any} */ (snapshot),
      known: !!root,
    });
  }

  /** fileGate, then the limits for these files. @param {string} root @param {ReadonlyArray<import('./attachments.js').FileAttachment>} files */
  #filesRefusal(root, files) {
    return this.fileGate(root) ?? fitFiles([], files, this.#state.connection.attachmentLimits ?? NO_FILES).error;
  }

  /**
   * Uploads the files of a message that are not uploaded yet, one after another, under the
   * message's session; each upload's requestId is the message's and the file's (uploadRequestId),
   * so a repeat continues what the host holds and a committed file answers its attachment. The
   * message's entry shows each file's progress. Answers the files with their attachment ids.
   * Stops once the message is discarded (no further file is begun; a running one stops after its
   * chunk), throwing DiscardedError.
   * @param {AlpRpcClient} client @param {PendingPrompt} prompt
   */
  #upload(client, prompt) {
    const running = this.#uploadFiles(client, prompt);
    this.#uploading.set(prompt.id, running);
    const settled = () => { if (this.#uploading.get(prompt.id) === running) this.#uploading.delete(prompt.id); };
    running.then(settled, settled);
    return running;
  }

  /** The upload of each message whose files are being uploaded now, by its id. @type {Map<string, Promise<unknown>>} */
  #uploading = new Map();

  /** Whether a message is still pending (not discarded nor done). @param {string} id */
  #pending(id) { return this.#state.prompts.some(entry => entry.id === id); }

  /** @param {AlpRpcClient} client @param {PendingPrompt} prompt */
  async #uploadFiles(client, prompt) {
    const files = prompt.files ?? [];
    const key = prompt.uploadKey ?? prompt.id;
    const limits = this.#state.connection.attachmentLimits ?? NO_FILES;
    /** @param {number} slot @param {Partial<import('./attachments.js').FileAttachment>} change */
    const mark = (slot, change) => this.#set(state => ({ prompts: state.prompts.map(entry => entry.id === prompt.id && entry.files ? { ...entry, files: entry.files.map((file, index) => index === slot ? { ...file, ...change } : file) } : entry) }));
    const api = attachmentApi(client);
    const done = [...files];
    for (const [slot, file] of files.entries()) {
      if (file.attachmentId) continue;
      if (!this.#pending(prompt.id)) throw new DiscardedError();
      mark(slot, { error: undefined, received: file.received ?? 0, started: true });
      try {
        const attachment = await api.upload({
          sessionId: prompt.rootId, name: file.name, mimeType: file.mimeType, data: file.data,
          requestId: uploadRequestId(key, slot, file.attempt), maxChunkBytes: limits.maxChunkBytes,
          onProgress: received => {
            // Thrown out of the SDK's chunk loop: a discarded message's upload goes no further.
            if (!this.#pending(prompt.id)) throw new DiscardedError();
            mark(slot, { received });
          },
        });
        if (typeof attachment?.attachmentId !== 'string') throw new Error(`The host did not answer an attachment for ${file.name}.`);
        done[slot] = { ...file, attachmentId: attachment.attachmentId, received: file.size, error: undefined };
        mark(slot, { attachmentId: attachment.attachmentId, received: file.size, error: undefined });
      } catch (error) {
        if (error instanceof DiscardedError || !this.#pending(prompt.id)) throw new DiscardedError();
        const failure = describe(error);
        mark(slot, { error: failure.message });
        throw new UploadError(file.name, failure, isAlpClientError(error) && ['closed', 'disconnected', 'send_failed'].includes(error.reason));
      }
    }
    return done;
  }

  /**
   * Messages whose upload a dropped connection interrupted continue by themselves once the
   * connection is back (the same uploads, from what the host holds), at most three times each;
   * nothing of theirs reached the agent yet.
   */
  #resumeUploads() {
    for (const prompt of this.#state.prompts) {
      if (prompt.status !== 'failed' || !prompt.resumeUpload || prompt.resumeUpload > 3) continue;
      void this.retryPrompt(prompt.id, { resume: true }).catch(() => {});
    }
  }

  /**
   * Delivers a message under a new id after the root's previous message of ours got its answer,
   * then as a steer if the root works by then, else as a new turn: the host refuses a second turn
   * while one is active, and a steer before the turn exists.
   * @param {PendingPrompt} prompt
   */
  async #deliverInTurn(prompt) {
    const root = prompt.rootId;
    const before = this.#inflight.get(root);
    const delivered = (async () => {
      if (before) await before.catch(() => {});
      const current = this.#state.prompts.find(entry => entry.id === prompt.id);
      if (!current || current.status !== 'sending') return;
      const delivery = this.rootBusy(root, prompt.id) ? 'steer' : 'auto';
      if (delivery !== current.delivery) this.#set(state => ({ prompts: state.prompts.map(entry => entry.id === prompt.id ? { ...entry, delivery } : entry) }));
      await this.#deliver({ ...current, delivery });
    })();
    this.#inflight.set(root, delivered);
    try { await delivered; } finally { if (this.#inflight.get(root) === delivered) this.#inflight.delete(root); }
  }

  /** The last message of each root still being delivered, so the next one waits for its answer. @type {Map<string, Promise<void>>} */
  #inflight = new Map();

  /**
   * Whether a root is working as far as the composer is concerned: a turn runs, or a message of
   * ours was taken and its turn has not ended yet (prompt.accepted and turn.started may still be
   * on their way), or one is still being sent. `except` leaves one message of ours out.
   * @param {string | null} [root] @param {string} [except]
   */
  rootBusy(root = this.#state.selected, except) {
    if (!root) return false;
    const tree = this.#trees.get(root);
    if (tree && root in tree.projection.running) return true;
    if (this.#stops.has(root)) return true;
    for (const id of this.#stopCandidates.get(root) ?? []) {
      if (id === except) continue;
      const outcome = tree?.projection.prompts[id];
      if (!this.#taken.has(id) && (!outcome || outcome.errorCode === 'outcome_unknown')) return true;
    }
    if (this.#state.prompts.some(prompt => prompt.rootId === root && prompt.id !== except && prompt.status === 'unknown')) return true;
    // Still on its way, no answer yet. One the host answered as taken counts below, with a limit.
    // Messages still waiting behind it in the chain have not gone out and do not count.
    if (this.#state.prompts.some(prompt => prompt.rootId === root && prompt.id !== except && prompt.status === 'sending' && !prompt.accepted && this.#requesting.has(prompt.id))) return true;
    const waits = this.#turnWaits.get(root);
    if (!waits || !tree) return false;
    for (const [id] of waits) {
      if (id === except) continue;
      const outcome = tree.projection.prompts[id];
      if (outcome?.state === 'failed') continue;
      // Taken (its answer or prompt.accepted said so), its turn not over: the host has an active
      // turn even before prompt.accepted or turn.started arrives. A turn never seen starting stops
      // counting after a while, in case its events were lost.
      if (!outcome && !this.#taken.has(id)) continue;
      const unseen = !outcome?.turnId || !tree.projection.turns[outcome.turnId];
      if (unseen && Date.now() - (this.#sentAt.get(id) ?? 0) > this.#busyUnseenMs) continue;
      if (!outcome || !promptTurnOver(tree.projection, id)) return true;
    }
    return false;
  }

  /**
   * Changes the open session's permissions mode (session.configure), within the modes the
   * access token allows; the gateway checks the grant again.
   * @param {string} mode
   */
  async configureMode(mode) {
    const root = this.#state.selected;
    if (!root || !mode) return;
    const allowed = this.#state.principal?.modes;
    const blocked = this.driveBlock() ?? (allowed && !allowed.includes(mode) ? `Your access token can only use ${allowed.join(', ')} mode.` : undefined);
    if (blocked) { this.#notify('error', blocked); return; }
    if (this.#state.busy.mode) return;
    this.#set(state => ({ busy: { ...state.busy, mode: true } }));
    try {
      const result = await this.#client().request('session.configure', { sessionId: root, mode }, { timeoutMs: this.#options.requestTimeoutMs });
      const tree = this.#trees.get(root);
      const next = typeof result?.session?.mode === 'string' ? result.session.mode : mode;
      if (tree) {
        tree.projection = { ...tree.projection, sessions: { ...tree.projection.sessions, [root]: { ...tree.projection.sessions[root], id: root, mode: next } } };
        this.#publishTree(root);
      }
      this.#set(state => ({ sessions: { ...state.sessions, list: state.sessions.list.map(row => row.id === root ? { ...row, mode: next } : row) } }));
    } catch (error) {
      this.#notify('error', describe(error).message);
    } finally {
      this.#set(state => ({ busy: { ...state.busy, mode: false } }));
    }
  }

  /**
   * Whether the open root's model, thinking and team can be changed now (lib/configure.js
   * liveConfigureGate): the host's capability, the root's summary, the token, an idle tree.
   */
  liveConfigure() {
    const { principal, connection, busy: flags } = this.#state;
    const root = this.#state.tree?.rootId;
    const tree = root ? this.#trees.get(root) : undefined;
    const busy = !!root && !!tree && (this.rootBusy(root) || Object.keys(tree.projection.running).length > 0 || Object.keys(tree.projection.questions).length > 0);
    return liveConfigureGate({
      capabilities: connection.capabilities,
      canWrite: can(principal ?? undefined, 'session.write'),
      canTeam: can(principal ?? undefined, 'session.team.write'),
      summary: root ? this.#rootSummary(root) : null,
      closed: !!root && !!tree?.projection.closed[root],
      busy,
      configuring: !!flags.configure || !!flags.mode,
      generation: root ? this.#older.get(root)?.generation ?? null : null,
      online: connection.phase === 'open',
      driveBlock: root ? this.driveBlock() : undefined,
    });
  }

  /**
   * session.configure.preview: what a change of the open root would run it with and whether the host
   * would take it now (reads only). Undefined when the host or the token cannot say.
   * @param {import('./configure.js').LiveChange} [change]
   * @returns {Promise<import('@anhlp/alp-protocol/session').ConfigurePreview | undefined>}
   */
  async previewConfigure(change = {}) {
    const root = this.#state.tree?.rootId;
    if (!root || !this.hasCapability(CONFIGURE_LIVE) || !can(this.#state.principal ?? undefined, 'session.read')) return undefined;
    /** @type {import('@anhlp/alp-protocol').RpcMethodMap['session.configure.preview']['result']} */
    const result = await this.#client().request('session.configure.preview', { sessionId: root, ...change }, { timeoutMs: this.#options.requestTimeoutMs });
    return result?.preview && typeof result.preview === 'object' ? result.preview : undefined;
  }

  /** The request id of a live configure whose answer was lost, kept for the same change only. @type {{ key: string, requestId: string } | undefined} */
  #configureRetry;

  /**
   * Changes the open root's model, thinking or team (session.configure, §12.9): one change at a
   * time, at the idle barrier, with a fresh requestId (the same one again only after a lost answer)
   * and the history generation this view holds. The labels then show what the host answered it runs
   * with; a refusal changes nothing here and a notice says why (a new session when a mismatch is the
   * way on). A team change is previewed first, so a refusal shows before anything restarts.
   * @param {import('./configure.js').LiveChange} change
   */
  async configureLive(change) {
    const root = this.#state.tree?.rootId;
    const asked = Object.fromEntries(Object.entries(change).filter(([key, value]) => ['model', 'thinking', 'team'].includes(key) && typeof value === 'string' && value));
    if (!root || !Object.keys(asked).length) return undefined;
    if (this.#state.busy.configure) return undefined;
    const gate = this.liveConfigure();
    const control = asked.team ? gate.team : asked.model ? gate.model : gate.thinking;
    if (!gate.shown || !control.enabled) { this.#notify('error', control.reason ?? gate.reason ?? 'This change is not available now.'); return undefined; }
    this.#set(state => ({ busy: { ...state.busy, configure: true } }));
    const key = JSON.stringify([root, asked]);
    try {
      if (asked.team) {
        const preview = await this.previewConfigure(asked).catch(() => undefined);
        if (preview && !preview.allowed) {
          const reason = preview.reason ?? 'runtime_unsupported';
          this.#notify('error', CONFIGURE_MESSAGES[reason] ?? preview.message ?? 'The host would not take this change.', NEW_SESSION_REFUSALS.has(reason) ? { action: 'new-session' } : undefined);
          return undefined;
        }
      }
      const { generation, client } = this.#conversationTarget();
      const requestId = this.#configureRetry?.key === key ? this.#configureRetry.requestId : newConversationRequestId();
      this.#configureRetry = undefined;
      /** @type {import('@anhlp/alp-protocol').RpcMethodMap['session.configure']['result']} */
      let result;
      try {
        result = await client.request('session.configure', { sessionId: root, ...asked, requestId, ifGeneration: generation }, { timeoutMs: this.#options.createTimeoutMs });
      } catch (error) {
        const described = describeConfigureError(error);
        if (described.retrySame) this.#configureRetry = { key, requestId };
        this.#conversationRefused(root, error);
        this.#notify('error', described.message, described.newSession ? { action: 'new-session' } : undefined);
        return undefined;
      }
      const configured = result?.configured;
      this.#adoptSummary(configuredSummary(result.session, configured?.effective));
      void this.refreshSessions({ quiet: true });
      if (configured) {
        const label = this.#state.catalog.models.find(row => row.id === `${configured.effective.runtime}:${configured.effective.model}`)?.label;
        this.#notify('info', configuredNotice(configured, effortLabel, label));
      }
      return result;
    } catch (error) {
      this.#notify('error', describeConfigureError(error).message);
      return undefined;
    } finally {
      this.#set(state => ({ busy: { ...state.busy, configure: false } }));
    }
  }

  /** @param {PendingPrompt} prompt */
  async #deliver(prompt) {
    /** @param {Partial<PendingPrompt>} change */
    const update = change => this.#set(state => ({ prompts: state.prompts.map(entry => entry.id === prompt.id ? { ...entry, ...change } : entry) }));
    this.#requesting.add(prompt.id);
    try {
      const client = this.#client();
      // The initial prompt already runs inside create's viewer transaction on a fresh root.
      // Queuing another viewer operation here would wait on that same transaction.
      const creating = this.#creating === prompt.rootId && this.#attached?.client === client && this.#attached.root === prompt.rootId;
      if (!creating && this.#state.selected === prompt.rootId) await this.#wake(client, prompt.rootId);
      const fitted = fitImages([], prompt.images ?? [], this.#state.connection.promptImageLimits);
      if (fitted.error) throw new ConfigurationError(fitted.error);
      let files = prompt.files ?? [];
      if (files.length) {
        // Checked again: the token, the limits or the session's runtime may have changed since.
        const refused = this.#filesRefusal(prompt.rootId, files);
        if (refused) throw new ConfigurationError(refused);
        files = await this.#upload(client, prompt);
        // Discarded while its files were uploading: it is not sent.
        if (!this.#pending(prompt.id)) return;
      }
      if (!this.#pending(prompt.id)) return;
      update({ submitted: true });
      let candidates = this.#stopCandidates.get(prompt.rootId);
      if (!candidates) this.#stopCandidates.set(prompt.rootId, candidates = new Set());
      candidates.add(prompt.id);
      const result = await client.request('session.prompt', { sessionId: prompt.rootId, clientMessageId: prompt.id, delivery: prompt.delivery, content: messageContent(prompt.text, prompt.images, files) }, { timeoutMs: this.#options.requestTimeoutMs });
      if (result?.outcome === 'unknown') {
        update({ status: 'unknown', error: 'The host cannot tell whether the agent took the message.', retrySameId: false });
        return;
      }
      if (result?.outcome === 'failed') {
        this.#refusedStop(prompt.rootId, prompt.id);
        update({ status: 'failed', error: result.error?.message ? `The agent did not take the message: ${result.error.message}` : 'The agent did not take the message.', retrySameId: false });
        return;
      }
      // Accepted: the entry stays until its user message shows in the timeline.
      this.#taken.add(prompt.id);
      this.#recheckBusyLater();
      if (this.#isDelivered(prompt)) this.#dropPrompt(prompt.id);
      else update({ accepted: true });
    } catch (error) {
      // The timeline may already show it (the answer was lost, the message was not): then it is done.
      if (this.#isDelivered(prompt)) return this.#dropPrompt(prompt.id);
      if (error instanceof DiscardedError) return;
      if (error instanceof UploadError) {
        // Nothing reached the agent: the same message may go again. A dropped connection continues
        // the upload by itself once it is back; a refusal waits for the user, with its reason.
        const interrupted = error.dropped;
        const resumes = this.#state.prompts.find(entry => entry.id === prompt.id)?.resumeUpload ?? 0;
        update({ status: 'failed', error: `Could not upload ${error.fileName}: ${error.failure.message}${interrupted ? ' The upload continues when the connection is back.' : ''}`, retrySameId: true, resumeUpload: interrupted ? resumes + 1 : 0 });
        return;
      }
      const failure = describe(error);
      if (prompt.files?.length && (failure.reason === 'attachment_unavailable' || failure.code === 1001)) await this.#forgetLost(prompt, error);
      if (failure.sent === 'no') update({ status: 'failed', error: failure.message, retrySameId: true });
      else if (failure.sent === 'yes' && failure.reason !== 'outcome_unknown') update({ status: 'failed', error: failure.message, retrySameId: false });
      else update({ status: 'unknown', error: failure.message, retrySameId: failure.reason !== 'outcome_unknown' });
    } finally {
      this.#requesting.delete(prompt.id);
      const current = this.#state.prompts.find(entry => entry.id === prompt.id);
      if (current?.status === 'failed') this.#refusedStop(prompt.rootId, prompt.id);
      else this.#pumpStop(prompt.rootId);
    }
  }

  /**
   * After session.prompt was refused because the host no longer has (not_found) or cannot read
   * (attachment_unavailable) a committed file of `prompt`: those files lose their attachment id and
   * get a new attempt (a requestId of their own), so Retry uploads them afresh. attachment_unavailable
   * from alpd itself may name the file (data.attachmentId); through the gateway, which passes only the
   * reason, it means all of them; for not_found, attachment.get
   * tells which are gone (a not_found about something else leaves them as they are).
   * @param {PendingPrompt} prompt @param {unknown} error
   */
  async #forgetLost(prompt, error) {
    const data = /** @type {any} */ (error)?.data;
    // As the entry is now: the upload put the attachment ids there.
    const current = this.#state.prompts.find(entry => entry.id === prompt.id);
    const committed = (current?.files ?? []).filter(file => typeof file.attachmentId === 'string');
    /** @type {Set<string>} */
    let lost;
    if (data?.reason === 'attachment_unavailable') {
      const named = committed.filter(file => file.attachmentId === data?.attachmentId);
      lost = new Set((named.length ? named : committed).map(file => /** @type {string} */ (file.attachmentId)));
    } else {
      let api;
      try { api = attachmentApi(this.#client()); } catch { return; }
      const gone = await Promise.all(committed.map(file => api.get(/** @type {string} */ (file.attachmentId)).then(() => false, caught => describe(caught).code === 1001)));
      lost = new Set(committed.filter((_file, index) => gone[index]).map(file => /** @type {string} */ (file.attachmentId)));
    }
    if (!lost.size) return;
    this.#set(state => ({ prompts: state.prompts.map(entry => entry.id === prompt.id && entry.files ? { ...entry, files: entry.files.map(file => file.attachmentId && lost.has(file.attachmentId) ? { ...file, attachmentId: undefined, received: 0, started: false, attempt: (file.attempt ?? 0) + 1 } : file) } : entry) }));
  }

  /** Messages of ours whose delivery (wake, then session.prompt) has started and not been answered. @type {Set<string>} */
  #requesting = new Set();

  /** @param {PendingPrompt} prompt */
  #isDelivered(prompt) {
    const tree = this.#trees.get(prompt.rootId);
    return !!tree && deliveredPrompts(tree.projection).has(prompt.id);
  }

  /** @param {string} id */
  #dropPrompt(id) { this.#set(state => ({ prompts: state.prompts.filter(entry => entry.id !== id) })); }

  /**
   * Sends a message that failed or whose outcome is unknown again, on the user's say. Under the
   * same clientMessageId and delivery where that is safe (receipts answer a repeat with the first
   * outcome, §10); under a new id when the host said it cannot know (outcome_unknown) or the
   * runtime refused the message.
   * Its files keep the uploads they have (uploadKey stays the first id): a committed one is not
   * uploaded again, an interrupted one continues.
   * @param {string} id @param {{ resume?: boolean }} [options] resume: a reconnect continues an
   *   interrupted upload (the count of such resumes is kept), not the user
   */
  async retryPrompt(id, { resume = false } = {}) {
    const prompt = this.#state.prompts.find(entry => entry.id === id);
    if (!prompt || prompt.status === 'sending') return;
    const resumes = resume ? prompt.resumeUpload : 0;
    /** @type {PendingPrompt} */
    const next = prompt.retrySameId
      ? { ...prompt, status: 'sending', error: undefined, accepted: false, resumeUpload: resumes }
      : { ...prompt, id: newMessageId(), delivery: this.rootBusy(prompt.rootId, prompt.id) ? 'steer' : 'auto', status: 'sending', error: undefined, retrySameId: true, accepted: false, resumeUpload: resumes, ...(prompt.files?.length ? { uploadKey: prompt.uploadKey ?? prompt.id } : {}) };
    this.#set(state => ({ prompts: state.prompts.map(entry => entry.id === id ? next : entry) }));
    // The same id repeats the first request (receipts); a new one is a new message, in turn.
    if (next.id === prompt.id) return this.#deliver(next);
    this.#forget(prompt.rootId, prompt.id);
    this.#awaitTurn(next);
    await this.#deliverInTurn(next);
  }

  /** The bookkeeping of one message of ours. @param {string} root @param {string} id */
  #forget(root, id) {
    this.#turnWaits.get(root)?.delete(id);
    this.#sentAt.delete(id);
    this.#taken.delete(id);
  }

  /**
   * Drops a message the user gave up on; the queue no longer waits for its turn. Its uploads that
   * were begun and not committed are aborted once its running upload stopped (best effort), so
   * they do not hold the host's active-upload slots until they expire; committed objects stay.
   * @param {string} id
   */
  discardPrompt(id) {
    const prompt = this.#state.prompts.find(entry => entry.id === id);
    if (prompt) this.#forget(prompt.rootId, id);
    this.#dropPrompt(id);
    if (prompt) this.#abandonUploads(prompt);
  }

  /** @param {PendingPrompt} prompt as it was when discarded */
  #abandonUploads(prompt) {
    const begun = (prompt.files ?? []).map((file, slot) => ({ file, slot })).filter(({ file }) => file.started && !file.attachmentId);
    if (!begun.length) return;
    const key = prompt.uploadKey ?? prompt.id;
    const running = this.#uploading.get(prompt.id) ?? Promise.resolve();
    this.#abandoning = this.#abandoning.then(() => running.catch(() => {})).then(async () => {
      let client;
      try { client = this.#client(); } catch { return; }
      const api = attachmentApi(client);
      for (const { file, slot } of begun) await abortUpload(api, { sessionId: prompt.rootId, file, requestId: uploadRequestId(key, slot, file.attempt), digest: sha256Hex });
    });
  }

  /** The aborts of discarded messages' uploads, one after another (tests wait on it). @type {Promise<void>} */
  #abandoning = Promise.resolve();

  /** Settles once the uploads of messages discarded so far were aborted (or could not be). */
  abandonedUploads() { return this.#abandoning; }

  /**
   * Messages of ours whose turn is not known to be over, per root, with the tree's reset count
   * when sent. The pending entry of a message goes as soon as its user message shows, before its
   * turn starts (events and answers arrive in separate tasks, in any order, §8.2), so the queue
   * waits on these instead: on prompt.accepted's turn ending, or on prompt.failed.
   * @type {Map<string, Map<string, number>>}
   */
  #turnWaits = new Map();

  /** @param {PendingPrompt} prompt */
  #awaitTurn(prompt) {
    let waits = this.#turnWaits.get(prompt.rootId);
    if (!waits) this.#turnWaits.set(prompt.rootId, waits = new Map());
    waits.set(prompt.id, this.#trees.get(prompt.rootId)?.projection.reset ?? 0);
    this.#sentAt.set(prompt.id, Date.now());
  }

  /** When each message of ours was sent, for rootBusy. @type {Map<string, number>} */
  #sentAt = new Map();
  /** Messages of ours the host answered as taken, for rootBusy. @type {Set<string>} */
  #taken = new Set();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  #busyTimer;
  get #busyUnseenMs() { return this.#options.busyUnseenMs; }

  /** Views read rootBusy when they render; once a taken message stops counting, render again. */
  #recheckBusyLater() {
    if (this.#busyTimer !== undefined) clearTimeout(this.#busyTimer);
    this.#busyTimer = setTimeout(() => {
      this.#busyTimer = undefined;
      if (this.#run) this.#set(state => ({ busy: { ...state.busy } }));
    }, this.#busyUnseenMs + 100);
  }

  /**
   * Whether a queued message may start now: no message of ours on this root still has a turn
   * running or yet to start. After a reset that left no history, a message sent before it cannot
   * be traced; an idle root is then the last word.
   * @param {string} root @param {Projection} projection
   */
  #turnsSettled(root, projection) {
    const waits = this.#turnWaits.get(root);
    if (!waits) return true;
    for (const [id, reset] of waits) {
      const untraceable = projection.historyUnavailable && projection.reset > reset && Object.keys(projection.running).length === 0;
      if (promptTurnOver(projection, id) || untraceable) { waits.delete(id); this.#sentAt.delete(id); this.#taken.delete(id); }
    }
    return waits.size === 0;
  }

  // ---- the queue (Paseo's: Cmd/Ctrl+Enter while the agent works) ---------------------------

  /** Holds a message for the selected root until it is idle. @param {string} text */
  queuePrompt(text) {
    const root = this.#state.selected;
    const body = String(text ?? '');
    if (!root || !body.trim()) return;
    const blocked = this.driveBlock();
    if (blocked) throw new ConfigurationError(blocked);
    this.#set(state => ({ queued: [...state.queued, { id: newMessageId(), rootId: root, text: body }] }));
  }

  /** Takes a queued message back out, for the composer to edit. @param {string} id @returns {string | null} */
  editQueued(id) {
    const entry = this.#state.queued.find(item => item.id === id);
    if (!entry) return null;
    this.#set(state => ({ queued: state.queued.filter(item => item.id !== id) }));
    return entry.text;
  }

  /** Sends a queued message now: steered into the running turn, or a new turn when idle. @param {string} id */
  async sendQueuedNow(id) {
    const entry = this.#state.queued.find(item => item.id === id);
    if (!entry || entry.rootId !== this.#state.selected) return;
    this.#set(state => ({ queued: state.queued.filter(item => item.id !== id) }));
    await this.sendPrompt(entry.text);
  }

  #drainScheduled = false;
  #scheduleDrain() {
    if (this.#drainScheduled) return;
    this.#drainScheduled = true;
    queueMicrotask(() => { this.#drainScheduled = false; this.#drain(); });
  }

  /**
   * Sends the next queued message of the selected root once that root is idle on an open
   * connection with no message of its own still in flight or unresolved; one at a time, each
   * under a new clientMessageId. A message that fails stays in the timeline for the user, and
   * the queue waits behind it.
   */
  #drain() {
    const { selected: root, tree, connection, prompts, queued } = this.#state;
    if (!root || connection.phase !== 'open' || !tree || tree.rootId !== root || tree.status !== 'attached') return;
    if (root in tree.projection.running || prompts.some(prompt => prompt.rootId === root)) return;
    if (!this.#turnsSettled(root, tree.projection)) return;
    if (this.driveBlock()) return;
    const next = queued.find(item => item.rootId === root);
    if (next) this.sendQueuedNow(next.id).catch(() => {});
  }

  /** Submitted identities kept until an explicit outcome, independently of queue idle heuristics. @type {Map<string, Set<string>>} */
  #stopCandidates = new Map();

  /** Stop intents survive request timeouts and reconnects; each keeps the identity captured at click. */
  /** @type {Map<string, StopIntent>} */
  #stops = new Map();

  /** Stops only the selected turn, or the turn belonging to the message still on its way. */
  async interrupt() {
    const root = this.#state.selected;
    if (!root) return;
    const existing = this.#stops.get(root);
    if (existing) {
      existing.attempts = 0;
      existing.exhausted = false;
      if (existing.observer?.state === 'stopped') this.#observeStop(root, existing);
      this.#pumpStop(root);
      return existing.promise;
    }
    if (!this.hasCapability('session.interrupt.turn')) {
      this.#notify('error', 'This host cannot safely stop a specific turn. Upgrade the host to use Stop.');
      return;
    }
    const projection = this.#trees.get(root)?.projection;
    const turnId = projection?.running[root];
    // A timed-out delivery is still a target: absence of a running turn proves nothing about it.
    const messageId = !turnId ? [...new Set([...(this.#stopCandidates.get(root) ?? []), ...this.#state.prompts.filter(prompt => prompt.rootId === root && prompt.status !== 'failed').map(prompt => prompt.id)])].find(id => {
      const outcome = projection?.prompts[id];
      return !outcome || (outcome.state === 'failed' && outcome.errorCode === 'outcome_unknown')
        || (outcome.state === 'accepted' && (!outcome.turnId || projection?.turns[outcome.turnId] !== 'ended'));
    }) : undefined;
    if (!turnId && !messageId) return;
    const pending = this.#state.prompts.find(prompt => prompt.id === messageId);
    if (pending && !pending.submitted) {
      this.discardPrompt(pending.id);
      this.#notify('info', 'Message canceled before sending.');
      return;
    }
    let done = () => {};
    const promise = new Promise(resolve => { done = () => resolve(undefined); });
    const intent = { ...(turnId ? { turnId } : { messageId }), done, promise };
    this.#stops.set(root, intent);
    this.#observeStop(root, intent);
    this.#set(state => ({ busy: { ...state.busy, interrupt: true } }));
    if (!turnId) this.#notify('info', STOP_WAITING);
    this.#pumpStop(root);
    return promise;
  }

  /**
   * A read-only attachment owned by this Stop, independent of the selected tree and workspace.
   * Its connection carries one root only; child envelopes cannot enter the selected projection.
   * @param {string} root @param {StopIntent} intent
   */
  #observeStop(root, intent) {
    const run = this.#run;
    const principal = this.#state.principal?.id;
    const { open, backoff, stableMs, requestTimeoutMs } = this.#options;
    const gateway = this.#state.connection.gateway;
    const token = this.#token;
    let buffer = /** @type {any[] | null} */ (null);
    let opened = false;
    intent.observed ??= this.#trees.get(root)?.projection ?? emptyProjection(root);
    const current = () => this.#run === run && this.#stops.get(root) === intent;
    const observer = createReconnectingClient({
      connect: async ({ signal }) => {
        const link = await open({ url: gateway, token, signal: /** @type {AbortSignal} */ (signal) });
        if (!current()) { link.transport.close(); throw new ConfigurationError('This Stop is no longer waiting.'); }
        if (link.principal.id !== principal || !can(link.principal, 'session.read') || !can(link.principal, 'session.write')) {
          link.transport.close();
          throw new AuthenticationError('Stop access changed. Reconnect with the original access before trying again.');
        }
        return link.transport;
      },
      onConnect: async (client, { signal }) => {
        const greeting = await hello(client, CLIENT, { signal, timeoutMs: requestTimeoutMs });
        const capabilities = Array.isArray(greeting.capabilities) ? greeting.capabilities : [];
        if (!capabilities.includes('session.interrupt.turn') || !capabilities.includes('attach.after')) throw new ConfigurationError('This host cannot safely observe and stop a specific turn.');
        buffer = [];
        // No wake or create: attachment is authoritative scope validation and starts no work.
        const response = await client.request('session.attach', { sessionId: root, after: intent.observed?.cursor ?? 0 }, { signal, timeoutMs: requestTimeoutMs });
        if (!current()) return;
        intent.observed = applyAttach(intent.observed ?? emptyProjection(root), response, buffer);
        intent.observed = { ...intent.observed, cursor: Math.max(intent.observed.cursor, response.cursor ?? 0) };
        buffer = null;
        this.#pumpStop(root);
      },
      onDisconnect: () => { buffer = null; },
      shouldRetry: error => !describe(error).terminal && !endsRoot(error),
      backoff, stableMs, client: { timeoutMs: requestTimeoutMs },
    });
    intent.observer = observer;
    observer.onEvent(envelope => {
      if (!current() || envelope.sessionId !== root) return;
      if (buffer) { buffer.push(envelope); return; }
      intent.observed = project(intent.observed ?? emptyProjection(root), envelope);
      this.#pumpStop(root);
    });
    observer.onState((state, error) => {
      if (!current()) return;
      if (state === 'open') {
        if (opened) { intent.attempts = 0; intent.exhausted = false; }
        opened = true;
        this.#pumpStop(root);
      } else if (state === 'stopped') {
        this.#releaseStopLease(root);
        intent.exhausted = true;
        if (this.#state.selected === root) this.#set(state => ({ busy: { ...state.busy, interrupt: false } }));
        this.#notify('error', `Stop is unresolved: ${describe(error).message}`);
      }
    });
  }

  /** @param {string} root */
  #finishStop(root) {
    const intent = this.#stops.get(root);
    if (!intent) return;
    this.#stops.delete(root);
    this.#releaseStopLease(root);
    clearTimeout(intent.retry);
    intent.observer?.stop();
    intent.done();
    if (this.#state.notice?.text === STOP_WAITING) this.#set({ notice: null });
    if (this.#state.selected === root) this.#set(state => ({ busy: { ...state.busy, interrupt: false } }));
  }

  /** A definitive refusal, as opposed to an unknown delivery outcome. @param {string} root @param {string} id */
  #refusedStop(root, id) {
    this.#stopCandidates.get(root)?.delete(id);
    if (this.#stops.get(root)?.messageId !== id) return;
    this.#notify('info', 'The agent did not take that message. There is no turn to stop.');
    this.#finishStop(root);
  }

  /** Uses replay and live events alike; never treats idle, a user message, or an RPC timeout as proof. @param {string} root */
  #pumpStop(root) {
    const intent = this.#stops.get(root);
    if (!intent) return;
    const cached = this.#trees.get(root)?.projection;
    const projections = [intent.observed, cached].filter((/** @type {Projection | undefined} */ entry) => !!entry).sort((a, b) => (b?.cursor ?? 0) - (a?.cursor ?? 0));
    const outcome = intent.messageId ? projections.map(entry => entry?.prompts[/** @type {string} */ (intent.messageId)]).find(Boolean) : undefined;
    if (outcome?.state === 'failed' && outcome.errorCode !== 'outcome_unknown') {
      this.#refusedStop(root, /** @type {string} */ (intent.messageId));
      return;
    }
    if (!intent.turnId && outcome?.state === 'accepted' && outcome.turnId) intent.turnId = outcome.turnId;
    if (intent.turnId && projections.some(entry => entry?.turns[/** @type {string} */ (intent.turnId)] === 'ended')) { this.#finishStop(root); return; }
    const observerClient = intent.observer?.state === 'open' ? intent.observer.client : undefined;
    const client = observerClient ?? (this.#state.connection.phase === 'open' ? this.#run?.alp?.client : undefined);
    if (!intent.turnId || intent.sending || intent.exhausted || intent.observer?.state === 'stopped' || !client) return;
    if (!observerClient && !this.hasCapability('session.interrupt.turn')) {
      if (!intent.warned) { intent.warned = true; this.#notify('error', 'Stop is still waiting: this host cannot safely stop a specific turn.'); }
      return;
    }
    clearTimeout(intent.retry);
    intent.sending = true;
    intent.attempts = (intent.attempts ?? 0) + 1;
    if (this.#state.selected === root) this.#set(state => ({ busy: { ...state.busy, interrupt: true } }));
    void client.request('session.interrupt', { sessionId: root, turnId: intent.turnId }, { timeoutMs: this.#options.requestTimeoutMs }).then(result => {
      // Both answers resolve this exact target. A false answer changes no later turn.
      if (this.#stops.get(root) === intent && typeof result?.interrupted === 'boolean') this.#finishStop(root);
    }, error => {
      if (this.#stops.get(root) !== intent) return;
      this.#notify('error', `Stop is still waiting for this turn's outcome: ${describe(error).message}`);
    }).finally(() => {
      intent.sending = false;
      if (this.#stops.get(root) !== intent) return;
      // Retrying a conditional request is safe even when the previous answer was lost. Bound
      // automatic attempts; then re-enable Stop so the user can retry the same retained target.
      if ((intent.attempts ?? 0) < 3) intent.retry = setTimeout(() => this.#pumpStop(root), 250);
      else {
        intent.exhausted = true;
        if (this.#state.selected === root) this.#set(state => ({ busy: { ...state.busy, interrupt: false } }));
        this.#notify('error', 'Stop is unresolved. Try Stop again to check this same turn.');
      }
    });
  }

  /**
   * Answers an agent's question, or dismisses it (the agent hears it was declined).
   * @param {string} questionId @param {{ text?: string, dismiss?: boolean }} answer
   */
  async answerQuestion(questionId, { text, dismiss = false }) {
    const key = `question:${questionId}`;
    this.#set(state => ({ busy: { ...state.busy, [key]: true } }));
    try {
      await this.#client().request('question.answer', dismiss ? { questionId, dismiss: true, reason: 'Declined in ALP web' } : { questionId, text: String(text ?? '') });
      const root = this.#state.selected;
      const tree = root ? this.#trees.get(root) : undefined;
      if (tree && root && tree.projection.questions[questionId]) {
        const questions = { ...tree.projection.questions };
        delete questions[questionId];
        tree.projection = { ...tree.projection, questions };
        this.#publishTree(root);
      }
      void this.refreshAttention();
    } catch (error) {
      const failure = describe(error);
      // Gone (answered elsewhere, timed out): the host's next announcement is the truth.
      this.#notify('error', failure.code === 1001 ? 'That question is no longer waiting for an answer.' : failure.message);
    } finally {
      this.#set(state => ({ busy: { ...state.busy, [key]: false } }));
    }
  }

  // ---- tasks -------------------------------------------------------------------------------

  /** @param {boolean} visible */
  /**
   * Counts the views that show tasks (the Tasks list, a task tab); polling runs while any does.
   * @param {boolean} visible
   */
  setTasksVisible(visible) {
    this.#taskViews = Math.max(0, this.#taskViews + (visible ? 1 : -1));
    const next = this.#taskViews > 0;
    if (this.#state.tasks.visible === next) return;
    this.#set(state => ({ tasks: { ...state.tasks, visible: next } }));
    if (next) void this.refreshTasks();
  }

  #taskViews = 0;

  tasksBlock() {
    const { principal } = this.#state;
    if (!principal) return 'Not connected.';
    if (!this.hasCapability('task')) return 'This host does not offer tasks.';
    if (!can(principal, 'project.read')) return 'Your access token cannot read this workspace\'s tasks.';
    return undefined;
  }

  /** Reads task.list; polling skips the update when the revision did not change. @param {{ quiet?: boolean }} [options] */
  async refreshTasks({ quiet = false } = {}) {
    const workspace = this.#state.workspace;
    if (!workspace || this.tasksBlock()) return;
    const context = this.#context;
    if (!quiet) this.#set(state => ({ tasks: { ...state.tasks, status: state.tasks.rows.length ? state.tasks.status : 'loading', error: undefined } }));
    try {
      const result = await this.#client().request('task.list', { projectRoot: workspace });
      if (context !== this.#context) return;
      if (quiet && result?.revision && result.revision === this.#state.tasks.revision) return;
      const rows = Array.isArray(result?.tasks) ? result.tasks : [];
      this.#set(state => ({ tasks: { ...state.tasks, status: 'ready', rows, revision: result?.revision, unreadable: Array.isArray(result?.unreadable) ? result.unreadable.length : 0, error: undefined, creates: this.#reconcileCreates(state.tasks.creates, rows) } }));
    } catch (error) {
      if (context !== this.#context) return;
      if (!quiet || this.#state.tasks.status !== 'ready') this.#set(state => ({ tasks: { ...state.tasks, status: 'error', error: describe(error) } }));
    }
  }

  /** Unknown creates name a matching task the list now shows, so the user can decide. @param {TaskCreate[]} creates @param {any[]} rows */
  #reconcileCreates(creates, rows) {
    return creates.map(create => {
      if (create.status !== 'unknown') return create;
      const match = rows.find(row => row.title === create.title && row.status !== 'closed');
      return match ? { ...create, match: match.id } : { ...create, match: undefined };
    });
  }

  /**
   * Creates a task with a fresh requestId. When the outcome is unknown the list is read again
   * and the user decides; nothing is sent again by itself (§10: dedupe holds within one alpd
   * process only).
   * @param {{ title: string, priority?: number }} input
   */
  async createTask({ title, priority = 2 }) {
    const workspace = this.#state.workspace;
    const clean = String(title ?? '').trim();
    if (!workspace || !clean) return;
    /** @type {TaskCreate} */
    const create = { requestId: newRequestId(), title: clean, priority, status: 'creating' };
    this.#set(state => ({ tasks: { ...state.tasks, creates: [...state.tasks.creates, create], message: undefined } }));
    await this.#sendCreate(create);
  }

  /** @param {TaskCreate} create */
  async #sendCreate(create) {
    const workspace = this.#state.workspace;
    const context = this.#context;
    /** @param {Partial<TaskCreate> | null} change */
    const update = change => this.#set(state => ({ tasks: { ...state.tasks, creates: change ? state.tasks.creates.map(entry => entry.requestId === create.requestId ? { ...entry, ...change } : entry) : state.tasks.creates.filter(entry => entry.requestId !== create.requestId) } }));
    try {
      const result = await this.#client().request('task.create', { projectRoot: workspace, title: create.title, priority: create.priority, requestId: create.requestId });
      if (context !== this.#context) return;
      update(null);
      this.#set(state => ({ tasks: { ...state.tasks, message: { level: 'info', text: result?.duplicate ? `Task ${result.id} already existed for this request.` : `Created task ${result?.id ?? ''}.` } } }));
      await this.refreshTasks({ quiet: false });
    } catch (error) {
      if (context !== this.#context) return;
      const failure = describe(error);
      if (failure.sent === 'unknown' || failure.code === 1000) {
        update({ status: 'unknown', error: `${failure.message} The list was read again: check it before creating this task again.` });
        await this.refreshTasks();
      } else {
        update({ status: 'failed', error: failure.message });
      }
    }
  }

  /** Sends a create that failed or is unknown again, when the user asks, with the same requestId. @param {string} requestId */
  async retryTaskCreate(requestId) {
    const create = this.#state.tasks.creates.find(entry => entry.requestId === requestId);
    if (!create || create.status === 'creating') return;
    const next = { ...create, status: /** @type {const} */ ('creating'), error: undefined, match: undefined };
    this.#set(state => ({ tasks: { ...state.tasks, creates: state.tasks.creates.map(entry => entry.requestId === requestId ? next : entry) } }));
    await this.#sendCreate(next);
  }

  /** @param {string} requestId */
  dismissTaskCreate(requestId) {
    this.#set(state => ({ tasks: { ...state.tasks, creates: state.tasks.creates.filter(entry => entry.requestId !== requestId) } }));
  }

  /**
   * Closes or reopens a task, or approves a human gate, guarded by the row's revision (ifRev):
   * a repeat or a stale view fails instead of changing something else.
   * @param {any} row @param {{ action: 'close' | 'reopen' } | { gate: string }} change
   */
  async changeTask(row, change) {
    const workspace = this.#state.workspace;
    if (!workspace || !row?.id) return;
    const context = this.#context;
    this.#set(state => ({ tasks: { ...state.tasks, busy: { ...state.tasks.busy, [row.id]: true }, message: undefined } }));
    try {
      const client = this.#client();
      if ('gate' in change) await client.request('task.gate.resolve', { projectRoot: workspace, id: row.id, gate: change.gate, ifRev: row.rev });
      else await client.request('task.update', { projectRoot: workspace, id: row.id, action: change.action, ...(change.action === 'close' ? { note: 'Closed in ALP web' } : {}), ifRev: row.rev });
    } catch (error) {
      if (context !== this.#context) return;
      const failure = describe(error);
      this.#set(state => ({ tasks: { ...state.tasks, message: { level: 'error', text: failure.sent === 'unknown' ? `${failure.message} The list was read again.` : failure.message } } }));
    } finally {
      if (context === this.#context) {
        this.#set(state => ({ tasks: { ...state.tasks, busy: { ...state.tasks.busy, [row.id]: false } } }));
        await this.refreshTasks();
      }
    }
  }

  // ---- settings ----------------------------------------------------------------------------

  /**
   * What Enter does while the agent works (Paseo's Sending setting): steer the running turn, or
   * queue; Cmd/Ctrl+Enter does the other. Kept for this tab only.
   * @param {'steer' | 'queue'} sendBehavior
   */
  setSendBehavior(sendBehavior) {
    this.#setPreferences({ sendBehavior });
  }

  /** Paseo's Appearance › Theme: light, dark, or the system's. @param {'system' | 'light' | 'dark'} theme */
  setTheme(theme) {
    this.#setPreferences({ theme });
  }

  /** @param {Partial<import('./preferences.js').Preferences>} change */
  #setPreferences(change) {
    // Validated as stored, so state and storage hold the same thing.
    const preferences = parsePreferences(JSON.stringify({ ...this.#state.preferences, ...change, v: 1 }));
    this.#set({ preferences });
    savePreferences(this.#options.storage, preferences);
  }

  /** The New session choices that started a session, for the next one (as Paseo's form preferences). @param {{ team?: string, mode?: string, model?: string, thinking?: string }} used */
  #rememberNewSession(used) {
    this.#setPreferences({ newSession: rememberChoices(this.#state.preferences.newSession, used) });
  }

  /** Back to the defaults, in state and storage (Paseo's reset settings). */
  resetPreferences() {
    this.#setPreferences(parsePreferences(null));
  }

  /** Reads the preferences again, after another tab changed them (the page's storage event). */
  reloadPreferences() {
    const preferences = loadPreferences(this.#options.storage);
    if (JSON.stringify(preferences) !== JSON.stringify(this.#state.preferences)) this.#set({ preferences });
  }

  /** Why session.preview cannot be asked here, if it cannot. */
  previewBlock() {
    const { principal, workspace } = this.#state;
    if (!principal) return 'Not connected.';
    if (!can(principal, 'session.read')) return 'Your access token cannot read sessions, so the host cannot say what would run.';
    if (!workspace) return 'Choose a workspace first.';
    return undefined;
  }

  /**
   * What a new session with this spec would run (session.preview: team, main agent, runtime,
   * model, mode, thinking), without starting it. The spec's cwd is the workspace.
   * @param {Record<string, unknown>} spec @param {{ signal?: AbortSignal }} [options]
   * @returns {Promise<import('./new-session.js').Preview>}
   */
  async previewSession(spec, { signal } = {}) {
    const blocked = this.previewBlock();
    if (blocked) throw new ConfigurationError(blocked);
    const result = await this.#client().request('session.preview', { spec: { ...spec, cwd: this.#state.workspace } }, { timeoutMs: this.#options.requestTimeoutMs, ...(signal ? { signal } : {}) });
    const preview = parsePreview(result);
    if (!preview) throw new ConfigurationError('The host answered the preview in a form this app does not read.');
    return preview;
  }

  /** Why the library cannot be listed here, if it cannot. */
  libraryBlock() {
    const { principal, workspace } = this.#state;
    if (!principal) return 'Not connected.';
    if (!this.hasCapability('library')) return 'This host does not offer its library.';
    if (!can(principal, 'project.read')) return 'Your access token cannot read this workspace\'s configuration.';
    if (!workspace) return 'Choose a workspace first.';
    return undefined;
  }

  /**
   * Names, sources and descriptions of one kind of library entry, as the selected workspace sees
   * them (library.list). Content is read one entry at a time with getLibraryEntry.
   * @param {'agents' | 'skills' | 'mcp' | 'hooks' | 'teams' | 'providers'} kind
   * @returns {Promise<Array<{ name: string, source: string, overrides?: string, description?: string, usedBy?: string[] }>>}
   */
  async listLibrary(kind) {
    const blocked = this.libraryBlock();
    if (blocked) throw new ConfigurationError(blocked);
    const result = await this.#client().request('library.list', { kind, projectRoot: this.#state.workspace }, { timeoutMs: this.#options.requestTimeoutMs });
    return (Array.isArray(result?.entries) ? result.entries : []).filter((/** @type {any} */ entry) => entry && typeof entry.name === 'string');
  }

  /**
   * One library entry as the selected workspace's sessions would use it (library.get), read only.
   * The gateway answers its content with `{ $secret: 'keep' }` in place of every value that can
   * hold a secret, and `secrets` lists where; this app shows those as hidden and never edits.
   * @param {'agents' | 'skills' | 'mcp' | 'hooks' | 'teams' | 'providers'} kind @param {string} name
   * @returns {Promise<{ kind: string, name: string, source: string, overrides?: string, content: Record<string, unknown>, revision?: string | null, usedBy: string[], librarySkills?: string[], secrets: string[] }>}
   */
  async getLibraryEntry(kind, name) {
    const blocked = this.libraryBlock();
    if (blocked) throw new ConfigurationError(blocked);
    const result = await this.#client().request('library.get', { kind, name, projectRoot: this.#state.workspace }, { timeoutMs: this.#options.requestTimeoutMs });
    if (!result || typeof result !== 'object' || !result.content || typeof result.content !== 'object' || Array.isArray(result.content)) throw new ConfigurationError('The host answered library.get in a form this app does not read.');
    const strings = (/** @type {unknown} */ value) => Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
    return {
      kind: typeof result.kind === 'string' ? result.kind : kind,
      name: typeof result.name === 'string' ? result.name : name,
      source: typeof result.source === 'string' ? result.source : 'unknown',
      ...(typeof result.overrides === 'string' ? { overrides: result.overrides } : {}),
      content: result.content,
      ...(typeof result.revision === 'string' || result.revision === null ? { revision: result.revision } : {}),
      usedBy: strings(result.usedBy),
      ...(Array.isArray(result.librarySkills) ? { librarySkills: strings(result.librarySkills) } : {}),
      secrets: strings(result.secrets),
    };
  }

  /** Why project instruction editing is unavailable. @param {string} kind */
  libraryWriteBlock(kind) {
    const blocked = this.libraryBlock();
    if (blocked) return blocked;
    if (!can(this.#state.principal ?? undefined, 'library.write')) return 'This token does not grant library.write.';
    if (!this.hasCapability('library.project.write')) return 'Update the host to support safe project instruction editing.';
    if (!['agents', 'skills'].includes(kind)) return 'Executable and administrative configuration is edited on the host.';
    return null;
  }

  /** Project-only instruction mutations; the gateway and daemon enforce the content policy.
   * @param {'save'|'delete'|'duplicate'|'rename'} action @param {string} kind @param {Record<string, unknown>} params */
  async writeLibrary(action, kind, params) {
    const blocked = this.libraryWriteBlock(kind);
    if (blocked) throw new ConfigurationError(blocked);
    return this.#client().request(`library.${action}`, { ...params, kind, scope: 'project', projectRoot: this.#state.workspace }, { timeoutMs: this.#options.requestTimeoutMs });
  }

  async loadSettings() {
    const principal = this.#state.principal;
    if (!principal) return;
    const context = this.#context;
    this.#set(state => ({ settings: { ...state.settings, status: 'loading', error: undefined } }));
    try {
      const client = this.#client();
      const [language, models] = await Promise.all([
        this.hasCapability('settings.language') && can(principal, 'session.read') ? client.request('settings.language.get', {}).catch(() => undefined) : undefined,
        this.hasCapability('library') && can(principal, 'session.read') ? client.request('library.models', {}).catch(() => undefined) : undefined,
      ]);
      if (context !== this.#context) return;
      this.#set({ settings: {
        status: 'ready',
        ...(language && typeof language.applies === 'string' ? { language } : {}),
        models: normalizeModels(models?.models),
      } });
    } catch (error) {
      if (context !== this.#context) return;
      this.#set(state => ({ settings: { ...state.settings, status: 'error', error: describe(error) } }));
    }
  }
}
