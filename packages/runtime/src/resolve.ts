import path from 'node:path';
import { access, readFile, stat } from 'node:fs/promises';
import { defaultTeam, resolveWorkflow } from '@anhlp/alp-core/workflow';
import { initProject } from '@anhlp/alp-core/init';
import { profileModel, agentProfiles, selectedProfile } from '@anhlp/alp-core/profiles';
import { jsonObject, resolveAgent } from '@anhlp/alp-core/resolver';
import { resolveTeam, teamOf } from '@anhlp/alp-core/teams';
import { loadHooks } from '@anhlp/alp-core/hooks';
import { acpModel, loadProvider } from '@anhlp/alp-core/providers';
import type { AcpProvider } from './acp-transport.js';
import type { AntigravityProvider } from './antigravity-transport.js';
import { ensureLibrary } from '@anhlp/alp-core/library';
import { compileAgent } from '@anhlp/alp-core/adapter';
import { capMode, profileFor } from '@anhlp/alp-core/permissions';
import { compactSettings } from './compact.js';
import { userLanguage } from '@anhlp/alp-core/user-settings';
import { claudeSandboxAvailable } from './claude-transport.js';
import type { ResolvedAgent } from '@anhlp/alp-core/types';
import type { AlpRuntimeAdapter } from '@anhlp/alp-core/adapter';
import { DEFAULT_ANTIGRAVITY_MODEL, DEFAULT_CLAUDE_MODEL, DEFAULT_MODEL, ORACLE_MODELS, ORACLE_THINKING, models, modes, thinkingOptions, thinkingOptionsFor } from './catalog.js';

/** Codex and Claude Code, or an ACP agent the user's library defines (ALPD §46). */
import type { RuntimeKind } from '@anhlp/alp-protocol/dto';
export type { RuntimeKind } from '@anhlp/alp-protocol/dto';

import type { HostMcpServer, SessionSpec } from '@anhlp/alp-protocol/session';
export type { HostMcpServer, SessionSpec } from '@anhlp/alp-protocol/session';

export type ResolvedSession = Awaited<ReturnType<typeof resolveSession>>;

async function exists(target: string) {
  try {
    await access(target);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

/** How much of a skill's description its listing carries. */
const SKILL_DESCRIPTION_CHARS = 400;

/** The description in a SKILL.md's frontmatter, on one line; empty when it has none. */
export async function skillDescription(file: string) {
  const text = await readFile(file, 'utf8').catch(() => '');
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const match = /^description:[ \t]*(.*(?:\r?\n[ \t]+.*)*)/m.exec(front)?.[1] ?? '';
  const flat = match.replace(/^[>|][-+]?/, '').replace(/\s+/g, ' ').trim().replace(/^(['"])(.*)\1$/, '$2');
  return flat.length > SKILL_DESCRIPTION_CHARS ? `${flat.slice(0, SKILL_DESCRIPTION_CHARS - 1)}…` : flat;
}

/**
 * Composes project and agent instructions with the agent's skills (ALPD §59): each by
 * name, file and description, so an agent knows which work a skill is for without
 * opening it, and opens it before that work.
 */
export class InstructionsAdapter implements AlpRuntimeAdapter<{ instructions: string; mcp: ResolvedAgent['mcp']; runtime: ResolvedAgent['runtime'] }> {
  id = 'native';
  // ALP runs an agent's hooks itself, at its own events (ALPD §45).
  capabilities() { return { instructions: 'emulated', skills: 'emulated', hooks: 'emulated', mcp: 'native' } as const; }
  async compile(agent: ResolvedAgent) {
    const listed = await Promise.all(agent.skills.map(async skill => {
      const description = await skillDescription(skill.path);
      return `- ${skill.name} (${skill.path})${description ? `: ${description}` : ''}`;
    }));
    const skills = listed.length
      ? 'Your skills: methods written for kinds of work. Before you start work that a skill\'s description matches, read its SKILL.md and follow it; say which skill you use.\n' + listed.join('\n')
      : '';
    return { adapterId: this.id, agentName: agent.name, projectRoot: agent.projectRoot, material: {
      instructions: [agent.instructions.project, agent.instructions.agent, skills].filter(Boolean).join('\n\n'),
      mcp: agent.mcp, runtime: agent.runtime,
    } };
  }
}

/** Lessons main recorded after supervisor reviews; the newest are kept when the file grows. */
export const LESSONS_FILE = 'lessons.md';
const LESSON_CHARS = 6000;

async function lessons(file: string) {
  const text = (await readFile(file, 'utf8').catch(() => '')).trim();
  return text.length > LESSON_CHARS ? `…\n${text.slice(-LESSON_CHARS)}` : text;
}

/** Agents that advise, review, or watch: they never write, and take no tasks. */
export const READ_ONLY_AGENTS = ['oracle', 'reviewer', 'supervisor'];

export async function resolveSession(spec: SessionSpec, options: { templates?: Record<string, string>; library?: string; language?: string; /** False for a preview: it writes nothing (D31). */ initialize?: boolean } = {}) {
  if (!path.isAbsolute(spec.cwd) || !(await stat(spec.cwd)).isDirectory()) throw new Error('Session cwd must be an existing absolute directory');
  if (spec.workdir !== undefined && (!path.isAbsolute(spec.workdir) || !(await stat(spec.workdir)).isDirectory())) throw new Error('Session workdir must be an existing absolute directory');
  const starter = options.templates ? { templates: options.templates } : {};
  if (options.initialize !== false) {
    const settingsFile = path.join(spec.cwd, '.alp', 'settings.json');
    const scaffoldMissing = !(await exists(path.join(spec.cwd, 'ALP.md'))) || !(await exists(settingsFile));
    if (scaffoldMissing) await initProject(spec.cwd, { ...starter, library: options.library });
    else if (!spec.restore) {
      const settings = await jsonObject(settingsFile, 'INVALID_SETTINGS');
      await initProject(spec.cwd, { ...starter, library: options.library, onlyManagedProfiles: true, teamIds: [spec.workflow === undefined ? defaultTeam(settings) : teamOf(spec.workflow)] });
    }
  }
  if (options.library) await ensureLibrary(options.library, options.templates ? { templates: options.templates } : {});
  const restored = spec.restore;
  if (restored && spec.agent !== undefined && spec.agent !== restored.agent) throw new Error('Cannot resume a thread as a different ALP agent');
  const { team, ...workflow } = await resolveWorkflow(spec.cwd, spec.workflow, restored?.workflow, { library: options.library, templates: options.templates, scaffold: options.initialize === false });
  const agent = await resolveAgent(spec.cwd, { agent: spec.agent ?? restored?.agent, library: options.library, templates: options.templates });
  const oracleModels = team?.oracleModels ?? ORACLE_MODELS;
  if (agent.name === 'oracle' && !restored && !oracleModels.includes(spec.model ?? '')) throw new Error(`Oracle runs on ${oracleModels.join(' or ')}; choose one`);
  const projectSettings: import('@anhlp/alp-core/types').RawSettings = await jsonObject(path.join(spec.cwd, '.alp/settings.json'), 'INVALID_SETTINGS');
  const profile = (projectSettings.team ?? projectSettings.profile)?.[workflow.mode]?.[agent.name];
  const modelProfiles: Record<string, import('@anhlp/alp-core/types').AgentModelConfig[]> = Object.fromEntries(Object.entries((projectSettings.team ?? projectSettings.profile)?.[workflow.mode] ?? {}).map(([name, config]) => [name, agentProfiles(config, name)]));
  const requestedModel = restored?.model ? `${restored.runtime ?? agent.runtime.provider ?? 'codex'}:${restored.model}` : spec.model;
  const profileChoice = selectedProfile(modelProfiles[agent.name] ?? [], requestedModel);
  const projectModel = profileModel(profileChoice);
  const compiled = await compileAgent(new InstructionsAdapter(), agent);
  // Order (ALPD §42): the caller, then settings.json's runtime, then the team's choice for this member, then the agent's own.
  // A resumed session keeps its model; it keeps the team's effort while it still runs on the team's model.
  // A custom graph has no team; its main runs as Phở's does, and follows Phở's house rules, as before teams.
  const base = team ?? await resolveTeam(undefined, 'pho', { templates: options.templates });
  const main = base.main;
  const member = Object.hasOwn(base.members, agent.name) && (team || agent.name === main) ? base.members[agent.name] : undefined;
  const sameModel = (id?: string) => id === undefined || restored?.model === undefined || `${restored.runtime}:${restored.model}` === id || restored.model === id;
  const teamChoice = member && !agent.projectRuntime?.model && !agent.projectRuntime?.provider && spec.model === undefined && sameModel(member.model) ? member : undefined;
  let runtimeKind = restored?.runtime ?? profileChoice?.provider ?? (teamChoice?.model ? undefined : agent.runtime.provider) ?? 'codex';
  let model = restored?.model ?? spec.model ?? projectModel ?? teamChoice?.model ?? agent.runtime.model ?? (runtimeKind === 'claude' ? DEFAULT_CLAUDE_MODEL : DEFAULT_MODEL);
  if (model.startsWith('codex:')) { runtimeKind = 'codex'; model = model.slice('codex:'.length); }
  if (model.startsWith('claude:')) { runtimeKind = 'claude'; model = model.slice('claude:'.length); }
  if (model.startsWith('codex/')) { runtimeKind = 'codex'; model = model.slice('codex/'.length); }
  if (model.startsWith('claude/')) { runtimeKind = 'claude'; model = model.slice('claude/'.length); }
  if (model.startsWith('antigravity:')) { runtimeKind = 'antigravity'; model = model.slice('antigravity:'.length); }
  if (model.startsWith('antigravity/')) { runtimeKind = 'antigravity'; model = model.slice('antigravity/'.length); }
  if (model.startsWith('acp:')) {
    const raw = model.slice('acp:'.length);
    if (raw.startsWith('antigravity/') || raw === 'antigravity') {
      runtimeKind = 'antigravity';
      model = raw.startsWith('antigravity/') ? raw.slice('antigravity/'.length) : '';
    } else {
      runtimeKind = 'acp';
      model = raw;
    }
  }
  if (runtimeKind === 'antigravity') {
    if (!model.trim() || model === DEFAULT_MODEL) model = DEFAULT_ANTIGRAVITY_MODEL;
  }
  // An agent.json provider other than builtins names an ACP provider of the library; its model is that provider's.
  if (!['codex', 'claude', 'acp', 'antigravity'].includes(runtimeKind)) { model = model === DEFAULT_MODEL && agent.runtime.model !== DEFAULT_MODEL ? runtimeKind : `${runtimeKind}/${model}`; runtimeKind = 'acp'; }
  if (restored?.runtime && runtimeKind !== restored.runtime) throw new Error('Cannot resume a thread with a different runtime provider');
  let acp: AcpProvider | undefined;
  if (runtimeKind === 'acp') {
    const { provider: id, model: native } = acpModel(model);
    acp = await loadProvider(options.library, id) as AcpProvider | undefined;
    if (!acp) throw new Error(`No ACP provider '${id}': add one to your library with alp provider add ${id}, or name codex or claude`);
    if (acp.enabled === false) throw new Error(`ACP provider '${id}' is turned off; turn it on in the web app's Providers settings or in providers/${id}.json`);
    const listed = [...(acp.models ?? []), ...(acp.additionalModels ?? [])];
    if (native && acp.models && !listed.some(candidate => candidate.id === native)) throw new Error(`ACP provider '${id}' lists no model '${native}'`);
    if (spec.copy) throw new Error('A review copy cannot run on an ACP agent: ALP cannot keep its commands inside the copy');
  }
  let antigravity: AntigravityProvider | undefined;
  if (runtimeKind === 'antigravity') {
    const provider = await loadProvider(options.library, 'antigravity');
    if (provider && provider.kind === 'antigravity') {
      antigravity = provider as unknown as AntigravityProvider;
      if (antigravity.enabled === false) throw new Error("Antigravity provider 'antigravity' is turned off; turn it on in the web app's Providers settings or in providers/antigravity.json");
    }
  }
  // Main has full access unless the caller limits it; a permission profile caps the mode at its base.
  // agy enforces each mode itself (antigravityModeArgs): it denies what the mode does not allow.
  const permissions = await profileFor(agent.projectRoot, options.library, agent.name);
  const requested = spec.mode ?? agent.mode ?? (agent.name === main ? 'full-access' : 'read-only');
  const mode = permissions ? capMode(requested, permissions.base) : requested;
  if (runtimeKind === 'antigravity') {
    if (spec.copy || permissions?.workdir === 'copy') throw new Error('Antigravity cannot enforce isolation for a review copy');
    if (permissions && (permissions.deny.length || permissions.ask.length || permissions.allow.length || permissions.beyondMode === 'ask')) {
      throw new Error('Antigravity cannot enforce custom permission rules');
    }
  }
  // An ACP or Antigravity agent chooses its own effort.
  const availableThinking = ['acp', 'antigravity'].includes(runtimeKind) ? [] : thinkingOptionsFor(runtimeKind as 'codex' | 'claude' | 'antigravity', model);
  const preferred = ['acp', 'antigravity'].includes(runtimeKind) ? 'none' : spec.thinking ?? profileChoice?.effort ?? agent.projectRuntime?.reasoning ?? (agent.name === 'oracle' ? team?.oracleThinking?.[`${runtimeKind}:${model}`] ?? team?.oracleThinking?.[runtimeKind] : undefined) ?? teamChoice?.thinking ?? agent.runtime.reasoning ??
    (agent.name === 'oracle' ? ORACLE_THINKING : availableThinking.length ? 'medium' : 'none');
  // A default the model does not take gives way to the model's own (GPT-6 Astra runs at low only); an explicit choice is checked below.
  const thinking = spec.thinking === undefined && availableThinking.length && !availableThinking.some(candidate => candidate.id === preferred)
    ? models.find(candidate => candidate.id === `${runtimeKind}:${model}`)?.defaultThinkingOptionId ?? availableThinking[0].id
    : preferred;
  if (!model.trim()) throw new Error('Model must be nonempty');
  if (!modes.some(m => m.id === mode)) throw new Error(`Unsupported mode '${mode}'`);
  // Only Claude's Bash sandbox keeps a session in a copy from writing elsewhere.
  if (spec.copy && runtimeKind === 'claude' && !claudeSandboxAvailable()) throw new Error('A review copy on Claude needs its Bash sandbox (Seatbelt on macOS; bubblewrap and socat on Linux)');
  if (!thinkingOptions.some(m => m.id === thinking)) throw new Error(`Unsupported thinking option '${thinking}'`);
  if (availableThinking.length && !availableThinking.some(candidate => candidate.id === thinking)) throw new Error(`Thinking option '${thinking}' is unsupported by ${runtimeKind}:${model}`);
  const mcp: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(compiled.material.mcp.mcpServers) as [string, any][]) {
    const { headers, ...rest } = value;
    Object.defineProperty(mcp, name, { value: { ...rest, ...(headers ? { http_headers: headers } : {}) }, enumerable: true, writable: true });
  }
  for (const [name, value] of Object.entries(spec.mcpServers ?? {})) {
    if (Object.hasOwn(mcp, name)) throw new Error(`MCP server name collision: '${name}'`);
    if (value.type === 'sse') throw new Error(`SSE MCP server '${name}' is unsupported by this runtime`);
    const server = value.type === 'stdio'
      ? { command: value.command, args: value.args ?? [], env: value.env ?? {} }
      : { url: value.url, http_headers: value.headers ?? {} };
    Object.defineProperty(mcp, name, { value: server, enumerable: true, writable: true });
  }
  // Main follows its lessons; the supervisor checks them.
  let learned = '';
  const supervisorAgent = team?.supervisor ? team.supervisor.agent : undefined;
  if ([main, supervisorAgent].includes(agent.name) && workflow.supervisor) {
    const user = options.library ? await lessons(path.join(options.library, LESSONS_FILE)) : '';
    const project = await lessons(path.join(agent.projectRoot, '.alp', LESSONS_FILE));
    if (user || project) {
      learned = 'Lessons main recorded after earlier supervisor reviews. Follow them; they are the user\'s process, not a task.' +
        (user ? `\n\nFor every project:\n${user}` : '') + (project ? `\n\nFor this project:\n${project}` : '');
    }
  }
  const houseRules = base.houseRules;
  const hooks = await loadHooks(agent);
  return {
    agent, workflow, team, oracleModels, modelProfiles, houseRules, hooks, runtimeKind: runtimeKind as RuntimeKind, model, ...(acp ? { acp } : {}), ...(antigravity ? { antigravity } : {}), mode, permissions, thinking, threadId: restored?.threadId,
    workdir: spec.workdir ?? agent.projectRoot,
    copy: Boolean(spec.copy && spec.workdir),
    ...(spec.copy && spec.copyOf ? { copyOf: spec.copyOf } : {}),
    instructions: [compiled.material.instructions, learned, spec.systemPrompt].filter(Boolean).join('\n\n'),
    mcp, env: { ...spec.env }, persist: spec.persist ?? false, keepThread: spec.keepThread ?? false,
    // ALPD §57: the window the agent works in before its runtime compacts; absent, the model's.
    ...(agent.context ? { context: agent.context } : {}),
    autocompact: typeof profile?.autocompact === 'number' ? profile.autocompact as number : typeof agent.autocompact === 'number' ? agent.autocompact : undefined,
    // t-0e56: when main's context is compacted at a turn boundary.
    compact: compactSettings(projectSettings.compact),
    // ALPD §54: the language everything the user reads is written in.
    language: options.language ?? await userLanguage(options.library),
  };
}
