// @ts-check

/** A random lowercase hex string of `length` characters from the platform's CSPRNG. @param {number} [length] */
export function randomHex(length = 16) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('').slice(0, length);
}

/** A root session id this app chooses, so events that come before session.create answers are known (§8). */
export const newSessionId = () => `web_${randomHex(16)}`;
/** A prompt's idempotency key (§10): one per message the user writes, never reused for other content. */
export const newMessageId = () => `web-msg-${randomHex(20)}`;
/** A task.create dedupe key (§10). */
export const newRequestId = () => `web-task-${randomHex(16)}`;
