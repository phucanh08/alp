/**
 * The address `alp dashboard --print` prints (docs/alp/dashboard.md §4.2): `http://127.0.0.1:<port>/#token=alpgw1.…`.
 * It carries the user's web token, so it is kept in memory only: never logged, never written,
 * never passed on a command line. Anything else is refused, so the window only ever opens the
 * user's own loopback alp dashboard.
 */
const ADDRESS = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/#token=alpgw1\.[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/;

export type DashboardAddress = { url: string; origin: string };

/** The address to open, from the output of `alp dashboard --print`, or undefined when it has none. */
export function parseDashboardOutput(stdout: string): DashboardAddress | undefined {
  const lines = String(stdout ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const last = lines.at(-1);
  return last === undefined ? undefined : validateDashboardUrl(last);
}

/** The address and its origin when `text` is exactly an alp dashboard link, else undefined. */
export function validateDashboardUrl(text: string): DashboardAddress | undefined {
  const match = ADDRESS.exec(text);
  if (!match) return undefined;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== match[1]) return undefined;
  const origin = `http://127.0.0.1:${port}`;
  // The URL parser must agree: same origin, nothing hidden in userinfo, path or query.
  let parsed: URL;
  try { parsed = new URL(text); } catch { return undefined; }
  if (parsed.origin !== origin || parsed.pathname !== '/' || parsed.search || parsed.username || parsed.password) return undefined;
  return { url: text, origin };
}
