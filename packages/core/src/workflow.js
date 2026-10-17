import path from 'node:path';
import { jsonObject, optionalText } from './resolver.js';
import { applyProfile } from './profiles.js';
import { validateSettings } from './validation.js';
import { resolveTeam, teamOf } from './teams.js';

export { teamOf as profileOf } from './teams.js';

/** The team `alp init` names in a new project's settings (`init.js`). */
export const INIT_TEAM = 'pho';

/**
 * The team a session runs in when the caller selects none (ALPD §42, §60): the one a resumed
 * session ran in, else settings' workflow.mode, else `custom` (settings' delegation graph, no
 * supervisor). A project without .alp/settings.json gets init's settings when a session is
 * created, so with `scaffolded` a missing file counts as naming INIT_TEAM. session.create and
 * session.preview both resolve through here, so a preview names the team that would run.
 * @param {Record<string, any>} settings the project's settings, `{}` when the file is missing
 * @param {{ restored?: { mode: string }, scaffolded?: boolean }} [options]
 */
export function defaultTeam(settings, { restored, scaffolded = false } = {}) {
  return teamOf(restored?.mode ?? settings.workflow?.mode ?? (scaffolded ? INIT_TEAM : 'custom'));
}

/**
 * The team a session runs in (ALPD §42): the one the caller selects, else defaultTeam. Without
 * any, the session is `custom`: its graph is settings' delegation and no supervisor watches it.
 * Selecting `custom` is refused unless it is the team that would run anyway, so a client may send
 * back the team session.preview named.
 * @param {string} root
 * @param {string | undefined} selected
 * @param {{ mode: string, maxPeers?: number, supervisor?: boolean } | undefined} restored
 * @param {{ library?: string, templates?: Record<string, string>, scaffold?: boolean }} [options]
 *   scaffold: a missing settings file will be written by init before the session runs (a preview).
 * @returns {Promise<{ mode: string, maxPeers: number, supervisor: boolean, team?: Awaited<ReturnType<typeof resolveTeam>> }>}
 */
export async function resolveWorkflow(root, selected, restored, { library, templates, scaffold = false } = {}) {
  const file = path.join(root, '.alp/settings.json');
  const settings = await jsonObject(file, 'INVALID_SETTINGS');
  validateSettings(settings, '.alp/settings.json');
  const scaffolded = scaffold && await optionalText(file) === undefined;
  const fallback = defaultTeam(settings, { restored, scaffolded });
  const chosen = selected === undefined ? undefined : teamOf(selected);
  if (chosen === 'custom' && fallback !== 'custom') throw new Error('Choose a team, such as pho (Phở) or cafe (Cafe)');
  const mode = chosen ?? fallback;
  if (restored && mode !== teamOf(restored.mode)) throw new Error('Cannot change team in an existing session');
  const team = mode === 'custom' ? undefined : applyProfile(await resolveTeam(root, mode, { library, templates }), (settings.team ?? settings.profile)?.[mode]);
  const maxPeers = restored?.maxPeers ?? settings.workflow?.maxPeers ?? team?.maxPeers ?? 2;
  if (!Number.isSafeInteger(maxPeers) || maxPeers < 1) throw new Error('workflow.maxPeers must be a positive integer');
  // A custom delegation graph has no main to supervise; settings can turn a team's supervisor off.
  const supervisor = !!team?.supervisor && (restored?.supervisor ?? settings.workflow?.supervisor ?? true);
  return { mode, maxPeers, supervisor, ...(team ? { team } : {}) };
}
