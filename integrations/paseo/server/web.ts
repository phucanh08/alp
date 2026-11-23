import { createHash, randomBytes } from 'node:crypto';
import { chmod, link, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { MAX_FRAME } from '@anhlp/alp-client/index';
import { assertPrivateDirectory } from '@anhlp/alp-client/index';

/**
 * The Paseo integration's local listener (ALPD §61, §62): a socket on 127.0.0.1, at a port the
 * system picks (alp dashboard owns `dashboard.port` and dashboard.json), that speaks Paseo's protocol through the
 * bridge. The socket needs the integration's token, which is also the password Paseo's app asks
 * for. Only `daemon.get_status` (which reports this address) and token-authenticated Paseo sockets
 * use this listener; relay sockets attach to the bridge directly.
 * It served Paseo's web app (paseo-web) until that app was removed (t-55ce.3); `alp dashboard` now serves
 * ALP's own app (apps/web), so this listener answers plain HTTP requests with 404. Requests must
 * name this host and port (no DNS rebinding). Only clients without an Origin header may open
 * the socket; browser origins are refused now that this listener serves no browser app.
 *
 * Credentials (t-cde5). The token is made once and kept, so a paired device survives restarts, but
 * not in paseo.json: it lives in the credential directory `<home>/paseo/` (mode 0700), in
 * `token.json` (0600), beside the relay's key pair (`relay-keypair.json`, ./paseo/relay.ts). A
 * read-only agent session is denied reading that directory (packages/runtime claude-transport.ts and
 * acp-transport.ts). paseo.json names only the pid, port, URL and server id. A token an earlier
 * version left in paseo.json, in the pre-rename web.json, or a key pair left at
 * `<home>/relay-keypair.json` moves into the directory on the next start and leaves the old place.
 *
 * `alp dashboard pair` gets the token over a local socket only the user can connect to (the same
 * shape as alp dashboard's, packages/cli/src/dashboard/token-socket.js):
 * - POSIX: `<home>/paseo/token.sock`, or for a home whose path is too long for a socket address
 *   `/tmp/alp-paseo-<uid>-<hash>/token.sock`; mode 0600 inside a directory of the user's with mode
 *   0700 whose ancestors no other user may write. The integration checks both after it listens and
 *   refuses to start otherwise; the CLI checks them before it connects.
 * - Windows: the named pipe `\\.\pipe\alp-paseo-<sha256(home)[:24]>`, created first-instance with
 *   the default security descriptor, which lets other accounts open it for reading only; so nothing
 *   is written on connect: the answer comes only after the client has WRITTEN a request line. Not
 *   checked on a Windows host in t-cde5.
 * Protocol: the client writes `{"op":"token"}` (or `{"op":"rotate"}`, which makes and keeps a new
 * token, ends every connected device's socket and restarts the relay) and a newline; the answer is
 * one JSON line `{"token","serverId","pid"}`. Anything else is closed without an answer.
 * What this does not stop: a process running as the user without an OS sandbox can connect as the
 * user does (full-access agents are outside t-cde5, as in t-cee3).
 */

/**
 * @deprecated The integration no longer listens on the dashboard's port (alp dashboard does); it binds port 0.
 * Kept for one release for importers of `@anhlp/alp-paseo/web`.
 */
export const DEFAULT_WEB_PORT = 7433;
const BEARER_PREFIX = 'paseo.bearer.';
function bearerOf(protocols: Iterable<string>) { for (const protocol of protocols) if (protocol.startsWith(BEARER_PREFIX)) return protocol; return undefined; }
/** Ports tried after a busy one. */
const PORT_TRIES = 10;

/** What listen() returns: what paseo.json names, and the token, which stays in memory and in the credential directory. */
export type WebInfo = { port: number; token: string; url: string; pid: number; serverId: string };

/** The Paseo bridge: each socket it is given speaks Paseo's protocol over alpd. */
export type WebGateway = { attach(ws: any, options?: { bearer?: string }): void; close?(): void | Promise<void> };
/** @deprecated Pass `gateway`; `dir` is ignored since Paseo's web app was removed. Kept for one release. */
export type WebApp = { dir?: string; gateway: WebGateway };

/** Where the integration records its address and server id: `<home>/paseo.json` (no token since t-cde5). */
export function webFile(home: string) {
  return path.join(home, 'paseo.json');
}

/** The integration's credential directory (t-cde5): the token and the relay's key pair, nothing else. */
export function credentialDir(home: string) {
  return path.join(home, 'paseo');
}

/** The token, as `{"v":1,"token"}`. */
export function tokenFile(home: string) {
  return path.join(credentialDir(home), 'token.json');
}

/** The relay's key pair (./paseo/relay.ts). */
export function relayKeyFile(home: string) {
  return path.join(credentialDir(home), 'relay-keypair.json');
}

/** Where the relay's key pair was kept before t-cde5. */
export function legacyRelayKeyFile(home: string) {
  return path.join(home, 'relay-keypair.json');
}

/** Before the rename the integration kept its identity in `<home>/web.json`, which alp-web now owns. */
const legacyWebFile = (home: string) => path.join(home, 'web.json');

const TOKEN = /^[a-f0-9]{64}$/;
const SERVER_ID = /^alp-[a-f0-9]{16}$/;
const validToken = (value: unknown) => typeof value === 'string' && TOKEN.test(value) ? value : undefined;
const validServerId = (value: unknown) => typeof value === 'string' && SERVER_ID.test(value) ? value : undefined;
const readJson = async (file: string): Promise<any> => { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; } };
const without = (value: Record<string, unknown>, key: string) => { const { [key]: _dropped, ...rest } = value; return rest; };

/**
 * Writes `text` to `file` private (0600) and whole: a fresh temporary file (never one left by
 * another process), then renamed into place, or with `create` linked so an existing file is kept.
 * Returns false when `create` found the file there.
 */
export async function writePrivate(file: string, text: string, { create = false }: { create?: boolean } = {}) {
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600);
    if (!create) { await rename(temporary, file); return true; }
    try { await link(temporary, file); return true; } catch (error: any) { if (error?.code === 'EEXIST') return false; throw error; }
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Makes the credential directory, or refuses one that is not the user's with mode 0700. */
export async function ensureCredentialDir(home: string) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const directory = credentialDir(home);
  await assertPrivateDirectory(directory, { create: true }).catch(error => {
    throw new Error(`The Paseo integration keeps its password and relay key in ${directory}, which must be a directory owned by you with mode 0700 (${error?.message ?? error})`, { cause: error });
  });
  return directory;
}

/**
 * Moves a relay key pair from its place before t-cde5 into the credential directory; when the
 * directory has one already, the old copy is removed. Assumes the directory exists.
 */
export async function moveLegacyRelayKey(home: string) {
  const old = legacyRelayKeyFile(home);
  const info = await lstat(old).catch(() => undefined);
  if (!info?.isFile()) return false;
  const kept = await lstat(relayKeyFile(home)).then(() => true, () => false);
  if (kept) await unlink(old);
  else { await chmod(old, 0o600).catch(() => {}); await rename(old, relayKeyFile(home)); }
  return true;
}

/**
 * The token and the server id, made once and kept, so a paired device survives alpd restarts. The
 * token is read from the credential directory; without one there, a token an earlier version kept
 * in paseo.json (or, without paseo.json, in the pre-rename web.json: one of alp web, 0.0.1-beta.8
 * and earlier, names `app: 'alp-web'` and is never read) is moved there. Every start then removes
 * the token from paseo.json and that web.json, and moves an old relay key pair.
 */
async function lastIdentity(home: string, log: (message: string) => void) {
  await ensureCredentialDir(home);
  const published = await readJson(webFile(home));
  const publishedObject = published && typeof published === 'object' ? published : undefined;
  const legacy = await readJson(legacyWebFile(home));
  const legacyIdentity = legacy && typeof legacy === 'object' && legacy.app === undefined ? legacy : undefined;
  // As before t-cde5: web.json speaks only for a home without paseo.json.
  const carried = publishedObject ? publishedObject : await lstat(webFile(home)).then(() => undefined, () => legacyIdentity);
  let token = validToken((await readJson(tokenFile(home)))?.token);
  if (!token) {
    const previous = validToken(carried?.token);
    token = previous ?? randomBytes(32).toString('hex');
    await writePrivate(tokenFile(home), `${JSON.stringify({ v: 1, token })}\n`);
    if (previous) log(`moved the Paseo password into ${tokenFile(home)}`);
  }
  const serverId = validServerId(carried?.serverId) ?? `alp-${randomBytes(8).toString('hex')}`;
  // The copies outside the credential directory go: paseo.json is written again by listen(), whole.
  if (publishedObject && 'token' in publishedObject) await writePrivate(webFile(home), JSON.stringify(without(publishedObject, 'token')));
  if (legacyIdentity && 'token' in legacyIdentity) await writePrivate(legacyWebFile(home), JSON.stringify(without(legacyIdentity, 'token')));
  if (await moveLegacyRelayKey(home)) log(`moved the relay key pair into ${relayKeyFile(home)}`);
  return { token, serverId };
}

/** The request lines of the token socket. */
export const TOKEN_REQUEST = '{"op":"token"}';
export const ROTATE_REQUEST = '{"op":"rotate"}';
/** The longest request line the socket reads. */
const MAX_REQUEST = 256;

/**
 * Where the integration of `home` answers for its token: a Unix socket in the credential directory,
 * or under /tmp when that path is too long for a socket address (/tmp, not TMPDIR, so a client with
 * another TMPDIR finds it); a named pipe on Windows. Must match packages/cli/src/interfaces.js.
 */
export function tokenSocketPath(home: string, { platform = process.platform, uid = process.getuid?.() }: { platform?: NodeJS.Platform; uid?: number } = {}) {
  const hash = createHash('sha256').update(home).digest('hex');
  if (platform === 'win32') return `\\\\.\\pipe\\alp-paseo-${hash.slice(0, 24)}`;
  const preferred = path.join(credentialDir(home), 'token.sock');
  return Buffer.byteLength(preferred) < 100 ? preferred : `/tmp/alp-paseo-${uid ?? 'user'}-${hash.slice(0, 12)}/token.sock`;
}

/** Throws unless `socketPath` is a socket of the user's, mode 0600, in a directory of the user's with mode 0700 (POSIX). */
export async function assertTokenSocket(socketPath: string) {
  if (process.platform === 'win32') return;
  const directory = path.dirname(socketPath);
  await assertPrivateDirectory(directory).catch(error => {
    throw new Error(`The Paseo integration's token socket must be in a directory owned by you with mode 0700: ${directory} is not (${error?.message ?? error})`, { cause: error });
  });
  const info = await lstat(socketPath);
  if (!info.isSocket()) throw new Error(`The Paseo integration's token socket ${socketPath} is not a socket`);
  if (info.uid !== process.getuid?.()) throw new Error(`The Paseo integration's token socket ${socketPath} is not yours (uid ${info.uid})`);
  if ((info.mode & 0o777) !== 0o600) throw new Error(`The Paseo integration's token socket ${socketPath} must have mode 0600, not ${(info.mode & 0o777).toString(8).padStart(4, '0')}`);
}

/**
 * Listens on the token socket of `home`; `answer` gives the line for a request. Refuses to listen
 * (throws, and leaves no socket) unless the socket is 0600 inside a 0700 directory of the user's.
 * The caller holds the integration lock, so a socket file already there is a dead integration's.
 */
export async function serveToken({ home, answer, afterListen }: {
  home: string;
  answer: (op: 'token' | 'rotate') => Promise<Record<string, unknown> | undefined>;
  /** Runs between the chmod and the check (tests). */
  afterListen?: (socketPath: string) => Promise<void>;
}) {
  const socketPath = tokenSocketPath(home);
  const posix = process.platform !== 'win32';
  if (posix) {
    const directory = path.dirname(socketPath);
    await assertPrivateDirectory(directory, { create: true }).catch(error => {
      throw new Error(`The Paseo integration keeps its token socket in ${directory}, which must be a directory owned by you with mode 0700; run chmod 700 on it (${error?.message ?? error})`, { cause: error });
    });
    const stale = await lstat(socketPath).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error; });
    if (stale && !stale.isSocket()) throw new Error(`${socketPath} exists and is not a socket; remove it, then start the Paseo integration again`);
    if (stale) await unlink(socketPath);
  }
  const connections = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5_000, () => socket.destroy());
    let received = '';
    let asked = false;
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      if (asked) return;
      received += chunk;
      const end = received.indexOf('\n');
      if (end < 0) { if (received.length > MAX_REQUEST) socket.destroy(); return; }
      asked = true;
      const line = received.slice(0, end).trim();
      const op = line === TOKEN_REQUEST ? 'token' : line === ROTATE_REQUEST ? 'rotate' : undefined;
      if (!op) { socket.destroy(); return; }
      answer(op).then(value => { if (value) socket.end(`${JSON.stringify(value)}\n`); else socket.destroy(); }, () => socket.destroy());
    });
  });
  const close = async () => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(() => resolve(undefined)));
    if (posix) await unlink(socketPath).catch(() => {});
  };
  // The socket is created 0600 (umask), then chmod'ed: no moment where it is wider.
  const umask = posix ? process.umask(0o077) : 0;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
  } finally { if (posix) process.umask(umask); }
  try {
    if (posix) await chmod(socketPath, 0o600);
    if (afterListen) await afterListen(socketPath);
    await assertTokenSocket(socketPath);
  } catch (error) { await close(); throw error; }
  return { path: socketPath, close };
}

/** What every plain HTTP request gets: there is no page here. */
const NO_PAGE = 'Not found: this is the Paseo bridge\'s socket, not a web page. Open ALP\'s web app with `alp dashboard`.\n';

export function createWebServer({ gateway: given, app, home, port = 0, log = () => {}, onRotate }: {
  /** The bridge each authenticated socket is attached to; without it the socket is refused. */
  gateway?: WebGateway;
  /** Runs after a rotation has ended this listener's sockets: the relay's devices are ended there (main.ts). */
  onRotate?: () => void | Promise<void>;
  /** @deprecated Use `gateway`. */
  app?: WebApp;
  home: string;
  /** 0 (the default) lets the system pick; a fixed port is tried with the next nine. */
  port?: number;
  log?: (message: string) => void;
}) {
  const gateway = given ?? app?.gateway;
  let token = '';
  let tokenSocket: { path: string; close: () => Promise<void> } | undefined;
  let rotation: Promise<string> = Promise.resolve('');
  let serverId = '';
  let bound = 0;
  const hosts = () => new Set([`127.0.0.1:${bound}`, `localhost:${bound}`]);
  const headers = {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  };

  const server = http.createServer((request, response) => {
    if (!hosts().has(request.headers.host ?? '')) { response.writeHead(403, headers).end('Forbidden host\n'); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405, headers).end(); return; }
    response.writeHead(404, headers);
    response.end(request.method === 'HEAD' ? undefined : NO_PAGE);
  });

  // Track raw connections too: incomplete HTTP requests and upgrades can outlive server.close.
  const connections = new Set<import('node:net').Socket>();
  server.on('connection', socket => { connections.add(socket); socket.once('close', () => connections.delete(socket)); });

  // A browser carries Paseo's password as a subprotocol and needs it echoed to keep the socket.
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, handleProtocols: protocols => bearerOf(protocols) ?? false });
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const refuse = (status: string) => { socket.end(`HTTP/1.1 ${status}\r\n\r\n`); };
    if (url.pathname !== '/ws' || !hosts().has(request.headers.host ?? '')) return refuse('403 Forbidden');
    if (request.headers.origin !== undefined) return refuse('403 Forbidden');
    if (!gateway) return refuse('404 Not Found');
    // The token comes with the hello (or as the subprotocol) and the gateway checks it.
    sockets.handleUpgrade(request, socket, head, ws => gateway.attach(ws, { bearer: ws.protocol || undefined }));
  });

  /**
   * A new token, kept before it is used: the old one is refused from now on, and every socket that
   * signed in with it is ended (this listener's here, the relay's by onRotate). One at a time.
   */
  const rotate = () => {
    rotation = rotation.catch(() => '').then(async () => {
      const next = randomBytes(32).toString('hex');
      await writePrivate(tokenFile(home), `${JSON.stringify({ v: 1, token: next })}\n`);
      token = next;
      for (const client of sockets.clients) client.terminate();
      await onRotate?.();
      log('rotated the Paseo password: devices sign in again with the new one');
      return next;
    });
    return rotation;
  };

  return {
    get token() { return token; },
    get serverId() { return serverId; },
    /** The token socket's path once listening. */
    get tokenSocket() { return tokenSocket?.path; },
    rotate,
    /**
     * Listens on `port` (or the first free one after it), serves the token socket, and records where
     * in paseo.json (without the token). A token socket that cannot be made private stops the start.
     */
    async listen(): Promise<WebInfo> {
      ({ token, serverId } = await lastIdentity(home, log));
      for (let attempt = 0; ; attempt++) {
        const candidate = port + attempt;
        try {
          await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(candidate, '127.0.0.1', () => { server.off('error', reject); resolve(); });
          });
          bound = candidate;
          break;
        } catch (error: any) {
          if (error?.code !== 'EADDRINUSE' || attempt + 1 >= PORT_TRIES || port === 0) throw error;
          log(`port ${candidate} is in use; trying ${candidate + 1}`);
        }
      }
      bound = (server.address() as { port: number }).port;
      try {
        tokenSocket = await serveToken({ home, answer: async op => ({ token: op === 'rotate' ? await rotate() : token, serverId, pid: process.pid }) });
      } catch (error) {
        await new Promise<void>(resolve => server.close(() => resolve()));
        throw error;
      }
      const published = { port: bound, url: `http://127.0.0.1:${bound}/`, pid: process.pid, serverId };
      await writePrivate(webFile(home), JSON.stringify(published));
      return { ...published, token };
    },

    async close() {
      await tokenSocket?.close();
      tokenSocket = undefined;
      for (const client of sockets.clients) client.terminate();
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const connection of connections) connection.destroy();
      await closed;
      await gateway?.close?.();
    },
  };
}
