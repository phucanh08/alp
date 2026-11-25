/**
 * The Browser tab's addresses (t-9116; docs/alp/desktop.md, Browser tab). The tab exists only in
 * ALP.app: the desktop shell adds DESKTOP_MARKER to the dashboard window's user agent. The marker
 * says where the page runs; it grants nothing. What a Browser tab may load is enforced by the
 * desktop's main process (apps/desktop/src/browser.ts), not here.
 *
 * Typed addresses are read as Paseo's normalizeBrowserUrl reads them (packages/app/src/desktop/
 * browser/store/state.ts): a local host (localhost, an IPv4 address, a bracketed IPv6 address,
 * with or without a port) gets http://, a scheme is kept, anything else gets https://. There is
 * no search engine. The result must then be an http or https URL, or about:blank.
 */

/** The user agent token ALP.app's dashboard window carries (apps/desktop/src/browser.ts). */
export const DESKTOP_MARKER = 'ALPDesktop/1';
/** What a new Browser tab shows until an address is typed (Paseo's opens https://example.com). */
export const BLANK_URL = 'about:blank';
/** The most Browser tabs one workspace keeps, and the longest address kept. */
export const MAX_BROWSERS = 20;
export const MAX_URL_CHARS = 2048;
/** The event ALP.app's main process dispatches when a page in a Browser tab opens a new window. */
export const OPEN_EVENT = 'alp-desktop:browser-open';
/**
 * The event ALP.app's main process dispatches when it stops a page's own navigation (a link, a
 * redirect, a location change) to an address a Browser tab may not show: `{ guest, url }`.
 */
export const BLOCKED_EVENT = 'alp-desktop:browser-blocked';
/** The longest address a blocked-navigation notice shows. */
export const MAX_NOTICE_URL_CHARS = 200;

/**
 * The text a Browser tab shows for a blocked navigation: the address as plain text, without control
 * characters and cut to MAX_NOTICE_URL_CHARS.
 */
export function blockedNotice(url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  // eslint-disable-next-line no-control-regex
  const clean = url.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '');
  if (!clean) return null;
  const shown = clean.length > MAX_NOTICE_URL_CHARS ? `${clean.slice(0, MAX_NOTICE_URL_CHARS)}…` : clean;
  return `Blocked navigation to ${shown}`;
}

/** Whether this page runs in ALP.app's dashboard window. */
export function isDesktopApp(userAgent: string | undefined = typeof navigator === 'undefined' ? undefined : navigator.userAgent) {
  return typeof userAgent === 'string' && userAgent.includes(DESKTOP_MARKER);
}

/** Whether a Browser tab may show `value`: http, https or about:blank. */
export function isBrowsableUrl(value: unknown) {
  if (typeof value !== 'string' || !value || value.length > MAX_URL_CHARS) return false;
  try {
    const url = new URL(value);
    return url.href === BLANK_URL || ((url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname);
  } catch { return false; }
}

const LOCAL = /^(localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-fA-F:.]+])(?::\d+)?(?:[/?#]|$)/i;
const SCHEME = /^[a-zA-Z][a-zA-Z\d+.-]*:/;

/**
 * What the address bar's text opens: `{ url }` (normalised, as the URL parser writes it) or
 * `{ error }` saying why not.
 */
export function readAddress(text: string): { url: string; } | { error: string; } {
  const trimmed = text.trim();
  if (!trimmed) return { error: 'Type an address.' };
  if (/\s/.test(trimmed)) return { error: 'Type a web address such as example.com; Browser has no search.' };
  const candidate = LOCAL.test(trimmed) ? `http://${trimmed}`
    : SCHEME.test(trimmed) && !/^[^:/]+:\d+(?:[/?#]|$)/.test(trimmed) ? trimmed
      : trimmed.startsWith('//') ? `https:${trimmed}` : `https://${trimmed}`;
  let url;
  try { url = new URL(candidate); } catch { return { error: `"${trimmed}" is not a web address.` }; }
  if (url.href !== BLANK_URL && url.protocol !== 'http:' && url.protocol !== 'https:') return { error: `Browser opens only http and https addresses, not ${url.protocol}` };
  if (!isBrowsableUrl(url.href)) return { error: `"${trimmed}" is not a web address.` };
  return { url: url.href };
}

/** A tab's label: the page's host, else "Browser". */
export function browserLabel(value: string | undefined) {
  try {
    const url = new URL(String(value));
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host ? url.host : 'Browser';
  } catch { return 'Browser'; }
}

/** The page's own origin, when it has one. */
const pageOrigin = () => (typeof location === 'undefined' ? undefined : location.origin);

/**
 * Saved Browser tabs, checked: ids like `b1`, http/https/about:blank addresses of bounded length,
 * at most MAX_BROWSERS, no id twice. Anything else is dropped, and so is a tab showing the dashboard's
 * own origin (`ownOrigin`, the page's location.origin): that address carries the dashboard's token in
 * its fragment, and ALP.app refuses to load it in a guest anyway. Addresses are kept without their
 * #fragment, so no fragment (a token among them) is written to storage. Load and save both pass here
 * (layout.js parseLayout, serializeLayout).
 */
export function parseBrowsers(value: unknown, ownOrigin: string | undefined = pageOrigin()): Array<{ id: string; url: string; }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ id: string; url: string; }> = [];
  const seen = new Set();
  for (const entry of value) {
    if (out.length >= MAX_BROWSERS) break;
    if (!entry || typeof entry !== 'object') continue;
    const { id, url } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !/^b\d{1,6}$/.test(id) || seen.has(id) || !isBrowsableUrl(url)) continue;
    const parsed = new URL(url as string);
    if (ownOrigin && parsed.origin === ownOrigin) continue;
    parsed.hash = '';
    seen.add(id);
    out.push({ id, url: parsed.href });
  }
  return out;
}

/** A Browser tab id not in `taken`. */
export function nextBrowserId(taken: Iterable<string>) {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`b${n}`)) n += 1;
  return `b${n}`;
}
