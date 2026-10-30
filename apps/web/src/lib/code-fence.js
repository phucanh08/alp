// @ts-check
/**
 * The file name a Markdown code fence's info string stands for, so the highlighter
 * (lib/highlight) picks its parser by extension. Pure, no React, so it is tested in Node.
 */

/** Paseo's fence names that are not already file extensions (highlighted-code-block.tsx). @type {Record<string, string>} */
const LANGUAGE_ALIASES = {
  typescript: 'ts', javascript: 'js', python: 'py', rust: 'rs', golang: 'go', 'c++': 'cpp', csharp: 'cs', 'c#': 'cs',
  objc: 'm', 'objective-c': 'm', markdown: 'md', elixir: 'ex',
};

/** A file name for a fence's info string ("ts", "typescript {1,3}"), so the extension picks the parser. @param {string | null | undefined} info @returns {string | null} */
export function fenceFilename(info) {
  const first = info?.trim().split(/\s+/)[0]?.toLowerCase().replace(/^\./, '');
  if (!first) return null;
  // Own entries only: a fence named `constructor` or `__proto__` is a name, never Object's.
  return `code.${Object.hasOwn(LANGUAGE_ALIASES, first) ? LANGUAGE_ALIASES[first] : first}`;
}
