import type { SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import plugin from 'alp:plugin-client';
import { registerLibraryRpc } from '../panel/library.js';
import { registerTaskRpc } from '../panel/tasks.js';
import { registerUsageRpc } from '../panel/usage.js';
import type { PluginServerContext } from '../panel/compat.js';
import type { Handler } from './gateway.js';

/** ALP panels over the bridge: native Paseo evaluates the catalog's clientBundle as a factory,
 * just as its own daemon's plugin runtime does. Keep the embedded client and the panel RPCs;
 * the removed paseo-web preloader's alp-preloaded URI is not a native catalog bundle.
 * See docs/alp/paseo-catalog-origin-012.md for the upstream 0.12 contract.
 */

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Outbound = SessionOutboundMessage;
type Contract = { name: string; input: { parseAsync(value: unknown): Promise<unknown> }; output: { parseAsync(value: unknown): Promise<unknown> } };

export function createPlugins({ log = () => {}, usage, home, projectDirectories }: {
  home?: string;
  projectDirectories?: () => Promise<string[]>; log?: (message: string) => void; usage?: (refresh?: boolean) => Promise<any> } = {}) {
  const methods = new Map<string, { contract: Contract; run: (input: any) => Promise<unknown> }>();
  const server = { handle: (contract: Contract, run: (input: any) => Promise<unknown>) => { methods.set(contract.name, { contract, run }); } } as unknown as PluginServerContext;
  registerTaskRpc(server);
  registerLibraryRpc(server, { home, projectDirectories });
  registerUsageRpc(server, usage);

  const handlers: Record<string, Handler> = {
    'plugin.catalog.get.request': (message: Inbound<'plugin.catalog.get.request'>) =>
      ({ type: 'plugin.catalog.get.response', payload: { requestId: message.requestId, plugins: [{ id: plugin.id, clientBundle: plugin.factory, requirements: plugin.requirements }] } }) satisfies Outbound,

    // ALP is core. The catalog loads its built-in UI adapter; management lists only
    // user plugins, so the adapter must not appear as an installed plugin.
    'plugin.list.request': (message: Inbound<'plugin.list.request'>) =>
      ({ type: 'plugin.list.response', payload: { requestId: message.requestId, plugins: [] } }) satisfies Outbound,

    /** A panel's call: checked against the plugin's contract going in and coming out, as Paseo's daemon checks it. */
    async 'plugin.rpc.invoke.request'(message: Inbound<'plugin.rpc.invoke.request'>) {
      if (message.pluginId !== plugin.id) throw Object.assign(new Error(`No plugin ${message.pluginId}`), { code: 'plugin_not_found' });
      const method = methods.get(message.method);
      if (!method) throw Object.assign(new Error(`No method ${message.method}`), { code: 'method_not_found' });
      try {
        const output = await method.contract.output.parseAsync(await method.run(await method.contract.input.parseAsync(message.input)));
        return { type: 'plugin.rpc.invoke.response', payload: { requestId: message.requestId, output } } satisfies Outbound;
      } catch (error: any) {
        log(`plugin ${message.method} failed: ${error?.message ?? error}`);
        throw Object.assign(new Error(error?.message ?? String(error)), { code: 'handler_error' });
      }
    },
  };

  return { handlers, features: { plugins: true, pluginSettings: true, pluginManagement: true } };
}
