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

/**
 * Paseo's favicon status from the sessions' buckets: any running wins, then any waiting.
 * @param {Array<'running' | 'needs_input' | 'failed' | 'done'>} buckets @returns {FaviconStatus}
 */
export function faviconStatus(buckets) {
  if (buckets.includes('running')) return 'running';
  if (buckets.includes('needs_input')) return 'attention';
  return 'none';
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
