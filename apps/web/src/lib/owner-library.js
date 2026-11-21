// @ts-check
import { WORKSPACE_FILES } from '@anhlp/alp-protocol';
import { FileAccessError, describeFileError } from './errors.js';
import { cleanListing, relativeFilePath } from './file-tree.js';
import { HIDDEN, isSecretMarker } from './library.js';

/**
 * The host owner's library and file actions in Settings and the Files panel (t-a95b group C;
 * docs/alp/dashboard.md §4.8): requests through controller.ownerRequest (only the owner's own
 * dashboard connection, state.owner; the gateway checks again), and the forms the Hooks and MCP
 * servers pages edit. A value alpd keeps hidden (an env or header value) stays the marker
 * `{ $secret: 'keep' }` from read to save unless the owner types a new one: the mask text the page
 * shows (HIDDEN) is never sent as a value.
 */

/** The marker that keeps a stored value (alpd's, docs/protocol/alp-json-rpc-v1.md §15.3). */
export const KEEP = Object.freeze({ $secret: 'keep' });
/** Hook events as core accepts them (packages/core/src/validation.js HOOK_EVENTS), and those that may block. */
export const HOOK_EVENTS = Object.freeze(['session.start', 'turn.end', 'assignment.start', 'assignment.end', 'handoff', 'task.close', 'merge']);
export const BLOCKING_HOOK_EVENTS = Object.freeze(['handoff', 'task.close', 'merge']);
/** Scopes an owner writes: this host's library (the user's entries) or the open project's .alp. */
export const SCOPE_LABELS = Object.freeze({ library: 'This host (your library)', project: 'This project (.alp)' });

/**
 * @typedef {{ ownerRequest: (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<any> }} OwnerClient
 * @typedef {'agents' | 'skills' | 'teams' | 'mcp' | 'hooks'} OwnerKind
 * @typedef {'library' | 'project'} OwnerScope
 * @typedef {{ key: string, value: string | null }} SecretRow  value null: the stored value is kept
 * @typedef {{ transport: 'command' | 'url', command: string, args: string, cwd: string, url: string, env: SecretRow[], headers: SecretRow[] }} McpForm
 * @typedef {{ description: string, event: string, command: string, blocking: boolean, timeoutSec: string, matchAgent: string, matchLabel: string }} HookForm
 */

// ---- requests ----------------------------------------------------------------------------------

/** @param {OwnerClient} client @param {{ kind: OwnerKind, name: string, scope?: OwnerScope, projectRoot?: string }} params */
export const getOwnerEntry = (client, params) => client.ownerRequest('host.library.get', params);
/** @param {OwnerClient} client @param {{ kind: OwnerKind, name: string, scope: OwnerScope, projectRoot?: string, content: Record<string, unknown>, revision: string | null }} params */
export const saveOwnerEntry = (client, params) => client.ownerRequest('host.library.save', params);
/** @param {OwnerClient} client @param {{ kind: OwnerKind, name: string, scope: OwnerScope, projectRoot?: string, revision: string }} params */
export const deleteOwnerEntry = (client, params) => client.ownerRequest('host.library.delete', params);
/** @param {OwnerClient} client @param {{ kind: 'mcp' | 'hooks', name: string, scope?: OwnerScope, projectRoot?: string }} params */
export const testOwnerEntry = (client, params) => client.ownerRequest('host.library.test', params, { timeoutMs: 60_000 });

/**
 * The entry of exactly `scope` and its revision, or `{ revision: null }` when that scope has none
 * yet (a save then creates it there).
 * @param {OwnerClient} client @param {{ kind: OwnerKind, name: string, scope: OwnerScope, projectRoot?: string }} params
 */
export async function ownScopeEntry(client, params) {
  try {
    const entry = await getOwnerEntry(client, params);
    return { entry, revision: typeof entry?.revision === 'string' ? entry.revision : null };
  } catch (error) {
    if (/** @type {any} */ (error)?.code === 1001 || /** @type {any} */ (error)?.data?.reason === 'not_found') return { entry: undefined, revision: null };
    throw error;
  }
}

/** The sha256 (hex) of a text's UTF-8 bytes: host.files.write's base. @param {string} text */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// ---- workspace files (the owner's Files panel and Editor) -------------------------------------

/** @param {string | undefined} path @param {boolean} required */
function filePath(path, required) {
  if (path === undefined || path === '') {
    if (required) throw new FileAccessError({ message: 'That is not a valid path in this workspace.', reason: 'invalid_path', sent: 'no', terminal: false });
    return undefined;
  }
  const relative = relativeFilePath(path);
  if (!relative) throw new FileAccessError({ message: 'That is not a valid path in this workspace.', reason: 'invalid_path', sent: 'no', terminal: false });
  return relative;
}
/** @param {unknown} error */
const fileFailure = error => error instanceof FileAccessError ? error : new FileAccessError(describeFileError(error));

/**
 * A directory of the workspace (the root when `path` is left out), as listWorkspaceFiles answers it,
 * through host.files.list.
 * @param {OwnerClient} client @param {string} workspace @param {{ path?: string, includeIgnored?: boolean }} [input]
 */
export async function listOwnerFiles(client, workspace, { path, includeIgnored = false } = {}) {
  const relative = filePath(path, false);
  let result;
  try { result = await client.ownerRequest('host.files.list', { projectRoot: workspace, ...(relative ? { path: relative } : {}), ...(includeIgnored ? { includeIgnored: true } : {}) }); }
  catch (error) { throw fileFailure(error); }
  return cleanListing(result, relative ?? '');
}

/**
 * One text file, as readWorkspaceFile answers it, with the sha256 host.files.write needs, through
 * host.files.read.
 * @param {OwnerClient} client @param {string} workspace @param {{ path: string, includeIgnored?: boolean }} input
 * @returns {Promise<{ path: string, content: string, size: number, modifiedAt?: string, sha256: string }>}
 */
export async function readOwnerFile(client, workspace, { path, includeIgnored = false }) {
  const relative = /** @type {string} */ (filePath(path, true));
  let result;
  try { result = await client.ownerRequest('host.files.read', { projectRoot: workspace, path: relative, ...(includeIgnored ? { includeIgnored: true } : {}) }); }
  catch (error) { throw fileFailure(error); }
  const content = typeof result?.content === 'string' ? result.content : undefined;
  if (content === undefined || content.length > WORKSPACE_FILES.maxReadBytes) throw new FileAccessError({ message: content === undefined ? 'The host sent something this app does not understand.' : 'This file is too large to display', ...(content === undefined ? {} : { reason: 'too_large' }), sent: 'yes', terminal: false });
  return {
    path: relative, content,
    size: typeof result.size === 'number' ? result.size : content.length,
    ...(typeof result.modifiedAt === 'string' ? { modifiedAt: result.modifiedAt } : {}),
    sha256: typeof result.sha256 === 'string' ? result.sha256 : await sha256Hex(content),
  };
}

/**
 * Saves a file the owner edited (host.files.write): only while the host still holds `base`, the
 * text that was read; else 1004 revision_conflict and nothing is written.
 * @param {OwnerClient} client @param {string} workspace @param {{ path: string, content: string, base: string }} input
 */
export async function writeOwnerFile(client, workspace, { path, content, base }) {
  const relative = /** @type {string} */ (filePath(path, true));
  if (new TextEncoder().encode(content).length > WORKSPACE_FILES.maxReadBytes) throw new FileAccessError({ message: 'Files over 1 MB cannot be saved from the app.', reason: 'too_large', sent: 'no', terminal: false });
  return client.ownerRequest('host.files.write', { projectRoot: workspace, path: relative, content, baseSha256: await sha256Hex(base) });
}

// ---- MCP servers -------------------------------------------------------------------------------

/** @param {unknown} map @returns {SecretRow[]} */
const rowsOf = map => map && typeof map === 'object' && !Array.isArray(map)
  ? Object.entries(/** @type {Record<string, unknown>} */ (map)).map(([key, value]) => ({ key, value: isSecretMarker(value) ? null : typeof value === 'string' ? value : '' }))
  : [];

/** @param {SecretRow[]} rows @param {string} what */
function mapOf(rows, what) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (!key && (row.value ?? '') === '') continue;
    if (!key) throw new Error(`Every ${what} needs a name.`);
    if (Object.hasOwn(out, key)) throw new Error(`${what} ${key} is listed twice.`);
    if (row.value !== null && row.value.includes(HIDDEN)) throw new Error(`${what} ${key}: type the new value, or keep the hidden one.`);
    out[key] = row.value === null ? { ...KEEP } : row.value;
  }
  return out;
}

/** An MCP server's content as its form. @param {Record<string, any> | undefined} content @returns {McpForm} */
export function mcpForm(content) {
  const server = content?.server ?? {};
  const text = (/** @type {unknown} */ value) => typeof value === 'string' ? value : '';
  return {
    transport: typeof server.url === 'string' || isSecretMarker(server.url) ? 'url' : 'command',
    command: text(server.command),
    args: Array.isArray(server.args) ? server.args.map(text).join('\n') : '',
    cwd: text(server.cwd),
    url: text(server.url),
    env: rowsOf(server.env),
    headers: rowsOf(server.headers),
  };
}

/** The content a form saves: a kept value stays the marker. @param {McpForm} form @returns {Record<string, unknown>} */
export function mcpContent(form) {
  if (form.transport === 'url') {
    if (!form.url.trim()) throw new Error('A URL is required.');
    const headers = mapOf(form.headers, 'Header');
    return { server: { url: form.url.trim(), ...(Object.keys(headers).length ? { headers } : {}) } };
  }
  if (!form.command.trim()) throw new Error('A command is required.');
  const args = form.args.split('\n').map(line => line.trim()).filter(Boolean);
  const env = mapOf(form.env, 'Variable');
  return { server: { command: form.command.trim(), ...(args.length ? { args } : {}), ...(form.cwd.trim() ? { cwd: form.cwd.trim() } : {}), ...(Object.keys(env).length ? { env } : {}) } };
}

// ---- hooks -------------------------------------------------------------------------------------

/** @param {Record<string, any> | undefined} content @returns {HookForm} */
export function hookForm(content) {
  const hook = content?.hook ?? {};
  return {
    description: typeof hook.description === 'string' ? hook.description : '',
    event: typeof hook.event === 'string' ? hook.event : 'turn.end',
    command: typeof hook.command === 'string' ? hook.command : '',
    blocking: hook.blocking === true,
    timeoutSec: typeof hook.timeoutSec === 'number' ? String(hook.timeoutSec) : '',
    matchAgent: typeof hook.match?.agent === 'string' ? hook.match.agent : '',
    matchLabel: typeof hook.match?.label === 'string' ? hook.match.label : '',
  };
}

/** @param {HookForm} form @returns {Record<string, unknown>} */
export function hookContent(form) {
  if (!HOOK_EVENTS.includes(form.event)) throw new Error(`Choose an event: ${HOOK_EVENTS.join(', ')}.`);
  if (!form.command.trim()) throw new Error('A command is required.');
  if (form.blocking && !BLOCKING_HOOK_EVENTS.includes(form.event)) throw new Error(`Only ${BLOCKING_HOOK_EVENTS.join(', ')} hooks can block.`);
  const timeout = form.timeoutSec.trim() ? Number(form.timeoutSec) : undefined;
  if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error('The timeout is a number of seconds.');
  const match = { ...(form.matchAgent.trim() ? { agent: form.matchAgent.trim() } : {}), ...(form.matchLabel.trim() ? { label: form.matchLabel.trim() } : {}) };
  return { hook: {
    ...(form.description.trim() ? { description: form.description.trim() } : {}),
    event: form.event, command: form.command.trim(),
    ...(form.blocking ? { blocking: true } : {}),
    ...(timeout !== undefined ? { timeoutSec: timeout } : {}),
    ...(Object.keys(match).length ? { match } : {}),
  } };
}

// ---- what a save will run ----------------------------------------------------------------------

/** A kept value as the review shows it. @param {unknown} value */
const shown = value => isSecretMarker(value) ? `${HIDDEN} (kept as stored)` : '•••••• (new value)';

/**
 * What a save will make the host run, for the review before it: command, arguments, environment
 * names (values never shown), directory or URL, a hook's event and whether it blocks. Agents,
 * skills and templates run nothing themselves: their review says what changes.
 * @param {OwnerKind} kind @param {string} name @param {OwnerScope} scope @param {Record<string, any>} content
 * @returns {Array<[string, string]>}
 */
export function reviewRows(kind, name, scope, content) {
  /** @type {Array<[string, string]>} */
  const rows = [['Entry', `${name} (${kind === 'mcp' ? 'MCP server' : kind.replace(/s$/, '')})`], ['Saved in', SCOPE_LABELS[scope]]];
  if (kind === 'mcp') {
    const server = content.server ?? {};
    if (server.url !== undefined) {
      rows.push(['Connects to', String(server.url)]);
      for (const [key, value] of Object.entries(server.headers ?? {})) rows.push([`Header ${key}`, shown(value)]);
    } else {
      rows.push(['Runs', [server.command, ...(server.args ?? [])].map(String).join(' ')]);
      rows.push(['In directory', server.cwd ? String(server.cwd) : 'the session\'s project']);
      for (const [key, value] of Object.entries(server.env ?? {})) rows.push([`Env ${key}`, shown(value)]);
    }
  } else if (kind === 'hooks') {
    const hook = content.hook ?? {};
    rows.push(['Runs (shell)', String(hook.command ?? '')]);
    rows.push(['On', String(hook.event ?? '')]);
    rows.push(['Blocking', hook.blocking ? 'yes: a failure refuses the action' : 'no']);
    if (hook.timeoutSec !== undefined) rows.push(['Timeout', `${hook.timeoutSec} s`]);
    if (hook.match) rows.push(['Only for', Object.entries(hook.match).map(([key, value]) => `${key} ${value}`).join(', ')]);
  } else {
    rows.push(['Runs', 'nothing by itself: instructions and settings agents read']);
  }
  return rows;
}
