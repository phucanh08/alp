import { AlpRpcClient, createReconnectingClient, hello } from '@anhlp/alp-client/portable';
import type { AlpTransport } from '@anhlp/alp-client/portable';
import type { Logger } from '@anhlp/alp-core/log';
import type { Upstream } from './connection.js';

/**
 * The gateway's side of alpd: client SDK connections over the daemon's private IPC socket. The
 * gateway never starts alpd and never reads its files; it only connects, as any local client.
 */
export type { AlpTransport };
export type OpenTransport = () => Promise<AlpTransport>;

const HELLO_TIMEOUT_MS = 10_000;

/** Opens one handshaken connection per remote client. */
export function upstreamConnector({ openTransport, version, maxPending }: { openTransport: OpenTransport, version: string, maxPending: number }): () => Promise<Upstream> {
  return async () => {
    // A little room above the client's own limit for the gateway's scope lookups.
    const client = new AlpRpcClient(await openTransport(), { maxPending: maxPending * 2 + 16 });
    try {
      const result = await hello(client, { name: 'alp-gateway', version }, { timeoutMs: HELLO_TIMEOUT_MS });
      return { client, hello: result };
    } catch (error) {
      client.close();
      throw error;
    }
  };
}

/**
 * Readiness: a connection of its own that keeps reconnecting and asks daemon.status every
 * `intervalMs`. Ready means alpd answers and reports itself ready (its state can be written).
 */
export function daemonMonitor({ openTransport, version, intervalMs = 5_000, logger }: { openTransport: OpenTransport, version: string, intervalMs?: number, logger?: Logger }) {
  let state: { connected: boolean, ready: boolean, code?: string, checkedAt?: string } = { connected: false, ready: false, code: 'ALP_GATEWAY_DAEMON_UNREACHABLE' };
  let previous = '';
  const set = (next: typeof state) => {
    state = { ...next, checkedAt: new Date().toISOString() };
    const summary = `${state.connected}:${state.ready}:${state.code ?? ''}`;
    if (summary !== previous) {
      previous = summary;
      logger?.[state.ready ? 'info' : 'warn'](state.ready ? 'alpd is ready' : 'alpd is not ready', { code: state.code ?? 'ALP_GATEWAY_DAEMON_READY' });
    }
  };
  const connection = createReconnectingClient({
    connect: () => openTransport(),
    onConnect: client => hello(client, { name: 'alp-gateway-monitor', version }, { timeoutMs: HELLO_TIMEOUT_MS }),
    backoff: { initialMs: 250, maxMs: 5_000 },
    // An incompatible daemon may be replaced by a compatible one: keep trying.
    shouldRetry: () => true,
  });
  async function check() {
    if (connection.state !== 'open') { set({ connected: false, ready: false, code: 'ALP_GATEWAY_DAEMON_UNREACHABLE' }); return; }
    try {
      const status = await connection.request('daemon.status', {}, { timeoutMs: Math.min(intervalMs, 3_000) });
      const ready = status?.health?.ready === true;
      set({ connected: true, ready, ...(ready ? {} : { code: 'ALP_GATEWAY_DAEMON_NOT_READY' }) });
    } catch {
      set({ connected: connection.state === 'open', ready: false, code: 'ALP_GATEWAY_DAEMON_UNREACHABLE' });
    }
  }
  connection.onState(next => { if (next === 'open') void check(); else if (state.connected) set({ connected: false, ready: false, code: 'ALP_GATEWAY_DAEMON_UNREACHABLE' }); });
  const timer = setInterval(() => void check(), intervalMs);
  timer.unref?.();
  return {
    get state() { return state; },
    check,
    /**
     * Ends every terminal of a credential at once (terminal.revoke, docs/protocol/alp-json-rpc-v1.md
     * §12.10): a revoked, rotated, expired or regranted credential keeps no shell. When alpd cannot be
     * asked now, its own detach timeout ends them once their connections have closed.
     */
    async revokeTerminals(principalId: string) {
      if (connection.state !== 'open') return { revoked: false };
      try {
        const result = await connection.request('terminal.revoke', { principalId }, { timeoutMs: 5_000 });
        return { revoked: true, closed: Number.isSafeInteger(result?.closed) ? result.closed : 0 };
      } catch (error) {
        return { revoked: false, error };
      }
    },
    stop() { clearInterval(timer); connection.stop(); },
  };
}
