import type { SessionUsage } from '../events.ts';

/**
 * A provider's usage as daemon.usage answers it (ALPD §58; docs/alp/dashboard.md §4.7). `name` is
 * ALP's own name of a window, kept for `alp usage` and older viewers; `id` and `label` are Paseo's
 * (plugins/claude-usage-source, plugins/codex-usage-source): a stable id and the text the Usage page
 * shows. `planLabel`, `details` and `balances` are Paseo's too. `account` is the signed-in email,
 * and only daemon.usage (owner-only) carries it: never a runtime's orchestrationContext, a log or an
 * error.
 */
export type UsageWindow = { name: string; usedPercent: number | null; resetsAt: string | null; id: string; label: string };
export type UsageDetail = { id: string; label: string; value: string };
export type UsageBalance = { id: 'credits'; label: 'Credits'; remaining: number | null; unlimited: boolean };
export type ProviderUsage = {
  runtime: 'codex' | 'claude';
  available: boolean;
  checkedAt: string;
  plan: string | null;
  planLabel: string | null;
  limited: boolean;
  windows: UsageWindow[];
  details: UsageDetail[];
  balances: UsageBalance[];
  account: { email: string } | null;
};

const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const percent = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : null;
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

/** Paseo's durationWindowName (packages/plugin/src/server/usage.ts): "5-hour", "Weekly", "1-day". */
function durationName(seconds: number): { id: string; label: string } {
  if (seconds === 604800) return { id: 'weekly', label: 'Weekly' };
  const id = seconds === 18000 ? 'five_hour' : `${seconds}s`;
  const units = [[86400, 'day'], [3600, 'hour'], [60, 'minute'], [1, 'second']] as const;
  const unit = units.find(([size]) => seconds % size === 0) ?? units[units.length - 1]!;
  return { id, label: `${seconds / unit[0]}-${unit[1]}` };
}

/** Paseo's normalizeName: the characters a window id may carry. */
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');

/** An id not yet taken in this answer (Paseo's uniqueWindowId): suffixed rather than dropped. */
function unique(candidate: string, taken: Set<string>) {
  let id = candidate;
  for (let suffix = 2; taken.has(id); suffix += 1) id = `${candidate}_${suffix}`;
  taken.add(id);
  return id;
}

/**
 * Codex's windows as Paseo's codex-usage-source names them: the default bucket's by length
 * ("5-hour" five_hour, "Weekly" weekly, else "<n>-<unit>"; a window of no reported length
 * "Primary limit" / "Secondary limit"), another bucket's scoped by its limit id and named after it
 * ("<limitName> · Weekly", id "limit:<limitId>:weekly").
 */
function codexWindows(limits: any[]): UsageWindow[] {
  const taken = new Set<string>();
  const main = limits.some(limit => limit?.main === true);
  return limits.flatMap((limit, limitIndex) => {
    const scoped = main ? limit?.main !== true : limitIndex > 0;
    const scope = text(limit?.id) ?? text(limit?.name) ?? `bucket_${limitIndex + 1}`;
    const scopeLabel = text(limit?.name) ?? text(limit?.model) ?? scope;
    const group = text(limit?.name) ?? text(limit?.model);
    return (Array.isArray(limit?.windows) ? limit.windows : []).filter((window: any) => window && typeof window === 'object').map((window: any, index: number) => {
      const minutes = window.windowMinutes;
      const primary = (window.slot ?? (index === 0 ? 'primary' : 'secondary')) === 'primary';
      const named = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? durationName(minutes * 60)
        : primary ? { id: 'unknown_primary', label: 'Primary limit' } : { id: 'unknown_secondary', label: 'Secondary limit' };
      return {
        name: `${group ? `${group} · ` : ''}${windowName(window, index)}`,
        usedPercent: percent(window.usedPercent),
        resetsAt: resetTime(window.resetsAt),
        id: unique(scoped ? `limit:${encodeURIComponent(scope)}:${named.id}` : named.id, taken),
        label: scoped ? `${scopeLabel} · ${named.label}` : named.label,
      };
    });
  });
}

/** Claude's plan windows Paseo shows, and its legacy per-model keys (seven_day_<model>). */
const CLAUDE_PLAN: Record<string, { id: string; label: string }> = { five_hour: { id: 'five_hour', label: 'Session' }, seven_day: { id: 'weekly', label: 'Weekly' } };
const CLAUDE_LEGACY_MODELS: Record<string, string> = { seven_day_opus: 'Opus', seven_day_sonnet: 'Sonnet', seven_day_omelette: 'Omelette' };

/**
 * Claude's windows as Paseo's claude-usage-source shows them: "Session" and "Weekly", then one
 * "Weekly · <Model>" per model, the legacy seven_day_<model> key and its model_scoped entry
 * reconciled into one window by normalized name (model_scoped wins, a missing number falls back to
 * the legacy one). Other keys (seven_day_oauth_apps, any key ALP does not know) are not shown, as in
 * Paseo; they stay in the runtime's report and the limit watch.
 */
function claudeWindows(usage: any): UsageWindow[] {
  const raw: any[] = (Array.isArray(usage?.windows) ? usage.windows : []).filter((window: any) => window && typeof window === 'object');
  const windows: UsageWindow[] = [];
  for (const key of Object.keys(CLAUDE_PLAN)) {
    const window = raw.find(item => item.name === key);
    if (window) windows.push({ name: windowName(window, 0), usedPercent: percent(window.usedPercent), resetsAt: resetTime(window.resetsAt), ...CLAUDE_PLAN[key]! });
  }
  type Model = { model: string; name: string; usedPercent: number | null; resetsAt: string | null };
  const models: Model[] = raw.filter(window => Object.hasOwn(CLAUDE_LEGACY_MODELS, window.name)).map(window => ({
    model: CLAUDE_LEGACY_MODELS[window.name]!, name: windowName(window, 0), usedPercent: percent(window.usedPercent), resetsAt: resetTime(window.resetsAt),
  }));
  for (const entry of Array.isArray(usage?.models) ? usage.models : []) {
    if (!text(entry?.name)) continue;
    const next = { usedPercent: percent(entry.usedPercent), resetsAt: resetTime(entry.resetsAt) };
    const twin = models.find(model => slug(model.model) === slug(entry.name));
    if (twin) Object.assign(twin, { model: entry.name, usedPercent: next.usedPercent ?? twin.usedPercent, resetsAt: next.resetsAt ?? twin.resetsAt });
    else models.push({ model: entry.name, name: `seven day ${entry.name.toLowerCase()}`, ...next });
  }
  const taken = new Set(windows.map(window => window.id));
  for (const model of models) windows.push({ name: model.name, usedPercent: model.usedPercent, resetsAt: model.resetsAt, id: unique(`weekly:${slug(model.model) || 'model'}`, taken), label: `Weekly · ${model.model}` });
  return windows;
}

/** Every window a report holds, for `limited`: the ones shown and the ones Paseo leaves out alike. */
function allPercents(usage: any, limits: any[]): Array<number | null> {
  const windows: any[] = limits.length ? limits.flatMap(limit => Array.isArray(limit?.windows) ? limit.windows : []) : Array.isArray(usage?.windows) ? usage.windows : [];
  return windows.filter(window => window && typeof window === 'object').map(window => percent(window.usedPercent));
}

/**
 * A runtime's usage report (runtime-context.ts codexUsage / claudeUsage) as daemon.usage answers it,
 * with `account` the email read apart (codexAccount / claudeAccount), or null.
 */
export function providerUsage(runtime: ProviderUsage['runtime'], usage: any, checkedAt = new Date().toISOString(), account: { email: string } | null = null): ProviderUsage {
  const limits: any[] = Array.isArray(usage?.limits) ? usage.limits : [];
  const windows = runtime === 'claude' ? claudeWindows(usage) : codexWindows(limits.length ? limits : [{ main: true, windows: usage?.windows }]);
  const plan = text(usage?.plan) ?? limits.map(limit => text(limit?.plan)).find(Boolean) ?? null;
  const mainPlan = text(limits.find(limit => limit?.main === true)?.plan) ?? plan;
  const credits = usage?.credits;
  const email = text(account?.email);
  return {
    runtime, available: usage?.available === true, checkedAt,
    plan,
    planLabel: runtime === 'claude' ? (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : null) : mainPlan,
    limited: usage?.ordinaryUsageAllowed === false || limits.some(limit => limit?.spendControlReached === true) || allPercents(usage, limits).some(used => used === 100),
    windows,
    details: typeof usage?.extraUsage === 'boolean' ? [{ id: 'extra_usage', label: 'Extra usage', value: usage.extraUsage ? 'Enabled' : 'Disabled' }] : [],
    balances: credits && typeof credits === 'object'
      ? [{ id: 'credits', label: 'Credits', remaining: typeof credits.balance === 'number' && Number.isFinite(credits.balance) ? credits.balance : null, unlimited: credits.unlimited === true }]
      : [],
    account: email ? { email } : null,
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
