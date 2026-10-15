import WebSocket from 'ws';
import { AlpRpcClient, hello } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';

/**
 * The remote mode's only way to alpd (docs/alp/paseo-remote.md): the ALP remote gateway
 * (apps/gateway, docs/alp/remote-gateway.md) with the portable client SDK. A bearer credential buys
 * a one-time ticket over HTTPS; the WebSocket offers it as a subprotocol. Nothing here reads or
 * writes this machine's files, finds a socket through a lock, or starts a process: when the gateway
 * cannot be reached the caller is told, and nothing falls back to a local or embedded alpd.
 */

export type GatewayConfig = { url: string; token: string };

export type Principal = {
  id: string;
  label?: string;
  permissions: string[];
  workspaces: string[];
  /** The same workspaces with the path alpd names them by; older gateways leave it out. */
  workspaceRoots?: Array<{ path: string; canonical: string }>;
  modes?: string[];
};

export type GatewayLink = { client: AlpRpcClient; principal: Principal; capabilities: string[] };

/** Capabilities the remote mode needs of alpd behind the gateway. */
export const REQUIRED_CAPABILITIES = ['attach.after', 'prompt.receipts'];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Thrown when the gateway refuses the credential: reconnecting cannot help until it is replaced. */
export class GatewayAuthError extends Error {
  constructor(message: string) { super(message); this.name = 'GatewayAuthError'; }
}

/**
 * The gateway named by ALP_GATEWAY_URL and ALP_GATEWAY_TOKEN, or undefined when the remote mode is
 * not configured. The token goes only to https, or http on a loopback address (a gateway on this
 * machine or through an SSH tunnel), never in clear over a network.
 */
export function gatewayConfig(env: Record<string, string | undefined> = process.env): GatewayConfig | undefined {
  const url = env.ALP_GATEWAY_URL?.trim();
  if (!url) return undefined;
  const token = env.ALP_GATEWAY_TOKEN?.trim();
  if (!token) throw new Error('ALP_GATEWAY_URL is set but ALP_GATEWAY_TOKEN is not: create a credential with alp-gateway credential create');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new Error('ALP_GATEWAY_URL is not a URL'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('ALP_GATEWAY_URL must not carry credentials, a query or a fragment');
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname))) throw new Error('ALP_GATEWAY_URL must use https (http only on a loopback address)');
  return { url: parsed.origin + parsed.pathname.replace(/\/+$/, ''), token };
}

/** Opens one connection to alpd through the gateway: ticket, WebSocket, hello. */
export async function openGateway(config: GatewayConfig, client: { name: string; version: string }, { fetch: fetchImpl = fetch }: { fetch?: typeof fetch } = {}): Promise<GatewayLink> {
  let response: Response;
  try {
    response = await fetchImpl(`${config.url}/v1/tickets`, { method: 'POST', headers: { authorization: `Bearer ${config.token}` } });
  } catch (error) {
    throw new Error(`The ALP gateway at ${config.url} cannot be reached: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.status === 401) throw new GatewayAuthError('The ALP gateway refused this credential: it was revoked, rotated, expired or mistyped');
  if (response.status !== 201) throw new Error(`The ALP gateway refused a ticket (HTTP ${response.status})`);
  const ticket = await response.json() as { websocket: string; subprotocols: string[]; principal: Principal };
  const transport = await connectWebSocket(`${config.url.replace(/^http/, 'ws')}${ticket.websocket}`, { WebSocket: WebSocket as any, protocols: ticket.subprotocols });
  const rpc = new AlpRpcClient(transport);
  try {
    const greeting = await hello(rpc, client) as { capabilities?: string[] };
    const capabilities = Array.isArray(greeting.capabilities) ? greeting.capabilities : [];
    const missing = REQUIRED_CAPABILITIES.filter(capability => !capabilities.includes(capability));
    if (missing.length) throw new Error(`The ALP host behind the gateway lacks ${missing.join(', ')}; update ALP there`);
    return { client: rpc, principal: ticket.principal, capabilities };
  } catch (error) {
    rpc.close();
    throw error;
  }
}

/**
 * The granted workspace a directory lies in, by path segments, the longest one first: the
 * credential's path or alpd's name for it. Only strings are compared; nothing is resolved here.
 */
export function workspaceFor(principal: Principal, directory: string | undefined) {
  if (!directory) return undefined;
  const roots = principal.workspaceRoots ?? principal.workspaces.map(path => ({ path, canonical: path }));
  const inside = (root: string) => directory === root || directory.startsWith(root.endsWith('/') ? root : `${root}/`);
  return roots.filter(root => inside(root.path) || inside(root.canonical)).sort((a, b) => b.path.length - a.path.length)[0];
}

/** Whether alpd's projectRoot `stored` and Paseo's `cwd` name the same granted workspace. */
export function sameWorkspace(principal: Principal, stored: string, cwd: string) {
  if (stored === cwd) return true;
  const roots = principal.workspaceRoots ?? [];
  return roots.some(root => (root.path === cwd || root.canonical === cwd) && (root.path === stored || root.canonical === stored));
}
