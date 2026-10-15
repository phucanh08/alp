import type { PluginServerContext } from '../compat.js';
import { gatewayConfig, type GatewayConfig } from './link.js';
import { createRemoteProvider } from './provider.js';
import { registerRemoteLibraryRpc, registerRemoteTaskRpc, registerRemoteUsageRpc, remoteLink } from './panels.js';

export { gatewayConfig, openGateway, GatewayAuthError, REQUIRED_CAPABILITIES, sameWorkspace, workspaceFor, type GatewayConfig, type GatewayLink, type Principal } from './link.js';
export { createRemoteProvider, remoteState } from './provider.js';
export { registerRemoteLibraryRpc, registerRemoteTaskRpc, registerRemoteUsageRpc, remoteLink, RemoteUnavailableError, UNAVAILABLE } from './panels.js';

/**
 * The plugin in remote mode (docs/alp/paseo-remote.md): the ALP provider and the panels, all
 * through the gateway. No alpd is supervised, found or started on this machine.
 */
export function contributeRemote(server: PluginServerContext, config: GatewayConfig = gatewayConfig() as GatewayConfig, version = '0') {
  if (!config) throw new Error('ALP remote mode needs ALP_GATEWAY_URL and ALP_GATEWAY_TOKEN');
  server.registerProvider(createRemoteProvider(config, { version }));
  const link = remoteLink(config, { name: 'alp-paseo-remote-panels', version });
  registerRemoteTaskRpc(server, link);
  registerRemoteLibraryRpc(server, link);
  registerRemoteUsageRpc(server);
  return () => link.close();
}
