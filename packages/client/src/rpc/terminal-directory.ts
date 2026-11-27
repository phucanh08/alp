import type { TerminalInfo } from '@anhlp/alp-protocol';

// any: request results and notification params are daemon JSON, checked field by field below.
export type TerminalConnection = { request<T = any>(method: string, params?: any): Promise<T>, onNotification?(listener: (method: string, params: any) => void): () => void, onClose(listener: (error: Error) => void): () => void };
export type WatchTerminalsOptions = { capabilities: readonly string[], workspaceId?: string, pollMs?: number, onSnapshot: (terminals: TerminalInfo[]) => void, onError?: (error: unknown) => void, onMode?: (mode: 'events' | 'polling') => void };

/**
 * A terminal directory for one connection. Subscribe before requesting the atomic snapshot.
 * Invalidations are coalesced; a reconnect installs a new watcher and replaces state with its
 * full snapshot (reset), rather than replaying obsolete list mutations. No output is replayed.
 */
export function watchTerminals(connection: TerminalConnection, options: WatchTerminalsOptions) {
  const events = options.capabilities.includes('terminal.watch') && !!connection.onNotification;
  let closed = false;
  let watchId = '';
  let cursor = '';
  let again = false;
  let refreshing: Promise<void> | undefined;
  // One newest token per watchId; bounded even when the host sends malformed/stale traffic.
  const pending = new Map<string, string>();
  const off = connection.onNotification?.((method, params) => {
    if (closed || !events || method !== 'terminal.changed' || !/^[0-9a-f]{32}$/.test(params?.watchId) || !/^[0-9a-f]{32}$/.test(params?.cursor)) return;
    if (pending.size >= 4 && !pending.has(params.watchId)) pending.delete(pending.keys().next().value ?? '');
    pending.set(params.watchId, params.cursor);
    if (params.watchId === watchId && params.cursor !== cursor) { again = true; void refresh(); }
  });
  function refresh(): Promise<void> {
    if (closed) return Promise.resolve();
    if (refreshing) return refreshing;
    refreshing = (async () => {
      do {
        again = false;
        try {
          const result = await connection.request(events ? 'terminal.watch' : 'terminal.list', { ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}), ...(events && cursor ? { after: cursor } : {}) });
          if (closed) return;
          if (!Array.isArray(result?.terminals)) throw new Error('Invalid terminal directory snapshot');
          if (events) {
            if (!/^[0-9a-f]{32}$/.test(result.watchId) || !/^[0-9a-f]{32}$/.test(result.cursor) || typeof result.reset !== 'boolean') throw new Error('Invalid terminal directory cursor');
            watchId = result.watchId;
            cursor = result.cursor;
            again = pending.has(watchId) && pending.get(watchId) !== cursor;
            pending.clear();
          }
          options.onSnapshot(result.terminals);
        } catch (error) { options.onError?.(error); return; }
      } while (again && !closed);
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  }
  const timer = events ? undefined : setInterval(() => { void refresh(); }, options.pollMs ?? 5000);
  let offClose = () => {};
  function close(unwatch: boolean = true) {
    if (closed) return;
    closed = true;
    if (timer !== undefined) clearInterval(timer);
    off?.(); offClose(); pending.clear();
    if (events && unwatch) void connection.request('terminal.unwatch', {}).catch(() => {});
  }
  offClose = connection.onClose(() => close(false));
  if (closed) offClose();
  options.onMode?.(events ? 'events' : 'polling');
  const ready = refresh();
  return { ready, refresh, close, mode: events ? 'events' : 'polling' };
}
