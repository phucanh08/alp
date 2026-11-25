/**
 * The service's side of how `alp dashboard [--print]` gets the token of the running service (t-cee3, docs/alp/dashboard.md §4.2).
 *
 * The service mints a fresh credential on every start and keeps its `alpgw1.*` token in memory
 * only: no file under <home> holds it. It answers on a local socket that only the user can
 * connect to:
 *
 * - POSIX: a Unix socket `<home>/dashboard/token.sock` (or, for a home whose path is too long for a
 *   socket address, `<tmpdir>/alp-dashboard-<uid>-<hash>/token.sock`), mode 0600, inside a directory
 *   that is the user's with mode 0700 and whose ancestors no other user may write. The service
 *   checks both after it listens and refuses to run otherwise; the client checks them before it
 *   connects.
 * - Windows: the named pipe `\\.\pipe\alp-dashboard-<sha256(home)[:24]>`, named as alpd's pipe is
 *   (packages/client daemonPaths). Node (libuv) creates it with FILE_FLAG_FIRST_PIPE_INSTANCE, so a
 *   pipe someone else made first makes the service fail to start rather than share the name, and with
 *   the default security descriptor (no lpSecurityAttributes), whose DACL grants full control to
 *   LocalSystem, Administrators and the creator owner (the user), and only READ access to Everyone
 *   and the anonymous account. Node cannot set an explicit DACL. So the token is never written on
 *   connect: the server answers only after the client has WRITTEN a request line, which a handle
 *   opened with read access alone cannot do. The token therefore reaches only a principal with
 *   write access: the user (and LocalSystem/Administrators, who own the machine anyway). Not
 *   checked on a Windows host in t-cee3.
 *
 * The path, the checks and the client are in ../dashboard-service.js (the CLI ships that file, and
 * this one only inside the service's bundle).
 *
 * Protocol: the client writes `{"op":"token"}\n`; the server answers one JSON line
 * `{"token","credentialId","pid"}` and closes. Anything else is closed without an answer.
 *
 * What this does not stop: a process running as the user without an OS sandbox (a full-access agent,
 * or any program of the user's) can connect as the user does. Read-only agents are kept out by their
 * OS sandbox, which denies connecting to a Unix socket.
 */
import { chmod, lstat, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { assertPrivateDirectory } from '@anhlp/alp-client/index';
import { TOKEN_REQUEST, assertTokenSocket, tokenSocketPath } from '../dashboard-service.js';

/** The longest request line the server reads. */
const MAX_REQUEST = 256;

/**
 * Listens on the token socket of `home` and hands `token` to whoever asks on it. Refuses to listen
 * (throws, and leaves no socket) unless the socket is 0600 inside a 0700 directory of the user's.
 * @param options `afterListen` runs between the chmod and the check (tests).
 */
export async function serveToken({ home, token, credentialId, afterListen }: {
  home: string;
  token: () => string | undefined;
  credentialId: () => string | undefined;
  afterListen?: (socketPath: string) => Promise<void>;
}): Promise<{ path: string; close: () => Promise<void> }> {
  const socketPath = tokenSocketPath(home);
  const posix = process.platform !== 'win32';
  if (posix) {
    const directory = path.dirname(socketPath);
    await assertPrivateDirectory(directory, { create: true }).catch(error => {
      throw new Error(`alp dashboard keeps its token socket in ${directory}, which must be a directory owned by you with private permissions (0700); run chmod 700 on it (${error?.message ?? error})`, { cause: error });
    });
    // Left by a service that died: the caller holds the dashboard lock, so no live service owns it.
    const stale = await lstat(socketPath).catch(error => { if (error?.code === 'ENOENT') return undefined; throw error; });
    if (stale && !stale.isSocket()) throw new Error(`${socketPath} exists and is not a socket; remove it, then start alp dashboard again`);
    if (stale) await unlink(socketPath);
  }
  const connections = new Set<net.Socket>();
  const server = net.createServer(socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(5_000, () => socket.destroy());
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      received += chunk;
      const end = received.indexOf('\n');
      if (end < 0) { if (received.length > MAX_REQUEST) socket.destroy(); return; }
      const value = token();
      if (received.slice(0, end).trim() !== TOKEN_REQUEST || !value) { socket.destroy(); return; }
      socket.end(`${JSON.stringify({ token: value, credentialId: credentialId(), pid: process.pid })}\n`);
    });
  });
  const close = async (): Promise<void> => {
    for (const socket of connections) socket.destroy();
    await new Promise(resolve => server.close(() => resolve(undefined)));
    if (posix) await unlink(socketPath).catch(() => {});
  };
  // The socket is created 0600 (umask), then chmod'ed: no moment where it is wider.
  const umask = posix ? process.umask(0o077) : 0;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(undefined); });
    });
  } finally { if (posix) process.umask(umask); }
  try {
    if (posix) await chmod(socketPath, 0o600);
    if (afterListen) await afterListen(socketPath);
    await assertTokenSocket(socketPath);
  } catch (error) { await close(); throw error; }
  return { path: socketPath, close };
}

