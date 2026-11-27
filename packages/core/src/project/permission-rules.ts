import path from 'node:path';
import { AlpError } from '../_shared/errors.ts';

const RULE = /^([A-Za-z][\w-]*)(?:\((.*)\))?$/s;
/** Tools a rule may name; a misspelt one would silently match nothing. MCP tools are mcp__<server>__<tool>. */
export const TOOLS: string[] = ['Bash', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'WebFetch', 'WebSearch', 'Skill'];

export const own = <T>(value: Record<string, T>, key: string): T | undefined => Object.hasOwn(value, key) ? value[key] : undefined;
export const setOwn = (value: object, key: string, entry: unknown) => Object.defineProperty(value, key, { value: entry, enumerable: true, writable: true, configurable: true });
// any: settings are unvalidated JSON; a value that passes is an object whose fields are then checked one by one
export const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === 'object' && !Array.isArray(value);
export const fail: (source: string, message: string) => never = (source, message) => { throw new AlpError('INVALID_SETTINGS', `${source}: ${message}`); };

/** Parses one rule; returns { tool, specifier? } or throws. */
export function parseRule(rule: unknown, source = 'rule'): { tool: string; specifier?: string } {
  if (typeof rule !== 'string' || rule.length > 500) fail(source, 'a rule is text of at most 500 characters');
  const match = RULE.exec(rule.trim());
  if (!match) fail(source, `${JSON.stringify(rule)} is not Tool or Tool(specifier)`);
  const [, tool, specifier] = match;
  if (!TOOLS.includes(tool) && !/^mcp__[\w-]+(__[\w-]+)?$/.test(tool)) fail(source, `${JSON.stringify(rule)} names unknown tool ${tool}; use ${TOOLS.join(', ')} or mcp__<server>__<tool>`);
  if (specifier !== undefined && !specifier.trim()) fail(source, `${JSON.stringify(rule)} has an empty specifier`);
  if (specifier !== undefined && specifier.trim().startsWith('@')) {
    const checked = checkedRule(specifier.trim());
    if (tool !== 'Bash' || !checked) fail(source, `${JSON.stringify(rule)}: a checked rule is Bash(@git-clone-public <root>), Bash(@git-read <root>) or Bash(@git-unsafe), with <root> an absolute, normalised path or ~/<dir>`);
  }
  return { tool, ...(specifier !== undefined && specifier.trim() !== '*' ? { specifier: specifier.trim() } : {}) };
}

const CHECKED_KINDS = ['git-clone-public', 'git-read', 'git-unsafe'];

/** Parses a checked specifier: { kind, root? } or null. */
export function checkedRule(specifier: string): { kind: string, root?: string } | null {
  const match = /^@([a-z-]+)(?:\s+(\S+))?$/.exec(specifier);
  if (!match || !CHECKED_KINDS.includes(match[1])) return null;
  const [, kind, root] = match;
  if (kind === 'git-unsafe') return root === undefined ? { kind } : null;
  // <root> is an absolute path in normal form, or `~/<dir>`: <dir> in the home of the user ALP runs as.
  if (root === undefined || !cleanAbsolute(root.startsWith('~/') ? root.slice(1) : root) || ['/', '~/'].includes(root)) return null;
  return { kind, root };
}

/** An absolute POSIX path in normal form: no `.`/`..` segment, no `//`, no trailing `/`, no `~`. */
export function cleanAbsolute(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('/') && path.posix.normalize(value) === value && (value === '/' || !value.endsWith('/'));
}
