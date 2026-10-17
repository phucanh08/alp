// Paseo's History list (packages/app/src/components/agent-list.tsx): sessions grouped by the day
// of their last activity, newest first, filtered by a search on the title (every word, title or id).

/** @typedef {'today' | 'yesterday' | 'thisWeek' | 'thisMonth' | 'older'} DateSection */

/** @type {Array<{ id: DateSection, label: string }>} */
export const DATE_SECTIONS = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'thisWeek', label: 'This week' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'older', label: 'Older' },
];

const DAY = 24 * 60 * 60 * 1000;

/** Paseo's deriveDateSectionKey, by calendar day in local time. @param {string | undefined} iso @param {Date} [now] @returns {DateSection} */
export function dateSection(iso, now = new Date()) {
  const time = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(time)) return 'older';
  const at = new Date(time);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime();
  if (day >= today) return 'today';
  if (day >= new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()) return 'yesterday';
  // Rounded: a day across a daylight-saving change is 23 or 25 hours long.
  const days = Math.round((today - day) / DAY);
  if (days <= 7) return 'thisWeek';
  if (days <= 30) return 'thisMonth';
  return 'older';
}

/**
 * The sections with their sessions, in order, after the query.
 * @template {{ id: string, title?: string, updatedAt?: string, createdAt?: string }} T
 * @param {T[]} sessions @param {string} [query] @param {Date} [now]
 */
export function groupHistory(sessions, query = '', now = new Date()) {
  // Every word in the title or the id, as a host that searches matches (docs/protocol/alp-json-rpc-v1.md §12.1).
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = words.length ? sessions.filter(session => words.every(word => `${session.title ?? ''}\n${session.id}`.toLowerCase().includes(word))) : sessions;
  /** @type {Map<DateSection, T[]>} */
  const buckets = new Map();
  for (const session of shown) {
    const section = dateSection(session.updatedAt ?? session.createdAt, now);
    buckets.set(section, [...(buckets.get(section) ?? []), session]);
  }
  return DATE_SECTIONS.filter(section => buckets.has(section.id)).map(section => ({ ...section, sessions: /** @type {T[]} */ (buckets.get(section.id)) }));
}
