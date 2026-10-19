// @ts-check
/**
 * Images attached to a message (t-7679.11), as Paseo's composer takes them (paste, drop, the
 * attach button; a preview each, with Remove), but sent inline: the browser reads the file and
 * the prompt carries its base64, never a path on either machine. The limits are the gateway's
 * (apps/gateway/src/policy.js GATEWAY_PROMPT_IMAGES), so a refusal shows here before sending.
 */

/** The types the host takes (protocol PROMPT_IMAGES.mimeTypes). */
export const IMAGE_TYPES = Object.freeze(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** At most so many images, each of at most maxBytes, maxTotalBytes together.
 * @type {Readonly<{ maxCount: number, maxBytes: number, maxTotalBytes: number }>} */
export const IMAGE_LIMITS = Object.freeze({ maxCount: 4, maxBytes: 2 * 1024 * 1024, maxTotalBytes: 2.5 * 1024 * 1024 });

/** Effective limits from hello; old peers use the compatible defaults, malformed offers fail closed.
 * @param {unknown} offered @param {boolean} [capable]
 */
export function imageLimits(offered, capable = true) {
  const none = { maxCount: 0, maxBytes: 0, maxTotalBytes: 0 };
  if (!capable) return none;
  if (offered === undefined) return { ...IMAGE_LIMITS };
  if (!offered || typeof offered !== 'object' || Array.isArray(offered)) return none;
  const value = /** @type {Record<string, unknown>} */ (offered);
  if (!['maxCount', 'maxBytes', 'maxTotalBytes'].every(key => Number.isSafeInteger(value[key]) && /** @type {number} */ (value[key]) >= 0)) return none;
  const maxTotalBytes = Math.min(IMAGE_LIMITS.maxTotalBytes, /** @type {number} */ (value.maxTotalBytes));
  return { maxCount: Math.min(IMAGE_LIMITS.maxCount, /** @type {number} */ (value.maxCount)), maxBytes: Math.min(IMAGE_LIMITS.maxBytes, maxTotalBytes, /** @type {number} */ (value.maxBytes)), maxTotalBytes };
}

/**
 * One attached image: what session.prompt carries, plus its size for the limits.
 * @typedef {{ id: string, type: 'image', mimeType: string, data: string, name: string, size: number }} ImageAttachment
 */

/** @param {number} bytes */
export const formatBytes = bytes => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** The type of a file the host takes, by its MIME type (image/jpg as image/jpeg), else null. @param {{ type?: string }} file */
export function imageType(file) {
  const type = String(file?.type ?? '').split(';', 1)[0].trim().toLowerCase();
  const normal = type === 'image/jpg' ? 'image/jpeg' : type;
  return IMAGE_TYPES.includes(normal) ? normal : null;
}

/** The files of a paste or a drop. @param {{ files?: ArrayLike<File> | null, items?: ArrayLike<{ kind?: string, getAsFile?: () => File | null }> | null } | null | undefined} transfer @returns {File[]} */
export function filesOf(transfer) {
  if (!transfer) return [];
  const files = Array.from(transfer.files ?? []);
  if (files.length) return files;
  return Array.from(transfer.items ?? []).filter(item => item?.kind === 'file').map(item => item.getAsFile?.()).filter(/** @returns {file is File} */ file => !!file);
}

/** Base64 of bytes, in chunks so a large image does not overflow the call stack. @param {Uint8Array} bytes */
export function toBase64(bytes) {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

let counter = 0;

/**
 * Why one more image of `size` bytes (named `name`, of type `mimeType`) cannot join `current`, or null.
 * @param {ReadonlyArray<{ size: number }>} current @param {string} name @param {string | null} mimeType @param {number} size
 */
function refusal(current, name, mimeType, size, limits = IMAGE_LIMITS) {
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
 * @param {ReadonlyArray<ImageAttachment>} current
 * @param {ArrayLike<{ name?: string, type?: string, size: number, arrayBuffer: () => Promise<ArrayBuffer> }>} files
 * @returns {Promise<{ added: ImageAttachment[], error: string | null }>}
 */
export async function readImages(current, files, limits = IMAGE_LIMITS) {
  /** @type {ImageAttachment[]} */
  const added = [];
  let error = null;
  for (const file of Array.from(files)) {
    const name = String(file.name || 'image');
    const mimeType = imageType(file);
    const refuse = refusal([...current, ...added], name, mimeType, file.size, limits);
    if (refuse || !mimeType) { error ??= refuse; continue; }
    const data = toBase64(new Uint8Array(await file.arrayBuffer()));
    added.push({ id: `image-${++counter}`, type: 'image', mimeType, data, name, size: file.size });
  }
  return { added, error };
}

/**
 * Puts images read earlier next to what is attached now (which may have changed while they were
 * read: sent, removed, or added to by another paste), within the limits again.
 * @param {ReadonlyArray<ImageAttachment>} current @param {ReadonlyArray<ImageAttachment>} added
 * @returns {{ attachments: ImageAttachment[], error: string | null }}
 */
export function fitImages(current, added, limits = IMAGE_LIMITS) {
  const attachments = [...current];
  let error = null;
  for (const image of added) {
    const refuse = refusal(attachments, image.name, image.mimeType, image.size, limits);
    if (refuse) { error ??= refuse; continue; }
    attachments.push(image);
  }
  return { attachments, error };
}

/** Reads `files` and adds those that fit to `current`. @param {ReadonlyArray<ImageAttachment>} current @param {Parameters<typeof readImages>[1]} files */
export async function addImages(current, files, limits = IMAGE_LIMITS) {
  const { added, error } = await readImages(current, files, limits);
  const fitted = fitImages(current, added, limits);
  return { attachments: fitted.attachments, error: error ?? fitted.error };
}

/** The prompt parts of a message: its text (when any), then its images. @param {string} text @param {ImageAttachment[]} [images] */
export function promptContent(text, images = []) {
  return [
    ...(text.trim() || !images.length ? [{ type: 'text', text }] : []),
    ...images.map(image => ({ type: 'image', mimeType: image.mimeType, data: image.data, ...(image.name ? { name: image.name.slice(0, 255) } : {}) })),
  ];
}

/** A data URL for an image's preview. @param {{ mimeType: string, data: string }} image */
export const previewUrl = image => `data:${image.mimeType};base64,${image.data}`;
