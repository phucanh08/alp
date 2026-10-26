import { createLogger } from '@anhlp/alp-core/log';
import type { PluginServerContext } from './compat.js';
import { createProvider, daemonEntry } from './provider.js';
import { registerTaskRpc } from './tasks.js';
import { registerLibraryRpc } from './library.js';
import { registerUsageRpc } from './usage.js';
import { alpHome } from '@anhlp/alp-client/index';
import { superviseDaemon } from '@anhlp/alp-client/supervise';
import { contributeRemote, gatewayConfig } from './remote/index.js';
export { createProvider } from './provider.js';
export { createPaseoBridge, NOT_IMPLEMENTED, PASEO_PROTOCOL_VERSION, webAppDir } from './paseo/index.js';
export { createWebServer, DEFAULT_WEB_PORT, webFile } from './web.js';
export type { PaseoGateway } from './paseo/gateway.js';
export { sessionTasks } from './session-tasks.js';
export { mapSession, toSessionSpec, PaseoAdapter } from './mapping.js';
export { ClaudeTransport, claudePermissions, CodexTransport } from '@anhlp/alp-runtime/index';
export { contributeRemote, createRemoteProvider, gatewayConfig } from './remote/index.js';
export default function contribute(server: PluginServerContext) {
  // Remote mode (docs/alp/paseo-remote.md): alpd on another host, through its gateway. A wrong
  // configuration fails here, and nothing on this machine is started instead.
  const remote = gatewayConfig();
  if (remote) return contributeRemote(server, remote);
  // Sessions run in the user's alpd, which keeps assignment logs outside the project (~/.alp/runs).
  server.registerProvider(createProvider());
  // The Tasks panel (index.client.tsx) reads and changes the project's tasks through these.
  registerTaskRpc(server);
  // The ALP settings screen edits agents, skills, MCP servers, hooks and teams through these.
  registerLibraryRpc(server);
  registerUsageRpc(server);
  // While Paseo runs, alpd runs: started now, and again whenever it goes down, unless the user stopped it (ALPD §40).
  const stop = process.env.ALP_SUPERVISE === '0'
    ? async () => {}
    : superviseDaemon({ home: alpHome(), entry: () => daemonEntry(), by: 'Paseo', log: message => createLogger({ component: 'alp-plugin' }).warn(message, { code: 'ALP_DAEMON_SUPERVISION' }) });
  return () => stop();
}
