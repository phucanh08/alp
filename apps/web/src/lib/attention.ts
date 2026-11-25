/**
 * What the page shows of the workspace's sessions outside itself, as Paseo's web app does:
 * the favicon's status (hooks/use-favicon-status.ts: running first, then attention, else none),
 * the window title (the open tab's label) and a browser notification when a session starts
 * waiting for the user's answer (utils/os-notifications.ts, contexts/session-context.tsx).
 */

export type FaviconStatus = 'running' | 'attention' | 'none';

export const FAVICONS = { none: '/favicon.svg', running: '/favicon-running.svg', attention: '/favicon-attention.svg' } as const;
const BODY_CHARS = 220;

export type Bucket = 'running' | 'needs_input' | 'failed' | 'attention' | 'done';

/**
 * Paseo's status bucket of a session row (protocol/agent-state-bucket.ts deriveAgentStateBucket):
 * waiting for an answer, then failed (the session's error status or a turn that failed unseen),
 * then running, then finished unseen ('attention', Paseo's green dot), else done.
 */
export function sessionBucket({ status, waiting = false, reason }: { status?: string; waiting?: boolean; reason?: 'finished' | 'error'; }): Bucket {
  if (waiting) return 'needs_input';
  if (status === 'error' || reason === 'error') return 'failed';
  if (status === 'running' || status === 'initializing') return 'running';
  if (reason === 'finished') return 'attention';
  return 'done';
}

/**
 * Paseo's favicon status (hooks/use-favicon-status.ts): any session running wins, then any that
 * asks for the user (a question, or a turn that finished or failed unseen), else none.
 * @param attention some root has a finished or error attention
 */
export function faviconStatus(buckets: Bucket[], attention: boolean = false): FaviconStatus {
  if (buckets.includes('running')) return 'running';
  if (attention || buckets.includes('needs_input') || buckets.includes('attention')) return 'attention';
  return 'none';
}

/**
 * Paseo's attention notification (protocol/agent-attention-notification.ts) for a root whose turn
 * ended unseen: "Agent finished" / "Finished working.", "Agent needs attention" / "Encountered an
 * error." (or the turn's error message), one per root and reason.
 */
export function turnNotification({ root, name, reason, message }: { root: string; name: string; reason: 'finished' | 'error'; message?: string; }) {
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
 */
export function newlyEnded(before: Record<string, { at: number; }>, now: Record<string, { at: number; }>): string[] {
  return Object.entries(now).filter(([id, entry]) => entry.at !== before[id]?.at).map(([id]) => id);
}

/** Markdown marks out, whitespace folded, cut to Paseo's 220 characters with "...". */
export function notificationBody(text: string) {
  const plain = text.replace(/```[\s\S]*?```/g, ' ').replace(/[`*_>#~[\]]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > BODY_CHARS ? `${plain.slice(0, BODY_CHARS - 3).trimEnd()}...` : plain;
}

/**
 * The sessions that started waiting since the last look: ids in `now` with more questions than
 * in `before` (a session asked again after an answer counts again).
 */
export function newlyWaiting(before: Record<string, number>, now: Record<string, number>): string[] {
  return Object.entries(now).filter(([id, count]) => count > 0 && count > (before[id] ?? 0)).map(([id]) => id);
}

/**
 * Whether the user sees the session already: Paseo stays quiet when the window is visible and
 * focused and the agent is the one in front.
 */
export const userSees = (page: { visible: boolean; focused: boolean; shown: string | null; }, id: string) => page.visible && page.focused && page.shown === id;
