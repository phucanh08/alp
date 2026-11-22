// @ts-check
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

/** Whether this page runs in ALP.app's dashboard window. @param {string | undefined} [userAgent] */
export function isDesktopApp(userAgent = typeof navigator === 'undefined' ? undefined : navigator.userAgent) {
  return typeof userAgent === 'string' && userAgent.includes(DESKTOP_MARKER);
}

/** Whether a Browser tab may show `value`: http, https or about:blank. @param {unknown} value */
export function isBrowsableUrl(value) {
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
 * @param {string} text @returns {{ url: string } | { error: string }}
 */
export function readAddress(text) {
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

/** A tab's label: the page's host, else "Browser". @param {string | undefined} value */
export function browserLabel(value) {
  try {
    const url = new URL(String(value));
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host ? url.host : 'Browser';
  } catch { return 'Browser'; }
}

/**
 * Saved Browser tabs, checked: ids like `b1`, http/https/about:blank addresses of bounded length,
 * at most MAX_BROWSERS, no id twice. Anything else is dropped.
 * @param {unknown} value @returns {Array<{ id: string, url: string }>}
 */
export function parseBrowsers(value) {
  if (!Array.isArray(value)) return [];
  /** @type {Array<{ id: string, url: string }>} */
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    if (out.length >= MAX_BROWSERS) break;
    if (!entry || typeof entry !== 'object') continue;
    const { id, url } = /** @type {Record<string, unknown>} */ (entry);
    if (typeof id !== 'string' || !/^b\d{1,6}$/.test(id) || seen.has(id) || !isBrowsableUrl(url)) continue;
    seen.add(id);
    out.push({ id, url: /** @type {string} */ (url) });
  }
  return out;
}

/** A Browser tab id not in `taken`. @param {Iterable<string>} taken */
export function nextBrowserId(taken) {
  const used = new Set(taken);
  let n = 1;
  while (used.has(`b${n}`)) n += 1;
  return `b${n}`;
}
