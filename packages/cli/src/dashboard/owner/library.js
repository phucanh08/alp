// @ts-check
import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, readFile, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { ERROR, RPC_ERROR, WORKSPACE_FILES, blockedFilePath } from '@anhlp/alp-protocol';
import { moveFile } from '@anhlp/alp-core/atomic';
import { testEntry } from '@anhlp/alp-client/library-test';
import { imagePreviewType, projectImagePreview } from '@anhlp/alp-gateway/policy';

/**
 * Owner handlers for the user's library and workspace files (t-a95b group C; Settings › Templates,
 * Agents, Skills, Hooks, MCP servers and Editor; docs/alp/dashboard.md §4.8). Each one also has its
 * `owner` entry (`handler: true`, its `params`) in the `// --- owner: library (group C) ---` block of
 * apps/gateway/src/policy.js, or it is never reachable. Only the keys an entry lists reach a handler,
 * and a handler checks every value itself: no protocol schema covers a host.* method.
 *
 *   host.library.get     alpd's library.get: env and header values come back as { $secret: 'keep' }
 *                        (alpd's own redaction, docs/protocol/alp-json-rpc-v1.md §15.3).
 *   host.library.save    alpd's library.save with no project-data policy, in the library (host) or a
 *                        project scope; a marker keeps the stored value (alpd's unredact), and the
 *                        app's mask text anywhere in the content is refused, so a mask never lands.
 *   host.library.delete  alpd's library.delete.
 *   host.library.test    core's testEntry, as `alp mcp test` / `alp hook test`, in this process.
 *   host.files.list      alpd's workspace.files.list / .read for the owner, who holds no files.read:
 *   host.files.read      a registry workspace and a checked path only (listWorkspaceFiles below).
 *   host.files.preview   alpd's workspace.files.preview for one raster image (PNG, JPEG, GIF, WebP;
 *                        never SVG) of at most 1 MiB, whole, never through a link (previewWorkspaceImage).
 *   host.files.write     one existing text file of a registry workspace, replaced atomically when it
 *                        still holds what the app read (sha256 of its bytes); see writeWorkspaceFile.
 */

/** The kinds Settings edits here; providers are Settings › Providers' (group B). */
export const OWNER_LIBRARY_KINDS = Object.freeze(['agents', 'skills', 'teams', 'mcp', 'hooks']);
/** The kinds that can be tried out (testEntry). */
export const OWNER_TEST_KINDS = Object.freeze(['mcp', 'hooks']);
/** What the app shows in place of a hidden value (apps/web/src/lib/library.js HIDDEN); never stored. */
export const MASK_TEXT = '‹hidden on the host›';
/** At most this much of a test's stdout and stderr each goes back to the app. */
export const TEST_OUTPUT_CHARS = 16 * 1024;
const TEST_TIMEOUT_MS = 30_000;

/** A refusal the gateway passes to the app as this JSON-RPC error. */
export class OwnerError extends Error {
  /** @param {number} code @param {string} reason @param {string} message */
  constructor(code, reason, message) {
    super(message);
    this.code = code;
    this.data = { reason };
  }
}
const invalid = (/** @type {string} */ message) => new OwnerError(RPC_ERROR.invalidParams, 'invalid_params', message);

const isObject = (/** @type {unknown} */ value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** @param {unknown} value */
function kindOf(value, kinds = OWNER_LIBRARY_KINDS) {
  if (typeof value !== 'string' || !kinds.includes(value)) throw invalid(`kind must be one of ${kinds.join(', ')}`);
  return value;
}
/** An entry name as core accepts one ([\w.-], not . or ..). @param {unknown} value @param {string} what */
function nameOf(value, what = 'name') {
  if (typeof value !== 'string' || value.length > 128 || !/^[\w.-]+$/.test(value) || value === '.' || value === '..') throw invalid(`${what} must be an entry name (letters, digits, _ . -)`);
  return value;
}
/** @param {unknown} value */
function scopeOf(value, required = true) {
  if (value === undefined && !required) return undefined;
  if (value !== 'library' && value !== 'project') throw invalid('scope must be library (this host\'s) or project');
  return value;
}
/** An absolute directory path, as the app names a workspace. @param {unknown} value */
function rootOf(value, required = false) {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || !value || value.length > WORKSPACE_FILES.maxPathLength || value.includes('\0') || !path.isAbsolute(value)) throw invalid('projectRoot must be an absolute path');
  return value;
}
/** @param {unknown} value */
function revisionOf(value) {
  if (value !== null && (typeof value !== 'string' || !value || value.length > 64)) throw invalid('revision must be the revision read, or null for a new entry');
  return value;
}

/** The JSON Pointer of the first string holding the mask text, or undefined. @param {unknown} value @param {string} at @returns {string | undefined} */
export function maskIn(value, at = '') {
  if (typeof value === 'string') return value.includes(MASK_TEXT) ? at || '/' : undefined;
  if (Array.isArray(value)) { for (const [index, item] of value.entries()) { const found = maskIn(item, `${at}/${index}`); if (found) return found; } return undefined; }
  if (isObject(value)) { for (const [key, item] of Object.entries(/** @type {object} */ (value))) { const found = maskIn(item, `${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`); if (found) return found; } }
  return undefined;
}

/** @param {Record<string, any>} params */
function entryParams(params, { scopeRequired = true, kinds = OWNER_LIBRARY_KINDS } = {}) {
  const kind = kindOf(params.kind, kinds);
  const name = nameOf(params.name);
  const scope = scopeOf(params.scope, scopeRequired);
  const projectRoot = rootOf(params.projectRoot, scope === 'project');
  return { kind, name, ...(scope ? { scope } : {}), ...(projectRoot ? { projectRoot } : {}) };
}

/** @param {string} text */
const clip = text => typeof text === 'string' && text.length > TEST_OUTPUT_CHARS ? `${text.slice(0, TEST_OUTPUT_CHARS)}\n… (cut at ${TEST_OUTPUT_CHARS} characters)` : text;

/**
 * alpd's library call for the owner. Outside scope project, a projectRoot with no .alp (alpd's
 * not_alp_project: the dashboard's no-project directory, a repository never `alp init`-ed) is left
 * out and the call asked again, so it reads and writes the library there (t-a95b.1 F1). alpd refuses
 * before it writes anything; scope project and every other refusal keep alpd's answer.
 * @param {{ request: (method: string, params?: Record<string, unknown>) => Promise<unknown> }} daemon
 * @param {string} method @param {Record<string, any>} values
 */
async function libraryCall(daemon, method, values) {
  try { return await daemon.request(method, values); }
  catch (caught) {
    const error = /** @type {any} */ (caught);
    if (values.scope === 'project' || values.projectRoot === undefined || error?.code !== ERROR.notFound || error?.data?.reason !== 'not_alp_project') throw caught;
    const { projectRoot: _projectRoot, ...rest } = values;
    return daemon.request(method, rest);
  }
}

/** @type {import('./index.js').DashboardOwnerHandler} */
async function libraryGet({ params, daemon }) {
  return libraryCall(daemon, 'library.get', entryParams(params, { scopeRequired: false }));
}

/** @type {import('./index.js').DashboardOwnerHandler} */
async function librarySave({ params, daemon }) {
  const entry = entryParams(params);
  if (!isObject(params.content)) throw invalid('content must be the entry\'s content object');
  const mask = maskIn(params.content);
  if (mask !== undefined) throw new OwnerError(RPC_ERROR.invalidParams, 'secret_marker', `${mask} holds the text that stands for a hidden value; keep the hidden value or type a new one`);
  if (!Object.hasOwn(params, 'revision')) throw invalid('revision is required: the revision read, or null for a new entry');
  return libraryCall(daemon, 'library.save', { ...entry, content: params.content, revision: revisionOf(params.revision) });
}

/** @type {import('./index.js').DashboardOwnerHandler} */
async function libraryDelete({ params, daemon }) {
  const entry = entryParams(params);
  if (typeof params.revision !== 'string' || !params.revision || params.revision.length > 64) throw invalid('revision must be the revision read');
  return libraryCall(daemon, 'library.delete', { ...entry, revision: params.revision });
}

/**
 * Runs an MCP server or hook once, as `alp mcp test` / `alp hook test` do: the entry that applies
 * (or the one of `scope`), the project's directory when given. Its output goes back clipped.
 * @param {import('./index.js').DashboardOwnerContext} context
 * @param {{ run?: typeof testEntry }} [seams]
 */
export async function libraryTest({ params, home }, { run = testEntry } = {}) {
  const { kind, name, scope, projectRoot } = entryParams(params, { scopeRequired: false, kinds: OWNER_TEST_KINDS });
  const result = /** @type {Record<string, any>} */ (await run(kind, name, { root: projectRoot, library: home, ...(scope ? { scope } : {}), timeoutMs: TEST_TIMEOUT_MS }));
  return { ...result, ...(typeof result.stdout === 'string' ? { stdout: clip(result.stdout) } : {}), ...(typeof result.stderr === 'string' ? { stderr: clip(result.stderr) } : {}) };
}

// ---- host.files.write -------------------------------------------------------------------------

const SHA256 = /^[0-9a-f]{64}$/;
const sha256 = (/** @type {Buffer} */ bytes) => createHash('sha256').update(bytes).digest('hex');

/** The '/'-separated segments of a path relative to a workspace, or a refusal. @param {unknown} value */
export function relativeSegments(value) {
  if (typeof value !== 'string' || !value || value.length > WORKSPACE_FILES.maxPathLength || value.includes('\0')) throw invalid('path must be a file path relative to the workspace');
  if (value.startsWith('/') || value.includes('\\') || /^[A-Za-z]:/.test(value) || path.isAbsolute(value)) throw new OwnerError(RPC_ERROR.invalidParams, 'invalid_path', 'path must be relative to the workspace, not absolute');
  const segments = value.split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) throw new OwnerError(RPC_ERROR.invalidParams, 'invalid_path', 'path must not have empty, . or .. segments');
  if (blockedFilePath(value)) throw new OwnerError(ERROR.forbidden, 'blocked_path', `${value} is never written from the app: .git, .alp, .env files and key or credential files are refused`);
  return segments;
}

/**
 * The real directory of the registry workspace `projectRoot` names (its directory or that
 * directory's real path), asked of alpd; a directory alpd does not know as a workspace is refused.
 * @param {{ request: (method: string, params?: Record<string, unknown>) => Promise<unknown> }} daemon @param {string} projectRoot
 */
export async function registryWorkspace(daemon, projectRoot) {
  const wanted = await realpath(projectRoot).catch(() => undefined);
  if (wanted) {
    for (let cursor = /** @type {string | null} */ (null), pages = 0; pages < 50; pages++) {
      const page = /** @type {any} */ (await daemon.request('workspace.list', { limit: 500, ...(cursor ? { cursor } : {}) }));
      for (const workspace of Array.isArray(page?.workspaces) ? page.workspaces : []) {
        if (typeof workspace?.directory !== 'string') continue;
        if (workspace.directory === projectRoot || (await realpath(workspace.directory).catch(() => undefined)) === wanted) return wanted;
      }
      cursor = typeof page?.nextCursor === 'string' ? page.nextCursor : null;
      if (!cursor) break;
    }
  }
  throw new OwnerError(ERROR.forbidden, 'outside_workspace', 'projectRoot is not a workspace this host knows');
}

/**
 * The file at `segments` under the real directory `root`, checked as one the app may replace: every
 * directory on the way a real directory (no link: its real path is the path), the file an existing
 * regular file with one name, not a link. Answers its path, bytes and mode.
 * @param {string} root @param {string[]} segments @param {string} relative
 */
async function confinedFile(root, segments, relative) {
  const file = path.join(root, ...segments);
  const parent = path.dirname(file);
  const realParent = await realpath(parent).catch(() => undefined);
  if (realParent === undefined) throw new OwnerError(ERROR.notFound, 'not_found', `No file at ${relative}`);
  if (realParent !== parent || !(realParent === root || realParent.startsWith(`${root}${path.sep}`))) throw new OwnerError(ERROR.forbidden, 'linked', `${relative} is reached through a link; the app does not write through links`);
  const info = await lstat(file).catch(() => undefined);
  if (!info) throw new OwnerError(ERROR.notFound, 'not_found', `No file at ${relative}; the app edits existing files only`);
  if (info.isSymbolicLink()) throw new OwnerError(ERROR.forbidden, 'linked', `${relative} is a link; the app does not write through links`);
  if (!info.isFile()) throw new OwnerError(RPC_ERROR.invalidParams, 'not_file', `${relative} is not a regular file`);
  if (info.nlink > 1) throw new OwnerError(ERROR.forbidden, 'linked', `${relative} has more than one name (a hard link); the app does not write through links`);
  if (info.size > WORKSPACE_FILES.maxReadBytes) throw new OwnerError(ERROR.failed, 'too_large', `${relative} is larger than ${WORKSPACE_FILES.maxReadBytes} bytes`);
  return { file, info };
}

/**
 * host.files.write: replaces one existing UTF-8 text file of a registry workspace with `content`,
 * only while it still holds the bytes the app read (`baseSha256`, the sha256 of the text it shows,
 * which workspace.files.read answers byte for byte), else 1004 revision_conflict and nothing is
 * written. Refused before any write: a workspace alpd does not know, an absolute path or one with
 * . or .. segments, a blocked path (.git, .alp, .env, keys: blockedFilePath, as reads), a link on
 * the way or as the file, a missing file, content over WORKSPACE_FILES.maxReadBytes. The new bytes
 * go to a temporary file beside it (same mode) that is renamed over it once the file is checked
 * again, so a reader sees the old or the new content.
 * @param {{ daemon: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> }, params: Record<string, any> }} context
 */
export async function writeWorkspaceFile({ daemon, params }, { afterTempWrite, beforeRename } = /** @type {{ afterTempWrite?: () => unknown, beforeRename?: () => unknown }} */ ({})) {
  const projectRoot = rootOf(params.projectRoot, true);
  const segments = relativeSegments(params.path);
  const relative = segments.join('/');
  if (typeof params.content !== 'string') throw invalid('content must be text');
  const bytes = Buffer.from(params.content, 'utf8');
  if (bytes.length > WORKSPACE_FILES.maxReadBytes) throw new OwnerError(ERROR.failed, 'too_large', `The file would be larger than ${WORKSPACE_FILES.maxReadBytes} bytes`);
  if (typeof params.baseSha256 !== 'string' || !SHA256.test(params.baseSha256)) throw invalid('baseSha256 must be the sha256 (hex) of the content read');
  const root = await registryWorkspace(daemon, /** @type {string} */ (projectRoot));
  const { file, info } = await confinedFile(root, segments, relative);
  const conflict = () => new OwnerError(ERROR.conflict, 'revision_conflict', `${relative} changed on the host since you opened it; reload it and apply your change again`);
  if (sha256(await readFile(file)) !== params.baseSha256) throw conflict();
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.alp-tmp`);
  // Permission bits only: never carry setuid/setgid/sticky onto the new file.
  const handle = await open(temporary, 'wx', info.mode & 0o777);
  try {
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    // The parent is checked again now the temporary file exists: a directory on the way swapped for a
    // link after confinedFile would put the temporary (and the rename) outside the workspace, so it is
    // refused and the temporary removed. What remains is a window of a few system calls between these
    // checks and rename() (an lstat, a re-read of the file of up to 1 MiB and its sha256) in which a
    // racing process of the same user could swap a directory or change the file; it needs that user's
    // own code already running (docs/alp/dashboard.md §4.8). The two hooks are test seams only: the
    // methods table calls this with one argument.
    await afterTempWrite?.();
    const parentNow = await realpath(path.dirname(file)).catch(() => undefined);
    if (parentNow !== path.dirname(file) || !(parentNow === root || parentNow.startsWith(`${root}${path.sep}`))) throw new OwnerError(ERROR.forbidden, 'linked', `${relative} is reached through a link; the app does not write through links`);
    await beforeRename?.();
    // Checked again just before the rename: the same file, still holding what the app read.
    const again = await lstat(file).catch(() => undefined);
    if (!again || again.isSymbolicLink() || !again.isFile() || again.ino !== info.ino || again.dev !== info.dev || again.nlink > 1) throw conflict();
    if (sha256(await readFile(file)) !== params.baseSha256) throw conflict();
    await moveFile(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  const written = await lstat(file);
  return { path: relative, size: written.size, sha256: sha256(bytes), modifiedAt: written.mtime.toISOString() };
}

/**
 * host.files.list and host.files.read: the owner's Files panel and Editor, without files.read on the
 * dashboard credential (which stays as it is). The workspace must be one alpd's registry knows and
 * the path is checked as for host.files.write (relative, no . or .., never blocked); alpd then lists
 * or reads it on the owner's own connection with its own confinement (workspace.files.list/read:
 * no link followed, one name, ignored files only with includeIgnored, no private key, 1 MiB of UTF-8
 * text). A read answers the sha256 of the bytes too, which host.files.write takes as its base.
 * @param {{ daemon: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> }, params: Record<string, any> }} context
 */
export async function listWorkspaceFiles({ daemon, params }) {
  const projectRoot = rootOf(params.projectRoot, true);
  const relative = params.path === undefined || params.path === '' ? undefined : relativeSegments(params.path).join('/');
  if (params.includeIgnored !== undefined && typeof params.includeIgnored !== 'boolean') throw invalid('includeIgnored must be true or false');
  const root = await registryWorkspace(daemon, /** @type {string} */ (projectRoot));
  return daemon.request('workspace.files.list', { projectRoot: root, ...(relative ? { path: relative } : {}), ...(params.includeIgnored ? { includeIgnored: true } : {}) });
}

/** @param {{ daemon: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> }, params: Record<string, any> }} context */
export async function readWorkspaceFile({ daemon, params }) {
  const projectRoot = rootOf(params.projectRoot, true);
  const relative = relativeSegments(params.path).join('/');
  if (params.includeIgnored !== undefined && typeof params.includeIgnored !== 'boolean') throw invalid('includeIgnored must be true or false');
  const root = await registryWorkspace(daemon, /** @type {string} */ (projectRoot));
  const result = /** @type {any} */ (await daemon.request('workspace.files.read', { projectRoot: root, path: relative, ...(params.includeIgnored ? { includeIgnored: true } : {}) }));
  if (typeof result?.content !== 'string' || result.path !== relative) throw new OwnerError(ERROR.failed, 'unreadable', `alpd answered the read of ${relative} in a form the dashboard does not read`);
  return { ...result, sha256: sha256(Buffer.from(result.content, 'utf8')) };
}

/**
 * host.files.preview: one image of a registry workspace for the owner's file view, as the gateway
 * narrows workspace.files.preview for files.read (apps/gateway/src/policy.js PREVIEW_IMAGE_TYPES):
 * a raster image by extension in any case (never SVG, a document that can carry script), checked
 * as host.files.read checks a path, refused before alpd otherwise; alpd reads it from offset 0 with
 * maxBytes WORKSPACE_FILES.maxReadBytes and its own confinement (no link, one name, no private
 * key); its answer must be that one whole image (projectImagePreview), else refused. Read only.
 * @param {{ daemon: { request: (method: string, params?: Record<string, unknown>) => Promise<unknown> }, params: Record<string, any> }} context
 */
export async function previewWorkspaceImage({ daemon, params }) {
  const projectRoot = rootOf(params.projectRoot, true);
  const relative = relativeSegments(params.path).join('/');
  if (!imagePreviewType(relative)) throw new OwnerError(ERROR.forbidden, 'not_image', 'Only PNG, JPEG, GIF and WebP images are previewed; other files are read as text');
  if (params.includeIgnored !== undefined && typeof params.includeIgnored !== 'boolean') throw invalid('includeIgnored must be true or false');
  const root = await registryWorkspace(daemon, /** @type {string} */ (projectRoot));
  const result = /** @type {any} */ (await daemon.request('workspace.files.preview', { projectRoot: root, path: relative, ...(params.includeIgnored ? { includeIgnored: true } : {}), maxBytes: WORKSPACE_FILES.maxReadBytes }));
  if (result?.path === relative && result?.nextOffset !== undefined) throw new OwnerError(ERROR.failed, 'too_large', `${relative} is larger than ${WORKSPACE_FILES.maxReadBytes} bytes`);
  const image = projectImagePreview(result, relative);
  if (!image) throw new OwnerError(ERROR.failed, 'unreadable', `alpd answered the preview of ${relative} in a form the dashboard does not show`);
  return image;
}

/** @type {Readonly<Record<string, import('./index.js').DashboardOwnerHandler>>} */
export const methods = {
  'host.files.list': context => listWorkspaceFiles(context),
  'host.files.read': context => readWorkspaceFile(context),
  'host.files.preview': context => previewWorkspaceImage(context),
  'host.library.get': libraryGet,
  'host.library.save': librarySave,
  'host.library.delete': libraryDelete,
  'host.library.test': context => libraryTest(context),
  'host.files.write': context => writeWorkspaceFile(context),
};
