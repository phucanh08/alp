// @ts-check
/**
 * Owner handlers for host settings (t-a95b group B fills this: Providers, Terminals, Workspaces,
 * Projects and the other host pages of Settings). Each one also needs its `owner` entry in the
 * `// --- owner: host (group B) ---` block of apps/gateway/src/policy.js, or it is never reachable.
 * A method that alpd answers as it stands needs no handler here: its policy entry lists `params`
 * and the gateway forwards it (daemon.usage does).
 */

/** @type {Readonly<Record<string, import('./index.js').DashboardOwnerHandler>>} */
export const methods = {};
