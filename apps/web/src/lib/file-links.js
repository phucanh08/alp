// @ts-check
import { blockedFilePath } from '@anhlp/alp-protocol';
import { relativeFilePath } from './file-tree.js';

/**
 * File links in an agent's reply, a subset of Paseo's assistant-file-links/parse.ts (b63a325):
 * inline code and Markdown link targets that name a file of the open workspace open it in a file
 * tab. Accepted: workspace-relative paths (`src/a.ts`, `./a.ts`), with a line (`a.ts:12`,
 * `a.ts:12:3`, `a.ts:12-20`, `a.ts#L12`, `#L12-L20`), and absolute paths under the workspace root
 * (made relative). Refused: URLs, `~/`, `..`, paths outside the root, blocked paths (secrets, .git,
 * .alp), and inline code that is a bare name without a slash (Paseo looks those up with a search;
 * ALP does not yet). Pure, no React.
 */

/** @typedef {{ path: string, line?: number, lineEnd?: number }} FileTarget */

const COLON_LINE = /^(.+?):(\d+)(?::\d+)?(?:-(\d+)(?::\d+)?)?$/;
const FRAGMENT_LINE = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/i;
// A URL scheme (no dot: `a.ts:12` is a file and a line).
const SCHEME = /^[a-z][a-z0-9+-]*:/i;
const EXTENSION = /\.[a-z0-9_+-]{1,12}$/i;

/** @param {string} value */
function decode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** @param {string | undefined} start @param {string | undefined} end */
function lines(start, end) {
  const line = start ? Number(start) : undefined;
  const lineEnd = end ? Number(end) : undefined;
  if (line !== undefined && (!Number.isSafeInteger(line) || line <= 0)) return null;
  if (lineEnd !== undefined && (!Number.isSafeInteger(lineEnd) || line === undefined || lineEnd < line)) return null;
  return { ...(line ? { line } : {}), ...(lineEnd && lineEnd !== line ? { lineEnd } : {}) };
}

/** A root without its trailing slashes. @param {string} root */
const trimRoot = root => root.replace(/\/+$/, '');

/**
 * The file a token names in the workspace, or undefined.
 * @param {string} raw the inline code's text or the link's target
 * @param {{ roots: string[], kind: 'code' | 'href' }} options roots: the workspace's absolute
 *   paths (as granted, and its real path) that an absolute path may start with
 * @returns {FileTarget | undefined}
 */
export function parseFileLink(raw, { roots, kind }) {
  let text = String(raw ?? '').trim().replace(/^['"`]+|['"`]+$/g, '');
  if (!text || text.length > 4096 || /\s/.test(text)) return undefined;
  if (kind === 'href') {
    if (/^file:\/\//i.test(text)) text = text.replace(/^file:\/\/(localhost)?/i, '');
    else if (SCHEME.test(text) && !/^[a-zA-Z]:[\\/]/.test(text)) return undefined;
    text = decode(text);
  } else if (text.includes('://')) return undefined;
  if (text.startsWith('~') || text.startsWith('#')) return undefined;
  let range = {};
  const hash = text.indexOf('#');
  if (hash >= 0) {
    const fragment = FRAGMENT_LINE.exec(text.slice(hash + 1));
    const parsed = fragment ? lines(fragment[1], fragment[2]) : null;
    if (!parsed) return undefined;
    range = parsed;
    text = text.slice(0, hash);
  } else {
    const colon = COLON_LINE.exec(text);
    if (colon) {
      const parsed = lines(colon[2], colon[3]);
      if (!parsed) return undefined;
      range = parsed;
      text = colon[1];
    }
  }
  let path = text;
  if (path.startsWith('/')) {
    const root = roots.map(trimRoot).filter(Boolean).find(entry => path.startsWith(`${entry}/`));
    if (!root) return undefined;
    path = path.slice(root.length + 1);
  }
  const relative = relativeFilePath(path);
  if (!relative || blockedFilePath(relative)) return undefined;
  if (kind === 'code') {
    // A bare name is ambiguous (Paseo searches for it): only a path with a slash, or './name'.
    if (!relative.includes('/') && !text.startsWith('./')) return undefined;
    if (!EXTENSION.test(relative.split('/').pop() ?? '') && !('line' in range)) return undefined;
  }
  return { path: relative, ...range };
}
