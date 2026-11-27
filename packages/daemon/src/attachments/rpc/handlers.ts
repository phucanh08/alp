/**
 * attachment.* (§12.6): each call acts for its principal context; without the store (no home or
 * store, or Windows) alpd does not serve them, as for any method it does not know. alpd spreads
 * them into its handler table (server.ts).
 */
import { ERROR, RPC_ERROR } from '@anhlp/alp-protocol';
import type { createLogger } from '@anhlp/alp-core/log';
import { RpcError } from '../../rpc/rpc-error.ts';
import { principalOf } from '../../rpc/helpers.ts';
import type { Connection } from '../../rpc/connection.ts';
import type { createAttachmentStore } from '../attachments.ts';

// any: params arrive as JSON; the store checks the fields it reads.
type AttachmentHandler = (connection: Connection, params: any) => Promise<unknown>;
type AttachmentMethod = 'attachment.begin' | 'attachment.chunk' | 'attachment.commit' | 'attachment.abort' | 'attachment.get' | 'attachment.delete';

/** The handlers over this daemon's attachment store, or none (every call refused as unknown). */
export function createAttachmentHandlers({ attachments, log }: {
  attachments: ReturnType<typeof createAttachmentStore> | undefined;
  log: ReturnType<typeof createLogger>;
}): Record<AttachmentMethod, AttachmentHandler> {
  const attachmentCall = async <T>(run: (store: NonNullable<typeof attachments>) => Promise<T>) => {
    if (!attachments) throw new RpcError(RPC_ERROR.methodNotFound, 'This alpd does not store attachments (capability attachments is not listed)');
    try {
      return await run(attachments);
    } catch (error) {
      if (error instanceof RpcError) throw error;
      log.warn('attachment call failed', { code: 'ALPD_ATTACHMENT_FAILED', error });
      throw new RpcError(ERROR.failed, 'alpd could not store the attachment; the upload was aborted', { reason: 'persistence_failed' });
    }
  };
  return {
    'attachment.begin': (_c, p) => attachmentCall(store => store.begin(principalOf(p), p)),
    'attachment.chunk': (_c, p) => attachmentCall(store => store.chunk(principalOf(p), p)),
    'attachment.commit': (_c, p) => attachmentCall(store => store.commit(principalOf(p), p)),
    'attachment.abort': (_c, p) => attachmentCall(store => store.abort(principalOf(p), p)),
    'attachment.get': (_c, p) => attachmentCall(store => store.get(principalOf(p), p)),
    'attachment.delete': (_c, p) => attachmentCall(store => store.remove(principalOf(p), p)),
  };
}
