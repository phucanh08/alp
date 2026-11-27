import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { ERROR, RPC_ERROR, WORKSPACE_FILES, blockedFilePath } from '@anhlp/alp-protocol';
import { gitIgnored, IgnoreUnknown, type GitCheckOptions } from './gitignore.ts';

export class FilesError extends Error {}

/**
 * A refusal of workspace.files.list or workspace.files.read: the JSON-RPC code and `data.reason`
 * alpd answers with. Messages are fixed or name only the client's own relative path, never a host
 * path or anything read from a file.
 */
export class FileAccessError extends Error {
  declare readonly code: number;
  declare readonly reason: string;
  constructor(message: string, code: number, reason: string) {
    super(message);
    this.code = code;
    this.reason = reason;
  }
}

/** Opening never follows a final link nor waits on a FIFO; Windows has neither flag. */
const OPEN_FLAGS = process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export const notFound = (relative: string) => new FileAccessError(`No readable file or directory at ${relative}`, ERROR.notFound, 'not_found');
export const linked = (relative: string) => new FileAccessError(`${relative} is reached through a link, has more than one name, or changed while it was read; alpd does not follow links`, ERROR.forbidden, 'linked');
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
export async function internalSegments(root: string, segments: string[], relative: string): Promise<{ segments: string[]; via?: string }> {
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
export async function internalTarget(root: string, file: string): Promise<{ kind: 'file' | 'directory'; target: string } | undefined> {
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
export async function realRoot(projectRoot: string): Promise<string> {
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
export async function directoryChain(root: string, segments: string[], relative: string): Promise<{ paths: string[]; identities: string[] }> {
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
export async function sameChain(chain: { paths: string[]; identities: string[] }, relative: string): Promise<void> {
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
export async function ignoredOf(root: string, paths: string[], git?: GitCheckOptions): Promise<(path: string) => boolean> {
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

export async function readConfined(file: string, maxBytes: number, probe?: FileProbe): Promise<{ bytes: Buffer; modifiedAt: Date } | undefined> {
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
export async function openConfined(file: string, maxBytes: number, probe?: FileProbe): Promise<{ handle: FileHandle; before: BigIntStats; opened: BigIntStats } | undefined> {
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

export const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

