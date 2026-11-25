/**
 * The composer's "@" file suggestions (Paseo's agentAutocomplete for files): while the word at the
 * caret starts with "@", the workspace's files (workspace.files.search) that match the rest of it.
 * Choosing one puts `@<relative path> ` in its place; a path with a space goes in quotes.
 */

/**
 * The "@" word the caret is in, or null: an "@" at the start of the text or after whitespace, then
 * no whitespace up to the caret.
 *
 * @returns start: where the "@" is; end: the caret
 */
export function mentionAt(text: string, caret: number): { start: number; end: number; query: string; } | null {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([^\s@"]*)$/.exec(before);
  if (!match) return null;
  const start = caret - match[2].length - 1;
  return { start, end: caret, query: match[2] };
}

/** How a path goes in the text: `@path`, or `@"path"` when it has whitespace. */
export const mentionText = (path: string) => /\s/.test(path) ? `@"${path}"` : `@${path}`;

/** The text once `path` is chosen for `mention`, and where the caret goes (after the space). */
export function insertMention(text: string, mention: { start: number; end: number; }, path: string): { text: string; caret: number; } {
  // The rest of the word after the caret goes too: the path replaces the whole word.
  const after = text.slice(mention.end);
  const tail = after.replace(/^\S*/, '');
  const inserted = `${mentionText(path)} `;
  const rest = tail.startsWith(' ') ? tail.slice(1) : tail;
  return { text: text.slice(0, mention.start) + inserted + rest, caret: mention.start + inserted.length };
}
