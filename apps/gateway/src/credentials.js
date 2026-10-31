// @ts-check
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat, readFile, realpath, rename, stat, writeFile, chmod, unlink } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { alpHome, assertPrivateDirectory } from '@anhlp/alp-client';
import { PERMISSIONS } from './policy.js';

/**
 * Errors Windows intermittently raises when replacing a file that is concurrently open for reading.
 */
export const RETRIABLE_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
export const RENAME_MAX_RETRIES = 8;
export const RENAME_INITIAL_BACKOFF_MS = 10;
export const RENAME_MAX_BACKOFF_MS = 80;

/**
 * Replaces a file atomically, retrying with bounded backoff on Windows (or when encountering
 * EPERM/EACCES/EBUSY) when the destination is temporarily held open by another process or reader.
 * @param {string} temporary
 * @param {string} destination
 * @param {{ retries?: number, initialBackoffMs?: number, maxBackoffMs?: number, sleep?: (ms: number) => Promise<void> }} [options]
 */
export async function renameWithRetry(temporary, destination, {
  retries = RENAME_MAX_RETRIES,
  initialBackoffMs = RENAME_INITIAL_BACKOFF_MS,
  maxBackoffMs = RENAME_MAX_BACKOFF_MS,
  sleep: delayFn = sleep,
} = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(temporary, destination);
      return;
    } catch (error) {
      if (!RETRIABLE_RENAME_ERRORS.has(/** @type {any} */ (error)?.code) || attempt >= retries) {
        throw error;
      }
      const delay = Math.min(initialBackoffMs * (2 ** attempt), maxBackoffMs);
      await delayFn(delay);
    }
  }
}

/**
 * Gateway credentials (docs/alp/remote-gateway.md §4): long-lived bearer tokens that only ever
 * travel in an `Authorization` header to POST /v1/tickets. The gateway keeps a SHA-256 of each
 * token's secret, never the secret; a token is shown once, when it is created or rotated.
 *
 * A credential grants a fixed list of workspaces (project roots on the daemon host, resolved
 * when the credential is created, never from what a client sends), a set of permissions and,
 * optionally, the session modes it may use. The file belongs to the gateway, not to alpd: the
 * gateway reads no ALP business state.
 *
 * An agent credential (`agent: true`, t-53aa) is one the owner made for an ALP agent: every
 * connection it opens is marked to alpd as an agent's (`principal.agent`), whatever the client
 * says in daemon.hello, so alpd refuses it what only the user may do. The mark only takes away;
 * a credential without it keeps what it had, and a client may still mark itself. A credential
 * never loses the mark: make a new one for a user.
 *
 * A named agent credential (t-1c59) also carries the agent's name (`agentName`, which the owner
 * gives with `credential create --agent NAME`): the gateway sends it to alpd in its re-hello as
 * `principal: { agent: NAME }`, so alpd and the logs can tell which agent connected. The name is
 * fixed for the credential's life (reissue may name an unnamed agent credential, never rename
 * one); it never adds access, and a credential with a malformed name is refused, not read as a
 * user's. Only the owner's local CLI makes, changes or revokes credentials; no RPC does.
 *
 * Token: `alpgw1.<id>.<secret>`; id is 16 hex characters, secret 32 random bytes in base64url.
 */

const TOKEN = /^alpgw1\.([a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/;
const FILE_VERSION = 1;
const MODE = /^[a-z][a-z0-9-]{0,63}$/;
/** An agent's name on a credential: lower-case letters, digits and single hyphens, 1 to 64 characters. */
export const AGENT_NAME = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;

/**
 * @typedef {{ path: string, canonical: string }} Workspace
 *   `path` as the owner gave it, `canonical` its real path when the credential was made; a client
 *   names a workspace by either string, exactly.
 * @typedef {{
 *   id: string, label: string, hash: string, workspaces: Workspace[], permissions: string[],
 *   worktreeMappings?: string[], scopeId?: string, modes?: string[], agent?: true, agentName?: string, createdAt: string, rotatedAt?: string, updatedAt?: string, expiresAt?: string, revokedAt?: string,
 * }} StoredCredential
 * @typedef {{
 *   id: string, label: string, workspaces: Workspace[], permissions: Set<string>,
 *   worktreeMappings?: string[], scopeId?: string, modes?: Set<string>, agent?: true, agentName?: string, expiresAt?: number, secretHash: string, fingerprint: string,
 * }} Grant
 */

/** Where the gateway keeps its own files: $ALP_GATEWAY_HOME, else <ALP_HOME>/gateway. @param {NodeJS.ProcessEnv} [env] */
export function gatewayHome(env = process.env) {
  return path.resolve(env.ALP_GATEWAY_HOME || path.join(alpHome(env), 'gateway'));
}

/** @param {string} home */
export const credentialsFile = home => path.join(home, 'credentials.json');

const digest = (/** @type {string} */ secret) => createHash('sha256').update(secret, 'utf8').digest('hex');

/** The id and secret of a well-formed token, or undefined. @param {unknown} token */
export function parseToken(token) {
  const match = typeof token === 'string' ? TOKEN.exec(token) : null;
  return match ? { id: match[1], secret: match[2] } : undefined;
}

function newToken(id = randomBytes(8).toString('hex')) {
  const secret = randomBytes(32).toString('base64url');
  return { id, secret, token: `alpgw1.${id}.${secret}` };
}

/**
 * Reads the credentials file. A missing file holds none; a file others can read, or that is not
 * ours, is refused, as ssh refuses a private key others can read.
 * @param {string} home
 * @returns {Promise<{ version: number, credentials: StoredCredential[] }>}
 */
export async function readCredentials(home) {
  const file = credentialsFile(home);
  const info = await lstat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
  if (!info) return { version: FILE_VERSION, credentials: [] };
  if (!info.isFile()) throw new Error(`${file} is not a regular file`);
  if (process.platform !== 'win32') {
    if (info.uid !== process.getuid?.()) throw new Error(`${file} is not owned by the current user`);
    if (info.mode & 0o077) throw new Error(`${file} is readable by other users; run chmod 600 on it`);
  }
  const data = JSON.parse(await readFile(file, 'utf8'));
  if (data?.version !== FILE_VERSION || !Array.isArray(data.credentials)) throw new Error(`${file} is not a version ${FILE_VERSION} credentials file`);
  return data;
}

/** Writes the file whole, private, and replaces the old one in one rename. @param {string} home @param {{ version: number, credentials: StoredCredential[] }} data */
async function writeCredentials(home, data) {
  await assertPrivateDirectory(home, { create: true });
  const file = credentialsFile(home);
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    await renameWithRetry(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** What a credential may be shown as: everything but its hash. @param {StoredCredential} credential */
export function describeCredential({ hash: _hash, ...rest }) {
  return rest;
}

/**
 * Resolves the workspaces of a new credential on this host: absolute, normalized, existing
 * directories. Done by the owner's command, never with a path a client sent.
 * @param {string[]} workspaces
 * @returns {Promise<Workspace[]>}
 */
async function resolveWorkspaces(workspaces) {
  if (!Array.isArray(workspaces) || !workspaces.length) throw new Error('A credential needs at least one workspace');
  /** @type {Workspace[]} */
  const resolved = [];
  for (const entry of workspaces) {
    if (typeof entry !== 'string' || !path.isAbsolute(entry) || path.resolve(entry) !== entry || entry.includes('\0')) {
      throw new Error(`Workspace ${JSON.stringify(entry)} must be an absolute, normalized path`);
    }
    const canonical = await realpath(entry);
    if (!(await stat(canonical)).isDirectory()) throw new Error(`Workspace ${entry} is not a directory`);
    if (!resolved.some(known => known.canonical === canonical)) resolved.push({ path: entry, canonical });
  }
  return resolved;
}

/** @param {unknown} permissions */
function checkPermissions(permissions) {
  if (!Array.isArray(permissions) || !permissions.length) throw new Error(`A credential needs permissions: ${PERMISSIONS.join(', ')}`);
  for (const permission of permissions) {
    if (!PERMISSIONS.includes(permission)) throw new Error(`Unknown or ungrantable permission ${JSON.stringify(permission)}; a remote credential may hold ${PERMISSIONS.join(', ')}`);
  }
  const granted = new Set(permissions);
  // files.read is held only when named: no other permission implies it, and it implies none.
  // Writing without reading is not a useful grant: a client must see what it does.
  if (granted.has('session.write')) granted.add('session.read');
  if (granted.has('project.write') || granted.has('library.write')) granted.add('project.read');
  return PERMISSIONS.filter(permission => granted.has(permission));
}

/** Host-only named mappings; never paths. @param {unknown} value @returns {string[]} */
function checkMappings(value) {
 if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(id))) throw new Error('worktreeMappings must list host mapping IDs');
 return [...new Set(value)];
}

/** @param {unknown} modes */
function checkModes(modes) {
  if (modes === undefined) return undefined;
  if (!Array.isArray(modes) || !modes.length || modes.some(mode => typeof mode !== 'string' || !MODE.test(mode))) throw new Error('modes must be a non-empty list of session mode ids');
  return [...new Set(modes)];
}

/**
 * `agent`: undefined or false (a user's), true (an unnamed agent credential, as before t-1c59) or
 * an agent name. @param {unknown} agent @returns {{ agent: boolean, name?: string }}
 */
function checkAgent(agent) {
  if (agent === undefined || typeof agent === 'boolean') return { agent: agent === true };
  if (typeof agent !== 'string' || !AGENT_NAME.test(agent) || agent === 'true' || agent === 'false') throw new Error(`agent must be true, false or an agent name (lower-case letters, digits and single hyphens, starting with a letter, at most 64 characters, not true or false); got ${JSON.stringify(agent)}`);
  return { agent: true, name: agent };
}

/**
 * Creates a credential and returns its token, which is not stored and cannot be shown again.
 * `agent: true` makes an agent credential (see above); the default is a user's.
 * @param {string} home
 * @param {{ label: string, workspaces: string[], permissions: string[], worktreeMappings?: string[], modes?: string[], agent?: boolean | string, expiresAt?: string, now?: Date }} options
 */
export async function createCredential(home, { label, workspaces, permissions, worktreeMappings = [], modes, agent, expiresAt, now = new Date() }) {
  if (typeof label !== 'string' || !label.trim() || label.length > 100) throw new Error('A credential needs a label of 1 to 100 characters');
  const forAgent = checkAgent(agent);
  if (expiresAt !== undefined && !(Date.parse(expiresAt) > now.getTime())) throw new Error('expiresAt must be a future ISO 8601 time');
  const data = await readCredentials(home);
  const token = newToken();
  /** @type {StoredCredential} */
  const credential = {
    id: token.id,
    label: label.trim(),
    hash: digest(token.secret),
    workspaces: await resolveWorkspaces(workspaces),
    permissions: checkPermissions(permissions),
    worktreeMappings: checkMappings(worktreeMappings), scopeId: randomBytes(16).toString('hex'),
    ...(checkModes(modes) ? { modes: checkModes(modes) } : {}),
    ...(forAgent.agent ? { agent: true } : {}),
    ...(forAgent.name ? { agentName: forAgent.name } : {}),
    createdAt: now.toISOString(),
    ...(expiresAt ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
  };
  data.credentials.push(credential);
  await writeCredentials(home, data);
  return { credential: describeCredential(credential), token: token.token };
}

/** @param {{ credentials: StoredCredential[] }} data @param {string} id */
function find(data, id) {
  const credential = data.credentials.find(entry => entry.id === id);
  if (!credential) throw new Error(`No credential ${id}`);
  return credential;
}

/**
 * Replaces a credential's secret: the old token stops working at once, also for connections the
 * gateway holds (it closes them), and the grant stays. Returns the new token.
 * @param {string} home @param {string} id @param {{ now?: Date }} [options]
 */
export async function rotateCredential(home, id, { now = new Date() } = {}) {
  const data = await readCredentials(home);
  const credential = find(data, id);
  if (credential.revokedAt) throw new Error(`Credential ${id} is revoked; create a new one`);
  const token = newToken(id);
  Object.assign(credential, { hash: digest(token.secret), rotatedAt: now.toISOString() });
  await writeCredentials(home, data);
  return { credential: describeCredential(credential), token: token.token };
}

/**
 * Locally replaces named grant fields and reissues the secret, keeping the device id.
 * Omitted fields retain their grants; supplied lists replace rather than append. `agent: true`
 * makes it an agent credential; an agent credential stays one (`agent: false` is refused).
 * @param {string} home @param {string} id
 * @param {{ label?: string, workspaces?: string[], permissions?: string[], worktreeMappings?: string[], modes?: string[], agent?: boolean | string, expiresAt?: string, now?: Date }} [options]
 */
export async function reissueCredential(home, id, { label, workspaces, permissions, worktreeMappings, modes, agent, expiresAt, now = new Date() } = {}) {
  const data = await readCredentials(home);
  const credential = find(data, id);
  if (credential.revokedAt) throw new Error(`Credential ${id} is revoked; create a new one`);
  const forAgent = checkAgent(agent);
  if (agent === false && credential.agent !== undefined) throw new Error(`Credential ${id} is an agent credential and stays one; create a new credential for a user`);
  if (forAgent.name && credential.agentName !== undefined && credential.agentName !== forAgent.name) throw new Error(`Credential ${id} belongs to agent ${credential.agentName}; an agent credential is never renamed, create a new one for ${forAgent.name}`);
  if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 100)) throw new Error('A credential needs a label of 1 to 100 characters');
  if (expiresAt !== undefined && !(Date.parse(expiresAt) > now.getTime())) throw new Error('expiresAt must be a future ISO 8601 time');
  const replacement = {
    ...(label !== undefined ? { label: label.trim() } : {}),
    scopeId: randomBytes(16).toString('hex'),
    ...(worktreeMappings !== undefined ? { worktreeMappings: checkMappings(worktreeMappings) } : {}),
    ...(workspaces !== undefined ? { workspaces: await resolveWorkspaces(workspaces) } : {}),
    ...(permissions !== undefined ? { permissions: checkPermissions(permissions) } : {}),
    ...(modes !== undefined ? { modes: checkModes(modes) } : {}),
    ...(forAgent.agent ? { agent: /** @type {true} */ (true) } : {}),
    ...(forAgent.name ? { agentName: forAgent.name } : {}),
    ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
  };
  const token = newToken(id);
  Object.assign(credential, replacement, { hash: digest(token.secret), rotatedAt: now.toISOString() });
  await writeCredentials(home, data);
  return { credential: describeCredential(credential), token: token.token };
}

/**
 * Replaces a credential's workspaces and/or permissions in place, keeping its secret: the token
 * stays valid (new tickets carry the new grant) while the gateway closes the connections opened
 * under the old grant with 4403, so they reconnect under the new one. The device id, scopeId
 * (principal epoch), label, modes and expiry stay; a credential stored without a scopeId derives
 * its epoch from the grant (grantOf), so for it the epoch changes too. Omitted fields retain their
 * grants; supplied lists replace rather than append. Inputs are checked as createCredential checks
 * them, before anything is written.
 * @param {string} home @param {string} id
 * @param {{ workspaces?: string[], permissions?: string[], now?: Date }} [options]
 */
export async function updateCredential(home, id, { workspaces, permissions, now = new Date() } = {}) {
  if (workspaces === undefined && permissions === undefined) throw new Error('An update needs workspaces or permissions');
  const data = await readCredentials(home);
  const credential = find(data, id);
  if (credential.revokedAt) throw new Error(`Credential ${id} is revoked; create a new one`);
  const replacement = {
    ...(workspaces !== undefined ? { workspaces: await resolveWorkspaces(workspaces) } : {}),
    ...(permissions !== undefined ? { permissions: checkPermissions(permissions) } : {}),
  };
  Object.assign(credential, replacement, { updatedAt: now.toISOString() });
  await writeCredentials(home, data);
  return { credential: describeCredential(credential) };
}

/** Revokes a credential for good; the gateway closes its connections. @param {string} home @param {string} id @param {{ now?: Date }} [options] */
export async function revokeCredential(home, id, { now = new Date() } = {}) {
  const data = await readCredentials(home);
  const credential = find(data, id);
  credential.revokedAt ??= now.toISOString();
  await writeCredentials(home, data);
  return describeCredential(credential);
}

/** @param {string} home */
export async function listCredentials(home) {
  return (await readCredentials(home)).credentials.map(describeCredential);
}

/** A grant from a stored credential, or undefined when it can no longer be used. @param {StoredCredential} stored @param {number} now */
function grantOf(stored, now) {
  if (stored.revokedAt) return undefined;
  const expiresAt = stored.expiresAt === undefined ? undefined : Date.parse(stored.expiresAt);
  if (expiresAt !== undefined && !(expiresAt > now)) return undefined;
  const workspaces = Array.isArray(stored.workspaces) ? stored.workspaces.filter(entry => typeof entry?.path === 'string' && typeof entry?.canonical === 'string' && path.isAbsolute(entry.path) && path.isAbsolute(entry.canonical)) : [];
  const permissions = Array.isArray(stored.permissions) ? stored.permissions.filter(permission => PERMISSIONS.includes(permission)) : [];
  if (!workspaces.length || !permissions.length || typeof stored.hash !== 'string' || !/^[a-f0-9]{64}$/.test(stored.hash)) return undefined;
  let mappingIds; try { mappingIds = checkMappings(stored.worktreeMappings ?? []); } catch { return undefined; }
  if (stored.scopeId !== undefined && (typeof stored.scopeId !== 'string' || !/^[a-f0-9]{32}$/.test(stored.scopeId))) return undefined;
  // Anything but `true` in `agent` is not a credential the CLI wrote: refused, not read as a user's.
  if (stored.agent !== undefined && stored.agent !== true) return undefined;
  const agent = stored.agent === true;
  // A name only on an agent credential, and only one the CLI could have written.
  if (stored.agentName !== undefined && (!agent || typeof stored.agentName !== 'string' || !AGENT_NAME.test(stored.agentName))) return undefined;
  const agentName = stored.agentName;
  return /** @type {Grant} */ ({
    id: stored.id,
    label: String(stored.label ?? ''),
    workspaces: workspaces.map(({ path: given, canonical }) => ({ path: given, canonical })),
    permissions: new Set(permissions),
    worktreeMappings: mappingIds, scopeId: stored.scopeId ?? digest(JSON.stringify([workspaces, permissions, stored.worktreeMappings ?? []])),
    ...(Array.isArray(stored.modes) ? { modes: new Set(stored.modes.filter(mode => typeof mode === 'string')) } : {}),
    ...(agent ? { agent: true } : {}),
    ...(agentName ? { agentName } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    secretHash: stored.hash,
    // The mark is appended only when set: a user credential's fingerprint (its epoch, when it has
    // no scopeId) stays what it was; gaining the mark changes it, so its connections close.
    fingerprint: JSON.stringify([workspaces, permissions, stored.modes ?? null, stored.expiresAt ?? null, stored.worktreeMappings ?? [], stored.scopeId ?? null, ...(agent ? ['agent'] : []), ...(agentName ? [agentName] : [])]),
  });
}

/**
 * The credentials a running gateway checks tokens against. It reloads the file when it changes
 * (the CLI writes it with one rename) and tells listeners which credentials were revoked, rotated
 * or expired (`revoked`) or got another grant (`changed`), so their connections close. A file
 * that cannot be read safely counts as holding no credentials: the gateway fails closed.
 */
export class CredentialStore {
  /** @type {Map<string, StoredCredential>} */ #stored = new Map();
  /** @type {Map<string, Grant>} */ #grants = new Map();
  /** @type {Set<(changes: Map<string, 'revoked' | 'changed'>) => void>} */ #listeners = new Set();
  /** @type {ReturnType<typeof setInterval> | undefined} */ #timer;
  #signature = '';
  #home;
  #log;
  #now;

  /**
   * @param {{ home: string, logger?: import('@anhlp/alp-core/log').Logger, pollMs?: number, now?: () => number }} options
   */
  constructor({ home, logger, pollMs = 1000, now = Date.now }) {
    this.#home = home;
    this.#log = logger;
    this.#now = now;
    if (pollMs > 0) {
      this.#timer = setInterval(() => void this.#poll(), pollMs);
      this.#timer.unref?.();
    }
  }

  /** Reads the file now; also the first load. Never throws: an unreadable file holds nothing. */
  async reload() {
    /** @type {StoredCredential[]} */
    let list = [];
    try {
      list = (await readCredentials(this.#home)).credentials;
    } catch (error) {
      this.#log?.error('the credentials file cannot be used; every credential is refused until it is fixed', { code: 'ALP_GATEWAY_CREDENTIALS_UNREADABLE', error });
    }
    this.#stored = new Map(list.filter(entry => typeof entry?.id === 'string').map(entry => [entry.id, entry]));
    this.#refresh();
  }

  /** Re-evaluates expiry; the gateway calls it on a timer so expired grants close their connections. */
  expire() { this.#refresh(); }

  #refresh() {
    const now = this.#now();
    const previous = this.#grants;
    /** @type {Map<string, Grant>} */
    const grants = new Map();
    for (const [id, stored] of this.#stored) {
      const grant = grantOf(stored, now);
      if (grant) grants.set(id, grant);
    }
    this.#grants = grants;
    /** @type {Map<string, 'revoked' | 'changed'>} */
    const changes = new Map();
    for (const [id, before] of previous) {
      const after = grants.get(id);
      // Gone, revoked, expired or rotated: the token those connections authenticated with is dead.
      if (!after || after.secretHash !== before.secretHash) changes.set(id, 'revoked');
      else if (after.fingerprint !== before.fingerprint) changes.set(id, 'changed');
    }
    if (changes.size) for (const listener of [...this.#listeners]) { try { listener(changes); } catch {} }
  }

  async #poll() {
    const file = credentialsFile(this.#home);
    const info = await stat(file).catch(() => undefined);
    const signature = info ? `${info.ino}:${info.size}:${info.mtimeMs}:${info.mode}` : 'missing';
    if (signature === this.#signature) { this.#refresh(); return; }
    this.#signature = signature;
    await this.reload();
  }

  /**
   * The grant a token carries, or undefined; compares in constant time and does the same work
   * for an unknown id.
   * @param {unknown} token
   */
  verify(token) {
    const parsed = parseToken(token);
    const presented = Buffer.from(digest(parsed?.secret ?? 'x'), 'hex');
    const stored = parsed ? this.#stored.get(parsed.id) : undefined;
    const expected = Buffer.from(stored && /^[a-f0-9]{64}$/.test(stored.hash) ? stored.hash : '0'.repeat(64), 'hex');
    const same = timingSafeEqual(presented, expected);
    if (!parsed || !stored || !same) return undefined;
    return this.grant(parsed.id);
  }

  /** The current grant of a credential, if it is still usable. @param {string} id */
  grant(id) {
    const grant = this.#grants.get(id);
    if (grant?.expiresAt !== undefined && !(grant.expiresAt > this.#now())) return undefined;
    return grant;
  }

  /** @param {(changes: Map<string, 'revoked' | 'changed'>) => void} listener */
  onChange(listener) { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }

  close() {
    if (this.#timer) clearInterval(this.#timer);
    this.#listeners.clear();
  }
}
