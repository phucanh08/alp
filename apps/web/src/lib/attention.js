// @ts-check
/**
 * What the page shows of the workspace's sessions outside itself, as Paseo's web app does:
 * the favicon's status (hooks/use-favicon-status.ts: running first, then attention, else none),
 * the window title (the open tab's label) and a browser notification when a session starts
 * waiting for the user's answer (utils/os-notifications.ts, contexts/session-context.tsx).
 */

/** @typedef {'running' | 'attention' | 'none'} FaviconStatus */

export const FAVICONS = /** @type {const} */ ({ none: '/favicon.svg', running: '/favicon-running.svg', attention: '/favicon-attention.svg' });
const BODY_CHARS = 220;

/** @typedef {'running' | 'needs_input' | 'failed' | 'attention' | 'done'} Bucket */

/**
 * Paseo's status bucket of a session row (protocol/agent-state-bucket.ts deriveAgentStateBucket):
 * waiting for an answer, then failed (the session's error status or a turn that failed unseen),
 * then running, then finished unseen ('attention', Paseo's green dot), else done.
 * @param {{ status?: string, waiting?: boolean, reason?: 'finished' | 'error' }} input @returns {Bucket}
 */
export function sessionBucket({ status, waiting = false, reason }) {
  if (waiting) return 'needs_input';
  if (status === 'error' || reason === 'error') return 'failed';
  if (status === 'running' || status === 'initializing') return 'running';
  if (reason === 'finished') return 'attention';
  return 'done';
}

/**
 * Paseo's favicon status (hooks/use-favicon-status.ts): any session running wins, then any that
 * asks for the user (a question, or a turn that finished or failed unseen), else none.
 * @param {Bucket[]} buckets @param {boolean} [attention] some root has a finished or error attention
 * @returns {FaviconStatus}
 */
export function faviconStatus(buckets, attention = false) {
  if (buckets.includes('running')) return 'running';
  if (attention || buckets.includes('needs_input') || buckets.includes('attention')) return 'attention';
  return 'none';
}

/**
 * Paseo's attention notification (protocol/agent-attention-notification.ts) for a root whose turn
 * ended unseen: "Agent finished" / "Finished working.", "Agent needs attention" / "Encountered an
 * error." (or the turn's error message), one per root and reason.
 * @param {{ root: string, name: string, reason: 'finished' | 'error', message?: string }} input
 */
export function turnNotification({ root, name, reason, message }) {
  const detail = reason === 'error' ? (message ? notificationBody(message) : '') || 'Encountered an error.' : 'Finished working.';
  return {
    title: reason === 'finished' ? 'Agent finished' : 'Agent needs attention',
    body: `${name}: ${detail}`,
    tag: `alp-${reason}-${root}`,
  };
}

/**
 * The turn attentions that are new since the last look: roots whose entry was not there or ended
 * again (a later `at`).
 * @param {Record<string, { at: number }>} before @param {Record<string, { at: number }>} now @returns {string[]}
 */
export function newlyEnded(before, now) {
  return Object.entries(now).filter(([id, entry]) => entry.at !== before[id]?.at).map(([id]) => id);
}

/** Markdown marks out, whitespace folded, cut to Paseo's 220 characters with "...". @param {string} text */
export function notificationBody(text) {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/[`*_>#~[\]]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > BODY_CHARS ? `${plain.slice(0, BODY_CHARS - 3).trimEnd()}...` : plain;
}

/**
 * The sessions that started waiting since the last look: ids in `now` with more questions than
 * in `before` (a session asked again after an answer counts again).
 * @param {Record<string, number>} before @param {Record<string, number>} now @returns {string[]}
 */
export function newlyWaiting(before, now) {
  return Object.entries(now).filter(([id, count]) => count > 0 && count > (before[id] ?? 0)).map(([id]) => id);
}

/**
 * Whether the user sees the session already: Paseo stays quiet when the window is visible and
 * focused and the agent is the one in front.
 * @param {{ visible: boolean, focused: boolean, shown: string | null }} page @param {string} id
 */
export const userSees = (page, id) => page.visible && page.focused && page.shown === id;
