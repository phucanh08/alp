import { randomBytes } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { RPC_ERROR, WORKSPACE_FILES, blockedFilePath } from '@anhlp/alp-protocol';
import { gitIgnored, IgnoreUnknown, GIT_CHECK, type GitCheckOptions } from './gitignore.ts';
import { FileAccessError, internalTarget, realRoot } from './files-confined.ts';

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

type Kind = 'file' | 'directory';
/** An entry a walk found: '/'-separated from the root, at the breadth-first level of its directory; a link is never entered. */
type Walked = { path: string; name: string; kind: Kind; depth: number; link?: true };
type WalkOptions = {
  depth: number; scanned: number; ms: number; now: () => number; git?: GitCheckOptions;
  /** Before Git is asked: whether the entry is kept (a directory: also entered while `depth` allows). Blocked paths never are. */
  keep: (child: string, name: string, kind: Kind, depth: number) => boolean;
  /** After Git answered; `repository` is false when no .gitignore rules apply (no Git, or no repository). */
  admit?: (entry: Walked, repository: boolean) => boolean;
  /** Links whose real path is inside the root (internalTarget) are kept as their target's kind, never entered. */
  links?: boolean;
};

/**
 * The entries under the real root `root`, as workspace.files.search walks (above): breadth first,
 * no link entered, each directory checked before and after it is read, one bounded Git request per
 * level before its directories are entered. `truncated` when a bound stopped it. Throws
 * IgnoreUnknown when Git cannot say what is ignored.
 */
async function walk(root: string, options: WalkOptions): Promise<{ entries: Walked[]; truncated: boolean }> {
  const { now, git } = options;
  const deadline = now() + options.ms;
  const realDeadline = Date.now() + options.ms;
  const found: Walked[] = [];
  let scanned = 0;
  let truncated = false;
  // Known after the first level Git was asked about; no rules at the root means none below it.
  let repository: boolean | undefined;
  let level: string[] = [''];
  for (let depth = 0; level.length && !truncated; depth++) {
    const levelEntries: Walked[] = [];
    for (const relative of level) {
      if (scanned >= options.scanned || now() > deadline) { truncated = true; break; }
      // Reached by names alone from the real root, so it is inside it unless a link took its place.
      const directory = relative ? path.join(root, ...relative.split('/')) : root;
      const entries: Walked[] = [];
      try {
        const before = await identity(directory);
        if (!before) continue;
        // Iterated, not read whole: the limits hold inside one large directory too.
        for await (const entry of await opendir(directory)) {
          if (++scanned > options.scanned || now() > deadline) { truncated = true; break; }
          const name = entry.name;
          const child = relative ? `${relative}/${name}` : name;
          if (name.includes('\\') || blockedFilePath(child)) continue;
          // Sockets, devices and (unless asked) links: neither listed nor entered.
          const kind: Kind | undefined = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : options.links && entry.isSymbolicLink() ? (await internalTarget(root, path.join(directory, name)))?.kind : undefined;
          if (!kind || !options.keep(child, name, kind, depth)) continue;
          entries.push({ path: child, name, kind, depth, ...(entry.isSymbolicLink() ? { link: true as const } : {}) });
        }
        if ((await identity(directory)) !== before) continue;
      } catch {
        continue;
      }
      levelEntries.push(...entries);
      if (truncated) break;
    }
    // One bounded Git request per breadth-first level, before entering its directories or
    // ranking its files. Git evaluates nested rules and ignored ancestors itself.
    const remaining = Math.min(deadline - now(), realDeadline - Date.now());
    if (remaining <= 0) { truncated = true; break; }
    let ignored: Set<string> | null = null;
    if (repository !== false) {
      const asked = levelEntries.map(entry => entry.path);
      ignored = await gitIgnored(root, asked, { ...git, timeoutMs: Math.min(git?.timeoutMs ?? GIT_CHECK.timeoutMs, remaining) });
      if (asked.length) repository = ignored !== null;
    }
    const admitted = levelEntries.filter(entry => !ignored?.has(entry.path) && (options.admit?.(entry, repository === true) ?? true));
    found.push(...admitted);
    level = admitted.filter(entry => entry.kind === 'directory' && !entry.link && depth < options.depth).map(entry => entry.path);
  }
  return { entries: found, truncated };
}

/**
 * The files under `projectRoot` matching `query`, best first. `projectRoot` must be an absolute path
 * of a directory; anything else throws FilesError.
 */
export async function searchWorkspaceFiles(projectRoot: string, { query = '', limit = LIMITS.defaultLimit, now = Date.now, git }: { query?: string; limit?: number; now?: () => number; git?: GitCheckOptions } = {}): Promise<{ files: Array<{ path: string }>; truncated?: true }> {
  const root = await realRoot(projectRoot);
  const wanted = query.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').toLowerCase();
  const count = Math.max(1, Math.min(LIMITS.maxLimit, Math.trunc(limit)));
  let walked;
  try {
    walked = await walk(root, {
      depth: LIMITS.depth, scanned: LIMITS.scanned, ms: LIMITS.ms, now, git,
      keep: (child, name, kind, depth) => kind === 'file'
        ? !name.startsWith('.') && rank(child, wanted) !== null
        : !IGNORED_DIRECTORIES.has(name) && (!name.startsWith('.') || HIDDEN_DIRECTORIES.has(name)) && depth < LIMITS.depth,
    });
  } catch (error) {
    if (!(error instanceof IgnoreUnknown)) throw error;
    // No partial result may reveal paths whose ignore status could not be established.
    return { files: [], truncated: true };
  }
  const found = walked.entries.filter(entry => entry.kind === 'file').map(entry => rank(entry.path, wanted)!);
  found.sort(compare);
  return { files: found.slice(0, count).map(entry => ({ path: entry.path })), ...(walked.truncated ? { truncated: true as const } : {}) };
}

// ---- workspace.files.find (docs/protocol/alp-json-rpc-v1.md §12.11) ----

/**
 * Bounds of one workspace.files.find walk, deeper and larger than search's: as complete as
 * `git ls-files` is for the Paseo bridge, which ranks the whole set itself. A snapshot of the
 * names it found is kept `ttlMs` after its last page, at most `snapshots` of them in alpd.
 */
export const FIND_LIMITS = Object.freeze({ depth: 64, scanned: 100_000, ms: 10_000, ttlMs: 60_000, snapshots: 16 });
/** Outside a repository, what the Paseo bridge's own walks skipped: big, generated, or (on macOS) behind a consent prompt. */
export const SKIPPED_FOLDERS = new Set(['node_modules', 'Library', '.git', 'dist', 'build', '.cache', 'target', '.venv', 'venv', '__pycache__']);

export type FoundEntry = { path: string; kind: Kind };
export type FindOptions = { query?: string; kinds?: readonly Kind[]; matchMode?: 'subsequence' | 'suffix'; now?: () => number; git?: GitCheckOptions };

/** Whether `candidate` holds the characters of `query` in order (the Paseo bridge's last ranking tier). */
export function inOrder(query: string, candidate: string): boolean {
  let at = 0;
  for (const char of candidate) if (char === query[at]) at += 1;
  return at >= query.length;
}

/**
 * Every file and directory under `projectRoot` whose path, case-insensitively, holds `query`'s
 * characters in order (`subsequence`, every name the Paseo bridge's ranking can match) or is it or
 * ends with `/query` (`suffix`); every name for an empty query. In path order (code units).
 *
 * As `git ls-files --cached --others --exclude-standard` lists a repository: dot names included,
 * .gitignore'd ones left out (Git's answer, failing closed as search does), and links whose real
 * path is inside the root listed as their target's kind, never entered. Outside a repository,
 * names starting with `.` and SKIPPED_FOLDERS are skipped. Blocked paths never appear. Bounded by
 * FIND_LIMITS; `truncated` when a bound stopped the walk.
 */
export async function findWorkspaceEntries(projectRoot: string, { query = '', kinds = ['file'], matchMode = 'subsequence', now = Date.now, git }: FindOptions = {}): Promise<{ entries: FoundEntry[]; truncated?: true }> {
  const root = await realRoot(projectRoot);
  const wanted = query.trim().replace(/^\.\//, '').toLowerCase();
  const matches = (candidate: string) => !wanted || (matchMode === 'suffix' ? candidate === wanted || candidate.endsWith(`/${wanted}`) : inOrder(wanted, candidate));
  let walked;
  try {
    walked = await walk(root, {
      depth: FIND_LIMITS.depth, scanned: FIND_LIMITS.scanned, ms: FIND_LIMITS.ms, now, git, links: true,
      keep: () => true,
      admit: (entry, repository) => repository || !(entry.name.startsWith('.') || SKIPPED_FOLDERS.has(entry.name)),
    });
  } catch (error) {
    if (!(error instanceof IgnoreUnknown)) throw error;
    return { entries: [], truncated: true };
  }
  const entries = walked.entries
    .filter(entry => kinds.includes(entry.kind) && matches(entry.path.toLowerCase()))
    .map(entry => ({ path: entry.path, kind: entry.kind }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, ...(walked.truncated ? { truncated: true as const } : {}) };
}

const invalidCursor = () => new FileAccessError('cursor is not one alpd gave for these params, or it expired; ask again without it', RPC_ERROR.invalidParams, 'invalid_cursor');

/**
 * workspace.files.find in pages: the first call (no cursor) walks and keeps the snapshot; each
 * `nextCursor` names the snapshot and where the next page starts, for the connection (`owner`) that
 * asked and the same params only. A snapshot is dropped after its last page, FIND_LIMITS.ttlMs
 * after its last use, or when more than FIND_LIMITS.snapshots are kept (the oldest first).
 */
export function createFindPages({ now = Date.now, git }: { now?: () => number; git?: GitCheckOptions } = {}) {
  const snapshots = new Map<string, { owner: unknown; key: string; entries: FoundEntry[]; truncated: boolean; at: number }>();
  return async function page(owner: unknown, projectRoot: string, { query = '', kinds = ['file'], matchMode = 'subsequence', limit = WORKSPACE_FILES.maxFindEntries, cursor }: Omit<FindOptions, 'now' | 'git'> & { limit?: number; cursor?: string } = {}): Promise<{ entries: FoundEntry[]; nextCursor?: string; truncated?: true }> {
    const count = Math.max(1, Math.min(WORKSPACE_FILES.maxFindEntries, Math.trunc(limit)));
    const key = JSON.stringify([projectRoot, query, [...new Set(kinds)].sort(), matchMode]);
    for (const [id, snapshot] of snapshots) if (now() - snapshot.at > FIND_LIMITS.ttlMs) snapshots.delete(id);
    let id: string;
    let offset: number;
    let snapshot;
    if (cursor !== undefined) {
      const named = /^([A-Za-z0-9_-]{22})\.(\d{1,7})$/.exec(cursor);
      snapshot = named ? snapshots.get(named[1]!) : undefined;
      if (!named || !snapshot || snapshot.owner !== owner || snapshot.key !== key || Number(named[2]) > snapshot.entries.length) throw invalidCursor();
      [id, offset] = [named[1]!, Number(named[2])];
    } else {
      const found = await findWorkspaceEntries(projectRoot, { query, kinds, matchMode, now, git });
      snapshot = { owner, key, entries: found.entries, truncated: found.truncated === true, at: now() };
      [id, offset] = [randomBytes(16).toString('base64url'), 0];
    }
    const entries = snapshot.entries.slice(offset, offset + count);
    const end = offset + entries.length;
    if (end < snapshot.entries.length) {
      snapshot.at = now();
      snapshots.set(id, snapshot);
      for (const old of snapshots.keys()) { if (snapshots.size <= FIND_LIMITS.snapshots) break; snapshots.delete(old); }
    } else snapshots.delete(id);
    return { entries, ...(end < snapshot.entries.length ? { nextCursor: `${id}.${end}` } : {}), ...(snapshot.truncated ? { truncated: true as const } : {}) };
  };
}
