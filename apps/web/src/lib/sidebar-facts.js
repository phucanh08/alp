// @ts-check
/**
 * The facts Paseo's sidebar shows beside a workspace's rows (t-ff83; docs/alp/dashboard.md, the
 * sidebar): its diff counts, branch, pull request and CI, its icon, and the footer's account usage.
 * ALP keeps these per WORKSPACE (a directory), not per session or agent worktree, so the sidebar
 * shows them once, on the workspace's most recent session row. Pure helpers; the sidebar fetches
 * through controller.ownerRequest (host owner only) and renders what these answer.
 *
 * @typedef {{ number: number, state: 'open' | 'draft' | 'merged' | 'closed' }} PullRequest
 * @typedef {{ branch?: string, additions?: number, deletions?: number, pr?: PullRequest, ci?: 'passed' | 'failed' | 'pending', icon?: string, fetchedAt?: string }} WorkspaceFacts
 * @typedef {import('./owner-host.js').UsageProvider} UsageProvider
 * @typedef {import('@anhlp/alp-protocol/session').SessionSummary} SessionSummary
 */

import { DEFAULT_USAGE_PREFS, pinnedSummary } from './usage-prefs.js';

/** host.workspace.facts takes at most this many workspace ids per call. */
export const FACTS_BATCH = 50;
/** How often the sidebar reads facts, usage and schedules again while it shows (ms). */
export const FACTS_REFRESH_MS = 60_000;

/** `items` in batches of `size`. @template T @param {readonly T[]} items @param {number} [size] @returns {T[][]} */
export function batches(items, size = FACTS_BATCH) {
  const out = [];
  for (let at = 0; at < items.length; at += size) out.push(items.slice(at, at + size));
  return out;
}

/**
 * Reads host.workspace.facts for `ids`, FACTS_BATCH at a time; a batch that fails is left out (the
 * rows then show what they showed before). @param {{ ownerRequest: (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<any> }} controller
 * @param {readonly string[]} ids @param {{ refresh?: boolean }} [options]
 * @returns {Promise<Record<string, WorkspaceFacts>>}
 */
export async function readFacts(controller, ids, { refresh = false } = {}) {
  const unique = [...new Set(ids.filter(id => typeof id === 'string' && id))];
  const answers = await Promise.all(batches(unique).map(async workspaceIds => {
    try {
      const result = await controller.ownerRequest('host.workspace.facts', { workspaceIds, ...(refresh ? { refresh: true } : {}) }, { timeoutMs: 60_000 });
      return result?.workspaces && typeof result.workspaces === 'object' ? result.workspaces : {};
    } catch { return {}; }
  }));
  /** @type {Record<string, WorkspaceFacts>} */
  const facts = {};
  for (const answer of answers) for (const [id, value] of Object.entries(answer)) if (unique.includes(id)) facts[id] = cleanFacts(value);
  return facts;
}

/** @param {unknown} value */
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
const PR_STATES = ['open', 'draft', 'merged', 'closed'];
const CI_STATES = ['passed', 'failed', 'pending'];

/**
 * Keeps only well-formed fields; an icon only as a data:image URL of a raster or SVG image (the
 * sidebar shows it in an <img>, never as markup). @param {any} value @returns {WorkspaceFacts}
 */
export function cleanFacts(value) {
  /** @type {WorkspaceFacts} */
  const facts = {};
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

/** Paseo's diff count: 672, 2.6k, 36.5k, 1.2m. @param {number} value */
export function formatDiffCount(value) {
  if (value >= 1_000_000) return `${trim(value / 1_000_000)}m`;
  if (value >= 1_000) return `${trim(value / 1_000)}k`;
  return String(value);
}
/** @param {number} value */
const trim = value => (value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, ''));

/** The pull request's label: "2", "344 Merged", "12 Draft", "7 Closed". @param {PullRequest} pr */
export function prLabel(pr) {
  return pr.state === 'open' ? String(pr.number) : `${pr.number} ${pr.state[0].toUpperCase()}${pr.state.slice(1)}`;
}

/**
 * The session of a workspace's list that carries its facts: the one updated last (its creation
 * time when it has no update); ties by id, so the choice is stable. @param {readonly SessionSummary[]} sessions
 */
export function mostRecentSession(sessions) {
  /** @param {SessionSummary} session */
  const time = session => { const parsed = Date.parse(session.updatedAt ?? session.createdAt ?? ''); return Number.isFinite(parsed) ? parsed : 0; };
  let best = /** @type {SessionSummary | undefined} */ (undefined);
  for (const session of sessions) if (!best || time(session) > time(best) || (time(session) === time(best) && session.id < best.id)) best = session;
  return best;
}

/**
 * The footer's usage summary: per provider whose card is on, its pinned windows (Paseo's default:
 * the 5-hour and weekly ones) as "98% 5h  61% wk", in the Percentages choice (used or left), and
 * nothing while Summary in sidebar is off. lib/usage-prefs.js pinnedSummary, which owns the rule.
 * @param {readonly UsageProvider[]} providers @param {import('./usage-prefs.js').UsagePrefs} [prefs]
 */
export const usageLine = (providers, prefs = DEFAULT_USAGE_PREFS) => pinnedSummary(providers, prefs);

/** A prompt's first line, at most `max` characters. @param {string} prompt @param {number} [max] */
export function excerpt(prompt, max = 120) {
  const line = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * The jobs schedule.list answered for each project root, as one list: pending first by due time,
 * the rest newest first. @param {Record<string, any[]>} byRoot
 */
export function scheduleRows(byRoot) {
  const jobs = Object.values(byRoot).flat().filter(job => job && typeof job.id === 'string');
  const time = (/** @type {string} */ value) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : 0; };
  return jobs.sort((a, b) => {
    const pa = a.status === 'pending' ? 0 : 1;
    const pb = b.status === 'pending' ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return pa === 0 ? time(a.dueAt) - time(b.dueAt) || a.id.localeCompare(b.id) : time(b.dueAt) - time(a.dueAt) || a.id.localeCompare(b.id);
  });
}
