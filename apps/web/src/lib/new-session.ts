/**
 * The New session screen's logic without React: the models with the efforts each takes
 * (library.models), the thinking options of the model a session would run, the spec sent to
 * session.preview and session.create (only fields the gateway allows: cwd, workflow, mode, model,
 * thinking, persist), what session.preview answers as rows a person reads, and the title a first
 * message gives a session that has none.
 */

export type ModelRow = { id: string; label: string; efforts: string[]; effort?: string; };
export type Choices = { team?: string; mode?: string; model?: string; thinking?: string; };
export type Preview = {
  teams: Array<{ id: string; label: string; description?: string; }>; team: string; teamLabel?: string;
  agent: string; runtime: string; model: string; mode: string; thinking: string;
};

const RUNTIME_LABELS = { codex: 'Codex', claude: 'Claude', acp: 'ACP', antigravity: 'Antigravity' } as Record<string, string>;
const MODE_LABELS = { 'read-only': 'Read only', 'workspace-write': 'Workspace write', 'full-access': 'Full access' } as Record<string, string>;

/** A team the workspace does not list: `custom` runs settings' delegation graph (ALPD §42). */
const unlistedLabel = (team: string) => team === 'custom' ? 'Custom' : team;

const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;

/**
 * library.models rows the app can use: an id, a label, the efforts (strings, deduplicated) and
 * the usual one when it is among them.
 */
export function normalizeModels(rows: unknown): ModelRow[] {
  if (!Array.isArray(rows)) return [];
  const models: Map<string, ModelRow> = new Map();
  for (const row of rows) {
    const id = text(row?.id);
    if (!id || models.has(id)) continue;
    const efforts = Array.isArray(row.efforts) ? [...new Set(row.efforts.filter((effort: unknown) => !!text(effort)))] : [];
    const effort = text(row.effort);
    models.set(id, { id, label: text(row.label) ?? id, efforts: efforts as string[], ...(effort && efforts.includes(effort) ? { effort } : {}) });
  }
  return [...models.values()];
}

/**
 * A thinking option as Paseo labels one (formatThinkingOptionLabel): sentence case, "xhigh" as
 * Extra high.
 */
export function effortLabel(effort: string) {
  const compact = effort.replace(/[\s_-]+/g, '').toLowerCase();
  if (compact === 'xhigh') return 'Extra high';
  const words = effort.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1).toLowerCase() : effort;
}

/**
 * The model a session would run: the one chosen, else the one session.preview names (as
 * `runtime:model`, library.models' ids), when the list knows it.
 */
export function effectiveModel(models: ModelRow[], chosen: string | undefined, preview: Partial<Preview> | undefined): ModelRow | undefined {
  if (chosen) return models.find(model => model.id === chosen);
  if (!preview?.model) return undefined;
  const full = preview.runtime ? `${preview.runtime}:${preview.model}` : preview.model;
  return models.find(model => model.id === full) ?? models.find(model => model.id === preview.model);
}

/**
 * The thinking options to offer for a model: its efforts, each with Paseo's label. None when the
 * model takes no effort or is unknown (then the control hides and no thinking is sent).
 */
export function effortOptions(model: ModelRow | undefined): Array<{ id: string; label: string; }> {
  return (model?.efforts ?? []).map(effort => ({ id: effort, label: effortLabel(effort) }));
}

/**
 * The thinking to send for a model: the remembered/chosen one if the model takes it, else none
 * (the host applies the model's usual effort).
 */
export function resolveThinking(model: ModelRow | undefined, wanted: string | undefined) {
  return wanted && model?.efforts.includes(wanted) ? wanted : undefined;
}

/** The choices to start from: the remembered ones that the workspace still offers. */
export function initialChoices(catalog: { teams: Array<{ id: string; }>; modes: Array<{ id: string; }>; models: ModelRow[]; defaultMode?: string; }, remembered: import('./preferences.js').NewSessionChoices): Choices {
  const team = remembered.team && catalog.teams.some(entry => entry.id === remembered.team) ? remembered.team : undefined;
  const mode = remembered.mode && catalog.modes.some(entry => entry.id === remembered.mode) ? remembered.mode : catalog.defaultMode ?? catalog.modes[0]?.id;
  const modelRow = remembered.model ? catalog.models.find(entry => entry.id === remembered.model) : undefined;
  const thinkingWanted = remembered.thinkingByModel?.[modelRow?.id ?? 'default'];
  return {
    ...(team ? { team } : {}),
    ...(mode ? { mode } : {}),
    ...(modelRow ? { model: modelRow.id } : {}),
    // Without a known model the effort is checked once the preview names it.
    ...(thinkingWanted && (!modelRow || modelRow.efforts.includes(thinkingWanted)) ? { thinking: thinkingWanted } : {}),
  };
}

/**
 * The spec of session.preview / session.create for these choices in `workspace`: only fields
 * the gateway allows, empty choices left out so the host decides.
 */
export function buildSpec(workspace: string, choices: Choices, { persist = false }: { persist?: boolean; } = {}) {
  return {
    cwd: workspace,
    ...(persist ? { persist: true } : {}),
    ...(choices.team ? { workflow: choices.team } : {}),
    ...(choices.mode ? { mode: choices.mode } : {}),
    ...(choices.model ? { model: choices.model } : {}),
    ...(choices.thinking ? { thinking: choices.thinking } : {}),
  };
}

/** A session.preview answer, checked: undefined when it is not one. */
export function parsePreview(result: unknown): Preview | undefined {
  // any: alpd's or the gateway's answer (untrusted JSON); each field is checked where it is read.
  const preview = (result as any)?.preview;
  if (!preview || typeof preview !== 'object') return undefined;
  const team = text(preview.team);
  const agent = text(preview.agent);
  if (!team || !agent) return undefined;
  // any: alpd's or the gateway's answer (untrusted JSON); each field is checked where it is read.
  const teams = Array.isArray(preview.teams) ? preview.teams.filter((entry: any) => text(entry?.id))
    // any: alpd's or the gateway's answer (untrusted JSON); each field is checked where it is read.
    .map((entry: any) => ({ id: entry.id, label: text(entry.label) ?? entry.id, ...(text(entry.description) ? { description: entry.description } : {}) })) : [];
  return {
    teams, team, agent,
    ...(text(preview.teamLabel) ? { teamLabel: preview.teamLabel } : {}),
    runtime: text(preview.runtime) ?? '',
    model: text(preview.model) ?? '',
    mode: text(preview.mode) ?? '',
    thinking: text(preview.thinking) ?? '',
  };
}

/**
 * What a preview says will run, as label/value rows (Paseo shows the same choices as the
 * composer's controls; ALP adds who runs: the team and its main agent on a runtime).
 */
export function previewRows(preview: Preview, models: ModelRow[] = []): Array<{ key: string; label: string; value: string; }> {
  const model = effectiveModel(models, undefined, preview);
  const rows: Array<{ key: string; label: string; value: string; }> = [
    { key: 'team', label: 'Team', value: preview.teamLabel ?? preview.teams.find(entry => entry.id === preview.team)?.label ?? unlistedLabel(preview.team) },
    { key: 'agent', label: 'Agent', value: preview.agent },
  ];
  if (preview.runtime) rows.push({ key: 'runtime', label: 'Runtime', value: RUNTIME_LABELS[preview.runtime] ?? preview.runtime });
  if (preview.model) rows.push({ key: 'model', label: 'Model', value: model?.label ?? preview.model });
  if (preview.thinking) rows.push({ key: 'thinking', label: 'Thinking', value: effortLabel(preview.thinking) });
  if (preview.mode) rows.push({ key: 'mode', label: 'Permissions', value: MODE_LABELS[preview.mode] ?? preview.mode });
  return rows;
}

/**
 * What a preview request asked about the model that would run: the team and the model chosen
 * (empty: the host's default). A preview answered for another pair says nothing about this one's
 * model, so the thinking is not checked against it.
 */
export function previewBase(spec: { workflow?: unknown; model?: unknown; } | null | undefined) {
  return JSON.stringify([typeof spec?.workflow === 'string' ? spec.workflow : '', typeof spec?.model === 'string' ? spec.model : '']);
}

/**
 * Why the workspace's teams are not known: the host has no `team` capability, the token lacks
 * project.read, or team.list failed (message: its error; Retry asks again).
 */
export type TeamsUnavailable = { reason: 'capability' | 'permission' | 'failed'; message?: string; };

/**
 * The team a preview named that the workspace's team list lacks (`custom`, for settings without
 * workflow.mode, t-5586), as a menu entry; undefined when it is listed or there is no preview.
 */
export function unlistedTeam(teams: Array<{ id: string; }>, preview: Preview | undefined): { id: string; label: string; } | undefined {
  if (!preview || teams.some(entry => entry.id === preview.team)) return undefined;
  return { id: preview.team, label: preview.teamLabel ?? unlistedLabel(preview.team) };
}

/**
 * The Team menu: the workspace's teams, led by an unlisted one a preview named (kept after
 * another team is chosen, so it can be chosen back).
 */
export function teamMenu<T extends { id: string, label: string }>(teams: T[], unlisted: { id: string; label: string; } | undefined): Array<T | { id: string; label: string; }> {
  return unlisted && !teams.some(entry => entry.id === unlisted.id) ? [unlisted, ...teams] : teams;
}

/**
 * The team a session is started with, or why Start must wait. One is always sent (the team the
 * preview named, which alpd's session.create accepts back, `custom` included), except when the
 * host has said it has no team at all (fail closed).
 * @param input
 *   previewTeam: the team of a preview answered for the current choices. previewSettled: the
 *   preview cannot answer (blocked, failed), so waiting for it does not help. previewBlocked: it
 *   was not asked at all (previewError then says why); previewNeedsRead: because the token lacks session.read.
 * @returns
 *   stuck: waiting alone does not help; wait names the cause and what unblocks it.
 */
export function startTeam({ chosen, previewTeam, previewSettled, previewError, previewBlocked, previewNeedsRead, teams, teamsKnown, teamsUnavailable }: {
    chosen?: string; previewTeam?: string; previewSettled: boolean; previewError?: string;
    previewBlocked?: boolean; previewNeedsRead?: boolean; teams: Array<{ id: string; }>; teamsKnown?: boolean;
    teamsUnavailable?: TeamsUnavailable;
  }): { team?: string; wait?: undefined; } | { team?: undefined; wait: string; stuck?: boolean; } {
  if (chosen) return { team: chosen };
  if (previewTeam) return { team: previewTeam };
  if (!previewSettled) return { wait: 'Checking what would run…' };
  if (teams.length) return { team: teams[0].id };
  if (teamsKnown) return {};
  return { wait: stuckReason({ previewError, previewBlocked, previewNeedsRead, teamsUnavailable }), stuck: true };
}

function stuckReason({ previewError, previewBlocked, previewNeedsRead, teamsUnavailable }: { previewError?: string; previewBlocked?: boolean; previewNeedsRead?: boolean; teamsUnavailable?: TeamsUnavailable; }) {
  const teamCause = teamsUnavailable?.reason === 'capability' ? 'this host does not list teams (no team capability)'
    : teamsUnavailable?.reason === 'permission' ? 'your access token cannot list teams (it lacks project.read)'
    : teamsUnavailable?.reason === 'failed' ? `the team list failed${teamsUnavailable.message ? ` (${trimStop(teamsUnavailable.message)})` : ''}`
    : 'the team list is not available';
  const previewCause = previewBlocked ? `the preview is not available${previewError ? ` (${trimStop(previewError)})` : ''}`
    : `the preview failed${previewError ? ` (${trimStop(previewError)})` : ''}`;
  const fixes = [];
  if (teamsUnavailable?.reason === 'failed' || !previewBlocked) fixes.push('use Retry in the preview to ask again');
  const grants = [];
  if (teamsUnavailable?.reason === 'permission') grants.push('project.read');
  if (previewBlocked && previewNeedsRead) grants.push('session.read');
  if (grants.length) fixes.push(`reconnect with a token that has ${grants.join(' or ')}`);
  if (!fixes.length) fixes.push('connect to a host that lists teams or previews sessions');
  const unblock = fixes.join(', or ');
  return `Cannot tell which team would run: ${teamCause}, and ${previewCause}. To start, ${unblock}.`;
}

function trimStop(text: string) { return String(text).trim().replace(/[.。]+$/, ''); }

/**
 * The notice for a start that failed after its screen closed. The first message itself is kept by
 * the caller for the next New session screen, so the notice only says where to find it.
 * @param where the workspace's name
 */
export function failedStartNotice(message: string, prompt: string, where?: string) {
  if (!String(prompt ?? '').trim()) return message;
  return `${message} Your first message was not sent; it is back in the New session box${where ? ` of ${where}` : ''}.`;
}

/**
 * Starts a session from the New session screen. Where the start began (workspace, connection) is
 * taken before it waits on the host: a failure after the screen closed keeps the first message
 * for that workspace and names it in the notice, even if the person moved on meanwhile. The error
 * is thrown again, for the screen when it is still open (its composer keeps the text).
 *
 * @param spec what createSession sends @param text the first message
 *
 * @returns the new session's id
 */
// any: the session spec is built and checked by buildSpec; this function only passes it on.
export async function startNewSession(controller: { startOrigin(): { workspace: string | null; connection: number; }; createSession(spec: any): Promise<string>; keepUnsentDraft(text: string, origin: { workspace: string | null; connection: number; }): void; notify(level: string, text: string): void; }, spec: any, text: string, { mounted, describe, nameOf }: { mounted: () => boolean; describe: (error: unknown) => { message: string; }; nameOf: (path: string) => string; }): Promise<string> {
  const origin = controller.startOrigin();
  try {
    return await controller.createSession(spec);
  } catch (error) {
    if (!mounted()) {
      if (text.trim()) controller.keepUnsentDraft(text, origin);
      controller.notify('error', failedStartNotice(describe(error).message, text, origin.workspace ? nameOf(origin.workspace) : undefined));
    }
    throw error;
  }
}
