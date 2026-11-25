import { mkdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { assertPrivateDirectory, connect } from '@anhlp/alp-client/index';
import type { AlpClient as Client } from '@anhlp/alp-client/index';
import { createCredential, listCredentials, revokeCredential, updateCredential } from '@anhlp/alp-gateway';
import type { CredentialStore } from '@anhlp/alp-gateway';
import { DEFAULT_PERMISSIONS, PERMISSIONS } from '@anhlp/alp-gateway/policy';
import { isAgentProcess } from '@anhlp/alp-core/tasks';

/**
 * The one gateway credential `alp dashboard` hands the browser (docs/alp/dashboard.md): its token travels in
 * the URL the CLI opens, so it is a real `alpgw1.*` credential with the least the app needs.
 *
 * Single writer: the credentials live in `<home>/dashboard/credentials.json`, a file of alp dashboard's own
 * (not the standalone gateway's `<home>/gateway`). Only the process holding the `dashboard` integration
 * lock writes it, and inside that process every write goes through one queue (`serial`), so no
 * two writes interleave their read-modify-write. Another tool must not write it while the service
 * runs. Because the file is alp dashboard's own, `alp-gateway credential list/revoke` (which read
 * `<home>/gateway`) do not see this credential: `alp dashboard rotate` is the way to replace or end it.
 * The gateway's own checks apply to this path as to its default one: the directory must be the
 * user's and private (0700, checked on every start, not only on a write) and the file 0600 and the
 * user's, else nothing is read or written and the service does not start.
 *
 * Grant: permissions are DEFAULT_PERMISSIONS + workspace.write, plus `dashboard.permissions` from the
 * user's settings when every entry is a permission a credential may hold (with any unknown entry
 * the whole list is ignored, with a warning naming it, so the grant stays the default). Workspaces are alpd's project
 * registry (live projects) ∪ the `--project` directory the caller named; with none, a private
 * empty directory stands in (a credential needs one workspace, and it grants nothing).
 */

export const LABEL = 'alp dashboard (this machine)';
export const BASE_PERMISSIONS = Object.freeze([...DEFAULT_PERMISSIONS, 'workspace.write']);

/** A granted workspace: the path as given, and its real path. */
export type Workspace = { path: string; canonical: string };

/** Where alp dashboard keeps its credentials. */
export const dashboardGatewayHome = (home: string): string => path.join(home, 'dashboard');

/**
 * The permissions to grant: the base set and, when valid, `dashboard.permissions`.
 * @param extra the `dashboard.permissions` setting
 */
export function grantPermissions(extra: unknown, warn: (message: string) => void = () => {}): string[] {
  const wanted = new Set<string>(BASE_PERMISSIONS);
  if (extra !== undefined) {
    const unknown = Array.isArray(extra) ? extra.filter(entry => typeof entry !== 'string' || !PERMISSIONS.includes(entry)) : [extra];
    if (!unknown.length) for (const entry of (extra as string[])) wanted.add(entry);
    else warn(`ignoring dashboard.permissions: ${unknown.map(entry => JSON.stringify(entry)).join(', ')} ${unknown.length === 1 ? 'is not a permission' : 'are not permissions'} a credential may hold (${PERMISSIONS.join(', ')}); the default grant (${BASE_PERMISSIONS.join(', ')}) is in use`);
  }
  // As the gateway stores them: a write permission holds its read (credentials.js checkPermissions).
  if (wanted.has('session.write')) wanted.add('session.read');
  if (wanted.has('project.write') || wanted.has('library.write')) wanted.add('project.read');
  return PERMISSIONS.filter(permission => wanted.has(permission));
}

/**
 * Existing directories among `paths`, as the gateway stores workspaces: absolute and normalized as
 * given, one per real path (the first wins). Anything else is dropped, never resolved further.
 */
export async function existingWorkspaces(paths: Iterable<unknown>): Promise<Workspace[]> {
  const found: Workspace[] = [];
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
 */
export async function registryRoots(socket: string | undefined, { timeoutMs = 3_000 }: { timeoutMs?: number } = {}): Promise<string[] | undefined> {
  if (!socket) return undefined;
  let client: Client | undefined;
  let finished = false;
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), timeoutMs); });
  // A connection that opens after the answer was given up on is closed at once.
  const opened = (value: Client): void => { if (finished) { try { value.close(); } catch {} } else client = value; };
  try { return await Promise.race([listRoots(socket, opened), late]); }
  finally { finished = true; clearTimeout(timer); try { client?.close(); } catch {} }
}

async function listRoots(socket: string, opened: (client: Client) => void): Promise<string[] | undefined> {
  let client: Client | undefined;
  try {
    client = await connect(socket, { name: 'alp-dashboard', version: '1' });
    opened(client);
    const roots: string[] = [];
    let cursor: unknown;
    for (let page = 0; page < 100; page++) {
      // any: alpd's project.list answer, checked field by field below
      const result: any = (await client.request('project.list', { limit: 500, ...(cursor ? { cursor } : {}) }));
      for (const project of result?.projects ?? []) if (typeof project?.root === 'string' && !project.removedAt) roots.push(project.root);
      cursor = result?.nextCursor;
      if (!cursor) return roots;
    }
    return undefined;
  } catch { return undefined; } finally { try { client?.close(); } catch {} }
}


const sameWorkspaces = (a: Workspace[], b: Workspace[]): boolean => {
  const key = (list: Workspace[]): string => JSON.stringify(list.map(entry => [entry.path, entry.canonical]).sort());
  return key(a) === key(b);
};
const samePermissions = (a: string[], b: string[]): boolean => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** The options of createGrant. */
export type GrantOptions = {
  home: string;
  store: CredentialStore;
  permissions: string[];
  project?: string;
  socket: () => string | undefined;
  log?: (message: string) => void;
};

/**
 * Owns alp dashboard's credential while this process holds the dashboard lock.
 */
export function createGrant({ home, store, permissions, project, socket, log = () => {} }: GrantOptions) {
  const credentialsHome = dashboardGatewayHome(home);
  const placeholder = path.join(credentialsHome, 'no-project');
  let tail: Promise<unknown> = Promise.resolve();
  /** One credentials write at a time, in order. */
  const serial = <T>(run: () => Promise<T>): Promise<T> => { const result = tail.then(run); tail = result.catch(() => {}); return result; };
  let id: string | undefined;
  /** The last registry answer, kept while alpd is down. */
  let known: string[] = [];
  /** The refresh under way, if any: a timer tick while one runs joins it rather than queueing another. */
  let refreshing: Promise<boolean> | undefined;

  /** The workspaces to grant now. */
  async function wanted(): Promise<Workspace[]> {
    const roots = await registryRoots(socket());
    if (roots) known = roots;
    const found = await existingWorkspaces([...(project ? [project] : []), ...known]);
    if (found.length) return found;
    await mkdir(placeholder, { recursive: true, mode: 0o700 });
    return existingWorkspaces([placeholder]);
  }

  /** Refuses an agent's process and a credentials directory that is not the user's and private. */
  async function guard(): Promise<void> {
    // Only the user holds alp dashboard's user credential (t-1c59): a process an ALP agent started gets no token.
    if (isAgentProcess()) throw new Error('alp dashboard hands out a user credential; this process was started by an ALP agent (ALP_AGENT_SESSION is set), so it is refused');
    // Throws unless the directory is the user's and private; creates it (0700) on the first start.
    await assertPrivateDirectory(credentialsHome, { create: true }).catch(error => {
      throw new Error(`alp dashboard keeps its credentials in ${credentialsHome}, which must be a directory owned by you with private permissions (0700); run chmod 700 on it (${error?.message ?? error})`, { cause: error });
    });
    await store.reload();
  }

  /** Revokes every live credential but the current one. */
  async function revokeOthers(): Promise<void> {
    for (const entry of await listCredentials(credentialsHome)) {
      if (entry.id !== id && !entry.revokedAt) { await revokeCredential(credentialsHome, entry.id); log(`revoked stale credential ${entry.id}`); }
    }
  }

  return {
    get id() { return id; },
    /** Resolves once every queued credentials write has finished. */
    settled: () => tail.then(() => undefined),
    /**
     * Creates a fresh credential and revokes every other live one in alp dashboard's file (t-cee3):
     * each start of the service mints its own token, which it keeps in memory only, so the token of
     * an earlier start (copied into a transcript, a mail or a file) no longer opens the host. Returns
     * the token; the caller never writes it to disk.
     */
    ensure: () => serial(async () => {
      await guard();
      const created = await createCredential(credentialsHome, { label: LABEL, workspaces: (await wanted()).map(entry => entry.path), permissions });
      id = created.credential.id;
      log(`created credential ${id}`);
      await revokeOthers();
      await store.reload();
      return created.token;
    }),
    /**
     * Revokes every live credential in alp dashboard's file (`alp dashboard rotate` while the service
     * is stopped): no token of an earlier start opens the host until the service starts again.
     */
    revokeAll: () => serial(async () => {
      await guard();
      id = undefined;
      await revokeOthers();
      await store.reload();
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
        log(`grant not refreshed: ${(error as Error | undefined)?.message ?? error}`);
        return false;
      }
    }).finally(() => { refreshing = undefined; }),
  };
}
