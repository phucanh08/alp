import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { knownModel } from './models.ts';
import { resolveTeam, teamSources } from './teams.ts';
import { agentSources, builtinText, optionalText } from './resolver.ts';
import type { AgentSource } from './resolver.ts';
import type { ResolvedTeam } from './teams.ts';
import type { AgentModelConfig, AgentProfilesConfig, RawSettings } from './types.ts';

/** A profile's parts, in whichever form a caller holds them. */
type ProfileLike = { provider?: string; model?: string; effort?: string };
/** Per-team, per-agent profile choices, as settings.json `team` holds them. */
type TeamProfiles = Record<string, Record<string, AgentProfilesConfig>>;
type ProfileOptions = { root?: string; library?: string; templates?: Record<string, string>; teamIds?: string[] };

export const userLibrary = (): string => process.env.ALP_HOME ?? path.join(os.homedir(), '.alp');
/** Accept the original provider map as well as the model list.
 * @param {import('./types.js').AgentProfilesConfig | undefined} config
 * @returns {Array<import('./types.js').AgentModelConfig>}
 */
export const oracleProfiles = (config: AgentProfilesConfig | undefined): AgentModelConfig[] => (config?.profiles ?? [config?.claude, config?.codex].filter(Boolean)) as AgentModelConfig[];

/** The choices for any agent, accepting the earlier single-model configuration.
 * @param {import('./types.js').AgentProfilesConfig | undefined} config
 * @param {string} name
 * @returns {Array<import('./types.js').AgentModelConfig>}
 */
export const agentProfiles = (config: AgentProfilesConfig | undefined, name: string): AgentModelConfig[] => {
  if (!config) return [];
  if (name === 'oracle') return oracleProfiles(config).map(parseProfile);
  const { autocompact, commands, ...legacy } = config;
  return (config.profiles ?? [legacy]).map(parseProfile);
};

/** A profile is "provider:model[:effort]", "provider:*" (any model the provider has), or the earlier { provider, model, effort }. */
export const parseProfile = (profile: string | AgentModelConfig): AgentModelConfig => {
  if (typeof profile !== 'string') return profile;
  const [provider, model, effort] = profile.split(':');
  return { provider, model, ...(effort ? { effort } : {}) } as AgentModelConfig;
};
/** The string form of a profile: "provider:model", with ":effort" when it has one. */
export const profileString = (profile: ProfileLike): string => `${profileModel(profile)}${profile.effort ? `:${profile.effort}` : ''}`;
/** The efforts a runtime-prefixed model takes, for the models ALP knows (the live catalog when loaded, t-086c); undefined for others. */
export const modelEfforts = (id: string): string[] | undefined => knownModel(id)?.efforts;
/** An effort the model takes: the one wanted, or else the model's own default. */
export const fitEffort = (id: string, effort: string | undefined): string | undefined => {
  const efforts = modelEfforts(id);
  if (!efforts?.length || (efforts as Array<string | undefined>).includes(effort)) return effort;
  return knownModel(id)?.effort ?? efforts[0];
};
/** Whether a profile stands for every model of its provider. */
export const anyModel = (profile: ProfileLike | undefined): boolean => profile?.model === '*';
/** Whether a runtime-prefixed model is one a profile list offers. */
export const offers = (profiles: ProfileLike[], model: string): boolean => profiles.some(profile => anyModel(profile) ? model.startsWith(`${profile.provider}:`) && model.length > profile.provider!.length + 1 : profileModel(profile) === model);

/** Only a matching model supplies effort for an explicit choice; otherwise use the first default.
 * @param {Array<import('./types.js').AgentModelConfig>} profiles
 * @param {string | undefined} model
 */
export const selectedProfile = (profiles: AgentModelConfig[], model: string | undefined): AgentModelConfig | undefined => model === undefined ? profiles.find(config => !anyModel(config)) : profiles.find(config => !anyModel(config) && (!config.model || profileModel(config) === model || (!model.includes(':') && config.model === model)));

/** Migrate complete choices while leaving legacy partial overrides readable. */
export function normalizeAgentProfiles(config: AgentProfilesConfig, name: string): AgentProfilesConfig {
  // The earlier object form becomes "provider:model:effort", which says the same.
  if (config.profiles) return { ...config, profiles: config.profiles.map(profile => typeof profile === 'string' ? profile : profileString(profile)), autocompact: config.autocompact ?? 'auto' };
  const profiles = agentProfiles(config, name);
  if (!profiles.length || profiles.some(profile => !profile.model)) return config;
  return { profiles: profiles.map(profile => profileString({ ...profile, provider: profile.provider ?? profile.model!.split(':')[0] })), autocompact: config.autocompact ?? 'auto', ...(config.commands ? { commands: config.commands } : {}) };
}

export const profileModel = (config: ProfileLike | undefined): string | undefined => config?.model ? config.model.includes(':') ? config.model : `${config.provider}:${config.model}` : undefined;

const withEffort = (model: string, effort: string | undefined) => {
  if (model.startsWith('acp:') || model.startsWith('antigravity:')) return model;
  const fitted = fitEffort(model, effort);
  return fitted ? `${model}:${fitted}` : model;
};

/** Snapshot current user team choices into editable project profiles. */
/**
 * The model and effort an agent's own agent.json names, as a runtime-prefixed model ID, or undefined.
 * An unreadable agent.json is left for resolving the session to report.
 */
async function agentJsonChoice(sources: Map<string, AgentSource>, name: string, templates: Record<string, string> | undefined): Promise<{ model: string; thinking?: string } | undefined> {
  const source = sources.get(name);
  if (!source) return undefined;
  let config;
  try {
    const text = source.directory ? await optionalText(path.join(source.directory, 'agent.json')) : await builtinText(`agents/${name}/agent.json`, templates);
    config = text === undefined ? undefined : JSON.parse(text);
  } catch { return undefined; }
  if (typeof config?.model !== 'string' || !config.model.trim()) return undefined;
  return { model: runtimeModelId(typeof config.provider === 'string' ? config.provider : undefined, config.model), ...(typeof config.thinking === 'string' ? { thinking: config.thinking } : {}) };
}

/** A runtime-prefixed model ID from an agent.json, settings.json or team.json choice, as resolving a session reads one.
 * @param {string | undefined} provider
 * @param {string} model
 * @returns {string}
 */
export function runtimeModelId(provider: string | undefined, model: string): string {
  const prefixed = /^(codex|claude|antigravity|acp)[:/]/.exec(model);
  if (prefixed) return `${prefixed[1]}:${model.slice(prefixed[0].length)}`;
  const kind = provider ?? 'codex';
  // Another provider names an ACP provider of the library.
  return ['codex', 'claude', 'antigravity', 'acp'].includes(kind) ? `${kind}:${model}` : `acp:${kind}/${model}`;
}

export async function projectProfiles({ root, library = userLibrary(), templates, runtime, teamIds }: ProfileOptions & { runtime?: { provider?: string; model?: string; reasoning?: string } } = {}): Promise<TeamProfiles> {
  const profiles: TeamProfiles = {};
  // A member the team.json gives no model runs on its agent.json's before main's (t-3aad).
  const sources = await agentSources(root, { library, templates });
  for (const id of (await teamSources(root, { library, templates })).keys()) {
    if (teamIds && !teamIds.includes(id)) continue;
    const team = await resolveTeam(root, id, { library, templates });
    const fallback = team.members[team.main].model ?? 'codex:gpt-6.1-sol';
    const profile: Record<string, AgentProfilesConfig> = {};
    for (const [name, member] of Object.entries(team.members)) {
      if (name === 'oracle') continue;
      const own = member.model ? undefined : await agentJsonChoice(sources, name, templates);
      const chosen = runtime?.model ? (runtime.model.includes(':') ? runtime.model : `${runtime.provider ?? 'codex'}:${runtime.model}`) : runtime?.provider ? (runtime.provider === 'claude' ? 'claude:claude-opus-5-5' : 'codex:gpt-6.1-sol') : member.model ?? own?.model ?? fallback;
      // The effort comes with the model: the member's, its agent.json's, else main's.
      const effort = runtime?.reasoning ?? member.thinking ?? (runtime?.model || runtime?.provider ? undefined : own?.thinking);
      profile[name] = { profiles: [withEffort(chosen, effort ?? team.members[team.main].thinking ?? 'medium')], autocompact: 'auto' };
    }
    if (team.supervisor) profile[team.supervisor.agent] = { profiles: [withEffort(team.supervisor.model ?? fallback, team.supervisor.thinking ?? 'medium')], autocompact: 'auto' };
    if (team.members.oracle) profile.oracle = { profiles: (team.oracleModels ?? ['claude:claude-fable-5-1', 'codex:gpt-6-astra'])
      .map(model => withEffort(model, team.oracleThinking?.[model] ?? team.oracleThinking?.[model.split(':')[0]] ?? 'high')), autocompact: 'auto' };
    profiles[id] = profile;
  }
  return profiles;
}

/** Apply per-project agent choices without replacing the team's graph or rules. */
export function applyProfile(team: ResolvedTeam, profile: Record<string, AgentProfilesConfig> | undefined): ResolvedTeam {
  if (!profile) return team;
  const next = structuredClone(team);
  for (const [name, config] of Object.entries(profile)) {
    if (name === 'oracle') {
      const lenses = oracleProfiles(config).map(parseProfile);
      next.oracleModels = lenses.map(profileModel) as string[];
      const efforts = lenses.filter(lens => lens.effort);
      if (efforts.length) next.oracleThinking = { ...next.oracleThinking, ...Object.fromEntries(efforts.map(lens => [profileModel(lens), lens.effort as string])) };
    } else {
      const target = next.members[name] ?? (next.supervisor && next.supervisor.agent === name ? next.supervisor : undefined);
      if (!target) throw new Error(`team.${team.id}.${name}: agent is not in this team`);
      const first = agentProfiles(config, name).find(profile => !anyModel(profile));
      if (first?.model) target.model = profileModel(first);
      if (first?.effort) target.thinking = first.effort;
    }
  }
  return next;
}

/** Fingerprints let generated defaults follow templates without replacing hand-edited project choices. */
export const profileFingerprint = (config: AgentProfilesConfig, name: string): string => createHash('sha256').update(JSON.stringify(agentProfiles(config, name).map(profileString))).digest('hex');
export const profileDefaults = (profiles: TeamProfiles): Record<string, Record<string, string>> => Object.fromEntries(Object.entries(profiles).map(([team, agents]) => [team, Object.fromEntries(Object.entries(agents).map(([name, config]) => [name, profileFingerprint(config, name)]))]));

/** Refresh only inherited profiles; older scaffolds are recognized by their shipped defaults. */
export async function syncTemplateProfiles(settings: RawSettings, options: ProfileOptions & { replaceModels?: boolean } = {}): Promise<RawSettings> {
  const defaults = await projectProfiles({ ...options, runtime: options.replaceModels ? undefined : settings.runtime });
  const legacy = settings.templateDefaults ? undefined : await projectProfiles({ templates: options.templates, library: '', runtime: settings.runtime });
  const previous = settings.templateDefaults ?? profileDefaults(legacy!);
  const next = structuredClone(settings);
  next.team = { ...(next.profile ?? {}), ...(next.team ?? {}) };
  delete next.profile;
  for (const id of new Set([...Object.keys(previous), ...Object.keys(defaults)])) {
    if (options.teamIds && !options.teamIds.includes(id)) continue;
    const desired = defaults[id] ?? {};
    const current = next.team[id] ?? {};
    for (const name of new Set([...Object.keys(previous[id] ?? {}), ...(options.replaceModels ? Object.keys(current) : []), ...Object.keys(desired)])) {
      const config = current[name];
      if (!options.replaceModels && config && profileFingerprint(config, name) !== previous[id]?.[name]) continue;
      if (desired[name]) current[name] = { ...desired[name], autocompact: config?.autocompact ?? desired[name].autocompact, ...(config?.commands ? { commands: config.commands } : {}) };
      else delete current[name];
    }
    if (Object.keys(current).length) next.team[id] = current;
    else delete next.team[id];
  }
  next.templateDefaults = options.teamIds ? { ...previous, ...profileDefaults(defaults) } : profileDefaults(defaults);
  return next;
}
