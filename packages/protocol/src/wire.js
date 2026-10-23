/** Wire protocol of alpd (plans/reference/ALPD.md §3). Bump only for incompatible changes. */
export const PROTOCOL_VERSION = 1;
export const MAX_FRAME = 16 * 1024 * 1024;

export class AlpRpcError extends Error {
  constructor(error) {
    super(error?.message ?? 'ALP daemon request failed');
    this.code = error?.code;
    this.data = error?.data;
  }
}

export const ERROR = Object.freeze({ failed: 1000, notFound: 1001, forbidden: 1003, conflict: 1004, unavailable: 1005, protocol: 1006 });
/** The JSON-RPC 2.0 codes alpd answers with (docs/protocol/alp-json-rpc-v1.md §5). */
export const RPC_ERROR = Object.freeze({ parseError: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602 });
/**
 * Features a daemon lists in its daemon.hello result. A client uses a feature only when listed;
 * a daemon that lists none (one older than this list) has none of them. Unknown names are ignored.
 */
export const CAPABILITY = Object.freeze({ attachAfter: 'attach.after', sessionHistory: 'session.history', workspaceRegistry: 'workspace.registry', workspaceWorktree: 'workspace.worktree', workspaceGit: 'workspace.git', promptReceipts: 'prompt.receipts', extensionMethods: 'extension.methods', team: 'team', task: 'task', library: 'library', libraryProjectWrite: 'library.project.write', settingsLanguage: 'settings.language', sessionListPage: 'session.list.page', questionWatch: 'question.watch', questionWatchTurns: 'question.watch.turns', sessionAttention: 'session.attention', workspaceFiles: 'workspace.files', workspaceFilesRead: 'workspace.files.read', promptImages: 'prompt.images', schedule: 'schedule', attachments: 'attachments', sessionFork: 'session.fork', sessionRewind: 'session.rewind' , sessionReload: 'session.reload', sessionResumeCommand: 'session.resumeCommand'});
/**
 * What alpd takes as images in one session.prompt (capability `prompt.images`): inline base64 of
 * these types only, never a path or URL; at most `maxCount` of them, each at most `maxBytes`
 * decoded, and `maxTotalBytes` together, so their base64 fits one MAX_FRAME. A gateway may allow
 * less (docs/alp/remote-gateway.md).
 */
export const PROMPT_IMAGES = Object.freeze({ mimeTypes: Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']), maxCount: 8, maxBytes: 5 * 1024 * 1024, maxTotalBytes: 11 * 1024 * 1024 });
/** Decoded bytes of base64 `data` (padding aware), without decoding it. @param {string} data */
export const base64Bytes = data => Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
export const RPC_METHODS = Object.freeze(["assignment.recall", "attachment.abort", "attachment.begin", "attachment.chunk", "attachment.commit", "attachment.delete", "attachment.get", "board.list", "catalog.get", "daemon.hello", "daemon.pause", "daemon.pauses", "daemon.resume", "daemon.shutdown", "daemon.status", "daemon.usage", "extension.register", "extension.unregister", "library.delete", "library.duplicate", "library.get", "library.list", "library.models", "library.rename", "library.save", "library.skills.set", "project.list", "project.register", "project.remove", "question.answer", "question.list", "question.watch", "registry.owner", "registry.worktree", "schedule.cancel", "schedule.create", "schedule.get", "schedule.list", "session.archive", "session.attach", "session.attention.clear", "session.close", "session.configure", "session.create", "session.fork", "session.get", "session.history", "session.interrupt", "session.list", "session.log", "session.message", "session.preview", "session.prompt", "session.release", "session.reload", "session.rename", "session.resumeCommand", "session.rewind", "session.status", "settings.language.get", "settings.language.set", "task.create", "task.gate.resolve", "task.list", "task.update", "team.list", "workspace.files.list", "workspace.files.read", "workspace.files.search", "workspace.get", "workspace.git.diff", "workspace.git.status", "workspace.list", "workspace.update", "workspace.worktree.create", "workspace.worktree.options", "workspace.worktree.remove"]);

/**
 * Limits of workspace.files.list and workspace.files.read (capability `workspace.files.read`,
 * docs/protocol/alp-json-rpc-v1.md §12.4): a file of at most `maxReadBytes`, a listing of at most
 * `maxListEntries` entries, a relative path of at most `maxPathLength` characters.
 */
export const WORKSPACE_FILES = Object.freeze({ maxReadBytes: 1024 * 1024, maxListEntries: 1000, maxPathLength: 4096 });

/**
 * Limits of workspace.git.status and workspace.git.diff (capability `workspace.git`,
 * docs/protocol/alp-json-rpc-v1.md §12.5): one file's patch at most `maxFileBytes`, one page's
 * patches at most `maxTotalBytes` (then `nextCursor`), at most `maxUntracked` untracked files with
 * content, `maxStatusFiles` status rows, a base branch name of at most `maxRefLength` characters.
 * A gateway may lower them; never raise them.
 */
export const WORKSPACE_GIT = Object.freeze({ maxFileBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024, maxUntracked: 200, maxStatusFiles: 1000, maxRefLength: 255 });

/**
 * Limits of non-image attachments (capability `attachments`, docs/protocol/alp-json-rpc-v1.md
 * §12.6): an object of at most `maxObjectBytes`; a prompt of at most `maxPerPrompt` attachments and
 * `maxPromptBytes` together; chunks of at most `maxChunkBytes` decoded (lowered further by
 * attachmentChunkBytes to fit a frame); `maxActiveUploads` incomplete uploads and
 * `maxPrincipalBytes` stored per principal, `maxDaemonBytes` per daemon, retained references
 * included. An incomplete upload expires after `uploadTimeoutMs`; an unreferenced committed object
 * is purged after `unreferencedRetentionMs`, one whose references were all released after
 * `releasedGraceMs`. A display name is at most `maxNameBytes` UTF-8 bytes. An operator or a gateway
 * may lower them, never raise them; daemon.hello advertises the effective ones (`attachmentLimits`).
 */
export const ATTACHMENTS = Object.freeze({
  maxObjectBytes: 20 * 1024 * 1024,
  maxPerPrompt: 8,
  maxPromptBytes: 40 * 1024 * 1024,
  maxChunkBytes: 256 * 1024,
  maxActiveUploads: 2,
  maxPrincipalBytes: 200 * 1024 * 1024,
  maxDaemonBytes: 1024 * 1024 * 1024,
  uploadTimeoutMs: 60 * 60 * 1000,
  unreferencedRetentionMs: 24 * 60 * 60 * 1000,
  releasedGraceMs: 7 * 24 * 60 * 60 * 1000,
  maxNameBytes: 255,
});
/** Room an attachment.chunk request needs besides its base64 data. */
export const ATTACHMENT_CHUNK_OVERHEAD = 64 * 1024;
/**
 * The decoded bytes one attachment.chunk may carry over frames of at most `maxFrame` bytes:
 * `maxChunkBytes`, lowered so its base64 and ATTACHMENT_CHUNK_OVERHEAD fit. At least 1 byte.
 * @param {number} [maxFrame] @param {number} [maxChunkBytes]
 */
export function attachmentChunkBytes(maxFrame = MAX_FRAME, maxChunkBytes = ATTACHMENTS.maxChunkBytes) {
  const fits = Math.floor((maxFrame - ATTACHMENT_CHUNK_OVERHEAD) * 3 / 4);
  return Math.max(1, Math.min(maxChunkBytes, fits));
}

/** Directories whose whole content is refused: Git's, ALP's own configuration (its library overrides hold env values), and key and cloud-credential stores. */
const BLOCKED_DIRECTORIES = new Set(['.git', '.alp', '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.docker', 'gcloud']);
/** Files that hold credentials by convention. */
const BLOCKED_NAMES = new Set(['.netrc', '_netrc', '.npmrc', '.yarnrc.yml', '.pypirc', '.pgpass', '.htpasswd', '.git-credentials', '.dockercfg', '.boto', '.s3cfg', '.mcp.json', 'auth.json', 'kubeconfig', 'settings.local.json', '.vault-token', 'application_default_credentials.json', 'token.json']);
/** Credential files known by their directory too: GitHub CLI's token file. */
const BLOCKED_PAIRS = new Set(['gh/hosts.yml']);
/** Names of credential files before their first dot (a leading dot aside): credentials.json, .credentials.json, secrets.yaml, a secrets/ directory. */
const BLOCKED_STEMS = new Set(['credential', 'credentials', 'secret', 'secrets']);
/**
 * Source code is not a credential store: src/credentials.ts, lib/secrets.py stay readable (the stem
 * rule only; never a data or config format such as json, yaml, toml, ini, xml, txt). alpd's
 * private-key check still applies to them.
 */
const SOURCE_EXTENSIONS = new Set(['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'rb', 'php', 'cs', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'm', 'mm', 'scala', 'dart', 'vue', 'svelte']);
/** Key, certificate-store, keyring and Terraform-state extensions. */
const BLOCKED_EXTENSIONS = new Set(['pem', 'key', 'p12', 'pfx', 'p8', 'jks', 'keystore', 'ppk', 'der', 'gpg', 'pgp', 'asc', 'kdbx', 'ovpn', 'tfstate', 'tfvars']);
/** .env and every name starting with it (.env.local, .envrc); id_* (SSH keys: id_rsa, id_ed25519.pub, id_work); service-account keys; shell and REPL histories; Terraform state backups. */
const BLOCKED_PATTERN = /^(?:\.env|id_|service[-_]?account)|_history$|\.tfstate\.backup$/;

/**
 * Whether a path relative to a workspace names something workspace.files.list and
 * workspace.files.read never show, whatever the grant: a segment that is a blocked directory, or
 * any segment (file or directory) named as a secret is (BLOCKED_* above). Compared without case,
 * as macOS and Windows file systems name files. alpd and the gateway both check it; alpd also
 * refuses a file whose content holds a private key, whatever its name.
 * @param {string} relative a path relative to the workspace, '/'-separated
 */
export function blockedFilePath(relative) {
  let previous = '';
  for (const segment of String(relative).toLowerCase().split(/[\\/]/)) {
    if (!segment) continue;
    if (BLOCKED_PAIRS.has(`${previous}/${segment}`)) return true;
    previous = segment;
    if (BLOCKED_DIRECTORIES.has(segment) || BLOCKED_NAMES.has(segment) || BLOCKED_PATTERN.test(segment)) return true;
    const dot = segment.lastIndexOf('.');
    const extension = dot >= 0 ? segment.slice(dot + 1) : '';
    if (BLOCKED_EXTENSIONS.has(extension)) return true;
    // Any dotted part of the name but its extension: secrets.yaml, prod.secrets.yaml, .credentials.json.
    const parts = segment.replace(/^\.+/, '').split('.');
    if (parts.length > 1) parts.pop();
    if (parts.some(part => BLOCKED_STEMS.has(part)) && !SOURCE_EXTENSIONS.has(extension)) return true;
  }
  return false;
}

/** UTF-8 socket writers use one newline-terminated JSON value per frame. @param {unknown} value */
export function encodeFrame(value) { return `${JSON.stringify(value)}\n`; }
/** Parse one complete frame. Buffering and failure handling belong to the socket owner. @param {string} line @returns {unknown} */
export function decodeFrame(line) { return JSON.parse(line); }

/**
 * The command lines of session.resumeCommand (docs/protocol/alp-json-rpc-v1.md §12.8), built from argv
 * so that every argument reaches the program as it is: for a POSIX shell (sh, bash, zsh) and for
 * Windows cmd.exe, typed at its prompt and then read again by npm's `alp.cmd` shim (`%*`). An argument
 * with a control character (a line break would run a pasted command early) is refused, and for cmd.exe
 * one with `"`, `%` or `!` too: a quote inside an argument ends the shim's quoting and lets the rest
 * run, and `%`/`!` expand variables in either parse, so no escaping keeps them (session ids have none).
 */
const POSIX_SAFE = /^[A-Za-z0-9_@+:,./-]+$/;
const WINDOWS_SAFE = /^[A-Za-z0-9_@+:./\\-]+$/;
const assertArgument = (/** @type {unknown} */ arg) => {
  if (typeof arg !== 'string') throw new TypeError('A command argument is a string');
  if (/[\u0000-\u001f\u007f]/.test(arg)) throw new TypeError('A command argument has no control characters');
  return arg;
};
/** One argument for a POSIX shell: as it is when nothing in it is special, else in single quotes. @param {string} arg */
export function quotePosix(arg) {
  const text = assertArgument(arg);
  return text && POSIX_SAFE.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}
/**
 * One argument for cmd.exe: as it is when nothing in it is special; else in double quotes for the C
 * runtime's split (backslashes before the closing quote doubled), with every cmd.exe metacharacter,
 * the quotes too, escaped with ^ for the interactive parse; the shim's second parse then sees one
 * quoted argument, inside which `&|<>()^` are literal. `"`, `%` and `!` are refused (see above).
 * @param {string} arg
 */
export function quoteWindows(arg) {
  const text = assertArgument(arg);
  if (text && WINDOWS_SAFE.test(text)) return text;
  if (/["%!]/.test(text)) throw new TypeError('A cmd.exe command argument has no ", % or !');
  const quoted = `"${text.replace(/(\\*)$/, '$1$1')}"`;
  return quoted.replace(/([()\][^"`<>&|;, *?])/g, '^$1');
}
const SESSION_ID = /^[\w.:-]{1,128}$/;
/** argv as one command line. @param {string[]} argv @param {'posix' | 'windows'} platform */
export function commandLine(argv, platform) {
  return argv.map(platform === 'windows' ? quoteWindows : quotePosix).join(' ');
}
/**
 * session.resumeCommand's answer for a session: `alp attach <sessionId>`, which follows the session in
 * a terminal (a closed one says how to send it a message). ALP keeps the orchestration, so it is never
 * a native runtime's own resume command.
 * @param {string} sessionId @param {'posix' | 'windows'} platform the daemon host's
 */
export function resumeCommandOf(sessionId, platform) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) throw new TypeError('A session id is [A-Za-z0-9_.:-], at most 128 characters');
  const argv = ['alp', 'attach', sessionId];
  const posix = commandLine(argv, 'posix');
  const windows = commandLine(argv, 'windows');
  return { argv, posix, windows, display: platform === 'windows' ? windows : posix, platform };
}
