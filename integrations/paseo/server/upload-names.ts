import { createHash } from 'node:crypto';

/** Paseo's `uploaded_file` prompt part (ProviderContent, UploadedFileAttachmentSchema). */
export type UploadedFile = { type?: 'uploaded_file'; id: string; fileName: string; mimeType: string; size: number; path: string };

/**
 * A file's name as messages show it: its last path segment, without control or format characters,
 * at most 120 characters. Paseo sanitizes the names it stores, but a client writes the prompt part,
 * so a name that is a path is cut to its last segment and no message ever carries a host path.
 */
export function displayName(fileName: unknown) {
  const last = typeof fileName === 'string' ? fileName.split(/[\\/]/).filter(Boolean).pop() ?? '' : '';
  const clean = last.normalize('NFC').replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').trim();
  const shown = [...clean].slice(0, 120).join('');
  return shown ? `"${shown}"` : 'the uploaded file';
}

/** The name alpd stores (it removes what it does not keep, §12.6): the display name's text. */
export function storedName(fileName: unknown) {
  const shown = displayName(fileName);
  return shown.startsWith('"') ? shown.slice(1, -1) : 'upload';
}

/** alpd's mimeType grammar (attachment.begin); anything else is stored as octet-stream (advisory either way). */
const MIME = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
export function mimeOf(mimeType: unknown) {
  const bare = typeof mimeType === 'string' ? mimeType.split(';')[0]!.trim().toLowerCase() : '';
  return MIME.test(bare) ? bare : 'application/octet-stream';
}

/**
 * The attachment.begin requestId of the `index`-th part of a prompt: the same prompt (same alpd
 * session and clientMessageId) sent again, after a retry or a reconnect, resumes or answers the same
 * upload and object (§12.6), so one immutable ALP object stands for it. Hashed to fit 200 characters.
 */
export function uploadRequestId(sessionId: string, clientMessageId: string, index: number) {
  const digest = createHash('sha256').update(`${sessionId}\n${clientMessageId}`).digest('hex').slice(0, 40);
  return `paseo-upload:${digest}:${index}`;
}
