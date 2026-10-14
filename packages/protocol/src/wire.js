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
export const RPC_METHODS = Object.freeze(["assignment.recall", "board.list", "catalog.get", "daemon.hello", "daemon.pause", "daemon.pauses", "daemon.resume", "daemon.shutdown", "daemon.status", "daemon.usage", "extension.register", "extension.unregister", "question.answer", "question.list", "session.archive", "session.attach", "session.close", "session.configure", "session.create", "session.get", "session.interrupt", "session.list", "session.log", "session.message", "session.preview", "session.prompt", "session.release", "session.rename", "session.status"]);

/** UTF-8 socket writers use one newline-terminated JSON value per frame. @param {unknown} value */
export function encodeFrame(value) { return `${JSON.stringify(value)}\n`; }
/** Parse one complete frame. Buffering and failure handling belong to the socket owner. @param {string} line @returns {unknown} */
export function decodeFrame(line) { return JSON.parse(line); }
