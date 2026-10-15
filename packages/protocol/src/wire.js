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

export const ERROR = Object.freeze({ failed: 1000, notFound: 1001, conflict: 1004, protocol: 1006 });
/** The JSON-RPC 2.0 codes alpd answers with (docs/protocol/alp-json-rpc-v1.md §5). */
export const RPC_ERROR = Object.freeze({ parseError: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602 });
/**
 * Features a daemon lists in its daemon.hello result. A client uses a feature only when listed;
 * a daemon that lists none (one older than this list) has none of them. Unknown names are ignored.
 */
export const CAPABILITY = Object.freeze({ attachAfter: 'attach.after', promptReceipts: 'prompt.receipts', extensionMethods: 'extension.methods' });
export const RPC_METHODS = Object.freeze(["assignment.recall", "board.list", "catalog.get", "daemon.hello", "daemon.pause", "daemon.pauses", "daemon.resume", "daemon.shutdown", "daemon.status", "daemon.usage", "extension.register", "extension.unregister", "question.answer", "question.list", "session.archive", "session.attach", "session.close", "session.configure", "session.create", "session.get", "session.interrupt", "session.list", "session.log", "session.message", "session.preview", "session.prompt", "session.release", "session.rename", "session.status"]);

/** UTF-8 socket writers use one newline-terminated JSON value per frame. @param {unknown} value */
export function encodeFrame(value) { return `${JSON.stringify(value)}\n`; }
/** Parse one complete frame. Buffering and failure handling belong to the socket owner. @param {string} line @returns {unknown} */
export function decodeFrame(line) { return JSON.parse(line); }
