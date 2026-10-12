import path from 'node:path';
import { realpathSync } from 'node:fs';

/**
 * The project board (plans/reference/ALPD.md §18): one group channel per project that every
 * agent working on it shares, across trees. Agents pin claims (paths they are changing),
 * decisions (the approach everyone follows) and findings (what others need to know), so
 * agents working independently neither edit each other's files nor pursue different ideas.
 * These helpers stay pure; storage and delivery live in the runtime.
 */

export const PIN_KINDS = ['claim', 'decision', 'finding'] as const;
export type PinKind = typeof PIN_KINDS[number];

export type Pin = {
  id: string;
  /** The project root the board belongs to. */
  project: string;
  kind: PinKind;
  body: string;
  /** Project-relative files or directories, or absolute paths in an external write root; required for claims. */
  paths?: string[];
  agent: string;
  sessionId: string;
  rootId: string;
  at: string;
  /** When a claim ended, or any pin was taken down. */
  released?: string;
  /** The task the claiming assignment works on. */
  task?: string;
};

export const PIN_BODY_CHARS = 2000;
export const PIN_PATHS = 50;
/** Decisions and findings kept per project; live claims are always kept. */
export const BOARD_KEEP = 200;
const DIGEST_CHARS = 3000;

/** Resolve symlinked parents even for a file an assignment has not created yet. */
function canonicalPath(file: string): string {
  try { return realpathSync(file); } catch {
    const parent = path.dirname(file);
    return parent === file ? file : path.join(canonicalPath(parent), path.basename(file));
  }
}
const containsPath = (outer: string, inner: string) => {
  const relative = path.relative(outer, inner);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};

/** Normalized project-relative paths, or absolute paths in a declared external write root. */
export function normalizePaths(paths: unknown, project: string, roots: string[] = [project]): string[] | string {
  if (!Array.isArray(paths) || !paths.length || paths.length > PIN_PATHS) return `paths must list 1 to ${PIN_PATHS} files or directories`;
  const normalized: string[] = [];
  for (const entry of paths) {
    if (typeof entry !== 'string' || !entry.trim()) return 'paths must be nonempty strings';
    const absolute = canonicalPath(path.resolve(project, entry.trim()));
    if (!roots.some(root => containsPath(canonicalPath(root), absolute))) return `${entry} is outside the project or declared write root`;
    const relative = path.relative(canonicalPath(project), absolute).split(path.sep).join('/');
    normalized.push(relative === '' ? '.' : relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) ? absolute.split(path.sep).join('/') : relative);
  }
  return [...new Set(normalized)];
}

/** Two paths overlap when one is the other or contains it; '.' is the whole project. */
const contains = (outer: string, inner: string) => path.isAbsolute(outer) === path.isAbsolute(inner) && (outer === '.' || inner === outer || inner.startsWith(outer.endsWith('/') ? outer : `${outer}/`));

export function overlapping(a: string[], b: string[]) {
  return a.filter(left => b.some(right => contains(left, right) || contains(right, left)));
}

export const live = (pin: Pin) => !pin.released;

export function renderPin(pin: Pin) {
  const where = pin.paths?.length ? ` [${pin.paths.join(', ')}]` : '';
  return `${pin.kind} ${pin.id} by ${pin.agent}${pin.task ? ` for task ${pin.task}` : ''}${where}: ${pin.body}`;
}

/** What an agent should know before it starts: live claims, then recent decisions and findings. */
export function renderBoard(pins: Pin[], limit = DIGEST_CHARS) {
  const claims = pins.filter(pin => pin.kind === 'claim' && live(pin));
  const notes = pins.filter(pin => pin.kind !== 'claim' && live(pin)).reverse();
  if (!claims.length && !notes.length) return '';
  const lines = ['Project board (shared by every agent on this project; read more with alp_board):'];
  let size = lines[0].length;
  for (const pin of [...claims, ...notes]) {
    const line = `- ${renderPin(pin)}`;
    if (size + line.length > limit) {
      lines.push('- … more on alp_board');
      break;
    }
    lines.push(line);
    size += line.length;
  }
  return lines.join('\n');
}
