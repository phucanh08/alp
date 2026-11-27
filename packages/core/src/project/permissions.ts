import path from 'node:path';
import { statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { moveFile } from '../_shared/atomic.ts';
import { AlpError } from '../_shared/errors.ts';
import { fail, object, own, parseRule, setOwn } from './permission-rules.ts';
export { TOOLS, parseRule } from './permission-rules.ts';
export { unwrapShell, simpleCommands, plainCommands, commandDecision } from './permission-commands.ts';

export type PermissionBase = 'read-only' | 'workspace-write' | 'full-access';
export type PermissionProfile = { name: string; base: PermissionBase; allow: string[]; ask: string[]; deny: string[]; beyondMode: 'refuse' | 'ask'; workdir?: 'copy'; cappedFrom?: PermissionBase };
export type PermissionScopeName = 'project' | 'user';
export type PermissionSource = { scope: PermissionScopeName; file: string };
export type PermissionScope = PermissionSource & { exists: boolean; profiles: ReturnType<typeof validatePermissions>['profiles']; agents: Record<string, string> };
/** Where one resolved value came from: a settings file, or ALP's default when no file sets it. */
export type PermissionOrigin<T> = { value: T; key?: string; reason?: string } & (PermissionSource | { scope: 'default' });
export type PermissionRuleOrigin = { rule: string; sources: PermissionSource[] };
export type PermissionProvenance = {
  name: PermissionOrigin<string> & { overrides?: Array<PermissionSource & { value: string }> };
  base: PermissionOrigin<PermissionBase> & { cappedFrom?: PermissionBase };
  beyondMode: PermissionOrigin<'refuse' | 'ask'>;
  workdir?: PermissionOrigin<'copy'>;
  allow: PermissionRuleOrigin[]; ask: PermissionRuleOrigin[]; deny: PermissionRuleOrigin[];
};
export type PermissionWarning = { code: 'project-base-higher' | 'project-allow-rules' | 'project-beyond-mode' | 'user-deny-not-applied' | 'user-ask-not-applied'; agent: string; message: string; rules?: string[]; project?: PermissionBase; user?: PermissionBase };
export type PermissionExplanation = {
  agent: string;
  profile: PermissionProfile | null;
  provenance: PermissionProvenance | null;
  scopes: Array<PermissionSource & { exists: boolean; agentProfile?: string; profile?: ReturnType<typeof validatePermissions>['profiles'][string] }>;
  warnings: PermissionWarning[];
};
/** The settings of one profile as validatePermissions returns them. */
type ProfileSettings = { base?: PermissionBase; beyondMode?: 'refuse' | 'ask'; workdir?: 'copy'; allow: string[]; ask: string[]; deny: string[] };
type Merged = { profile: PermissionProfile | null; provenance: PermissionProvenance | null };

/**
 * Permission profiles: what an agent may do beyond, or never do within, its
 * base mode. Rules use Claude Code's syntax, `Tool` or `Tool(specifier)`, such as
 * `Bash(npm test:*)` (a command prefix), `Bash(git status)` (one exact command),
 * `Edit(src/**)` or `WebFetch(domain:example.com)`.
 *
 * Profiles and the agents they apply to come from `permissions` in the project's
 * .alp/settings.json and the user's $ALP_HOME/settings.json. A profile defined in
 * both takes its base from the project and the rules of both. An agent's entry in
 * the project wins over the user's. Deny wins over ask, and ask over allow: an ask
 * rule makes ALP ask the user every time. With `beyondMode: "ask"`, what the mode
 * refuses and no rule covers is asked too, and the user may allow it always.
 *
 * ALP enforces rules natively where it can: Claude receives deny rules, and allow
 * rules for tools other than Bash, as its own disallowed and allowed tools, which hold
 * in every permission mode; Bash allow rules it would match as written, so ALP decides
 * them in canUseTool (commandDecision). Codex runs
 * commands inside its sandbox without asking, so for Codex an allow rule lets a
 * command leave the sandbox when Codex asks to, and a deny rule refuses that.
 */

export const BASES: PermissionBase[] = ['read-only', 'workspace-write', 'full-access'];
const RANK: Record<string, number> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
/** Agents that advise, review or watch: their profiles stay read-only. */
export const ADVISORS: string[] = ['oracle', 'reviewer', 'supervisor'];
/**
 * Team roles that advise or review. A member serving in one is read-only whatever its name, its
 * agent.json mode or a profile settings give it: callers pass `readOnly` for such a member.
 */
export const READ_ONLY_ROLES: string[] = ['advisor', 'reviewer'];
export const MAX_RULES: number = 200;
const NAME = /^[\w.-]{1,64}$/;

/** Checks the `permissions` field of a settings file. */
export function validatePermissions(value: unknown, source: string): { profiles: Record<string, ProfileSettings>; agents: Record<string, string> } {
  if (value === undefined) return { profiles: {}, agents: {} };
  if (!object(value)) fail(source, 'permissions must be an object');
  for (const key of Object.keys(value)) if (!['profiles', 'agents'].includes(key)) fail(source, `unsupported permissions field '${key}'`);
  const profiles: Record<string, ProfileSettings> = {};
  if (value.profiles !== undefined) {
    if (!object(value.profiles)) fail(source, 'permissions.profiles must be an object');
    for (const [name, profile] of Object.entries(value.profiles)) {
      const where = `permissions.profiles.${name}`;
      if (!NAME.test(name)) fail(source, `${where}: a profile name has letters, digits, dots, dashes and underscores`);
      if (!object(profile)) fail(source, `${where} must be an object`);
      for (const key of Object.keys(profile)) if (!['base', 'allow', 'ask', 'deny', 'beyondMode', 'workdir'].includes(key)) fail(source, `${where}: unsupported field '${key}'`);
      if (profile.workdir !== undefined && profile.workdir !== 'copy') fail(source, `${where}.workdir must be copy`);
      if (profile.workdir === 'copy' && profile.base !== undefined && profile.base !== 'read-only') fail(source, `${where}: workdir copy is for read-only profiles; writers use worktree isolation`);
      if (profile.base !== undefined && !BASES.includes(profile.base)) fail(source, `${where}.base must be ${BASES.join(', ')}`);
      if (profile.beyondMode !== undefined && !['refuse', 'ask'].includes(profile.beyondMode)) fail(source, `${where}.beyondMode must be refuse or ask`);
      const rules: Record<string, string[]> = {};
      for (const kind of ['allow', 'ask', 'deny']) {
        const list = profile[kind] ?? [];
        if (!Array.isArray(list) || list.length > MAX_RULES) fail(source, `${where}.${kind} must list at most ${MAX_RULES} rules`);
        for (const rule of list) parseRule(rule, `${source}: ${where}.${kind}`);
        rules[kind] = list.map((rule: string) => rule.trim());
      }
      setOwn(profiles, name, { ...(profile.base ? { base: profile.base } : {}), ...(profile.beyondMode ? { beyondMode: profile.beyondMode } : {}), ...(profile.workdir ? { workdir: profile.workdir } : {}), ...rules });
    }
  }
  const agents: Record<string, string> = {};
  if (value.agents !== undefined) {
    if (!object(value.agents)) fail(source, 'permissions.agents must be an object');
    for (const [agent, profile] of Object.entries(value.agents)) {
      if (typeof profile !== 'string' || !NAME.test(profile)) fail(source, `permissions.agents.${agent} must name a profile`);
      setOwn(agents, agent, profile);
    }
  }
  return { profiles, agents };
}

async function settingsPermissions(file: string): Promise<ReturnType<typeof validatePermissions>> {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { profiles: {}, agents: {} }; throw error; }
  let settings;
  try { settings = JSON.parse(text); } catch (error) { fail(file, `invalid JSON: ${(error as Error).message}`); }
  if (!object(settings)) fail(file, 'expected an object');
  return validatePermissions(settings.permissions, file);
}

/**
 * The permission profile of an agent, or null when none applies: then the agent
 * keeps the runtime's defaults. Advisors without a profile get a read-only one.
 * `workdir: 'copy'` runs the agent in a disposable copy of its requester's tree,
 * where it may write, build and test; the requester's tree stays untouched.
 * `readOnly` (a member serving as a team advisor or reviewer, READ_ONLY_ROLES): the profile is
 * capped at read-only, and a profile settings give it with a higher base is capped, not obeyed;
 * its rules still apply, as they do for the built-in advisors.
 * @param {{ readOnly?: boolean }} [options]
 * @returns {Promise<{ name: string, base: string, allow: string[], ask: string[], deny: string[], beyondMode: 'refuse' | 'ask', workdir?: 'copy' } | null>}
 */
export async function profileFor(projectRoot: string, home: string | undefined, agent: string, { readOnly = false }: { readOnly?: boolean } = {}): Promise<PermissionProfile | null> {
  const project = await settingsPermissions(path.join(projectRoot, '.alp', 'settings.json'));
  const user = home ? await settingsPermissions(path.join(home, 'settings.json')) : { profiles: {}, agents: {} };
  const name = own(project.agents, agent) ?? own(user.agents, agent);
  const advisor = ADVISORS.includes(agent);
  if (!name) return advisor || readOnly ? { name: 'read-only', base: 'read-only', allow: [], ask: [], deny: [], beyondMode: 'refuse' } : null;
  const defined = [own(project.profiles, name), own(user.profiles, name)].filter(Boolean) as ProfileSettings[];
  if (!defined.length && !BASES.includes(name as PermissionBase)) {
    throw new AlpError('INVALID_SETTINGS', `permissions.agents.${agent} names profile '${name}', which no settings file defines`);
  }
  // A bare base name is a profile with no rules.
  const base = defined.find(profile => profile.base)?.base ?? (BASES.includes(name as PermissionBase) ? name as PermissionBase : advisor ? 'read-only' : 'full-access');
  const copy = defined.some(profile => profile.workdir === 'copy');
  if (copy && base !== 'read-only') throw new AlpError('INVALID_SETTINGS', `Profile '${name}' has workdir copy, which needs base read-only`);
  if (advisor && base !== 'read-only') throw new AlpError('INVALID_SETTINGS', `${agent} is an advisor; its profile '${name}' must have base read-only`);
  return {
    name, base: readOnly ? 'read-only' : base,
    ...(readOnly && base !== 'read-only' ? { cappedFrom: base } : {}),
    allow: [...new Set(defined.flatMap(profile => profile.allow ?? []))],
    ask: [...new Set(defined.flatMap(profile => profile.ask ?? []))],
    deny: [...new Set(defined.flatMap(profile => profile.deny ?? []))],
    beyondMode: defined.find(profile => profile.beyondMode)?.beyondMode ?? 'refuse',
    ...(copy ? { workdir: 'copy' } : {}),
  };
}

// --- provenance (alp config explain) ---------------------------------------------
//
// Nothing below decides what an agent may do: profileFor above does, and it is unchanged. These
// functions resolve the same two settings files one scope at a time, so that every value of the
// merged profile carries the scope and file it came from, and so that a project scope that gives
// more than the user scope can be reported. They explain and warn; they never refuse (t-7d81, the
// user's decision of 2026-11-06: what a user or a project owner grants is intended).

/**
 * The permission settings of each scope, in the order profileFor reads them: the project's
 * .alp/settings.json, then the user's $ALP_HOME/settings.json (absent without a home).
 * Throws INVALID_SETTINGS for a file profileFor would refuse.
 */
export async function permissionScopes(projectRoot: string, home: string | undefined): Promise<PermissionScope[]> {
  const files: Array<[PermissionScopeName, string]> = [['project', path.join(projectRoot, '.alp', 'settings.json')], ...(home ? [['user', path.join(home, 'settings.json')] as [PermissionScopeName, string]] : [])];
  const scopes: PermissionScope[] = [];
  for (const [scope, file] of files) {
    const { profiles, agents } = await settingsPermissions(file);
    scopes.push({ scope, file, exists: Boolean(statSync(file, { throwIfNoEntry: false })), profiles, agents });
  }
  return scopes;
}

/**
 * profileFor's merge over an ordered list of scopes, with where each value came from. With the
 * project and user scopes it returns the profile profileFor returns (or throws what it throws);
 * with one scope alone, what that scope would give the agent by itself.
 */
function mergeScopes(scopes: PermissionScope[], agent: string, readOnly: boolean): Merged {
  const mapped = scopes.find(scope => own(scope.agents, agent));
  const name = mapped ? own(mapped.agents, agent) : undefined;
  const advisor = ADVISORS.includes(agent);
  const from = (scope: PermissionScope): PermissionSource => ({ scope: scope.scope, file: scope.file });
  if (!name) {
    if (!(advisor || readOnly)) return { profile: null, provenance: null };
    const reason = advisor ? `${agent} is an advisor` : 'the member serves in a read-only role';
    return {
      profile: { name: 'read-only', base: 'read-only', allow: [], ask: [], deny: [], beyondMode: 'refuse' },
      provenance: { name: { value: 'read-only', scope: 'default', reason }, base: { value: 'read-only', scope: 'default', reason }, beyondMode: { value: 'refuse', scope: 'default' }, allow: [], ask: [], deny: [] },
    };
  }
  const defined = scopes.filter(scope => own(scope.profiles, name));
  const profiles = defined.map(scope => own(scope.profiles, name)!);
  if (!defined.length && !BASES.includes(name as PermissionBase)) {
    throw new AlpError('INVALID_SETTINGS', `permissions.agents.${agent} names profile '${name}', which no settings file defines`);
  }
  const baseScope = defined.find(scope => own(scope.profiles, name)!.base);
  const base = baseScope ? own(baseScope.profiles, name)!.base! : BASES.includes(name as PermissionBase) ? name as PermissionBase : advisor ? 'read-only' : 'full-access';
  const copyScope = defined.find(scope => own(scope.profiles, name)!.workdir === 'copy');
  if (copyScope && base !== 'read-only') throw new AlpError('INVALID_SETTINGS', `Profile '${name}' has workdir copy, which needs base read-only`);
  if (advisor && base !== 'read-only') throw new AlpError('INVALID_SETTINGS', `${agent} is an advisor; its profile '${name}' must have base read-only`);
  const modeScope = defined.find(scope => own(scope.profiles, name)!.beyondMode);
  const rules = (kind: 'allow' | 'ask' | 'deny') => [...new Set(profiles.flatMap(profile => profile[kind] ?? []))];
  const sources = (kind: 'allow' | 'ask' | 'deny') => rules(kind).map(rule => ({ rule, sources: defined.filter(scope => (own(scope.profiles, name)![kind] ?? []).includes(rule)).map(from) }));
  const shadowed = scopes.filter(scope => scope !== mapped && own(scope.agents, agent)).map(scope => ({ ...from(scope), value: own(scope.agents, agent)! }));
  return {
    profile: {
      name, base: readOnly ? 'read-only' : base,
      ...(readOnly && base !== 'read-only' ? { cappedFrom: base } : {}),
      allow: rules('allow'), ask: rules('ask'), deny: rules('deny'),
      beyondMode: modeScope ? own(modeScope.profiles, name)!.beyondMode! : 'refuse',
      ...(copyScope ? { workdir: 'copy' } : {}),
    },
    provenance: {
      name: { value: name, ...from(mapped!), key: `permissions.agents.${agent}`, ...(shadowed.length ? { overrides: shadowed } : {}) },
      base: {
        value: readOnly ? 'read-only' : base,
        ...(baseScope ? { ...from(baseScope), key: `permissions.profiles.${name}.base` }
          // A bare base name is a profile with no rules: the mapping itself is where the base comes from.
          : BASES.includes(name as PermissionBase) ? { ...from(mapped!), key: `permissions.agents.${agent}`, reason: 'a bare base name' }
          : { scope: 'default', reason: advisor ? `${agent} is an advisor` : `profile '${name}' sets no base` }),
        ...(readOnly && base !== 'read-only' ? { cappedFrom: base, reason: 'capped: the member serves in a read-only role' } : {}),
      },
      beyondMode: modeScope ? { value: own(modeScope.profiles, name)!.beyondMode!, ...from(modeScope), key: `permissions.profiles.${name}.beyondMode` } : { value: 'refuse', scope: 'default' },
      ...(copyScope ? { workdir: { value: 'copy', ...from(copyScope), key: `permissions.profiles.${name}.workdir` } } : {}),
      allow: sources('allow'), ask: sources('ask'), deny: sources('deny'),
    },
  };
}

/** What the project scope gives an agent beyond what the user scope says. Warnings only: nothing here refuses. */
function wideningWarnings(scopes: PermissionScope[], agent: string, merged: Merged, readOnly: boolean): PermissionWarning[] {
  const project = scopes.find(scope => scope.scope === 'project');
  const user = scopes.find(scope => scope.scope === 'user');
  if (!merged.profile || !project || !user) return [];
  const { profile, provenance } = merged;
  // What the user scope alone would give this agent. A mapping to a profile only the project defines says nothing alone.
  let alone: Merged = { profile: null, provenance: null };
  try { alone = mergeScopes([user], agent, readOnly); } catch {}
  const warnings: PermissionWarning[] = [];
  // The base the project brings, before a read-only role caps it.
  const base = profile.cappedFrom ?? profile.base;
  const byProject = provenance!.base.scope === 'project';
  // The user's base for this agent: in the user's definition of the same profile, or in what the user scope alone resolves to.
  const sameProfile = own(user.profiles, profile.name)?.base;
  const aloneBase = alone.provenance?.base.scope === 'user' ? alone.provenance.base.cappedFrom ?? alone.profile!.base : undefined;
  const userBase = ([sameProfile, aloneBase].filter(Boolean) as PermissionBase[]).sort((a, b) => RANK[a] - RANK[b])[0];
  if (byProject && userBase && RANK[base] > RANK[userBase]) {
    warnings.push({
      code: 'project-base-higher', agent, project: base, user: userBase,
      message: `the project sets base ${base} (${provenance!.base.key} in ${project.file}); your settings say ${userBase} (${user.file}). The project's value applies${profile.cappedFrom ? `, capped to ${profile.base} by the member's read-only role` : ''}.`,
    });
  }
  const onlyProject = (entry: PermissionRuleOrigin) => entry.sources.every(source => source.scope === 'project');
  const extra = provenance!.allow.filter(entry => onlyProject(entry) && !(alone.profile?.allow ?? []).includes(entry.rule)).map(entry => entry.rule);
  if (extra.length) {
    warnings.push({
      code: 'project-allow-rules', agent, rules: extra,
      message: `the project adds ${extra.length === 1 ? 'an allow rule' : `${extra.length} allow rules`} your settings do not have (${project.file}): ${extra.join(', ')}. ${extra.length === 1 ? 'It applies' : 'They apply'}, also beyond the agent's mode.`,
    });
  }
  if (profile.beyondMode === 'ask' && provenance!.beyondMode.scope === 'project' && alone.profile?.beyondMode !== 'ask') {
    warnings.push({
      code: 'project-beyond-mode', agent,
      message: `the project sets beyondMode ask (${provenance!.beyondMode.key} in ${project.file}): what the agent's mode refuses is asked instead, and may be allowed always.`,
    });
  }
  // A user profile the project's mapping replaces: its deny and ask rules are not loaded.
  for (const kind of ['deny', 'ask'] as const) {
    const dropped = (alone.profile?.[kind] ?? []).filter(rule => !profile[kind].includes(rule));
    if (!dropped.length) continue;
    warnings.push({
      code: `user-${kind}-not-applied`, agent, rules: dropped,
      message: `the project maps ${agent} to profile ${profile.name} (${project.file}), so the ${kind} rule${dropped.length === 1 ? '' : 's'} of your profile ${alone.profile!.name} (${user.file}) ${dropped.length === 1 ? 'does' : 'do'} not apply: ${dropped.join(', ')}.`,
    });
  }
  return warnings;
}

/**
 * Explains an agent's permission profile: `profile` is what profileFor returns for the same
 * arguments (and this throws what profileFor throws), `provenance` names the scope and file of its
 * name, base, beyondMode, workdir and of every allow, ask and deny rule (null when no profile
 * applies), `scopes` says what each settings file holds for the agent, and `warnings` lists what
 * the project scope gives beyond the user scope. A warning never changes the profile.
 * @param {{ readOnly?: boolean }} [options]
 */
export async function explainProfile(projectRoot: string, home: string | undefined, agent: string, { readOnly = false }: { readOnly?: boolean } = {}): Promise<PermissionExplanation> {
  const scopes = await permissionScopes(projectRoot, home);
  const merged = mergeScopes(scopes, agent, readOnly);
  return {
    agent,
    profile: merged.profile,
    provenance: merged.provenance,
    scopes: scopes.map(scope => {
      const name = own(scope.agents, agent);
      const defined = merged.profile ? own(scope.profiles, merged.profile.name) : undefined;
      return { scope: scope.scope, file: scope.file, exists: scope.exists, ...(name ? { agentProfile: name } : {}), ...(defined ? { profile: defined } : {}) };
    }),
    warnings: wideningWarnings(scopes, agent, merged, readOnly),
  };
}

/**
 * Adds an allow rule to a profile, in the settings file that defines it (the
 * project's first), when the user allows something always. Returns the file.
 */
export async function addAllowRule(projectRoot: string, home: string | undefined, profileName: string, rule: string): Promise<string> {
  parseRule(rule);
  for (const file of [path.join(projectRoot, '.alp', 'settings.json'), ...(home ? [path.join(home, 'settings.json')] : [])]) {
    let settings;
    try { settings = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    const profile = settings?.permissions?.profiles?.[profileName];
    if (!object(profile)) continue;
    profile.allow = [...new Set([...(profile.allow ?? []), rule])];
    validatePermissions(settings.permissions, file);
    const temporary = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`);
    await moveFile(temporary, file);
    return file;
  }
  throw new AlpError('INVALID_SETTINGS', `No settings file defines profile ${profileName}`);
}

/** The lower of two modes. */
export const capMode = (mode: string, base: string): string => (RANK[mode] ?? 0) <= (RANK[base] ?? 0) ? mode : base;
