/**
 * Images attached to a message (t-7679.11), as Paseo's composer takes them (paste, drop, the
 * attach button; a preview each, with Remove), but sent inline: the browser reads the file and
 * the prompt carries its base64, never a path on either machine. The limits are the gateway's
 * (apps/gateway/src/policy.ts GATEWAY_PROMPT_IMAGES), so a refusal shows here before sending.
 */

/** The types the host takes (protocol PROMPT_IMAGES.mimeTypes). */
export const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** At most so many images, each of at most maxBytes, maxTotalBytes together. */
export const IMAGE_LIMITS: Readonly<{ maxCount: number; maxBytes: number; maxTotalBytes: number; }> = Object.freeze({ maxCount: 4, maxBytes: 2 * 1024 * 1024, maxTotalBytes: 2.5 * 1024 * 1024 });

/** Effective limits from hello; old peers use the compatible defaults, malformed offers fail closed. */
export function imageLimits(offered: unknown, capable: boolean = true) {
  const none = { maxCount: 0, maxBytes: 0, maxTotalBytes: 0 };
  if (!capable) return none;
  if (offered === undefined) return { ...IMAGE_LIMITS };
  if (!offered || typeof offered !== 'object' || Array.isArray(offered)) return none;
  const value = offered as Record<string, unknown>;
  if (!['maxCount', 'maxBytes', 'maxTotalBytes'].every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)) return none;
  const maxTotalBytes = Math.min(IMAGE_LIMITS.maxTotalBytes, value.maxTotalBytes as number);
  return { maxCount: Math.min(IMAGE_LIMITS.maxCount, value.maxCount as number), maxBytes: Math.min(IMAGE_LIMITS.maxBytes, maxTotalBytes, value.maxBytes as number), maxTotalBytes };
}

/** One attached image: what session.prompt carries, plus its size for the limits. */
export type ImageAttachment = { id: string, type: 'image', mimeType: string, data: string, name: string, size: number };

export const formatBytes = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The type of a file the host takes, by its MIME type (image/jpg as image/jpeg), else null. */
export function imageType(file: { type?: string; }) {
  const type = String(file?.type ?? '').split(';', 1)[0].trim().toLowerCase();
  const normal = type === 'image/jpg' ? 'image/jpeg' : type;
  return IMAGE_TYPES.includes(normal) ? normal : null;
}

/** The files of a paste or a drop. */
export function filesOf(transfer: { files?: ArrayLike<File> | null; items?: ArrayLike<{ kind?: string; getAsFile?: () => File | null; }> | null; } | null | undefined): File[] {
  if (!transfer) return [];
  const files = Array.from(transfer.files ?? []);
  if (files.length) return files;
  return Array.from(transfer.items ?? []).filter(item => item?.kind === 'file').map(item => item.getAsFile?.()).filter((file): file is File => !!file);
}

/** Base64 of bytes, in chunks so a large image does not overflow the call stack. */
export function toBase64(bytes: Uint8Array) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

let counter = 0;

/** Why one more image of `size` bytes (named `name`, of type `mimeType`) cannot join `current`, or null. */
function refusal(current: ReadonlyArray<{ size: number; }>, name: string, mimeType: string | null, size: number, limits = IMAGE_LIMITS) {
  const total = current.reduce((sum, entry) => sum + entry.size, 0);
  return !mimeType ? `${name} is not a PNG, JPEG, GIF or WebP image.`
    : !limits.maxCount || !limits.maxBytes || !limits.maxTotalBytes ? 'This connection takes no images.'
    : current.length >= limits.maxCount ? `A message carries at most ${limits.maxCount} images.`
    : size > limits.maxBytes ? `${name} is ${formatBytes(size)}; an image is at most ${formatBytes(limits.maxBytes)}.`
    : total + size > limits.maxTotalBytes ? `The images of a message are at most ${formatBytes(limits.maxTotalBytes)} together.`
    : null;
}

/**
 * Reads the files that would fit next to `current`: each is read only once it is known to fit.
 * Answers the images read and, when a file was left out, why (the first reason).
 */
export async function readImages(current: ReadonlyArray<ImageAttachment>, files: ArrayLike<{ name?: string; type?: string; size: number; arrayBuffer: () => Promise<ArrayBuffer>; }>, limits = IMAGE_LIMITS): Promise<{ added: ImageAttachment[]; error: string | null; }> {
  const added: ImageAttachment[] = [];
  let error = null;
  for (const file of Array.from(files)) {
    const name = String(file.name || 'image');
    const mimeType = imageType(file);
    const refuse = refusal([...current, ...added], name, mimeType, file.size, limits);
    if (refuse || !mimeType) { error ??= refuse; continue; }
    let data;
    try { data = toBase64(new Uint8Array(await file.arrayBuffer())); }
    catch { error ??= `Could not read ${name}.`; continue; }
    added.push({ id: `image-${++counter}`, type: 'image', mimeType, data, name, size: file.size });
  }
  return { added, error };
}

/**
 * Puts images read earlier next to what is attached now (which may have changed while they were
 * read: sent, removed, or added to by another paste), within the limits again.
 */
export function fitImages(current: ReadonlyArray<ImageAttachment>, added: ReadonlyArray<ImageAttachment>, limits = IMAGE_LIMITS): { attachments: ImageAttachment[]; error: string | null; } {
  const attachments = [...current];
  let error = null;
  for (const image of added) {
    const refuse = refusal(attachments, image.name, image.mimeType, image.size, limits);
    if (refuse) { error ??= refuse; continue; }
    attachments.push(image);
  }
  return { attachments, error };
}

/** Reads `files` and adds those that fit to `current`. */
export async function addImages(current: ReadonlyArray<ImageAttachment>, files: Parameters<typeof readImages>[1], limits = IMAGE_LIMITS) {
  const { added, error } = await readImages(current, files, limits);
  const fitted = fitImages(current, added, limits);
  return { attachments: fitted.attachments, error: error ?? fitted.error };
}

/** The prompt parts of a message: its text (when any), then its images. */
export function promptContent(text: string, images: ImageAttachment[] = []) {
  return [
    ...(text.trim() || !images.length ? [{ type: 'text', text }] : []),
    ...images.map(image => ({ type: 'image', mimeType: image.mimeType, data: image.data, ...(image.name ? { name: image.name.slice(0, 255) } : {}) })),
  ];
}

/** A data URL for an image's preview. */
export const previewUrl = (image: { mimeType: string; data: string; }) => `data:${image.mimeType};base64,${image.data}`;

// ---- files (issue #121 J) ------------------------------------------------------------------
//
// Any other file goes into alpd's attachment store (docs/protocol/alp-json-rpc-v1.md §12.6): the
// browser keeps its bytes until it is uploaded under the message's session, in chunks within the
// limits the gateway's hello names (`attachmentLimits`), then session.prompt names it by its
// opaque id ({ type: 'attachment', attachmentId }). Never a path, never a URL. An upload's
// requestId is derived from the message and the file's place in it (uploadRequestId), so a resend
// or a reconnect continues the same upload and a committed file is not uploaded again.

/** The limits a message's files keep to; all zero when the connection takes none. */
export type FileLimits = { maxObjectBytes: number, maxPerPrompt: number, maxPromptBytes: number, maxChunkBytes: number };
export const NO_FILES: Readonly<FileLimits> = Object.freeze({ maxObjectBytes: 0, maxPerPrompt: 0, maxPromptBytes: 0, maxChunkBytes: 0 });

/**
 * One file attached to a message: its bytes until uploaded, then also its attachment id.
 * `received` counts the bytes the host holds while it uploads; `error` says why it did not.
 * `started`: an upload of it was begun (it may hold one of the host's active-upload slots until
 * committed or aborted). `attempt` counts fresh uploads after the host lost a committed one (its
 * requestId changes with it, uploadRequestId).
 */
export type FileAttachment = { id: string; type: 'file'; name: string; mimeType: string; size: number; data: Uint8Array; attachmentId?: string; received?: number; error?: string; started?: boolean; attempt?: number; };

const LIMIT_KEYS = ['maxObjectBytes', 'maxPerPrompt', 'maxPromptBytes', 'maxChunkBytes'] as const;

/**
 * The file limits of a connection from hello's `attachmentLimits`. Fails closed: without the
 * capability, or with an offer that is missing or malformed, the connection takes no files.
 */
export function fileLimits(offered: unknown, capable: boolean): FileLimits {
  if (!capable || !offered || typeof offered !== 'object' || Array.isArray(offered)) return { ...NO_FILES };
  const value = offered as Record<string, unknown>;
  if (!LIMIT_KEYS.every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)) return { ...NO_FILES };
  const [maxObjectBytes, maxPerPrompt, maxPromptBytes, maxChunkBytes] = LIMIT_KEYS.map(key => (value[key] as number));
  if (!maxPerPrompt || !maxPromptBytes || !maxChunkBytes) return { ...NO_FILES };
  return { maxObjectBytes: Math.min(maxObjectBytes, maxPromptBytes), maxPerPrompt, maxPromptBytes, maxChunkBytes };
}

/** A file's size for its chip: bytes below 1 KB, else as formatBytes. */
export const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : formatBytes(bytes);

/** Whether `limits` take any file at all. */
export const takesFiles = (limits: FileLimits | undefined) => !!limits && limits.maxPerPrompt > 0 && limits.maxPromptBytes > 0 && limits.maxChunkBytes > 0;

/**
 * Why files cannot go with a message to this session, or null when they can: the host stores
 * them (capability `attachments`), the token may upload (`attachments.write` with
 * `session.write`), the connection names limits, and, once the session is known, its runtime
 * reads attachment parts (its snapshot's `promptAttachments`).
 * @param context
 *   known: whether the session exists yet (the New session screen's message has none).
 */
export function fileRefusal({ capable, permitted, writable, limits, session, known = true }: { capable: boolean; permitted: boolean; writable: boolean; limits?: FileLimits; session?: { promptAttachments?: unknown; runtime?: unknown; agent?: unknown; } | null; known?: boolean; }) {
  if (!capable) return 'The host behind this gateway does not store files.';
  if (!writable) return 'Your access token cannot send messages.';
  if (!permitted) return 'Your access token cannot upload files (it needs attachments.write).';
  if (!takesFiles(limits)) return 'This connection takes no files.';
  if (!known) return null;
  const kinds = session?.promptAttachments;
  if (!Array.isArray(kinds) || !kinds.length) {
    const agent = typeof session?.agent === 'string' ? session.agent : 'This agent';
    const runtime = typeof session?.runtime === 'string' ? session.runtime : 'a runtime';
    return `${agent} runs on ${runtime} here, which cannot read attached files.`;
  }
  return null;
}

/**
 * A display name alpd keeps (§12.6): NFC, without control, format or line-separator characters or
 * path separators, trimmed, at most 255 UTF-8 bytes; "file" when nothing is left. Display only:
 * alpd never uses it as a path.
 */
export function fileName(name: unknown) {
  const clean = String(name ?? '').normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}/\\]/gu, '').trim();
  let out = '';
  let bytes = 0;
  for (const char of clean) {
    const size = new TextEncoder().encode(char).length;
    if (bytes + size > 255) break;
    out += char;
    bytes += size;
  }
  return out.trim() || 'file';
}

const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;
/** A file's MIME type as alpd takes it (advisory, lower case), else application/octet-stream. */
export function fileType(file: { type?: string; }) {
  const type = String(file?.type ?? '').split(';', 1)[0].trim().toLowerCase();
  return MIME.test(type) ? type : 'application/octet-stream';
}

/** Why one more file of `size` bytes (named `name`) cannot join `current`, or null. */
function fileLimitRefusal(current: ReadonlyArray<{ size: number; }>, name: string, size: number, limits: FileLimits) {
  const total = current.reduce((sum, entry) => sum + entry.size, 0);
  return !takesFiles(limits) ? 'This connection takes no files.'
    : current.length >= limits.maxPerPrompt ? `A message carries at most ${limits.maxPerPrompt} files.`
    : size > limits.maxObjectBytes ? `${name} is ${formatBytes(size)}; a file is at most ${formatBytes(limits.maxObjectBytes)}.`
    : total + size > limits.maxPromptBytes ? `The files of a message are at most ${formatBytes(limits.maxPromptBytes)} together.`
    : null;
}

let files = 0;

/**
 * Reads the files that would fit next to `current`: each is read only once it is known to fit.
 * Answers the files read and, when one was left out, why (the first reason). A file the browser
 * cannot read (removed, no permission) is left out with its reason; the rest are still read.
 */
export async function readFiles(current: ReadonlyArray<FileAttachment>, picked: ArrayLike<{ name?: string; type?: string; size: number; arrayBuffer: () => Promise<ArrayBuffer>; }>, limits: FileLimits): Promise<{ added: FileAttachment[]; error: string | null; }> {
  const added: FileAttachment[] = [];
  let error = null;
  for (const file of Array.from(picked)) {
    const name = fileName(file.name);
    const refuse = fileLimitRefusal([...current, ...added], name, file.size, limits);
    if (refuse) { error ??= refuse; continue; }
    let data;
    try { data = new Uint8Array(await file.arrayBuffer()); }
    catch { error ??= `Could not read ${name}.`; continue; }
    // The size is what was read: a file that changed since it was picked is sent as it is now.
    added.push({ id: `file-${++files}`, type: 'file', name, mimeType: fileType(file), size: data.length, data });
  }
  return { added, error };
}

/** Puts files read earlier next to what is attached now, within the limits again. */
export function fitFiles(current: ReadonlyArray<FileAttachment>, added: ReadonlyArray<FileAttachment>, limits: FileLimits): { attachments: FileAttachment[]; error: string | null; } {
  const attachments = [...current];
  let error = null;
  for (const file of added) {
    const refuse = fileLimitRefusal(attachments, file.name, file.size, limits);
    if (refuse) { error ??= refuse; continue; }
    attachments.push(file);
  }
  return { attachments, error };
}

/**
 * The upload requestId of a message's file: the message's first clientMessageId (`key`, kept when
 * the message is sent again under a new one) and the file's place in it. The same file of the same
 * message always resumes the same upload, and a committed one answers its attachment again.
 * `attempt` (0 first) is raised only when the host no longer has the committed object (a prompt
 * refused not_found or attachment_unavailable): a fresh upload, under a requestId of its own.
 */
export const uploadRequestId = (key: string, slot: number, attempt: number = 0) => `${key}:file-${slot}${attempt ? `.${attempt}` : ''}`;

/**
 * Aborts, best effort, the upload of `file` begun under `requestId` and not committed, so it does
 * not hold one of the host's active-upload slots until it expires: begin again with the same
 * requestId answers the upload's id (§12.6), then attachment.abort. A committed object is left as
 * it is (alpd collects an unreferenced one). Never throws; answers whether it aborted.
 */
// any: the SDK's attachment API, whose params and answers this function passes through without reading them.
export async function abortUpload(api: { begin: (params: any) => Promise<any>; abort: (uploadId: string) => Promise<any>; }, { sessionId, file, requestId, digest }: { sessionId: string; file: Pick<FileAttachment, 'name' | 'mimeType' | 'data'>; requestId: string; digest: (data: Uint8Array) => Promise<string>; }) {
  try {
    const begun = await api.begin({ sessionId, name: file.name, size: file.data.length, mimeType: file.mimeType, sha256: await digest(file.data), requestId });
    if (begun?.state !== 'uploading' || typeof begun.uploadId !== 'string') return false;
    await api.abort(begun.uploadId);
    return true;
  } catch {
    return false;
  }
}

/**
 * The prompt parts of a message: its text (when any), then its images inline, then its files by
 * attachment id (each must be uploaded first).
 */
export function messageContent(text: string, images: ImageAttachment[] = [], attached: ReadonlyArray<{ attachmentId?: string; }> = []) {
  const parts = promptContent(text, images);
  if (!attached.length) return parts;
  if (attached.some(file => typeof file.attachmentId !== 'string')) throw new Error('A file of this message is not uploaded yet.');
  return [
    ...(text.trim() ? [{ type: 'text', text }] : []),
    ...images.map(image => ({ type: 'image', mimeType: image.mimeType, data: image.data, ...(image.name ? { name: image.name.slice(0, 255) } : {}) })),
    ...attached.map(file => ({ type: 'attachment', attachmentId: file.attachmentId as string })),
  ];
}

/**
 * The files a sent user message lists (timeline item `attachments`): names and sizes for display,
 * nothing else (never a path). Entries that are not well formed are left out.
 */
export function messageFiles(value: unknown): Array<{ attachmentId: string; name: string; size: number; }> {
  if (!Array.isArray(value)) return [];
  return value.filter(entry => entry && typeof entry === 'object' && typeof entry.attachmentId === 'string' && typeof entry.name === 'string' && Number.isSafeInteger(entry.size) && entry.size >= 0)
    .map(entry => ({ attachmentId: entry.attachmentId, name: entry.name, size: entry.size }));
}
