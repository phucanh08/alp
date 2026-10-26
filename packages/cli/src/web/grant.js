// @ts-check
import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertPrivateDirectory, connect } from '@anhlp/alp-client/index';
import { createCredential, listCredentials, revokeCredential, updateCredential } from '@anhlp/alp-gateway';
import { DEFAULT_PERMISSIONS, PERMISSIONS } from '@anhlp/alp-gateway/policy';

/**
 * The one gateway credential `alp web` hands the browser (docs/alp/web.md): its token travels in
 * the URL the CLI opens, so it is a real `alpgw1.*` credential with the least the app needs.
 *
 * Single writer: the credentials live in `<home>/web/credentials.json`, a file of alp-web's own
 * (not the standalone gateway's `<home>/gateway`). Only the process holding the `web` integration
 * lock writes it, and inside that process every write goes through one queue (`serial`), so no
 * two writes interleave their read-modify-write. Another tool must not write it while the service
 * runs. Because the file is alp-web's own, `alp-gateway credential list/revoke` (which read
 * `<home>/gateway`) do not see this credential: `alp web rotate` is the way to replace or end it.
 * The gateway's own checks apply to this path as to its default one: the directory must be the
 * user's and private (0700, checked on every start, not only on a write) and the file 0600 and the
 * user's, else nothing is read or written and the service does not start.
 *
 * Grant: permissions are DEFAULT_PERMISSIONS + workspace.write, plus `web.permissions` from the
 * user's settings when every entry is a permission a credential may hold (with any unknown entry
 * the whole list is ignored, with a warning naming it, so the grant stays the default). Workspaces are alpd's project
 * registry (live projects) ∪ the `--project` directory the caller named; with none, a private
 * empty directory stands in (a credential needs one workspace, and it grants nothing).
 */

export const LABEL = 'alp web (this machine)';
export const BASE_PERMISSIONS = Object.freeze([...DEFAULT_PERMISSIONS, 'workspace.write']);

/** Where alp-web keeps its credentials. @param {string} home */
export const webGatewayHome = home => path.join(home, 'web');

/**
 * The permissions to grant: the base set and, when valid, `web.permissions`.
 * @param {unknown} extra the `web.permissions` setting
 * @param {(message: string) => void} [warn]
 */
export function grantPermissions(extra, warn = () => {}) {
  const wanted = new Set(BASE_PERMISSIONS);
  if (extra !== undefined) {
    const unknown = Array.isArray(extra) ? extra.filter(entry => typeof entry !== 'string' || !PERMISSIONS.includes(entry)) : [extra];
    if (!unknown.length) for (const entry of /** @type {string[]} */ (extra)) wanted.add(entry);
    else warn(`ignoring web.permissions: ${unknown.map(entry => JSON.stringify(entry)).join(', ')} ${unknown.length === 1 ? 'is not a permission' : 'are not permissions'} a credential may hold (${PERMISSIONS.join(', ')}); the default grant (${BASE_PERMISSIONS.join(', ')}) is in use`);
  }
  // As the gateway stores them: a write permission holds its read (credentials.js checkPermissions).
  if (wanted.has('session.write')) wanted.add('session.read');
  if (wanted.has('project.write') || wanted.has('library.write')) wanted.add('project.read');
  return PERMISSIONS.filter(permission => wanted.has(permission));
}

/**
 * Existing directories among `paths`, as the gateway stores workspaces: absolute and normalized as
 * given, one per real path (the first wins). Anything else is dropped, never resolved further.
 * @param {Iterable<unknown>} paths
 * @returns {Promise<Array<{ path: string, canonical: string }>>}
 */
export async function existingWorkspaces(paths) {
  /** @type {Array<{ path: string, canonical: string }>} */
  const found = [];
  for (const entry of paths) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry) || path.resolve(entry) !== entry || entry.includes('\0')) continue;
    const canonical = await realpath(entry).catch(() => undefined);
    if (!canonical || !(await stat(canonical).then(info => info.isDirectory(), () => false))) continue;
    if (!found.some(known => known.canonical === canonical)) found.push({ path: entry, canonical });
  }
  return found;
}

/**
 * The live project roots in alpd's registry, through its socket; undefined when alpd cannot answer
 * within `timeoutMs` (the grant is then left as it is).
 * @param {string | undefined} socket @param {{ timeoutMs?: number }} [options]
 */
export async function registryRoots(socket, { timeoutMs = 3_000 } = {}) {
  if (!socket) return undefined;
  /** @type {any} */
  let client;
  let finished = false;
  let timer;
  const late = new Promise(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
  // A connection that opens after the answer was given up on is closed at once.
  const opened = (/** @type {any} */ value) => { if (finished) { try { value.close(); } catch {} } else client = value; };
  try { return await Promise.race([listRoots(socket, opened), late]); }
  finally { finished = true; clearTimeout(timer); try { client?.close(); } catch {} }
}

/** @param {string} socket @param {(client: any) => void} opened */
async function listRoots(socket, opened) {
  let client;
  try {
    client = await connect(socket, { name: 'alp-web', version: '1' });
    opened(client);
    /** @type {string[]} */
    const roots = [];
    let cursor;
    for (let page = 0; page < 100; page++) {
      const result = /** @type {any} */ (await client.request('project.list', { limit: 500, ...(cursor ? { cursor } : {}) }));
      for (const project of result?.projects ?? []) if (typeof project?.root === 'string' && !project.removedAt) roots.push(project.root);
      cursor = result?.nextCursor;
      if (!cursor) return roots;
    }
    return undefined;
  } catch { return undefined; } finally { try { client?.close(); } catch {} }
}


/** @param {Array<{ path: string, canonical: string }>} a @param {Array<{ path: string, canonical: string }>} b */
const sameWorkspaces = (a, b) => {
  const key = (/** @type {Array<{ path: string, canonical: string }>} */ list) => JSON.stringify(list.map(entry => [entry.path, entry.canonical]).sort());
  return key(a) === key(b);
};
/** @param {string[]} a @param {string[]} b */
const samePermissions = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * Owns alp-web's credential while this process holds the web lock.
 * @param {{
 *   home: string,
 *   store: import('@anhlp/alp-gateway').CredentialStore,
 *   permissions: string[],
 *   project?: string,
 *   socket: () => string | undefined,
 *   log?: (message: string) => void,
 * }} options
 */
export function createGrant({ home, store, permissions, project, socket, log = () => {} }) {
  const credentialsHome = webGatewayHome(home);
  const placeholder = path.join(credentialsHome, 'no-project');
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  /** One credentials write at a time, in order. @template T @param {() => Promise<T>} run @returns {Promise<T>} */
  const serial = run => { const result = tail.then(run); tail = result.catch(() => {}); return result; };
  /** @type {string | undefined} */
  let id;
  /** The last registry answer, kept while alpd is down. @type {string[]} */
  let known = [];
  /** The refresh under way, if any: a timer tick while one runs joins it rather than queueing another. @type {Promise<boolean> | undefined} */
  let refreshing;

  /** The workspaces to grant now. */
  async function wanted() {
    const roots = await registryRoots(socket());
    if (roots) known = roots;
    const found = await existingWorkspaces([...(project ? [project] : []), ...known]);
    if (found.length) return found;
    await mkdir(placeholder, { recursive: true, mode: 0o700 });
    return existingWorkspaces([placeholder]);
  }

  return {
    get id() { return id; },
    /** Resolves once every queued credentials write has finished. */
    settled: () => tail.then(() => undefined),
    /**
     * Reuses the credential of `token` when it still verifies, else creates one; revokes every other
     * live credential in alp-web's file. Returns the token to publish.
     * @param {{ token?: unknown, credentialId?: unknown }} previous what web.json held
     */
    ensure: previous => serial(async () => {
      // Throws unless the directory is the user's and private; creates it (0700) on the first start.
      await assertPrivateDirectory(credentialsHome, { create: true }).catch(error => {
        throw new Error(`alp web keeps its credentials in ${credentialsHome}, which must be a directory owned by you with private permissions (0700); run chmod 700 on it (${error?.message ?? error})`, { cause: error });
      });
      await store.reload();
      const reused = typeof previous.token === 'string' ? store.verify(previous.token) : undefined;
      let token;
      if (reused && reused.id === previous.credentialId) { id = reused.id; token = /** @type {string} */ (previous.token); }
      else {
        const created = await createCredential(credentialsHome, { label: LABEL, workspaces: (await wanted()).map(entry => entry.path), permissions });
        id = created.credential.id;
        token = created.token;
        log(`created credential ${id}`);
      }
      for (const entry of await listCredentials(credentialsHome)) {
        if (entry.id !== id && !entry.revokedAt) { await revokeCredential(credentialsHome, entry.id); log(`revoked stale credential ${entry.id}`); }
      }
      await store.reload();
      return token;
    }),
    /** Brings the credential's workspaces and permissions in line; keeps its token. Never throws. */
    refresh: () => refreshing ??= serial(async () => {
      if (!id) return false;
      try {
        const current = (await listCredentials(credentialsHome)).find(entry => entry.id === id);
        if (!current || current.revokedAt) return false;
        const workspaces = await wanted();
        const update = {
          ...(sameWorkspaces(current.workspaces, workspaces) ? {} : { workspaces: workspaces.map(entry => entry.path) }),
          ...(samePermissions(current.permissions, permissions) ? {} : { permissions }),
        };
        if (!Object.keys(update).length) return false;
        await updateCredential(credentialsHome, id, update);
        await store.reload();
        log(`updated the grant of ${id}: ${workspaces.length} workspace(s)`);
        return true;
      } catch (error) {
        log(`grant not refreshed: ${/** @type {any} */ (error)?.message ?? error}`);
        return false;
      }
    }).finally(() => { refreshing = undefined; }),
  };
}
