export const MARKDOWN_COPY_TAG_ATTRIBUTE = "data-alp-markdown-tag";
export const MARKDOWN_COPY_IGNORE_ATTRIBUTE = "data-alp-markdown-ignore";
export const MARKDOWN_COPY_LIST_MARKER_ATTRIBUTE = "data-alp-markdown-list-marker";
export const MARKDOWN_COPY_UNWRAP_ATTRIBUTE = "data-alp-markdown-unwrap";
export const MARKDOWN_COPY_LIST_START_ATTRIBUTE = "data-alp-markdown-list-start";
export const MARKDOWN_COPY_LANGUAGE_ATTRIBUTE = "data-alp-markdown-language";
export const MARKDOWN_COPY_ALIGN_ATTRIBUTE = "data-alp-markdown-align";

/**
 * Trailing line breaks, with any indentation that followed the last one.
 *
 * Both ways of copying code strip these, for the same reason: pasting a trailing
 * newline into a terminal runs the last line. A fence body always ends in one, and
 * ends in several when the author left blank lines before the closing fence; a
 * selection picks one up whenever it overshoots the end of a rendered line.
 */
export const TRAILING_CODE_LINE_BREAKS = /(\r?\n[ \t]*)+$/;

export const markdownCopyDataSet = {
  blockquote: { alpMarkdownTag: "blockquote" },
  br: { alpMarkdownTag: "br" },
  code: { alpMarkdownTag: "code" },
  h1: { alpMarkdownTag: "h1" },
  h2: { alpMarkdownTag: "h2" },
  h3: { alpMarkdownTag: "h3" },
  h4: { alpMarkdownTag: "h4" },
  h5: { alpMarkdownTag: "h5" },
  h6: { alpMarkdownTag: "h6" },
  hr: { alpMarkdownTag: "hr" },
  ignore: { alpMarkdownIgnore: "true" },
  li: { alpMarkdownTag: "li" },
  listMarker: { alpMarkdownIgnore: "true", alpMarkdownListMarker: "true" },
  ol: { alpMarkdownTag: "ol" },
  p: { alpMarkdownTag: "p" },
  pre: { alpMarkdownTag: "pre" },
  s: { alpMarkdownTag: "s" },
  strong: { alpMarkdownTag: "strong" },
  em: { alpMarkdownTag: "em" },
  table: { alpMarkdownTag: "table" },
  tbody: { alpMarkdownTag: "tbody" },
  td: { alpMarkdownTag: "td" },
  th: { alpMarkdownTag: "th" },
  thead: { alpMarkdownTag: "thead" },
  tr: { alpMarkdownTag: "tr" },
  ul: { alpMarkdownTag: "ul" },
  unwrap: { alpMarkdownUnwrap: "true" },
} as const;

export type MarkdownCopyInlineTag = "br" | "code" | "em" | "s" | "strong";

export function markdownCopyOrderedListDataSet(start: unknown) {
  return {
    ...markdownCopyDataSet.ol,
    alpMarkdownListStart: String(start ?? 1),
  } as const;
}

export function markdownCopyCodeBlockDataSet(language: string | null | undefined) {
  const fenceLanguage = language?.trim().split(/\s+/)[0];
  return {
    ...markdownCopyDataSet.pre,
    ...(fenceLanguage ? { alpMarkdownLanguage: fenceLanguage } : {}),
  } as const;
}

export function markdownCopyTableCellDataSet(tag: "td" | "th", style: unknown) {
  const alignment =
    typeof style === "string"
      ? style.match(/(?:^|;)\s*text-align\s*:\s*(left|right|center)/i)?.[1]
      : null;
  return {
    ...markdownCopyDataSet[tag],
    ...(alignment ? { alpMarkdownAlign: alignment.toLowerCase() } : {}),
  } as const;
}
