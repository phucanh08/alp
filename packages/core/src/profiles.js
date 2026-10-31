import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { knownModel } from './models.js';
import { resolveTeam, teamSources } from './teams.js';

export const userLibrary = () => process.env.ALP_HOME ?? path.join(os.homedir(), '.alp');
/** Accept the original provider map as well as the model list.
 * @param {import('./types.js').AgentProfilesConfig | undefined} config
 * @returns {Array<import('./types.js').AgentModelConfig>}
 */
export const oracleProfiles = config => config?.profiles ?? [config?.claude, config?.codex].filter(Boolean);

/** The choices for any agent, accepting the earlier single-model configuration.
 * @param {import('./types.js').AgentProfilesConfig | undefined} config
 * @param {string} name
 * @returns {Array<import('./types.js').AgentModelConfig>}
 */
export const agentProfiles = (config, name) => {
  if (!config) return [];
  if (name === 'oracle') return oracleProfiles(config).map(parseProfile);
  const { autocompact, commands, ...legacy } = config;
  return (config.profiles ?? [legacy]).map(parseProfile);
};

/** A profile is "provider:model[:effort]", "provider:*" (any model the provider has), or the earlier { provider, model, effort }. */
export const parseProfile = profile => {
  if (typeof profile !== 'string') return profile;
  const [provider, model, effort] = profile.split(':');
  return { provider, model, ...(effort ? { effort } : {}) };
};
/** The string form of a profile: "provider:model", with ":effort" when it has one. */
export const profileString = profile => `${profileModel(profile)}${profile.effort ? `:${profile.effort}` : ''}`;
/** The efforts a runtime-prefixed model takes, for the models ALP knows (the live catalog when loaded, t-086c); undefined for others. */
export const modelEfforts = id => knownModel(id)?.efforts;
/** An effort the model takes: the one wanted, or else the model's own default. */
export const fitEffort = (id, effort) => {
  const efforts = modelEfforts(id);
  if (!efforts?.length || efforts.includes(effort)) return effort;
  return knownModel(id)?.effort ?? efforts[0];
};
/** Whether a profile stands for every model of its provider. */
export const anyModel = profile => profile?.model === '*';
/** Whether a runtime-prefixed model is one a profile list offers. */
export const offers = (profiles, model) => profiles.some(profile => anyModel(profile) ? model.startsWith(`${profile.provider}:`) && model.length > profile.provider.length + 1 : profileModel(profile) === model);

/** Only a matching model supplies effort for an explicit choice; otherwise use the first default.
 * @param {Array<import('./types.js').AgentModelConfig>} profiles
 * @param {string | undefined} model
 */
export const selectedProfile = (profiles, model) => model === undefined ? profiles.find(config => !anyModel(config)) : profiles.find(config => !anyModel(config) && (!config.model || profileModel(config) === model || (!model.includes(':') && config.model === model)));

/** Migrate complete choices while leaving legacy partial overrides readable. */
export function normalizeAgentProfiles(config, name) {
  // The earlier object form becomes "provider:model:effort", which says the same.
  if (config.profiles) return { ...config, profiles: config.profiles.map(profile => typeof profile === 'string' ? profile : profileString(profile)), autocompact: config.autocompact ?? 'auto' };
  const profiles = agentProfiles(config, name);
  if (!profiles.length || profiles.some(profile => !profile.model)) return config;
  return { profiles: profiles.map(profile => profileString({ ...profile, provider: profile.provider ?? profile.model.split(':')[0] })), autocompact: config.autocompact ?? 'auto', ...(config.commands ? { commands: config.commands } : {}) };
}

export const profileModel = config => config?.model ? config.model.includes(':') ? config.model : `${config.provider}:${config.model}` : undefined;

const withEffort = (model, effort) => {
  if (model.startsWith('acp:') || model.startsWith('antigravity:')) return model;
  const fitted = fitEffort(model, effort);
  return fitted ? `${model}:${fitted}` : model;
};

/** Snapshot current user team choices into editable project profiles. */
export async function projectProfiles({ root, library = userLibrary(), templates, runtime, teamIds } = {}) {
  const profiles = {};
  for (const id of (await teamSources(root, { library, templates })).keys()) {
    if (teamIds && !teamIds.includes(id)) continue;
    const team = await resolveTeam(root, id, { library, templates });
    const fallback = team.members[team.main].model ?? 'codex:gpt-6.1-sol';
    const profile = {};
    for (const [name, member] of Object.entries(team.members)) {
      if (name === 'oracle') continue;
      const chosen = runtime?.model ? (runtime.model.includes(':') ? runtime.model : `${runtime.provider ?? 'codex'}:${runtime.model}`) : runtime?.provider ? (runtime.provider === 'claude' ? 'claude:claude-opus-5-5' : 'codex:gpt-6.1-sol') : member.model ?? fallback;
      profile[name] = { profiles: [withEffort(chosen, runtime?.reasoning ?? member.thinking ?? team.members[team.main].thinking ?? 'medium')], autocompact: 'auto' };
    }
    if (team.supervisor) profile[team.supervisor.agent] = { profiles: [withEffort(team.supervisor.model ?? fallback, team.supervisor.thinking ?? 'medium')], autocompact: 'auto' };
    if (team.members.oracle) profile.oracle = { profiles: (team.oracleModels ?? ['claude:claude-fable-5-1', 'codex:gpt-6-astra'])
      .map(model => withEffort(model, team.oracleThinking?.[model] ?? team.oracleThinking?.[model.split(':')[0]] ?? 'high')), autocompact: 'auto' };
    profiles[id] = profile;
  }
  return profiles;
}

/** Apply per-project agent choices without replacing the team's graph or rules. */
export function applyProfile(team, profile) {
  if (!profile) return team;
  const next = structuredClone(team);
  for (const [name, config] of Object.entries(profile)) {
    if (name === 'oracle') {
      const lenses = oracleProfiles(config).map(parseProfile);
      next.oracleModels = lenses.map(profileModel);
      const efforts = lenses.filter(lens => lens.effort);
      if (efforts.length) next.oracleThinking = { ...next.oracleThinking, ...Object.fromEntries(efforts.map(lens => [profileModel(lens), lens.effort])) };
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
export const profileFingerprint = (config, name) => createHash('sha256').update(JSON.stringify(agentProfiles(config, name).map(profileString))).digest('hex');
export const profileDefaults = profiles => Object.fromEntries(Object.entries(profiles).map(([team, agents]) => [team, Object.fromEntries(Object.entries(agents).map(([name, config]) => [name, profileFingerprint(config, name)]))]));

/** Refresh only inherited profiles; older scaffolds are recognized by their shipped defaults. */
export async function syncTemplateProfiles(settings, options = {}) {
  const defaults = await projectProfiles({ ...options, runtime: options.replaceModels ? undefined : settings.runtime });
  const legacy = settings.templateDefaults ? undefined : await projectProfiles({ templates: options.templates, library: '', runtime: settings.runtime });
  const previous = settings.templateDefaults ?? profileDefaults(legacy);
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
