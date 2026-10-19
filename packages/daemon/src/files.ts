import { constants } from 'node:fs';
import { lstat, open, opendir, realpath, stat } from 'node:fs/promises';
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

/**
 * The files under `projectRoot` matching `query`, best first. `projectRoot` must be an absolute path
 * of a directory; anything else throws FilesError.
 */
export async function searchWorkspaceFiles(projectRoot: string, { query = '', limit = LIMITS.defaultLimit, now = Date.now, git }: { query?: string; limit?: number; now?: () => number; git?: GitCheckOptions } = {}): Promise<{ files: Array<{ path: string }>; truncated?: true }> {
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
  const realDeadline = Date.now() + LIMITS.ms;
  const found: Rank[] = [];
  let scanned = 0;
  let truncated = false;
  // Breadth first: shallow files are found before the limits stop the walk.
  let level: string[] = [''];
  for (let depth = 0; level.length && !truncated; depth++) {
    const next: string[] = [];
    const levelFiles: Rank[] = [];
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
          if (name.includes('\\') || blockedFilePath(child)) continue;
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
      levelFiles.push(...files);
      next.push(...directories);
      if (truncated) break;
    }
    // One bounded Git request per breadth-first level, before entering its directories or
    // ranking its files. Git evaluates nested rules and ignored ancestors itself.
    const remaining = Math.min(deadline - now(), realDeadline - Date.now());
    if (remaining <= 0) { truncated = true; break; }
    let ignored: Set<string> | null;
    try {
      ignored = await gitIgnored(root, [...levelFiles.map(file => file.path), ...next], {
        ...git, timeoutMs: Math.min(git?.timeoutMs ?? GIT_CHECK.timeoutMs, remaining),
      });
    } catch (error) {
      if (!(error instanceof IgnoreUnknown)) throw error;
      // No partial result may reveal paths whose ignore status could not be established.
      return { files: [], truncated: true };
    }
    found.push(...levelFiles.filter(file => !ignored?.has(file.path)));
    level = next.filter(directory => !ignored?.has(directory));
  }
  found.sort(compare);
  return { files: found.slice(0, count).map(entry => ({ path: entry.path })), ...(truncated ? { truncated: true as const } : {}) };
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

/** Paseo's isLikelyBinary (file-explorer/service.ts at b63a325): a NUL byte, or over 30% control characters. */
function likelyBinary(buffer: Buffer): boolean {
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
const PRIVATE_KEY = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|PuTTY-User-Key-File-\d+:/;

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export type ListedEntry = { name: string; path: string; kind: 'file' | 'directory'; size?: number; modifiedAt?: string };

/**
 * The entries of a directory under `projectRoot` (its root without `relative`): regular files and
 * directories only (links, sockets, devices are left out), never a blocked one (blockedFilePath)
 * and, unless `includeIgnored`, none .gitignore'd. Directories first, then by name. Each directory
 * on the way is checked (real directory, real path, same device and inode) before and after the
 * read. At most WORKSPACE_FILES.maxListEntries entries; then `truncated`.
 */
export async function listWorkspaceDirectory(projectRoot: string, { path: relative, includeIgnored = false, now = Date.now, probe, git }: { path?: string; includeIgnored?: boolean; now?: () => number; probe?: FileProbe; git?: GitCheckOptions } = {}): Promise<{ entries: ListedEntry[]; truncated?: true }> {
  const root = await realRoot(projectRoot);
  const segments = relative === undefined ? [] : relativeSegments(relative);
  const shown = relative ?? '.';
  const chain = await directoryChain(root, segments, shown);
  const directory = chain.paths.at(-1)!;
  const prefix = segments.length ? `${relative}/` : '';
  const deadline = now() + LIST_LIMITS.ms;
  // Regular files and directories that are not blocked, before .gitignore is asked about them.
  const candidates: Array<{ name: string; child: string; kind: 'file' | 'directory' }> = [];
  let scanned = 0;
  let truncated = false;
  try {
    for await (const entry of await opendir(directory)) {
      if (++scanned > LIST_LIMITS.scanned || now() > deadline) { truncated = true; break; }
      const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'directory' : undefined;
      if (!kind) continue;
      const child = `${prefix}${entry.name}`;
      if (entry.name.includes('\\') || blockedFilePath(child)) continue;
      candidates.push({ name: entry.name, child, kind });
    }
  } catch {
    throw notFound(shown);
  }
  // One Git process for the directory and every candidate: Git also says a path inside an
  // ignored directory is ignored, and a `!` rule can bring one back.
  if (!includeIgnored) {
    const ignored = await ignoredOf(root, [...(segments.length ? [relative!] : []), ...candidates.map(entry => entry.child)], git);
    if (segments.length && ignored(relative!)) throw new FileAccessError(`${relative} is ignored by .gitignore; ask with includeIgnored to see it`, ERROR.forbidden, 'ignored');
    for (let index = candidates.length - 1; index >= 0; index--) if (ignored(candidates[index]!.child)) candidates.splice(index, 1);
  }
  const entries: ListedEntry[] = [];
  for (const { name, child, kind } of candidates) {
    if (entries.length >= WORKSPACE_FILES.maxListEntries) { truncated = true; break; }
    let info;
    try {
      info = await lstat(path.join(directory, name));
    } catch {
      continue;
    }
    // Replaced by something else since it was listed: left out.
    if (kind === 'file' ? !info.isFile() : !info.isDirectory()) continue;
    entries.push({ name, path: child, kind, ...(kind === 'file' ? { size: info.size } : {}), modifiedAt: info.mtime.toISOString() });
  }
  await probe?.('listed');
  await sameChain(chain, shown);
  entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { entries, ...(truncated ? { truncated: true as const } : {}) };
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
