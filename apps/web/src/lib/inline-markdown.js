// @ts-check
/**
 * The inline spans of RichText's Markdown (apps/web/src/app/RichText.tsx): code, bold, strike,
 * links, bare URLs and italics, one regular expression with a group each. Pure, no React.
 *
 * Every span is bounded (at most 1000 characters, a link target 2048 on either side of its
 * parentheses), and no part of the expression can match the same text in two ways, so a long line
 * full of unclosed markers costs a bounded, linear scan per position, never one to the end of the
 * line (a 1 MiB Markdown file in a file tab's preview).
 */

// A link target: no space, and at most one level of balanced parentheses, once (Wikipedia's
// `https://en.wikipedia.org/wiki/Foo_(bar)`); never empty.
const TARGET = String.raw`(?!\))[^()\s]{0,2048}(?:\([^()\s]{0,2048}\)[^()\s]{0,2048})?`;
const LINK_TEXT = String.raw`[^[\]\n]{1,1000}`;

export const INLINE = new RegExp([
  '(`[^`\\n]{1,1000}`)',
  String.raw`(\*\*[^*\n]{1,1000}?\*\*|__[^_\n]{1,1000}?__)`,
  String.raw`(~~[^~\n]{1,1000}?~~)`,
  String.raw`(\[${LINK_TEXT}\]\(${TARGET}\))`,
  String.raw`((?:https?:\/\/|mailto:)[^\s<>()]{0,2048}[^\s<>().,;:!?'"` + '`' + String.raw`*])`,
  String.raw`(\*[^*\s][^*\n]{0,1000}?\*|(?<![\w])_[^_\s][^_\n]{0,1000}?_(?![\w]))`,
].join('|'));

const LINK = new RegExp(String.raw`^\[(${LINK_TEXT})\]\((${TARGET})\)$`);

/**
 * A link span INLINE matched, split into its text and target; undefined for anything else.
 * @param {string} link
 * @returns {{ text: string, href: string } | undefined}
 */
export function splitLink(link) {
  const parts = LINK.exec(link);
  return parts ? { text: parts[1], href: parts[2] } : undefined;
}
