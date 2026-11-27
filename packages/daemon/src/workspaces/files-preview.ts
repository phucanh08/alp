import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { lstat, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { ERROR, RPC_ERROR, WORKSPACE_FILES } from '@anhlp/alp-protocol';
import type { GitCheckOptions } from './gitignore.ts';
import { FileAccessError, type FileProbe, PRIVATE_KEY, directoryChain, ignoredOf, internalSegments, linked, notFound, openConfined, realRoot, relativeSegments, sameChain } from './files-confined.ts';

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
