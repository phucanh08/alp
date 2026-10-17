import type { SessionUsage } from './events.js';

/** Account-free usage data shown in ALP's viewers. */
export type UsageWindow = { name: string; usedPercent: number | null; resetsAt: string | null };
export type ProviderUsage = {
  runtime: 'codex' | 'claude';
  available: boolean;
  checkedAt: string;
  plan: string | null;
  limited: boolean;
  windows: UsageWindow[];
};

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
function resetTime(value: unknown): string | null {
  const ms = typeof value === 'number' ? value * 1000 : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : null;
}
function windowName(window: any, index: number) {
  if (text(window.name)) return window.name.replaceAll('_', ' ');
  const minutes = window.windowMinutes;
  if (typeof minutes === 'number' && minutes > 0) {
    if (minutes % 1440 === 0) return `${minutes / 1440} day window`;
    if (minutes % 60 === 0) return `${minutes / 60} hour window`;
    return `${minutes} minute window`;
  }
  return `Window ${index + 1}`;
}
export function providerUsage(runtime: ProviderUsage['runtime'], usage: any, checkedAt = new Date().toISOString()): ProviderUsage {
  const limits: any[] = Array.isArray(usage?.limits) ? usage.limits : [];
  const windows = (limits.length ? limits.flatMap(limit => (Array.isArray(limit?.windows) ? limit.windows : []).map((window: any) => ({ ...window, group: text(limit.name) ?? text(limit.model) }))) : Array.isArray(usage?.windows) ? usage.windows : [])
    .filter((window: any) => window && typeof window === 'object')
    .map((window: any, index: number) => ({
      name: `${window.group ? `${window.group} · ` : ''}${windowName(window, index)}`,
      usedPercent: typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? Math.min(100, Math.max(0, window.usedPercent)) : null,
      resetsAt: resetTime(window.resetsAt),
    }));
  return {
    runtime, available: usage?.available === true, checkedAt,
    plan: text(usage?.plan) ?? limits.map(limit => text(limit?.plan)).find(Boolean) ?? null,
    limited: usage?.ordinaryUsageAllowed === false || limits.some(limit => limit?.spendControlReached === true) || windows.some((window: UsageWindow) => window.usedPercent === 100),
    windows,
  };
}

const tokens = (value: unknown, least = 0): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) && value >= least ? value : undefined;

/**
 * A session's usage after one token report (ALPD §57), as Paseo's AgentUsage. Every transport
 * reports as Codex's thread/tokenUsage/updated does: `last` the latest model call, of which
 * `totalTokens` is what the context holds now; `modelContextWindow` the window once known;
 * `totalCostUsd` the session's cost where the runtime counts it. The fields a report carries
 * replace the session's; the others are kept, except that the latest response's input, cached and
 * output counts are replaced together. Undefined when the report changes nothing.
 */
export function sessionUsage(previous: SessionUsage | undefined, report: any): SessionUsage | undefined {
  if (!report || typeof report !== 'object') return undefined;
  const last = report.last && typeof report.last === 'object' ? report.last : {};
  const cost = report.totalCostUsd;
  const fields: SessionUsage = {
    contextWindowUsedTokens: tokens(last.totalTokens),
    contextWindowMaxTokens: tokens(report.modelContextWindow, 1),
    inputTokens: tokens(last.inputTokens),
    cachedInputTokens: tokens(last.cachedInputTokens ?? report.cachedInputTokens),
    outputTokens: tokens(last.outputTokens),
    totalCostUsd: typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined,
  };
  const next: SessionUsage = { ...previous };
  // The latest response's counts go together: a report with any of them replaces all three, so a
  // count an earlier response had never sits beside a newer one's.
  if (fields.inputTokens !== undefined || fields.cachedInputTokens !== undefined || fields.outputTokens !== undefined) {
    delete next.inputTokens; delete next.cachedInputTokens; delete next.outputTokens;
  }
  for (const [key, value] of Object.entries(fields) as Array<[keyof SessionUsage, number | undefined]>) if (value !== undefined) next[key] = value;
  const keys = Object.keys(next) as Array<keyof SessionUsage>;
  if (keys.length === Object.keys(previous ?? {}).length && keys.every(key => previous?.[key] === next[key])) return undefined;
  return next;
}
