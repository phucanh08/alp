/**
 * Live configure of a root (docs/protocol/alp-json-rpc-v1.md §12.9, issue #121 branch D): the pure
 * parts. What a model a client names means for a session's runtime, which models the host offers,
 * the effective configuration a resolved session runs with, and what of it can run commands.
 */
import { createHash } from 'node:crypto';
import { MODELS } from '@anhlp/alp-core/models';
import { profileModel } from '@anhlp/alp-core/profiles';
import type { ConfigureChange, EffectiveConfig } from '@anhlp/alp-protocol/session';
import type { ResolvedSession, RuntimeKind } from './resolve.js';

export type { ConfigureChange, EffectiveConfig } from '@anhlp/alp-protocol/session';

/** What a client may change on a live root; each absent field keeps the session's own. */
export type ConfigureChanges = { model?: string; thinking?: string; team?: string; mode?: string };

/** Runtimes whose roots alpd reconfigures live (macOS and Linux; Codex and Claude, issue #121 closure scope). */
export const CONFIGURABLE: ReadonlySet<RuntimeKind> = new Set(['codex', 'claude'] as RuntimeKind[]);

const PREFIXED = /^(codex|claude|antigravity|acp)[:/](.*)$/s;

/**
 * The native model `model` names for a session of `runtime`: unprefixed, or prefixed with that runtime
 * (`codex:`, `claude:`, or with a slash). A prefix of another runtime is a migration, never taken.
 */
export function nativeModelOf(runtime: RuntimeKind, model: string): { model: string } | { runtime: string } {
  const match = PREFIXED.exec(model);
  if (!match) return { model };
  return match[1] === runtime ? { model: match[2] } : { runtime: match[1] };
}

/**
 * Whether the host offers `model` on `runtime`: ALP's catalog (core MODELS, what library.models and
 * catalog.get list), a model the project's settings give an agent of the team, or the model the session
 * runs already. Never an arbitrary string.
 */
export function offered(runtime: RuntimeKind, model: string, mapping: ResolvedSession) {
  if (model === mapping.model) return true;
  if (MODELS.some(entry => entry.runtime === runtime && entry.id === model)) return true;
  return Object.values(mapping.modelProfiles ?? {}).flat().some(profile => profileModel(profile) === `${runtime}:${model}`);
}

/** MCP servers of a resolved session by name and kind: a stdio one runs a command on the host. */
export function mcpOf(mapping: ResolvedSession): EffectiveConfig['mcpServers'] {
  return Object.entries(mapping.mcp ?? {}).map(([name, server]) => ({ name, kind: server && typeof server === 'object' && 'command' in (server as object) ? 'stdio' as const : 'http' as const }));
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/**
 * What of a resolved session runs commands on the daemon host: its stdio MCP servers (command, args,
 * env names) and its hooks (event and command), each as a digest. A change may keep or drop these,
 * never add one (a team change that brings an executable resource is refused).
 */
export function executablesOf(mapping: ResolvedSession): Set<string> {
  const found = new Set<string>();
  for (const [name, server] of Object.entries(mapping.mcp ?? {}) as Array<[string, any]>) {
    if (server && typeof server === 'object' && 'command' in server) found.add(`mcp:${name}:${digest([server.command, server.args ?? [], Object.keys(server.env ?? {}).sort()])}`);
  }
  for (const hook of (mapping.hooks ?? []) as Array<{ name?: string; event?: unknown; command?: unknown }>) found.add(`hook:${hook.name ?? ''}:${digest([hook.event, hook.command])}`);
  return found;
}

/** The effective configuration of a resolved root, with its delegation targets, ALP tools and instructions digest. */
export function effectiveOf(runtime: RuntimeKind, mapping: ResolvedSession, extra: { delegates: string[]; tools: string[]; supervisor: boolean; instructionsSha?: string }): EffectiveConfig {
  return {
    team: mapping.workflow.mode,
    ...(mapping.team?.label ? { teamLabel: mapping.team.label } : {}),
    agent: mapping.agent.name,
    runtime,
    model: mapping.model,
    thinking: mapping.thinking,
    mode: mapping.mode,
    ...(mapping.permissions?.name ? { permissionProfile: mapping.permissions.name } : {}),
    supervisor: extra.supervisor,
    maxPeers: mapping.workflow.maxPeers,
    delegates: [...extra.delegates],
    tools: [...extra.tools],
    mcpServers: mcpOf(mapping),
    hooks: (mapping.hooks ?? []).length,
    ...(extra.instructionsSha ? { instructionsSha: extra.instructionsSha } : {}),
  };
}

/** Which of model, thinking, team and mode differ between two effective configurations. */
export function changesOf(current: EffectiveConfig, proposed: EffectiveConfig): ConfigureChange[] {
  const changes: ConfigureChange[] = [];
  if (current.model !== proposed.model) changes.push('model');
  if (current.thinking !== proposed.thinking) changes.push('thinking');
  if (current.team !== proposed.team) changes.push('team');
  if (current.mode !== proposed.mode) changes.push('mode');
  return changes;
}
