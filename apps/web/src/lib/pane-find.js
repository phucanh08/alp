// @ts-check
/**
 * Find in a chat pane (Paseo's pane-find), without the DOM: the page hands the pane's text as
 * segments (its text nodes, in order) and gets back where each match starts and ends. Matching is
 * literal and ignores case. A match may run across segments of one block (a bold word in a
 * sentence) but not across blocks: a segment with `breakBefore` starts a new block.
 */

/** Paseo's isFindShortcut: Cmd+F on a Mac, Ctrl+F elsewhere, no other modifier. @param {{ key: string, metaKey: boolean, ctrlKey: boolean, shiftKey: boolean, altKey: boolean }} event @param {boolean} mac */
export function isFindShortcut(event, mac) {
  return (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'f';
}

/** More matches than this are not marked: the count says "1000+". */
export const FIND_LIMIT = 1000;

/**
 * @typedef {{ text: string, breakBefore?: boolean }} FindSegment
 * @typedef {{ segment: number, offset: number }} FindPoint
 * @typedef {{ start: FindPoint, end: FindPoint }} FindMatch
 */

/**
 * The matches of `query` in `segments`, in reading order; at most FIND_LIMIT.
 * @param {FindSegment[]} segments @param {string} query
 * @returns {{ matches: FindMatch[], limited: boolean }}
 */
export function findMatches(segments, query) {
  const needle = query.toLowerCase();
  if (!needle.trim()) return { matches: [], limited: false };
  /** @type {FindMatch[]} */
  const matches = [];
  // One block at a time: its segments joined, then each hit mapped back to its segments.
  let first = 0;
  while (first < segments.length) {
    let last = first + 1;
    while (last < segments.length && !segments[last].breakBefore) last += 1;
    /** @type {number[]} */
    const starts = [];
    let joined = '';
    for (let index = first; index < last; index += 1) { starts.push(joined.length); joined += segments[index].text; }
    const hay = joined.toLowerCase();
    const point = (/** @type {number} */ at, /** @type {boolean} */ end) => {
      // The segment holding `at`; an end on a boundary stays in the segment before it.
      let index = starts.length - 1;
      while (index > 0 && (end ? starts[index] >= at : starts[index] > at)) index -= 1;
      return { segment: first + index, offset: at - starts[index] };
    };
    for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
      if (matches.length >= FIND_LIMIT) return { matches, limited: true };
      matches.push({ start: point(at, false), end: point(at + needle.length, true) });
    }
    first = last;
  }
  return { matches, limited: false };
}

/** The match after (`delta` 1) or before (-1) `current`, wrapping; 0 without matches. @param {number} current @param {number} total @param {1 | -1} delta */
export function stepMatch(current, total, delta) {
  if (total <= 0) return 0;
  return ((current + delta) % total + total) % total;
}

/** What the find bar says: "3 of 12", "No matches", or nothing before a query. @param {string} query @param {number} current @param {number} total @param {boolean} [limited] */
export function findStatus(query, current, total, limited = false) {
  if (!query.trim()) return '';
  if (!total) return 'No matches';
  return `${current + 1} of ${total}${limited ? '+' : ''}`;
}
