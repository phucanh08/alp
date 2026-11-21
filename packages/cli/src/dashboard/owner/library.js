// @ts-check
/**
 * Owner handlers for the user's library (t-a95b group C fills this: templates, agents, skills,
 * hooks, MCP servers, editor and metadata pages of Settings). Each one also needs its `owner`
 * entry in the `// --- owner: library (group C) ---` block of apps/gateway/src/policy.js, or it is
 * never reachable.
 */

/** @type {Readonly<Record<string, import('./index.js').DashboardOwnerHandler>>} */
export const methods = {};
