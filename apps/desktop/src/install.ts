/**
 * Installing ALP when the app finds none (t-81b0.8, docs/alp/desktop.md §4). The app does not download
 * or run any script from the network: it runs the install.sh it was built with (dist/install.sh, a copy
 * of the repository's), which downloads the release archive, checks it against the release's SHA256SUMS
 * and installs it the way `curl … install.sh | sh` does. Before that, the app reads only the release's
 * SHA256SUMS, to name the version, the archive and the paths on the confirmation page; nothing is
 * written until the user chooses Install there.
 *
 * Pure parts only; main.ts wires them to Electron.
 */
import path from 'node:path';

export const REPO = 'phucanh08/alp';
export const RELEASES = `https://github.com/${REPO}/releases`;
/** The first release with `alp dashboard`, which the app runs (0.0.1-beta.9). */
export const MIN_VERSION = '0.0.1-beta.9';
/**
 * A local release mirror (an absolute directory or file:// URL) the e2e installs from. Read only by an
 * app that is not packaged (`electron .` from a checkout); ALP.app ignores it (installSource).
 */
export const MIRROR_VARIABLE = 'ALP_DESKTOP_INSTALL_MIRROR';
/** install.sh reads these to change where it downloads from; the app passes --base-url instead. */
const SOURCE_VARIABLES = ['ALP_INSTALL_BASE_URL', 'ALP_INSTALL_REPO'];

export type InstallSource = {
  /** Where the latest release's SHA256SUMS is read. */
  latest: string;
  /** The release directory install.sh downloads `version` from. */
  forVersion: (version: string) => string;
  /** True for the test mirror. */
  mirror: boolean;
};

/** GitHub Releases, or the test mirror for an app that is not packaged and has MIRROR_VARIABLE set. */
export function installSource(packaged: boolean, env: NodeJS.ProcessEnv): InstallSource {
  const value = env[MIRROR_VARIABLE];
  if (!packaged && value) {
    const url = value.startsWith('file://') ? value.replace(/\/+$/, '') : path.isAbsolute(value) ? `file://${path.resolve(value)}` : undefined;
    if (url) return { latest: url, forVersion: () => url, mirror: true };
  }
  return { latest: `${RELEASES}/latest/download`, forVersion: version => `${RELEASES}/download/v${version}`, mirror: false };
}

/** The archive's architecture name for Node's process.arch, or undefined where there is no build. */
export const archiveArch = (arch: string): string | undefined => (arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined);

export type Release = { version: string; asset: string; sha256: string };

/**
 * The macOS archive for `arch` that SHA256SUMS lists, chosen as install.sh chooses "latest": exactly one
 * `alp-<version>-darwin-<arch>.tar.gz`, a plain name, a well-formed checksum.
 */
export function pickRelease(sums: string, arch: string): Release | { error: string } {
  const suffix = `-darwin-${arch}.tar.gz`;
  const lines = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts.length >= 2)
    .map(([sha256, name]) => ({ sha256: sha256!, asset: name!.replace(/^\*/, '') }))
    .filter(entry => /^alp-[0-9]/.test(entry.asset) && entry.asset.endsWith(suffix));
  if (lines.length === 0) return { error: `The release has no ALP build for macOS ${arch}.` };
  if (lines.length > 1) return { error: `The release lists more than one ALP build for macOS ${arch}.` };
  const { sha256, asset } = lines[0]!;
  if (!/^[0-9A-Za-z.+_-]+$/.test(asset)) return { error: `The release names an unexpected archive (${asset}).` };
  if (!/^[0-9a-f]{64}$/.test(sha256)) return { error: `The release's checksum for ${asset} is malformed.` };
  const version = asset.slice('alp-'.length, -suffix.length);
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) return { error: `The release names an unexpected version (${version}).` };
  return { version, asset, sha256 };
}

/** Semantic version order (major.minor.patch, then the prerelease, which sorts before the release). */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core = '', pre] = v.split('+', 1)[0]!.split(/-(.*)/s);
    return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a), y = split(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) < (y.core[i] ?? 0) ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

export type InstallPlan = Release & {
  /** The release directory install.sh downloads from. */
  source: string;
  /** <home>/.alp: install.sh's --root. */
  root: string;
  /** Where this version's files go. */
  appDir: string;
  /** The alp command (a symlink to <root>/app/current/bin/alp). */
  command: string;
  /** The ALP home (data and alpd's socket). */
  alpHome: string;
  /** Whether install.sh creates the ALP home (0700) when it is missing: only when it is <root>. */
  createsHome: boolean;
};

/** What will be installed where, for the confirmation page and for install.sh's arguments. */
export function installPlan(release: Release, source: InstallSource, home: string, env: NodeJS.ProcessEnv): InstallPlan {
  const root = path.join(home, '.alp');
  const alpHome = env.ALP_HOME && path.isAbsolute(env.ALP_HOME) ? path.resolve(env.ALP_HOME) : root;
  return {
    ...release,
    source: source.forVersion(release.version),
    root,
    appDir: path.join(root, 'app', release.version),
    command: path.join(root, 'bin', 'alp'),
    alpHome,
    createsHome: alpHome === root,
  };
}

/**
 * install.sh's arguments after `sh -s --`: this version from this release, into <home>/.alp with the
 * command in <home>/.alp/bin, and no shell profile edit (the app runs <home>/.alp/bin/alp itself).
 */
export const installArgs = (plan: InstallPlan): string[] => [
  '--version', plan.version, '--base-url', plan.source, '--root', plan.root, '--dir', path.dirname(plan.command), '--no-modify-path',
];

/** install.sh's environment: the app's, without what would change its source or Electron's mode. */
export function installEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const name of [...SOURCE_VARIABLES, 'ELECTRON_RUN_AS_NODE', MIRROR_VARIABLE]) delete out[name];
  // install.sh needs curl, shasum, tar and mktemp: the system's come first, before anything on the app's PATH.
  out.PATH = ['/usr/bin:/bin:/usr/sbin:/sbin', env.PATH].filter(Boolean).join(':');
  return out;
}

/** The reason install.sh gave (its `alp-install: error:` line), else the end of its output. */
export function installFailure(result: { code: number | null; stdout: string; stderr: string; timedOut: boolean; error?: Error }): string {
  if (result.timedOut) return 'the installer did not finish in time';
  if (result.error) return result.error.message;
  const errors = result.stderr.split(/\r?\n/).filter(line => line.startsWith('alp-install: error: '));
  if (errors.length) return errors[errors.length - 1]!.slice('alp-install: error: '.length);
  const tail = (result.stderr.trim() || result.stdout.trim()).split(/\r?\n/).slice(-5).join('\n');
  return tail || `the installer exited with code ${result.code}`;
}

/**
 * Why an ALP home that already exists will stop alpd: any group or other permission bit (alpd refuses
 * a home that is not 0700, and install.sh leaves an existing home's mode alone, only warning). `mode` is
 * the home's st_mode, or undefined when it does not exist (install.sh then creates it 0700).
 */
export function homeWarning(alpHome: string, mode: number | undefined): string | undefined {
  if (mode === undefined || (mode & 0o077) === 0) return undefined;
  return `${alpHome} already exists and other users can read or enter it (mode ${(mode & 0o777).toString(8).padStart(3, '0')}). ALP needs it private, or alpd will refuse to start. Fix it in a terminal with: chmod 700 '${alpHome}'`;
}

/** install.sh's warnings (`alp-install: warning: …` lines), which it prints on success too. */
export const installWarnings = (output: string): string[] => output.split(/\r?\n/)
  .filter(line => line.startsWith('alp-install: warning: ')).map(line => line.slice('alp-install: warning: '.length));

/** The confirmation page's query: everything it states, and the one-time nonce its buttons carry. */
export function confirmQuery(plan: InstallPlan, nonce: string, warning?: string): Record<string, string> {
  return {
    ...(warning ? { homeWarning: warning } : {}),
    version: plan.version, asset: plan.asset, sha256: plan.sha256, source: plan.source,
    appDir: plan.appDir, command: plan.command, alpHome: plan.alpHome, bin: path.dirname(plan.command), nonce,
    homeNote: plan.createsHome
      ? 'created private (0700, only you can read it) if it does not exist yet; an existing folder keeps its permissions, and ALP needs it to be 0700'
      : 'not created by the installer: ALP_HOME points outside the install folder',
  };
}

/**
 * The page's answer: alp-page://app/confirm?action=install|cancel&nonce=<nonce>, a navigation the main
 * process stops and reads. Undefined for anything else.
 */
export function confirmAction(url: string): { action: 'install' | 'cancel'; nonce: string } | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== 'alp-page:' || parsed.host !== 'app' || parsed.pathname !== '/confirm') return undefined;
  const action = parsed.searchParams.get('action');
  const nonce = parsed.searchParams.get('nonce');
  if ((action !== 'install' && action !== 'cancel') || !nonce) return undefined;
  return { action, nonce };
}

/**
 * The latest release's macOS build for `arch`, read from `<source.latest>/SHA256SUMS` with `read`, or why
 * not (no build, unreadable, older than MIN_VERSION).
 */
export async function latestRelease(source: InstallSource, arch: string, read: (url: string) => Promise<string>): Promise<Release | { error: string }> {
  const name = archiveArch(arch);
  if (!name) return { error: `ALP has no build for this Mac's architecture (${arch}).` };
  let sums: string;
  try { sums = await read(`${source.latest}/SHA256SUMS`); } catch (error) {
    return { error: `Could not read the latest ALP release (${source.latest}/SHA256SUMS): ${error instanceof Error ? error.message : String(error)}` };
  }
  const release = pickRelease(sums, name);
  if ('error' in release) return release;
  if (compareVersions(release.version, MIN_VERSION) < 0) return { error: `The latest ALP release is ${release.version}; this app needs ${MIN_VERSION} or later.` };
  return release;
}
