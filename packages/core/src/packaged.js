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

/** Subcommands of `alp` that run each ALP role in that process (`alp daemon run`, `alp web serve`, `alp bridge acp`). */
export const ROLE_ARGS = Object.freeze({
  daemon: Object.freeze(['daemon', 'run']),
  web: Object.freeze(['web', 'serve']),
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
    // node/bin/node on macOS and Linux, node/node.exe on Windows.
    const nodeDir = path.basename(path.dirname(real)) === 'bin' ? path.dirname(path.dirname(real)) : path.dirname(real);
    const root = path.dirname(nodeDir);
    if (path.basename(nodeDir) === 'node') {
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
  return { command: process.execPath, args: [script, ...args] };
}

/** Where this process's own entry lives, for records that later processes read: `script`, through `current` in a bundle. @param {string} script */
export function selfEntry(script) { return stablePath(script); }
