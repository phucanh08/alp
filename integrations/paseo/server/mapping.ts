import path from 'node:path';
import bundledTemplates from 'alp:templates';
import { resolveSession, models as runtimeModels } from '@anhlp/alp-runtime/index';
import type { HostMcpServer, SessionSpec } from '@anhlp/alp-protocol/session';
import { listTeams, teamOf } from '@anhlp/alp-core/teams';
import { alpHome } from '@anhlp/alp-client/index';
import type { ProviderSessionConfig, ProviderPersistence } from './compat.js';
import { alpdSessionOf, configModels as wireConfigModels, DEFAULT_TEAM } from './mapping-wire.js';

export { alpdSessionOf, DEFAULT_TEAM, handleFor, type AlpdHandle } from './mapping-wire.js';

export { DEFAULT_MODEL, DEFAULT_CLAUDE_MODEL, models, modes, thinkingOptions, thinkingOptionsFor, InstructionsAdapter as PaseoAdapter } from '@anhlp/alp-runtime/index';

export const templates = bundledTemplates;

/**
 * Paseo shows teams in place of models (ALPD §42): the built-ins Phở and Cafe, then
 * the library's, then the project's. A team fixes its members' models and effort, so a
 * session picks a team and nothing else. A team that fails to load is left out.
 */
export async function teamModels(cwd?: string) {
  const teams = await listTeams(cwd, { library: alpHome(), templates });
  return teams.filter(team => !team.error).map(team => ({ id: team.id, label: team.label ?? team.id, ...(team.description ? { description: team.description } : {}), thinkingOptions: [] }));
}

/** The team a Paseo model selection names: an id without a runtime prefix, accepting Phở and Cafe's old names. */
export const teamFor = (model: string | null | undefined) => model && !model.includes(':') && !model.includes('/') ? teamOf(model) : undefined;

/** The model list a session's config shows: its team for a root, its own model for a child or a custom root. */
export const configModels = (session: Parameters<typeof wireConfigModels>[0]) => wireConfigModels(session, id => runtimeModels.find(model => model.id === id));

/** Validates Paseo's session config and persistence and translates them to a runtime spec. */
export function toSessionSpec(config: ProviderSessionConfig, persistence?: ProviderPersistence): SessionSpec {
  const options = config.providerOptions ?? {};
  for (const key of Object.keys(options)) if (!['agent', 'workflow'].includes(key)) throw new Error(`Unknown ALP provider option '${key}'`);
  if (options.agent !== undefined && (typeof options.agent !== 'string' || !options.agent.trim())) throw new Error('providerOptions.agent must be a nonempty string');
  if (Object.keys(config.settings).some(key => key !== 'workflow')) throw new Error('Unknown ALP session setting');
  if (config.settings.workflow !== undefined && typeof config.settings.workflow !== 'string') throw new Error('workflow must be a string');
  if (config.toolPolicy) throw new Error('Per-tool approval policy is unsupported by this prototype');
  const restored = persistence?.version === 2 ? undefined : persistence?.data as { agent?: string; cwd?: string; threadId?: string; runtime?: string; model?: string; workflow?: { mode: string; maxPeers: number } } | undefined;
  if (persistence?.version === 2) alpdSessionOf(config, persistence);
  else if (persistence && (persistence.version !== 1 || !restored || typeof restored.agent !== 'string' || typeof restored.threadId !== 'string' || restored.cwd !== path.resolve(config.cwd))) throw new Error('Invalid ALP persistence or project mismatch');
  if (options.workflow !== undefined && typeof options.workflow !== 'string') throw new Error('providerOptions.workflow must be a string');
  // The selected model is a team; model and effort follow from it. Older clients send workflow instead.
  const selected = [teamFor(config.model), options.workflow, config.settings.workflow].filter((value): value is string => value !== undefined).map(value => teamOf(value));
  if (new Set(selected).size > 1) throw new Error('Conflicting team selections');
  return {
    cwd: config.cwd,
    agent: options.agent as string | undefined,
    workflow: selected[0],
    mode: config.mode ?? undefined,
    systemPrompt: config.systemPrompt ?? undefined,
    env: { ...config.env },
    mcpServers: config.mcpServers as Record<string, HostMcpServer>,
    persist: config.persist,
    ...(restored ? { restore: { agent: restored.agent!, threadId: restored.threadId!, runtime: restored.runtime, model: restored.model, workflow: restored.workflow } } : {}),
  };
}

export async function mapSession(config: ProviderSessionConfig, persistence?: ProviderPersistence) {
  return resolveSession(toSessionSpec(config, persistence), { templates });
}
