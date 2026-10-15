import path from 'node:path';
import type { ProviderSessionConfig, ProviderPersistence } from './compat.js';

/**
 * The parts of the Paseo ↔ ALP mapping that need nothing but the wire: no core, no runtime, no
 * filesystem. The provider (provider.ts) and the remote entry (remote/) share them; mapping.ts adds
 * what reads the library and runtime catalogue for the local and embedded modes.
 */

export const DEFAULT_TEAM = 'pho';

/** The permission modes ALP sessions run in (packages/runtime/src/catalog.ts), as Paseo lists them. */
export const MODES = [{ id: 'read-only', label: 'Read only' }, { id: 'workspace-write', label: 'Workspace write' }, { id: 'full-access', label: 'Full access' }];

/** A Paseo model selection that names a team: an id without a runtime prefix. */
export const teamName = (model: string | null | undefined) => model && !model.includes(':') && !model.includes('/') ? model : undefined;

/**
 * The model list a session's config shows: its team for a root, its own model for a child or a
 * custom root. `labelOf` names a model id when the catalogue knows it.
 */
export function configModels(session: { parentId?: string; runtime: string; model: string; workflow: { mode: string }; teamLabel?: string }, labelOf: (id: string) => { label: string; description?: string } | undefined = () => undefined) {
  if (!session.parentId && session.workflow.mode !== 'custom') return { model: session.workflow.mode, models: [{ id: session.workflow.mode, label: session.teamLabel ?? session.workflow.mode, thinkingOptions: [] }] };
  const id = `${session.runtime}:${session.model}`;
  const known = labelOf(id);
  return { model: id, models: [{ id, label: known?.label ?? id, ...(known?.description ? { description: known.description } : {}), thinkingOptions: [] }] };
}

/**
 * Version 2 names a session in alpd, which keeps its native thread and history.
 * Version 1 (plugin 0.2) carried the native thread itself; alpd adopts it on open.
 */
export type AlpdHandle = { alpdSessionId: string; agent: string; cwd: string };

export const handleFor = (session: { id: string; agent: string; projectRoot: string }): ProviderPersistence => ({
  version: 2,
  data: { alpdSessionId: session.id, agent: session.agent, cwd: session.projectRoot },
});

/**
 * The alpd session a version 2 handle names, after checking it belongs to this project. `sameProject`
 * says whether the handle's directory (alpd's projectRoot) is the session's; locally that is the
 * resolved path, remotely the workspace the credential names it by.
 */
export function alpdSessionOf(config: ProviderSessionConfig, persistence?: ProviderPersistence, sameProject = (stored: string, cwd: string) => stored === path.resolve(cwd)) {
  if (persistence?.version !== 2) return undefined;
  const data = persistence.data as Partial<AlpdHandle> | undefined;
  if (!data || typeof data.alpdSessionId !== 'string' || typeof data.agent !== 'string' || typeof data.cwd !== 'string' || !sameProject(data.cwd, config.cwd)) throw new Error('Invalid ALP persistence or project mismatch');
  const agent = config.providerOptions?.agent;
  if (agent !== undefined && agent !== data.agent) throw new Error('Cannot resume a thread as a different ALP agent');
  return data.alpdSessionId;
}
