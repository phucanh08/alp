import type { RpcMethodMap } from '@anhlp/alp-protocol';

/** A client the typed registries call: any object with `request`, as AlpRpcClient has. */
// any: the result type is named per method by R<> below.
export type RequestClient = { request<T = any>(method: string, params?: unknown): Promise<T> };
type P<K extends keyof RpcMethodMap> = RpcMethodMap[K]['params'];
type R<K extends keyof RpcMethodMap> = Promise<RpcMethodMap[K]['result']>;
export type UploadOptions = { sessionId: string, name: string, mimeType: string, data: Uint8Array, requestId: string, sha256?: string, maxChunkBytes?: number, signal?: AbortSignal, onBegun?: (uploadId: string) => void, onProgress?: (received: number, size: number) => void };
// any: abort accepts any reason value, as AbortController.abort does.
export type Upload = Promise<RpcMethodMap['attachment.commit']['result']['attachment']> & { readonly uploadId?: string, abort(reason?: any): Promise<void> };

/** Typed registry methods for portable clients. Mutations are sent once: callers retain requestId
 * and ifRevision to reconcile a timeout by repeating the identical request. */
export function workspaceRegistry(client: RequestClient) {
  return {
    worktreeOptions: (workspaceId: string): R<'workspace.worktree.options'> => client.request('workspace.worktree.options', { workspaceId }),
    createWorktree: (params: P<'workspace.worktree.create'>): R<'workspace.worktree.create'> => client.request('workspace.worktree.create', params),
    removeWorktree: (params: P<'workspace.worktree.remove'>): R<'workspace.worktree.remove'> => client.request('workspace.worktree.remove', params),
    /** Read-only Git status of a registry workspace (capability `workspace.git`, §12.5). */
    gitStatus: (workspaceId: string): R<'workspace.git.status'> => client.request('workspace.git.status', { workspaceId }),
    /** One page of a read-only Git diff; pass `nextCursor` back as `cursor` with the same comparison and path. */
    gitDiff: (params: P<'workspace.git.diff'>): R<'workspace.git.diff'> => client.request('workspace.git.diff', params),
    projects: (params: P<'project.list'> = {}): R<'project.list'> => client.request('project.list', params),
    workspaces: (params: P<'workspace.list'> = {}): R<'workspace.list'> => client.request('workspace.list', params),
    get: (workspaceId: string): R<'workspace.get'> => client.request('workspace.get', { workspaceId }),
    register: (params: P<'project.register'>): R<'project.register'> => client.request('project.register', params),
    remove: (params: P<'project.remove'>): R<'project.remove'> => client.request('project.remove', params),
    update: (params: P<'workspace.update'>): R<'workspace.update'> => client.request('workspace.update', params),
  };
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Canonical base64 of `bytes`, without Buffer or btoa, so it runs in browsers and Node alike. */
export function base64Encode(bytes: Uint8Array): string {
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

/** Lowercase hex SHA-256 of `bytes` through WebCrypto (browsers' secure contexts, Node 19+). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('SHA-256 needs WebCrypto here; pass sha256 yourself');
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Typed attachment methods (capability `attachments`, docs/protocol/alp-json-rpc-v1.md §12.6) and a
 * chunked upload that keeps to the limits the daemon (or gateway) advertised. Mutations are sent
 * once: `upload` resumes an interrupted upload by repeating its begin with the same requestId and
 * continues from what the daemon holds.
 */
export function attachments(client: RequestClient) {
  const api = {
    begin: (params: P<'attachment.begin'>): R<'attachment.begin'> => client.request('attachment.begin', params),
    chunk: (params: P<'attachment.chunk'>): R<'attachment.chunk'> => client.request('attachment.chunk', params),
    commit: (params: P<'attachment.commit'>): R<'attachment.commit'> => client.request('attachment.commit', params),
    abort: (uploadId: string): R<'attachment.abort'> => client.request('attachment.abort', { uploadId }),
    /** Metadata only (no bytes, no path). */
    get: (attachmentId: string): R<'attachment.get'> => client.request('attachment.get', { attachmentId }),
    /** Refused (1004 attachment_referenced) while a prompt references it. */
    delete: (attachmentId: string): R<'attachment.delete'> => client.request('attachment.delete', { attachmentId }),
    /**
     * Uploads `data` and commits it: begin (or resume, with the same requestId), chunks of at most
     * the smaller of `maxChunkBytes` and what begin answered, commit with its SHA-256. A chunk
     * refused `offset_mismatch` continues from the daemon's `received`. Returns the attachment.
     * The returned promise exposes `.uploadId` once begun and `.abort(reason?: any)` to abort on alpd.
     */
    upload({ sessionId, name, mimeType, data, requestId, sha256, maxChunkBytes, signal, onBegun, onProgress }: UploadOptions): Upload {
      let uploadId: string | undefined;
      let userAborted = false;
      let userAbortReason: unknown;
      const isAborted = () => userAborted || (signal?.aborted ?? false);
      const getAbortReason = () => userAbortReason ?? signal?.reason ?? new Error('Upload aborted');

      const onSignalAbort = () => {
        if (uploadId) api.abort(uploadId).catch(() => {});
      };
      signal?.addEventListener?.('abort', onSignalAbort, { once: true });

      const run = ((async () => {
        try {
          if (isAborted()) throw getAbortReason();
          const digest = sha256 ?? await sha256Hex(data);
          if (isAborted()) throw getAbortReason();
          const begun = await api.begin({ sessionId, name, size: data.length, mimeType, sha256: digest, requestId });
          uploadId = begun.uploadId;
          try { onBegun?.(begun.uploadId); }
          catch (error) {
            if (begun.state !== 'committed') await api.abort(begun.uploadId).catch(() => {});
            throw error;
          }
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
              // any: a JSON-RPC error's data; its reason and received are checked before use.
              const held = (error as any)?.data;
              // Another attempt got further (or less far) than this one knew: continue where the daemon is.
              if (held?.reason !== 'offset_mismatch' || !Number.isSafeInteger(held.received) || ++realigned > 3) throw error;
              offset = held.received;
              continue;
            }
            if (isAborted()) {
              await api.abort(begun.uploadId).catch(() => {});
              throw getAbortReason();
            }
            try { onProgress?.(offset, data.length); }
            catch (error) {
              await api.abort(begun.uploadId).catch(() => {});
              throw error;
            }
          }
          if (isAborted()) {
            await api.abort(begun.uploadId).catch(() => {});
            throw getAbortReason();
          }
          return (await api.commit({ uploadId: begun.uploadId, sha256: digest })).attachment;
        } finally {
          signal?.removeEventListener?.('abort', onSignalAbort);
        }
      })()) as Promise<RpcMethodMap['attachment.commit']['result']['attachment']> & { uploadId?: string, abort(reason?: unknown): Promise<void> };

      Object.defineProperty(run, 'uploadId', {
        get: () => uploadId,
        enumerable: true,
      });
      run.abort = async (reason?: unknown) => {
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
 */
export function conversation(client: RequestClient) {
  return {
    /**
     * A new closed root whose conversation is the source root's through or before a turn (`boundary`),
     * or a branch a rewind set aside (`branchId`); resume it with session.create { sessionId, resume: true }.
     * Principal fields are set by a trusted gateway on its own connection, never by a remote client.
     */
    fork: (params: P<'session.fork'>): R<'session.fork'> => client.request('session.fork', params),
    /**
     * Continues the root's conversation from before `beforeTurnId` under the same session id; the
     * later turns stay a branch (`branch.branchId`) that `fork({ branchId })` recovers.
     */
    rewind: (params: P<'session.rewind'>): R<'session.rewind'> => client.request('session.rewind', params),
    /**
     * Restarts a live root's native process on its own conversation and configuration at the idle
     * barrier (capability `session.reload`, §12.8); id, history and receipts stay. Sent once: repeat
     * the same `requestId` after a lost answer.
     */
    reload: (params: P<'session.reload'>): R<'session.reload'> => client.request('session.reload', params),
    /**
     * The ALP CLI command that follows the session in a terminal (capability `session.resumeCommand`,
     * §12.8), built by alpd: for the clipboard only, never to run.
     */
    resumeCommand: (params: P<'session.resumeCommand'>): R<'session.resumeCommand'> => client.request('session.resumeCommand', params),
    /** The slash commands and skills the session's composer offers after "/" (capability `session.commands`, §12.12). */
    commands: (params: P<'session.commands'>): R<'session.commands'> => client.request('session.commands', params),
    /**
     * Changes a live root's model, effort or team (capability `session.configure.live`, §12.9) at the
     * idle barrier, through a restart of its native process on the same conversation; `configured` says
     * what it runs with now. Sent once: repeat the same `requestId` after a lost answer. A change to
     * another runtime is refused (1005 runtime_mismatch, `data.action: 'session.create'`).
     */
    configure: (params: P<'session.configure'> & { requestId: string; ifGeneration: string }): R<'session.configure'> => client.request('session.configure', params),
    /**
     * What a change of model, effort, team or mode would run a live root with, and whether it would be
     * taken now (capability `session.configure.live`, §12.9). Reads only.
     */
    configurePreview: (params: P<'session.configure.preview'>): R<'session.configure.preview'> => client.request('session.configure.preview', params),
  };
}
