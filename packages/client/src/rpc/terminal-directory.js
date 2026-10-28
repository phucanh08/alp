/**
 * A terminal directory for one connection. Subscribe before requesting the atomic snapshot.
 * Invalidations are coalesced; a reconnect installs a new watcher and replaces state with its
 * full snapshot (reset), rather than replaying obsolete list mutations. No output is replayed.
 * @param {{request<T = any>(method:string, params?:any):Promise<T>, onNotification?(listener:(method:string,params:any)=>void):()=>void, onClose(listener:(error:Error)=>void):()=>void}} connection
 * @param {{capabilities:readonly string[], workspaceId?:string, pollMs?:number, onSnapshot:(terminals:import('@anhlp/alp-protocol').TerminalInfo[])=>void, onError?:(error:unknown)=>void, onMode?:(mode:'events'|'polling')=>void}} options
 */
export function watchTerminals(connection, options) {
  const events = options.capabilities.includes('terminal.watch') && !!connection.onNotification;
  let closed = false;
  let watchId = '';
  let cursor = '';
  let again = false;
  /** @type {Promise<void> | undefined} */ let refreshing;
  // One newest token per watchId; bounded even when the host sends malformed/stale traffic.
  /** @type {Map<string,string>} */ const pending = new Map();
  const off = connection.onNotification?.((method, params) => {
    if (closed || !events || method !== 'terminal.changed' || !/^[0-9a-f]{32}$/.test(params?.watchId) || !/^[0-9a-f]{32}$/.test(params?.cursor)) return;
    if (pending.size >= 4 && !pending.has(params.watchId)) pending.delete(pending.keys().next().value ?? '');
    pending.set(params.watchId, params.cursor);
    if (params.watchId === watchId && params.cursor !== cursor) { again = true; void refresh(); }
  });
  function refresh() {
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
  /** @param {boolean} [unwatch] */
  function close(unwatch = true) {
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
