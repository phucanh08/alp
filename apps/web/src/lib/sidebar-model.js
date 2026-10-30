// @ts-check
/**
 * The Workspaces section's rows as Paseo 0.14 arranges them (components/sidebar: sidebar-model,
 * sidebar-group-visibility, projects/workspace-structure), on ALP's data: a project is a
 * workspace the token grants, its rows are that workspace's sessions.
 *
 * - Sort: Created or Last prompt, newest first (ALP has no last-prompt time; the session's last
 *   update stands in). Paseo's Manual order needs drag and drop and is not offered.
 * - Grouping by status: Needs input, Failed, Ready to review, Working, Done, in Paseo's order.
 * - A group shows seven rows plus every row that is not Done; Show more shows the rest.
 * - The Project filter keeps the projects it names; one naming no project left counts as none.
 */

/** @typedef {import('@anhlp/alp-protocol/session').SessionSummary} SessionSummary */
/** @typedef {'running' | 'needs_input' | 'failed' | 'attention' | 'done'} Bucket */

/** Paseo's status sections (sidebar.statusBucket), in its order. */
export const STATUS_GROUPS = /** @type {const} */ ([
  ['needs_input', 'Needs input'],
  ['failed', 'Failed'],
  ['attention', 'Ready to review'],
  ['running', 'Working'],
  ['done', 'Done'],
]);

/** Paseo's group limit for workspace rows (selectSidebarGroupVisibility). */
export const GROUP_LIMIT = 7;

/** @param {string | undefined} value */
const time = value => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : 0; };

/**
 * Newest first by creation, or by last activity for Last prompt; ties by id.
 * @param {SessionSummary[]} sessions @param {'created' | 'lastPrompt'} sort @returns {SessionSummary[]}
 */
export function sortSessions(sessions, sort) {
  const key = (/** @type {SessionSummary} */ session) => sort === 'lastPrompt' ? time(session.updatedAt ?? session.createdAt) : time(session.createdAt);
  return [...sessions].sort((a, b) => key(b) - key(a) || a.id.localeCompare(b.id));
}

/**
 * The rows a group shows: the first seven and every row past them that is not Done; all when
 * expanded. `canToggle` when some row is left out.
 * @template T @param {readonly T[]} rows @param {boolean} expanded @param {(row: T) => Bucket} bucketOf
 * @returns {{ visible: T[], canToggle: boolean }}
 */
export function limitRows(rows, expanded, bucketOf) {
  const baseline = rows.filter((row, index) => index < GROUP_LIMIT || bucketOf(row) !== 'done');
  return { visible: expanded ? [...rows] : baseline, canToggle: baseline.length < rows.length };
}

/**
 * The sessions in Paseo's status sections; empty sections are left out.
 * @param {SessionSummary[]} sessions @param {(session: SessionSummary) => Bucket} bucketOf
 * @returns {Array<{ bucket: Bucket, label: string, sessions: SessionSummary[] }>}
 */
export function groupByStatus(sessions, bucketOf) {
  return STATUS_GROUPS
    .map(([bucket, label]) => ({ bucket, label, sessions: sessions.filter(session => bucketOf(session) === bucket) }))
    .filter(group => group.sessions.length > 0);
}

/**
 * The project filter in effect: the stored paths that still name a project (Paseo's resolved
 * filters). @param {readonly string[]} filters @param {readonly string[]} projects
 */
export function resolveProjectFilters(filters, projects) {
  return filters.filter(path => projects.includes(path));
}

/** The projects the section lists under the filter: all when it names none. @param {readonly string[]} projects @param {readonly string[]} filters */
export function filterProjects(projects, filters) {
  const resolved = resolveProjectFilters(filters, projects);
  return resolved.length ? projects.filter(path => resolved.includes(path)) : [...projects];
}
