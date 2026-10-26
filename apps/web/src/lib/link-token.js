// @ts-check
/**
 * The token in the address `alp web` opens (docs/alp/web.md §4.2): `http://127.0.0.1:<port>/#token=alpgw1.…`.
 * A fragment never reaches a server, but it stays in the address bar, the history and anything that
 * copies the address. So the page takes the token out of the address at once (history.replaceState)
 * and keeps it in this tab's sessionStorage only, where a reload of the same tab finds it again. It
 * never goes to localStorage, which every tab and every later visit shares. The page connects to its
 * own origin, the alp web service that served it, and only on a loopback address.
 */

/** The sessionStorage key of the link's token. */
export const LINK_TOKEN_KEY = 'alp-web:link-token';

/** A gateway credential's token (apps/gateway/src/credentials.js): `alpgw1.<16 hex>.<43 base64url>`. */
const TOKEN = /^alpgw1\.[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/;

/** What the connect form says when the link's token stopped working (rotated, revoked). */
export const LINK_TOKEN_INVALID = 'This link\'s access token is no longer valid. Run `alp web` again to open ALP with a new link.';
/** What the connect form says when a link was opened on an address that is not this machine. */
export const LINK_NOT_LOOPBACK = 'This page is not on this machine\'s loopback address, so it did not use the access token in its link. Open the address `alp web` printed.';
/** What the connect form says when the link's token is not an ALP web token at all. */
export const LINK_TOKEN_MALFORMED = 'The access token in this link is incomplete or damaged. Run `alp web` again, or copy its whole address.';

/** Loopback host names: the ones lib/gateway.js accepts over http (alp web listens on 127.0.0.1). */
const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

/** Whether `value` has the shape of an `alpgw1.*` token. @param {unknown} value @returns {value is string} */
export const isLinkToken = value => typeof value === 'string' && TOKEN.test(value);

/**
 * The `token` parameter of an address fragment (`#token=…`, other `&`-separated parameters allowed).
 * undefined: the fragment names no token. `{ token }`: a well-formed one. `{ malformed: true }`: a
 * token parameter that is not an alpgw1 token (its text is never returned, so it cannot be shown).
 * @param {string} hash location.hash, with or without its `#`
 * @returns {{ token: string } | { malformed: true } | undefined}
 */
export function parseLinkHash(hash) {
  const body = String(hash ?? '').replace(/^#/, '');
  if (!body) return undefined;
  const params = new URLSearchParams(body);
  if (!params.has('token')) return undefined;
  const token = params.get('token');
  return isLinkToken(token) ? { token } : { malformed: true };
}

/** Whether the page is served from this machine's loopback address. @param {{ protocol: string, hostname: string }} location */
export const isLoopbackPage = location => location.protocol === 'http:' && LOOPBACK.has(location.hostname);

/**
 * @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void, removeItem(key: string): void }} TokenStorage
 * @typedef {{ hash: string, pathname: string, search: string, origin: string, protocol: string, hostname: string }} PageLocation
 * @typedef {{ state: unknown, replaceState(data: unknown, unused: string, url?: string): void }} PageHistory
 * @typedef {{ url: string, token: string } | { error: string } | undefined} LinkStart
 *   What the page does on load: connect to `url` with `token`, show the connect form with `error`,
 *   or (undefined) show the connect form as usual.
 */

/** The token this tab kept, if it is one (anything else there is removed). @param {TokenStorage | undefined} storage */
export function storedLinkToken(storage) {
  let value;
  try { value = storage?.getItem(LINK_TOKEN_KEY); } catch { return undefined; }
  if (value == null) return undefined;
  if (isLinkToken(value)) return value;
  forgetLinkToken(storage);
  return undefined;
}

/** Forgets the token this tab kept. @param {TokenStorage | undefined} storage */
export function forgetLinkToken(storage) {
  try { storage?.removeItem(LINK_TOKEN_KEY); } catch { /* storage may be off */ }
}

/**
 * Runs once when the page loads: takes a `#token=` out of the address (always, whatever it holds),
 * keeps a well-formed one in this tab's sessionStorage, and says what to connect to. Without a
 * token in the address, the one this tab kept from an earlier load is used. A page that is not on
 * loopback never keeps or uses a token from its address.
 * @param {{ location: PageLocation, history: PageHistory, storage: TokenStorage | undefined }} page
 * @returns {LinkStart}
 */
export function takeLinkToken({ location, history, storage }) {
  const link = parseLinkHash(location.hash);
  if (link) {
    // First, before anything can copy the address: the same path and query, no fragment.
    history.replaceState(history.state, '', `${location.pathname}${location.search}`);
  }
  const loopback = isLoopbackPage(location);
  if (link && 'malformed' in link) return { error: LINK_TOKEN_MALFORMED };
  if (link && !loopback) return { error: LINK_NOT_LOOPBACK };
  if (link) {
    try { storage?.setItem(LINK_TOKEN_KEY, link.token); } catch { /* storage may be off: this load still connects */ }
    return { url: location.origin, token: link.token };
  }
  if (!loopback) return undefined;
  const kept = storedLinkToken(storage);
  return kept ? { url: location.origin, token: kept } : undefined;
}

/** The standalone gateway's default address (`alp-gateway serve`), for a page it does not serve. */
export const STANDALONE_GATEWAY = 'http://127.0.0.1:7434';

/**
 * Whether this page is probably the one `alp web` serves: a built app (not Vite's dev server, which
 * sits beside a standalone gateway) on this machine's loopback address. alp web serves the app and
 * its gateway on one listener, so there the page's own origin is the gateway. This is a heuristic
 * from the address alone: anything else that serves the built app on loopback looks the same. The
 * connect form uses it only for its default address, which the user can edit, and its help text.
 * @param {{ location: { protocol: string, hostname: string }, dev?: boolean }} page
 */
export const servedByAlpWeb = ({ location, dev = false }) => !dev && isLoopbackPage(location);

/**
 * The connect form's gateway address before the person types one: the address remembered from an
 * earlier connect on this origin, else this page's origin when alp web serves it, else the
 * standalone gateway's default.
 * @param {{ location: { protocol: string, hostname: string, origin: string }, remembered?: string | null, dev?: boolean }} page
 */
export function defaultGatewayAddress({ location, remembered, dev = false }) {
  if (remembered) return remembered;
  return servedByAlpWeb({ location, dev }) ? location.origin : STANDALONE_GATEWAY;
}
