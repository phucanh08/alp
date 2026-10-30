import * as React from 'react';
import type { SyntaxTheme } from './preferences.js';
import { SYNTAX_THEME_OPTIONS as PALETTE_OPTIONS, resolveSyntaxColors, type HighlightStyle, type HighlightToken } from './highlight/palettes';

/**
 * Code highlighting as Paseo does it, with Paseo's highlighter carried in lib/highlight: Lezer
 * parsers chosen by file extension and its eight highlight themes. The parsers load on first
 * use, apart from the main bundle; until then, and for a language they do not know or a source
 * over the budget, code shows plain. Colors are CSS variables (`--syntax-<role>`) set by
 * `applySyntaxTheme`, so a theme change repaints without highlighting again.
 */

type Highlighter = typeof import('./highlight/highlighter');

/** Paseo's highlight themes (SYNTAX_THEME_OPTIONS), in its menu order. */
export const SYNTAX_THEME_OPTIONS: Array<{ value: SyntaxTheme; label: string }> = PALETTE_OPTIONS.map(option => ({ value: option.id, label: option.label }));

let loaded: Highlighter | null = null;
let loading: Promise<Highlighter> | null = null;
const waiting = new Set<() => void>();

/** Loads the parsers once; every component waiting on them re-renders when they are in. */
function load(): Promise<Highlighter> {
  loading ??= import('./highlight/highlighter').then(module => {
    loaded = module;
    for (const listener of waiting) listener();
    return module;
  });
  return loading;
}

/** The highlighter, or null until it has loaded (asking starts the load). */
function useHighlighter(): Highlighter | null {
  const [, rerender] = React.useReducer((count: number) => count + 1, 0);
  React.useEffect(() => {
    if (loaded) return;
    waiting.add(rerender);
    void load();
    return () => { waiting.delete(rerender); };
  }, []);
  return loaded;
}

/** Paseo's fence names that are not already file extensions (highlighted-code-block.tsx). */
const LANGUAGE_ALIASES: Record<string, string> = {
  typescript: 'ts', javascript: 'js', python: 'py', rust: 'rs', golang: 'go', 'c++': 'cpp', csharp: 'cs', 'c#': 'cs',
  objc: 'm', 'objective-c': 'm', markdown: 'md', elixir: 'ex',
};

/** A file name for a fence's info string ("ts", "typescript {1,3}"), so the extension picks the parser. */
export function fenceFilename(info: string | null | undefined): string | null {
  const first = info?.trim().split(/\s+/)[0]?.toLowerCase().replace(/^\./, '');
  if (!first) return null;
  return `code.${LANGUAGE_ALIASES[first] ?? first}`;
}

/** Paseo's highlighting budget (HIGHLIGHT_MAX_SOURCE_BYTES): larger sources stay plain. */
const MAX_SOURCE_CHARS = 768 * 1024;

/**
 * The lines of `code` as highlighted tokens for `filename`, or null while the highlighter loads,
 * for a language it does not know, or for a source over the budget.
 */
export function useHighlightedLines(code: string, filename: string | null | undefined): HighlightToken[][] | null {
  const highlighter = useHighlighter();
  return React.useMemo(() => {
    if (!highlighter || !filename || code.length > MAX_SOURCE_CHARS || !highlighter.isLanguageSupported(filename)) return null;
    try { return highlighter.highlightCode(code, filename); } catch { return null; }
  }, [highlighter, code, filename]);
}

/** One line's tokens, each colored by its role's variable. */
export function Tokens({ tokens }: { tokens: HighlightToken[] }) {
  return React.createElement(React.Fragment, null, tokens.map((token, index) => token.style
    ? React.createElement('span', { key: index, style: { color: `var(--syntax-${token.style})` } }, token.text)
    : token.text));
}

const ROLES: HighlightStyle[] = ['keyword', 'comment', 'string', 'number', 'literal', 'function', 'definition', 'class', 'type', 'tag', 'attribute', 'property', 'variable', 'operator', 'punctuation', 'regexp', 'escape', 'meta', 'heading', 'link'];

/** Sets `--syntax-<role>` on `<html>` from Paseo's palette for the highlight theme in the app's color scheme. */
export function applySyntaxTheme(theme: SyntaxTheme, scheme: 'light' | 'dark'): void {
  const colors = resolveSyntaxColors(theme, scheme);
  const style = document.documentElement.style;
  for (const role of ROLES) style.setProperty(`--syntax-${role}`, colors[role]);
}
