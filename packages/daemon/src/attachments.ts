import { createHash, randomBytes } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { ATTACHMENTS, ERROR, RPC_ERROR, attachmentChunkBytes } from '@anhlp/alp-protocol';
import type { AttachmentInfo, AttachmentLimits } from '@anhlp/alp-protocol/rpc';
import type { RuntimeAttachment } from '@anhlp/alp-protocol/session';
import { RpcError } from './rpc-error.js';

/**
 * Non-image attachments (capability `attachments`, docs/protocol/alp-json-rpc-v1.md §12.6, issue
 * #121 branch I): daemon-owned immutable objects under `<ALP_HOME>/state/attachments/<id>/`, each a
 * directory (0700) holding an opaque `payload` (0600, 0400 once committed) and its `meta.json`,
 * plus one durable reference index `refs.json` beside them.
 *
 * - An upload is bound to its principal (identity and grant epoch; `owner` for the local owner), the
 *   canonical project of its session, and the session. Every chunk, commit, get, delete and prompt
 *   checks the whole binding again; an id that is unknown, of another principal, epoch, project or
 *   session, or whose session is gone answers the same `1001 not_found`.
 * - Nothing a client sends becomes a path: ids are generated here, the display name is only
 *   metadata. Files are created exclusively without following links, and every open checks a
 *   regular file with one name whose device and inode are the ones recorded at creation, so a
 *   swapped, linked or replaced directory or payload is refused rather than followed.
 * - Quota is reserved at begin for the declared size, synchronously, so concurrent begins cannot
 *   oversubscribe; it is held until the object is deleted, whether or not it is referenced.
 * - An object is published by writing its meta as committed, atomically, after its whole payload
 *   was read back and its SHA-256 matched. A write failure aborts the upload: nothing half written
 *   is ever committed and its reservation is released.
 * - References are holders (a prompt receipt key, later a fork) naming the attachments they keep,
 *   in `refs.json`, written atomically before what needs them (a prompt's delivery). A referenced
 *   object is never collected; one whose references were released is kept `releasedGraceMs` more.
 *
 * Process crashes are covered (atomic renames, temporary files cleaned at start); power loss is not
 * claimed. Windows is not supported (no O_NOFOLLOW, no POSIX modes): alpd does not serve this there.
 */

export type Principal = { id: string; epoch: string; roots?: readonly string[] };
export type AttachmentLimitsInput = Partial<AttachmentLimits>;

/** What alpd binds for a runtime that takes attachments (the seam of issue #121 branch J). */
export type AttachmentReader = {
  /**
   * The verified bytes of an attachment some holder of `sessionId` pins (a prompt alpd delivers to
   * it): a read-only stream of exactly `size` bytes whose SHA-256 is checked at its end, never a path.
   */
  open(attachmentId: string, sessionId: string): Promise<{ stream: Readable; attachment: RuntimeAttachment }>;
};

/** The runtime side of the seam: absent members mean the runtime takes no attachment parts. */
export type AttachmentRuntime = {
  /** Whether this live session's runtime takes `{ type: 'attachment' }` parts (RuntimeAttachment) now. */
  takesAttachments?(sessionId: string): boolean;
  /** alpd hands its reader over once, at start, as it does its schedules. */
  bindAttachments?(reader: AttachmentReader | undefined): void;
  /** Removes the runtime's staged copy of an object alpd collected. */
  dropAttachment?(attachmentId: string): Promise<void>;
};

type Meta = {
  version: 1;
  id: string;
  state: 'uploading' | 'committed';
  principalId: string;
  principalEpoch: string;
  project: string;
  sessionId: string;
  requestKey: string;
  fingerprint: string;
  name: string;
  mimeType: string;
  size: number;
  declaredSha256?: string;
  createdAt: string;
  expiresAt: string;
  dir: { dev: string; ino: string };
  payload: { dev: string; ino: string };
  sha256?: string;
  detectedMimeType?: string;
  committedAt?: string;
};

type Holder = { sessionId: string; attachments: string[]; at: string; kind: string };
type Refs = { version: 1; holders: Record<string, Holder>; released: Record<string, string> };

const ID = /^[0-9a-f]{32}$/;
const UPLOAD = /^upl_([0-9a-f]{32})$/;
const ATTACHMENT = /^att_([0-9a-f]{32})$/;
const SHA256 = /^[0-9a-f]{64}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const OPEN_READ = constants.O_RDONLY | NOFOLLOW;
const OPEN_WRITE = constants.O_RDWR | NOFOLLOW;
const OPEN_CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;
const MAX_META_BYTES = 64 * 1024;
const MAX_REFS_BYTES = 64 * 1024 * 1024;

const notFound = (what: 'upload' | 'attachment') => new RpcError(ERROR.notFound, what === 'upload' ? 'No such upload' : 'No such attachment', { reason: 'not_found' });
const invalid = (reason: string, message: string, extra: object = {}) => new RpcError(RPC_ERROR.invalidParams, message, { reason, ...extra });
const conflict = (reason: string, message: string, extra: object = {}) => new RpcError(ERROR.conflict, message, { reason, ...extra });
const unavailable = (reason: string, message: string, extra: object = {}) => new RpcError(ERROR.unavailable, message, { reason, ...extra });
const persistence = (what: string) => new RpcError(ERROR.failed, `alpd could not store ${what}`, { reason: 'persistence_failed' });

const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso = (ms: number) => new Date(ms).toISOString();
const identity = (info: Stats) => ({ dev: String(info.dev), ino: String(info.ino) });
const same = (info: Stats, recorded: { dev: string; ino: string }) => String(info.dev) === recorded.dev && String(info.ino) === recorded.ino;

/**
 * A display name as alpd keeps it: NFC, without control or format characters (NUL, bidi
 * overrides, zero-width), line or paragraph separators and path separators (/ and \), trimmed; at
 * most `maxBytes` UTF-8 bytes. It is metadata only and never names a file. Undefined when nothing
 * usable is left (empty, `.` or `..`) or it is too long.
 */
export function attachmentName(raw: unknown, maxBytes = ATTACHMENTS.maxNameBytes): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const name = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\]/gu, '').trim();
  if (!name || name === '.' || name === '..') return undefined;
  if (Buffer.byteLength(name, 'utf8') > maxBytes) return undefined;
  return name;
}

/**
 * What the first bytes of a payload look like, for display only: the declared MIME type is the
 * client's and is never trusted to choose behaviour, nor is this.
 */
export function sniffMimeType(head: Buffer): string {
  const starts = (bytes: number[] | string, at = 0) => {
    const expected = typeof bytes === 'string' ? Buffer.from(bytes, 'latin1') : Buffer.from(bytes);
    return head.length >= at + expected.length && head.subarray(at, at + expected.length).equals(expected);
  };
  if (!head.length) return 'application/octet-stream';
  if (starts('%PDF-')) return 'application/pdf';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts('GIF87a') || starts('GIF89a')) return 'image/gif';
  if (starts('RIFF') && starts('WEBP', 8)) return 'image/webp';
  if (starts([0x50, 0x4b, 0x03, 0x04]) || starts([0x50, 0x4b, 0x05, 0x06])) return 'application/zip';
  if (starts([0x1f, 0x8b])) return 'application/gzip';
  if (head.includes(0)) return 'application/octet-stream';
  // Valid UTF-8 (a character cut at the end of the head aside) reads as text.
  for (let cut = 0; cut < 4 && cut < head.length; cut++) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(head.subarray(0, head.length - cut)); return 'text/plain'; } catch {}
  }
  return 'application/octet-stream';
}

/** Effective limits: ATTACHMENTS, each lowered (never raised) by `input`; the chunk also by the frame. */
export function attachmentLimits(input: AttachmentLimitsInput = {}, maxFrame?: number): AttachmentLimits {
  const out: Record<string, number> = {};
  for (const key of ['maxObjectBytes', 'maxPerPrompt', 'maxPromptBytes', 'maxChunkBytes', 'maxActiveUploads', 'maxPrincipalBytes', 'maxDaemonBytes', 'uploadTimeoutMs', 'unreferencedRetentionMs', 'releasedGraceMs'] as const) {
    const value = (input as Record<string, unknown>)[key];
    out[key] = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, ATTACHMENTS[key]) : ATTACHMENTS[key];
  }
  out.maxChunkBytes = attachmentChunkBytes(maxFrame, Math.max(1, out.maxChunkBytes));
  return out as AttachmentLimits;
}

/** Hooks for tests: a write that fails as a full disk would, crash points, a clock. */
export type AttachmentStoreOptions = {
  /** `<ALP_HOME>/state/attachments`. */
  root: string;
  limits?: AttachmentLimitsInput;
  /** The project root of a session alpd knows (live or recorded), or undefined. */
  sessionProject(sessionId: string): string | undefined;
  now?: () => number;
  crashPoint?: (name: string) => void;
  log?: { warn(message: string, fields?: Record<string, unknown>): void; info?(message: string, fields?: Record<string, unknown>): void };
  io?: { write?(handle: FileHandle, buffer: Buffer, position: number): Promise<void> };
  /** How often expired uploads and unreferenced objects are collected while alpd runs. */
  sweepMs?: number;
  /** Told of each committed object alpd removes (the runtime drops its staged copy); failures are logged. */
  onDiscard?: (attachmentId: string) => Promise<void> | void;
};

export type AttachmentStore = ReturnType<typeof createAttachmentStore>;

export function createAttachmentStore(options: AttachmentStoreOptions) {
  const { root, sessionProject } = options;
  const limits = attachmentLimits(options.limits);
  const now = options.now ?? Date.now;
  const crashPoint = options.crashPoint ?? (() => {});
  const log = options.log;
  /** Every object alpd knows, committed or uploading; reservations count from the moment they are here. */
  const objects = new Map<string, Meta>();
  let refs: Refs = { version: 1, holders: {}, released: {} };
  /** Begins in flight by request key, so a repeat waits for the first. */
  const beginning = new Map<string, Promise<unknown>>();
  const queues = new Map<string, Promise<unknown>>();
  let failure: Error | undefined;
  let sweeper: NodeJS.Timeout | undefined;
  /** Referenced object directories whose meta could not be read (logged once). */
  const unreadable = new Set<string>();

  /** Runs `run` after everything queued under `key`. */
  function serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(run);
    queues.set(key, result);
    void result.finally(() => { if (queues.get(key) === result) queues.delete(key); }).catch(() => {});
    return result;
  }
  const withRefs = <T>(run: () => Promise<T>) => serial('refs', run);
  const withObject = <T>(id: string, run: () => Promise<T>) => serial(`object:${id}`, run);

  const dirOf = (id: string) => path.join(root, id);
  const payloadOf = (id: string) => path.join(root, id, 'payload');
  const metaOf = (id: string) => path.join(root, id, 'meta.json');
  const refsFile = path.join(root, 'refs.json');

  /** Writes `file` through an exclusive temporary file beside it, then one rename. */
  async function writeAtomic(file: string, body: string) {
    const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    let handle: FileHandle | undefined;
    try {
      handle = await open(temporary, OPEN_CREATE, 0o600);
      await handle.writeFile(body, 'utf8');
      await handle.datasync();
      await handle.close();
      handle = undefined;
      await rename(temporary, file);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  /** Reads a small regular file without following a link at its end. */
  async function readSmall(file: string, max: number) {
    const handle = await open(file, OPEN_READ);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.size > max) throw new Error('not a private regular file');
      return await handle.readFile('utf8');
    } finally { await handle.close(); }
  }

  /** The object's directory, checked: a real directory (no link), private, the one created. */
  async function checkDir(meta: Meta) {
    const info = await lstat(dirOf(meta.id));
    if (!info.isDirectory() || info.isSymbolicLink() || !same(info, meta.dir) || (process.platform !== 'win32' && (info.mode & 0o077) !== 0)) throw new Error('attachment directory changed');
  }

  /** Opens the object's payload, checked: no link, a regular file with one name, the one created, no other access. */
  async function openPayload(meta: Meta, flags: number) {
    await checkDir(meta);
    const handle = await open(payloadOf(meta.id), flags);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || !same(info, meta.payload) || (process.platform !== 'win32' && (info.mode & 0o177) !== 0)) throw new Error('attachment payload changed');
      return { handle, info };
    } catch (error) { await handle.close().catch(() => {}); throw error; }
  }

  function parseMeta(text: string, id: string): Meta | undefined {
    let value: any;
    try { value = JSON.parse(text); } catch { return undefined; }
    const strings = ['principalId', 'principalEpoch', 'project', 'sessionId', 'requestKey', 'fingerprint', 'name', 'mimeType', 'createdAt', 'expiresAt'];
    if (!value || value.version !== 1 || value.id !== id || !['uploading', 'committed'].includes(value.state) || strings.some(key => typeof value[key] !== 'string')) return undefined;
    if (!Number.isSafeInteger(value.size) || value.size < 0) return undefined;
    for (const key of ['dir', 'payload']) if (typeof value[key]?.dev !== 'string' || typeof value[key]?.ino !== 'string') return undefined;
    if (value.state === 'committed' && (!SHA256.test(value.sha256 ?? '') || typeof value.committedAt !== 'string' || typeof value.detectedMimeType !== 'string')) return undefined;
    return value as Meta;
  }

  const holdersOf = (id: string) => Object.values(refs.holders).filter(holder => holder.attachments.includes(id));
  const usage = (principalId?: string) => {
    let bytes = 0; let uploads = 0;
    for (const meta of objects.values()) {
      if (principalId !== undefined && meta.principalId !== principalId) continue;
      bytes += meta.size;
      if (meta.state === 'uploading') uploads++;
    }
    return { bytes, uploads };
  };

  const info = (meta: Meta): AttachmentInfo => ({
    attachmentId: `att_${meta.id}`, sessionId: meta.sessionId, name: meta.name, mimeType: meta.mimeType,
    detectedMimeType: meta.detectedMimeType!, size: meta.size, sha256: meta.sha256!, createdAt: meta.createdAt,
    committedAt: meta.committedAt!, referenced: holdersOf(meta.id).length > 0,
  });
  const descriptor = (meta: Meta): RuntimeAttachment => ({ type: 'attachment', attachmentId: `att_${meta.id}`, name: meta.name, mimeType: meta.mimeType, detectedMimeType: meta.detectedMimeType!, size: meta.size, sha256: meta.sha256! });

  /** The canonical project of a session alpd knows now, or undefined. */
  async function projectOfSession(sessionId: string) {
    const project = sessionProject(sessionId);
    if (typeof project !== 'string' || !path.isAbsolute(project)) return undefined;
    return realpath(project).catch(() => undefined);
  }

  /** Whether `principal` may see `meta`: its identity, epoch, an authorized project, and the session still in it. */
  async function bound(meta: Meta, principal: Principal) {
    if (meta.principalId !== principal.id || meta.principalEpoch !== principal.epoch) return false;
    if (principal.roots !== undefined && !principal.roots.includes(meta.project)) return false;
    return (await projectOfSession(meta.sessionId)) === meta.project;
  }

  function usable() {
    if (closed) throw unavailable('attachment_unavailable', 'alpd attachment store is closed');
    if (failure) throw unavailable('attachment_unavailable', 'alpd cannot use its attachment store; its log says why');
  }

  /** Forgets an object and removes its files; its reservation is released at once. */
  async function discard(meta: Meta, why: string) {
    objects.delete(meta.id);
    if (refs.released[meta.id] !== undefined) delete refs.released[meta.id];
    await rm(dirOf(meta.id), { recursive: true, force: true }).catch(error => log?.warn('could not remove an attachment directory', { code: 'ALPD_ATTACHMENT_REMOVE_FAILED', why, error }));
    if (meta.state === 'committed') await Promise.resolve().then(() => options.onDiscard?.(`att_${meta.id}`)).catch(error => log?.warn('could not remove the staged copy of an attachment', { code: 'ALPD_ATTACHMENT_UNSTAGE_FAILED', why, error }));
  }

  /**
   * An upload of `principal` by its id: uploading, bound, not expired. Only under the object's
   * queue (`locked`) is an expired one removed.
   */
  async function upload(uploadId: unknown, principal: Principal, locked = true) {
    const id = typeof uploadId === 'string' ? UPLOAD.exec(uploadId)?.[1] : undefined;
    const meta = id ? objects.get(id) : undefined;
    if (!meta || meta.state !== 'uploading' || !await bound(meta, principal)) throw notFound('upload');
    if (locked && Date.parse(meta.expiresAt) <= now()) {
      await discard(meta, 'expired');
      throw new RpcError(ERROR.notFound, 'This upload expired; begin it again', { reason: 'upload_expired' });
    }
    return meta;
  }

  /** A committed attachment of `principal` by its id. */
  async function attachment(attachmentId: unknown, principal: Principal) {
    const id = typeof attachmentId === 'string' ? ATTACHMENT.exec(attachmentId)?.[1] : undefined;
    const meta = id ? objects.get(id) : undefined;
    if (!meta || meta.state !== 'committed' || !await bound(meta, principal)) throw notFound('attachment');
    return meta;
  }

  async function saveRefs(next: Refs) {
    await writeAtomic(refsFile, JSON.stringify(next));
    refs = next;
  }

  /** Collects expired uploads, unreferenced objects past their retention and leftovers of a crash. */
  async function sweep() {
    if (failure || closed) return;
    await withRefs(async () => {
      const at = now();
      const released = { ...refs.released };
      let changed = false;
      for (const meta of [...objects.values()]) {
        await withObject(meta.id, async () => {
          if (objects.get(meta.id) !== meta) return;
          if (meta.state === 'uploading') {
            if (Date.parse(meta.expiresAt) <= at) await discard(meta, 'expired');
            return;
          }
          if (holdersOf(meta.id).length) return;
          const since = released[meta.id];
          const due = since !== undefined ? Date.parse(since) + limits.releasedGraceMs : Date.parse(meta.committedAt!) + limits.unreferencedRetentionMs;
          if (!(due <= at)) return;
          if (since !== undefined) { delete released[meta.id]; changed = true; }
          await discard(meta, since !== undefined ? 'released' : 'unreferenced');
        });
      }
      for (const id of Object.keys(released)) if (!objects.has(id)) { delete released[id]; changed = true; }
      if (changed) await saveRefs({ ...refs, released }).catch(error => log?.warn('could not record collected attachments', { code: 'ALPD_ATTACHMENT_REFS_FAILED', error }));
      await removeLeftovers(at);
    });
  }

  /** Directories without a readable meta (a begin a crash cut short) after the upload timeout; temporary files. */
  async function removeLeftovers(at: number) {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const file = path.join(root, entry.name);
      if (entry.name.startsWith('refs.json.') && entry.name.endsWith('.tmp')) { await rm(file, { force: true }); continue; }
      if (!ID.test(entry.name) || objects.has(entry.name)) continue;
      const info = await lstat(file).catch(() => undefined);
      if (!info) continue;
      if (!info.isDirectory() || info.isSymbolicLink()) { await rm(file, { force: true }); continue; }
      // A directory whose meta cannot be read but that a reference names is never removed: it is kept for repair.
      if (holdersOf(entry.name).length) {
        if (!unreadable.has(entry.name)) { unreadable.add(entry.name); log?.warn('a referenced attachment\'s metadata cannot be read; it is kept', { code: 'ALPD_ATTACHMENT_UNAVAILABLE', attachmentId: `att_${entry.name}` }); }
        continue;
      }
      if (at - info.mtimeMs >= limits.uploadTimeoutMs) await rm(file, { recursive: true, force: true });
    }
  }

  /**
   * Start-up: the root checked private, the reference index loaded (an unreadable one kept aside
   * and every committed object treated as referenced: nothing is collected on a guess), objects
   * loaded with their payloads checked, temporary files and expired uploads removed.
   */
  async function recover() {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const top = await lstat(root);
    if (!top.isDirectory() || top.isSymbolicLink() || (process.platform !== 'win32' && ((top.mode & 0o077) !== 0 || top.uid !== process.getuid?.()))) throw new Error('the attachment store must be a private directory of the daemon user (0700), not a link');
    let conservative = false;
    try {
      const parsed = JSON.parse(await readSmall(refsFile, MAX_REFS_BYTES));
      if (!parsed || parsed.version !== 1 || typeof parsed.holders !== 'object' || typeof parsed.released !== 'object') throw new Error('not a reference index');
      for (const holder of Object.values(parsed.holders) as Holder[]) if (typeof holder?.sessionId !== 'string' || !Array.isArray(holder.attachments)) throw new Error('not a reference index');
      refs = { version: 1, holders: parsed.holders, released: parsed.released };
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        conservative = true;
        const aside = `${refsFile}.corrupt-${now()}`;
        await rename(refsFile, aside).catch(() => {});
        log?.warn('the attachment reference index cannot be read; kept aside, every stored attachment is kept as referenced', { code: 'ALPD_ATTACHMENT_REFS_UNREADABLE', error });
      }
    }
    const at = now();
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!ID.test(entry.name)) continue;
      const directory = dirOf(entry.name);
      const dirInfo = await lstat(directory).catch(() => undefined);
      if (!dirInfo || !dirInfo.isDirectory() || dirInfo.isSymbolicLink()) continue;
      for (const name of await readdir(directory)) if (name.startsWith('meta.json.') && name.endsWith('.tmp')) await rm(path.join(directory, name), { force: true });
      const meta = parseMeta(await readSmall(metaOf(entry.name), MAX_META_BYTES).catch(() => ''), entry.name);
      if (!meta) continue;
      if (meta.state === 'uploading' && Date.parse(meta.expiresAt) <= at) { await rm(directory, { recursive: true, force: true }); continue; }
      objects.set(meta.id, meta);
      if (meta.state === 'committed') {
        // A crash between publication and making it read-only.
        const opened = await openPayload(meta, OPEN_READ).catch(() => undefined);
        if (opened) { await opened.handle.chmod(0o400).catch(() => {}); await opened.handle.close(); }
        else log?.warn('a stored attachment\'s payload is missing or changed; it is kept as unavailable', { code: 'ALPD_ATTACHMENT_UNAVAILABLE', attachmentId: `att_${meta.id}` });
        if (conservative) refs.holders[`recovered:${meta.id}`] = { sessionId: meta.sessionId, attachments: [meta.id], at: iso(at), kind: 'recovered' };
      }
    }
    if (conservative) await saveRefs(refs);
    await removeLeftovers(at);
    await sweep();
  }

  const recovered = recover().catch(error => {
    failure = error instanceof Error ? error : new Error(String(error));
    log?.warn('the attachment store cannot be used', { code: 'ALPD_ATTACHMENTS_UNUSABLE', error });
  });
  let closed = false;
  // Collection while alpd runs starts only once recovery has loaded every object: before that, an
  // object directory not yet loaded would look like a leftover and be removed.
  if (options.sweepMs !== 0) {
    void recovered.then(() => {
      if (closed || failure) return;
      sweeper = setInterval(() => void sweep().catch(error => log?.warn('attachment collection failed', { code: 'ALPD_ATTACHMENT_SWEEP_FAILED', error })), options.sweepMs ?? Math.min(15 * 60 * 1000, Math.max(1000, Math.floor(limits.uploadTimeoutMs / 4))));
      sweeper.unref();
    });
  }

  const beginResult = (meta: Meta, received: number) => ({
    uploadId: `upl_${meta.id}`, state: meta.state, received, size: meta.size, maxChunkBytes: limits.maxChunkBytes,
    ...(meta.state === 'uploading' ? { expiresAt: meta.expiresAt } : { attachmentId: `att_${meta.id}` }),
  });

  /** Bytes stored of an upload so far: its payload's size, read through the checked handle. */
  async function received(meta: Meta) {
    const { handle, info } = await openPayload(meta, OPEN_READ);
    await handle.close();
    return info.size;
  }

  async function write(handle: FileHandle, buffer: Buffer, position: number) {
    if (options.io?.write) return options.io.write(handle, buffer, position);
    let done = 0;
    while (done < buffer.length) {
      const { bytesWritten } = await handle.write(buffer, done, buffer.length - done, position + done);
      if (!bytesWritten) throw new Error('short write');
      done += bytesWritten;
    }
  }

  return {
    /** Effective limits, advertised in daemon.hello. */
    limits,
    /** Settles when start-up recovery is done (or failed: the methods then answer 1005). */
    ready: () => recovered,
    /** One collection now, after start-up recovery (as the timer's). */
    async sweep() { await recovered; return sweep(); },

    async begin(principal: Principal, params: { sessionId: string; name: string; size: number; mimeType: string; sha256?: string; requestId: string }) {
      await recovered; usable();
      const name = attachmentName(params.name, ATTACHMENTS.maxNameBytes);
      if (!name) throw invalid('invalid_name', `A file name needs a visible character and at most ${ATTACHMENTS.maxNameBytes} UTF-8 bytes once control characters and path separators are removed`);
      if (!Number.isSafeInteger(params.size) || params.size < 0) throw invalid('invalid_params', 'size must be a byte count');
      if (params.size > limits.maxObjectBytes) throw invalid('attachment_too_large', `An attachment is at most ${limits.maxObjectBytes} bytes`, { limit: limits.maxObjectBytes });
      if (params.sha256 !== undefined && !SHA256.test(params.sha256)) throw invalid('invalid_params', 'sha256 must be 64 lowercase hex digits');
      const mimeType = params.mimeType.toLowerCase();
      const project = await projectOfSession(params.sessionId);
      if (!project || (principal.roots !== undefined && !principal.roots.includes(project))) throw new RpcError(ERROR.notFound, 'No such session', { reason: 'not_found' });
      const requestKey = sha(['attachment.begin', principal.id, principal.epoch, params.requestId]);
      const fingerprint = sha([params.sessionId, name, params.size, mimeType, params.sha256 ?? null]);
      // One request key makes at most one upload: after any await here the checks run again, as a
      // concurrent repeat may have begun it meanwhile.
      for (;;) {
        while (beginning.has(requestKey)) await beginning.get(requestKey)!.catch(() => {});
        const existing = [...objects.values()].find(meta => meta.requestKey === requestKey);
        if (!existing || existing.principalId !== principal.id || existing.principalEpoch !== principal.epoch) break;
        if (existing.fingerprint !== fingerprint) throw conflict('request_conflict', `requestId ${params.requestId} was used for another upload`);
        if (!await bound(existing, principal)) throw new RpcError(ERROR.notFound, 'No such session', { reason: 'not_found' });
        if (existing.state === 'committed') return beginResult(existing, existing.size);
        if (Date.parse(existing.expiresAt) > now()) return withObject(existing.id, async () => beginResult(existing, await received(existing)));
        await withObject(existing.id, () => discard(existing, 'expired'));
      }
      // Reserved here, before anything awaits: concurrent begins see each other's reservation.
      const at = now();
      // Expired uploads release their reservation now, and so do this principal's uploads of
      // another grant epoch (a reissued credential): nobody can continue or abort those any more.
      // Their files go after any call on them.
      for (const meta of [...objects.values()]) {
        if (meta.state !== 'uploading') continue;
        if (Date.parse(meta.expiresAt) > at && !(meta.principalId === principal.id && meta.principalEpoch !== principal.epoch)) continue;
        objects.delete(meta.id);
        void withObject(meta.id, () => rm(dirOf(meta.id), { recursive: true, force: true })).catch(() => {});
      }
      const mine = usage(principal.id);
      if (mine.uploads >= limits.maxActiveUploads) throw unavailable('quota_exceeded', `At most ${limits.maxActiveUploads} uploads may be in progress at once; commit or abort one first`, { limit: 'active_uploads', max: limits.maxActiveUploads });
      if (mine.bytes + params.size > limits.maxPrincipalBytes) throw unavailable('quota_exceeded', `Attachments of this principal take at most ${limits.maxPrincipalBytes} bytes, referenced ones included; delete unreferenced ones first`, { limit: 'principal_bytes', max: limits.maxPrincipalBytes });
      if (usage().bytes + params.size > limits.maxDaemonBytes) throw unavailable('quota_exceeded', 'The daemon host keeps no more attachment bytes now', { limit: 'daemon_bytes', max: limits.maxDaemonBytes });
      const id = randomBytes(16).toString('hex');
      const meta: Meta = {
        version: 1, id, state: 'uploading', principalId: principal.id, principalEpoch: principal.epoch, project, sessionId: params.sessionId,
        requestKey, fingerprint, name, mimeType, size: params.size, ...(params.sha256 ? { declaredSha256: params.sha256 } : {}),
        createdAt: iso(at), expiresAt: iso(at + limits.uploadTimeoutMs), dir: { dev: '', ino: '' }, payload: { dev: '', ino: '' },
      };
      objects.set(id, meta);
      const creating = withObject(id, async () => {
        try {
          await mkdir(dirOf(id), { mode: 0o700 });
          const dirInfo = await lstat(dirOf(id));
          if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) throw new Error('attachment directory is not a directory');
          meta.dir = identity(dirInfo);
          const handle = await open(payloadOf(id), OPEN_CREATE, 0o600);
          try { meta.payload = identity(await handle.stat()); } finally { await handle.close(); }
          crashPoint('attachment.begin.before-meta');
          await writeAtomic(metaOf(id), JSON.stringify(meta));
          crashPoint('attachment.begin.after-meta');
          return beginResult(meta, 0);
        } catch (error) {
          if (objects.get(id) === meta) objects.delete(id);
          await rm(dirOf(id), { recursive: true, force: true }).catch(() => {});
          log?.warn('could not begin an attachment upload', { code: 'ALPD_ATTACHMENT_BEGIN_FAILED', error });
          throw persistence('the upload; it was not begun');
        }
      });
      beginning.set(requestKey, creating);
      try { return await creating; } finally { if (beginning.get(requestKey) === creating) beginning.delete(requestKey); }
    },

    async chunk(principal: Principal, params: { uploadId: string; offset: number; data: string }) {
      await recovered; usable();
      const first = await upload(params.uploadId, principal, false);
      return withObject(first.id, async () => {
        const meta = await upload(params.uploadId, principal);
        const bytes = Buffer.from(params.data, 'base64');
        // Canonical base64 only: what decodes is exactly what was sent.
        if (!bytes.length || bytes.toString('base64') !== params.data) throw invalid('invalid_data', 'data must be canonical base64 of at least one byte');
        if (bytes.length > limits.maxChunkBytes) throw invalid('invalid_data', `A chunk carries at most ${limits.maxChunkBytes} decoded bytes`, { limit: limits.maxChunkBytes });
        if (!Number.isSafeInteger(params.offset) || params.offset < 0) throw invalid('invalid_params', 'offset must be a byte offset');
        if (params.offset + bytes.length > meta.size) throw invalid('attachment_too_large', `This upload declared ${meta.size} bytes; the chunk goes beyond them`, { size: meta.size });
        let opened;
        try { opened = await openPayload(meta, OPEN_WRITE); }
        catch (error) {
          log?.warn('an upload\'s files changed or vanished; it was aborted', { code: 'ALPD_ATTACHMENT_TAMPERED', error });
          await discard(meta, 'tampered');
          throw persistence('the upload; it was aborted');
        }
        const { handle, info } = opened;
        try {
          const stored = info.size;
          if (params.offset > stored) throw conflict('offset_mismatch', `The upload holds ${stored} bytes; send the chunk at offset ${stored}`, { received: stored });
          // A retry of bytes already stored must be those bytes; the rest is appended.
          const overlap = Math.min(stored - params.offset, bytes.length);
          if (overlap > 0) {
            const existing = Buffer.alloc(overlap);
            await handle.read(existing, 0, overlap, params.offset);
            if (!existing.equals(bytes.subarray(0, overlap))) throw conflict('chunk_conflict', `Bytes at offset ${params.offset} were already received with other content`, { received: stored });
          }
          if (overlap < bytes.length) {
            try { await write(handle, bytes.subarray(overlap), params.offset + overlap); }
            catch (error) {
              await handle.close().catch(() => {});
              log?.warn('could not write an upload chunk; the upload was aborted', { code: 'ALPD_ATTACHMENT_WRITE_FAILED', error });
              await discard(meta, 'write failed');
              throw persistence('the chunk; the upload was aborted and its space released');
            }
          }
          return { received: Math.max(stored, params.offset + bytes.length), size: meta.size };
        } finally { await handle.close().catch(() => {}); }
      });
    },

    async commit(principal: Principal, params: { uploadId: string; sha256: string }) {
      await recovered; usable();
      const id = UPLOAD.exec(params.uploadId)?.[1];
      const known = id ? objects.get(id) : undefined;
      // A repeat of a commit that succeeded answers the same attachment.
      if (known?.state === 'committed' && await bound(known, principal)) {
        if (known.sha256 !== params.sha256) throw conflict('hash_mismatch', 'This upload was committed with another SHA-256');
        return { attachment: info(known) };
      }
      const first = await upload(params.uploadId, principal, false);
      return withObject(first.id, async () => {
        const again = objects.get(first.id);
        if (again?.state === 'committed' && await bound(again, principal)) {
          if (again.sha256 !== params.sha256) throw conflict('hash_mismatch', 'This upload was committed with another SHA-256');
          return { attachment: info(again) };
        }
        const meta = await upload(params.uploadId, principal);
        let opened;
        try { opened = await openPayload(meta, OPEN_READ); }
        catch (error) {
          log?.warn('an upload\'s files changed or vanished; it was aborted', { code: 'ALPD_ATTACHMENT_TAMPERED', error });
          await discard(meta, 'tampered');
          throw persistence('the upload; it was aborted');
        }
        const { handle, info: stat } = opened;
        let digest: string;
        let head: Buffer;
        try {
          if (stat.size !== meta.size) throw conflict('upload_incomplete', `The upload holds ${stat.size} of ${meta.size} bytes`, { received: stat.size, size: meta.size });
          // Every byte read back from the checked file: the digest is of what is stored, not of what was sent.
          const hash = createHash('sha256');
          const buffer = Buffer.alloc(64 * 1024);
          head = Buffer.alloc(0);
          for (let position = 0; position < meta.size;) {
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, meta.size - position), position);
            if (!bytesRead) throw new Error('short read');
            hash.update(buffer.subarray(0, bytesRead));
            if (head.length < 8192) head = Buffer.concat([head, buffer.subarray(0, Math.min(bytesRead, 8192 - head.length))]);
            position += bytesRead;
          }
          digest = hash.digest('hex');
          await handle.datasync();
        } catch (error) {
          await handle.close().catch(() => {});
          if (error instanceof RpcError) throw error;
          log?.warn('could not read an upload back; it was aborted', { code: 'ALPD_ATTACHMENT_READ_FAILED', error });
          await discard(meta, 'read failed');
          throw persistence('the upload; it was aborted');
        }
        await handle.close().catch(() => {});
        if (digest !== params.sha256 || (meta.declaredSha256 !== undefined && digest !== meta.declaredSha256)) {
          await discard(meta, 'hash mismatch');
          throw conflict('hash_mismatch', 'The bytes received do not have this SHA-256; the upload was aborted');
        }
        // A begin may have released this upload meanwhile (expired, or of an earlier grant epoch):
        // its files go after this call, and it is never published again.
        if (objects.get(meta.id) !== meta) throw notFound('upload');
        const committed: Meta = { ...meta, state: 'committed', sha256: digest, detectedMimeType: sniffMimeType(head), committedAt: iso(now()) };
        crashPoint('attachment.commit.before-publish');
        try { await writeAtomic(metaOf(meta.id), JSON.stringify(committed)); }
        catch (error) {
          log?.warn('could not publish an attachment; the upload was aborted', { code: 'ALPD_ATTACHMENT_PUBLISH_FAILED', error });
          await discard(meta, 'publish failed');
          throw persistence('the attachment; the upload was aborted and its space released');
        }
        if (objects.get(meta.id) !== meta) throw notFound('upload');
        objects.set(meta.id, committed);
        crashPoint('attachment.commit.after-publish');
        // Read-only from now on; recovery repeats it after a crash in between.
        const readOnly = await openPayload(committed, OPEN_READ).catch(() => undefined);
        if (readOnly) { await readOnly.handle.chmod(0o400).catch(() => {}); await readOnly.handle.close(); }
        return { attachment: info(committed) };
      });
    },

    async abort(principal: Principal, params: { uploadId: string }) {
      await recovered; usable();
      const first = await upload(params.uploadId, principal, false);
      return withObject(first.id, async () => {
        const meta = await upload(params.uploadId, principal);
        await discard(meta, 'aborted');
        return { aborted: true as const };
      });
    },

    async get(principal: Principal, params: { attachmentId: string }) {
      await recovered; usable();
      return { attachment: info(await attachment(params.attachmentId, principal)) };
    },

    /** Deletes an attachment nothing references; a referenced one is refused, never evicted. */
    async remove(principal: Principal, params: { attachmentId: string }) {
      await recovered; usable();
      await attachment(params.attachmentId, principal);
      return withRefs(() => withObject(ATTACHMENT.exec(params.attachmentId)![1], async () => {
        const meta = await attachment(params.attachmentId, principal);
        if (holdersOf(meta.id).length) throw conflict('attachment_referenced', 'A prompt still references this attachment; it is kept');
        const released = { ...refs.released };
        if (released[meta.id] !== undefined) { delete released[meta.id]; await saveRefs({ ...refs, released }).catch(() => {}); }
        await discard(meta, 'deleted');
        return { deleted: true as const };
      }));
    },

    /**
     * The attachments of a prompt to `sessionId`, in order, checked as every other call checks them
     * (bound to this principal, project and session) and within the prompt limits, with their payloads
     * there. What the runtime gets in their place: ids, display metadata and digests.
     */
    async resolve(principal: Principal, sessionId: string, attachmentIds: unknown[]) {
      await recovered; usable();
      if (attachmentIds.length > limits.maxPerPrompt) throw invalid('attachment_limit', `A prompt carries at most ${limits.maxPerPrompt} attachments`, { maxPerPrompt: limits.maxPerPrompt });
      const found: RuntimeAttachment[] = [];
      let total = 0;
      for (const attachmentId of attachmentIds) {
        const meta = await attachment(attachmentId, principal);
        if (meta.sessionId !== sessionId) throw notFound('attachment');
        total += meta.size;
        if (total > limits.maxPromptBytes) throw invalid('attachment_limit', `The attachments of a prompt are at most ${limits.maxPromptBytes} bytes together`, { maxPromptBytes: limits.maxPromptBytes });
        const opened = await openPayload(meta, OPEN_READ).catch(() => undefined);
        await opened?.handle.close();
        if (!opened || opened.info.size !== meta.size) throw unavailable('attachment_unavailable', `Attachment att_${meta.id} is stored but its bytes cannot be read now`, { attachmentId: `att_${meta.id}` });
        found.push(descriptor(meta));
      }
      return found;
    },

    /**
     * Pins `attachmentIds` for `holder` durably (a prompt's receipt key; t-15b0.4's fork adds the
     * new session's holder the same way after re-authorizing the source's attachments for it). Each
     * must still be committed; a write failure pins nothing. If interrupted by crash before the receipt
     * is written, the pin is held conservatively until session cleanup (releaseSessions).
     */
    async pin(holder: string, sessionId: string, attachmentIds: string[], kind = 'prompt') {
      await recovered; usable();
      const ids = attachmentIds.map(attachmentId => ATTACHMENT.exec(attachmentId)?.[1]);
      return withRefs(async () => {
        for (const id of ids) if (!id || objects.get(id)?.state !== 'committed') throw notFound('attachment');
        const kept = new Set([...(refs.holders[holder]?.attachments ?? []), ...ids as string[]]);
        const released = { ...refs.released };
        for (const id of kept) delete released[id];
        crashPoint('attachment.pin.before-write');
        try { await saveRefs({ version: 1, holders: { ...refs.holders, [holder]: { sessionId, attachments: [...kept], at: iso(now()), kind } }, released }); }
        catch (error) {
          log?.warn('could not record attachment references', { code: 'ALPD_ATTACHMENT_REFS_FAILED', error });
          throw persistence('the attachment references; the prompt was not sent');
        }
        crashPoint('attachment.pin.after-write');
      });
    },

    /** The attachments these holders pin, as ids (a fork's kept prompts, §12.7); unknown holders hold none. */
    async heldBy(holders: string[]) {
      await recovered;
      if (failure) return [];
      const ids = new Set<string>();
      for (const holder of holders) for (const id of refs.holders[holder]?.attachments ?? []) ids.add(`att_${id}`);
      return [...ids];
    },

    /**
     * Re-authorizes attachments for `principal` before another session pins them (a fork, §12.7): each
     * must be committed and bound to this principal, its grant epoch and an authorized project, as every
     * other call checks; otherwise refused as an unknown one.
     */
    async authorize(principal: Principal, attachmentIds: string[], forks: string[] = []) {
      await recovered; usable();
      for (const attachmentId of attachmentIds) {
        const id = typeof attachmentId === 'string' ? ATTACHMENT.exec(attachmentId)?.[1] : undefined;
        const meta = id ? objects.get(id) : undefined;
        if (meta?.state === 'committed' && await bound(meta, principal)) continue;
        // A fork of a fork whose first ancestor's history is gone: the session the object was uploaded
        // to is no longer known, but a fork in the lineage, still in the same project, pinned it after
        // re-authorizing it for this very principal and epoch. Nothing else is relaxed.
        if (meta?.state === 'committed' && meta.principalId === principal.id && meta.principalEpoch === principal.epoch && (principal.roots === undefined || principal.roots.includes(meta.project))) {
          let held = false;
          for (const fork of forks) {
            if (refs.holders[`fork:${fork}`]?.sessionId === fork && refs.holders[`fork:${fork}`].attachments.includes(meta.id) && await projectOfSession(fork) === meta.project) { held = true; break; }
          }
          if (held) continue;
        }
        throw notFound('attachment');
      }
    },

    /** Drops `holder`'s references (a prompt refused before it reached the runtime). */
    async release(holder: string) {
      await recovered; usable();
      return withRefs(async () => {
        if (!refs.holders[holder]) return;
        const { [holder]: dropped, ...holders } = refs.holders;
        const released = { ...refs.released };
        for (const id of dropped.attachments) if (!Object.values(holders).some(other => other.attachments.includes(id))) released[id] = iso(now());
        await saveRefs({ version: 1, holders, released });
      });
    },

    /**
     * Releases every reference of these sessions: the seam for deleting a session's history (today
     * only retention removes a tree; archive keeps it). Released objects stay `releasedGraceMs`.
     */
    async releaseSessions(sessionIds: string[]) {
      await recovered;
      if (failure) return;
      const gone = new Set(sessionIds);
      return withRefs(async () => {
        const holders: Record<string, Holder> = {};
        const dropped: string[] = [];
        for (const [key, holder] of Object.entries(refs.holders)) {
          if (gone.has(holder.sessionId)) dropped.push(...holder.attachments);
          else holders[key] = holder;
        }
        if (!dropped.length && Object.keys(holders).length === Object.keys(refs.holders).length) return;
        const released = { ...refs.released };
        for (const id of dropped) if (!Object.values(holders).some(other => other.attachments.includes(id))) released[id] = iso(now());
        await saveRefs({ version: 1, holders, released });
      });
    },

    /** The runtime's reader (AttachmentReader). */
    reader: {
      async open(attachmentId: string, sessionId: string) {
        await recovered; usable();
        const id = ATTACHMENT.exec(attachmentId)?.[1];
        const meta = id ? objects.get(id) : undefined;
        if (!meta || meta.state !== 'committed' || !Object.values(refs.holders).some(holder => holder.sessionId === sessionId && holder.attachments.includes(meta.id))) throw notFound('attachment');
        const { handle, info: stat } = await openPayload(meta, OPEN_READ);
        if (stat.size !== meta.size) { await handle.close(); throw unavailable('attachment_unavailable', 'The attachment\'s bytes changed', { attachmentId: `att_${meta.id}` }); }
        const hash = createHash('sha256');
        const stream = handle.createReadStream({ start: 0, ...(meta.size ? { end: meta.size - 1 } : {}), autoClose: true });
        const verified = stream.pipe(new Transform({
          transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk); },
          flush(done) { done(hash.digest('hex') === meta.sha256 ? null : new Error('attachment bytes do not match their SHA-256')); },
        }));
        stream.on('error', error => verified.destroy(error));
        return { stream: verified as Readable, attachment: descriptor(meta) };
      },
    } satisfies AttachmentReader,

    /** Usage, for tests and status: bytes reserved and uploads in progress, of one principal or all. */
    usage,
    /** The holders of the reference index, for tests. */
    holders: () => structuredClone(refs.holders),

    async close() {
      closed = true;
      if (sweeper) {
        clearInterval(sweeper);
        sweeper = undefined;
      }
      await Promise.allSettled([...queues.values()]);
    },
  };
}

const LIMIT_KEYS = ['maxObjectBytes', 'maxPerPrompt', 'maxPromptBytes', 'maxChunkBytes', 'maxActiveUploads', 'maxPrincipalBytes', 'maxDaemonBytes', 'uploadTimeoutMs', 'unreferencedRetentionMs', 'releasedGraceMs'] as const;

/**
 * The operator's attachment limits: `<ALP_HOME>/attachments.json`, `{ "limits": { "<name>": n } }`
 * with names of AttachmentLimits and non-negative integers. They may only lower ATTACHMENTS: a
 * higher value, an unknown name or a bad value is ignored and reported. A missing file is no
 * change; one that cannot be read is reported and ignored (the defaults hold).
 */
export async function readAttachmentConfig(home: string): Promise<{ limits: AttachmentLimitsInput; problems: string[] }> {
  const problems: string[] = [];
  const limits: Record<string, number> = {};
  let text: string;
  try {
    const handle = await open(path.join(home, 'attachments.json'), OPEN_READ);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('not a small regular file');
      text = await handle.readFile('utf8');
    } finally { await handle.close(); }
  } catch (error: any) {
    if (error?.code !== 'ENOENT') problems.push(`attachments.json cannot be read (${error?.code ?? error?.message ?? error}); the default limits hold`);
    return { limits, problems };
  }
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { problems.push('attachments.json is not JSON; the default limits hold'); return { limits, problems }; }
  const given = parsed?.limits;
  if (given === undefined) return { limits, problems };
  if (!given || typeof given !== 'object' || Array.isArray(given)) { problems.push('attachments.json limits must be an object'); return { limits, problems }; }
  for (const [key, value] of Object.entries(given)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) { problems.push(`attachments.json names an unknown limit ${key}`); continue; }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { problems.push(`attachments.json limit ${key} must be a non-negative integer`); continue; }
    if (value > ATTACHMENTS[key as keyof typeof ATTACHMENTS]) { problems.push(`attachments.json limit ${key} cannot raise the default ${ATTACHMENTS[key as keyof typeof ATTACHMENTS]}; it is ignored`); continue; }
    limits[key] = value;
  }
  return { limits, problems };
}
