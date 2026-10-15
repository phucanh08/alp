// @ts-check
import { CAPABILITY, ERROR, RPC_METHODS } from '@anhlp/alp-protocol';

/**
 * What the gateway lets a remote client call (docs/alp/remote-gateway.md §5): the method
 * exposure matrix as data. Default deny: a method with no `exposed` entry here answers -32601,
 * also when alpd implements it and lists its capability. A capability says what alpd can do,
 * never what a remote principal may do.
 *
 * Each exposed method names the permission it needs, the resource its scope check reads, the
 * params forwarded to alpd (others are dropped: alpd ignores unknown params in v1, and a later
 * meaning must not reach it unreviewed) and the gateway tests that cover its authorization
 * (apps/gateway/tests/authorization.test.js asserts each exposed method has them).
 */

/**
 * Permissions a remote credential can hold: sessions, and a project's other resources (tasks,
 * teams, project library entries). A write permission implies its read. Host administration has
 * no remote permission in v1.
 */
export const PERMISSIONS = Object.freeze(['session.read', 'session.write', 'project.read', 'project.write']);

/**
 * Daemon capabilities the gateway passes on when alpd lists them; never `extension.methods`.
 * Within `library` and `settings.language` some methods stay unexposed and answer -32601
 * `not_exposed` (docs/alp/remote-gateway.md §5.4).
 */
export const FORWARDED_CAPABILITIES = Object.freeze([CAPABILITY.attachAfter, CAPABILITY.promptReceipts, CAPABILITY.task, CAPABILITY.team, CAPABILITY.library, CAPABILITY.settingsLanguage]);

/** The codes of docs/protocol/alp-json-rpc-v1.md §5.1 the gateway answers its own refusals with; `data.reason` says why. */
export const GATEWAY_ERROR = Object.freeze({ forbidden: ERROR.forbidden, unavailable: ERROR.unavailable });

/** `data.reason` values the gateway sets. */
export const GATEWAY_REASON = Object.freeze({
  notExposed: 'not_exposed',
  grant: 'grant',
  outsideWorkspace: 'outside_workspace',
  hostScope: 'host_scope',
  specField: 'spec_field',
  contentType: 'content_type',
  mode: 'mode',
  rateLimited: 'rate_limited',
  tooManyPending: 'too_many_pending',
  gatewayTimeout: 'gateway_timeout',
  daemonDisconnected: 'daemon_disconnected',
  notSent: 'not_sent',
});

/** session.create / session.preview spec fields a remote client may set; anything else is refused. */
export const SPEC_FIELDS = Object.freeze(['cwd', 'agent', 'model', 'mode', 'thinking', 'persist']);

/** Prompt content parts a remote client may send. The runtime reads text only. */
export const CONTENT_TYPES = Object.freeze(['text']);

/**
 * Fields of list rows passed on; anything else alpd adds later is dropped until reviewed. Rows name
 * entries, they never carry their content (commands, args, URLs, env) or host paths.
 */
export const LIBRARY_ROW_FIELDS = Object.freeze(['name', 'source', 'overrides', 'description', 'usedBy']);
export const TEAM_ROW_FIELDS = Object.freeze(['id', 'label', 'description', 'source', 'overrides', 'error']);
export const MODEL_ROW_FIELDS = Object.freeze(['id', 'label', 'efforts', 'effort']);

/** Visible characters: no whitespace, no control characters. */
const VISIBLE = '[^\\s\\u0000-\\u001f\\u007f-\\u009f]';
const MODEL_ID = new RegExp(`^(?:(?:codex|claude|antigravity):${VISIBLE}+|acp:(?!\\.\\.?(?:/|$))[\\w.-]+(?:/${VISIBLE}+)?|[A-Za-z0-9][\\w.@\\[\\]-]*)$`, 'u');

/**
 * A model id as alpd reads spec.model (packages/runtime/src/resolve.ts) and library.models lists
 * them: `<runtime>:<model>` for codex, claude and antigravity (catalogue ids such as
 * `claude:claude-opus-4-8[1m]`), `acp:<provider>` or `acp:<provider>/<model>`, where a provider id
 * is a library file name ([\w.-], packages/core/src/providers.js) and its model any id without
 * whitespace the provider lists, or a bare catalogue id. At most 256 characters. A model id is
 * never a path to the gateway or alpd: it chooses a provider by name and is passed to it.
 * @param {unknown} value
 */
export function isModelId(value) {
  return typeof value === 'string' && value.length <= 256 && MODEL_ID.test(value);
}

/**
 * @typedef {'gateway' | 'exposed' | 'denied' | 'prohibited'} ExposureStatus
 *   gateway: answered by the gateway itself; exposed: forwarded after the checks; denied: not
 *   exposed until a contract or policy makes its scope checkable; prohibited: never remote in v1.
 * @typedef {{
 *   status: ExposureStatus,
 *   permission?: 'session.read' | 'session.write' | 'project.read' | 'project.write',
 *   scope: string,
 *   capability?: string,
 *   params?: readonly string[],
 *   tests?: readonly string[],
 *   reason?: string,
 * }} Exposure
 */

/** @type {Readonly<Record<string, Exposure>>} */
export const EXPOSURE = Object.freeze({
  'daemon.hello': { status: 'gateway', scope: 'connection', reason: 'Answered by the gateway after its own hello to alpd: capabilities are alpd\'s intersected with FORWARDED_CAPABILITIES; no pid.', tests: ['handshake'] },

  'catalog.get': { status: 'exposed', permission: 'session.read', scope: 'none: the static model and mode catalogue', params: [], tests: ['permission'] },
  'session.list': { status: 'exposed', permission: 'session.read', scope: 'result: sessions whose tree lies in a granted workspace; projectRoot must name one', params: ['projectRoot', 'rootsOnly', 'includeClosed', 'includeArchived'], tests: ['permission', 'workspace-param', 'result-filter'] },
  'session.get': { status: 'exposed', permission: 'session.read', scope: 'session: its tree\'s root and itself in a granted workspace', params: ['sessionId'], tests: ['permission', 'session-scope'] },
  'session.status': { status: 'exposed', permission: 'session.read', scope: 'session; the answer must be the checked root\'s tree with every session in a granted workspace. Rows carry host paths of that tree (workdir, lease checkouts)', params: ['sessionId'], tests: ['permission', 'session-scope', 'tree-scope'] },
  'session.log': { status: 'exposed', permission: 'session.read', scope: 'session; the answer must be the checked root\'s run log, whose entries may name host paths of that tree', params: ['sessionId'], tests: ['permission', 'session-scope', 'tree-scope'] },
  'session.attach': { status: 'exposed', permission: 'session.read', scope: 'session; events and replay are then filtered per envelope', capability: CAPABILITY.attachAfter, params: ['sessionId', 'replay', 'after'], tests: ['permission', 'session-scope', 'event-filter'] },
  'session.release': { status: 'exposed', permission: 'session.read', scope: 'session', params: ['sessionId'], tests: ['permission', 'session-scope'] },
  'session.preview': { status: 'exposed', permission: 'session.read', scope: 'workspace: spec.cwd names a granted workspace; spec fields allow-listed', params: ['spec'], tests: ['permission', 'spec-scope'] },
  'question.list': { status: 'exposed', permission: 'session.read', scope: 'result: questions whose tree lies in a granted workspace; projectRoot must name one', params: ['projectRoot'], tests: ['permission', 'workspace-param', 'result-filter'] },
  'board.list': { status: 'exposed', permission: 'session.read', scope: 'workspace: projectRoot names a granted workspace', params: ['projectRoot'], tests: ['permission', 'workspace-param'] },

  'session.create': { status: 'exposed', permission: 'session.write', scope: 'workspace: spec.cwd names a granted workspace and is replaced by its canonical path; an existing sessionId must be in scope; the created root is checked again', params: ['sessionId', 'spec', 'history', 'delegation', 'resume'], tests: ['permission', 'spec-scope', 'session-scope'] },
  'session.prompt': { status: 'exposed', permission: 'session.write', scope: 'session; text content only; drives: the modes of the session and every ancestor, looked up afresh, within the grant\'s modes', capability: CAPABILITY.promptReceipts, params: ['sessionId', 'clientMessageId', 'delivery', 'content'], tests: ['permission', 'session-scope', 'content', 'mode'] },
  'session.interrupt': { status: 'exposed', permission: 'session.write', scope: 'session; stops: a root always, an assignment when its requesters\' modes are within the grant\'s', params: ['sessionId'], tests: ['permission', 'session-scope', 'mode'] },
  'session.configure': { status: 'exposed', permission: 'session.write', scope: 'session; mode within the grant\'s modes', params: ['sessionId', 'mode'], tests: ['permission', 'session-scope', 'mode'] },
  'session.close': { status: 'exposed', permission: 'session.write', scope: 'session; stops, as session.interrupt', params: ['sessionId'], tests: ['permission', 'session-scope', 'mode'] },
  'session.rename': { status: 'exposed', permission: 'session.write', scope: 'session', params: ['sessionId', 'title'], tests: ['permission', 'session-scope'] },
  'session.archive': { status: 'exposed', permission: 'session.write', scope: 'session', params: ['sessionId', 'archived'], tests: ['permission', 'session-scope'] },
  'session.message': { status: 'exposed', permission: 'session.write', scope: 'session; drives (wakes or steers it, and an assignment\'s requester is told), as session.prompt', params: ['sessionId', 'text'], tests: ['permission', 'session-scope', 'mode'] },
  'question.answer': { status: 'exposed', permission: 'session.write', scope: 'question: an exact id (no prefix) whose tree lies in a granted workspace; drives the asking session, as session.prompt', params: ['questionId', 'text', 'dismiss', 'reason'], tests: ['permission', 'question-scope', 'mode'] },

  'team.list': { status: 'exposed', permission: 'project.read', scope: 'workspace: projectRoot names a granted workspace (required by the gateway); rows also come from the library and built-in layers, as session.preview shows them; TEAM_ROW_FIELDS only, a read error replaced by a fixed text', capability: CAPABILITY.team, params: ['projectRoot'], tests: ['permission', 'workspace-param', 'row-fields'] },
  'task.list': { status: 'exposed', permission: 'project.read', scope: 'workspace: projectRoot', capability: CAPABILITY.task, params: ['projectRoot'], tests: ['permission', 'workspace-param'] },
  'task.create': { status: 'exposed', permission: 'project.write', scope: 'workspace: projectRoot; requestId dedupes within one alpd process for 10 minutes only, so read task.list before retrying after 1000 or a restart', capability: CAPABILITY.task, params: ['projectRoot', 'title', 'priority', 'requestId'], tests: ['permission', 'workspace-param'] },
  'task.update': { status: 'exposed', permission: 'project.write', scope: 'workspace: projectRoot', capability: CAPABILITY.task, params: ['projectRoot', 'id', 'action', 'note', 'ifRev'], tests: ['permission', 'workspace-param'] },
  'task.gate.resolve': { status: 'exposed', permission: 'project.write', scope: 'workspace: projectRoot', capability: CAPABILITY.task, params: ['projectRoot', 'id', 'gate', 'note', 'ifRev'], tests: ['permission', 'workspace-param'] },
  'library.list': { status: 'exposed', permission: 'project.read', scope: 'workspace: projectRoot (required by the gateway); rows (names, descriptions, sources, users) also come from the library and built-in layers; LIBRARY_ROW_FIELDS only, never content', capability: CAPABILITY.library, params: ['kind', 'projectRoot'], tests: ['permission', 'workspace-param', 'row-fields'] },
  'library.models': { status: 'exposed', permission: 'session.read', scope: 'none: model ids and labels, as catalog.get; MODEL_ROW_FIELDS only', capability: CAPABILITY.library, params: [], tests: ['permission', 'row-fields'] },
  'settings.language.get': { status: 'exposed', permission: 'session.read', scope: 'none: the language the user reads', capability: CAPABILITY.settingsLanguage, params: [], tests: ['permission'] },

  'library.get': { status: 'denied', scope: 'library-or-project', reason: 'Answers an entry\'s whole content: MCP servers (URLs that may hold tokens in userinfo or query, args, command), hooks (commands), providers, agents. alpd redacts only env and header values, so no layer is passed on until a redaction contract covers every field that can hold a secret.' },
  'library.save': { status: 'denied', scope: 'library-or-project', reason: 'Configures commands alpd runs on the daemon host (mcp, hooks, providers, agents naming them) and, with sync, writes every known project; not exposed until a policy tells project-scope, non-executable changes apart.' },
  'library.delete': { status: 'denied', scope: 'library-or-project', reason: 'Writes ALP configuration; with library.save.' },
  'library.duplicate': { status: 'denied', scope: 'library-or-project', reason: 'Copies executable configuration, secrets included; with library.save.' },
  'library.rename': { status: 'denied', scope: 'library-or-project', reason: 'Writes ALP configuration; with library.save.' },
  'library.skills.set': { status: 'denied', scope: 'host', reason: 'Host-level write (role-skills.json).' },
  'settings.language.set': { status: 'denied', scope: 'host', reason: 'Host-level write (settings.json).' },
  'daemon.status': { status: 'denied', scope: 'host', reason: 'Host-wide: pid, persistence state and counts across every workspace; the result schema requires pid. Readiness is GET /readyz.' },
  'daemon.usage': { status: 'denied', scope: 'host', reason: 'Account-wide provider usage; refresh probes providers on the daemon host.' },
  'assignment.recall': { status: 'denied', scope: 'unverifiable', reason: 'assignmentId/taskId do not name a workspace the gateway can check before the call, which runs a model.' },
  'daemon.pause': { status: 'denied', scope: 'host', reason: 'host.admin' },
  'daemon.resume': { status: 'denied', scope: 'host', reason: 'host.admin' },
  'daemon.pauses': { status: 'denied', scope: 'host', reason: 'host.admin' },
  'daemon.shutdown': { status: 'prohibited', scope: 'host', reason: 'Stops alpd.' },
  'extension.register': { status: 'prohibited', scope: 'host', reason: 'Would let a remote client serve methods every local client calls.' },
  'extension.unregister': { status: 'prohibited', scope: 'host', reason: 'Extension methods are never remote.' },
});

/** The exposure of a method, or undefined when the gateway does not know it at all. @param {string} method */
export function exposureOf(method) {
  return Object.hasOwn(EXPOSURE, method) ? EXPOSURE[method] : undefined;
}

/** Methods of v1 the matrix does not classify yet: a test fails while any is left. */
export function unclassified(methods = RPC_METHODS) {
  return methods.filter(method => !exposureOf(method));
}

/**
 * The workspace of a grant `value` names exactly (its path as given or its canonical path), or
 * undefined. Client strings are compared, never resolved on this host.
 * @param {import('./credentials.js').Grant} grant @param {unknown} value
 */
export function workspaceOf(grant, value) {
  if (typeof value !== 'string') return undefined;
  return grant.workspaces.find(workspace => workspace.path === value || workspace.canonical === value);
}
