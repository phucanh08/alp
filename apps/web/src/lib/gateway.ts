import { connectWebSocket } from '@anhlp/alp-client/websocket';
import { AuthenticationError, ConfigurationError, TransientError } from './errors.js';

/**
 * The browser's way to alpd: the ALP remote gateway (docs/alp/remote-gateway.md §4, §8). The access
 * token goes only in the Authorization header of POST /v1/tickets; the WebSocket opens with the
 * one-time ticket as a subprotocol. Nothing here stores the token, puts it in a URL or logs it.
 */

export type WorkspaceRoot = { path: string; canonical: string; };

export type Principal = {
  id: string;
  label?: string;
  permissions: string[];
  workspaces: string[];
  workspaceRoots?: WorkspaceRoot[];
  modes?: string[];
};

export type AlpTransport = import('@anhlp/alp-client/portable').AlpTransport;

const LOOPBACK = new Set(['localhost', '127.0.0.1']);

/**
 * The gateway's base URL: https, or http on a loopback address (a gateway on this machine or
 * reached through an SSH tunnel). No credentials, query or fragment, which could leak a secret.
 */
export function gatewayUrl(input: string) {
  let url;
  try { url = new URL(String(input).trim()); } catch { throw new ConfigurationError('Enter the gateway address, such as https://alp.example.com or http://127.0.0.1:7434.'); }
  if (url.username || url.password || url.search || url.hash) throw new ConfigurationError('Use a gateway address without a user name, password, query or fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))) {
    throw new ConfigurationError('Use https, or http only on this machine (127.0.0.1 or localhost, for example through an SSH tunnel).');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(entry => typeof entry === 'string');

/** A ticket answer of the expected shape, else undefined. */
// any: alpd's or the gateway's answer (untrusted JSON); each field is checked where it is read.
function ticketOf(body: any) {
  if (!body || typeof body !== 'object') return undefined;
  const { websocket, subprotocols, principal } = body;
  if (websocket !== '/v1/ws' || !strings(subprotocols) || !subprotocols.includes('alp.v1')) return undefined;
  if (!principal || typeof principal.id !== 'string' || !strings(principal.permissions) || !strings(principal.workspaces)) return undefined;
  if (principal.modes !== undefined && !strings(principal.modes)) return undefined;
  const clean: Principal = {
    id: principal.id,
    ...(typeof principal.label === 'string' ? { label: principal.label } : {}),
    permissions: [...principal.permissions],
    workspaces: [...principal.workspaces],
    // any: alpd's or the gateway's answer (untrusted JSON); each field is checked where it is read.
    ...(Array.isArray(principal.workspaceRoots) ? { workspaceRoots: principal.workspaceRoots.filter((root: any) => root && typeof root.path === 'string' && typeof root.canonical === 'string').map((root: any) => ({ path: root.path, canonical: root.canonical })) } : {}),
    ...(principal.modes ? { modes: [...principal.modes] } : {}),
  };
  return { websocket: websocket as string, subprotocols: subprotocols as string[], principal: clean };
}

/** The `error` field of a gateway's JSON refusal, if it has one. */
async function refusalOf(response: Response) {
  try { const body = await response.json(); return typeof body?.error === 'string' ? body.error : undefined; } catch { return undefined; }
}

/** An AbortSignal that fires when `outer` does or after `ms`, and a way to stop its timer. */
function deadline(outer: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new TransientError('The gateway did not answer in time.')), ms);
  const onAbort = () => controller.abort(outer?.reason);
  if (outer?.aborted) onAbort(); else outer?.addEventListener('abort', onAbort, { once: true });
  return { signal: controller.signal, done() { clearTimeout(timer); outer?.removeEventListener('abort', onAbort); } };
}

/**
 * Opens one WebSocket to alpd through the gateway: a ticket for `token`, then the socket.
 * Throws AuthenticationError (401: stop), ConfigurationError (this page or address is refused:
 * stop) or TransientError (unreachable or busy: try again later).
 */
export async function openGateway({ url, token, signal, timeoutMs = 15_000, fetch: fetchImpl = globalThis.fetch.bind(globalThis), WebSocket }: {
    url: string;
    token: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    fetch?: typeof fetch;
    WebSocket?: import('@anhlp/alp-client/websocket').WebSocketConstructor;
  }): Promise<{ transport: AlpTransport; principal: Principal; }> {
  const base = gatewayUrl(url);
  if (!token || /\s/.test(token)) throw new AuthenticationError('Enter the access token printed by alp-gateway credential create.');
  const wait = deadline(signal, timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${base}/v1/tickets`, {
      method: 'POST',
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      headers: { authorization: `Bearer ${token}` },
      signal: wait.signal,
    });
  } catch (error) {
    wait.done();
    if (signal?.aborted) throw signal.reason ?? error;
    if (wait.signal.reason instanceof TransientError) throw wait.signal.reason;
    // A refused origin answers without CORS headers, which a browser reports exactly like an
    // unreachable host; only the gateway's log can tell them apart.
    throw new TransientError('Cannot reach the gateway. Check that it is running at this address and that it allows this page\'s origin (alp-gateway serve --origin).');
  }
  try {
    if (response.status === 401) throw new AuthenticationError();
    if (response.status === 403) {
      const reason = await refusalOf(response);
      throw new ConfigurationError(reason === 'tls_required'
        ? 'The gateway only accepts this connection over HTTPS.'
        : 'The gateway does not allow this page\'s origin. Start it with --origin set to this page\'s address.');
    }
    if (response.status === 421) throw new ConfigurationError('The gateway does not know this host name. Add it with alp-gateway serve --public-host.');
    if (response.status === 429) throw new TransientError('The gateway is limiting requests from this address. Wait a moment.');
    if (response.status !== 201) throw new TransientError(`The gateway is not ready (HTTP ${response.status}).`);
    const ticket = ticketOf(await response.json().catch(() => undefined));
    if (!ticket) throw new ConfigurationError('The gateway answered with an unexpected ticket. Check that the address points to an ALP gateway.');
    const socketUrl = `${base.replace(/^http/, 'ws')}${ticket.websocket}`;
    const transport = await connectWebSocket(socketUrl, { protocols: ticket.subprotocols, signal: wait.signal, timeoutMs, ...(WebSocket ? { WebSocket } : {}) })
      .catch(error => {
        if (signal?.aborted) throw signal.reason ?? error;
        throw new TransientError('The gateway accepted the token but the live connection failed. Retrying may help.');
      });
    return { transport, principal: ticket.principal };
  } finally {
    wait.done();
  }
}

/**
 * The granted workspace a path names exactly, by the path the credential was given or alpd's
 * canonical one (docs/alp/remote-gateway.md §5.1: whole strings, never prefixes).
 */
export function grantedWorkspace(principal: Principal | undefined, path: string | undefined) {
  if (!principal || !path) return undefined;
  const roots = principal.workspaceRoots?.length ? principal.workspaceRoots : principal.workspaces.map(entry => ({ path: entry, canonical: entry }));
  return roots.find(root => root.path === path || root.canonical === path);
}

/** Whether the principal holds `permission`; a write permission implies its read. */
export function can(principal: Principal | undefined, permission: string) {
  if (!principal) return false;
  if (principal.permissions.includes(permission)) return true;
  return permission.endsWith('.read') && principal.permissions.includes(permission.replace(/\.read$/, '.write'));
}
