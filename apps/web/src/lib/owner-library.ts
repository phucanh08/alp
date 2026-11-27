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
/** Hook events as core accepts them (packages/core/src/settings/validation.ts HOOK_EVENTS), and those that may block. */
export const HOOK_EVENTS = Object.freeze(['session.start', 'turn.end', 'assignment.start', 'assignment.end', 'handoff', 'task.close', 'merge']);
export const BLOCKING_HOOK_EVENTS = Object.freeze(['handoff', 'task.close', 'merge']);
/** Scopes an owner writes: this host's library (the user's entries) or the open project's .alp. */
export const SCOPE_LABELS = Object.freeze({ library: 'This host (your library)', project: 'This project (.alp)' });

// any: each owner method answers its own shape; the caller reads only the fields it needs.
export type OwnerClient = { ownerRequest: (method: string, params?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<any> };
export type OwnerKind = 'agents' | 'skills' | 'teams' | 'mcp' | 'hooks';
export type OwnerScope = 'library' | 'project';
/** value null: the stored value is kept */
export type SecretRow = { key: string, value: string | null };
export type McpForm = { transport: 'command' | 'url', command: string, args: string, cwd: string, url: string, env: SecretRow[], headers: SecretRow[] };
export type HookForm = { description: string, event: string, command: string, blocking: boolean, timeoutSec: string, matchAgent: string, matchLabel: string };

// ---- requests ----------------------------------------------------------------------------------

export const getOwnerEntry = (client: OwnerClient, params: { kind: OwnerKind; name: string; scope?: OwnerScope; projectRoot?: string; }) => client.ownerRequest('host.library.get', params);
export const saveOwnerEntry = (client: OwnerClient, params: { kind: OwnerKind; name: string; scope: OwnerScope; projectRoot?: string; content: Record<string, unknown>; revision: string | null; }) => client.ownerRequest('host.library.save', params);
export const deleteOwnerEntry = (client: OwnerClient, params: { kind: OwnerKind; name: string; scope: OwnerScope; projectRoot?: string; revision: string; }) => client.ownerRequest('host.library.delete', params);
export const testOwnerEntry = (client: OwnerClient, params: { kind: 'mcp' | 'hooks'; name: string; scope?: OwnerScope; projectRoot?: string; }) => client.ownerRequest('host.library.test', params, { timeoutMs: 60_000 });

/**
 * The entry of exactly `scope` and its revision, or `{ revision: null }` when that scope has none
 * yet (a save then creates it there).
 */
export async function ownScopeEntry(client: OwnerClient, params: { kind: OwnerKind; name: string; scope: OwnerScope; projectRoot?: string; }) {
  try {
    const entry = await getOwnerEntry(client, params);
    return { entry, revision: typeof entry?.revision === 'string' ? entry.revision : null };
  } catch (error) {
    // any: a thrown value of unknown shape; only optional fields are read, each checked before use.
    if ((error as any)?.code === 1001 || (error as any)?.data?.reason === 'not_found') return { entry: undefined, revision: null };
    throw error;
  }
}

/** The sha256 (hex) of a text's UTF-8 bytes: host.files.write's base. */
export async function sha256Hex(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// ---- workspace files (the owner's Files panel and Editor) -------------------------------------

function filePath(path: string | undefined, required: boolean) {
  if (path === undefined || path === '') {
    if (required) throw new FileAccessError({ message: 'That is not a valid path in this workspace.', reason: 'invalid_path', sent: 'no', terminal: false });
    return undefined;
  }
  const relative = relativeFilePath(path);
  if (!relative) throw new FileAccessError({ message: 'That is not a valid path in this workspace.', reason: 'invalid_path', sent: 'no', terminal: false });
  return relative;
}
const fileFailure = (error: unknown) => error instanceof FileAccessError ? error : new FileAccessError(describeFileError(error));

/**
 * A directory of the workspace (the root when `path` is left out), as listWorkspaceFiles answers it,
 * through host.files.list.
 */
export async function listOwnerFiles(client: OwnerClient, workspace: string, { path, includeIgnored = false }: { path?: string; includeIgnored?: boolean; } = {}) {
  const relative = filePath(path, false);
  let result;
  try { result = await client.ownerRequest('host.files.list', { projectRoot: workspace, ...(relative ? { path: relative } : {}), ...(includeIgnored ? { includeIgnored: true } : {}) }); }
  catch (error) { throw fileFailure(error); }
  return cleanListing(result, relative ?? '');
}

/**
 * One text file, as readWorkspaceFile answers it, with the sha256 host.files.write needs, through
 * host.files.read.
 */
export async function readOwnerFile(client: OwnerClient, workspace: string, { path, includeIgnored = false }: { path: string; includeIgnored?: boolean; }): Promise<{ path: string; content: string; size: number; modifiedAt?: string; sha256: string; }> {
  const relative = filePath(path, true) as string;
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

// ---- images (the file view's image preview, t-a35b) -------------------------------------------

/**
 * The raster images the file view shows as images, by extension in any case, with their MIME type
 * (the gateway's PREVIEW_IMAGE_TYPES). SVG is not one: it stays text, never rendered as a document.
 */
export const PREVIEW_IMAGE_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' });

/** The MIME type of a path the file view shows as an image, else undefined. */
export function previewImageType(path: unknown) {
  if (typeof path !== 'string') return undefined;
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.hasOwn(PREVIEW_IMAGE_TYPES, extension) ? PREVIEW_IMAGE_TYPES[(extension as keyof typeof PREVIEW_IMAGE_TYPES)] : undefined;
}

export type ImagePreview = { path: string; mimeType: string; size: number; modifiedAt?: string; content: string; };

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * A workspace.files.preview / host.files.preview answer as the file view shows it: one whole image
 * of `path`, its MIME type the one its extension names, base64 of at most 1 MiB. Anything else is a
 * FileAccessError (too_large when the host sent more).
 */
export function imagePreview(raw: unknown, path: string): ImagePreview {
  // any: alpd's or the gateway's answer (untrusted JSON); each field is checked where it is read.
  const result = raw as any;
  const mimeType = previewImageType(path);
  const content = result?.content;
  const fits = typeof content === 'string' && content.length <= Math.ceil(WORKSPACE_FILES.maxReadBytes / 3) * 4;
  if (result?.path === path && (result.nextOffset !== undefined || (typeof content === 'string' && !fits))) throw new FileAccessError({ message: 'This file is too large to display', reason: 'too_large', sent: 'yes', terminal: true });
  if (!mimeType || result?.path !== path || result.kind !== 'image' || result.encoding !== 'base64' || result.mimeType !== mimeType || !fits || !BASE64.test(content)) {
    throw new FileAccessError({ message: 'The host sent something this app does not understand.', sent: 'yes', terminal: false });
  }
  const size = Math.floor(content.length * 3 / 4) - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0);
  return { path, mimeType, size, content, ...(typeof result.modifiedAt === 'string' ? { modifiedAt: result.modifiedAt } : {}) };
}

/**
 * One image of the workspace for the owner's file view, through host.files.preview (no files.read
 * needed on the owner's dashboard), as previewWorkspaceImage answers it.
 */
export async function previewOwnerImage(client: OwnerClient, workspace: string, { path, includeIgnored = false }: { path: string; includeIgnored?: boolean; }): Promise<ImagePreview> {
  const relative = filePath(path, true) as string;
  if (!previewImageType(relative)) throw new FileAccessError({ message: 'Only PNG, JPEG, GIF and WebP images are shown as images.', reason: 'not_image', sent: 'no', terminal: true });
  let result;
  try { result = await client.ownerRequest('host.files.preview', { projectRoot: workspace, path: relative, ...(includeIgnored ? { includeIgnored: true } : {}) }); }
  catch (error) { throw fileFailure(error); }
  return imagePreview(result, relative);
}

/**
 * Saves a file the owner edited (host.files.write): only while the host still holds `base`, the
 * text that was read; else 1004 revision_conflict and nothing is written.
 */
export async function writeOwnerFile(client: OwnerClient, workspace: string, { path, content, base }: { path: string; content: string; base: string; }) {
  const relative = filePath(path, true) as string;
  if (new TextEncoder().encode(content).length > WORKSPACE_FILES.maxReadBytes) throw new FileAccessError({ message: 'Files over 1 MB cannot be saved from the app.', reason: 'too_large', sent: 'no', terminal: false });
  return client.ownerRequest('host.files.write', { projectRoot: workspace, path: relative, content, baseSha256: await sha256Hex(base) });
}

// ---- MCP servers -------------------------------------------------------------------------------

const rowsOf = (map: unknown): SecretRow[] => map && typeof map === 'object' && !Array.isArray(map)
  ? Object.entries(map as Record<string, unknown>).map(([key, value]) => ({ key, value: isSecretMarker(value) ? null : typeof value === 'string' ? value : '' }))
  : [];

function mapOf(rows: SecretRow[], what: string) {
  const out: Record<string, unknown> = {};
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

/** An MCP server's content as its form. */
// any: stored or host JSON of any shape; every field is checked where it is read.
export function mcpForm(content: Record<string, any> | undefined): McpForm {
  const server = content?.server ?? {};
  const text = (value: unknown) => typeof value === 'string' ? value : '';
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

/** The content a form saves: a kept value stays the marker. */
export function mcpContent(form: McpForm): Record<string, unknown> {
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

// any: stored or host JSON of any shape; every field is checked where it is read.
export function hookForm(content: Record<string, any> | undefined): HookForm {
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

export function hookContent(form: HookForm): Record<string, unknown> {
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

/** A kept value as the review shows it. */
const shown = (value: unknown) => isSecretMarker(value) ? `${HIDDEN} (kept as stored)` : '•••••• (new value)';

/**
 * What a save will make the host run, for the review before it: command, arguments, environment
 * names (values never shown), directory or URL, a hook's event and whether it blocks. Agents,
 * skills and templates run nothing themselves: their review says what changes.
 */
// any: stored or host JSON of any shape; every field is checked where it is read.
export function reviewRows(kind: OwnerKind, name: string, scope: OwnerScope, content: Record<string, any>): Array<[string, string]> {
  const rows: Array<[string, string]> = [['Entry', `${name} (${kind === 'mcp' ? 'MCP server' : kind.replace(/s$/, '')})`], ['Saved in', SCOPE_LABELS[scope]]];
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
