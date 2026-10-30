import { createHash, randomBytes } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, opendir, realpath, stat, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ERROR, RPC_ERROR, WORKSPACE_FILES, blockedFilePath } from '@anhlp/alp-protocol';
import { gitIgnored, IgnoreUnknown, GIT_CHECK, type GitCheckOptions } from './gitignore.js';

// For tests: which git alpd would run, and how many run now.
export { gitChecksRunning, resolveGit, GIT_CHECK } from './gitignore.js';

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
const SKIPPED_FOLDERS = new Set(['node_modules', 'Library', '.git', 'dist', 'build', '.cache', 'target', '.venv', 'venv', '__pycache__']);

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

// ---- workspace.files.list and workspace.files.read (docs/protocol/alp-json-rpc-v1.md §12.4) ----

/**
 * A refusal of workspace.files.list or workspace.files.read: the JSON-RPC code and `data.reason`
 * alpd answers with. Messages are fixed or name only the client's own relative path, never a host
 * path or anything read from a file.
 */
export class FileAccessError extends Error {
  constructor(message: string, readonly code: number, readonly reason: string) {
    super(message);
  }
}

/** Extra bounds of one listing: entries looked at, and wall time. */
const LIST_LIMITS = Object.freeze({ scanned: 20_000, ms: 3_000 });
/** Opening never follows a final link nor waits on a FIFO; Windows has neither flag. */
const OPEN_FLAGS = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

const notFound = (relative: string) => new FileAccessError(`No readable file or directory at ${relative}`, ERROR.notFound, 'not_found');
const linked = (relative: string) => new FileAccessError(`${relative} is reached through a link, has more than one name, or changed while it was read; alpd does not follow links`, ERROR.forbidden, 'linked');
const outside = (relative: string) => new FileAccessError(`${relative} is a link that leads outside the workspace; alpd follows only links that stay inside it`, ERROR.forbidden, 'outside');

/** `real` as a '/'-separated path inside `root`, or undefined when it is the root itself, outside it or holds a backslash. */
function insideRoot(root: string, real: string): string | undefined {
  const relative = path.relative(root, real);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return undefined;
  const inside = relative.split(path.sep).join('/');
  return inside.includes('\\') ? undefined : inside;
}

/**
 * With internalLinks (workspace.files.browse): the segments of the real path `segments` lead to
 * when it goes through links, provided that real path is inside the root and not blocked; the
 * root itself is []. Only that real path is then read, checked as any other (no link on the way).
 * `via` is the path as asked up to its first link, the last of it Git can judge (Git refuses a
 * path beyond a link), so .gitignore is asked about it and about the real path.
 */
async function internalSegments(root: string, segments: string[], relative: string): Promise<{ segments: string[]; via?: string }> {
  let real;
  try {
    real = await realpath(path.join(root, ...segments));
  } catch {
    throw notFound(relative);
  }
  let via: string | undefined;
  for (let index = 1; index <= segments.length && via === undefined; index++) {
    if ((await lstat(path.join(root, ...segments.slice(0, index))).catch(() => undefined))?.isSymbolicLink()) via = segments.slice(0, index).join('/');
  }
  if (real === root) return { segments: [], via };
  const inside = insideRoot(root, real);
  if (inside === undefined) throw outside(relative);
  if (blockedFilePath(inside)) throw new FileAccessError(`${relative} leads to a path that is not readable remotely: .git, .env files, ALP configuration and key or credential files are always refused`, ERROR.forbidden, 'blocked_path');
  return { segments: inside.split('/'), via };
}

/** Where the link `file` leads, when its real path is inside `root`, not blocked, and a regular file or a directory. */
async function internalTarget(root: string, file: string): Promise<{ kind: 'file' | 'directory'; target: string } | undefined> {
  try {
    const real = await realpath(file);
    const target = insideRoot(root, real);
    if (target === undefined || blockedFilePath(target)) return undefined;
    const info = await lstat(real);
    return info.isFile() ? { kind: 'file', target } : info.isDirectory() ? { kind: 'directory', target } : undefined;
  } catch {
    return undefined;
  }
}

/** The real path of a workspace root that is a directory, else FilesError. */
async function realRoot(projectRoot: string): Promise<string> {
  if (!path.isAbsolute(projectRoot)) throw new FilesError('projectRoot must be an absolute path');
  try {
    const root = await realpath(projectRoot);
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
    return root;
  } catch {
    throw new FilesError('projectRoot is not a directory alpd can read');
  }
}

/**
 * A path relative to the workspace as a client may send it, its segments, or a refusal: '/'
 * separated, no leading slash, drive or backslash, no `.`, `..` or empty segment, no NUL, at most
 * WORKSPACE_FILES.maxPathLength characters. A blocked path (blockedFilePath) is refused as such.
 */
export function relativeSegments(relative: unknown): string[] {
  if (typeof relative !== 'string' || !relative || [...relative].length > WORKSPACE_FILES.maxPathLength || relative.includes('\0') || relative.includes('\\') || relative.startsWith('/') || /^[A-Za-z]:/.test(relative)) {
    throw new FileAccessError('path must be a relative path inside the workspace, with / between names and no . or .. segment', RPC_ERROR.invalidParams, 'invalid_path');
  }
  const segments = relative.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) {
    throw new FileAccessError('path must be a relative path inside the workspace, with / between names and no . or .. segment', RPC_ERROR.invalidParams, 'invalid_path');
  }
  if (blockedFilePath(relative)) throw new FileAccessError(`${relative} is not readable remotely: .git, .env files, ALP configuration and key or credential files are always refused`, ERROR.forbidden, 'blocked_path');
  return segments;
}

/**
 * The directories from the root to `segments` (the root first), each checked as reached by name:
 * a real directory, not a link, at its own real path. Their identities (device and inode) are
 * returned so the caller can check them again after reading.
 */
async function directoryChain(root: string, segments: string[], relative: string): Promise<{ paths: string[]; identities: string[] }> {
  const paths = [root];
  for (let index = 0; index < segments.length; index++) paths.push(path.join(root, ...segments.slice(0, index + 1)));
  const identities: string[] = [];
  for (const directory of paths) identities.push(await directoryIdentity(directory, relative));
  return { paths, identities };
}

/** The identity of a directory reached by name, or the refusal: missing or not a directory, or a link. */
async function directoryIdentity(directory: string, relative: string): Promise<string> {
  let info;
  try {
    info = await lstat(directory, { bigint: true });
  } catch {
    throw notFound(relative);
  }
  if (info.isSymbolicLink()) throw linked(relative);
  if (!info.isDirectory()) throw notFound(relative);
  let real;
  try {
    real = await realpath(directory);
  } catch {
    throw notFound(relative);
  }
  if (real !== directory) throw linked(relative);
  return `${info.dev}:${info.ino}`;
}

/** The chain checked again: the same directories, else the read is refused. */
async function sameChain(chain: { paths: string[]; identities: string[] }, relative: string): Promise<void> {
  for (const [index, directory] of chain.paths.entries()) {
    let now;
    try {
      now = await directoryIdentity(directory, relative);
    } catch {
      throw linked(relative);
    }
    if (now !== chain.identities[index]) throw linked(relative);
  }
}

/**
 * Which of `paths` .gitignore hides (gitignore.ts, Git's own answer), failing closed: when Git
 * cannot answer, every path counts as ignored. No repository or no Git: none is.
 */
async function ignoredOf(root: string, paths: string[], git?: GitCheckOptions): Promise<(path: string) => boolean> {
  try {
    const ignored = await gitIgnored(root, paths, git);
    return ignored ? entry => ignored.has(entry) : () => false;
  } catch (error) {
    if (!(error instanceof IgnoreUnknown)) throw error;
    return () => true;
  }
}

/**
 * The bytes of a regular file reached by name, or undefined when it is larger than `maxBytes`;
 * throws when it is missing, not a regular file, a link, has more than one name, or is not the
 * file it was a moment before. The file is opened without following a final link and checked by
 * its handle (same device and inode as by name, before and after).
 */
/** Test probes: called between the checks of a read, where a racing writer could change the file. */
export type FileProbe = (step: 'checked' | 'read' | 'listed') => Promise<void> | void;

async function readConfined(file: string, maxBytes: number, probe?: FileProbe): Promise<{ bytes: Buffer; modifiedAt: Date } | undefined> {
  const confined = await openConfined(file, maxBytes, probe);
  if (!confined) return undefined;
  const { handle, before, opened } = confined;
  try {
    // One byte more than allowed tells a file that grew from one that fits.
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes) return undefined;
    await probe?.('read');
    const after = await lstat(file, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino) throw Object.assign(new Error('changed'), { linked: true });
    return { bytes: buffer.subarray(0, length), modifiedAt: opened.mtime };
  } finally {
    await handle.close();
  }
}

/**
 * A regular file reached by name, opened as readConfined reads it: not a link, one name, at its
 * own real path, opened without following a final link and the same file by its handle; undefined
 * when it is larger than `maxBytes`. The caller reads, closes the handle and checks the name again.
 */
async function openConfined(file: string, maxBytes: number, probe?: FileProbe): Promise<{ handle: FileHandle; before: BigIntStats; opened: BigIntStats } | undefined> {
  const before = await lstat(file, { bigint: true });
  if (before.isSymbolicLink()) throw Object.assign(new Error('link'), { linked: true });
  if (!before.isFile()) throw new Error('not a file');
  if (before.nlink > 1n) throw Object.assign(new Error('hard link'), { linked: true });
  if ((await realpath(file)) !== file) throw Object.assign(new Error('real path differs'), { linked: true });
  if (before.size > BigInt(maxBytes)) return undefined;
  await probe?.('checked');
  let handle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw Object.assign(new Error('link'), { linked: true });
    throw error;
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink > 1n) throw Object.assign(new Error('changed'), { linked: true });
    return { handle, before, opened };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

/**
 * The bytes of the file at `segments` under the real root `root`, confined as readWorkspaceFile
 * confines a read (every directory on the way a real directory reached by name and the same after
 * the read; the file a regular file with one name, opened without following a link, the same by
 * handle and by name), or `too_large` past `maxBytes`. Throws FileAccessError `linked` or
 * `not_found` (its message names only `relative`). No block list or .gitignore check: the caller
 * decides what may be read (workspace.git.diff, docs/protocol/alp-json-rpc-v1.md §12.5).
 */
export async function readConfinedFile(root: string, segments: readonly string[], relative: string, maxBytes: number): Promise<Buffer | 'too_large'> {
  const chain = await directoryChain(root, segments.slice(0, -1), relative);
  let read: { bytes: Buffer } | undefined;
  try {
    read = await readConfined(path.join(root, ...segments), maxBytes);
  } catch (error) {
    if ((error as { linked?: boolean }).linked) throw linked(relative);
    throw notFound(relative);
  }
  await sameChain(chain, relative);
  return read === undefined ? 'too_large' : read.bytes;
}

/** Paseo's isLikelyBinary (file-explorer/service.ts at b63a325): a NUL byte, or over 30% control characters. */
export function likelyBinary(buffer: Buffer): boolean {
  if (!buffer.length) return false;
  let suspicious = 0;
  for (const byte of buffer) {
    if (byte === 0) return true;
    if ((byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 127) suspicious++;
  }
  return suspicious / buffer.length > 0.3;
}

// The BOM is kept: the content is the file's bytes, decoded.
/** PEM, OpenSSH and PuTTY private-key headers: a file holding one is refused whatever its name. */
export const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-\d+:/;

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type ListedEntry = { name: string; path: string; kind: 'file' | 'directory'; size?: number; modifiedAt?: string; target?: string };

/** The order of a listing: directories first, then by name (code units). */
const listOrder = (a: { kind: string; name: string }, b: { kind: string; name: string }) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
/** A listing's `nextCursor`: the last entry answered, which the next page starts after. */
const listCursor = (entry: { kind: 'file' | 'directory'; name: string }) => Buffer.from(JSON.stringify([entry.kind === 'directory' ? 0 : 1, entry.name])).toString('base64url');
function afterCursor(cursor: string): { kind: 'file' | 'directory'; name: string } {
  let value: unknown;
  try { value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')); } catch { value = undefined; }
  if (!Array.isArray(value) || value.length !== 2 || (value[0] !== 0 && value[0] !== 1) || typeof value[1] !== 'string' || !value[1]) {
    throw new FileAccessError('cursor is not one alpd gave for a listing', RPC_ERROR.invalidParams, 'invalid_cursor');
  }
  return { kind: value[0] === 0 ? 'directory' : 'file', name: value[1] };
}

/**
 * The entries of a directory under `projectRoot` (its root without `relative`): regular files and
 * directories only (links, sockets, devices are left out), never a blocked one (blockedFilePath)
 * and, unless `includeIgnored`, none .gitignore'd. Directories first, then by name. Each directory
 * on the way is checked (real directory, real path, same device and inode) before and after the
 * read. At most WORKSPACE_FILES.maxListEntries entries; then `truncated` and `nextCursor`, which
 * `cursor` takes to answer the entries after them.
 *
 * With `internalLinks` (workspace.files.browse): a link whose real path is inside the root and not
 * blocked is listed as what it leads to, with that path as `target`, and `relative` may go through
 * such links (the answer's `target` then names the directory listed, and entries are under it).
 * Both the link's path and its target must pass .gitignore. A link leading outside is left out,
 * and refused (`outside`) as `relative`.
 */
export async function listWorkspaceDirectory(projectRoot: string, { path: relative, includeIgnored = false, cursor, internalLinks = false, now = Date.now, probe, git }: { path?: string; includeIgnored?: boolean; cursor?: string; internalLinks?: boolean; now?: () => number; probe?: FileProbe; git?: GitCheckOptions } = {}): Promise<{ entries: ListedEntry[]; truncated?: true; nextCursor?: string; target?: string }> {
  const root = await realRoot(projectRoot);
  const requested = relative === undefined ? [] : relativeSegments(relative);
  const shown = relative ?? '.';
  const after = cursor === undefined ? undefined : afterCursor(cursor);
  const { segments, via } = internalLinks && requested.length ? await internalSegments(root, requested, shown) : { segments: requested, via: undefined };
  const real = segments.join('/');
  const target = real !== requested.join('/') ? real || '.' : undefined;
  const chain = await directoryChain(root, segments, shown);
  const directory = chain.paths.at(-1)!;
  const prefix = segments.length ? `${real}/` : '';
  const deadline = now() + LIST_LIMITS.ms;
  // Regular files and directories that are not blocked, before .gitignore is asked about them.
  const candidates: Array<{ name: string; child: string; kind: 'file' | 'directory'; target?: string }> = [];
  let scanned = 0;
  let truncated = false;
  try {
    for await (const entry of await opendir(directory)) {
      if (++scanned > LIST_LIMITS.scanned || now() > deadline) { truncated = true; break; }
      const child = `${prefix}${entry.name}`;
      if (entry.name.includes('\\') || blockedFilePath(child)) continue;
      const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : undefined;
      if (kind) candidates.push({ name: entry.name, child, kind });
      else if (internalLinks && entry.isSymbolicLink()) {
        const link = await internalTarget(root, path.join(directory, entry.name));
        if (link) candidates.push({ name: entry.name, child, ...link });
      }
    }
  } catch {
    throw notFound(shown);
  }
  // One Git process for the directory and every candidate: Git also says a path inside an
  // ignored directory is ignored, and a `!` rule can bring one back.
  if (!includeIgnored) {
    // The directory as asked (up to its first link, beyond which Git judges nothing) and as it is.
    const listed = [...new Set([...(requested.length ? [via ?? relative!] : []), ...(segments.length ? [real] : [])])];
    const ignored = await ignoredOf(root, [...listed, ...candidates.flatMap(entry => entry.target ? [entry.child, entry.target] : [entry.child])], git);
    if (listed.some(ignored)) throw new FileAccessError(`${relative} is ignored by .gitignore; ask with includeIgnored to see it`, ERROR.forbidden, 'ignored');
    for (let index = candidates.length - 1; index >= 0; index--) {
      const candidate = candidates[index]!;
      if (ignored(candidate.child) || (candidate.target !== undefined && ignored(candidate.target))) candidates.splice(index, 1);
    }
  }
  candidates.sort(listOrder);
  const start = after ? candidates.findIndex(candidate => listOrder(candidate, after) > 0) : 0;
  const entries: ListedEntry[] = [];
  let nextCursor: string | undefined;
  for (const { name, child, kind, target: leadsTo } of start < 0 ? [] : candidates.slice(start)) {
    if (entries.length >= WORKSPACE_FILES.maxListEntries) { truncated = true; nextCursor = listCursor(entries.at(-1)!); break; }
    let info;
    try {
      // A link's target is a real path inside the root: what it leads to is described.
      info = await lstat(leadsTo === undefined ? path.join(directory, name) : path.join(root, ...leadsTo.split('/')));
    } catch {
      continue;
    }
    // Replaced by something else since it was listed: left out.
    if (kind === 'file' ? !info.isFile() : !info.isDirectory()) continue;
    entries.push({ name, path: child, kind, ...(kind === 'file' ? { size: info.size } : {}), modifiedAt: info.mtime.toISOString(), ...(leadsTo === undefined ? {} : { target: leadsTo }) });
  }
  await probe?.('listed');
  await sameChain(chain, shown);
  return { entries, ...(truncated ? { truncated: true as const } : {}), ...(nextCursor ? { nextCursor } : {}), ...(target ? { target } : {}) };
}

/**
 * The content of a UTF-8 text file under `projectRoot`, read-only: refused when it is blocked
 * (blockedFilePath), .gitignore'd (unless `includeIgnored`), missing or not a regular file,
 * reached through a link (any directory on the way or the file), has more than one name (a hard
 * link may share a file from anywhere), changes while it is read, is over
 * WORKSPACE_FILES.maxReadBytes, or is not UTF-8 text.
 */
export async function readWorkspaceFile(projectRoot: string, { path: relative, includeIgnored = false, probe, git }: { path: string; includeIgnored?: boolean; probe?: FileProbe; git?: GitCheckOptions }): Promise<{ path: string; content: string; size: number; modifiedAt: string }> {
  const root = await realRoot(projectRoot);
  const segments = relativeSegments(relative);
  const chain = await directoryChain(root, segments.slice(0, -1), relative);
  if (!includeIgnored && (await ignoredOf(root, [relative], git))(relative)) throw new FileAccessError(`${relative} is ignored by .gitignore; ask with includeIgnored to read it`, ERROR.forbidden, 'ignored');
  const file = path.join(root, ...segments);
  let read: { bytes: Buffer; modifiedAt: Date } | undefined;
  try {
    read = await readConfined(file, WORKSPACE_FILES.maxReadBytes, probe);
  } catch (error) {
    if ((error as { linked?: boolean }).linked) throw linked(relative);
    throw notFound(relative);
  }
  if (read === undefined) throw new FileAccessError(`${relative} is larger than ${WORKSPACE_FILES.maxReadBytes} bytes`, ERROR.failed, 'too_large');
  await sameChain(chain, relative);
  let content: string;
  try {
    if (likelyBinary(read.bytes)) throw new Error('binary');
    content = UTF8.decode(read.bytes);
  } catch {
    throw new FileAccessError(`${relative} is not a UTF-8 text file`, ERROR.failed, 'binary');
  }
  // A private key under any name (id_work, a service account's JSON) is refused as a blocked path.
  if (PRIVATE_KEY.test(content)) throw new FileAccessError(`${relative} holds a private key; such files are never readable remotely`, ERROR.forbidden, 'blocked_path');
  return { path: relative, content, size: read.bytes.length, modifiedAt: read.modifiedAt.toISOString() };
}

// ---- workspace.files.preview (docs/protocol/alp-json-rpc-v1.md §12.11) ----

/** Images a preview answers as such, by extension (the Paseo bridge's own list). */
export const PREVIEW_IMAGES: Readonly<Record<string, string>> = Object.freeze({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' });
/** Bytes before a chunk also searched for a private-key header, so none hides across a chunk's edge. */
const KEY_OVERLAP = 256;
/** What a preview reads at once while it decides whether a file is text. */
const CLASSIFY_BLOCK = 1024 * 1024;

export type FilePreview = {
  path: string; target?: string; kind: 'text' | 'image' | 'binary'; mimeType: string; size: number; modifiedAt: string; revision: string;
  encoding: 'base64' | 'none'; content?: string; offset?: number; nextOffset?: number;
};

/** A file's version as a preview names it: its identity, size, times and kind, hashed (no host detail leaves alpd). */
const revisionOf = (info: BigIntStats, kind: string) => `r${createHash('sha256').update(`${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${kind}`).digest('base64url').slice(0, 22)}`;

/**
 * Whether the open file is text as the Paseo bridge judged it (textOf): no NUL byte, at most 30%
 * control characters in its first 16 KiB, valid UTF-8 throughout; read in blocks, never whole.
 * `key` when it is text holding a private-key header.
 */
async function classify(handle: FileHandle, size: number): Promise<'text' | 'binary' | 'key'> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const block = Buffer.alloc(Math.max(1, Math.min(CLASSIFY_BLOCK, size)));
  let tail = '';
  let key = false;
  for (let position = 0; position < size;) {
    const { bytesRead } = await handle.read(block, 0, Math.min(block.length, size - position), position);
    if (!bytesRead) throw Object.assign(new Error('shrank'), { linked: true });
    const bytes = block.subarray(0, bytesRead);
    if (bytes.includes(0)) return 'binary';
    if (position === 0) {
      const head = bytes.subarray(0, 16 * 1024);
      let control = 0;
      for (const byte of head) if (byte < 9 || (byte > 13 && byte < 32)) control++;
      if (control / head.length > 0.3) return 'binary';
    }
    try { decoder.decode(bytes, { stream: true }); } catch { return 'binary'; }
    const text = tail + bytes.toString('latin1');
    key ||= PRIVATE_KEY.test(text);
    tail = text.slice(-KEY_OVERLAP);
    position += bytesRead;
  }
  try { decoder.decode(); } catch { return 'binary'; }
  return key ? 'key' : 'text';
}

/** Bytes `from` to `end` of the open file; throws when it holds fewer (it shrank while read). */
async function readRange(handle: FileHandle, from: number, end: number): Promise<Buffer> {
  const buffer = Buffer.alloc(end - from);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await handle.read(buffer, length, buffer.length - length, from + length);
    if (!bytesRead) throw Object.assign(new Error('shrank'), { linked: true });
    length += bytesRead;
  }
  return buffer;
}

/**
 * A preview of a file under `projectRoot`, as the Paseo bridge's Files panel showed one: `image`
 * by extension (PREVIEW_IMAGES), else `text` when the whole file is (classify), else `binary`
 * (metadata only, no content). Text and image bytes come as base64 in chunks of at most
 * WORKSPACE_FILES.maxPreviewChunkBytes: the first from `offset` 0, each next one from the
 * `nextOffset` before with the `revision` the first answered (a file that changed since is
 * refused `changed`, so the chunks are of one file). At most `maxBytes` (and
 * WORKSPACE_FILES.maxPreviewBytes), else `too_large`.
 *
 * Refused as workspace.files.read refuses: a blocked path, a .gitignore'd one (unless
 * `includeIgnored`), missing or not a regular file, reached through a link, more than one name, a
 * change while it is read; a text file holding a private key (and any chunk holding one) is
 * refused `blocked_path`. With `internalLinks`, `relative` may go through links whose real path is
 * inside the root (internalSegments): that real path, answered as `target`, is what is read, and
 * both paths must pass .gitignore.
 */
export async function previewWorkspaceFile(projectRoot: string, { path: relative, includeIgnored = false, internalLinks = false, maxBytes = WORKSPACE_FILES.maxPreviewBytes, offset = 0, revision, probe, git }: { path: string; includeIgnored?: boolean; internalLinks?: boolean; maxBytes?: number; offset?: number; revision?: string; probe?: FileProbe; git?: GitCheckOptions }): Promise<FilePreview> {
  const root = await realRoot(projectRoot);
  const requested = relativeSegments(relative);
  const { segments, via } = internalLinks ? await internalSegments(root, requested, relative) : { segments: requested, via: undefined };
  if (!segments.length) throw notFound(relative);
  const real = segments.join('/');
  const target = real !== relative ? real : undefined;
  const limit = Math.max(1, Math.min(WORKSPACE_FILES.maxPreviewBytes, Math.trunc(maxBytes)));
  const chain = await directoryChain(root, segments.slice(0, -1), relative);
  if (!includeIgnored) {
    // The path as asked (up to its first link, beyond which Git judges nothing) and as it is.
    const asked = [...new Set([via ?? relative, real])];
    if (asked.some(await ignoredOf(root, asked, git))) throw new FileAccessError(`${relative} is ignored by .gitignore; ask with includeIgnored to read it`, ERROR.forbidden, 'ignored');
  }
  const file = path.join(root, ...segments);
  const extension = path.extname(file).toLowerCase();
  let preview: FilePreview;
  try {
    const confined = await openConfined(file, limit, probe);
    if (!confined) throw new FileAccessError(`${relative} is larger than ${limit} bytes`, ERROR.failed, 'too_large');
    const { handle, before, opened } = confined;
    try {
      const size = Number(opened.size);
      if (offset > 0 && revision === undefined) throw new FileAccessError('a chunk past offset 0 needs the revision its first chunk answered', RPC_ERROR.invalidParams, 'invalid_params');
      const image = PREVIEW_IMAGES[extension];
      // A later chunk is of the file and kind its revision names: text as offset 0 found it, or an image.
      const kind: FilePreview['kind'] | 'key' = image ? 'image' : offset > 0 ? 'text' : await classify(handle, size);
      if (kind === 'key') throw new FileAccessError(`${relative} holds a private key; such files are never readable remotely`, ERROR.forbidden, 'blocked_path');
      const current = revisionOf(opened, kind);
      if (revision !== undefined && revision !== current) throw new FileAccessError(`${relative} changed since its first chunk was read; read it again from offset 0`, ERROR.conflict, 'changed');
      if (offset > 0 && offset >= size) throw new FileAccessError(`offset is past the end of ${relative}`, RPC_ERROR.invalidParams, 'invalid_params');
      const mimeType = image ?? (kind === 'binary' ? 'application/octet-stream' : extension === '.json' ? 'application/json' : 'text/plain');
      // To the nearest millisecond, as fs.Stats and so workspace.files.list give it.
      const modifiedAt = new Date(Number(opened.mtimeNs / 1_000_000n) + (opened.mtimeNs % 1_000_000n >= 500_000n ? 1 : 0)).toISOString();
      const base = { path: relative, ...(target === undefined ? {} : { target }), kind, mimeType, size, modifiedAt, revision: current };
      if (kind === 'binary') preview = { ...base, encoding: 'none' };
      else {
        const end = Math.min(size, offset + WORKSPACE_FILES.maxPreviewChunkBytes);
        const from = Math.max(0, offset - KEY_OVERLAP);
        const bytes = await readRange(handle, from, end);
        if (PRIVATE_KEY.test(bytes.toString('latin1'))) throw new FileAccessError(`${relative} holds a private key; such files are never readable remotely`, ERROR.forbidden, 'blocked_path');
        preview = { ...base, encoding: 'base64', content: bytes.subarray(offset - from).toString('base64'), offset, ...(end < size ? { nextOffset: end } : {}) };
      }
      await probe?.('read');
      const after = await lstat(file, { bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino) throw Object.assign(new Error('changed'), { linked: true });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof FileAccessError) throw error;
    if ((error as { linked?: boolean }).linked) throw linked(relative);
    throw notFound(relative);
  }
  await sameChain(chain, relative);
  return preview;
}

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
