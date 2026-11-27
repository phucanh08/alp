import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { ATTACHMENTS, attachmentChunkBytes } from '@anhlp/alp-protocol';
import type { AttachmentLimits } from '@anhlp/alp-protocol/rpc';

export type AttachmentLimitsInput = Partial<AttachmentLimits>;

export const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
export const OPEN_READ = constants.O_RDONLY | NOFOLLOW;

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
