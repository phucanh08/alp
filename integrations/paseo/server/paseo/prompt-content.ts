import type { UploadedFile } from '../upload-names.js';

/** Inline images remain inline; uploaded files are resolved by the socket-owned staging store
 * before an agent is created or a message interrupts a turn. Other context kinds are refused. */
export type PaseoImage = { data?: unknown; mimeType?: unknown };
export type PaseoAttachment = { type?: unknown; fileName?: unknown };
const KINDS: Record<string, string> = {
  forge_change_request: 'change requests', github_pr: 'pull requests', forge_issue: 'issues', github_issue: 'issues',
  text: 'text context', review: 'review comments',
};

/** Why a message with these attachments cannot be sent, or undefined when it has none. */
export function attachmentRefusal(attachments: unknown): string | undefined {
  if (attachments === undefined || attachments === null) return undefined;
  if (!Array.isArray(attachments)) return 'The attachments of this message are not a list; nothing was sent';
  if (attachments.length === 0) return undefined;

  const kinds = [...new Set((attachments as PaseoAttachment[]).filter(attachment => attachment?.type !== 'uploaded_file').map(attachment => KINDS[String(attachment?.type)] ?? 'attachments of this kind'))];
  const reasons = kinds;
  if (!reasons.length) return undefined;
  return `ALP cannot send ${reasons.join(' or ')} attached in this app yet; nothing was sent. Send the message without them.`;
}

export type MessagePart = { type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string } | (UploadedFile & { type: 'uploaded_file' });

/**
 * session.prompt content of a message; throws (nothing is sent) when it carries unsupported context, or
 * images that are not a list of inline base64 data with their type.
 */
export function messageContent(text: string | undefined, images: unknown, attachments: unknown) {
  const refusal = attachmentRefusal(attachments);
  if (refusal) throw new Error(refusal);
  if (images !== undefined && images !== null && !Array.isArray(images)) throw new Error('The images of this message are not a list; nothing was sent');
  const parts: MessagePart[] = [];
  if (text !== undefined && (text.trim() || !Array.isArray(images) || images.length === 0)) parts.push({ type: 'text', text });
  for (const image of Array.isArray(images) ? images as PaseoImage[] : []) {
    if (typeof image?.data !== 'string' || typeof image?.mimeType !== 'string') throw new Error('An image of this message is not inline base64 with its type; nothing was sent');
    parts.push({ type: 'image', mimeType: image.mimeType, data: image.data });
  }
  for (const file of Array.isArray(attachments) ? attachments : []) parts.push(file);
  return parts;
}

/**
 * The content of a new agent's first message (create_agent_request, a new workspace's agent), or
 * undefined when it has none: its trimmed prompt, then its images. Built before the agent or its
 * workspace is made, so what the facade can tell is wrong (unsupported context, malformed images) is
 * refused before anything exists; alpd's own refusal of the prompt comes only after.
 */
export function firstMessage(prompt: string | undefined, images: unknown, attachments: unknown): MessagePart[] | undefined {
  const text = prompt?.trim() || undefined;
  const content = messageContent(text, images, attachments);
  return content.length ? content : undefined;
}
