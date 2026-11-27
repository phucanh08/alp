import { createHash } from 'node:crypto';
import { readFile, realpath, stat, lstat, mkdir, readlink, readdir, chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { NATIVE_DAEMON } from '@anhlp/alp-core/packaged';
import type { Stats } from 'node:fs';

export function alpHome(env: NodeJS.ProcessEnv = process.env): string {
  return path.resolve(env.ALP_HOME || path.join(os.homedir(), '.alp'));
}

/** Windows uses named pipes; long Unix homes get a short socket in the temp directory. */
export function daemonPaths(home: string) {
  const preferred = path.join(home, 'alpd.sock');
  const socket = process.platform === 'win32'
    ? `\\\\.\\pipe\\alpd-${createHash('sha256').update(home).digest('hex').slice(0, 24)}`
    : Buffer.byteLength(preferred) < 100
    ? preferred
    : path.join(os.tmpdir(), `alpd-${process.getuid?.() ?? 'user'}-${createHash('sha256').update(home).digest('hex').slice(0, 12)}`, 'rpc.sock');
  return { home, lock: path.join(home, 'alpd.lock'), hold: path.join(home, 'alpd.lock.held'), socket, log: path.join(home, 'logs', 'alpd.log'), install: path.join(home, 'alpd.json') };
}

/** IPC trusts the OS user, not every local process. Existing unsafe directories fail closed.
 * Windows mode bits do not describe named-pipe ACLs; those remain an OS deployment assumption. */
async function assertSafeAncestors(directory: string) {
  if (process.platform === 'win32') return;
  const absolute = path.isAbsolute(directory) ? directory : `${process.cwd()}/${directory}`;
  let current = path.parse(absolute).root;
  const pending = absolute.slice(current.length).split('/');
  let links = 0;
  // Follow every link expansion, including intermediate targets that realpath hides.
  // Check a directory before entering it; never create beneath an unsafe parent.
  while (pending.length) {
    const part = pending.shift();
    if (!part || part === '.') continue;
    if (part === '..') { current = path.dirname(current); continue; }
    const candidate = path.join(current, part);
    const info = await lstat(candidate).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!info) { current = candidate; continue; }
    const trustedOwner = info.uid === 0 || info.uid === process.getuid?.();
    if (!trustedOwner) throw new Error('IPC requires ancestors owned by the current user or root');
    if (info.isSymbolicLink()) {
      if (++links > 40) throw new Error('IPC ancestor symlink loop');
      const target = await readlink(candidate);
      if (path.isAbsolute(target)) current = path.parse(target).root;
      pending.unshift(...target.slice(path.isAbsolute(target) ? path.parse(target).root.length : 0).split('/'));
      continue;
    }
    // Sticky shared temp directories prevent users replacing each other's entries.
    if (!info.isDirectory() || ((info.mode & 0o022) && !(info.mode & 0o1000))) {
      throw new Error('IPC requires trusted ancestors without shared write permissions');
    }
    current = candidate;
  }
}

export async function assertPrivateDirectory(directory: string, { create = false }: { create?: boolean } = {}): Promise<void> {
  await assertSafeAncestors(directory);
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  let info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('IPC requires a private directory, not a symlink');
  if (process.platform === 'win32') return;
  const shown = JSON.stringify(directory);
  const mine = (entry: Stats) => entry.isDirectory() && !entry.isSymbolicLink() && entry.uid === process.getuid?.();
  if (info.uid !== process.getuid?.()) throw new Error(`IPC directory ${shown} must be owned by the current user (it belongs to uid ${info.uid}); use a directory of your own`);
  if ((info.mode & 0o077) === 0) return;
  // t-37f1: a directory the user made for ALP (mkdir, mktemp) and left at 0755 is still empty:
  // ALP tightens it. One that holds anything is left alone, with the exact command to fix it.
  if (create && (await readdir(directory)).length === 0) {
    await chmod(directory, 0o700).catch(() => {});
  }
  // Re-read: another ALP process may have tightened it meanwhile (and filled it).
  info = await lstat(directory);
  if (mine(info) && (info.mode & 0o077) === 0) return;
  // Single quotes, so the command is safe to paste into a POSIX shell.
  const quoted = `'${directory.replaceAll("'", "'\\''")}'`;
  throw new Error(`IPC directory ${shown} must have private permissions (0700), not ${(info.mode & 0o777).toString(8).padStart(4, '0')}; fix it with: chmod 700 ${quoted}`);
}

export async function assertPrivateSocket(socketPath: string): Promise<Stats | undefined> {
  if (process.platform === 'win32') return;
  await assertPrivateDirectory(path.dirname(socketPath));
  const info = await lstat(socketPath);
  if (!info.isSocket() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new Error('IPC socket must be owned by the current user with private permissions (0600)');
  }
  return info;
}

export const isFile = (file: string) => stat(file).then(info => info.isFile(), () => false);

/** Global bin directories that a GUI app's PATH may lack. */
export const BIN_DIRECTORIES = [path.join(os.homedir(), '.alp', 'bin'), path.join(os.homedir(), '.npm-global', 'bin'), path.join(os.homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];

/** The npm package that ships the `alp` command and alpd. */
const CLI_PACKAGES = ['@anhlp/alp', '@anhlp/alp-cli'];

/**
 * alpd behind an `alp` found on PATH (its real path), or undefined: the ALP bundle's launcher
 * (<bundle>/bin/alp or alp.cmd, t-1807; its native alpd when it ships one, t-81b0.9, else its alpd.js), npm's @anhlp/alp-cli (dist/cli.js) or the @anhlp/alp wrapper (bin/alp.js),
 * which depends on @anhlp/alp-cli (installed beside it, or in its own node_modules). On Windows an
 * alp.cmd shim of npm or install.ps1 is followed to the script it runs (t-1f14).
 */
async function cliDaemonEntry(cli: string, depth = 0, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const base = path.basename(cli).toLowerCase();
  const root = path.resolve(path.dirname(cli), '..');
  const alpd = (directory: string) => path.join(directory, 'dist', 'alpd.js');
  const named = async (directory: string) => readFile(path.join(directory, 'package.json'), 'utf8').then(text => JSON.parse(text)?.name).catch(() => undefined);
  let candidates: string[] = [];
  if (base === 'alp.cmd' && depth < 1 && !await isFile(path.join(root, 'alp-bundle.json'))) {
    // A Windows shim that is not the bundle's own: npm's ("%dp0%\node_modules\@anhlp\alp\bin\alp.js")
    // or install.ps1's ("<root>\app\current\lib\node_modules\@anhlp\alp-cli\dist\cli.js"): follow the script it runs.
    const text = await stat(cli).then(info => info.size <= 64 * 1024 ? readFile(cli, 'utf8') : '', () => '');
    for (const [, quoted] of text.matchAll(/"([^"\r\n]+\.js)"/gi)) {
      const script = quoted.replace(/^%~?dp0%?[\\/]?/i, `${path.dirname(cli)}${path.sep}`);
      const entry = path.isAbsolute(script) && await isFile(script) ? await cliDaemonEntry(script, depth + 1, env) : undefined;
      if (entry) return entry;
    }
    return undefined;
  }
  if (base === 'alp' || base === 'alp.cmd') {
    // A bundle: bin/ beside alp-bundle.json; name alpd through app/current when that is this bundle.
    if (!await isFile(path.join(root, 'alp-bundle.json'))) return undefined;
    const current = path.join(path.dirname(root), 'current');
    const viaCurrent = await realpath(current).then(real => real === root, () => false);
    const bundle = viaCurrent ? current : root;
    // The native alpd first (t-81b0.9), as the bundle's own `alp` starts it; alpd.js where it ships none.
    candidates = [...(env.ALP_NATIVE_DAEMON === '0' ? [] : [path.join(bundle, 'bin', NATIVE_DAEMON)]), alpd(path.join(bundle, 'lib', 'node_modules', '@anhlp', 'alp-cli'))];
  } else if (base === 'cli.js' && CLI_PACKAGES.includes(await named(root))) {
    candidates = [alpd(root)];
  } else if (base === 'alp.js' && await named(root) === '@anhlp/alp') {
    candidates = [alpd(path.join(root, 'node_modules', '@anhlp', 'alp-cli')), alpd(path.join(root, '..', 'alp-cli'))];
  }
  for (const candidate of candidates) if (await isFile(candidate)) return candidate;
  return undefined;
}

/**
 * Finds alpd.js for a client that cannot locate it beside itself, such as the Paseo
 * plugin, which Paseo re-bundles: the first existing candidate, then where alpd last
 * recorded itself ($ALP_HOME/alpd.json), then the ALP CLI (`alp`) on PATH and in the usual install
 * directories (`binDirectories`; a test passes [] so the caller's own install is not found).
 */
export async function findDaemonEntry({ home = alpHome(), env = process.env, candidates = [], binDirectories = BIN_DIRECTORIES }: { home?: string, env?: NodeJS.ProcessEnv, candidates?: Array<string | undefined>, binDirectories?: string[] } = {}): Promise<string | undefined> {
  for (const candidate of candidates) if (candidate && await isFile(candidate)) return candidate;
  try {
    const { entry } = JSON.parse(await readFile(daemonPaths(home).install, 'utf8'));
    if (typeof entry === 'string' && await isFile(entry)) return entry;
  } catch {}
  for (const directory of [...(env.PATH ?? '').split(path.delimiter).filter(Boolean), ...binDirectories]) {
    for (const name of process.platform === 'win32' ? ['alp.cmd', 'alp'] : ['alp']) {
      const cli = await realpath(path.join(directory, name)).catch(() => undefined);
      const entry = cli && await cliDaemonEntry(cli, 0, env);
      if (entry) return entry;
    }
  }
  return undefined;
}
