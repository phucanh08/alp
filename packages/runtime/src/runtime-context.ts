export const COMPACT_SHARE = 0.9;

/** Bounded optional reads. Never expose account identifiers or credentials. */
export async function optionalRead<T>(read: () => Promise<T>, timeout = 1500): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([Promise.resolve().then(read).catch(() => undefined), new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeout); })]);
  } finally { clearTimeout(timer); }
}

/**
 * Codex's account/rateLimits/read as ALP's usage report: what agents see in their catalog and what
 * alpd's limit watch reads (usageAllows). Never an account identifier; the email is read apart
 * (codexAccount), for daemon.usage only. `id` is the bucket's metered limit id (rateLimitsByLimitId's
 * key), `main` marks the default bucket (rateLimits), `slot` the window's place in it.
 */
export function codexUsage(result: any) {
  if (!result?.rateLimits) return { available: false };
  const mainId = typeof result.rateLimits.limitId === 'string' ? result.rateLimits.limitId : 'codex';
  const clean = (id: string, limit: any, main: boolean) => ({
    id, main,
    name: limit?.limitName ?? null, model: limit?.normalModelSlug ?? null,
    plan: limit?.planType ?? null,
    windows: (['primary', 'secondary'] as const).filter(slot => limit?.[slot]).map(slot => ({
      slot,
      usedPercent: limit[slot].usedPercent,
      remainingPercent: typeof limit[slot].usedPercent === 'number' ? Math.max(0, 100 - limit[slot].usedPercent) : null,
      windowMinutes: limit[slot].windowDurationMins, resetsAt: limit[slot].resetsAt,
    })),
    spendControlReached: limit?.spendControlReached ?? null,
  });
  const credits = result.rateLimits.credits;
  const balance = typeof credits?.balance === 'string' && credits.balance.trim() ? Number(credits.balance) : NaN;
  return { available: true, ordinaryUsageAllowed: result.ordinaryUsageAllowed ?? null,
    limits: Object.entries(result.rateLimitsByLimitId ?? { [mainId]: result.rateLimits }).map(([id, limit]) => clean(id, limit, id === mainId)),
    ...(credits && typeof credits === 'object' ? { credits: { hasCredits: credits.hasCredits === true, unlimited: credits.unlimited === true, balance: Number.isFinite(balance) ? balance : null } } : {}) };
}

/** The ChatGPT login's email from Codex's account/read, or null. For daemon.usage only (owner-only). */
export function codexAccount(result: any): { email: string } | null {
  const email = result?.account?.type === 'chatgpt' ? result.account.email : undefined;
  return typeof email === 'string' && email.trim() ? { email } : null;
}

/** The signed-in Claude account's email from Query.accountInfo(), or null. For daemon.usage only. */
export function claudeAccount(info: any): { email: string } | null {
  const email = info?.email;
  return typeof email === 'string' && email.trim() ? { email } : null;
}

/**
 * Claude's usage answer (SDK get_usage) as ALP's usage report: `windows` every rate_limits key
 * with a utilization (five_hour, seven_day, seven_day_opus, ...) by its key (`name`), as before;
 * `models` the per-model weekly windows of rate_limits.model_scoped
 * (display name only); `extraUsage` whether extra usage is enabled. Extra usage is no window: its
 * utilization is the month's spend against the overage cap, not a plan limit, so it never reads as
 * a limit reached (usageAllows) or as a bar.
 */
export function claudeUsage(result: any) {
  if (!result) return { available: false };
  const limits = result.rate_limits && typeof result.rate_limits === 'object' ? result.rate_limits : {};
  const window = (value: any) => ({ usedPercent: value.utilization,
    remainingPercent: typeof value.utilization === 'number' ? Math.max(0, 100 - value.utilization) : null,
    resetsAt: value.resets_at });
  const models = Array.isArray(limits.model_scoped) ? limits.model_scoped.flatMap((entry: any) =>
    entry && typeof entry.display_name === 'string' && entry.display_name.trim() ? [{ name: entry.display_name.trim(), ...window(entry) }] : []) : [];
  const extra = limits.extra_usage?.is_enabled;
  return { available: result.rate_limits_available === true, plan: result.subscription_type ?? null,
    windows: Object.entries(limits).flatMap(([name, value]: [string, any]) =>
      name !== 'extra_usage' && value && typeof value === 'object' && !Array.isArray(value) && 'utilization' in value ? [{ name, ...window(value) }] : []),
    ...(models.length ? { models } : {}),
    ...(typeof extra === 'boolean' ? { extraUsage: extra } : {}) };
}

/**
 * Whether a runtime's usage report (codexUsage or claudeUsage) lets it work again (ALPD §58):
 * true when every window has room, false on explicit provider denial, a used-up window or spending cap, and
 * undefined when the report says nothing either way. Claude's per-model weekly windows from
 * model_scoped (`models`) are not read, as before t-9116 added them to the report; the legacy
 * seven_day_opus / seven_day_sonnet keys are `windows` and still are.
 */
export function usageAllows(usage: any): boolean | undefined {
  if (!usage?.available) return undefined;
  const limits: any[] = Array.isArray(usage.limits) ? usage.limits : [];
  if (usage.ordinaryUsageAllowed === false || limits.some(limit => limit?.spendControlReached === true)) return false;
  const windows: any[] = limits.length ? limits.flatMap(limit => limit?.windows ?? []) : usage.windows ?? [];
  const known = windows.filter(window => typeof window?.usedPercent === 'number');
  if (!known.length) return undefined;
  return known.every(window => window.usedPercent < 100);
}
