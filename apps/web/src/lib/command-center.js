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
 * With an empty query: the actions shown always, then the first five sessions (waiting for an
 * answer first, then running, then the most recently updated).
 */

/**
 * @typedef {{ id: string, label: string, group: 'workspace' | 'actions' | 'alp', always?: boolean, keywords?: string[], shortcut?: string, disabled?: boolean }} CommandAction
 * @typedef {{ id: string, title: string, subtitle?: string, bucket: 'running' | 'needs_input' | 'failed' | 'done', updatedAt?: string }} CommandSession
 * @typedef {{ kind: 'action', item: CommandAction } | { kind: 'session', item: CommandSession }} CommandRow
 * @typedef {{ id: string, title: string, rows: CommandRow[] }} CommandSection
 */

export const SESSIONS_SHOWN_EMPTY = 5;
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

const BUCKET_RANK = { needs_input: 0, running: 1, failed: 2, done: 2 };

/** Sessions in Paseo's agent order: waiting, running, then the most recent. @param {CommandSession[]} sessions */
export function sortSessions(sessions) {
  return sessions
    .map((session, index) => ({ session, index }))
    .sort((a, b) => (BUCKET_RANK[a.session.bucket] - BUCKET_RANK[b.session.bucket])
      || (Date.parse(b.session.updatedAt ?? '') || 0) - (Date.parse(a.session.updatedAt ?? '') || 0)
      || a.index - b.index)
    .map(entry => entry.session);
}

/**
 * The sections to show for `query`.
 * @param {{ actions: CommandAction[], sessions: CommandSession[], query: string }} input
 * @returns {CommandSection[]}
 */
export function commandResults({ actions, sessions, query }) {
  const needle = query.trim();
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
  if (matched.length) sections.push({ id: 'sessions', title: 'Sessions', rows: matched.map(item => ({ kind: 'session', item })) });
  return sections;
}
