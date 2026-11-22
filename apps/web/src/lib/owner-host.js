// @ts-check
import { HIDDEN } from './library.js';

/**
 * The host owner's requests of Settings' host pages (t-a95b.1 group B; docs/alp/dashboard.md §4.7),
 * on controller.ownerRequest: refused in the page when the connection is not the owner's, and by
 * the gateway in any case. Plus the pure helpers those pages render with (usage windows, the
 * provider confirm step). Usage's page and its preferences are in app/settings/usage and
 * lib/usage-prefs.js (Paseo's packages/app/src/usage).
 *
 * @typedef {{ ownerRequest: (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<any> }} OwnerController
 * @typedef {{ name: string, usedPercent: number | null, resetsAt: string | null, id?: string, label?: string, summary?: boolean }} UsageWindow
 * @typedef {{ runtime: string, available: boolean, checkedAt: string, plan: string | null, limited: boolean, windows: UsageWindow[], pause: { reason: string, since: string, resetsAt?: string } | null, parked: number,
 *   planLabel?: string | null, details?: Array<{ id: string, label: string, value: string }>, balances?: Array<{ id: string, label: string, remaining: number | null, unlimited: boolean }>, account?: { email?: string } | null }} UsageProvider
 * @typedef {{ enabled: boolean, host: string }} UsageSetting
 * @typedef {{ id: string, projectId: string, directory: string, title: string | null, pinnedAt: string | null, archivedAt: string | null, labels: string[], createdAt: string, managedWorktree: boolean, sessions: number }} OwnerWorkspace
 * @typedef {{ revision: number, projects: Array<{ id: string, root: string, customName?: string, addedAt: string }>, workspaces: OwnerWorkspace[], labels: Array<{ name: string, color: string }> }} OwnerRegistry
 */

/** Label colours alpd's registry accepts (packages/daemon/src/registry.ts). */
export const LABEL_COLORS = Object.freeze(['violet', 'sky', 'emerald', 'orange', 'pink', 'indigo', 'teal', 'red', 'amber', 'blue']);

const requestId = () => globalThis.crypto.randomUUID();

// ---- Usage -------------------------------------------------------------------------------------

/**
 * daemon.usage: refresh asks every provider again on the host. `disabled` when the host's Check
 * usage setting is off (it then answers no providers). The optional fields (planLabel, details,
 * balances, account, a window's id/label) come from newer hosts; the page falls back without them.
 * @param {OwnerController} controller @param {boolean} [refresh]
 */
export async function readUsage(controller, refresh = false) {
  const result = await controller.ownerRequest('daemon.usage', { refresh }, { timeoutMs: 60_000 });
  const usage = { providers: /** @type {UsageProvider[]} */ (Array.isArray(result?.providers) ? result.providers : []), disabled: result?.disabled === true };
  announceUsage(usage);
  return usage;
}

/**
 * The window event every usage read and Check usage change is announced on, so the sidebar's
 * summary follows the Usage page at once instead of at its next 60 s read (t-9116).
 */
export const USAGE_EVENT = 'alp:usage';
/** @param {{ providers: UsageProvider[], disabled: boolean }} usage */
function announceUsage(usage) {
  try { globalThis.dispatchEvent?.(new CustomEvent(USAGE_EVENT, { detail: usage })); } catch { /* no window (tests) */ }
}

/** host.usage.setting.get: whether the host checks usage, and its name. @param {OwnerController} controller @returns {Promise<UsageSetting>} */
export async function readUsageSetting(controller) {
  const result = await controller.ownerRequest('host.usage.setting.get', {});
  return { enabled: result?.enabled !== false, host: typeof result?.host === 'string' ? result.host : '' };
}
/** host.usage.setting.set: Check usage on or off, for every device of the host. @param {OwnerController} controller @param {boolean} enabled @returns {Promise<UsageSetting>} */
export async function setUsageSetting(controller, enabled) {
  const result = await controller.ownerRequest('host.usage.setting.set', { enabled });
  const setting = { enabled: result?.enabled !== false, host: typeof result?.host === 'string' ? result.host : '' };
  // Off: the summary goes at once. On: the next read (the page's, or the sidebar's) brings it back.
  if (!setting.enabled) announceUsage({ providers: [], disabled: true });
  return setting;
}

/** @param {string} runtime */
export const runtimeName = runtime => runtime === 'codex' ? 'Codex' : runtime === 'claude' ? 'Claude' : runtime;

/**
 * A provider's state when it is not plainly available, as a dot and word beside its name (Paseo
 * shows none for an available report). @param {UsageProvider} provider
 * @returns {{ label: string, tone: 'warning' | 'success' | 'muted' }}
 */
export function usageStatus(provider) {
  if (provider.pause) return { label: 'Paused', tone: 'warning' };
  if (!provider.available) return { label: 'Unavailable', tone: 'muted' };
  if (provider.limited) return { label: 'Limit reached', tone: 'warning' };
  return { label: 'Available', tone: 'success' };
}

/** @param {string} value */
export function dateLabel(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unknown';
}

// ---- Providers ---------------------------------------------------------------------------------

/**
 * The provider form (text fields) as host.provider.add params: args one per line, env NAME=value
 * one per line, models comma-separated; empty fields left out. Throws on a malformed env line.
 * @param {{ id: string, command: string, args: string, env: string, label: string, description: string, models: string }} form
 */
export function providerParams(form) {
  /** @type {Record<string, unknown>} */
  const params = { id: form.id.trim(), command: form.command.trim() };
  const args = form.args.split('\n').map(line => line.trimEnd()).filter(Boolean);
  if (args.length) params.args = args;
  /** @type {Record<string, string>} */
  const env = {};
  for (const line of form.env.split('\n').map(item => item.trim()).filter(Boolean)) {
    const at = line.indexOf('=');
    if (at <= 0) throw new Error(`Environment takes NAME=value, one per line, not '${line.length > 40 ? `${line.slice(0, 40)}…` : line}'`);
    env[line.slice(0, at).trim()] = line.slice(at + 1);
  }
  if (Object.keys(env).length) params.env = env;
  if (form.label.trim()) params.label = form.label.trim();
  if (form.description.trim()) params.description = form.description.trim();
  const models = form.models.split(',').map(model => model.trim()).filter(Boolean);
  if (models.length) params.models = models;
  return params;
}

/** A shell-like quoting of one word, for showing a command line (never run). @param {string} word */
export const quoteWord = word => /^[A-Za-z0-9_@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;

/**
 * What the confirm step shows: the exact command and args that will run, and each env name with its
 * value masked (HIDDEN), never the value.
 * @param {Record<string, any>} params host.provider.add params
 */
export function providerPreview(params) {
  const args = /** @type {string[]} */ (params.args ?? []);
  return {
    command: String(params.command ?? ''),
    args,
    line: [params.command, ...args].map(word => quoteWord(String(word))).join(' '),
    env: Object.keys(params.env ?? {}).map(name => ({ name, value: HIDDEN })),
  };
}

/** @param {OwnerController} controller @param {Record<string, unknown>} params */
export const addProvider = (controller, params) => controller.ownerRequest('host.provider.add', params);
/** @param {OwnerController} controller @param {string} name */
export const testProvider = (controller, name) => controller.ownerRequest('host.provider.test', { name }, { timeoutMs: 120_000 });
/** @param {OwnerController} controller @returns {Promise<{ checks: Array<{ id: string, status: 'ok' | 'warn' | 'fail', summary: string, details?: string[], hint?: string }> }>} */
export const diagnoseProviders = controller => controller.ownerRequest('host.provider.diagnose', {}, { timeoutMs: 120_000 });

/** One line for a provider test result, as alp provider test prints it. @param {any} result */
export function testSummary(result) {
  const name = result?.name ?? 'provider';
  if (result?.agent?.name === 'antigravity') return `${name}: ${result.agent?.title ?? 'Antigravity'} ${result.agent?.version ?? ''} (models: ${result.models?.length ?? 0}, mode: ${result.currentMode ?? 'full-access'})`;
  return `${name}: ${result?.agent?.title ?? result?.agent?.name ?? 'agent'} ${result?.agent?.version ?? ''} speaks ACP ${result?.protocolVersion}; ${result?.loadSession ? 'resumes sessions' : 'cannot resume sessions'}${result?.mcpHttp ? '; takes HTTP MCP servers' : ''}${result?.authMethods?.length ? `; signs in with ${result.authMethods.join(', ')}` : ''}`.replace(/\s+/g, ' ');
}

// ---- Terminals ---------------------------------------------------------------------------------

/** @param {OwnerController} controller @returns {Promise<{ allowRemoteTerminal: boolean, allowPaseoTerminal: boolean, problem?: string, warning: string }>} */
export const terminalStatus = controller => controller.ownerRequest('host.terminal.status', {});
/** @param {OwnerController} controller @param {boolean} allow @param {boolean} [confirm] */
export const setTerminal = (controller, allow, confirm = false) => controller.ownerRequest('host.terminal.set', allow ? { allow, confirm } : { allow });

// ---- Workspaces and projects ---------------------------------------------------------------------

/** @param {OwnerController} controller @returns {Promise<OwnerRegistry>} */
export const ownerRegistry = controller => controller.ownerRequest('host.registry', {});
/**
 * Paseo's Open in file manager: the host's file manager opens a registry workspace's directory (ALP.app on the host only, t-747e).
 * @param {OwnerController} controller @param {string} workspaceId @returns {Promise<{ opened: boolean }>}
 */
export const revealWorkspace = (controller, workspaceId) => controller.ownerRequest('host.workspace.reveal', { workspaceId });
/**
 * Paseo's Open in editor: the editors installed on the host (a fixed list there: VS Code, Cursor, Zed,
 * Xcode, JetBrains IDEs, and the file manager), ALP.app on the host only (t-a876).
 * @param {OwnerController} controller @returns {Promise<Array<{ id: string, label: string }>>}
 */
export async function workspaceEditors(controller) {
  const result = await controller.ownerRequest('host.workspace.editors', {});
  return (Array.isArray(result?.editors) ? result.editors : []).filter((/** @type {any} */ editor) => editor && typeof editor.id === 'string' && typeof editor.label === 'string');
}
/**
 * Opens a registry workspace (by id, never a path) in one of those editors on the host.
 * @param {OwnerController} controller @param {string} workspaceId @param {string} editor @returns {Promise<{ opened: boolean }>}
 */
export const openInEditor = (controller, workspaceId, editor) => controller.ownerRequest('host.workspace.open', { workspaceId, editor });
/** @param {OwnerController} controller @param {string} workspaceId @param {boolean} archived @param {number} ifRevision */
export const archiveWorkspace = (controller, workspaceId, archived, ifRevision) => controller.ownerRequest('host.workspace.update', { workspaceId, archived, ifRevision, requestId: requestId() });
/**
 * @param {OwnerController} controller
 * @param {{ action: 'assign' | 'unassign' | 'update' | 'delete', workspaceId?: string, name: string, newName?: string, color?: string }} change
 * @param {number} ifRevision
 */
export const changeLabel = (controller, change, ifRevision) => controller.ownerRequest('host.workspace.label', { ...change, ifRevision, requestId: requestId() });
/** @param {OwnerController} controller @param {string} directory @param {number} ifRevision */
export const registerDirectory = (controller, directory, ifRevision) => controller.ownerRequest('host.project.register', { directory: directory.trim(), ifRevision, requestId: requestId() });
/** @param {OwnerController} controller @param {string} projectId @param {number} ifRevision */
export const removeProject = (controller, projectId, ifRevision) => controller.ownerRequest('host.project.remove', { projectId, ifRevision, requestId: requestId() });

/** An error's message for the page. @param {unknown} error */
export const message = error => error instanceof Error ? error.message : String(error);
