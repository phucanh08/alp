/** Typed registry methods for portable clients. Mutations are sent once: callers retain requestId
 * and ifRevision to reconcile a timeout by repeating the identical request. @param {{request<T = any>(method: string, params?: unknown): Promise<T>}} client */
export function workspaceRegistry(client) {
  return {
    /** @param {string} workspaceId @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.worktree.options']['result']>} */
    worktreeOptions: workspaceId => client.request('workspace.worktree.options', { workspaceId }),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['workspace.worktree.create']['params']} params @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.worktree.create']['result']>} */
    createWorktree: params => client.request('workspace.worktree.create', params),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['workspace.worktree.remove']['params']} params @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.worktree.remove']['result']>} */
    removeWorktree: params => client.request('workspace.worktree.remove', params),
    /** Read-only Git status of a registry workspace (capability `workspace.git`, §12.5). @param {string} workspaceId @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.git.status']['result']>} */
    gitStatus: workspaceId => client.request('workspace.git.status', { workspaceId }),
    /** One page of a read-only Git diff; pass `nextCursor` back as `cursor` with the same comparison and path. @param {import('@anhlp/alp-protocol').RpcMethodMap['workspace.git.diff']['params']} params @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.git.diff']['result']>} */
    gitDiff: params => client.request('workspace.git.diff', params),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['project.list']['params']} [params] @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['project.list']['result']>} */
    projects: (params = {}) => client.request('project.list', params),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['workspace.list']['params']} [params] @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.list']['result']>} */
    workspaces: (params = {}) => client.request('workspace.list', params),
    /** @param {string} workspaceId @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.get']['result']>} */
    get: workspaceId => client.request('workspace.get', { workspaceId }),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['project.register']['params']} params @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['project.register']['result']>} */
    register: params => client.request('project.register', params),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['project.remove']['params']} params @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['project.remove']['result']>} */
    remove: params => client.request('project.remove', params),
    /** @param {import('@anhlp/alp-protocol').RpcMethodMap['workspace.update']['params']} params @returns {Promise<import('@anhlp/alp-protocol').RpcMethodMap['workspace.update']['result']>} */
    update: params => client.request('workspace.update', params),
  };
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Canonical base64 of `bytes`, without Buffer or btoa, so it runs in browsers and Node alike. @param {Uint8Array} bytes */
export function base64Encode(bytes) {
  let out = '';
  let index = 0;
  for (; index + 2 < bytes.length; index += 3) {
    const n = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    out += BASE64[n >> 18] + BASE64[(n >> 12) & 63] + BASE64[(n >> 6) & 63] + BASE64[n & 63];
  }
  if (index < bytes.length) {
    const n = (bytes[index] << 16) | ((index + 1 < bytes.length ? bytes[index + 1] : 0) << 8);
    out += BASE64[n >> 18] + BASE64[(n >> 12) & 63] + (index + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=') + '=';
  }
  return out;
}

/** Lowercase hex SHA-256 of `bytes` through WebCrypto (browsers' secure contexts, Node 19+). @param {Uint8Array} bytes */
export async function sha256Hex(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 needs WebCrypto here; pass sha256 yourself');
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Typed attachment methods (capability `attachments`, docs/protocol/alp-json-rpc-v1.md §12.6) and a
 * chunked upload that keeps to the limits the daemon (or gateway) advertised. Mutations are sent
 * once: `upload` resumes an interrupted upload by repeating its begin with the same requestId and
 * continues from what the daemon holds.
 * @param {{request<T = any>(method: string, params?: unknown): Promise<T>}} client
 */
export function attachments(client) {
  /** @typedef {import('@anhlp/alp-protocol').RpcMethodMap} Map */
  const api = {
    /** @param {Map['attachment.begin']['params']} params @returns {Promise<Map['attachment.begin']['result']>} */
    begin: params => client.request('attachment.begin', params),
    /** @param {Map['attachment.chunk']['params']} params @returns {Promise<Map['attachment.chunk']['result']>} */
    chunk: params => client.request('attachment.chunk', params),
    /** @param {Map['attachment.commit']['params']} params @returns {Promise<Map['attachment.commit']['result']>} */
    commit: params => client.request('attachment.commit', params),
    /** @param {string} uploadId @returns {Promise<Map['attachment.abort']['result']>} */
    abort: uploadId => client.request('attachment.abort', { uploadId }),
    /** Metadata only (no bytes, no path). @param {string} attachmentId @returns {Promise<Map['attachment.get']['result']>} */
    get: attachmentId => client.request('attachment.get', { attachmentId }),
    /** Refused (1004 attachment_referenced) while a prompt references it. @param {string} attachmentId @returns {Promise<Map['attachment.delete']['result']>} */
    delete: attachmentId => client.request('attachment.delete', { attachmentId }),
    /**
     * Uploads `data` and commits it: begin (or resume, with the same requestId), chunks of at most
     * the smaller of `maxChunkBytes` and what begin answered, commit with its SHA-256. A chunk
     * refused `offset_mismatch` continues from the daemon's `received`. Returns the attachment.
     * The returned promise exposes `.uploadId` once begun and `.abort(reason?: any)` to abort on alpd.
     * @param {{ sessionId: string, name: string, mimeType: string, data: Uint8Array, requestId: string, sha256?: string, maxChunkBytes?: number, signal?: AbortSignal, onBegun?: (uploadId: string) => void, onProgress?: (received: number, size: number) => void }} options
     * @returns {Promise<Map['attachment.commit']['result']['attachment']> & { readonly uploadId?: string, abort(reason?: any): Promise<void> }}
     */
    upload({ sessionId, name, mimeType, data, requestId, sha256, maxChunkBytes, signal, onBegun, onProgress }) {
      /** @type {string | undefined} */
      let uploadId;
      let userAborted = false;
      let userAbortReason;
      const isAborted = () => userAborted || (signal?.aborted ?? false);
      const getAbortReason = () => userAbortReason ?? signal?.reason ?? new Error('Upload aborted');

      const onSignalAbort = () => {
        if (uploadId) api.abort(uploadId).catch(() => {});
      };
      signal?.addEventListener?.('abort', onSignalAbort, { once: true });

      const run = /** @type {Promise<Map['attachment.commit']['result']['attachment']> & { uploadId?: string, abort(reason?: any): Promise<void> }} */ ((async () => {
        try {
          if (isAborted()) throw getAbortReason();
          const digest = sha256 ?? await sha256Hex(data);
          if (isAborted()) throw getAbortReason();
          const begun = await api.begin({ sessionId, name, size: data.length, mimeType, sha256: digest, requestId });
          uploadId = begun.uploadId;
          onBegun?.(begun.uploadId);
          if (isAborted()) {
            if (begun.state !== 'committed') await api.abort(begun.uploadId).catch(() => {});
            throw getAbortReason();
          }
          if (begun.state === 'committed' && begun.attachmentId) return (await api.get(begun.attachmentId)).attachment;
          const size = Math.max(1, Math.min(begun.maxChunkBytes, maxChunkBytes ?? Infinity));
          let offset = begun.received;
          for (let realigned = 0; offset < data.length;) {
            if (isAborted()) {
              await api.abort(begun.uploadId).catch(() => {});
              throw getAbortReason();
            }
            const end = Math.min(data.length, offset + size);
            try {
              const { received } = await api.chunk({ uploadId: begun.uploadId, offset, data: base64Encode(data.subarray(offset, end)) });
              offset = received;
            } catch (error) {
              if (isAborted()) {
                await api.abort(begun.uploadId).catch(() => {});
                throw getAbortReason();
              }
              const held = /** @type {any} */ (error)?.data;
              // Another attempt got further (or less far) than this one knew: continue where the daemon is.
              if (held?.reason !== 'offset_mismatch' || !Number.isSafeInteger(held.received) || ++realigned > 3) throw error;
              offset = held.received;
              continue;
            }
            if (isAborted()) {
              await api.abort(begun.uploadId).catch(() => {});
              throw getAbortReason();
            }
            onProgress?.(offset, data.length);
          }
          if (isAborted()) {
            await api.abort(begun.uploadId).catch(() => {});
            throw getAbortReason();
          }
          return (await api.commit({ uploadId: begun.uploadId, sha256: digest })).attachment;
        } finally {
          signal?.removeEventListener?.('abort', onSignalAbort);
        }
      })());

      Object.defineProperty(run, 'uploadId', {
        get: () => uploadId,
        enumerable: true,
      });
      run.abort = async (reason) => {
        userAborted = true;
        userAbortReason = reason ?? new Error('Upload aborted');
        if (uploadId) await api.abort(uploadId).catch(() => {});
      };
      return run;
    },
  };
  return api;
}

/**
 * Typed conversation methods (capabilities `session.fork` and `session.rewind`, docs/protocol/
 * alp-json-rpc-v1.md §12.7; `session.reload` and `session.resumeCommand`, §12.8). Both change the conversation only, never a file. Mutations are sent
 * once: keep `requestId` (and `ifGeneration`) to repeat the identical request after a timeout, which
 * answers the first result with `duplicate: true`. After a rewind, attached clients get a
 * `history.reset` event: drop cached history, fetch a new tail and attach with its generation.
 * @param {{request<T = any>(method: string, params?: unknown): Promise<T>}} client
 */
export function conversation(client) {
  /** @typedef {import('@anhlp/alp-protocol').RpcMethodMap} Map */
  return {
    /**
     * A new closed root whose conversation is the source root's through or before a turn (`boundary`),
     * or a branch a rewind set aside (`branchId`); resume it with session.create { sessionId, resume: true }.
     * Principal fields are set by a trusted gateway on its own connection, never by a remote client.
     * @param {Map['session.fork']['params']} params @returns {Promise<Map['session.fork']['result']>}
     */
    fork: params => client.request('session.fork', params),
    /**
     * Continues the root's conversation from before `beforeTurnId` under the same session id; the
     * later turns stay a branch (`branch.branchId`) that `fork({ branchId })` recovers.
     * @param {Map['session.rewind']['params']} params @returns {Promise<Map['session.rewind']['result']>}
     */
    rewind: params => client.request('session.rewind', params),
    /**
     * Restarts a live root's native process on its own conversation and configuration at the idle
     * barrier (capability `session.reload`, §12.8); id, history and receipts stay. Sent once: repeat
     * the same `requestId` after a lost answer.
     * @param {Map['session.reload']['params']} params @returns {Promise<Map['session.reload']['result']>}
     */
    reload: params => client.request('session.reload', params),
    /**
     * The ALP CLI command that follows the session in a terminal (capability `session.resumeCommand`,
     * §12.8), built by alpd: for the clipboard only, never to run.
     * @param {Map['session.resumeCommand']['params']} params @returns {Promise<Map['session.resumeCommand']['result']>}
     */
    resumeCommand: params => client.request('session.resumeCommand', params),
    /**
     * Changes a live root's model, effort or team (capability `session.configure.live`, §12.9) at the
     * idle barrier, through a restart of its native process on the same conversation; `configured` says
     * what it runs with now. Sent once: repeat the same `requestId` after a lost answer. A change to
     * another runtime is refused (1005 runtime_mismatch, `data.action: 'session.create'`).
     * @param {Map['session.configure']['params'] & { requestId: string; ifGeneration: string }} params @returns {Promise<Map['session.configure']['result']>}
     */
    configure: params => client.request('session.configure', params),
    /**
     * What a change of model, effort, team or mode would run a live root with, and whether it would be
     * taken now (capability `session.configure.live`, §12.9). Reads only.
     * @param {Map['session.configure.preview']['params']} params @returns {Promise<Map['session.configure.preview']['result']>}
     */
    configurePreview: params => client.request('session.configure.preview', params),
  };
}
