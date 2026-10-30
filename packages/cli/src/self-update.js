import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { executablePath } from '@anhlp/alp-core/packaged';

/**
 * `alp update` (t-1e02 P3): replaces the ALP executable with a release from GitHub Releases, after
 * checking the archive against the release's SHA256SUMS and, when `gh` is installed, its build
 * provenance. The project template upgrade that `alp update` used to run is `alp update-template`.
 *
 * Everything that touches the network, the filesystem or child processes comes in through `deps`
 * so the tests can drive each step.
 */

export const DEFAULT_REPO = 'phucanh08/alp';
export const SIGNER_WORKFLOW = '.github/workflows/release-binaries.yml';
export const NPM_PACKAGE = '@anhlp/alp';
const TEMPLATE_HINT = 'did you mean `alp update-template`? (`alp update` now updates the ALP executable; the project template upgrade is `alp update-template [directory]`)';

const OPTIONS = { check: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, version: { type: 'string' }, 'base-url': { type: 'string' }, help: { type: 'boolean', short: 'h' } };

export const UPDATE_USAGE = `Usage: alp update [--check] [--yes] [--version X] [--base-url URL]
Replaces this ALP executable with the latest release (or release X) from GitHub Releases, after checking
it against SHA256SUMS and, when gh is installed, its build provenance. --check only reports.
ALP_UPDATE_BASE_URL (as --base-url, an https:// or file:// mirror) and ALP_INSTALL_REPO (owner/name) override the source.
The project template upgrade is \`alp update-template [directory]\`.`;

/** The release platform of this process: darwin-arm64, linux-x64, windows-x64. @param {string} platform @param {string} arch */
export function releasePlatform(platform = process.platform, arch = process.arch) {
  const osName = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[platform];
  const archName = { x64: 'x64', arm64: 'arm64' }[arch];
  if (!osName || !archName || (osName === 'windows' && archName !== 'x64')) throw new Error(`ALP publishes no executable for ${platform}-${arch}`);
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
  if (matches.length === 0) throw new Error(`This release has no ALP executable for ${platform}${version ? ` at version ${version}` : ''}`);
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
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(base) && (path.isAbsolute(base) || path.win32.isAbsolute(base))) base = pathToFileURL(base).href;
  base = base.replace(/\/+$/, '');
  const url = new URL(base);
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && url.protocol !== 'file:' && !loopback) throw new Error(`The release mirror must be https:// or file:// (${base})`);
  return base;
}

/** The largest file alp update downloads: the executable is about 100 MB. */
export const MAX_DOWNLOAD = 512 * 1024 * 1024;

/** Downloads `url` (https, loopback http or file) within a time and size limit; an https download never ends on plain http. @param {string} url */
async function fetchBytes(url, { timeoutMs = 10 * 60_000, max = MAX_DOWNLOAD } = {}) {
  if (url.startsWith('file:')) {
    const file = fileURLToPath(url);
    if (nodeFs.statSync(file).size > max) throw new Error(`${url} is larger than ${max} bytes`);
    return new Uint8Array(await nodeFs.promises.readFile(file));
  }
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  if (new URL(url).protocol === 'https:' && new URL(response.url || url).protocol !== 'https:') throw new Error(`${url} redirected away from https (${response.url}); refused`);
  if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status})`);
  if (Number(response.headers.get('content-length') ?? 0) > max) throw new Error(`${url} is larger than ${max} bytes`);
  const chunks = [];
  let size = 0;
  for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (response.body ?? [])) {
    size += chunk.byteLength;
    if (size > max) throw new Error(`${url} is larger than ${max} bytes`);
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

/** The previous executable Windows keeps beside the new one until the next start. @param {string} target @param {string} [platform] */
export const oldPath = (target, platform = process.platform) => {
  const p = platform === 'win32' ? path.win32 : path;
  return p.join(p.dirname(target), `${p.basename(target, p.extname(target))}.old${p.extname(target) || '.exe'}`);
};

/**
 * Puts `staged` in place of `target`. Unix: rename over the running file. Windows: the running
 * alp.exe cannot be overwritten but can be renamed, so it becomes alp.old.exe (deleted on the next
 * start) and the new file takes its name; a failure puts the old one back.
 * @param {string} staged @param {string} target @param {{ platform?: string, fs?: Pick<typeof nodeFs, 'renameSync' | 'rmSync' | 'existsSync'> }} [options]
 */
export function replaceExecutable(staged, target, { platform = process.platform, fs = nodeFs, unique = () => randomBytes(4).toString('hex') } = {}) {
  if (platform !== 'win32') { fs.renameSync(staged, target); return { old: undefined }; }
  const old = oldPath(target, platform);
  if (fs.existsSync(old)) {
    // A process started from the previous update's file (an alpd not restarted yet) keeps it locked:
    // it cannot be deleted, but it can be moved aside for a later start to delete.
    try { fs.rmSync(old, { force: true }); } catch {
      const aside = old.replace(/\.exe$/i, `.${unique()}.exe`);
      try { fs.renameSync(old, aside); } catch (error) {
        throw new Error(`${old} is in use and could not be moved (${error.code ?? error.message}); stop the ALP processes started from it (alp daemon stop) and run alp update again`);
      }
    }
  }
  fs.renameSync(target, old);
  try {
    fs.renameSync(staged, target);
  } catch (error) {
    try { fs.renameSync(old, target); } catch (restore) {
      throw new Error(`Could not put the new executable at ${target} (${error.code ?? error.message}), and could not move the previous one back (${restore.code ?? restore.message}): rename ${old} to ${target} yourself`);
    }
    throw error;
  }
  return { old };
}

/** Deletes the alp.old.exe (and alp.old.<hex>.exe) a Windows update left behind; called on every packaged start. @param {string} target @param {{ platform?: string, fs?: Pick<typeof nodeFs, 'rmSync' | 'readdirSync'> }} [options] */
export function cleanupOldExecutable(target, { platform = process.platform, fs = nodeFs } = {}) {
  if (platform !== 'win32') return false;
  const old = path.win32.basename(oldPath(target, platform));
  const stem = old.slice(0, -'.exe'.length).toLowerCase();
  let names;
  try { names = fs.readdirSync(path.win32.dirname(target)); } catch { return false; }
  let removed = false;
  // alp.old.exe, and the alp.old.<hex>.exe a locked one was moved aside to.
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower !== `${stem}.exe` && !(lower.startsWith(`${stem}.`) && /^[0-9a-f]+\.exe$/.test(lower.slice(stem.length + 1)))) continue;
    try { fs.rmSync(path.win32.join(path.win32.dirname(target), name), { force: true }); removed = true; } catch {}
  }
  return removed;
}

/** What to say outside the executable (an npm install). @param {string[]} positionals */
export function npmMessage(positionals = []) {
  const lines = [];
  if (positionals.length) lines.push(`alp: ${TEMPLATE_HINT}`);
  lines.push(`This alp runs from npm, not as the ALP executable; update it with npm:\n  npm install -g ${NPM_PACKAGE}@beta\nThen restart alpd when no sessions are running: alp daemon restart\n(The project template upgrade is \`alp update-template [directory]\`.)`);
  return lines.join('\n');
}

/** Extracts the archive and returns the executable inside it. @param {string} archive @param {string} directory @param {{ name: string }} asset @param {string} platform */
function extract(archive, directory, asset, platform, run = spawnSync) {
  const windows = platform.startsWith('windows-');
  // tar reads both: GNU/bsd tar for .tar.gz, Windows' bsdtar (tar.exe) for .zip.
  // On Windows, Git's GNU tar (which reads no zip) may come first on PATH: use the system's bsdtar.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const result = run(tar, [windows ? '-xf' : '-xzf', archive, '-C', directory], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Could not extract ${asset.name}: ${(result.stderr || result.error?.message || '').trim()}`);
  const name = asset.name.slice(0, -archiveExtension(platform).length);
  const binary = path.join(directory, name, windows ? 'alp.exe' : 'alp');
  if (!nodeFs.existsSync(binary)) throw new Error(`${asset.name} does not contain ${name}/${windows ? 'alp.exe' : 'alp'}`);
  return binary;
}

/** Asks a yes/no question on the terminal. @param {string} question */
async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
}

/**
 * @typedef {{
 *   packaged: boolean, version: string, execPath: string, env: NodeJS.ProcessEnv, platform: string, arch: string,
 *   log: (line: string) => void, warn: (line: string) => void, interactive: boolean,
 *   fetchBytes: (url: string) => Promise<Uint8Array>, confirm: (question: string) => Promise<boolean>,
 *   provenance: (file: string, repo: string) => string, extract: typeof extract,
 *   daemon: () => Promise<{ version: string, sessions?: number } | undefined>, restartDaemon: (binary: string) => number,
 *   runVersion: (binary: string) => string,
 * }} UpdateDeps
 */

/** @param {string[]} args @param {Partial<UpdateDeps>} [overrides] @returns {Promise<number>} the exit code */
export async function selfUpdate(args, overrides = {}) {
  /** @type {UpdateDeps} */
  const deps = {
    packaged: false, version: '0.0.0', execPath: executablePath() ?? '', env: process.env, platform: process.platform, arch: process.arch,
    log: line => console.log(line), warn: line => console.error(line), interactive: !!(process.stdin.isTTY && process.stdout.isTTY),
    fetchBytes, confirm, extract,
    provenance: (file, repo) => verifyProvenance(file, { repo }),
    daemon: async () => undefined, restartDaemon: binary => spawnSync(binary, ['daemon', 'restart'], { stdio: 'inherit', windowsHide: true }).status ?? 1,
    runVersion: binary => spawnSync(binary, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).stdout?.trim() ?? '',
    ...overrides,
  };
  let parsed;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: OPTIONS, strict: true });
  } catch (error) {
    deps.warn(`alp: ${error.message}`);
    deps.warn(`alp: ${TEMPLATE_HINT}`);
    return deps.packaged ? 1 : 0;
  }
  const { values, positionals } = parsed;
  if (values.help) { deps.log(UPDATE_USAGE); return 0; }
  if (!deps.packaged) { deps.log(npmMessage(positionals)); return 0; }
  if (positionals.length) { deps.warn(`alp: ${TEMPLATE_HINT}`); return 1; }

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

  let target;
  try { target = nodeFs.realpathSync(deps.execPath); } catch { target = deps.execPath; }
  const dir = path.dirname(target);
  try { nodeFs.accessSync(dir, nodeFs.constants.W_OK); } catch { throw new Error(`${dir} is not writable; run alp update with the permissions that installed ${target}`); }

  if (!values.yes) {
    if (!deps.interactive) throw new Error(`alp update would replace ${target} (${deps.version} → ${asset.version}); pass --yes to do it without a terminal`);
    if (!await deps.confirm(`Replace ${target} (${deps.version} → ${asset.version})?`)) { deps.log('Not updated.'); return 1; }
  }

  const work = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'alp-update-'));
  let staged;
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
    const unpacked = path.join(work, 'x');
    nodeFs.mkdirSync(unpacked);
    const binary = deps.extract(archive, unpacked, asset, platform);
    // Stage beside the target so the rename stays on one filesystem; no half-written file is ever alp.
    staged = path.join(dir, `.alp.update.${randomBytes(6).toString('hex')}${deps.platform === 'win32' ? '.exe' : ''}`);
    nodeFs.copyFileSync(binary, staged);
    if (deps.platform !== 'win32') nodeFs.chmodSync(staged, 0o755);
    const reported = deps.runVersion(staged);
    if (reported !== asset.version) throw new Error(`The downloaded executable reports version ${JSON.stringify(reported)}, not ${asset.version}; nothing was replaced`);
    replaceExecutable(staged, target, { platform: deps.platform });
    staged = undefined;
  } finally {
    if (staged) nodeFs.rmSync(staged, { force: true });
    nodeFs.rmSync(work, { recursive: true, force: true });
  }
  deps.log(`Updated ${target}: ${deps.version} → ${asset.version}`);

  const running = await deps.daemon().catch(() => undefined);
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
