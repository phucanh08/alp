import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, opendir, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ERROR, RPC_ERROR, WORKSPACE_FILES, blockedFilePath } from '@anhlp/alp-protocol';
import type { GitCheckOptions } from './gitignore.ts';

// For tests: which git alpd would run, and how many run now.
export { gitChecksRunning, resolveGit, GIT_CHECK } from './gitignore.ts';
import { FileAccessError, type FileProbe, PRIVATE_KEY, UTF8, directoryChain, ignoredOf, internalSegments, internalTarget, likelyBinary, linked, notFound, openConfined, readConfined, realRoot, relativeSegments, sameChain } from './files-confined.ts';
export { FilesError, FileAccessError, relativeSegments, readConfinedFile, likelyBinary, PRIVATE_KEY } from './files-confined.ts';
export type { FileProbe } from './files-confined.ts';
import { SKIPPED_FOLDERS, inOrder } from './files-search.ts';
export { LIMITS, searchWorkspaceFiles, FIND_LIMITS, inOrder, findWorkspaceEntries, createFindPages } from './files-search.ts';
export type { FoundEntry, FindOptions } from './files-search.ts';

// ---- workspace.files.list and workspace.files.read (docs/protocol/alp-json-rpc-v1.md §12.4) ----

/** Extra bounds of one listing: entries looked at, and wall time. */
const LIST_LIMITS = Object.freeze({ scanned: 20_000, ms: 3_000 });

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
