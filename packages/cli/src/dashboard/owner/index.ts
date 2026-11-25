import { methods as host } from './host.js';
import { methods as library } from './library.js';
import { methods as workspaceFacts } from './workspace-facts.js';
import type { OwnerHandler } from '@anhlp/alp-gateway/owner';

/**
 * The host owner's methods of alp dashboard (t-a95b; docs/alp/remote-gateway.md §5.19): what the
 * dashboard's own credential, on a direct loopback socket, may do on this host that no gateway
 * credential can. main.js hands `ownerMethods({ home, socket })` to createGateway's `owner.methods`.
 *
 * A handler runs in the dashboard process, as the user, only after the gateway has checked that
 * the method is an `owner` entry of its exposure matrix (apps/gateway/src/policy.js) and that the
 * connection is the owner's; a handler with no matrix entry is never called. It gets one object:
 *   method   the method name;
 *   params   the request's params (only those the matrix entry lists, when it lists any); check them;
 *   principal  the owner credential's id;
 *   daemon   { request(method, params) }: alpd, on the owner's own connection;
 *   home     the ALP home (ALP_HOME or ~/.alp) this dashboard serves;
 *   socket   alpd's socket path, for a handler that needs a connection of its own.
 * It returns the result, or throws: an error with a numeric `code` (and `data`) reaches the app as
 * that JSON-RPC error; any other is logged and answered "<method> failed in the gateway".
 *
 * host.js (group B), library.js (group C) and workspace-facts.js (t-ff83, the sidebar's
 * host.workspace.facts) each own their methods; a name in both is a mistake
 * and stops the dashboard at start rather than letting one silently win.
 */
export type DashboardOwnerContext = {
  method: string;
  params: Record<string, any>; // any: the request's params, unchecked; each handler checks them
  principal: string;
  daemon: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> };
  home: string;
  socket: string;
};
export type DashboardOwnerHandler = (context: DashboardOwnerContext) => unknown;

/**
 * Merges the method tables; throws on a name defined twice.
 */
export function mergeOwnerMethods(tables: Array<Readonly<Record<string, DashboardOwnerHandler>>>): Record<string, DashboardOwnerHandler> {
  const merged: Record<string, DashboardOwnerHandler> = {};
  for (const table of tables) {
    for (const [name, handler] of Object.entries(table)) {
      if (Object.hasOwn(merged, name)) throw new Error(`owner method ${name} is defined twice`);
      merged[name] = handler;
    }
  }
  return merged;
}

/**
 * The owner methods as createGateway takes them: each handler gets the gateway's context plus
 * `home` and `socket`.
 */
export function ownerMethods({ home, socket }: { home: string; socket: string }): Record<string, OwnerHandler> {
  return Object.fromEntries(Object.entries(mergeOwnerMethods([host, library, workspaceFacts]))
    .map(([name, handler]) => [name, (context: Parameters<OwnerHandler>[0]) => handler({ ...context, home, socket })]));
}
