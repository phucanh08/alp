import { opendir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SKIPPED_FOLDERS, inOrder } from './files-search.ts';

// ---- host.directories.search (docs/protocol/alp-json-rpc-v1.md §12.11) ----

/** Bounds of host.directories.search: home's directories `depth` levels down, `scanned` looked at; a typed path's parent read up to `listed` entries. */
export const HOST_DIRECTORIES = Object.freeze({ depth: 4, scanned: 5_000, listed: 20_000, defaultLimit: 30, maxLimit: 100 });

/** How well a name matches a query, as the Paseo bridge ranks names: 0 equal, 1 starts with it, 2 holds it, 3 its letters in order, undefined none; case-insensitive. */
export function nameRank(candidate: string, query: string): number | undefined {
  const name = candidate.toLowerCase();
  const wanted = query.toLowerCase();
  if (name === wanted) return 0;
  if (name.startsWith(wanted)) return 1;
  if (name.includes(wanted)) return 2;
  return inOrder(wanted, name) ? 3 : undefined;
}

/** The directories in `directory` (not links), up to `max` entries looked at; none when it cannot be read. */
async function subdirectories(directory: string, max: number): Promise<{ names: string[]; truncated: boolean }> {
  const names: string[] = [];
  let looked = 0;
  try {
    for await (const entry of await opendir(directory)) {
      if (++looked > max) return { names, truncated: true };
      if (entry.isDirectory()) names.push(entry.name);
    }
  } catch {
    // Unreadable or gone: nothing to suggest there.
  }
  return { names, truncated: false };
}

/**
 * The daemon host's directories for the folder a user adds as a project, as the Paseo bridge
 * suggested them: a `query` that is a path (absolute, or `~` and `~/…` under `home`) answers the
 * directories of its parent whose name starts with what follows the last separator (dot names only
 * when that starts with `.`), by name; any other word answers the directories under `home`, up to
 * HOST_DIRECTORIES.depth levels and .scanned of them (no dot names, none of SKIPPED_FOLDERS), whose
 * name matches it (nameRank), best, then nearest, first. Names only; a link is neither listed nor
 * entered. Absolute paths: the caller is the host's owner (never remote).
 */
export async function searchHostDirectories(query: unknown, { limit = HOST_DIRECTORIES.defaultLimit, home = os.homedir() }: { limit?: number; home?: string } = {}): Promise<{ entries: Array<{ path: string }>; truncated?: true }> {
  const typed = typeof query === 'string' ? query.trim() : '';
  const count = Math.max(1, Math.min(HOST_DIRECTORIES.maxLimit, Math.trunc(limit)));
  const done = (paths: string[], truncated: boolean) => ({ entries: paths.slice(0, count).map(entry => ({ path: entry })), ...(truncated ? { truncated: true as const } : {}) });
  if (!typed) return done([], false);
  if (path.isAbsolute(typed) || typed.startsWith('~')) {
    const expanded = typed === '~' ? home : typed.startsWith('~/') ? path.join(home, typed.slice(2)) : typed;
    if (!path.isAbsolute(expanded)) return done([], false);
    const folder = expanded.endsWith('/') || expanded.endsWith(path.sep);
    const parent = folder ? expanded : path.dirname(expanded);
    const prefix = folder ? '' : path.basename(expanded).toLowerCase();
    const { names, truncated } = await subdirectories(parent, HOST_DIRECTORIES.listed);
    const matching = names.filter(name => name.toLowerCase().startsWith(prefix) && (!name.startsWith('.') || prefix.startsWith('.'))).sort((a, b) => a.localeCompare(b));
    return done(matching.map(name => path.join(parent, name)), truncated);
  }
  const found: Array<{ path: string; score: number; depth: number }> = [];
  let queue = [home];
  let scanned = 0;
  for (let depth = 1; depth <= HOST_DIRECTORIES.depth && queue.length && scanned < HOST_DIRECTORIES.scanned; depth += 1) {
    const next: string[] = [];
    for (const directory of queue) {
      for (const name of (await subdirectories(directory, HOST_DIRECTORIES.listed)).names) {
        if (name.startsWith('.') || SKIPPED_FOLDERS.has(name)) continue;
        const full = path.join(directory, name);
        scanned += 1;
        const score = nameRank(name, typed);
        if (score !== undefined) found.push({ path: full, score, depth });
        next.push(full);
        if (scanned >= HOST_DIRECTORIES.scanned) break;
      }
      if (scanned >= HOST_DIRECTORIES.scanned) break;
    }
    queue = next;
  }
  found.sort((a, b) => a.score - b.score || a.depth - b.depth || a.path.localeCompare(b.path));
  return done(found.map(entry => entry.path), scanned >= HOST_DIRECTORIES.scanned);
}
