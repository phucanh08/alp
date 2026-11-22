/**
 * The Browser tab's guards (t-9116, docs/alp/desktop.md §Browser tab). The dashboard window may hold
 * <webview> guests showing web pages; everything that makes that safe is decided here, in the main
 * process, whatever the dashboard page asks for:
 *
 * - an attach is refused unless its partition is BROWSER_PARTITION and its src is http, https or
 *   about:blank; its preferences are replaced by an allowlist (no preload, sandbox, context isolation,
 *   no Node, web security, no devtools, nothing else the page set);
 * - a guest navigates (any frame, redirects included) only to http, https or about:blank, never to the
 *   dashboard itself under any loopback or local-host spelling, and none of its requests reach the
 *   dashboard's port on those hosts;
 * - a guest opens no window: window.open asks the dashboard for a new Browser tab, a few at a time.
 *
 * The functions here are pure so they can be tested without Electron; main.ts wires them.
 */
import os from 'node:os';

/** The guests' own session: never the default one, where the dashboard page lives. */
export const BROWSER_PARTITION = 'persist:alp-browser';
/** The token the dashboard window's user agent carries; apps/web shows Browser only when it sees it. */
export const DESKTOP_MARKER = 'ALPDesktop/1';
/** The DOM event the dashboard page receives for a guest's window.open (apps/web BrowserPanel). */
export const OPEN_EVENT = 'alp-desktop:browser-open';

/** Whether a Browser tab may show `target` as its page: http, https or about:blank. */
export function isBrowsableUrl(target: string | undefined): boolean {
  if (!target) return false;
  try {
    const url = new URL(target);
    return url.href === 'about:blank' || ((url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname);
  } catch { return false; }
}

/** Whether a subframe may show `target`: a browsable page, or about:srcdoc (an iframe's inline document). */
export function isBrowsableFrameUrl(target: string | undefined): boolean {
  return isBrowsableUrl(target) || target === 'about:srcdoc';
}

/**
 * Every spelling of "this machine" a guest could use to reach the dashboard. The URL parser already
 * writes 2130706433, 0x7f.1 and 0177.0.0.1 as 127.0.0.1 and [::ffff:127.0.0.1] as [::ffff:7f00:1].
 */
export function localHosts(hostname = os.hostname(), interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = safeInterfaces()): Set<string> {
  const hosts = new Set(['localhost', '0.0.0.0', '[::]', '[::1]', '[::ffff:7f00:1]', '[::ffff:0:0]']);
  const name = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (name) {
    hosts.add(name);
    const bare = name.endsWith('.local') ? name.slice(0, -'.local'.length) : name;
    if (bare) { hosts.add(bare); hosts.add(`${bare}.local`); }
  }
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) hosts.add(entry.family === 'IPv6' ? `[${entry.address.split('%', 1)[0].toLowerCase()}]` : entry.address);
  }
  return hosts;
}

function safeInterfaces(): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  try { return os.networkInterfaces(); } catch { return {}; }
}

/** What the guard holds: the dashboard's ports (current and earlier in this run) and the local host spellings. */
export type DashboardTarget = { ports: ReadonlySet<number>; hosts: ReadonlySet<string> };

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443, 'ws:': 80, 'wss:': 443 };

/** The port `origin` (http or https) is served on: its explicit port, else the scheme's default. Never 0. */
export function dashboardPort(origin: string): number | undefined {
  let url: URL;
  try { url = new URL(origin); } catch { return undefined; }
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  return port && Number.isInteger(port) && port > 0 ? port : undefined;
}

/**
 * An IPv4-mapped (::ffff:a.b.c.d) or IPv4-compatible (::a.b.c.d) IPv6 host as the IPv4 address it
 * stands for; the URL parser writes both in hex ([::ffff:7f00:1]). Anything else is returned as is.
 */
function embeddedIpv4(host: string): string {
  const hex = /^\[::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/.exec(host);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  const dotted = /^\[::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})\]$/.exec(host);
  return dotted ? dotted[1] : host;
}

/** Whether `target` is the dashboard (or its gateway) under some local spelling: a guest may not go there. */
export function isDashboardUrl(target: string, dashboard: DashboardTarget): boolean {
  let url: URL;
  try { url = new URL(target); } catch { return false; }
  const fallback = DEFAULT_PORTS[url.protocol];
  if (fallback === undefined) return false;
  const port = url.port ? Number(url.port) : fallback;
  if (!dashboard.ports.has(port)) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const ipv4 = embeddedIpv4(host);
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ipv4) || host === 'localhost' || host.endsWith('.localhost')
    || dashboard.hosts.has(host) || dashboard.hosts.has(ipv4);
}

/** will-navigate / will-frame-navigate / will-redirect in a guest: allowed? */
export function isAllowedGuestNavigation(target: string, isMainFrame: boolean, dashboard: DashboardTarget): boolean {
  const browsable = isMainFrame ? isBrowsableUrl(target) : isBrowsableFrameUrl(target);
  return browsable && !isDashboardUrl(target, dashboard);
}

const NEVER = new Set(['file:', 'chrome:', 'chrome-extension:', 'devtools:', 'alp-page:', 'javascript:']);

/** session.webRequest.onBeforeRequest on the guests' partition: does this request go out? */
export function isAllowedGuestRequest(target: string, dashboard: DashboardTarget): boolean {
  let url: URL;
  try { url = new URL(target); } catch { return false; }
  if (NEVER.has(url.protocol)) return false;
  return !isDashboardUrl(target, dashboard);
}

/** The webPreferences and params Electron passes to will-attach-webview (the parts read or changed). */
export type AttachPreferences = Record<string, unknown> & { preload?: string; partition?: string };
export type AttachParams = Record<string, unknown> & { src?: string; partition?: string; preload?: string };

/**
 * The <webview> attributes that feed a guest's preferences (Electron's guest-view-manager reads them
 * into webPreferences before will-attach-webview). They are removed so nothing downstream reads them.
 */
const PREFERENCE_PARAMS = ['webpreferences', 'disablewebsecurity', 'nodeintegration', 'nodeintegrationinsubframes', 'preload', 'preloadURL', 'plugins', 'blinkfeatures', 'enableblinkfeatures', 'disableblinkfeatures'];

/**
 * Prepares a <webview> attach: false (refuse) unless it asks for BROWSER_PARTITION and a browsable
 * src (or none). Its preferences are then an allowlist: every key the page could set (directly, through
 * the webpreferences attribute, or as enableBlinkFeatures, additionalArguments, javascript, …) is
 * dropped and only the values below remain.
 */
export function prepareWebview(webPreferences: AttachPreferences, params: AttachParams): boolean {
  if (params.partition !== BROWSER_PARTITION) return false;
  if (params.src !== undefined && params.src !== '' && !isBrowsableUrl(params.src)) return false;
  const zoomFactor = webPreferences.zoomFactor;
  for (const key of Object.keys(webPreferences)) delete webPreferences[key];
  for (const key of PREFERENCE_PARAMS) delete params[key];
  Object.assign(webPreferences, {
    partition: BROWSER_PARTITION,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    devTools: false,
    plugins: false,
    experimentalFeatures: false,
    enableWebSQL: false,
    // Web pages need scripts; a dialog loop gets Chromium's "prevent more dialogs" box.
    javascript: true,
    safeDialogs: true,
    // window.open must reach the guest's setWindowOpenHandler (main.ts), which denies every window and
    // asks the dashboard for a tab instead; with popups disabled the page would get nothing.
    disablePopups: false,
  });
  // The embedder's zoom, which Electron copies into a guest: a number only, it changes no permission.
  if (typeof zoomFactor === 'number' && Number.isFinite(zoomFactor) && zoomFactor > 0) webPreferences.zoomFactor = zoomFactor;
  return true;
}

/**
 * How many window.open requests from one guest become tabs: at most `limit` in any `windowMs`, so a
 * page looping on window.open cannot flood the dashboard with tabs (Paseo caps pending requests at 20).
 */
export class OpenRequests {
  private readonly seen = new Map<number, number[]>();
  constructor(private readonly limit = 5, private readonly windowMs = 10_000, private readonly now = () => Date.now()) {}

  /** Records a request from `guest`; false when it is over the limit. */
  take(guest: number): boolean {
    const at = this.now();
    const recent = (this.seen.get(guest) ?? []).filter(time => at - time < this.windowMs);
    if (recent.length >= this.limit) { this.seen.set(guest, recent); return false; }
    recent.push(at);
    this.seen.set(guest, recent);
    return true;
  }

  forget(guest: number) { this.seen.delete(guest); }
}

/** The script that hands a guest's window.open to the dashboard page: data only, as JSON. */
export function openEventScript(guest: number, url: string): string {
  const detail = JSON.stringify({ guest, url });
  return `window.dispatchEvent(new CustomEvent(${JSON.stringify(OPEN_EVENT)}, { detail: ${detail} })); undefined;`;
}

/** The dashboard window's user agent: Chromium's, with DESKTOP_MARKER once. */
export function markUserAgent(userAgent: string): string {
  return userAgent.includes(DESKTOP_MARKER) ? userAgent : `${userAgent} ${DESKTOP_MARKER}`;
}
