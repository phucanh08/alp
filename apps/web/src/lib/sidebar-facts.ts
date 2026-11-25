/**
 * The facts Paseo's sidebar shows beside a workspace's rows (t-ff83; docs/alp/dashboard.md, the
 * sidebar): its diff counts, branch, pull request and CI, its icon, and the footer's account usage.
 * ALP keeps these per WORKSPACE (a directory), not per session or agent worktree, so the sidebar
 * shows them once, on the workspace's most recent session row. Pure helpers; the sidebar fetches
 * through controller.ownerRequest (host owner only) and renders what these answer.
 */
export type PullRequest = { number: number; state: 'open' | 'draft' | 'merged' | 'closed'; };

export type WorkspaceFacts = { branch?: string; additions?: number; deletions?: number; pr?: PullRequest; ci?: 'passed' | 'failed' | 'pending'; icon?: string; fetchedAt?: string; };

export type UsageProvider = import('./owner-host.js').UsageProvider;

export type SessionSummary = import('@anhlp/alp-protocol/session').SessionSummary;

import { DEFAULT_USAGE_PREFS, pinnedSummary } from './usage-prefs.js';

/** host.workspace.facts takes at most this many workspace ids per call. */
export const FACTS_BATCH = 50;
/** How often the sidebar reads facts, usage and schedules again while it shows (ms). */
export const FACTS_REFRESH_MS = 60_000;

/** `items` in batches of `size`. */
export function batches<T>(items: readonly T[], size: number = FACTS_BATCH): T[][] {
  const out = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/**
 * Reads host.workspace.facts for `ids`, FACTS_BATCH at a time; a batch that fails is left out (the
 * rows then show what they showed before).
 */
// any: each owner method answers its own shape; the caller reads only the fields it needs.
export async function readFacts(controller: { ownerRequest: (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number; }) => Promise<any>; }, ids: readonly string[], { refresh = false }: { refresh?: boolean; } = {}): Promise<Record<string, WorkspaceFacts>> {
  const unique = [...new Set(ids.filter(id => typeof id === 'string' && id))];
  const answers = await Promise.all(batches(unique).map(async workspaceIds => {
    try {
      const result = await controller.ownerRequest('host.workspace.facts', { workspaceIds, ...(refresh ? { refresh: true } : {}) }, { timeoutMs: 60_000 });
      return result?.workspaces && typeof result.workspaces === 'object' ? result.workspaces : {};
    } catch { return {}; }
  }));
  const facts: Record<string, WorkspaceFacts> = {};
  for (const answer of answers) for (const [id, value] of Object.entries(answer)) if (unique.includes(id)) facts[id] = cleanFacts(value);
  return facts;
}

const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
const PR_STATES = ['open', 'draft', 'merged', 'closed'];
const CI_STATES = ['passed', 'failed', 'pending'];

/**
 * Keeps only well-formed fields; an icon only as a data:image URL of a raster or SVG image (the
 * sidebar shows it in an <img>, never as markup).
 */
// any: alpd's or the gateway's answer (untrusted JSON); each field is checked where it is read.
export function cleanFacts(value: any): WorkspaceFacts {
  const facts: WorkspaceFacts = {};
  if (!value || typeof value !== 'object') return facts;
  if (typeof value.branch === 'string' && value.branch) facts.branch = value.branch;
  const additions = count(value.additions);
  const deletions = count(value.deletions);
  if (additions !== undefined) facts.additions = additions;
  if (deletions !== undefined) facts.deletions = deletions;
  if (value.pr && Number.isInteger(value.pr.number) && value.pr.number > 0 && PR_STATES.includes(value.pr.state)) facts.pr = { number: value.pr.number, state: value.pr.state };
  if (CI_STATES.includes(value.ci)) facts.ci = value.ci;
  if (typeof value.icon === 'string' && /^data:image\/(png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(value.icon)) facts.icon = value.icon;
  if (typeof value.fetchedAt === 'string') facts.fetchedAt = value.fetchedAt;
  return facts;
}

/** Paseo's diff count: 672, 2.6k, 36.5k, 1.2m. */
export function formatDiffCount(value: number) {
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trim(value / 1_000)}k`;
  return String(value);
}
const trim = (value: number) => (value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, ''));

/** The pull request's label: "2", "344 Merged", "12 Draft", "7 Closed". */
export function prLabel(pr: PullRequest) {
  return pr.state === 'open' ? String(pr.number) : `${pr.number} ${pr.state[0].toUpperCase()}${pr.state.slice(1)}`;
}

/**
 * The session of a workspace's list that carries its facts: the one updated last (its creation
 * time when it has no update); ties by id, so the choice is stable.
 */
export function mostRecentSession(sessions: readonly SessionSummary[]) {
  const time = (session: SessionSummary) => { const parsed = Date.parse(session.updatedAt ?? session.createdAt ?? ''); return Number.isFinite(parsed) ? parsed : 0; };
  let best = undefined as SessionSummary | undefined;
  for (const session of sessions) if (!best || time(session) > time(best) || (time(session) === time(best) && session.id < best.id)) best = session;
  return best;
}

/**
 * The footer's usage summary: per provider whose card is on, its pinned windows (Paseo's default:
 * the 5-hour and weekly ones) as "98% 5h  61% wk", in the Percentages choice (used or left), and
 * nothing while Summary in sidebar is off. lib/usage-prefs.ts pinnedSummary, which owns the rule.
 */
export const usageLine = (providers: readonly UsageProvider[], prefs: import('./usage-prefs.js').UsagePrefs = DEFAULT_USAGE_PREFS) => pinnedSummary(providers, prefs);

/** A prompt's first line, at most `max` characters. */
export function excerpt(prompt: string, max: number = 120) {
  const line = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The jobs schedule.list answered for each project root, as one list: pending first by due time,
 * the rest newest first.
 */
// any: host rows (untrusted JSON); each field is checked where it is read.
export function scheduleRows(byRoot: Record<string, any[]>) {
  const jobs = Object.values(byRoot).flat().filter(job => job && typeof job.id === 'string');
  const time = (value: string) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : 0; };
  return jobs.sort((a, b) => {
    const pa = a.status === 'pending' ? 0 : 1;
    const pb = b.status === 'pending' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return pa === 0 ? time(a.dueAt) - time(b.dueAt) || a.id.localeCompare(b.id) : time(b.dueAt) - time(a.dueAt) || a.id.localeCompare(b.id);
  });
}
