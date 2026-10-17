// @ts-check

/**
 * The context meter's numbers (t-7679.12), as Paseo's composer shows them
 * (packages/app/src/components/context-window-meter.tsx at b63a325): how full the context window
 * is, from the session's latest usage (docs/protocol/alp-json-rpc-v1.md, SessionUsage). Pure
 * functions; the meter renders what they answer.
 *
 * @typedef {import('@anhlp/alp-protocol/events').SessionUsage} SessionUsage
 */

/** @param {unknown} value */
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/**
 * How full the window is, or null while the runtime has not said both how much the context holds
 * and how large the window is (Paseo's "No context data"). `percentage` is shown, rounded; `share`
 * is the exact one, which the ring and its colour use, as Paseo's.
 * @param {SessionUsage | undefined | null} usage
 * @returns {{ percentage: number, share: number, usedTokens: number, maxTokens: number } | null}
 */
export function contextOf(usage) {
  const used = count(usage?.contextWindowUsedTokens);
  const max = count(usage?.contextWindowMaxTokens);
  if (used === null || max === null || max <= 0) return null;
  const share = (used / max) * 100;
  return { percentage: Math.round(share), share, usedTokens: used, maxTokens: max };
}

/** The ring's share, kept within 0–100 (a context past its window fills the ring). @param {number} percentage */
export const ringShare = percentage => Math.max(0, Math.min(100, percentage));

/** Paseo's colours: muted below 70%, amber from 70%, red above 90%. @param {number} percentage @returns {'normal' | 'warning' | 'danger'} */
export function meterLevel(percentage) {
  if (percentage > 90) return 'danger';
  if (percentage >= 70) return 'warning';
  return 'normal';
}

/** Paseo's token count: 950, 54k, 1m. @param {number} value */
export function formatTokenCount(value) {
  if (value >= 1_000_000) return `${Math.round(value / 1_000_000)}m`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return Math.round(value).toString();
}

/** Paseo's session cost: $0.0042 below a cent, $1.23 above; none for no cost. @param {unknown} value */
export function formatSessionCost(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/**
 * The tokens the runtime last reported, e.g. "25k input (20k cached) · 1k output": the latest model
 * response's (an ACP agent's: the latest turn's), or null when the runtime said neither.
 * @param {SessionUsage | undefined | null} usage
 */
export function responseTokens(usage) {
  const input = count(usage?.inputTokens);
  const cached = count(usage?.cachedInputTokens);
  const output = count(usage?.outputTokens);
  const parts = [];
  if (input !== null) parts.push(`${formatTokenCount(input)} input${cached ? ` (${formatTokenCount(cached)} cached)` : ''}`);
  if (output !== null) parts.push(`${formatTokenCount(output)} output`);
  return parts.length ? parts.join(' · ') : null;
}

/** The meter's accessible name, as Paseo's. @param {SessionUsage | undefined | null} usage */
export function meterLabel(usage) {
  const context = contextOf(usage);
  return context ? `Context window ${context.percentage}% used` : 'Context window: No context data';
}
