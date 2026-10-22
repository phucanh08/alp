// @ts-check
import { CAPABILITY, ERROR, PROMPT_IMAGES, RPC_METHODS, WORKSPACE_GIT, blockedFilePath } from '@anhlp/alp-protocol';

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
 * Permissions a remote credential can hold: sessions, a project's other resources (tasks, teams,
 * project library entries), and the content of a workspace's files (`files.read`: listing
 * directories and reading text files, docs/alp/remote-gateway.md §5.10). A write permission implies
 * its read; `files.read` implies nothing and nothing implies it. Host administration has no remote
 * permission in v1.
 */
export const PERMISSIONS = Object.freeze(['session.read', 'session.write', 'project.read', 'project.write', 'files.read', 'library.write', 'workspace.write', 'workspace.manage']);

/**
 * What `alp-gateway credential create` grants without --permission: session and project read/write;
 * files.read and library.write require explicit owner opt-in.
 */
export const DEFAULT_PERMISSIONS = Object.freeze(['session.read', 'session.write', 'project.read', 'project.write']);

/**
 * Daemon capabilities the gateway passes on when alpd lists them; never `extension.methods`.
 * Within `library` and `settings.language` some methods stay unexposed and answer -32601
 * `not_exposed` (docs/alp/remote-gateway.md §5.4).
 */
export const FORWARDED_CAPABILITIES = Object.freeze([CAPABILITY.workspaceRegistry, CAPABILITY.workspaceWorktree, CAPABILITY.sessionHistory, CAPABILITY.attachAfter, CAPABILITY.promptReceipts, CAPABILITY.task, CAPABILITY.team, CAPABILITY.library, CAPABILITY.libraryProjectWrite, CAPABILITY.settingsLanguage, CAPABILITY.sessionListPage, CAPABILITY.questionWatch, CAPABILITY.questionWatchTurns, CAPABILITY.sessionAttention, CAPABILITY.workspaceFiles, CAPABILITY.workspaceFilesRead, CAPABILITY.promptImages, CAPABILITY.workspaceGit]);

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
  imageLimit: 'image_limit',
  blockedPath: 'blocked_path',
  mode: 'mode',
  rateLimited: 'rate_limited',
  tooManyPending: 'too_many_pending',
  gatewayTimeout: 'gateway_timeout',
  daemonDisconnected: 'daemon_disconnected',
  notSent: 'not_sent',
});

/** session.create / session.preview spec fields a remote client may set; anything else is refused. */
/** `workflow` names a team the daemon host defines (built-in, library or project), as Paseo picks one. */
export const SPEC_FIELDS = Object.freeze(['cwd', 'agent', 'model', 'mode', 'thinking', 'persist', 'workflow']);

/**
 * Prompt content parts a remote client may send: text, and images inline as base64 (the schema
 * refuses any other field on an image, so never a host path or URL).
 */
export const CONTENT_TYPES = Object.freeze(['text', 'image']);

/**
 * What one remote prompt may carry in images, below alpd's own PROMPT_IMAGES: so many, each of at
 * most `maxBytes` decoded and `maxTotalBytes` together, which as base64 fits the default 4 MiB frame.
 */
export const GATEWAY_PROMPT_IMAGES = Object.freeze({ mimeTypes: PROMPT_IMAGES.mimeTypes, maxCount: 4, maxBytes: 2 * 1024 * 1024, maxTotalBytes: 2.5 * 1024 * 1024 });

/**
 * The image limits of a gateway whose clients send frames of at most `maxFrame` bytes: those above,
 * lowered so the images as base64, with 64 KiB for the rest of the request, still fit one frame (a
 * smaller `limits.maxFrame` refuses them as image_limit rather than closing the socket).
 * @param {number} [maxFrame]
 */
export function promptImageLimits(maxFrame = 4 * 1024 * 1024) {
  const fits = Math.max(0, Math.floor((maxFrame - 64 * 1024) * 3 / 4));
  const maxTotalBytes = Math.min(GATEWAY_PROMPT_IMAGES.maxTotalBytes, fits);
  return { maxCount: GATEWAY_PROMPT_IMAGES.maxCount, maxBytes: Math.min(GATEWAY_PROMPT_IMAGES.maxBytes, maxTotalBytes), maxTotalBytes };
}

/**
 * Fields of list rows passed on; anything else alpd adds later is dropped until reviewed. Rows name
 * entries, they never carry their content (commands, args, URLs, env) or host paths.
 */
export const LIBRARY_ROW_FIELDS = Object.freeze(['name', 'source', 'overrides', 'description', 'usedBy']);
export const TEAM_ROW_FIELDS = Object.freeze(['id', 'label', 'description', 'source', 'overrides', 'error']);
export const MODEL_ROW_FIELDS = Object.freeze(['id', 'label', 'efforts', 'effort']);
/** Fields of a library.get answer passed on; `content` and `secrets` are the gateway's own (projectLibraryContent). */
export const LIBRARY_ENTRY_FIELDS = Object.freeze(['kind', 'name', 'source', 'overrides', 'revision', 'usedBy', 'librarySkills']);

/** What stands for a hidden value in library.get content, as alpd's own marker (docs/protocol/alp-json-rpc-v1.md §15.3). */
export const SECRET_MARKER = Object.freeze({ $secret: 'keep' });

const plain = (/** @type {unknown} */ value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const pointerOf = (/** @type {string[]} */ parts) => parts.map(part => `/${part.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
const isString = (/** @type {unknown} */ value) => typeof value === 'string';
const isBoolean = (/** @type {unknown} */ value) => typeof value === 'boolean';
const isNumber = (/** @type {unknown} */ value) => typeof value === 'number' && Number.isFinite(value);
const isStrings = (/** @type {unknown} */ value) => Array.isArray(value) && value.every(isString);
const isStringOrNumber = (/** @type {unknown} */ value) => isString(value) || isNumber(value);

/**
 * How each field of an entry's content leaves the gateway. A function keeps a value of that type
 * (others are dropped); 'secret' answers the marker in its place; 'secretValues' keeps an object's
 * keys and marks each value; 'secretItems' keeps a list's length and marks each item; 'program'
 * keeps a program name, and marks a command with whitespace, which may carry inline arguments;
 * { $each } projects every value of an object, { $list } every item of a list, { $orFalse } keeps
 * false or projects an object; any other object projects the fields it names. A field the map
 * does not name is dropped, so a field alpd or core adds later stays on the host until it is
 * reviewed here. ($-names never collide with content fields: $schema is dropped.)
 * @typedef {((value: unknown) => boolean) | 'secret' | 'secretValues' | 'secretItems' | 'program' | { $each: Projection } | { $list: Projection } | { $orFalse: Projection } | { [key: string]: Projection }} Projection
 */
const MODEL_ENTRY = { id: isString, label: isString, description: isString };
const MEMBER = { role: isString, model: isString, thinking: isString };
/** @type {Readonly<Record<string, { [key: string]: Projection }>>} */
const LIBRARY_CONTENT = Object.freeze({
  agents: {
    instructions: isString,
    config: { description: isString, provider: isString, model: isString, thinking: isString, mode: isString, context: isStringOrNumber, autocompact: isStringOrNumber, skills: isStrings, mcp: isStrings, hooks: isStrings },
  },
  skills: { body: isString },
  // url may hold a token in its userinfo, query or path; cwd is a host path.
  mcp: { server: { command: 'program', args: 'secretItems', env: 'secretValues', headers: 'secretValues', url: 'secret', cwd: 'secret' } },
  // A hook's command is a shell line, which can carry a token.
  hooks: { hook: { description: isString, event: isString, command: 'secret', blocking: isBoolean, timeoutSec: isNumber, match: { agent: isString, label: isString } } },
  teams: {
    team: {
      label: isString, description: isString, main: isString, maxPeers: isNumber, oracleModels: isStrings,
      members: { $each: MEMBER }, delegation: { $each: isStrings }, oracleThinking: { $each: isString },
      modelSetup: { mode: isString, preset: isString },
      supervisor: { $orFalse: { agent: isString, model: isString, thinking: isString } },
    },
    houseRules: isString,
  },
  providers: {
    provider: {
      kind: isString, label: isString, description: isString, enabled: isBoolean, readOnlyMode: isString,
      command: 'program', args: 'secretItems', env: 'secretValues', params: 'secret',
      models: { $list: MODEL_ENTRY }, additionalModels: { $list: MODEL_ENTRY },
    },
  },
});

/**
 * An entry's content as a remote client may see it, and the JSON Pointers of the values it hides.
 * alpd hides env and header values itself (§15.3); the gateway hides every other field that can
 * hold a secret and drops what it does not know. A kind it does not know answers no content.
 * @param {string} kind @param {unknown} content
 * @returns {{ content: Record<string, unknown>, secrets: string[] }}
 */
export function projectLibraryContent(kind, content) {
  /** @type {string[]} */
  const secrets = [];
  const map = Object.hasOwn(LIBRARY_CONTENT, kind) ? LIBRARY_CONTENT[kind] : undefined;
  if (!map || !plain(content)) return { content: {}, secrets };
  /** @param {any} rule @param {unknown} value @param {string[]} parts @returns {unknown} */
  const project = (rule, value, parts) => {
    if (typeof rule === 'function') return rule(value) ? (Array.isArray(value) ? [...value] : value) : undefined;
    if (rule === 'secret') { secrets.push(pointerOf(parts)); return { ...SECRET_MARKER }; }
    if (rule === 'program') {
      if (!isString(value)) return undefined;
      if (!/\s/.test(value)) return value;
      secrets.push(pointerOf(parts));
      return { ...SECRET_MARKER };
    }
    if (rule === 'secretValues') {
      if (!plain(value)) return undefined;
      return Object.fromEntries(Object.keys(/** @type {object} */ (value)).map(key => { secrets.push(pointerOf([...parts, key])); return [key, { ...SECRET_MARKER }]; }));
    }
    if (rule === 'secretItems') {
      if (!Array.isArray(value)) return undefined;
      return value.map((_, index) => { secrets.push(pointerOf([...parts, String(index)])); return { ...SECRET_MARKER }; });
    }
    if (Object.hasOwn(rule, '$list')) {
      if (!Array.isArray(value)) return undefined;
      return value.map((item, index) => project(rule.$list, item, [...parts, String(index)])).filter(item => item !== undefined);
    }
    if (Object.hasOwn(rule, '$orFalse')) return value === false ? false : project(rule.$orFalse, value, parts);
    if (!plain(value)) return undefined;
    const source = /** @type {Record<string, unknown>} */ (value);
    /** @type {Record<string, unknown>} */
    const out = {};
    if (Object.hasOwn(rule, '$each')) {
      for (const key of Object.keys(source)) {
        const kept = project(rule.$each, source[key], [...parts, key]);
        if (kept !== undefined) out[key] = kept;
      }
      return out;
    }
    for (const key of Object.keys(rule)) {
      if (!Object.hasOwn(source, key)) continue;
      const kept = project(rule[key], source[key], [...parts, key]);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  };
  return { content: /** @type {Record<string, unknown>} */ (project(map, content, [])), secrets };
}

/**
 * The daemon host's machine name as the gateway passes it on in its hello (Paseo's host label,
 * patch 0017): alpd's os.hostname(), trimmed, at most 253 characters, no control or format
 * characters (bidi overrides, zero-width), which could make one host look like another.
 * Anything else answers no hostname.
 * @param {unknown} value
 */
export function hostLabel(value) {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name && name.length <= 253 && !/[\p{Cc}\p{Cf}]/u.test(name) ? name : undefined;
}

/** The longest error text the gateway passes on; longer text is cut. */
export const MAX_ERROR_TEXT = 1000;
/** What stands for a host path outside the grant in error text. */
export const HOST_PATH = '<host path>';
/** What stands for a granted workspace's own root in error text; paths under it become relative. */
export const WORKSPACE = '<workspace>';
/** What stands for V8's quote of a file in error text. */
export const FILE_QUOTE = '<file content>';

const escapeRegExp = (/** @type {string} */ text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Characters that end a path token in prose: whitespace, quotes, brackets, `,` `;` `:`. */
const PATH_CHAR = '[^\\s\'"`()\\[\\]{}<>,;:|]';
/**
 * One pass over error text: file: URLs, with any number of slashes and a drive (paths; `file:` in prose is not one), other URLs (kept), then
 * absolute POSIX paths, Windows drive and UNC paths, and ~/ paths, each starting at the text's start
 * or after a character that cannot be inside a word: a space, a quote, a bracket, `=` `,` `;` `|`,
 * `:` (PATH=/a:/b, cfg:/x), `@`. A URL's own `//` is consumed with its scheme first.
 */
const TOKENS = new RegExp([
  `(?<file>\\b[Ff][Ii][Ll][Ee]:(?:[\\\\/]*[A-Za-z]:)?[\\\\/]${PATH_CHAR}*)`,
  `(?<url>\\b[A-Za-z][A-Za-z0-9+.-]*://${PATH_CHAR}*)`,
  `(?<=^|[\\s'"\`(\\[{<=,;|:@])(?<path>(?:/|~/|[A-Za-z]:[\\\\/]|\\\\\\\\)${PATH_CHAR}*)`,
].join('|'), 'g');

/**
 * Error text of alpd, a runtime or a provider as a remote client may see it (t-d27c,
 * docs/alp/remote-gateway.md §5.12). The first line only (stack traces, CLI stderr, code frames of
 * a config file go), V8's quote of a file that does not parse replaced by FILE_QUOTE, absolute
 * paths inside a granted workspace made relative to it (its root WORKSPACE), every other absolute host path (POSIX,
 * Windows, UNC, ~/, file: URLs, the gateway's home directory) replaced by HOST_PATH, at most
 * MAX_ERROR_TEXT characters. Text with none of these (a rate limit, an HTTP status, a URL) passes as it is.
 * @param {unknown} value @param {readonly { path: string, canonical: string }[]} workspaces @param {{ lines?: boolean, home?: string }} [options]
 *   lines: keep every line (alpd's own notices); home: the host's home directory, replaced wherever it appears
 */
export function safeErrorText(value, workspaces, { lines = false, home } = {}) {
  // Never String() an object: one without a primitive conversion would throw.
  let text = typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
  if (!lines) text = text.split(/\r\n|\r|\n|\u0085|\u2028|\u2029/, 1)[0];
  // Bounded before any pattern runs: a provider may answer a whole page.
  if (text.length > 4 * MAX_ERROR_TEXT) text = text.slice(0, 4 * MAX_ERROR_TEXT);
  // V8: `Unexpected token 'x', "<quote>" is not valid JSON`, `"<quote>" is not valid JSON`.
  text = text.replace(/"(?:[^"\\]|\\.|"(?!(?:\.\.\.|…)?\s+is not valid JSON))*"(?=(?:\.\.\.|…)?\s+is not valid JSON)/g, `"${FILE_QUOTE}"`);
  // Workspace roots first, longest first, as literals: a path with spaces is still one path.
  const roots = [...new Set(workspaces.flatMap(workspace => [workspace.canonical, workspace.path]))].filter(root => typeof root === 'string' && root.length > 1).sort((a, b) => b.length - a.length);
  for (const root of roots) {
    const bare = root.replace(/[\\/]+$/, '');
    text = text.replace(new RegExp(`(?<![\\w.~-])${escapeRegExp(bare)}(?:[\\\\/]+(${PATH_CHAR}+)|(?=[.!?]*(?:$|[\\s'"\`()\\[\\]{}<>,;:|])))`, 'g'), (_match, rest) => {
      if (rest === undefined) return WORKSPACE;
      // A path that climbs out of the workspace is a host path.
      return rest.split(/[\\/]/).includes('..') ? HOST_PATH : rest;
    });
  }
  // The home directory as a literal too (a user name with a space), with the rest of its path.
  if (home && home.replace(/[\\/]+$/, '').length > 1) text = text.replace(new RegExp(`${escapeRegExp(home.replace(/[\\/]+$/, ''))}(?:[\\\\/]${PATH_CHAR}*)?`, 'g'), HOST_PATH);
  text = text.replace(TOKENS, (match, ...rest) => {
    const groups = rest.at(-1);
    if (groups.file !== undefined) return HOST_PATH;
    if (groups.url !== undefined) return match;
    // A lone `/` or one ending a sentence is not a path.
    if (/^[/\\]+$/.test(match)) return match;
    const trailing = /[.!?]+$/.exec(match)?.[0] ?? '';
    return HOST_PATH + trailing;
  });
  if (text.length > MAX_ERROR_TEXT) text = `${text.slice(0, MAX_ERROR_TEXT)}…`;
  return text;
}

/**
 * An error object of an event, a prompt receipt or a session's lastError (`{ message, code? }`) as
 * a remote client may see it: the code when it is a plain identifier, the message through
 * safeErrorText; every other field dropped. Anything that is not an object answers a generic one.
 * @param {unknown} error @param {readonly { path: string, canonical: string }[]} workspaces @param {{ home?: string }} [options]
 */
export function safeAlpError(error, workspaces, options = {}) {
  const source = /** @type {any} */ (plain(error) ? error : {});
  const code = typeof source.code === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(source.code) ? source.code : undefined;
  const message = typeof source.message === 'string' && source.message ? safeErrorText(source.message, workspaces, options) : 'Failed';
  return { message, ...(code ? { code } : {}) };
}

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
 *   alsoRequires: permissions the grant must hold besides `permission` (each checked, refused
 *   with 1003 grant naming the first one missing, before anything reaches alpd).
 * @typedef {{
 *   status: ExposureStatus,
 *   permission?: 'session.read' | 'session.write' | 'project.read' | 'project.write' | 'files.read' | 'library.write' | 'workspace.write' | 'workspace.manage',
 *   alsoRequires?: readonly ('session.read' | 'session.write' | 'project.read' | 'project.write' | 'files.read' | 'library.write' | 'workspace.write' | 'workspace.manage')[],
 *   scope: string,
 *   capability?: string,
 *   params?: readonly string[],
 *   tests?: readonly string[],
 *   reason?: string,
 * }} Exposure
 */

/** @type {Readonly<Record<string, Exposure>>} */
export const EXPOSURE = Object.freeze({
  'daemon.hello': { status: 'gateway', scope: 'connection', reason: 'Answered by the gateway after its own hello to alpd: capabilities are alpd\'s intersected with FORWARDED_CAPABILITIES; alpd\'s hostname when hostLabel accepts it; no pid.', tests: ['handshake'] },

  'catalog.get': { status: 'exposed', permission: 'session.read', scope: 'none: the static model and mode catalogue', params: [], tests: ['permission'] },
  'session.list': { status: 'exposed', permission: 'session.read', scope: 'result: sessions whose tree lies in a granted workspace; projectRoot must name one; with limit, alpd pages are read until the filtered page is full', params: ['projectRoot', 'rootsOnly', 'includeClosed', 'includeArchived', 'limit', 'cursor', 'query'], tests: ['permission', 'workspace-param', 'result-filter', 'paging'] },
  'session.get': { status: 'exposed', permission: 'session.read', scope: 'session: its tree\'s root and itself in a granted workspace', params: ['sessionId'], tests: ['permission', 'session-scope'] },
  'session.status': { status: 'exposed', permission: 'session.read', scope: 'session; the answer must be the checked root\'s tree with every session in a granted workspace. Rows carry host paths of that tree (workdir, lease checkouts)', params: ['sessionId'], tests: ['permission', 'session-scope', 'tree-scope'] },
  'session.log': { status: 'exposed', permission: 'session.read', scope: 'session; the answer must be the checked root\'s run log, whose entries may name host paths of that tree', params: ['sessionId'], tests: ['permission', 'session-scope', 'tree-scope'] },
  'session.history': { status: 'exposed', permission: 'session.read', scope: 'session: authorize before cursor processing; each envelope filtered', capability: CAPABILITY.sessionHistory, params: ['sessionId', 'before', 'limit'], tests: ['permission', 'session-scope', 'event-filter'] },
  'session.attach': { status: 'exposed', permission: 'session.read', scope: 'session; events and replay are then filtered per envelope', capability: CAPABILITY.attachAfter, params: ['sessionId', 'replay', 'after', 'generation'], tests: ['permission', 'session-scope', 'event-filter'] },
  'session.release': { status: 'exposed', permission: 'session.read', scope: 'session', params: ['sessionId'], tests: ['permission', 'session-scope'] },
  'session.preview': { status: 'exposed', permission: 'session.read', scope: 'workspace: spec.cwd names a granted workspace; spec fields allow-listed', params: ['spec'], tests: ['permission', 'spec-scope'] },
  'question.list': { status: 'exposed', permission: 'session.read', scope: 'result: questions whose tree lies in a granted workspace; projectRoot must name one', params: ['projectRoot'], tests: ['permission', 'workspace-param', 'result-filter'] },
  'question.watch': { status: 'exposed', permission: 'session.read', scope: 'result: as question.list; then question events, and with turns (question.watch.turns) roots\' turn.ended, with attention (session.attention) roots\' attention in the answer and its changes, filtered per envelope, and to the workspace projectRoot names', capability: CAPABILITY.questionWatch, params: ['projectRoot', 'turns', 'attention'], tests: ['permission', 'workspace-param', 'result-filter', 'event-filter'] },
  'session.attention.clear': { status: 'exposed', permission: 'session.read', scope: 'session: acknowledges a root\'s attention for every client, as a look at it does; a reader may', capability: CAPABILITY.sessionAttention, params: ['sessionId', 'at'], tests: ['permission', 'session-scope'] },
  'board.list': { status: 'exposed', permission: 'session.read', scope: 'workspace: projectRoot names a granted workspace', params: ['projectRoot'], tests: ['permission', 'workspace-param'] },

  'registry.worktree': { status: 'prohibited', scope: 'host', reason: 'host-only mapping and committed grant provenance' },
  'workspace.worktree.options': { status: 'exposed', permission: 'workspace.manage', scope: 'exact source grant and explicit host mapping IDs', params: ['workspaceId'], tests: ['permission', 'registry-scope'] },
  'workspace.worktree.create': { status: 'exposed', permission: 'workspace.manage', scope: 'exact source grant and explicit host destination mapping; generated destination only', params: ['workspaceId','mappingId','requestId','ifRevision'], tests: ['permission', 'registry-scope'] },
  'workspace.worktree.remove': { status: 'exposed', permission: 'workspace.manage', scope: 'creator-bound committed exact managed checkout provenance; current source and mapping rights', params: ['workspaceId','requestId','ifRevision'], tests: ['permission', 'registry-scope'] },
  'registry.owner': { status: 'prohibited', scope: 'host', reason: 'owner-only registry metadata and placement operations' },
  'project.list': { status: 'exposed', permission: 'project.read', scope: 'exact canonical grants filtered before paging and counts', params: ['cursor', 'limit'], tests: ['permission', 'registry-scope'] },
  'workspace.list': { status: 'exposed', permission: 'project.read', scope: 'workspace directory exact grant filtered before paging and counts', params: ['cursor', 'limit'], tests: ['permission', 'registry-scope'] },
  'workspace.get': { status: 'exposed', permission: 'project.read', scope: 'workspace directory exact canonical grant', params: ['workspaceId'], tests: ['permission', 'registry-scope'] },
  'project.register': { status: 'exposed', permission: 'workspace.write', scope: 'only an existing exact pregranted canonical directory', params: ['directory', 'ifRevision', 'requestId'], tests: ['permission', 'registry-scope'] },
  'project.remove': { status: 'exposed', permission: 'workspace.write', scope: 'exact project grant plus every workspace directory; metadata only', params: ['projectId', 'ifRevision', 'requestId'], tests: ['permission', 'registry-scope'] },
  'workspace.update': { status: 'exposed', permission: 'workspace.write', scope: 'workspace directory exact canonical grant; no owner placement or labels', params: ['workspaceId', 'title', 'pinned', 'archived', 'ifRevision', 'requestId'], tests: ['permission', 'registry-scope'] },
  'session.create': { status: 'exposed', permission: 'session.write', scope: 'workspace: spec.cwd names a granted workspace and is replaced by its canonical path; an existing sessionId must be in scope; the created root is checked again', params: ['sessionId', 'workspaceId', 'spec', 'history', 'delegation', 'resume'], tests: ['permission', 'spec-scope', 'session-scope'] },
  'session.prompt': { status: 'exposed', permission: 'session.write', scope: 'session; text, and inline images within GATEWAY_PROMPT_IMAGES; drives: the modes of the session and every ancestor, looked up afresh, within the grant\'s modes', capability: CAPABILITY.promptReceipts, params: ['sessionId', 'clientMessageId', 'delivery', 'content'], tests: ['permission', 'session-scope', 'content', 'mode'] },
  'session.interrupt': { status: 'exposed', permission: 'session.write', scope: 'session; stops: a root always, an assignment when its requesters\' modes are within the grant\'s', params: ['sessionId'], tests: ['permission', 'session-scope', 'mode'] },
  'session.configure': { status: 'exposed', permission: 'session.write', scope: 'session; mode within the grant\'s modes', params: ['sessionId', 'mode'], tests: ['permission', 'session-scope', 'mode'] },
  'session.close': { status: 'exposed', permission: 'session.write', scope: 'session; stops, as session.interrupt', params: ['sessionId'], tests: ['permission', 'session-scope', 'mode'] },
  'session.rename': { status: 'exposed', permission: 'session.write', scope: 'session', params: ['sessionId', 'title'], tests: ['permission', 'session-scope'] },
  'session.archive': { status: 'exposed', permission: 'session.write', scope: 'session', params: ['sessionId', 'archived'], tests: ['permission', 'session-scope'] },
  'session.message': { status: 'exposed', permission: 'session.write', scope: 'session; drives (wakes or steers it, and an assignment\'s requester is told), as session.prompt', params: ['sessionId', 'text'], tests: ['permission', 'session-scope', 'mode'] },
  'question.answer': { status: 'exposed', permission: 'session.write', scope: 'question: an exact id (no prefix) whose tree lies in a granted workspace; drives the asking session, as session.prompt', params: ['questionId', 'text', 'dismiss', 'reason'], tests: ['permission', 'question-scope', 'mode'] },

  'team.list': { status: 'exposed', permission: 'project.read', scope: 'workspace: projectRoot names a granted workspace (required by the gateway); rows also come from the library and built-in layers, as session.preview shows them; TEAM_ROW_FIELDS only, a read error replaced by a fixed text', capability: CAPABILITY.team, params: ['projectRoot'], tests: ['permission', 'workspace-param', 'row-fields'] },
  'workspace.files.search': { status: 'exposed', permission: 'project.read', scope: 'workspace: projectRoot names a granted workspace and is sent as its canonical path; alpd lists file names under it only (no link followed, no contents); answered paths must be relative without . or .. segments, others dropped', capability: CAPABILITY.workspaceFiles, params: ['projectRoot', 'query', 'limit'], tests: ['permission', 'workspace-param', 'result-filter'] },
  'workspace.files.list': { status: 'exposed', permission: 'files.read', scope: 'workspace: projectRoot names a granted workspace and is sent as its canonical path; path relative, no . or .. segment, never a blocked one (blockedFilePath, refused by the gateway before alpd); alpd lists regular files and directories under it, no link followed; answered entries must be direct children of path, plainly relative and not blocked, others dropped; alpd errors rewritten to fixed text', capability: CAPABILITY.workspaceFilesRead, params: ['projectRoot', 'path', 'includeIgnored'], tests: ['permission', 'workspace-param', 'result-filter', 'path-filter'] },
  'workspace.files.read': { status: 'exposed', permission: 'files.read', scope: 'workspace: as workspace.files.list; alpd reads one UTF-8 text file of at most WORKSPACE_FILES.maxReadBytes, no link or hard link; the answer must name the requested path and fit the limit, else refused; alpd errors rewritten to fixed text', capability: CAPABILITY.workspaceFilesRead, params: ['projectRoot', 'path', 'includeIgnored'], tests: ['permission', 'workspace-param', 'result-filter', 'path-filter'] },
  'workspace.git.status': { status: 'exposed', permission: 'project.read', scope: 'workspace: workspaceId names a registry workspace whose directory a grant names exactly (#registryWorkspace, managed worktrees included); read only, never a Git mutation; answer projected by projectGitStatus: listed fields only, rows whose path or old path is not plainly relative or is blocked dropped and counted hidden, a local remote URL answered null; alpd errors rewritten to fixed text', capability: CAPABILITY.workspaceGit, params: ['workspaceId'], tests: ['permission', 'registry-scope', 'result-filter'] },
  'workspace.git.diff': { status: 'exposed', permission: 'project.read', alsoRequires: ['files.read'], scope: 'workspace: as workspace.git.status; hunks are file content, so files.read too (never a default); compare re-projected to mode, baseRef, ignoreWhitespace; path relative and not blocked, refused by the gateway before alpd; answer projected by projectGitDiff: files of other paths, non-relative or blocked ones dropped (counted hidden), each file\'s patch and the page within WORKSPACE_GIT or the answer refused, pages split to fit the client\'s frame (sealed gateway cursors); alpd errors rewritten to fixed text', capability: CAPABILITY.workspaceGit, params: ['workspaceId', 'compare', 'path', 'cursor'], tests: ['permission', 'registry-scope', 'result-filter', 'path-filter'] },
  'task.list': { status: 'exposed', permission: 'project.read', scope: 'workspace: projectRoot', capability: CAPABILITY.task, params: ['projectRoot'], tests: ['permission', 'workspace-param'] },
  'task.create': { status: 'exposed', permission: 'project.write', scope: 'workspace: projectRoot; requestId dedupes within one alpd process for 10 minutes only, so read task.list before retrying after 1000 or a restart', capability: CAPABILITY.task, params: ['projectRoot', 'title', 'priority', 'requestId'], tests: ['permission', 'workspace-param'] },
  'task.update': { status: 'exposed', permission: 'project.write', scope: 'workspace: projectRoot', capability: CAPABILITY.task, params: ['projectRoot', 'id', 'action', 'note', 'ifRev'], tests: ['permission', 'workspace-param'] },
  'task.gate.resolve': { status: 'exposed', permission: 'project.write', scope: 'workspace: projectRoot', capability: CAPABILITY.task, params: ['projectRoot', 'id', 'gate', 'note', 'ifRev'], tests: ['permission', 'workspace-param'] },
  'library.list': { status: 'exposed', permission: 'project.read', scope: 'workspace: projectRoot (required by the gateway); rows (names, descriptions, sources, users) also come from the library and built-in layers; LIBRARY_ROW_FIELDS only, never content', capability: CAPABILITY.library, params: ['kind', 'projectRoot'], tests: ['permission', 'workspace-param', 'row-fields'] },
  'library.models': { status: 'exposed', permission: 'session.read', scope: 'none: model ids and labels, as catalog.get; MODEL_ROW_FIELDS only', capability: CAPABILITY.library, params: [], tests: ['permission', 'row-fields'] },
  'settings.language.get': { status: 'exposed', permission: 'session.read', scope: 'none: the language the user reads', capability: CAPABILITY.settingsLanguage, params: [], tests: ['permission'] },
  'library.get': { status: 'exposed', permission: 'project.read', scope: 'workspace: projectRoot (required by the gateway); the entry that applies may come from the library or built-in layers, as library.list rows do; read only. Content is projected by projectLibraryContent: listed fields only, every field that can hold a secret (env, headers, url, cwd, args, params, hook commands, commands with spaces) answered as a secret marker and listed in secrets', capability: CAPABILITY.library, params: ['kind', 'name', 'projectRoot', 'scope'], tests: ['permission', 'workspace-param', 'redaction'] },

  'library.save': { status: 'exposed', permission: 'library.write', scope: 'workspace: projectRoot required; project-only agents and skills under authoritative project-data policy; no host/builtin collision, executable config or sidecars', capability: CAPABILITY.libraryProjectWrite, params: ['kind', 'name', 'scope', 'projectRoot', 'content', 'revision', 'sync'], tests: ['permission', 'workspace-param', 'library-policy'] },
  'library.delete': { status: 'exposed', permission: 'library.write', scope: 'workspace: projectRoot required; project-only agents and skills under authoritative project-data policy; no host/builtin collision, executable config or sidecars', capability: CAPABILITY.libraryProjectWrite, params: ['kind', 'name', 'scope', 'projectRoot', 'revision'], tests: ['permission', 'workspace-param', 'library-policy'] },
  'library.duplicate': { status: 'exposed', permission: 'library.write', scope: 'workspace: projectRoot required; project-only agents and skills under authoritative project-data policy; no host/builtin collision, executable config or sidecars', capability: CAPABILITY.libraryProjectWrite, params: ['kind', 'from', 'to', 'scope', 'projectRoot'], tests: ['permission', 'workspace-param', 'library-policy'] },
  'library.rename': { status: 'exposed', permission: 'library.write', scope: 'workspace: projectRoot required; project-only agents and skills under authoritative project-data policy; no host/builtin collision, executable config or sidecars', capability: CAPABILITY.libraryProjectWrite, params: ['kind', 'from', 'to', 'scope', 'projectRoot'], tests: ['permission', 'workspace-param', 'library-policy'] },
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
  'schedule.create': { status: 'prohibited', scope: 'workspace', reason: 'A scheduled continuation opens a turn on a session without a user message, later than the request that made it; the gateway forwards nothing that fires after the request in v1.' },
  'schedule.list': { status: 'prohibited', scope: 'workspace', reason: 'The jobs of the host name sessions the gateway does not check; as schedule.create, they are never remote in v1.' },
  'schedule.get': { status: 'prohibited', scope: 'workspace', reason: 'As schedule.list: a job of the host is never remote in v1.' },
  'schedule.cancel': { status: 'prohibited', scope: 'workspace', reason: 'As schedule.create: cancelling a job of the host is never remote in v1.' },
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

// ---- workspace.git.status and workspace.git.diff (docs/protocol/alp-json-rpc-v1.md §12.5) ----

const GIT_CHANGES = new Set(['modified', 'added', 'deleted', 'renamed', 'copied', 'typechange', 'untracked', 'conflicted']);
const GIT_KINDS = new Set(['text', 'binary', 'too_large', 'withheld', 'symlink', 'submodule']);
const GIT_MODES = new Set(['uncommitted', 'staged', 'unstaged', 'base']);
const GIT_LINE_TYPES = new Set(['add', 'remove', 'context']);
const count = (/** @type {unknown} */ value) => Number.isSafeInteger(value) && /** @type {number} */ (value) >= 0;
/** A ref or branch name as text a client may see: 1–1024 characters, no control or format characters. */
const refName = (/** @type {unknown} */ value) => typeof value === 'string' && value.length > 0 && value.length <= 1024 && !/[\p{Cc}\p{Cf}]/u.test(value);

/**
 * A path a Git answer may name: plainly relative to the workspace ('/' between names, no root,
 * drive, backslash, `.`, `..` or empty segment, no NUL, at most 4096 code points) and not one
 * blockedFilePath names. Anything else never leaves the gateway.
 * @param {unknown} value
 */
export function gitPath(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || [...value].length > 4096 || /[\0\\]/.test(value)) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  if (!value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..')) return false;
  return !blockedFilePath(value);
}

/**
 * origin's URL as a remote client may see it: an http(s), ssh or git URL without user name,
 * password, query or fragment, or scp-like `host:path` (a host of two characters or more, so never
 * a Windows drive), at most 2048 characters without whitespace. A local path, a `file:` URL or
 * anything else answers null, as alpd answers a local remote.
 * @param {unknown} value
 */
export function gitRemoteUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s\p{Cc}\p{Cf}]/u.test(value)) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    return value;
  }
  // scp-like: host:path, never user@host (alpd removes user information) and never a path.
  return /^[A-Za-z0-9][A-Za-z0-9.-]+:(?!\/\/)[^@]*$/.test(value) && !value.includes('\\') ? value : null;
}

/**
 * The bytes of patch content a diff file carries (its lines' text, UTF-8), which is never more
 * than the patch alpd measured against WORKSPACE_GIT.
 * @param {{ hunks: Array<{ lines: Array<{ content: string }> }> }} file
 */
export function gitPatchBytes(file) {
  let bytes = 0;
  for (const hunk of file.hunks) for (const line of hunk.lines) bytes += Buffer.byteLength(line.content, 'utf8');
  return bytes;
}

/**
 * A workspace.git.status answer as a remote client may see it: the schema's fields only, each
 * checked; a row whose path or old path gitPath refuses is left out and counted in hiddenCount
 * (`dropped` says how many, for the gateway's log); at most WORKSPACE_GIT.maxStatusFiles rows.
 * Returns undefined for an answer that is not a status at all.
 * @param {unknown} raw
 * @returns {{ status: import('@anhlp/alp-protocol').GitStatus, dropped: number } | undefined}
 */
export function projectGitStatus(raw) {
  if (!plain(raw)) return undefined;
  const source = /** @type {Record<string, any>} */ (raw);
  if (!['repository', 'not_repository', 'unsupported'].includes(source.state) || typeof source.snapshot !== 'string' || source.snapshot.length > 1024) return undefined;
  let dropped = 0;
  let truncated = source.truncated === true;
  /** @type {import('@anhlp/alp-protocol').GitStatusFile[]} */
  const files = [];
  for (const row of Array.isArray(source.files) ? source.files : []) {
    const kept = plain(row) && gitPath(row.path) && (row.oldPath === undefined || gitPath(row.oldPath)) && GIT_CHANGES.has(row.change);
    if (!kept) { dropped++; continue; }
    if (files.length >= WORKSPACE_GIT.maxStatusFiles) { truncated = true; continue; }
    files.push({ path: row.path, ...(row.oldPath !== undefined ? { oldPath: row.oldPath } : {}), change: row.change, staged: row.staged === true, unstaged: row.unstaged === true });
  }
  const upstream = plain(source.upstream) && refName(source.upstream.ref) && count(source.upstream.ahead) && count(source.upstream.behind) ? { ref: source.upstream.ref, ahead: source.upstream.ahead, behind: source.upstream.behind } : null;
  const aheadBehind = plain(source.aheadBehind) && count(source.aheadBehind.ahead) && count(source.aheadBehind.behind) ? { ahead: source.aheadBehind.ahead, behind: source.aheadBehind.behind } : null;
  const repository = source.state === 'repository';
  return {
    dropped,
    status: {
      state: source.state,
      ...(!repository && typeof source.reason === 'string' && /^[a-z_]{1,64}$/.test(source.reason) ? { reason: source.reason } : {}),
      branch: repository && refName(source.branch) ? source.branch : null,
      detached: source.detached === true,
      head: typeof source.head === 'string' && /^[0-9a-f]{7,64}$/.test(source.head) ? source.head : null,
      upstream,
      baseRef: refName(source.baseRef) ? source.baseRef : null,
      aheadBehind,
      hasRemote: source.hasRemote === true,
      remoteUrl: gitRemoteUrl(source.remoteUrl),
      dirty: source.dirty === true,
      files,
      hiddenCount: (count(source.hiddenCount) ? source.hiddenCount : 0) + dropped,
      truncated,
      snapshot: source.snapshot,
    },
  };
}

/**
 * One file of a workspace.git.diff answer, checked field by field; undefined when its shape is
 * not the schema's (the whole answer is then refused), `false` when a path is refused by gitPath
 * (it is left out and counted hidden).
 * @param {unknown} raw
 * @returns {import('@anhlp/alp-protocol').GitDiffFile | false | undefined}
 */
function gitDiffFile(raw) {
  if (!plain(raw)) return undefined;
  const source = /** @type {Record<string, any>} */ (raw);
  if (!gitPath(source.path) || (source.oldPath !== undefined && !gitPath(source.oldPath))) return false;
  if (!GIT_CHANGES.has(source.change) || !GIT_KINDS.has(source.kind) || !count(source.additions) || !count(source.deletions) || !Array.isArray(source.hunks)) return undefined;
  /** @type {import('@anhlp/alp-protocol').GitDiffHunk[]} */
  const hunks = [];
  if (source.kind === 'text') {
    for (const hunk of source.hunks) {
      if (!plain(hunk) || !count(hunk.oldStart) || !count(hunk.oldCount) || !count(hunk.newStart) || !count(hunk.newCount) || !Array.isArray(hunk.lines)) return undefined;
      if (hunk.context !== undefined && (typeof hunk.context !== 'string' || hunk.context.length > 4096)) return undefined;
      /** @type {import('@anhlp/alp-protocol').GitDiffLine[]} */
      const lines = [];
      for (const line of hunk.lines) {
        if (!plain(line) || !GIT_LINE_TYPES.has(line.type) || typeof line.content !== 'string') return undefined;
        lines.push({ type: line.type, content: line.content, ...(line.noNewline === true ? { noNewline: true } : {}) });
      }
      hunks.push({ oldStart: hunk.oldStart, oldCount: hunk.oldCount, newStart: hunk.newStart, newCount: hunk.newCount, ...(hunk.context !== undefined ? { context: hunk.context } : {}), lines });
    }
  }
  return { path: source.path, ...(source.oldPath !== undefined ? { oldPath: source.oldPath } : {}), change: source.change, kind: source.kind, additions: source.additions, deletions: source.deletions, hunks };
}

/**
 * A workspace.git.diff answer as a remote client may see it, before the gateway pages it: the
 * schema's fields only; files whose path or old path gitPath refuses left out and counted
 * (`hidden`), as are files that name neither side `path` when one was asked for (`foreign`). A
 * file whose content is over WORKSPACE_GIT.maxFileBytes, or past the page's maxTotalBytes, stays
 * listed as too_large without hunks (`oversize`). Any field of the wrong shape refuses the whole
 * answer: `{ refused }` says why, for the gateway's log.
 * @param {unknown} raw @param {{ path?: string }} [request]
 * @returns {{ page: import('@anhlp/alp-protocol').GitDiffPage, hidden: number, foreign: number, oversize: number } | { refused: 'shape' }}
 */
export function projectGitDiff(raw, { path } = {}) {
  if (!plain(raw)) return { refused: 'shape' };
  const source = /** @type {Record<string, any>} */ (raw);
  const compare = source.compare;
  if (!plain(compare) || !GIT_MODES.has(compare.mode) || typeof compare.ignoreWhitespace !== 'boolean' || (compare.baseRef !== undefined && !refName(compare.baseRef))) return { refused: 'shape' };
  if (typeof source.snapshot !== 'string' || source.snapshot.length > 1024 || !Array.isArray(source.files)) return { refused: 'shape' };
  if (source.nextCursor !== undefined && (typeof source.nextCursor !== 'string' || !source.nextCursor || source.nextCursor.length > 1024)) return { refused: 'shape' };
  let hidden = 0;
  let foreign = 0;
  let oversize = 0;
  let total = 0;
  /** @type {import('@anhlp/alp-protocol').GitDiffFile[]} */
  const files = [];
  for (const entry of source.files) {
    const file = gitDiffFile(entry);
    if (file === undefined) return { refused: 'shape' };
    if (file === false) { hidden++; continue; }
    if (path !== undefined && file.path !== path && file.oldPath !== path) { foreign++; continue; }
    // Content over the per-file limit, or past the page's, is not passed on: the file stays listed
    // as too_large without hunks (alpd measures the same decoded content, so this is a backstop).
    const bytes = gitPatchBytes(file);
    if (bytes > WORKSPACE_GIT.maxFileBytes || total + bytes > WORKSPACE_GIT.maxTotalBytes) { oversize++; files.push({ ...file, kind: 'too_large', hunks: [] }); continue; }
    total += bytes;
    files.push(file);
  }
  return {
    hidden,
    foreign,
    oversize,
    page: {
      compare: { mode: compare.mode, ...(compare.baseRef !== undefined ? { baseRef: compare.baseRef } : {}), ignoreWhitespace: compare.ignoreWhitespace },
      snapshot: source.snapshot,
      files,
      hiddenCount: (count(source.hiddenCount) ? source.hiddenCount : 0) + hidden,
      truncated: source.truncated === true,
      ...(source.nextCursor !== undefined ? { nextCursor: source.nextCursor } : {}),
    },
  };
}
