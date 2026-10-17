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
export const CAPABILITY = Object.freeze({ attachAfter: 'attach.after', promptReceipts: 'prompt.receipts', extensionMethods: 'extension.methods', team: 'team', task: 'task', library: 'library', settingsLanguage: 'settings.language', sessionListPage: 'session.list.page', questionWatch: 'question.watch', questionWatchTurns: 'question.watch.turns', workspaceFiles: 'workspace.files', promptImages: 'prompt.images' });
/**
 * What alpd takes as images in one session.prompt (capability `prompt.images`): inline base64 of
 * these types only, never a path or URL; at most `maxCount` of them, each at most `maxBytes`
 * decoded, and `maxTotalBytes` together, so their base64 fits one MAX_FRAME. A gateway may allow
 * less (docs/alp/remote-gateway.md).
 */
export const PROMPT_IMAGES = Object.freeze({ mimeTypes: Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']), maxCount: 8, maxBytes: 5 * 1024 * 1024, maxTotalBytes: 11 * 1024 * 1024 });
/** Decoded bytes of base64 `data` (padding aware), without decoding it. @param {string} data */
export const base64Bytes = data => Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
export const RPC_METHODS = Object.freeze(["assignment.recall", "board.list", "catalog.get", "daemon.hello", "daemon.pause", "daemon.pauses", "daemon.resume", "daemon.shutdown", "daemon.status", "daemon.usage", "extension.register", "extension.unregister", "library.delete", "library.duplicate", "library.get", "library.list", "library.models", "library.rename", "library.save", "library.skills.set", "question.answer", "question.list", "question.watch", "session.archive", "session.attach", "session.close", "session.configure", "session.create", "session.get", "session.interrupt", "session.list", "session.log", "session.message", "session.preview", "session.prompt", "session.release", "session.rename", "session.status", "settings.language.get", "settings.language.set", "task.create", "task.gate.resolve", "task.list", "task.update", "team.list", "workspace.files.search"]);

/** UTF-8 socket writers use one newline-terminated JSON value per frame. @param {unknown} value */
export function encodeFrame(value) { return `${JSON.stringify(value)}\n`; }
/** Parse one complete frame. Buffering and failure handling belong to the socket owner. @param {string} line @returns {unknown} */
export function decodeFrame(line) { return JSON.parse(line); }
