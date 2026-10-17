import { lstat, opendir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * `workspace.files.search` (docs/protocol/alp-json-rpc-v1.md §12.3): the files of a workspace whose
 * path matches a query, as Paseo's command center finds them (server/utils/directory-suggestions.ts
 * at b63a325, with its workspace settings: relative paths, hidden and heavy directories skipped).
 *
 * Read-only and confined to the workspace: the walk starts at the root's real path and never
 * follows a symbolic link (a link is neither listed nor entered). Each directory is checked before
 * and after it is read: a real directory (not a link), at the real path it was reached by, the same
 * one (device and inode) both times; otherwise what was read is dropped. Only names are read, never
 * contents. A link swapped in and back out between those checks, by a writer racing inside the
 * workspace, can still expose names of the directory it pointed to (Node has no openat/O_NOFOLLOW
 * walk); docs/protocol/alp-json-rpc-v1.md §12.3. The walk stops at {@link LIMITS}, checked per
 * entry; the answer then says `truncated`.
 */

export const LIMITS = Object.freeze({
  /** Directory levels below the root that are entered (Paseo's DEFAULT_MAX_DEPTH). */
  depth: 12,
  /** Directory entries looked at (Paseo's DEFAULT_MAX_ENTRIES_SCANNED). */
  scanned: 20_000,
  /** Wall time of one search. */
  ms: 3_000,
  /** Results by default and at most (Paseo's DEFAULT_LIMIT, MAX_LIMIT). */
  defaultLimit: 30,
  maxLimit: 100,
});

/** Hidden directories that are still searched (Paseo's WORKSPACE_SEARCH_HIDDEN_DIRECTORIES, with ALP's own). */
const HIDDEN_DIRECTORIES = new Set(['.agents', '.alp', '.claude', '.codex', '.github', '.opencode', '.paseo', '.vscode']);
/** Directories never searched (Paseo's IGNORED_DIRECTORY_NAMES). */
const IGNORED_DIRECTORIES = new Set(['node_modules', 'venv', 'env', 'virtualenv', 'dist', 'build', 'target', 'out', 'coverage', 'vendor', '__pycache__', '.git']);

const NONE = Number.MAX_SAFE_INTEGER;

type Rank = { path: string; tier: number; segment: number; offset: number; fuzzy: number; depth: number };

/** The directory at `directory` as reached by name: a real directory there, not a link, or null. */
async function identity(directory: string): Promise<string | null> {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || (await realpath(directory)) !== directory) return null;
  return `${info.dev}:${info.ino}`;
}

/** Paseo's scoreFuzzySubsequence: the query's letters in order; the first offset plus the gaps, or null. */
function fuzzy(query: string, candidate: string): number | null {
  let at = 0;
  let first = -1;
  let previous = -1;
  let gaps = 0;
  for (let index = 0; index < candidate.length && at < query.length; index++) {
    if (candidate[index] !== query[at]) continue;
    if (first < 0) first = index;
    if (previous >= 0) gaps += index - previous - 1;
    previous = index;
    at++;
  }
  return at === query.length && first >= 0 ? first + gaps : null;
}

/** Paseo's rankTextMatch (a word) and rankPathMatch (a query with a slash), simplified; null: no match. */
function rank(relative: string, query: string): Rank | null {
  const lower = relative.toLowerCase();
  const segments = lower.split('/');
  const depth = segments.length;
  if (!query) return { path: relative, tier: 3, segment: NONE, offset: NONE, fuzzy: NONE, depth };
  const offset = lower.indexOf(query);
  if (query.includes('/')) {
    if (offset >= 0) return { path: relative, tier: lower.startsWith(query) ? 1 : 3, segment: NONE, offset, fuzzy: NONE, depth };
    const spread = fuzzy(query, lower);
    return spread === null ? null : { path: relative, tier: 4, segment: NONE, offset: NONE, fuzzy: spread, depth };
  }
  const last = fuzzy(query, segments.at(-1) ?? '');
  const tiers: Array<(segment: string) => boolean> = [segment => segment === query, segment => segment.startsWith(query), segment => segment.includes(query)];
  for (const [tier, test] of tiers.entries()) {
    const segment = segments.findIndex(test);
    if (segment >= 0) return { path: relative, tier, segment, offset: offset >= 0 ? offset : NONE, fuzzy: last ?? NONE, depth };
  }
  if (last !== null) return { path: relative, tier: 4, segment: NONE, offset: NONE, fuzzy: last, depth };
  return null;
}

const compare = (a: Rank, b: Rank) =>
  a.tier - b.tier || a.segment - b.segment || a.offset - b.offset || a.fuzzy - b.fuzzy || a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

export class FilesError extends Error {}

/**
 * The files under `projectRoot` matching `query`, best first. `projectRoot` must be an absolute path
 * of a directory; anything else throws FilesError.
 */
export async function searchWorkspaceFiles(projectRoot: string, { query = '', limit = LIMITS.defaultLimit, now = Date.now }: { query?: string; limit?: number; now?: () => number } = {}): Promise<{ files: Array<{ path: string }>; truncated?: true }> {
  if (!path.isAbsolute(projectRoot)) throw new FilesError('projectRoot must be an absolute path');
  let root: string;
  try {
    root = await realpath(projectRoot);
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new FilesError('projectRoot is not a directory alpd can read');
  }
  const wanted = query.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();
  const count = Math.max(1, Math.min(LIMITS.maxLimit, Math.trunc(limit)));
  const deadline = now() + LIMITS.ms;
  const found: Rank[] = [];
  let scanned = 0;
  let truncated = false;
  // Breadth first: shallow files are found before the limits stop the walk.
  let level: string[] = [''];
  for (let depth = 0; level.length && !truncated; depth++) {
    const next: string[] = [];
    for (const relative of level) {
      if (scanned >= LIMITS.scanned || now() > deadline) { truncated = true; break; }
      // Reached by names alone from the real root, so it is inside it unless a link took its place.
      const directory = relative ? path.join(root, ...relative.split('/')) : root;
      const files: Rank[] = [];
      const directories: string[] = [];
      try {
        const before = await identity(directory);
        if (!before) continue;
        // Iterated, not read whole: the limits hold inside one large directory too.
        for await (const entry of await opendir(directory)) {
          if (++scanned > LIMITS.scanned || now() > deadline) { truncated = true; break; }
          const name = entry.name;
          const child = relative ? `${relative}/${name}` : name;
          if (entry.isFile()) {
            if (name.startsWith('.')) continue;
            const ranked = rank(child, wanted);
            if (ranked) files.push(ranked);
          } else if (entry.isDirectory()) {
            if (IGNORED_DIRECTORIES.has(name) || (name.startsWith('.') && !HIDDEN_DIRECTORIES.has(name))) continue;
            if (depth < LIMITS.depth) directories.push(child);
          }
          // Links, sockets, devices: neither listed nor entered.
        }
        if ((await identity(directory)) !== before) continue;
      } catch {
        continue;
      }
      found.push(...files);
      next.push(...directories);
      if (truncated) break;
    }
    level = next;
  }
  found.sort(compare);
  return { files: found.slice(0, count).map(entry => ({ path: entry.path })), ...(truncated ? { truncated: true as const } : {}) };
}
