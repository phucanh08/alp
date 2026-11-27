/**
 * Helpers every RPC handler of alpd shares (server.ts and <domain>/rpc/handlers.ts): request ids,
 * frame sizes, the refusals alpd words the same way everywhere, the principal of a call, and
 * session.list's cursor.
 */
import { createHash } from 'node:crypto';
import { ERROR, RPC_ERROR, encodeFrame } from '@anhlp/alp-protocol';
import type { SessionSummary } from '@anhlp/alp-protocol/session';
import type { Principal } from '../attachments/attachments.ts';
import { RpcError } from './rpc-error.ts';

/** A request id v1 accepts: a string of at most 128 characters or a safe integer (docs/protocol/alp-json-rpc-v1.md §3). */
export function validId(id: unknown): id is string | number {
  if (typeof id !== 'string') return Number.isSafeInteger(id);
  let length = 0;
  for (const _point of id) if (++length > 128) return false;
  return true;
}

/** The bytes a frame takes on a newline-delimited stream, its newline included. */
export const frameBytes = (message: unknown) => Buffer.byteLength(encodeFrame(message), 'utf8');

export const invalidParams = (issues: Array<{ path: string; message: string }>) =>
  new RpcError(RPC_ERROR.invalidParams, `Invalid params: ${issues.map(issue => `${issue.path || 'params'} ${issue.message}`).join('; ')}`, { reason: 'invalid_params', issues });

export const persistenceFailed = (what: string, error: unknown) =>
  new RpcError(ERROR.failed, `alpd could not record ${what}: ${error instanceof Error ? error.message : String(error)}`, { reason: 'persistence_failed' });

/**
 * Who an attachment call acts for: the principal context a trusted gateway puts on its own
 * connection (its credential id and grant epoch, and the canonical workspaces it may use now), or
 * the local owner, as workspace.worktree does (§12.6, §16).
 */
export function principalOf(params: { principalId?: unknown; principalEpoch?: unknown; authorizedRoots?: unknown }): Principal {
  return {
    id: typeof params.principalId === 'string' ? params.principalId : 'owner',
    epoch: typeof params.principalEpoch === 'string' ? params.principalEpoch : 'owner',
    ...(Array.isArray(params.authorizedRoots) ? { roots: params.authorizedRoots.filter((root): root is string => typeof root === 'string') } : {}),
  };
}

/** A stable hash of JSON data, independent of key order (as Paseo's receipts). */
export function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value, (_key, candidate) =>
    candidate !== null && typeof candidate === 'object' && !Array.isArray(candidate)
      ? Object.fromEntries(Object.entries(candidate).sort(([a], [b]) => a.localeCompare(b)))
      : candidate)).digest('hex');
}

/** A shell alpd opens carries no ALP_AGENT_SESSION, so an agent's connection may not open, attach to or type into one (t-ca1f). */
export const agentRefused = (connection: { agent?: boolean }, method: string): undefined => {
  if (connection.agent) throw new RpcError(ERROR.forbidden, `${method} is the user's; this connection was opened by an ALP agent`, { reason: 'user_only' });
  return undefined;
};

/**
 * session.list's order and its keyset cursor: roots before children, the latest `updatedAt`
 * first, then by id, so a page continues after the last session it holds, as Paseo's history pages
 * (server/pagination/sortable-pager.ts at b63a325). The cursor is opaque to clients.
 */
type ListKey = [child: 0 | 1, updatedAt: string, id: string];
export const listCursor = {
  key: (session: SessionSummary): ListKey => [session.parentId ? 1 : 0, session.updatedAt ?? '', session.id],
  compare([childA, updatedA, idA]: ListKey, [childB, updatedB, idB]: ListKey) {
    return childA - childB || (updatedA === updatedB ? 0 : updatedA < updatedB ? 1 : -1) || (idA === idB ? 0 : idA < idB ? -1 : 1);
  },
  encode: (key: ListKey) => Buffer.from(JSON.stringify(key), 'utf8').toString('base64url'),
  decode(cursor: string): ListKey {
    let key: unknown;
    try { key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch {}
    if (!Array.isArray(key) || key.length !== 3 || (key[0] !== 0 && key[0] !== 1) || typeof key[1] !== 'string' || typeof key[2] !== 'string') {
      throw new RpcError(RPC_ERROR.invalidParams, 'cursor is not one session.list answered', { reason: 'invalid_params' });
    }
    return key as ListKey;
  },
};
