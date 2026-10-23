import { displayName } from '../upload-names.js';

/**
 * What a Paseo message (send_agent_message_request, create_agent_request, a new workspace's first
 * agent) becomes in session.prompt: its text, then its inline images as ALP image parts, in Paseo's
 * order (buildAgentPrompt: text, then images). alpd checks the images (PROMPT_IMAGES: type, size,
 * count) and whether the session's runtime takes images; its refusal is the message's.
 *
 * Paseo's attachments are refused, never dropped: the facade does not take Paseo's file upload
 * (file.upload.request is answered with an error, see uploadRefused), because Paseo uploads a file
 * before any message names the agent it is for, while alpd binds an upload to its session when it
 * begins (docs/protocol/alp-json-rpc-v1.md §12.6); and the other kinds (issues, change requests,
 * review comments, text context) have no ALP prompt part. A message that carries any is refused
 * whole, so nothing is sent without them.
 */

export type PaseoImage = { data?: unknown; mimeType?: unknown };
export type PaseoAttachment = { type?: unknown; fileName?: unknown };

const KINDS: Record<string, string> = {
  forge_change_request: 'change requests', github_pr: 'pull requests', forge_issue: 'issues', github_issue: 'issues',
  text: 'text context', review: 'review comments',
};

/** Why a message with these attachments cannot be sent, or undefined when it has none. */
export function attachmentRefusal(attachments: unknown): string | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) return undefined;
  const files = (attachments as PaseoAttachment[]).filter(attachment => attachment?.type === 'uploaded_file');
  const kinds = [...new Set((attachments as PaseoAttachment[]).filter(attachment => attachment?.type !== 'uploaded_file').map(attachment => KINDS[String(attachment?.type)] ?? 'attachments of this kind'))];
  const reasons = [
    ...(files.length ? [`files (${files.map(file => displayName(file.fileName)).join(', ')})`] : []),
    ...kinds,
  ];
  return `ALP cannot send ${reasons.join(' or ')} attached in this app yet; nothing was sent. Send the message without them.`;
}

/** The answer to Paseo's file.upload.request: ALP takes no uploads through this connection. */
export const uploadRefused = 'ALP does not take files uploaded through this app yet; nothing was uploaded.';

/** session.prompt content of a message; throws (nothing is sent) when it carries attachments. */
export function messageContent(text: string | undefined, images: unknown, attachments: unknown) {
  const refusal = attachmentRefusal(attachments);
  if (refusal) throw new Error(refusal);
  const parts: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }> = [];
  if (text !== undefined && (text.trim() || !Array.isArray(images) || images.length === 0)) parts.push({ type: 'text', text });
  for (const image of Array.isArray(images) ? images as PaseoImage[] : []) {
    if (typeof image?.data !== 'string' || typeof image?.mimeType !== 'string') throw new Error('An image of this message is not inline base64 with its type; nothing was sent');
    parts.push({ type: 'image', mimeType: image.mimeType, data: image.data });
  }
  return parts;
}
