import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import { ERROR, RPC_ERROR, WORKSPACE_FILES, blockedFilePath } from '@anhlp/alp-protocol';
import type { GitCheckOptions } from './gitignore.ts';

// For tests: which git alpd would run, and how many run now.
export { gitChecksRunning, resolveGit, GIT_CHECK } from './gitignore.ts';
import { FileAccessError, type FileProbe, PRIVATE_KEY, UTF8, directoryChain, ignoredOf, internalSegments, internalTarget, likelyBinary, linked, notFound, readConfined, realRoot, relativeSegments, sameChain } from './files-confined.ts';
export { FilesError, FileAccessError, relativeSegments, readConfinedFile, likelyBinary, PRIVATE_KEY } from './files-confined.ts';
export type { FileProbe } from './files-confined.ts';
export { LIMITS, searchWorkspaceFiles, FIND_LIMITS, inOrder, findWorkspaceEntries, createFindPages } from './files-search.ts';
export type { FoundEntry, FindOptions } from './files-search.ts';
export { PREVIEW_IMAGES, previewWorkspaceFile } from './files-preview.ts';
export type { FilePreview } from './files-preview.ts';
export { HOST_DIRECTORIES, nameRank, searchHostDirectories } from './host-directories.ts';

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
