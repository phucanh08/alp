import { existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * How ALP starts its own processes, and where its bundle lives. ALP always runs under Node: from npm
 * (`node cli.js`, `node alpd.js`) or from the ALP bundle (t-1807), which is the same npm install
 * beside an official Node release, started by `bin/alp`:
 *
 *   <app>/<version>/{bin/alp, node/bin/node, lib/node_modules/@anhlp/alp-cli, alp-bundle.json}
 *   <app>/current → <version>          (install.sh and `alp update` move it)
 *
 * Paths that outlive this process (a launchd/systemd service, alpd's install record) name the bundle
 * through `current`, so an update never leaves them on a removed version.
 */

/**
 * The native alpd (t-81b0.9): alpd compiled with `bun build --compile` into one executable, shipped as
 * `<bundle>/bin/alpd` beside the bundle's Node. Only alpd is native; the `alp` CLI still runs on the
 * bundle's Node. Its entry (packages/daemon/src/native-entry.ts) registers itself here before alpd loads:
 * `modules` holds what alpd would otherwise import by a computed name (the Claude Agent SDK); `distDir`
 * names the bundle's @anhlp/alp-cli dist, where the terminal helper is (undefined outside a bundle).
 * @typedef {{ modules: { claudeAgentSdk?: () => Promise<any> }, distDir?: () => string | undefined }} NativeDaemon
 */
const NATIVE = Symbol.for('alp.nativeDaemon');

/** Registers this process as the native alpd. Only native-entry.ts calls it. @param {NativeDaemon} native */
export function registerNativeDaemon(native) { /** @type {any} */ (globalThis)[NATIVE] = native; }

/** The native alpd's registration when this process is the native alpd, else undefined. @returns {NativeDaemon | undefined} */
export function nativeDaemon() { return /** @type {any} */ (globalThis)[NATIVE]; }

/** The native alpd's file name on this platform. */
export const NATIVE_DAEMON = process.platform === 'win32' ? 'alpd.exe' : 'alpd';

/** Whether `file` is named like the native alpd (alpd, alpd.exe). @param {string} file */
export const isNativeDaemonName = file => /^alpd(\.exe)?$/i.test(file.split(/[\\/]/).pop() ?? '');

/** Whether `file` is an ALP bundle's native alpd: `<bundle>/bin/alpd` beside alp-bundle.json. @param {string} file */
export const isBundleDaemon = file => isNativeDaemonName(file) && path.basename(path.dirname(file)) === 'bin' && existsSync(path.join(path.dirname(path.dirname(file)), 'alp-bundle.json'));

/** Subcommands of `alp` that run each ALP role in that process (`alp daemon run`, `alp dashboard serve`, `alp bridge acp`). */
export const ROLE_ARGS = Object.freeze({
  daemon: Object.freeze(['daemon', 'run']),
  dashboard: Object.freeze(['dashboard', 'serve']),
  'bridge-acp': Object.freeze(['bridge', 'acp']),
  'bridge-antigravity': Object.freeze(['bridge', 'antigravity']),
});

/**
 * Whether `file` is named like the `alp` command (alp, alp.exe, alp.cmd) rather than a script: an
 * install record or service written by the single-file executable of 0.0.1-beta.5/6 names it, and the
 * bundle's launcher keeps that name.
 * @param {string} file
 */
export const isExecutableName = file => /^alp(\.exe|\.cmd)?$/i.test(file.split(/[\\/]/).pop() ?? '');

/** A file path that names a JavaScript entry rather than a command. @param {string} file */
export const isScript = file => /\.[cm]?js$/i.test(file);

/** The canonical form of a path: symlinks resolved when it exists, case-folded where the filesystem usually is. @param {string} file */
const canonical = file => {
  let resolved = path.resolve(file);
  try { resolved = realpathSync.native(resolved); } catch {}
  return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Whether two paths name the same file (a symlink, or a differently cased path on macOS/Windows). @param {string} a @param {string} b */
export const samePath = (a, b) => canonical(a) === canonical(b);

/** The role's argument prefix. @param {keyof typeof ROLE_ARGS} role */
function roleArgs(role) {
  const args = ROLE_ARGS[role];
  if (!args) throw new TypeError(`Unknown ALP role: ${role}`);
  return [...args];
}

/**
 * @typedef {{ root: string, version: string, platform: string, app: string, current?: string }} BundleInfo
 * root: the bundle directory (real path); app: its parent; current: `<app>/current` when it points at root.
 */

const bundles = new Map();

/**
 * The ALP bundle this Node belongs to, or undefined for any other Node (an npm install).
 * @param {string} [execPath]
 * @returns {BundleInfo | undefined}
 */
export function bundleInfo(execPath = process.execPath) {
  if (bundles.has(execPath)) return bundles.get(execPath);
  let info;
  try {
    const real = realpathSync(execPath);
    // node/bin/node on macOS and Linux, node/node.exe on Windows; or the native alpd, bin/alpd.
    const native = isNativeDaemonName(real) && path.basename(path.dirname(real)) === 'bin';
    const nodeDir = path.basename(path.dirname(real)) === 'bin' ? path.dirname(path.dirname(real)) : path.dirname(real);
    const root = native ? nodeDir : path.dirname(nodeDir);
    if (native || path.basename(nodeDir) === 'node') {
      const manifest = JSON.parse(readFileSync(path.join(root, 'alp-bundle.json'), 'utf8'));
      if (manifest?.name === 'alp' && typeof manifest.version === 'string') {
        const app = path.dirname(root);
        const current = path.join(app, 'current');
        info = { root, version: manifest.version, platform: String(manifest.platform ?? ''), app, ...(existsSync(current) && samePath(current, root) ? { current } : {}) };
      }
    }
  } catch {}
  bundles.set(execPath, info);
  return info;
}

/** The bundle's own Node executable. @param {BundleInfo} bundle */
export const bundleNode = bundle => path.join(bundle.root, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node');

/** The bundle's native alpd, whether or not it exists. @param {BundleInfo} bundle */
export const bundleDaemon = bundle => path.join(bundle.root, 'bin', NATIVE_DAEMON);

/** Where @anhlp/alp-cli's dist lies in the bundle (alpd.js, the terminal helper). @param {BundleInfo} bundle */
export const bundleDist = bundle => path.join(bundle.root, 'lib', 'node_modules', '@anhlp', 'alp-cli', 'dist');

/**
 * The Node that runs JavaScript for this process: process.execPath, except in the native alpd, which
 * cannot run a script (`spawn(execPath, [script])` would start alpd again, and `-e` is not evaluated):
 * there it is the bundle's Node, or `node` on PATH for a native alpd outside a bundle.
 */
export function nodeExecutable() {
  if (!nativeDaemon()) return process.execPath;
  const bundle = bundleInfo();
  return bundle ? bundleNode(bundle) : 'node';
}

/**
 * `file` named through `<app>/current` when it lies inside this process's bundle and `current` points
 * at that bundle; otherwise `file` unchanged. For paths written to disk for later processes.
 * @param {string} file
 * @param {{ bundle?: BundleInfo | undefined }} [options]
 */
export function stablePath(file, { bundle = bundleInfo() } = {}) {
  if (!bundle?.current) return file;
  let real;
  try { real = realpathSync(file); } catch { return file; }
  const relative = path.relative(bundle.root, real);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return file;
  return path.join(bundle.current, relative);
}

/**
 * The command that starts ALP's `role` from this process: `script` under this Node.
 * @param {keyof typeof ROLE_ARGS} role
 * @param {{ script: string, args?: string[] }} options
 * @returns {{ command: string, args: string[] }}
 */
export function selfCommand(role, { script, args = [] }) {
  roleArgs(role);
  // The native alpd is its own entry: it starts itself with its options only, never a script path.
  if (nativeDaemon()) {
    if (role !== 'daemon') throw new Error(`The native alpd cannot start ALP's ${role}`);
    return { command: process.execPath, args: [...args] };
  }
  return { command: process.execPath, args: [script, ...args] };
}

/**
 * The command that runs an `entry` found on disk (an install record, a service definition, a CLI
 * on PATH): a script runs under `execPath`; an `alp` command (the bundle's launcher, or what a
 * 0.0.1-beta.5/6 single-file install recorded) runs its role subcommand.
 * @param {string} entry
 * @param {keyof typeof ROLE_ARGS} role
 * @param {string[]} [args]
 * @param {string} [execPath]
 * @param {{ scriptOnly?: boolean }} [options] scriptOnly: `entry` is always run under execPath (third-party integrations)
 * @returns {{ command: string, args: string[] }}
 */
export function entryCommand(entry, role, args = [], execPath = process.execPath, { scriptOnly = false } = {}) {
  // The native alpd (t-81b0.9) runs on its own, with alpd's options: only a bundle's bin/alpd, so an
  // extensionless script named alpd (an npm .bin shim, a source checkout) still runs under execPath.
  if (!scriptOnly && role === 'daemon' && isBundleDaemon(entry)) return { command: entry, args: [...args] };
  if (scriptOnly || isScript(entry) || !isExecutableName(entry)) return { command: execPath, args: [entry, ...args] };
  return { command: entry, args: [...roleArgs(role), ...args] };
}

/**
 * The command that runs a user's JavaScript file (a fake provider, an npm cmd shim on Windows) with this Node.
 * @param {string} script
 * @param {string[]} [args]
 * @returns {{ command: string, args: string[], env?: Record<string, string> }}
 */
export function scriptCommand(script, args = []) {
  return { command: nodeExecutable(), args: [script, ...args] };
}

/**
 * Where this process's own entry lives, for records that later processes read: `script`, through
 * `current` in a bundle; the native alpd's own executable in the native alpd.
 * @param {string} script
 */
export function selfEntry(script) { return stablePath(nativeDaemon() ? process.execPath : script); }

/**
 * What starts alpd for this `alp`: the bundle's native alpd when the bundle ships one, else `script`
 * (alpd.js), each named through `current`. ALP_NATIVE_DAEMON=0 keeps alpd on the bundle's Node.
 * @param {string} script alpd.js
 * @param {{ bundle?: BundleInfo | undefined, env?: NodeJS.ProcessEnv }} [options]
 */
export function daemonEntry(script, { bundle = bundleInfo(), env = process.env } = {}) {
  const native = bundle && env.ALP_NATIVE_DAEMON !== '0' ? bundleDaemon(bundle) : undefined;
  return stablePath(native && existsSync(native) ? native : script, { bundle });
}
