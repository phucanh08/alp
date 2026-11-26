import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import * as nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { bundleInfo, NATIVE_DAEMON, samePath } from '@anhlp/alp-core/packaged';
import type { BundleInfo } from '@anhlp/alp-core/packaged';

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

const OPTIONS = { check: { type: 'boolean' }, yes: { type: 'boolean', short: 'y' }, version: { type: 'string' }, 'base-url': { type: 'string' }, help: { type: 'boolean', short: 'h' } } as const;

export const UPDATE_USAGE = `Usage: alp update [--check] [--yes] [--version X] [--base-url URL]
Installs the latest ALP release (or release X) from GitHub Releases beside this one and switches to it, after checking
it against SHA256SUMS and, when gh is installed, its build provenance. --check only reports.
ALP_UPDATE_BASE_URL (as --base-url, an https:// or file:// mirror) and ALP_INSTALL_REPO (owner/name) override the source.
The project template upgrade is \`alp update-template [directory]\`.`;

/** The release platform of this process: darwin-arm64, linux-x64, windows-x64. */
export function releasePlatform(platform: string = process.platform, arch: string = process.arch): string {
  const osName = ({ darwin: 'darwin', linux: 'linux', win32: 'windows' } as Record<string, string | undefined>)[platform];
  const archName = ({ x64: 'x64', arm64: 'arm64' } as Record<string, string | undefined>)[arch];
  if (!osName || !archName || (osName === 'windows' && archName !== 'x64')) throw new Error(`ALP publishes no build for ${platform}-${arch}`);
  return `${osName}-${archName}`;
}

/** The archive extension of a release platform. */
export const archiveExtension = (platform: string): '.zip' | '.tar.gz' => platform.startsWith('windows-') ? '.zip' : '.tar.gz';

/** Parses SHA256SUMS into [{ sha256, name }]. */
export function parseSums(text: string): Array<{ sha256: string; name: string }> {
  const entries: Array<{ sha256: string; name: string }> = [];
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
 */
export function selectAsset(sumsText: string, platform: string, version?: string): { name: string; sha256: string; version: string } {
  const suffix = `-${platform}${archiveExtension(platform)}`;
  const matches = parseSums(sumsText).filter(({ name }) => name.endsWith(suffix) && /^alp-[0-9]/.test(name) && (!version || name === `alp-${version}${suffix}`));
  if (matches.length === 0) throw new Error(`This release has no ALP build for ${platform}${version ? ` at version ${version}` : ''}`);
  if (matches.length > 1) throw new Error(`SHA256SUMS lists more than one ${platform} archive: ${matches.map(m => m.name).join(', ')}`);
  const [match] = matches;
  if (/[^0-9A-Za-z.+_-]/.test(match.name)) throw new Error(`Unexpected archive name in SHA256SUMS: ${match.name}`);
  return { ...match, version: match.name.slice('alp-'.length, -suffix.length) };
}

export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Refuses an archive whose digest differs from SHA256SUMS. */
export function verifyChecksum(bytes: Uint8Array, asset: { name: string; sha256: string }): string {
  const actual = sha256(bytes);
  if (actual !== asset.sha256) throw new Error(`Checksum mismatch for ${asset.name} (expected ${asset.sha256}, got ${actual}); nothing was replaced`);
  return actual;
}

/** Compares dotted versions numerically, prerelease below release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
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

/** The base URL that holds SHA256SUMS and the archives. */
export function releaseBaseUrl({ repo, version, baseUrl }: { repo: string; version?: string; baseUrl?: string }): string {
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
const isLoopbackHttp = (url: URL) => url.protocol === 'http:' && LOOPBACK.includes(url.hostname);

/**
 * Whether a download may go to `next`: every hop of an https download stays https, since one plain
 * http hop lets a man in the middle replace the archive and SHA256SUMS together. Only a loopback
 * http mirror given explicitly (tests) may use loopback http, besides https.
 */
export function allowedHop(start: string, next: string): boolean {
  const to = new URL(next);
  if (to.protocol === 'https:') return true;
  return isLoopbackHttp(new URL(start)) && isLoopbackHttp(to);
}

/**
 * Downloads `url` (https, loopback http or file) within a time and size limit, following at most 10
 * redirects itself and refusing any hop that `allowedHop` refuses.
 */
export async function fetchBytes(url: string, { timeoutMs = 10 * 60_000, max = MAX_DOWNLOAD, fetch: fetchImpl = globalThis.fetch }: { timeoutMs?: number; max?: number; fetch?: typeof globalThis.fetch } = {}): Promise<Uint8Array<ArrayBuffer>> {
  if (url.startsWith('file:')) {
    const file = fileURLToPath(url);
    if (nodeFs.statSync(file).size > max) throw new Error(`${url} is larger than ${max} bytes`);
    return new Uint8Array(await nodeFs.promises.readFile(file));
  }
  if (!allowedHop(url, url)) throw new Error(`Refusing to download ${url}: not https`);
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  let response: Response;
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
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of (response.body ?? []) as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > max) throw new Error(`${current} is larger than ${max} bytes`);
    chunks.push(chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/** Whether a program is on PATH. */
function which(name: string): string | undefined {
  const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout.split(/\r?\n/)[0].trim() || undefined : undefined;
}

/**
 * Verifies the archive's build provenance with gh. Returns 'verified', or 'unavailable' when gh is
 * absent (ALP_UPDATE_NO_GH=1 treats it as absent); throws when gh reports a failure.
 */
export function verifyProvenance(file: string, { repo, env = process.env, run = spawnSync, find = which }: { repo: string; env?: NodeJS.ProcessEnv; run?: typeof spawnSync; find?: (name: string) => string | undefined }): 'verified' | 'unavailable' {
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
const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `action`, again after a pause while Windows reports the file busy: a virus scanner holds an
 * executable it just saw run (the staged bundle's --version) for a moment. About 8 s in all.
 */
export function retryBusy<T>(action: () => T, sleep: (ms: number) => void = pause, attempts = 25): T {
  for (let attempt = 1; ; attempt++) {
    try { return action(); } catch (error) {
      if (attempt >= attempts || !TRANSIENT.has((error as NodeJS.ErrnoException | undefined)?.code as string)) throw error;
      sleep(Math.min(50 * attempt, 400));
    }
  }
}

/** What to say outside the ALP bundle (an npm install). */
export function npmMessage(positionals: string[] = []): string {
  const lines: string[] = [];
  if (positionals.length) lines.push(`alp: ${TEMPLATE_HINT}`);
  lines.push(`This alp was installed with npm; update it with npm:\n  npm install -g ${NPM_PACKAGE}@beta\nThen restart alpd when no sessions are running: alp daemon restart\n(The project template upgrade is \`alp update-template [directory]\`.)`);
  return lines.join('\n');
}

/** Why this bundle cannot update itself: it was not installed by install.sh / install.ps1. */
export const notInstalledMessage = (root: string): string => `alp: ${root} is not an installed ALP (no app/current points at it); install the release with install.sh (Windows: install.ps1), which alp update can then keep up to date:\n  curl -fsSL https://github.com/${DEFAULT_REPO}/releases/latest/download/install.sh | sh`;

/**
 * tar, as this platform must start it. On Windows it is the system's own bsdtar
 * (%SystemRoot%\System32\tar.exe), never whatever comes first on PATH: under Git Bash that is Git's
 * GNU tar, which reads a drive-letter path such as `D:\a\…\alp.zip` as a remote `host:file`
 * archive and cannot read or write a zip at all. `--force-local` is not an answer: bsdtar rejects it.
 *
 * DUPLICATE, deliberately (t-ffe4.6): `windowsTar` in scripts/spawn-command.ts is the same
 * knowledge for the repository's own scripts. This package is published, so it cannot import from
 * scripts/, and scripts/ must keep working before anything is built. Change one and change the
 * other; test/integration/spawn-command.test.ts asserts the two agree, and refuses any third copy.
 */
export const systemTar = (platform: string = process.platform, env: Record<string, string | undefined> = process.env): string =>
  platform === 'win32' ? path.win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

/** Extracts the archive into `directory` and returns the bundle inside it. */
function extract(archive: string, directory: string, asset: { name: string }, platform: string, run = spawnSync): string {
  const windows = platform.startsWith('windows-');
  // tar reads both: GNU/bsd tar for .tar.gz, Windows' bsdtar (tar.exe) for .zip.
  // On Windows, Git's GNU tar (which reads no zip) may come first on PATH: use the system's bsdtar.
  const result = run(systemTar(), [windows ? '-xf' : '-xzf', archive, '-C', directory], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`Could not extract ${asset.name}: ${(result.stderr || result.error?.message || '').trim()}`);
  const root = path.join(directory, asset.name.slice(0, -archiveExtension(platform).length));
  if (!nodeFs.existsSync(path.join(root, 'alp-bundle.json'))) throw new Error(`${asset.name} does not contain an ALP bundle (${path.basename(root)}/alp-bundle.json)`);
  return root;
}

/** The bundle's own Node and CLI: run without its launcher, so Windows needs no shell for alp.cmd. */
export function bundleCommand(root: string, platform: string = process.platform): { command: string; args: string[] } {
  const node = platform === 'win32' ? path.join(root, 'node', 'node.exe') : path.join(root, 'node', 'bin', 'node');
  return { command: node, args: [path.join(root, 'lib', 'node_modules', '@anhlp', 'alp-cli', 'dist', 'cli.js')] };
}

/**
 * Points `<app>/current` at `<app>/<version>`. Unix: a relative symlink renamed over the old one, in
 * one step. Windows: the junction is replaced (removed, then made again; put back on failure).
 */
export function switchCurrent(app: string, version: string, { platform = process.platform, fs = nodeFs, unique = () => randomBytes(6).toString('hex') }: { platform?: string; fs?: typeof nodeFs; unique?: () => string } = {}): void {
  const p = platform === 'win32' ? path.win32 : path;
  const current = p.join(app, 'current');
  if (platform !== 'win32') {
    const link = p.join(app, `.current-${unique()}`);
    fs.symlinkSync(version, link);
    try { fs.renameSync(link, current); } catch (error) { try { fs.unlinkSync(link); } catch {} throw error; }
    return;
  }
  let previous: string | undefined;
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
 */
export function pruneVersions(app: string, keep: string[], fs: typeof nodeFs = nodeFs, { keepAside = false }: { keepAside?: boolean } = {}): string[] {
  let names: string[];
  try { names = fs.readdirSync(app); } catch { return []; }
  const removed: string[] = [];
  for (const name of names) {
    if (name === 'current' || keep.includes(name) || (keepAside && name.startsWith('.alp-old-'))) continue;
    if (!/^[0-9][0-9A-Za-z.+-]*$/.test(name) && !/^\.alp-(update|old)-[0-9A-Za-z]+$/.test(name) && !/^\.current-[0-9a-f]+$/.test(name)) continue;
    try { fs.rmSync(path.join(app, name), { recursive: true, force: true }); removed.push(name); } catch {}
  }
  return removed;
}

/** Asks a yes/no question on the terminal. */
async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); } finally { rl.close(); }
}

/** What selfUpdate reaches the network, the filesystem and child processes through; tests replace any of it. */
export type UpdateDeps = {
  bundle: BundleInfo | undefined; version: string; env: NodeJS.ProcessEnv; platform: string; arch: string;
  log: (line: string) => void; warn: (line: string) => void; interactive: boolean;
  fetchBytes: (url: string) => Promise<Uint8Array>; confirm: (question: string) => Promise<boolean>;
  provenance: (file: string, repo: string) => string; extract: (archive: string, directory: string, asset: { name: string }, platform: string, run?: typeof spawnSync) => string;
  daemon: () => Promise<{ version: string; sessions?: number } | undefined>; restartDaemon: (root: string) => number;
  runVersion: (root: string) => string; runDaemonVersion: (root: string) => string;
};

/** @returns the exit code */
export async function selfUpdate(args: string[], overrides: Partial<UpdateDeps> = {}): Promise<number> {
  const deps: UpdateDeps = {
    bundle: bundleInfo(), version: '0.0.0', env: process.env, platform: process.platform, arch: process.arch,
    log: line => console.log(line), warn: line => console.error(line), interactive: !!(process.stdin.isTTY && process.stdout.isTTY),
    fetchBytes, confirm, extract,
    provenance: (file, repo) => verifyProvenance(file, { repo }),
    daemon: async () => undefined,
    restartDaemon: root => { const run = bundleCommand(root); return spawnSync(run.command, [...run.args, 'daemon', 'restart'], { stdio: 'inherit', windowsHide: true }).status ?? 1; },
    runVersion: root => { const run = bundleCommand(root); return spawnSync(run.command, [...run.args, '--version'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).stdout?.trim() ?? ''; },
    // Without BUN_BE_BUN, which would make the native alpd the Bun CLI.
    runDaemonVersion: root => spawnSync(path.join(root, 'bin', NATIVE_DAEMON), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== 'BUN_BE_BUN')) }).stdout?.trim() ?? '',
    ...overrides,
  };
  const { bundle } = deps;
  let parsed: ReturnType<typeof parseArgs<{ args: string[]; allowPositionals: true; options: typeof OPTIONS; strict: true }>>;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: OPTIONS, strict: true });
  } catch (error) {
    deps.warn(`alp: ${(error as Error).message}`);
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
  // A reinstall of the running version moves its directory aside instead of replacing it in place,
  // on Windows too: Windows renames a directory that holds a running executable. Only a process
  // whose working directory is inside the tree, or a handle opened without delete sharing, refuses
  // the move (t-5294.7, board finding p-bcd9c956) — that failure is reported below, not predicted.
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
  /** the running version, moved aside by a reinstall */
  let aside: string | undefined;
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
    // The native alpd (t-81b0.9) must run on this machine too: an old CPU, glibc or a quarantined file would
    // otherwise leave alp without a daemon after the switch.
    if (deps.env.ALP_NATIVE_DAEMON !== '0' && nodeFs.existsSync(path.join(unpacked, 'bin', NATIVE_DAEMON))) {
      const native = deps.runDaemonVersion(unpacked);
      if (native !== asset.version) throw new Error(`The downloaded ALP's native alpd (bin/${NATIVE_DAEMON}) reports version ${JSON.stringify(native)}, not ${asset.version}, so it cannot run here; nothing was changed. To update with alpd on the bundled Node, set ALP_NATIVE_DAEMON=0 for this update and keep it set`);
    }
    if (nodeFs.existsSync(target)) {
      // A reinstall of the running version moves it aside (its processes keep their files); any other copy is stale.
      if (samePath(target, bundle.root) || running?.version === asset.version) {
        const moved = `.alp-old-${randomBytes(6).toString('hex')}`;
        try { retryBusy(() => nodeFs.renameSync(target, path.join(app, moved))); } catch (error) {
          // Nothing has been replaced yet. Say what really holds the directory, so nobody looks for
          // a Windows rule that does not exist (t-5294.7).
          throw new Error(`Could not move ${target} aside to reinstall ALP ${asset.version}: ${(error as Error).message}. Something holds that directory: a process whose working directory is inside it, or a file handle opened without delete sharing. Stop alpd (alp daemon stop), leave that directory in any shell, and run alp update again`, { cause: error });
        }
        aside = moved;
      }
      else nodeFs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    try { retryBusy(() => nodeFs.renameSync(unpacked, target)); } catch (error) {
      // The running version goes back where it was, so app/current still points at files (t-1f14).
      if (aside && !nodeFs.existsSync(target)) {
        // `aside!` below: the rename that would clear it is what failed.
        try { nodeFs.renameSync(path.join(app, aside), target); aside = undefined; } catch { throw new Error(`${(error as Error).message}; the running ALP ${asset.version} is in ${path.join(app, aside!)}: move it back to ${target}`, { cause: error }); }
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
