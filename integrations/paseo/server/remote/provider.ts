import type { DaemonConnection } from '@anhlp/alp-protocol';
import type { ProviderRegistration } from '../compat.js';
import { MODES, teamName } from '../mapping-wire.js';
import { createAlpProvider, type TeamModel } from '../provider-core.js';
import { openGateway, sameWorkspace, workspaceFor, type GatewayConfig, type GatewayLink, type Principal } from './link.js';

/**
 * The ALP provider for Paseo in remote mode (docs/alp/paseo-remote.md): the same translation of
 * Paseo inputs and alpd events as the local provider (provider-core.ts), over a connection to alpd
 * through the remote gateway. Teams come from alpd (team.list), never from this machine's library;
 * a session runs in a workspace the credential grants, by the daemon host's path; what Paseo would
 * run on this machine (its MCP servers, environment) is not sent, and the user is told. A dropped
 * connection is reopened with a new ticket and each root attached after its last replay cursor; a
 * request whose outcome is unknown is never sent again.
 */

export type RemoteState = { principal?: Principal; capabilities: string[]; models: Map<string, { label: string; description?: string }> };

export function remoteState(): RemoteState {
  return { capabilities: [], models: new Map() };
}

/** The granted workspace Paseo's cwd names exactly, by the credential's path or alpd's. */
function exactWorkspace(principal: Principal, cwd: string) {
  const roots = principal.workspaceRoots ?? principal.workspaces.map(path => ({ path, canonical: path }));
  return roots.find(root => root.path === cwd || root.canonical === cwd);
}

const granted = (principal: Principal) => principal.workspaces.join(', ');

export function createRemoteProvider(config: GatewayConfig, { version = '0', state = remoteState(), open = openGateway }: { version?: string; state?: RemoteState; open?: typeof openGateway } = {}): ProviderRegistration {
  const info = { name: 'alp-paseo-remote', version };
  const principal = () => {
    if (!state.principal) throw new Error('Not connected to the ALP gateway yet');
    return state.principal;
  };
  async function connect(): Promise<DaemonConnection> {
    const link: GatewayLink = await open(config, info);
    state.principal = link.principal;
    state.capabilities = link.capabilities;
    // Model labels for a child's config; a credential without session.read simply shows ids.
    void link.client.request('library.models', {}).then(
      (result: any) => { state.models = new Map((result?.models ?? []).map((model: any) => [model.id, { label: model.label }])); },
      () => {},
    );
    return link.client;
  }

  return createAlpProvider({
    description: 'ALP agents on a remote ALP host, through its gateway',
    async open() {
      return { client: await connect(), async shutdown(client) { client.close(); }, relink: () => connect() };
    },
    async teams(cwd, client) {
      const workspace = workspaceFor(principal(), cwd);
      if (!workspace) throw new Error(`${cwd ?? 'This folder'} is not a workspace your ALP credential grants (${granted(principal())})`);
      const { teams } = await client.request('team.list', { projectRoot: workspace.path });
      return (teams as Array<{ id: string; label?: string; description?: string; error?: string }>).filter(team => !team.error).map((team): TeamModel => ({ id: team.id, label: team.label ?? team.id, ...(team.description ? { description: team.description } : {}), thinkingOptions: [] }));
    },
    spec(paseo, persistence) {
      const options = paseo.providerOptions ?? {};
      for (const key of Object.keys(options)) if (!['agent', 'workflow'].includes(key)) throw new Error(`Unknown ALP provider option '${key}'`);
      if (options.agent !== undefined && (typeof options.agent !== 'string' || !options.agent.trim())) throw new Error('providerOptions.agent must be a nonempty string');
      if (Object.keys(paseo.settings).some(key => key !== 'workflow')) throw new Error('Unknown ALP session setting');
      if (paseo.toolPolicy) throw new Error('Per-tool approval policy is unsupported by this prototype');
      // Version 1 handles carry a native thread to adopt: only the ALP host itself may do that.
      if (persistence && persistence.version !== 2) throw new Error('This session was saved by an older ALP plugin; resume it on the ALP host');
      const workspace = exactWorkspace(principal(), paseo.cwd);
      if (!workspace) throw new Error(`${paseo.cwd} is not a workspace your ALP credential grants. Open one of: ${granted(principal())}`);
      const teams = [teamName(paseo.model), options.workflow, paseo.settings.workflow].filter((value): value is string => typeof value === 'string');
      if (new Set(teams).size > 1) throw new Error('Conflicting team selections');
      const notices: string[] = [];
      if (Object.keys(paseo.env ?? {}).length) notices.push('Paseo\'s environment variables stay on this machine: the remote ALP host does not get them.');
      if (Object.keys(paseo.mcpServers ?? {}).length) notices.push('Paseo\'s MCP servers run on this machine: the remote ALP host does not get them. Configure MCP servers on the ALP host.');
      if (paseo.systemPrompt) notices.push('Paseo\'s system prompt is not sent to the remote ALP host.');
      return {
        spec: {
          cwd: workspace.path,
          ...(typeof options.agent === 'string' ? { agent: options.agent } : {}),
          ...(teams[0] ? { workflow: teams[0] } : {}),
          ...(paseo.mode ? { mode: paseo.mode } : {}),
          ...(paseo.persist !== undefined ? { persist: paseo.persist } : {}),
        },
        notices,
      };
    },
    sameProject: (stored, cwd) => sameWorkspace(principal(), stored, cwd),
    projectRoot: cwd => cwd === undefined ? undefined : workspaceFor(principal(), cwd)?.path ?? cwd,
    labelOf: id => state.models.get(id),
    modes() {
      const allowed = state.principal?.modes;
      const modes = allowed ? MODES.filter(mode => allowed.includes(mode.id)) : MODES;
      return { modes, defaultMode: modes.some(mode => mode.id === 'full-access') ? 'full-access' : modes[0]?.id ?? 'read-only' };
    },
    cursors: true,
    repeatAfterRelink: false,
  });
}
