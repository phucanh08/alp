// @ts-check
/**
 * Settings › Usage's device-local preferences and the pure model its page and the sidebar summary
 * render from (t-9116), as Paseo keeps them (packages/app/src/usage/preferences.ts, pinned.ts,
 * tone.ts, format.ts): how percentages read (used or left), the windows pinned to the sidebar
 * summary, the provider cards turned off, and whether the summary shows at all. One versioned
 * localStorage key, read tolerantly (a bad field falls back to its default on its own; another
 * version or garbage gives the defaults). Whether the host checks usage at all is the host's
 * setting (host.usage.setting.*), never stored here.
 *
 * @typedef {'used' | 'remaining'} DisplayAs
 * @typedef {{ runtime: string, windowId: string }} UsagePin
 * @typedef {{ displayAs: DisplayAs, pins: UsagePin[] | null, cardsOff: string[], inSidebar: boolean }} UsagePrefs
 * @typedef {{ getItem: (key: string) => string | null, setItem: (key: string, value: string) => void }} UsageStorage
 * @typedef {import('./owner-host.js').UsageProvider} UsageProvider
 * @typedef {import('./owner-host.js').UsageWindow} UsageWindow
 * @typedef {{ id: string, label: string, shortLabel: string, usedPercent: number | null, resetsAt: string | null, summary: boolean }} ResolvedWindow
 */

export const USAGE_PREFS_KEY = 'alp-web:usage';
export const USAGE_PREFS_VERSION = 1;
const MAX_PINS = 64;
const MAX_ID = 200;

/** Paseo's defaults: used, the source defaults for pins (null), every card on, the summary shown. @type {Readonly<UsagePrefs>} */
export const DEFAULT_USAGE_PREFS = Object.freeze({ displayAs: 'used', pins: null, cardsOff: [], inSidebar: true });

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value @returns {value is string} */
const isId = value => typeof value === 'string' && value.length > 0 && value.length <= MAX_ID;

/** @param {unknown} value @returns {UsagePin[] | null} */
function parsePins(value) {
  if (!Array.isArray(value)) return null;
  /** @type {UsagePin[]} */
  const pins = [];
  for (const item of value) {
    if (!isRecord(item) || !isId(item.runtime) || !isId(item.windowId)) continue;
    const pin = { runtime: item.runtime, windowId: item.windowId };
    if (!pins.some(existing => samePin(existing, pin))) pins.push(pin);
  }
  return pins.slice(0, MAX_PINS);
}

/** The preferences from what storage holds. Never throws. @param {unknown} raw @returns {UsagePrefs} */
export function parseUsagePrefs(raw) {
  const defaults = () => ({ ...DEFAULT_USAGE_PREFS, cardsOff: [] });
  if (typeof raw !== 'string' || !raw) return defaults();
  let value;
  try { value = JSON.parse(raw); } catch { return defaults(); }
  if (!isRecord(value) || value.v !== USAGE_PREFS_VERSION) return defaults();
  return {
    displayAs: value.displayAs === 'remaining' ? 'remaining' : 'used',
    pins: parsePins(value.pins),
    cardsOff: Array.isArray(value.cardsOff) ? [...new Set(value.cardsOff.filter(isId))].slice(0, MAX_PINS) : [],
    inSidebar: typeof value.inSidebar === 'boolean' ? value.inSidebar : true,
  };
}

/** The stored string: the known fields only, re-validated. @param {UsagePrefs} prefs */
export function serializeUsagePrefs(prefs) {
  const clean = parseUsagePrefs(JSON.stringify({ ...prefs, v: USAGE_PREFS_VERSION }));
  return JSON.stringify({ v: USAGE_PREFS_VERSION, ...clean });
}

/** @param {UsageStorage | undefined} storage @returns {UsagePrefs} */
export function loadUsagePrefs(storage) {
  if (!storage) return parseUsagePrefs(null);
  try { return parseUsagePrefs(storage.getItem(USAGE_PREFS_KEY)); } catch { return parseUsagePrefs(null); }
}

/** Reads, changes and writes in one go; the new preferences, or null when storage refused. @param {UsageStorage | undefined} storage @param {(prefs: UsagePrefs) => UsagePrefs} change */
export function updateUsagePrefs(storage, change) {
  if (!storage) return null;
  try {
    const next = parseUsagePrefs(serializeUsagePrefs(change(loadUsagePrefs(storage))));
    storage.setItem(USAGE_PREFS_KEY, serializeUsagePrefs(next));
    return next;
  } catch { return null; }
}

// ---- Windows -------------------------------------------------------------------------------------

const FIVE_HOUR = /five[ _-]?hour|\b5[ _-]?h(our)?\b/i;
const WEEK = /seven[ _-]?day|\b7[ _-]?day\b|week/i;

/** @param {string} name */
const capitalised = name => { const text = name.replace(/_/g, ' ').trim(); return text ? text[0].toUpperCase() + text.slice(1) : name; };

/**
 * A window as the page shows it. The host's id and label when it sends them (five_hour, weekly,
 * weekly:<slug>; "Session", "Weekly · Fable"); an older host sends only `name`, read loosely.
 * shortLabel is the sidebar's: "5h", "wk", "Fable wk" (Paseo's scope-first short label).
 * @param {UsageWindow} window @returns {ResolvedWindow}
 */
export function resolveWindow(window) {
  const name = typeof window?.name === 'string' ? window.name : '';
  const id = isId(window?.id) ? window.id : name;
  const given = typeof window?.label === 'string' && window.label.trim() ? window.label.trim() : null;
  const period = id === 'five_hour' || FIVE_HOUR.test(id) ? '5h' : id === 'weekly' || id.startsWith('weekly:') || WEEK.test(id) ? 'wk' : null;
  const label = given ?? (id === 'five_hour' ? '5-hour' : id === 'weekly' || id === 'seven_day' ? 'Weekly' : capitalised(name || id));
  const scope = id.includes(':') && given?.includes(' · ') ? given.split(' · ').slice(1).join(' · ') : id.includes(':') ? capitalised(id.slice(id.indexOf(':') + 1)) : null;
  const shortLabel = period ? (scope ? `${scope} ${period}` : period) : label;
  const used = typeof window?.usedPercent === 'number' && Number.isFinite(window.usedPercent) ? window.usedPercent : null;
  return { id, label, shortLabel, usedPercent: used, resetsAt: typeof window?.resetsAt === 'string' ? window.resetsAt : null, summary: /** @type {any} */ (window)?.summary === true };
}

/** @param {UsageProvider} provider */
export const windowsOf = provider => (Array.isArray(provider?.windows) ? provider.windows : []).map(resolveWindow).filter(window => window.id);

/** @param {number} value */
export const clampPct = value => Math.max(0, Math.min(100, value));

/** The share shown: used, or left. @param {{ usedPercent: number | null }} window @param {DisplayAs} displayAs */
export function displayPercent(window, displayAs) {
  if (window.usedPercent === null) return null;
  const used = clampPct(window.usedPercent);
  return displayAs === 'used' ? used : 100 - used;
}

/** "96% left" / "4% used" (Paseo's values.used / values.remaining). @param {number} value @param {DisplayAs} displayAs */
export const formatDisplayPct = (value, displayAs) => `${Math.round(clampPct(value))}% ${displayAs === 'used' ? 'used' : 'left'}`;

/** Paseo's tone.ts: above 90% used danger, from 70% warning. @param {number | null} usedPercent @returns {'default' | 'warning' | 'danger'} */
export function windowTone(usedPercent) {
  if (usedPercent === null) return 'default';
  if (usedPercent > 90) return 'danger';
  if (usedPercent >= 70) return 'warning';
  return 'default';
}

// ---- Pins and cards -------------------------------------------------------------------------------

/** @param {UsagePin} a @param {UsagePin} b */
export const samePin = (a, b) => a.runtime === b.runtime && a.windowId === b.windowId;

/**
 * The pinned windows: the user's selection, or Paseo's source defaults: each provider's windows
 * marked `summary`, else its first unscoped 5-hour and weekly windows, else its first with a percent.
 * @param {UsagePrefs} prefs @param {readonly UsageProvider[]} providers @returns {UsagePin[]}
 */
export function effectivePins(prefs, providers) {
  if (prefs.pins !== null) return prefs.pins;
  /** @type {UsagePin[]} */
  const pins = [];
  for (const provider of providers) {
    const runtime = String(provider?.runtime ?? '');
    if (!runtime) continue;
    const withPercent = windowsOf(provider).filter(window => displayPercent(window, prefs.displayAs) !== null);
    const marked = withPercent.filter(window => window.summary);
    const standard = ['5h', 'wk'].map(short => withPercent.find(window => window.shortLabel === short)).filter(window => !!window);
    const chosen = marked.length ? marked : standard.length ? standard : withPercent.slice(0, 1);
    for (const window of chosen) {
      const pin = { runtime, windowId: window.id };
      if (!pins.some(existing => samePin(existing, pin))) pins.push(pin);
    }
  }
  return pins;
}

/** @param {UsagePrefs} prefs @param {UsagePin} pin @param {readonly UsageProvider[]} providers */
export const isPinned = (prefs, pin, providers) => effectivePins(prefs, providers).some(existing => samePin(existing, pin));

/** The first edit snapshots the defaults shown, then toggles one window (Paseo's toggleUsagePin). @param {UsagePrefs} prefs @param {UsagePin} pin @param {readonly UsageProvider[]} providers @returns {UsagePrefs} */
export function togglePin(prefs, pin, providers) {
  const selected = effectivePins(prefs, providers);
  const pins = selected.some(existing => samePin(existing, pin)) ? selected.filter(existing => !samePin(existing, pin)) : [...selected, { runtime: pin.runtime, windowId: pin.windowId }];
  return { ...prefs, pins };
}

/** @param {UsagePrefs} prefs @param {string} runtime */
export const isCardOn = (prefs, runtime) => !prefs.cardsOff.includes(runtime);

/** @param {UsagePrefs} prefs @param {string} runtime @param {boolean} on @returns {UsagePrefs} */
export function setCardOn(prefs, runtime, on) {
  const others = prefs.cardsOff.filter(id => id !== runtime);
  return { ...prefs, cardsOff: on ? others : [...others, runtime] };
}

/**
 * The sidebar footer's summary (Paseo's resolvePinnedUsage): per provider whose card is on, its
 * pinned windows with a percent, in the report's order; nothing while the summary is off.
 * @param {readonly UsageProvider[]} providers @param {UsagePrefs} prefs
 * @returns {Array<{ runtime: string, windows: Array<{ id: string, label: string, shortLabel: string, percent: number, text: string }> }>}
 */
export function pinnedSummary(providers, prefs) {
  if (!prefs.inSidebar) return [];
  const pins = effectivePins(prefs, providers);
  return providers.flatMap(provider => {
    const runtime = String(provider?.runtime ?? '');
    if (!runtime || !isCardOn(prefs, runtime)) return [];
    const windows = windowsOf(provider).flatMap(window => {
      const percent = displayPercent(window, prefs.displayAs);
      if (percent === null || !pins.some(pin => pin.runtime === runtime && pin.windowId === window.id)) return [];
      return [{ id: window.id, label: window.label, shortLabel: window.shortLabel, percent: Math.round(percent), text: `${Math.round(percent)}%` }];
    });
    return windows.length ? [{ runtime, windows }] : [];
  });
}

// ---- Time --------------------------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Paseo's countdown: "resets in 2d 23h", "resets in 4h 59m", "resets in 37m", "resetting now". @param {string | null | undefined} iso @param {number} [now] */
export function formatResetLabel(iso, now = Date.now()) {
  if (!iso) return null;
  const diff = Date.parse(iso) - now;
  if (!Number.isFinite(diff)) return null;
  if (diff <= 0) return 'resetting now';
  const days = Math.floor(diff / DAY);
  const hours = Math.floor((diff % DAY) / HOUR);
  const minutes = Math.floor((diff % HOUR) / MINUTE);
  /** @param {number} major @param {string} a @param {number} minor @param {string} b */
  const pair = (major, a, minor, b) => minor > 0 ? `${major}${a} ${minor}${b}` : `${major}${a}`;
  const duration = days === 1 && hours === 0 ? '24h' : days > 0 ? pair(days, 'd', hours, 'h') : hours > 0 ? pair(hours, 'h', minutes, 'm') : `${minutes}m`;
  return `resets in ${duration}`;
}

/** @param {Date} a @param {Date} b */
const calendarDays = (a, b) => Math.round((new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime() - new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / DAY);

/**
 * Paseo's exact reset time: a clock time today, "Thu 2:59 PM" within six days, "Thu, Nov 27, 2:59 PM"
 * after; nothing once passed. @param {string | null | undefined} iso @param {number} [now] @param {string} [locale]
 */
export function formatResetTime(iso, now = Date.now(), locale = undefined) {
  if (!iso) return null;
  const at = new Date(iso);
  const diff = at.getTime() - now;
  if (!Number.isFinite(diff) || diff <= 0) return null;
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  const days = calendarDays(new Date(now), at);
  if (days === 0) return time;
  if (days <= 6) return `${at.toLocaleDateString(locale, { weekday: 'short' })} ${time}`;
  return `${at.toLocaleDateString(locale, { weekday: 'short', month: 'short', day: 'numeric' })}, ${time}`;
}

/** A balance's value: "0 left", "12.5 left", "Unlimited", "—". @param {{ remaining?: number | null, unlimited?: boolean }} balance */
export function balanceText(balance) {
  if (balance?.unlimited) return 'Unlimited';
  const remaining = balance?.remaining;
  if (typeof remaining === 'number' && Number.isFinite(remaining)) return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(remaining)} left`;
  return '—';
}
