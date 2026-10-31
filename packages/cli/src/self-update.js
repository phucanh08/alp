import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { bundleInfo, samePath } from '@anhlp/alp-core/packaged';

/**
 * `alp update` (t-1807): installs a release of the ALP bundle from GitHub Releases beside the running
 * one (<app>/<version>, see @anhlp/alp-core/packaged) and points <app>/current at it, after checking
 * the archive against the release's SHA256SUMS and, when `gh` is installed, its build provenance.
 * The project template upgrade that `alp update` used to run is `alp update-template`.
 *
 * Everything that touches the network, the filesystem or child processes comes in through `deps`
 * so the tests can drive each step.
 */

export const DEFAULT_REPO = 'phucanh08/alp';
export const SIGNER_WORKFLOW = '.github/workflows/release-binaries.yml';
export const NPM_PACKAGE = '@anhlp/alp';
const TEMPLATE_HINT = 'did you mean `alp update-template`? (`alp update` now updates ALP itself; the project template upgrade is `alp update-template [directory]`)';

const OPTIONS = { check: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, version: { type: 'string' }, 'base-url': { type: 'string' }, help: { type: 'boolean', short: 'h' } };

export const UPDATE_USAGE = `Usage: alp update [--check] [--yes] [--version X] [--base-url URL]
Installs the latest ALP release (or release X) from GitHub Releases beside this one and switches to it, after checking
it against SHA256SUMS and, when gh is installed, its build provenance. --check only reports.
ALP_UPDATE_BASE_URL (as --base-url, an https:// or file:// mirror) and ALP_INSTALL_REPO (owner/name) override the source.
The project template upgrade is \`alp update-template [directory]\`.`;

/** The release platform of this process: darwin-arm64, linux-x64, windows-x64. @param {string} platform @param {string} arch */
export function releasePlatform(platform = process.platform, arch = process.arch) {
  const osName = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
  const archName = { x64: 'x64', arm64: 'arm64' }[arch];
  if (!osName || !archName || (osName === 'windows' && archName !== 'x64')) throw new Error(`ALP publishes no build for ${platform}-${arch}`);
  return `${osName}-${archName}`;
}

/** The archive extension of a release platform. @param {string} platform */
export const archiveExtension = platform => platform.startsWith('windows-') ? '.zip' : '.tar.gz';

/** Parses SHA256SUMS into [{ sha256, name }]. @param {string} text */
export function parseSums(text) {
  const entries = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const match = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(line);
    if (!match) throw new Error(`Malformed SHA256SUMS line: ${JSON.stringify(line)}`);
    entries.push({ sha256: match[1].toLowerCase(), name: match[2].trim() });
  }
  return entries;
}

/**
 * The archive for `platform` in SHA256SUMS: alp-<version>-<platform>.<ext>, for `version` when given.
 * @param {string} sumsText @param {string} platform @param {string} [version]
 * @returns {{ name: string, sha256: string, version: string }}
 */
export function selectAsset(sumsText, platform, version) {
  const suffix = `-${platform}${archiveExtension(platform)}`;
  const matches = parseSums(sumsText).filter(({ name }) => name.endsWith(suffix) && /^alp-[0-9]/.test(name) && (!version || name === `alp-${version}${suffix}`));
  if (matches.length === 0) throw new Error(`This release has no ALP build for ${platform}${version ? ` at version ${version}` : ''}`);
  if (matches.length > 1) throw new Error(`SHA256SUMS lists more than one ${platform} archive: ${matches.map(m => m.name).join(', ')}`);
  const [match] = matches;
  if (/[^0-9A-Za-z.+_-]/.test(match.name)) throw new Error(`Unexpected archive name in SHA256SUMS: ${match.name}`);
  return { ...match, version: match.name.slice('alp-'.length, -suffix.length) };
}

export const sha256 = (/** @type {Uint8Array} */ bytes) => createHash('sha256').update(bytes).digest('hex');

/** Refuses an archive whose digest differs from SHA256SUMS. @param {Uint8Array} bytes @param {{ name: string, sha256: string }} asset */
export function verifyChecksum(bytes, asset) {
  const actual = sha256(bytes);
  if (actual !== asset.sha256) throw new Error(`Checksum mismatch for ${asset.name} (expected ${asset.sha256}, got ${actual}); nothing was replaced`);
  return actual;
}

/** Compares dotted versions numerically, prerelease below release. @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const split = (/** @type {string} */ v) => {
    // Build metadata (+b) does not order versions.
    const [core, pre] = v.replace(/^v/, '').replace(/\+.*$/s, '').split(/-(.*)/s);
    if (!/^\d+(\.\d+)*$/.test(core)) throw new Error(`Invalid version: ${JSON.stringify(v)}`);
    return { core: core.split('.').map(Number), pre };
  };
  const x = split(a), y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const d = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (d) return Math.sign(d);
  }
  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

/** The base URL that holds SHA256SUMS and the archives. @param {{ repo: string, version?: string, baseUrl?: string }} options */
export function releaseBaseUrl({ repo, version, baseUrl }) {
  let base = baseUrl;
  if (!base) base = version ? `https://github.com/${repo}/releases/download/v${version}` : `https://github.com/${repo}/releases/latest/download`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base) && (path.isAbsolute(base) || (process.platform === 'win32' && path.win32.isAbsolute(base)))) base = pathToFileURL(base).href;
  base = base.replace(/\/+$/, '');
  const url = new URL(base);
  const loopback = isLoopbackHttp(url);
  if (url.protocol !== 'https:' && url.protocol !== 'file:' && !loopback) throw new Error(`The release mirror must be https:// or file:// (${base})`);
  return base;
}

/** The largest file alp update downloads: an archive of the bundle is about 70 MB. */
export const MAX_DOWNLOAD = 512 * 1024 * 1024;

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]'];
const isLoopbackHttp = (/** @type {URL} */ url) => url.protocol === 'http:' && LOOPBACK.includes(url.hostname);

/**
 * Whether a download may go to `next`: every hop of an https download stays https, since one plain
 * http hop lets a man in the middle replace the archive and SHA256SUMS together. Only a loopback
 * http mirror given explicitly (tests) may use loopback http, besides https.
 * @param {string} start @param {string} next
 */
export function allowedHop(start, next) {
  const to = new URL(next);
  if (to.protocol === 'https:') return true;
  return isLoopbackHttp(new URL(start)) && isLoopbackHttp(to);
}

/**
 * Downloads `url` (https, loopback http or file) within a time and size limit, following at most 10
 * redirects itself and refusing any hop that `allowedHop` refuses.
 * @param {string} url @param {{ timeoutMs?: number, max?: number, fetch?: typeof globalThis.fetch }} [options]
 */
export async function fetchBytes(url, { timeoutMs = 10 * 60_000, max = MAX_DOWNLOAD, fetch: fetchImpl = globalThis.fetch } = {}) {
  if (url.startsWith('file:')) {
    const file = fileURLToPath(url);
    if (nodeFs.statSync(file).size > max) throw new Error(`${url} is larger than ${max} bytes`);
    return new Uint8Array(await nodeFs.promises.readFile(file));
  }
  if (!allowedHop(url, url)) throw new Error(`Refusing to download ${url}: not https`);
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  let response;
  for (let hop = 0; ; hop++) {
    response = await fetchImpl(current, { redirect: 'manual', signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get('location');
    await response.body?.cancel().catch(() => {});
    if (!location) throw new Error(`${current} redirected without a location`);
    if (hop >= 10) throw new Error(`${url} redirected more than 10 times`);
    const next = new URL(location, current).href;
    if (!allowedHop(url, next)) throw new Error(`${url} redirected to ${next}, which is not https; refused`);
    current = next;
  }
  if (!response.ok) throw new Error(`Could not download ${current} (HTTP ${response.status})`);
  if (Number(response.headers.get('content-length') ?? 0) > max) throw new Error(`${current} is larger than ${max} bytes`);
  const chunks = [];
  let size = 0;
  for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (response.body ?? [])) {
    size += chunk.byteLength;
    if (size > max) throw new Error(`${current} is larger than ${max} bytes`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Whether a program is on PATH. @param {string} name */
function which(name) {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0].trim() || undefined : undefined;
}

/**
 * Verifies the archive's build provenance with gh. Returns 'verified', or 'unavailable' when gh is
 * absent (ALP_UPDATE_NO_GH=1 treats it as absent); throws when gh reports a failure.
 * @param {string} file @param {{ repo: string, env?: NodeJS.ProcessEnv, run?: typeof spawnSync, find?: typeof which }} options
 */
export function verifyProvenance(file, { repo, env = process.env, run = spawnSync, find = which }) {
  if (env.ALP_UPDATE_NO_GH === '1') return 'unavailable';
  const gh = find('gh');
  if (!gh) return 'unavailable';
  const result = run(gh, ['attestation', 'verify', file, '--repo', repo, '--source-ref', 'refs/heads/main', '--signer-workflow', `${repo}/${SIGNER_WORKFLOW}`], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().split(/\r?\n/).slice(-3).join(' ');
    throw new Error(`gh attestation verify refused ${path.basename(file)}${detail ? `: ${detail}` : ''}; nothing was replaced (sign in with gh auth login, or set ALP_UPDATE_NO_GH=1 to rely on the checksum only)`);
  }
  return 'verified';
}

const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']);
const pause = (/** @type {number} */ ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `action`, again after a pause while Windows reports the file busy: a virus scanner holds an
 * executable it just saw run (the staged bundle's --version) for a moment. About 6 s in all.
 * @template T @param {() => T} action @param {(ms: number) => void} [sleep]
 */
export function retryBusy(action, sleep = pause, attempts = 25) {
  for (let attempt = 1; ; attempt++) {
    try { return action(); } catch (error) {
      if (attempt >= attempts || !TRANSIENT.has(error?.code)) throw error;
      sleep(Math.min(50 * attempt, 400));
    }
  }
}

/** What to say outside the ALP bundle (an npm install). @param {string[]} positionals */
export function npmMessage(positionals = []) {
  const lines = [];
  if (positionals.length) lines.push(`alp: ${TEMPLATE_HINT}`);
  lines.push(`This alp was installed with npm; update it with npm:\n  npm install -g ${NPM_PACKAGE}@beta\nThen restart alpd when no sessions are running: alp daemon restart\n(The project template upgrade is \`alp update-template [directory]\`.)`);
  return lines.join('\n');
}

/** Why this bundle cannot update itself: it was not installed by install.sh / install.ps1. @param {string} root */
export const notInstalledMessage = root => `alp: ${root} is not an installed ALP (no app/current points at it); install the release with install.sh (Windows: install.ps1), which alp update can then keep up to date:\n  curl -fsSL https://github.com/${DEFAULT_REPO}/releases/latest/download/install.sh | sh`;

const systemTar = () => process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/** Extracts the archive into `directory` and returns the bundle inside it. @param {string} archive @param {string} directory @param {{ name: string }} asset @param {string} platform */
function extract(archive, directory, asset, platform, run = spawnSync) {
  const windows = platform.startsWith('windows-');
  // tar reads both: GNU/bsd tar for .tar.gz, Windows' bsdtar (tar.exe) for .zip.
  // On Windows, Git's GNU tar (which reads no zip) may come first on PATH: use the system's bsdtar.
  const result = run(systemTar(), [windows ? '-xf' : '-xzf', archive, '-C', directory], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Could not extract ${asset.name}: ${(result.stderr || result.error?.message || '').trim()}`);
  const root = path.join(directory, asset.name.slice(0, -archiveExtension(platform).length));
  if (!nodeFs.existsSync(path.join(root, 'alp-bundle.json'))) throw new Error(`${asset.name} does not contain an ALP bundle (${path.basename(root)}/alp-bundle.json)`);
  return root;
}

/** The bundle's own Node and CLI: run without its launcher, so Windows needs no shell for alp.cmd. @param {string} root @param {string} platform */
export function bundleCommand(root, platform = process.platform) {
  const node = platform === 'win32' ? path.join(root, 'node', 'node.exe') : path.join(root, 'node', 'bin', 'node');
  return { command: node, args: [path.join(root, 'lib', 'node_modules', '@anhlp', 'alp-cli', 'dist', 'cli.js')] };
}

/**
 * Points `<app>/current` at `<app>/<version>`. Unix: a relative symlink renamed over the old one, in
 * one step. Windows: the junction is replaced (removed, then made again; put back on failure).
 * @param {string} app @param {string} version @param {{ platform?: string, fs?: typeof nodeFs, unique?: () => string }} [options]
 */
export function switchCurrent(app, version, { platform = process.platform, fs = nodeFs, unique = () => randomBytes(6).toString('hex') } = {}) {
  const p = platform === 'win32' ? path.win32 : path;
  const current = p.join(app, 'current');
  if (platform !== 'win32') {
    const link = p.join(app, `.current-${unique()}`);
    fs.symlinkSync(version, link);
    try { fs.renameSync(link, current); } catch (error) { try { fs.unlinkSync(link); } catch {} throw error; }
    return;
  }
  let previous;
  try { previous = fs.readlinkSync(current); } catch {}
  if (previous !== undefined) retryBusy(() => fs.unlinkSync(current));
  try { fs.symlinkSync(p.join(app, version), current, 'junction'); } catch (error) {
    if (previous !== undefined) try { fs.symlinkSync(previous, current, 'junction'); } catch {}
    throw error;
  }
}

/**
 * Removes what earlier updates left in `<app>`: versions other than `keep`, and staging directories.
 * A failure (a file still in use on Windows) leaves that entry for the next update. keepAside keeps
 * the copies earlier reinstalls moved aside, which a running alpd may still run from.
 * @param {string} app @param {string[]} keep
 */
export function pruneVersions(app, keep, fs = nodeFs, { keepAside = false } = {}) {
  let names;
  try { names = fs.readdirSync(app); } catch { return []; }
  const removed = [];
  for (const name of names) {
    if (name === 'current' || keep.includes(name) || (keepAside && name.startsWith('.alp-old-'))) continue;
    if (!/^[0-9][0-9A-Za-z.+-]*$/.test(name) && !/^\.alp-(update|old)-[0-9A-Za-z]+$/.test(name) && !/^\.current-[0-9a-f]+$/.test(name)) continue;
    try { fs.rmSync(path.join(app, name), { recursive: true, force: true }); removed.push(name); } catch {}
  }
  return removed;
}

/** Asks a yes/no question on the terminal. @param {string} question */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
}

/**
 * @typedef {{
 *   bundle: import('@anhlp/alp-core/packaged').BundleInfo | undefined, version: string, env: NodeJS.ProcessEnv, platform: string, arch: string,
 *   log: (line: string) => void, warn: (line: string) => void, interactive: boolean,
 *   fetchBytes: (url: string) => Promise<Uint8Array>, confirm: (question: string) => Promise<boolean>,
 *   provenance: (file: string, repo: string) => string, extract: typeof extract,
 *   daemon: () => Promise<{ version: string, sessions?: number } | undefined>, restartDaemon: (root: string) => number,
 *   runVersion: (root: string) => string,
 * }} UpdateDeps
 */

/** @param {string[]} args @param {Partial<UpdateDeps>} [overrides] @returns {Promise<number>} the exit code */
export async function selfUpdate(args, overrides = {}) {
  /** @type {UpdateDeps} */
  const deps = {
    bundle: bundleInfo(), version: '0.0.0', env: process.env, platform: process.platform, arch: process.arch,
    log: line => console.log(line), warn: line => console.error(line), interactive: !!(process.stdin.isTTY && process.stdout.isTTY),
    fetchBytes, confirm, extract,
    provenance: (file, repo) => verifyProvenance(file, { repo }),
    daemon: async () => undefined,
    restartDaemon: root => { const run = bundleCommand(root); return spawnSync(run.command, [...run.args, 'daemon', 'restart'], { stdio: 'inherit', windowsHide: true }).status ?? 1; },
    runVersion: root => { const run = bundleCommand(root); return spawnSync(run.command, [...run.args, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).stdout?.trim() ?? ''; },
    ...overrides,
  };
  const { bundle } = deps;
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: OPTIONS, strict: true });
  } catch (error) {
    deps.warn(`alp: ${error.message}`);
    deps.warn(`alp: ${TEMPLATE_HINT}`);
    return bundle ? 1 : 0;
  }
  const { values, positionals } = parsed;
  if (values.help) { deps.log(UPDATE_USAGE); return 0; }
  if (!bundle) { deps.log(npmMessage(positionals)); return 0; }
  if (positionals.length) { deps.warn(`alp: ${TEMPLATE_HINT}`); return 1; }
  if (!bundle.current) { deps.warn(notInstalledMessage(bundle.root)); return 1; }

  const wanted = values.version?.replace(/^v/, '');
  if (wanted !== undefined && !/^[0-9][0-9A-Za-z.+-]*$/.test(wanted)) throw new Error(`Invalid version: ${values.version}`);
  const repo = deps.env.ALP_INSTALL_REPO || DEFAULT_REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`Invalid ALP_INSTALL_REPO: ${repo}`);
  const base = releaseBaseUrl({ repo, version: wanted, baseUrl: values['base-url'] ?? deps.env.ALP_UPDATE_BASE_URL });
  const platform = releasePlatform(deps.platform, deps.arch);

  const sums = new TextDecoder().decode(await deps.fetchBytes(`${base}/SHA256SUMS`));
  const asset = selectAsset(sums, platform, wanted);
  const order = compareVersions(asset.version, deps.version);
  if (values.check) {
    if (order === 0) deps.log(`alp ${deps.version} is up to date (${platform})`);
    else if (order < 0 && !wanted) deps.log(`alp ${deps.version} is newer than the latest release ${asset.version}`);
    else deps.log(`alp ${deps.version} → ${asset.version} available (${asset.name}); run: alp update${wanted ? ` --version ${wanted}` : ''}`);
    return 0;
  }
  // An explicit --version of the running version reinstalls it (a repair); without one there is nothing to do.
  if (order === 0 && !wanted) { deps.log(`alp ${deps.version} is up to date (${platform})`); return 0; }
  if (order < 0 && !wanted) { deps.log(`alp ${deps.version} is newer than the latest release ${asset.version}; nothing to do (pass --version ${asset.version} to go back)`); return 0; }

  const { app, current } = bundle;
  // Windows cannot rename or delete a directory that a running node.exe (this one) comes from.
  if (deps.platform === 'win32' && asset.version === path.basename(bundle.root)) throw new Error(`ALP ${asset.version} is the version running now; Windows cannot replace it in place. Close ALP (alp daemon stop) and rerun install.ps1 to repair it`);
  // The version a running alpd uses keeps its files, like the one this process runs.
  const running = await deps.daemon().catch(() => undefined);
  try { nodeFs.accessSync(app, nodeFs.constants.W_OK); } catch { throw new Error(`${app} is not writable; run alp update with the permissions that installed ALP there`); }
  const target = path.join(app, asset.version);

  if (!values.yes) {
    if (!deps.interactive) throw new Error(`alp update would install ${target} and switch ${current} to it (${deps.version} → ${asset.version}); pass --yes to do it without a terminal`);
    if (!await deps.confirm(`Install ALP ${asset.version} in ${target} and switch to it (from ${deps.version})?`)) { deps.log('Not updated.'); return 1; }
  }

  const work = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'alp-update-'));
  // Unpacked beside the versions, so moving it into place stays on one filesystem.
  const staging = path.join(app, `.alp-update-${randomBytes(6).toString('hex')}`);
  /** @type {string | undefined} the running version, moved aside by a reinstall */
  let aside;
  try {
    deps.log(`Downloading ${asset.name} from ${base}`);
    const bytes = await deps.fetchBytes(`${base}/${asset.name}`);
    verifyChecksum(bytes, asset);
    deps.log(`Checksum verified (${asset.sha256})`);
    const archive = path.join(work, asset.name);
    nodeFs.writeFileSync(archive, bytes);
    const provenance = deps.provenance(archive, repo);
    if (provenance === 'verified') deps.log(`Provenance verified by gh attestation (${repo}, refs/heads/main, release-binaries.yml)`);
    else deps.warn('alp: warning: gh is not available, so only the SHA256SUMS checksum was verified, not the build provenance (install gh to verify it)');
    nodeFs.mkdirSync(staging);
    const unpacked = deps.extract(archive, staging, asset, platform);
    const manifest = JSON.parse(nodeFs.readFileSync(path.join(unpacked, 'alp-bundle.json'), 'utf8'));
    if (manifest.version !== asset.version || (manifest.platform && manifest.platform !== platform)) throw new Error(`${asset.name} holds ALP ${manifest.version} for ${manifest.platform}, not ${asset.version} for ${platform}; nothing was changed`);
    const reported = deps.runVersion(unpacked);
    if (reported !== asset.version) throw new Error(`The downloaded ALP reports version ${JSON.stringify(reported)}, not ${asset.version}; nothing was changed`);
    if (nodeFs.existsSync(target)) {
      // A reinstall of the running version moves it aside (its processes keep their files); any other copy is stale.
      if (samePath(target, bundle.root) || running?.version === asset.version) { aside = `.alp-old-${randomBytes(6).toString('hex')}`; retryBusy(() => nodeFs.renameSync(target, path.join(app, aside))); }
      else nodeFs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    try { retryBusy(() => nodeFs.renameSync(unpacked, target)); } catch (error) {
      // The running version goes back where it was, so app/current still points at files (t-1f14).
      if (aside && !nodeFs.existsSync(target)) {
        try { nodeFs.renameSync(path.join(app, aside), target); aside = undefined; } catch { throw new Error(`${error.message}; the running ALP ${asset.version} is in ${path.join(app, aside)}: move it back to ${target}`, { cause: error }); }
      }
      throw error;
    }
    switchCurrent(app, asset.version, { platform: deps.platform });
  } finally {
    // A cleanup failure must not hide why the update failed; a leftover staging directory goes with the next update.
    try { nodeFs.rmSync(staging, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
    try { nodeFs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch {}
  }
  // The version this process (and maybe alpd) runs stays until the next update.
  pruneVersions(app, [asset.version, path.basename(bundle.root), ...(running?.version ? [running.version] : []), ...(aside ? [aside] : [])], nodeFs, { keepAside: Boolean(running) });
  deps.log(`Updated ALP ${deps.version} → ${asset.version} (${current} → ${target})`);

  if (running && running.version !== asset.version) {
    const sessions = running.sessions;
    const known = Number.isSafeInteger(sessions);
    deps.log(`alpd ${running.version} is still running${!known ? ' (its live sessions could not be read)' : sessions ? ` with ${sessions} live session${sessions === 1 ? '' : 's'}` : ''}; it runs the new version after: alp daemon restart`);
    // Never restart on our own: only an interactive yes with no live session known restarts it.
    if (!values.yes && deps.interactive && known && sessions === 0 && await deps.confirm('Restart alpd now?')) {
      if (deps.restartDaemon(target) !== 0) deps.warn('alp: alp daemon restart failed; run it yourself');
    }
  }
  return 0;
}
