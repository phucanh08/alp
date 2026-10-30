import { createHash } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * ALP runs either as npm scripts under Node (`node cli.js`, `node alpd.js`) or as one self-contained
 * executable (`alp`, built with `bun build --compile`, t-1e02). In the executable, `process.execPath`
 * is ALP itself: it cannot run a script path, and `-e code` is not evaluated. Every place that starts
 * another ALP process asks this module for the command instead of spawning `process.execPath`.
 *
 * The executable's entry registers itself before importing anything else; the registration lives
 * on globalThis because alpd.js and the CLI each inline their own copy of this module.
 */

const KEY = Symbol.for('alp.packaged');

/** Subcommands of the executable that run each ALP role (the npm CLI understands them too). */
export const ROLE_ARGS = Object.freeze({
  daemon: Object.freeze(['daemon', 'run']),
  web: Object.freeze(['web', 'serve']),
  'bridge-acp': Object.freeze(['bridge', 'acp']),
  'bridge-antigravity': Object.freeze(['bridge', 'antigravity']),
});

/**
 * @typedef {{ path: string, sha256: string, size: number }} PackagedAsset
 * @typedef {{ version: string, assets?: Record<string, PackagedAsset>, roles?: Record<string, () => Promise<unknown>> }} PackagedRegistration
 */

/** Called once by the executable's entry. @param {PackagedRegistration} registration */
export function registerPackaged(registration) {
  if (!registration || typeof registration.version !== 'string') throw new TypeError('registerPackaged needs a version');
  // assetDir rides along so dependency-free adapters (native-terminal.js) can reach the cache via globalThis alone.
  Object.defineProperty(globalThis, KEY, { value: Object.freeze({ ...registration, assetDir: () => assetDir() }), configurable: true, enumerable: false, writable: false });
}

/** The registration when this process is the ALP executable, else undefined. @returns {PackagedRegistration | undefined} */
export function packagedInfo() { return /** @type {any} */ (globalThis)[KEY]; }

/** Whether this process is the self-contained ALP executable. */
export function isPackaged() { return packagedInfo() !== undefined; }

/**
 * A string only ALP's executable carries: its generated entry embeds it, so discovery can tell ALP
 * from an unrelated native program that happens to be called `alp` without running it.
 */
export const EXECUTABLE_MARKER = 'alp-standalone-executable:v1:2b6f0c1e';

/** Whether `file` is named like the ALP executable (alp, alp.exe). @param {string} file */
export const isExecutableName = file => /^alp(\.exe)?$/i.test(file.split(/[\\/]/).pop() ?? '');

/** Whether `file` is this process's own ALP executable, whatever it is called (alp-darwin-arm64, a rename). @param {unknown} file */
export const isSelf = file => isPackaged() && typeof file === 'string' && samePath(file, process.execPath);

/** The canonical form of a path: symlinks resolved when it exists, case-folded where the filesystem usually is. @param {string} file */
const canonical = file => {
  let resolved = path.resolve(file);
  try { resolved = realpathSync.native(resolved); } catch {}
  return process.platform === 'darwin' || process.platform === 'win32' ? resolved.toLowerCase() : resolved;
};

/** Whether two paths name the same file (a symlink such as ~/.alp/bin/alp, or a differently cased path on macOS/Windows). @param {string} a @param {string} b */
export const samePath = (a, b) => canonical(a) === canonical(b);

/** A file path that names a JavaScript entry rather than an executable. @param {string} file */
export const isScript = file => /\.[cm]?js$/i.test(file);

/** The role's argument prefix. @param {keyof typeof ROLE_ARGS} role */
function roleArgs(role) {
  const args = ROLE_ARGS[role];
  if (!args) throw new TypeError(`Unknown ALP role: ${role}`);
  return [...args];
}

/**
 * The command that starts ALP's `role` from this process: the executable's subcommand when packaged,
 * else `script` under this Node, exactly as before.
 * @param {keyof typeof ROLE_ARGS} role
 * @param {{ script: string, args?: string[] }} options
 * @returns {{ command: string, args: string[] }}
 */
export function selfCommand(role, { script, args = [] }) {
  if (isPackaged()) return { command: process.execPath, args: [...roleArgs(role), ...args] };
  return { command: process.execPath, args: [script, ...args] };
}

/**
 * The command that runs an `entry` found on disk (an install record, a service definition, a CLI
 * on PATH): a script runs under `execPath`; an executable runs its own role subcommand.
 * @param {string} entry
 * @param {keyof typeof ROLE_ARGS} role
 * @param {string[]} [args]
 * @param {string} [execPath]
 * @param {{ scriptOnly?: boolean }} [options] scriptOnly: `entry` is always run under execPath (third-party integrations)
 * @returns {{ command: string, args: string[] }}
 */
export function entryCommand(entry, role, args = [], execPath = process.execPath, { scriptOnly = false } = {}) {
  // Only a file named alp/alp.exe, or this very executable under any name, is native; anything else
  // (alpd.js, alpd.ts, a launcher) is a script.
  if (scriptOnly || isScript(entry) || !(isExecutableName(entry) || isSelf(entry))) {
    // The executable cannot run a script itself; a script entry then needs a real Node.
    if (isPackaged() && execPath === process.execPath) return { command: 'node', args: [entry, ...args] };
    return { command: execPath, args: [entry, ...args] };
  }
  return { command: entry, args: [...roleArgs(role), ...args] };
}

/**
 * The command that runs a user's JavaScript file (a fake provider, an npm cmd shim on Windows)
 * with this process's runtime. The executable runs it as Bun does when BUN_BE_BUN is set.
 * @param {string} script
 * @param {string[]} [args]
 * @returns {{ command: string, args: string[], env?: Record<string, string> }}
 */
export function scriptCommand(script, args = []) {
  if (isPackaged()) return { command: process.execPath, args: [script, ...args], env: { BUN_BE_BUN: '1' } };
  return { command: process.execPath, args: [script, ...args] };
}

/** The ALP executable's path when this process is it, else undefined. */
export function executablePath() { return isPackaged() ? process.execPath : undefined; }

/** Where this process's own entry lives: the executable when packaged, else `script`. @param {string} script */
export function selfEntry(script) { return isPackaged() ? process.execPath : script; }

const sha256 = (/** @type {Buffer} */ bytes) => createHash('sha256').update(bytes).digest('hex');
const MARKER = '.alp-assets.json';

/** The directory the executable's assets are extracted to. @param {string} version @param {NodeJS.ProcessEnv} [env] */
export function assetCacheDir(version, env = process.env) {
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) throw new TypeError(`Invalid ALP version for the asset cache: ${JSON.stringify(version)}`);
  const home = env.ALP_HOME ? path.resolve(env.ALP_HOME) : path.join(os.homedir(), '.alp');
  return path.join(home, 'cache', version);
}

/** The manifest digest the marker records, so a changed build never reuses an older extraction. @param {Record<string, PackagedAsset>} assets */
const manifestDigest = assets => sha256(Buffer.from(JSON.stringify(Object.keys(assets).sort().map(name => [name, assets[name].sha256, assets[name].size]))));

/** Rejects names that would leave the cache directory. @param {string} name */
function assertAssetName(name) {
  if (!name || path.isAbsolute(name) || name.split(/[\\/]/).some(part => part === '..' || part === '' || part === '.') || name === MARKER) throw new Error(`Invalid packaged asset name: ${JSON.stringify(name)}`);
}

/** A private directory we own, not a symlink. @param {string} directory */
function assertPrivate(directory) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`ALP asset cache is not a directory: ${directory}`);
  if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) throw new Error(`ALP asset cache must be private to the current user (0700): ${directory}`);
}

/** The cache parent (<ALP_HOME>/cache): a real directory of ours that nobody else may write into. @param {string} directory */
function assertParent(directory) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`ALP asset cache parent is not a directory: ${directory}`);
  if (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o022) !== 0)) throw new Error(`ALP asset cache parent must belong to the current user and not be group- or world-writable: ${directory}`);
}

/** Whether `directory` holds exactly this manifest's extraction: every file's size and sha256 match. */
function extracted(/** @type {string} */ directory, /** @type {string} */ digest, /** @type {Record<string, PackagedAsset>} */ assets) {
  try {
    if (JSON.parse(readFileSync(path.join(directory, MARKER), 'utf8')).digest !== digest) return false;
    return Object.entries(assets).every(([name, asset]) => {
      const file = path.join(directory, name);
      const info = lstatSync(file);
      return info.isFile() && info.size === asset.size && sha256(readFileSync(file)) === asset.sha256;
    });
  } catch { return false; }
}

const STAGING = /^(.+)\.tmp-(\d+)-(\d+)$/;
const STALE_MS = 60 * 60 * 1000;
const SWEEP_MIN_MS = 10 * 60 * 1000;

/** Removes staging directories another process left behind (it crashed, or was killed mid-extraction). @param {string} parent */
function sweepStaging(parent) {
  let names;
  try { names = readdirSync(parent); } catch { return; }
  for (const name of names) {
    const match = STAGING.exec(name);
    if (!match) continue;
    const pid = Number(match[2]);
    if (pid === process.pid) continue;
    const age = Date.now() - Number(match[3]);
    // Another pid namespace (a bind-mounted ALP_HOME) may hold a live extractor this one cannot see,
    // so even a dead-looking pid's staging is kept for a few minutes; past an hour nothing is running.
    if (age < SWEEP_MIN_MS) continue;
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch (error) { alive = /** @type {any} */ (error)?.code === 'EPERM'; }
    if (alive && age < STALE_MS) continue;
    try { rmSync(path.join(parent, name), { recursive: true, force: true }); } catch {}
  }
}

/**
 * The directory holding the executable's embedded assets (templates, the web app, the native
 * terminal helper), extracted once per version to `<ALP_HOME or ~/.alp>/cache/<version>/` and
 * checked against the build's sha256 manifest. Undefined when not packaged: callers then use the
 * files beside their scripts, as before.
 * @param {{ env?: NodeJS.ProcessEnv, info?: PackagedRegistration }} [options]
 * @returns {string | undefined}
 */
export function assetDir({ env = process.env, info = packagedInfo() } = {}) {
  if (!info) return undefined;
  const assets = info.assets ?? {};
  const directory = assetCacheDir(info.version, env);
  const digest = manifestDigest(assets);
  // Checked once per process and directory; later calls (every template read) reuse the answer.
  const key = `${directory}\0${digest}`;
  if (verified.has(key) && existsSync(path.join(directory, MARKER))) return directory;
  const result = extract(directory, digest, assets, info.version);
  verified.add(key);
  return result;
}

const verified = new Set();

/** @param {string} directory @param {string} digest @param {Record<string, PackagedAsset>} assets @param {string} version */
function extract(directory, digest, assets, version) {
  const parent = path.dirname(directory);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertParent(parent);
  sweepStaging(parent);
  if (existsSync(directory)) {
    assertPrivate(directory);
    if (extracted(directory, digest, assets)) return directory;
  }
  const staging = `${directory}.tmp-${process.pid}-${Date.now()}`;
  mkdirSync(staging, { mode: 0o700 });
  try {
    for (const [name, asset] of Object.entries(assets)) {
      assertAssetName(name);
      const bytes = readFileSync(asset.path);
      if (bytes.length !== asset.size || sha256(bytes) !== asset.sha256) throw new Error(`Packaged asset ${name} does not match its manifest`);
      const target = path.join(staging, name);
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { mode: 0o600 });
      if (/(^|\/)terminal-owner(\.exe)?$/.test(name)) chmodSync(target, 0o700);
    }
    writeFileSync(path.join(staging, MARKER), JSON.stringify({ version, digest }), { mode: 0o600 });
    // Another ALP process may have finished the same extraction first; its copy is equivalent.
    if (existsSync(directory)) {
      assertPrivate(directory);
      if (extracted(directory, digest, assets)) { rmSync(staging, { recursive: true, force: true }); return directory; }
      rmSync(directory, { recursive: true, force: true });
    }
    renameSync(staging, directory);
    if (!extracted(directory, digest, assets)) throw new Error(`ALP asset cache ${directory} is incomplete after extraction`);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    if (existsSync(directory) && extracted(directory, digest, assets)) return directory;
    throw error;
  }
  return directory;
}
