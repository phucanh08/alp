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
export const CAPABILITY = Object.freeze({ attachAfter: 'attach.after', promptReceipts: 'prompt.receipts', extensionMethods: 'extension.methods', team: 'team', task: 'task', library: 'library', settingsLanguage: 'settings.language', sessionListPage: 'session.list.page', questionWatch: 'question.watch', questionWatchTurns: 'question.watch.turns', workspaceFiles: 'workspace.files', workspaceFilesRead: 'workspace.files.read', promptImages: 'prompt.images' });
/**
 * What alpd takes as images in one session.prompt (capability `prompt.images`): inline base64 of
 * these types only, never a path or URL; at most `maxCount` of them, each at most `maxBytes`
 * decoded, and `maxTotalBytes` together, so their base64 fits one MAX_FRAME. A gateway may allow
 * less (docs/alp/remote-gateway.md).
 */
export const PROMPT_IMAGES = Object.freeze({ mimeTypes: Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']), maxCount: 8, maxBytes: 5 * 1024 * 1024, maxTotalBytes: 11 * 1024 * 1024 });
/** Decoded bytes of base64 `data` (padding aware), without decoding it. @param {string} data */
export const base64Bytes = data => Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
export const RPC_METHODS = Object.freeze(["assignment.recall", "board.list", "catalog.get", "daemon.hello", "daemon.pause", "daemon.pauses", "daemon.resume", "daemon.shutdown", "daemon.status", "daemon.usage", "extension.register", "extension.unregister", "library.delete", "library.duplicate", "library.get", "library.list", "library.models", "library.rename", "library.save", "library.skills.set", "question.answer", "question.list", "question.watch", "session.archive", "session.attach", "session.close", "session.configure", "session.create", "session.get", "session.interrupt", "session.list", "session.log", "session.message", "session.preview", "session.prompt", "session.release", "session.rename", "session.status", "settings.language.get", "settings.language.set", "task.create", "task.gate.resolve", "task.list", "task.update", "team.list", "workspace.files.list", "workspace.files.read", "workspace.files.search"]);

/**
 * Limits of workspace.files.list and workspace.files.read (capability `workspace.files.read`,
 * docs/protocol/alp-json-rpc-v1.md §12.4): a file of at most `maxReadBytes`, a listing of at most
 * `maxListEntries` entries, a relative path of at most `maxPathLength` characters.
 */
export const WORKSPACE_FILES = Object.freeze({ maxReadBytes: 1024 * 1024, maxListEntries: 1000, maxPathLength: 4096 });

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
