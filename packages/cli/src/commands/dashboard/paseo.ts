import { createHash } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { assertPrivateDirectory, discoverIntegration, startIntegration } from '@anhlp/alp-client/index';

/** The Paseo integration (its web app, bridge and relay) runs as integration `paseo`. */
export const PASEO = 'paseo';

/**
 * Starts the Paseo integration. For one release, a home that still has only the descriptor
 * registered before the rename (`integrations/web.json`) keeps working, with a hint to re-register.
 * Exported for tests.
 */
export async function startPaseoIntegration(home: string) {
  const entry = await discoverIntegration(PASEO, { home });
  if (!entry) {
    const legacy = path.join(home, 'integrations', 'web.json');
    const legacyEntry = await legacyDescriptorEntry(legacy, home);
    if (legacyEntry) {
      console.error(`Using the Paseo integration registered before its rename (${legacy}); run \`alp-paseo-integration --register\` to register it again.`);
      return startIntegration({ name: PASEO, entry: legacyEntry, home });
    }
  }
  return startIntegration({ name: PASEO, home });
}

/**
 * The entry named by the pre-rename descriptor `<home>/integrations/web.json`, and nothing else: no
 * environment, distribution or PATH lookup, since the name `web` belonged to alp web after that. A relative
 * `main` resolves against the descriptor's directory, then the home, as discovery does.
 */
async function legacyDescriptorEntry(file: string, home: string): Promise<string | undefined> {
  // A missing or corrupt descriptor is no registration: the caller then reports the missing package.
  const raw = await readFile(file, 'utf8').then(text => JSON.parse(text)).catch(() => undefined);
  const isFile = (candidate: string) => stat(candidate).then(info => info.isFile(), () => false);
  // The fields discovery accepts in a descriptor, in its priority order.
  for (const field of ['main', 'entry', 'path', 'command']) {
    const value = raw?.[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    const candidates = path.isAbsolute(value) ? [value] : [path.resolve(path.dirname(file), value), path.resolve(home, value)];
    for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * alp dashboard pair: the link that pairs Paseo's app on another device with alpd through Paseo's relay
 * (ALPD §64). The device then signs in with the password this command prints: the integration's token,
 * which it keeps in its credential directory `<home>/paseo/` (t-cde5) and hands over only on its
 * private token socket (integrations/paseo/server/web.ts). `--rotate` makes the integration replace
 * it: the old password is refused from then on and every paired device must sign in again.
 */

/** The request lines of the Paseo integration's token socket (integrations/paseo/server/web.ts). */
const PASEO_TOKEN_REQUEST = '{"op":"token"}';
const PASEO_ROTATE_REQUEST = '{"op":"rotate"}';

/**
 * Where the Paseo integration of `home` answers for its token. Must match tokenSocketPath in
 * integrations/paseo/server/web.ts (the CLI does not depend on that package).
 */
export function paseoTokenSocketPath(home: string, { platform = process.platform, uid = process.getuid?.() }: { platform?: NodeJS.Platform; uid?: number } = {}): string {
  const hash = createHash('sha256').update(home).digest('hex');
  if (platform === 'win32') return `\\\\.\\pipe\\alp-paseo-${hash.slice(0, 24)}`;
  const preferred = path.join(home, PASEO, 'token.sock');
  return Buffer.byteLength(preferred) < 100 ? preferred : `/tmp/alp-paseo-${uid ?? 'user'}-${hash.slice(0, 12)}/token.sock`;
}

/**
 * Asks the Paseo integration of `home` for its password over its token socket, or (`rotate`) for a
 * new one. Refuses a socket that is not the user's 0600 socket in a 0700 directory of the user's.
 */
export async function readPaseoToken(home: string, { rotate = false, timeoutMs = 10_000, socketPath = paseoTokenSocketPath(home) }: { rotate?: boolean; timeoutMs?: number; socketPath?: string } = {}): Promise<{ token: string; serverId: string | undefined; pid: number | undefined }> {
  if (process.platform !== 'win32') {
    const directory = path.dirname(socketPath);
    await assertPrivateDirectory(directory).catch(error => {
      throw new Error(`the Paseo integration's token socket must be in a directory owned by you with mode 0700: ${directory} is not (${error?.message ?? error})`, { cause: error });
    });
    const info = await lstat(socketPath);
    if (!info.isSocket()) throw new Error(`the Paseo integration's token socket ${socketPath} is not a socket`);
    if (info.uid !== process.getuid?.()) throw new Error(`the Paseo integration's token socket ${socketPath} is not yours (uid ${info.uid})`);
    if ((info.mode & 0o777) !== 0o600) throw new Error(`the Paseo integration's token socket ${socketPath} must have mode 0600, not ${(info.mode & 0o777).toString(8).padStart(4, '0')}`);
  }
  const text = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(socketPath);
    let received = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error(`the Paseo integration did not answer on ${socketPath} within ${timeoutMs} ms`)); }, timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${rotate ? PASEO_ROTATE_REQUEST : PASEO_TOKEN_REQUEST}\n`));
    socket.on('data', chunk => { received += chunk; if (received.length > 4_096) socket.destroy(); });
    socket.on('error', error => { clearTimeout(timer); reject(error); });
    socket.on('close', () => { clearTimeout(timer); resolve(received); });
  });
  let answer;
  try { answer = JSON.parse(text); } catch { answer = undefined; }
  if (typeof answer?.token !== 'string' || !/^[a-f0-9]{64}$/.test(answer.token)) throw new Error(`the Paseo integration gave no password on ${socketPath}`);
  return { token: answer.token, serverId: typeof answer.serverId === 'string' ? answer.serverId : undefined, pid: Number.isSafeInteger(answer.pid) ? answer.pid : undefined };
}
