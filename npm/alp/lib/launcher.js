// The `alp` command of the npm package @anhlp/alp (t-cd7f): a launcher, not ALP itself. npm installs
// the ALP executable for this machine as one optional dependency, @anhlp/alp-<os>-<arch>; this file
// finds it and runs it with the same arguments, stdio, exit code and signal. Plain Node, no
// dependencies, no postinstall download.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const RELEASES_URL = 'https://github.com/phucanh08/alp/releases';
export const INSTALL_SH = 'curl -fsSL https://github.com/phucanh08/alp/releases/latest/download/install.sh | sh';

/** The platform packages, keyed by `${process.platform}-${process.arch}`. Linux builds are glibc only. */
export const PLATFORM_PACKAGES = Object.freeze({
  'darwin-arm64': '@anhlp/alp-darwin-arm64',
  'darwin-x64': '@anhlp/alp-darwin-x64',
  'linux-x64': '@anhlp/alp-linux-x64',
  'linux-arm64': '@anhlp/alp-linux-arm64',
  'win32-x64': '@anhlp/alp-win32-x64',
});

/** Whether this Linux runs glibc (Node reports its runtime glibc version; musl reports none). */
export function isGlibc(report = () => process.report?.getReport?.()) {
  try { return Boolean(/** @type {any} */ (report())?.header?.glibcVersionRuntime); } catch { return false; }
}

/**
 * The platform package for a machine, or why there is none.
 * @param {{ platform?: string, arch?: string, glibc?: () => boolean }} [machine]
 * @returns {{ name: string, executable: string } | { error: string }}
 */
export function platformPackage({ platform = process.platform, arch = process.arch, glibc = isGlibc } = {}) {
  const key = `${platform}-${arch}`;
  const name = PLATFORM_PACKAGES[key];
  if (!name) return { error: `ALP has no build for ${key}; supported: ${Object.keys(PLATFORM_PACKAGES).join(', ')}.` };
  if (platform === 'linux' && !glibc()) return { error: `ALP's Linux builds need glibc; this ${key} system uses another C library (musl, as on Alpine).` };
  return { name, executable: platform === 'win32' ? 'alp.exe' : 'alp' };
}

/**
 * The ALP executable installed beside this package, or an error message for the user.
 * @param {{ platform?: string, arch?: string, glibc?: () => boolean, resolve?: (request: string) => string, exists?: (file: string) => boolean }} [options]
 * @returns {{ binary: string, name: string } | { error: string }}
 */
export function findBinary({ resolve = createRequire(import.meta.url).resolve, exists = existsSync, ...machine } = {}) {
  const wanted = platformPackage(machine);
  // No executable exists for this machine: only the JavaScript CLI can run here.
  if ('error' in wanted) return { error: `alp: ${wanted.error}\nRun the JavaScript CLI instead (Node 22.12 or later; it also provides \`alp\`): npm uninstall -g @anhlp/alp && npm install -g @anhlp/alp-cli@beta\n(${RELEASES_URL})` };
  let manifest;
  try { manifest = resolve(`${wanted.name}/package.json`); } catch {
    return { error: missingMessage(`${wanted.name}, the ALP executable for this machine, is not installed (npm skips optional dependencies with --omit=optional or --no-optional).`) };
  }
  const binary = path.join(path.dirname(manifest), 'bin', wanted.executable);
  if (!exists(binary)) return { error: missingMessage(`${wanted.name} is installed but has no ${path.join('bin', wanted.executable)}; reinstall it.`) };
  return { binary, name: wanted.name };
}

/** @param {string} reason */
export function missingMessage(reason) {
  return [
    `alp: ${reason}`,
    'Reinstall with optional dependencies: npm install -g @anhlp/alp@beta --include=optional',
    `Or install the ALP executable directly: ${INSTALL_SH}`,
    `(Windows: install.ps1; every build: ${RELEASES_URL})`,
  ].join('\n');
}

/** Whether a terminal is attached (any of stdin, stdout, stderr): its keyboard signals reach the whole foreground group. */
export const onTerminal = (proc = process) => Boolean(proc.stdin?.isTTY || proc.stdout?.isTTY || proc.stderr?.isTTY);

/** Signals the launcher outlives so the executable decides what they mean. */
const HANDLED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT', 'SIGBREAK', 'SIGUSR1', 'SIGUSR2'];
/** The terminal's keyboard signals: a terminal sends them to the whole foreground process group, the executable included. */
const KEYBOARD = new Set(['SIGINT', 'SIGQUIT', 'SIGBREAK']);

/**
 * Whether a signal the launcher received must be passed on. Signals sent to the launcher alone
 * (kill <pid>, a supervisor) are. The terminal's Ctrl-C/Ctrl-\ already reached the executable, so
 * passing it on would deliver it twice. On Windows the console delivers Ctrl-C/Ctrl-Break to every
 * process attached to it, and kill() there only terminates, so nothing is passed on.
 */
export function forwards(signal, { platform = process.platform, tty = onTerminal() } = {}) {
  if (platform === 'win32') return false;
  return !(KEYBOARD.has(signal) && tty);
}

/**
 * Runs `binary` with `args` and inherited stdio. Resolves with how it ended: `{ code }` or `{ signal }`.
 * The launcher stays alive on the signals it handles and passes them on as `forwards` says; the
 * executable decides what they mean, and the launcher only reports how it ended.
 * @param {string} binary @param {string[]} args
 * @param {{ spawn?: typeof spawn, process?: NodeJS.Process, platform?: string, tty?: boolean }} [options]
 * @returns {Promise<{ code: number } | { signal: NodeJS.Signals }>}
 */
export function run(binary, args, { spawn: start = spawn, process: proc = process, platform = process.platform, tty = onTerminal() } = {}) {
  return new Promise(resolve => {
    const child = start(binary, args, { stdio: 'inherit', windowsHide: false });
    let started = false;
    child.once('spawn', () => { started = true; });
    const handlers = new Map();
    const release = () => { for (const [signal, handler] of handlers) proc.removeListener(signal, handler); };
    for (const signal of HANDLED) {
      const handler = () => { if (forwards(signal, { platform, tty })) try { child.kill(signal); } catch {} };
      try { proc.on(signal, handler); handlers.set(signal, handler); } catch {}
    }
    child.on('error', error => {
      // After the executable started, an error (a failed kill) changes nothing: its exit decides.
      if (started) return;
      release();
      proc.stderr.write(`alp: could not run ${binary}: ${error.message}\n${missingMessage('the ALP executable could not start.')}\n`);
      resolve({ code: 1 });
    });
    child.once('exit', (code, signal) => {
      release();
      resolve(signal ? { signal } : { code: code ?? 1 });
    });
  });
}

/** The launcher's main: find the executable, run it, end as it ended. */
export async function main(args = process.argv.slice(2)) {
  const found = findBinary();
  if ('error' in found) {
    process.stderr.write(`${found.error}\n`);
    process.exitCode = 1;
    return;
  }
  const end = await run(found.binary, args);
  if ('signal' in end) {
    // End by the same signal, so a shell sees what the child saw; exit 128+n if it does not kill us.
    try { process.kill(process.pid, end.signal); } catch {}
    const number = (await import('node:os')).constants.signals[end.signal] ?? 0;
    process.exit(128 + number);
  }
  process.exit(end.code);
}
