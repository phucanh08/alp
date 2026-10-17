// @ts-check
/**
 * The command center's results (Paseo's command-center/results.ts and its text match): actions
 * contributed by the app and the workspace, then the workspace's sessions, matched against the
 * query and grouped into sections.
 *
 * Matching, as Paseo's: the query splits on whitespace and every word must match some field.
 * A word's tier, best first: exact 0, whole word 1, prefix 2, word start 3, substring 4, the
 * letters in order 6. A match on hidden keywords only ranks after any match on what the row
 * shows. Ties keep the given order.
 *
 * With an empty query: the actions shown always, then the first five workspaces (by name) and
 * the first five sessions (waiting for an answer first, then a turn ended unseen, then running,
 * then the most recently updated).
 *
 * Sections, as Paseo's bands and ranks: the contributed actions, then Workspaces, Sessions (Paseo's
 * Agents) and Files. Files are the host's answer to workspace.files.search, already ranked there;
 * they show for a non-empty query, and alone in the Files scope (Mod+P).
 */

/**
 * @typedef {{ id: string, label: string, group: 'workspace' | 'actions' | 'alp', always?: boolean, keywords?: string[], shortcut?: string, disabled?: boolean }} CommandAction
 * @typedef {{ id: string, title: string, subtitle?: string, bucket: 'running' | 'needs_input' | 'failed' | 'attention' | 'done', attention?: boolean, updatedAt?: string }} CommandSession
 *   attention: its last turn finished or failed unseen (Paseo's requiresAttention).
 * @typedef {{ path: string, title: string, subtitle: string, current?: boolean }} CommandWorkspace
 *   A workspace the token grants: its folder's name, its full path.
 * @typedef {{ path: string, title: string, subtitle: string }} CommandFile
 *   A file of the workspace (relative POSIX path): its name, its directory.
 * @typedef {{ kind: 'action', item: CommandAction } | { kind: 'session', item: CommandSession } | { kind: 'workspace', item: CommandWorkspace } | { kind: 'file', item: CommandFile }} CommandRow
 * @typedef {{ id: string, title: string, rows: CommandRow[] }} CommandSection
 */

export const SESSIONS_SHOWN_EMPTY = 5;
/** Paseo's DEFAULT_CATEGORY_RESULT_LIMIT, for workspaces with an empty query. */
export const WORKSPACES_SHOWN_EMPTY = 5;
const HIDDEN = 10;

const words = (/** @type {string} */ text) => text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Whether `needle`'s letters appear in `hay` in order. @param {string} needle @param {string} hay */
function subsequence(needle, hay) {
  let at = 0;
  for (const char of hay) if (char === needle[at]) at += 1;
  return at === needle.length;
}

/** The tier of one query word against one text, or undefined. @param {string} token @param {string} text */
export function matchTier(token, text) {
  const hay = text.toLowerCase();
  if (!hay) return undefined;
  if (hay === token) return 0;
  const parts = words(hay);
  if (parts.includes(token)) return 1;
  if (hay.startsWith(token)) return 2;
  if (parts.some(part => part.startsWith(token))) return 3;
  if (hay.includes(token)) return 4;
  if (subsequence(token, hay)) return 6;
  return undefined;
}

/**
 * The score of `query` against the visible and hidden fields, or undefined when a word matches
 * nothing. Lower is better.
 * @param {string} query @param {string[]} visible @param {string[]} [hidden]
 */
export function matchScore(query, visible, hidden = []) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let score = 0;
  for (const token of tokens) {
    let best;
    for (const field of visible) {
      const tier = matchTier(token, field);
      if (tier !== undefined && (best === undefined || tier < best)) best = tier;
    }
    if (best === undefined) {
      for (const field of hidden) {
        const tier = matchTier(token, field);
        if (tier !== undefined && (best === undefined || tier + HIDDEN < best)) best = tier + HIDDEN;
      }
    }
    if (best === undefined) return undefined;
    score += best;
  }
  return score;
}

/** Paseo's sortAgents: needs input, then requires attention, then running, then the rest. @param {CommandSession} session */
const sessionRank = session => session.bucket === 'needs_input' ? 0 : session.attention ? 1 : session.bucket === 'running' ? 2 : 3;

/** Sessions in Paseo's agent order: waiting, ended unseen, running, then the most recent. @param {CommandSession[]} sessions */
export function sortSessions(sessions) {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => (sessionRank(a.session) - sessionRank(b.session))
      || (Date.parse(b.session.updatedAt ?? '') || 0) - (Date.parse(a.session.updatedAt ?? '') || 0)
      || a.index - b.index)
    .map(entry => entry.session);
}

/** Paseo's describeWorkspaceFilePath: the name, and the directory it sits in. @param {string} path @returns {CommandFile} */
export function describeFilePath(path) {
  const normalized = String(path).replace(/\\/g, '/');
  const separator = normalized.lastIndexOf('/');
  return { path: normalized, title: separator >= 0 ? normalized.slice(separator + 1) : normalized, subtitle: separator >= 0 ? normalized.slice(0, separator) : '' };
}

/** The granted workspaces as rows: the folder's name, the full path; `current` marks the open one. @param {string[]} paths @param {string | null} [current] @returns {CommandWorkspace[]} */
export function workspaceRows(paths, current = null) {
  return paths.map(path => {
    const trimmed = path.replace(/[\\/]+$/, '');
    const title = trimmed.split(/[\\/]/).pop() || path;
    return { path, title, subtitle: path, ...(path === current ? { current: true } : {}) };
  });
}

/** Paseo's compareWorkspacesByTitle: by name (numbers in order, case aside), then by path. @param {CommandWorkspace} a @param {CommandWorkspace} b */
const byTitle = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }) || a.subtitle.localeCompare(b.subtitle);

/**
 * Paseo's filterAndRankWorkspaces: with an empty query the first five by name; otherwise every
 * workspace whose name or path matches, best match first, ties by name.
 * @param {CommandWorkspace[]} workspaces @param {string} query @returns {CommandWorkspace[]}
 */
export function rankWorkspaces(workspaces, query) {
  const sorted = [...workspaces].sort(byTitle);
  const needle = query.trim();
  if (!needle) return sorted.slice(0, WORKSPACES_SHOWN_EMPTY);
  return sorted.map((workspace, index) => ({ workspace, index, score: matchScore(needle, [workspace.title, workspace.subtitle]) }))
    .filter(entry => entry.score !== undefined)
    .sort((a, b) => /** @type {number} */ (a.score) - /** @type {number} */ (b.score) || a.index - b.index)
    .map(entry => entry.workspace);
}

/**
 * The sections to show for `query`. `files` is the host's answer for this query (or undefined
 * when the host cannot search files); `scope` 'files' shows only them.
 * @param {{ actions: CommandAction[], sessions: CommandSession[], query: string, workspaces?: CommandWorkspace[], files?: CommandFile[], scope?: 'files' | null }} input
 * @returns {CommandSection[]}
 */
export function commandResults({ actions, sessions, query, workspaces = [], files, scope = null }) {
  const needle = query.trim();
  const fileSection = /** @type {CommandSection} */ ({ id: 'files', title: 'Files', rows: (files ?? []).map(item => ({ kind: 'file', item })) });
  if (scope === 'files') return files?.length ? [fileSection] : [];
  /** @type {{ id: string, title: string, rank: number, rows: { row: CommandRow, score: number }[] }[]} */
  const groups = [
    { id: 'workspace', title: 'Workspace actions', rank: -1, rows: [] },
    { id: 'actions', title: 'Actions', rank: 0, rows: [] },
    // Paseo lists a plugin's commands in a section of the plugin's own: ALP's (its alp-provider
    // plugin's Open ALP tasks…) come after the app's.
    { id: 'alp', title: 'ALP', rank: 1, rows: [] },
  ];
  for (const action of actions) {
    const group = groups.find(entry => entry.id === action.group);
    if (!group) continue;
    if (!needle) { if (action.always) group.rows.push({ row: { kind: 'action', item: action }, score: 0 }); continue; }
    const score = matchScore(needle, [action.label], action.keywords);
    if (score !== undefined) group.rows.push({ row: { kind: 'action', item: action }, score });
  }
  const best = (/** @type {{ score: number }[]} */ rows) => rows.reduce((low, entry) => Math.min(low, entry.score), Infinity);
  const contributed = groups
    .filter(group => group.rows.length)
    .map(group => ({ ...group, rows: [...group.rows].sort((a, b) => a.score - b.score) }))
    .sort((a, b) => needle ? best(a.rows) - best(b.rows) || a.rank - b.rank : a.rank - b.rank);
  /** @type {CommandSection[]} */
  const sections = contributed.map(group => ({ id: group.id, title: group.title, rows: group.rows.map(entry => entry.row) }));
  const ordered = sortSessions(sessions);
  const matched = needle
    ? ordered.map((session, index) => ({ session, index, score: matchScore(needle, [session.title], [session.id, session.subtitle ?? '']) }))
      .filter(entry => entry.score !== undefined)
      .sort((a, b) => /** @type {number} */ (a.score) - /** @type {number} */ (b.score) || a.index - b.index)
      .map(entry => entry.session)
    : ordered.slice(0, SESSIONS_SHOWN_EMPTY);
  const places = rankWorkspaces(workspaces, needle);
  if (places.length) sections.push({ id: 'workspaces', title: 'Workspaces', rows: places.map(item => ({ kind: 'workspace', item })) });
  if (matched.length) sections.push({ id: 'sessions', title: 'Sessions', rows: matched.map(item => ({ kind: 'session', item })) });
  if (needle && files?.length) sections.push(fileSection);
  return sections;
}
