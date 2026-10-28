import { userLanguage } from '@anhlp/alp-core/user-settings';
import { alpHome, connect, readLock } from '@anhlp/alp-client/index';
import type { DaemonConnection } from '@anhlp/alp-protocol';
import { words } from '@anhlp/alp-runtime/language';
import { createAgents } from './agents.js';
import { createPaseoGateway, type Handler } from './gateway.js';
import { quietHandlers } from './quiet.js';
import { createCheckouts } from './checkout.js';
import { createTerminals } from './terminals.js';
import { directorySuggestions, fileExplorer } from './files.js';
import { createPlugins } from './plugins.js';
import { createUsage } from './usage.js';
import { createWorkspaces } from './workspaces.js';
import { createDaemonConfig, createRelay, type RelaySettings } from './relay.js';
import { createProviders } from './providers.js';
import { createCreationReceipts } from './create-receipts.js';


export { createPaseoGateway, NOT_IMPLEMENTED, PASEO_PROTOCOL_VERSION } from './gateway.js';
export type { PaseoGateway } from './gateway.js';

/**
 * Features whose buttons the app shows only when the daemon says it has them, and which send a
 * request only when the user uses them. ALP lights them up so the app looks like Paseo's, and
 * answers their requests "in development" until it has them (ALPD §62 step 5). Flags that make
 * the app ask for something by itself, or change the protocol, stay off.
 */
const ENTRY_POINTS = {
  // agentForkContext(Cursor) stay off: Paseo's fork is a text summary of the conversation sent as a new
  // agent's first message, not a faithful fork. ALP's own fork (session.fork) is in apps/web (issue #121 C).
  projectGithubClone: true, workspaceGithubRepositorySearch: true, agentDetach: true,
  providerRemoval: true, importSessionWorkspaceTarget: true, importSessionSearch: true, fsEntryOps: true, fsEntryDuplicate: true, workspaceSetupRun: true,
};

/**
 * The Paseo bridge (ALPD §62): Paseo's protocol over alpd, for Paseo's app through the relay and
 * for token-authenticated local sockets. It was first built for Paseo's web app (paseo-web, removed
 * in t-55ce.3). The handlers and the features they light up grow step by step (D31); everything
 * else answers "in development".
 * ALP's state is read on the first client's hello, not at alpd's start.
 */
export function createPaseoBridge({ clientFactory, version, token, serverId, home, relay: relaySettings, listen = () => null, log }: {
  /** Injected client for the ALP daemon socket; defaults to connecting through the lock. */
  clientFactory?: (onEvent: (envelope: any) => void) => Promise<DaemonConnection>;
  /** The user's web.relay setting (ALPD §64). */
  relay?: RelaySettings;
  /** Where the integration's local listener is, as daemon.get_status reports it. */
  listen?: () => string | null;
  /** ALP's home, whose settings name the user's language. */
  home?: string;
  version: string;
  token: () => string;
  serverId: () => string;
  log?: (message: string) => void;
}) {
  const handlers: Record<string, Handler> = {};
  const features: Record<string, boolean> = {};
  const inDevelopment = async () => words(await userLanguage(home)).inDevelopment;
  const gateway = createPaseoGateway({
    token, serverId, version, handlers, features, log, inDevelopment,
    // workspaceTerminals follows the host's switch (terminal.json), read again at most every 5 s.
    beforeServerInfo: async () => { await terminals.refresh(); features.workspaceTerminals = terminals.features.workspaceTerminals; },
    onBinary: (bytes, client) => agents.uploads.binary(bytes, client),
    onClient: client => {
      agents.uploads.add(client);
      void agents.start().then(() => workspaces.start()).catch(error => log?.(`agents failed to start: ${error?.message ?? error}`));
      return () => { agents.uploads.drop(client); checkouts.drop(client); terminals.drop(client); };
    },
  });
  const broadcast = (message: Parameters<typeof gateway.broadcast>[0]) => gateway.broadcast(message);
  const receipts = createCreationReceipts(home ?? alpHome());
  const workspaces = createWorkspaces({ rpc: (method, params) => agents.request(method, params), broadcast, agents: () => agents.view, inDevelopment, receipts, log });
  const agents = createAgents({ clientFactory, home, broadcast, directory: workspaces, receipts, log });
  const readUsage = async (refresh = false) => {
    if (clientFactory) {
      const connection = await clientFactory(() => {});
      try { return await connection.request('daemon.usage', { refresh }); }
      finally { connection.close(); }
    }
    const lock = await readLock(home ?? alpHome());
    if (!lock?.ready) throw new Error('ALP daemon is not running');
    const connection = await connect(lock.socket);
    try { return await connection.request('daemon.usage', { refresh }); }
    finally { connection.close(); }
  };
  const plugins = createPlugins({ log, usage: readUsage, home, projectDirectories: workspaces.projectDirectories });
  const usage = createUsage(readUsage);
  const checkouts = createCheckouts({ broadcast, rpc: (method, params) => agents.request(method, params), log });
  // Terminals use their own connection to alpd (one attach per terminal, fanned out to every client).
  const terminals = createTerminals({
    home: home ?? alpHome(), log, archiveAgent: agents.archive,
    ...(clientFactory ? { connect: () => clientFactory(() => {}) } : {}),
  });
  const relay = createRelay({ home, serverId, attach: socket => gateway.attach(socket), initial: relaySettings, log: message => log?.(message) });
  const providers = createProviders({ home, broadcast, alpEntry: cwd => agents.providerEntry(cwd), log: message => log?.(message) });
  const daemonConfig = createDaemonConfig({ relay, providers, serverId, broadcast, inDevelopment, version, listen, startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString() });
  Object.assign(handlers, quietHandlers, daemonConfig.handlers, providers.handlers, agents.handlers, workspaces.handlers, plugins.handlers, usage.handlers, checkouts.handlers, terminals.handlers, { directory_suggestions_request: directorySuggestions, file_explorer_request: fileExplorer });
  Object.assign(features, ENTRY_POINTS, daemonConfig.features, providers.features, agents.features, workspaces.features, plugins.features, usage.features, checkouts.features, terminals.features);
  // agent.rewind.request in conversation mode. alpd (with its store) lists session.rewind on macOS and Linux,
  // not on Windows; the hello is answered before the bridge reaches alpd, so the platform decides here, and
  // each agent's supportsRewindConversation says whether that session's runtime rewinds.
  features.rewind = process.platform !== 'win32';
  // web.pairing is registered with alpd by the integration process over its RPC extension.

  return Object.assign(gateway, {
    relay,
    close: async () => { await receipts.close(); agents.uploads.close(); await agents.close(); checkouts.close(); terminals.close(); await relay.stop(); await workspaces.close(); },
  });
}
