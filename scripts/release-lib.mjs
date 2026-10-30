// Release artifacts for docs/alp/beta-scope.md §6–7: which packages a release is, the manifest and
// SHA256SUMS that pin the tarballs packed once, the checks run on those saved files (A5), and the
// gate table that decides whether they may be published. Nothing here packs, builds or publishes.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { corePackageProblems } from './core-package-boundary.mjs';
import { THIRD_PARTY_NOTICES, packageDirectory, packageName } from './third-party-notices.mjs';
import { PLATFORMS, PLATFORM_NAMES, platformOf } from './npm-platform.mjs';

export { PLATFORM_NAMES };
/** The npm launcher (t-cd7f): `alp` runs the ALP executable from the platform package for the machine. */
export const LAUNCHER = '@anhlp/alp';
export const LAUNCHER_LOCATION = 'npm/alp';

/**
 * The thirteen public packages, in publish order (§7.4): the seven JavaScript workspaces, the five
 * platform packages generated from the GitHub release archives (npm-platform.mjs; `location` null),
 * and last the launcher, whose optional dependencies they are. Every other workspace must be private.
 */
export const RELEASE_PACKAGES = [
  { name: '@anhlp/alp-protocol', location: 'packages/protocol', kind: 'workspace' },
  { name: '@anhlp/alp-core', location: 'packages/core', kind: 'workspace' },
  { name: '@anhlp/alp-runtime', location: 'packages/runtime', kind: 'workspace' },
  { name: '@anhlp/alp-client', location: 'packages/client', kind: 'workspace' },
  { name: '@anhlp/alp-daemon', location: 'packages/daemon', kind: 'workspace' },
  { name: '@anhlp/alp-cli', location: 'packages/cli', kind: 'workspace' },
  { name: '@anhlp/alp-paseo', location: 'integrations/paseo', kind: 'workspace' },
  ...PLATFORMS.map(platform => ({ name: platform.name, location: null, kind: 'platform' })),
  { name: LAUNCHER, location: LAUNCHER_LOCATION, kind: 'launcher' },
];
export const RELEASE_NAMES = RELEASE_PACKAGES.map(pkg => pkg.name);
/** A rehearsal packed without release archives has every package but the platform ones. */
export const releaseNames = ({ platforms = true } = {}) => RELEASE_NAMES.filter(name => platforms || !PLATFORM_NAMES.includes(name));

/** The platform package npm installs on this machine (none on an unsupported one). */
export function hostPlatformName({ platform = process.platform, arch = process.arch } = {}) {
  return PLATFORMS.find(entry => entry.os === platform && entry.cpu === arch)?.name;
}

/** The tarballs a consumer on this machine installs: npm refuses another platform's package outright. */
export const installableArtifacts = (artifacts, host = hostPlatformName()) => artifacts.filter(artifact => !PLATFORM_NAMES.includes(artifact.name) || artifact.name === host);

/**
 * The `npm install` flags of every consumer that installs the launcher from saved tarballs
 * (release-consumer, package-smoke). The saved tarballs are the consumer's own dependencies, so
 * `--omit=optional` still installs them, the host's platform package included when the release
 * carries it. What it leaves out is what only the launcher's optionalDependencies reach: once the
 * platform packages are published, npm would otherwise install this machine's from the registry,
 * and a rehearsal packed without the archives would run a published executable. npm still locks
 * those packages (optional), so installedProblems needs to know they are not in node_modules.
 */
export const SAVED_INSTALL_FLAGS = Object.freeze(['--omit=optional']);
export const PLUGIN = '@anhlp/alp-paseo';
export const MANIFEST_FILE = 'release-manifest.json';
export const SUMS_FILE = 'SHA256SUMS';
const DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'];
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** `npm pack`'s file name: `@anhlp/alp-core` at 1.0.0 is `anhlp-alp-core-1.0.0.tgz`. */
export const tarballFilename = (name, version) => `${name.replace(/^@/, '').replace('/', '-')}-${version}.tgz`;

/** The digests the release records: SHA-256 for SHA256SUMS, and npm's own `integrity` (sha512) and `shasum` (sha1). */
export function digests(buffer) {
  return {
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(buffer).digest('base64')}`,
    shasum: createHash('sha1').update(buffer).digest('hex'),
  };
}

/** `sha256sum`/`shasum -a 256` format, so the file checks with `sha256sum -c` as well as with this script. */
export const formatSha256Sums = entries => [...entries].sort((a, b) => a.filename.localeCompare(b.filename)).map(entry => `${entry.sha256}  ${entry.filename}\n`).join('');

export function parseSha256Sums(text) {
  const sums = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`${SUMS_FILE}: unreadable line ${JSON.stringify(line)}`);
    if (sums.has(match[2])) throw new Error(`${SUMS_FILE}: ${match[2]} listed twice`);
    sums.set(match[2], match[1]);
  }
  return sums;
}

/**
 * The regular files of a gzipped tarball, relative to npm's `package/` root. Reads ustar names with
 * their prefix field, plus pax and GNU long names, which is everything `npm pack` writes.
 */
export function readTarball(buffer) {
  const data = gunzipSync(buffer);
  const files = new Map();
  const field = (block, start, length) => block.subarray(start, start + length).toString('utf8').replace(/\0[\s\S]*$/, '');
  let longName;
  for (let offset = 0; offset + 512 <= data.length;) {
    const header = data.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') { longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? longName; continue; }
    if (type === 'L') { longName = body.toString('utf8').replace(/\0+$/, ''); continue; }
    if (type === 'g') continue;
    const prefix = field(header, 345, 155);
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    longName = undefined;
    if (type !== '0' && type !== '7') continue;
    files.set(name.replace(/^[^/]+\//, ''), Buffer.from(body));
  }
  return files;
}

/** Internal dependencies must name a released package and pin the release version exactly. */
export function internalDependencyProblems(pkg, version) {
  const problems = [];
  for (const field of DEPENDENCY_FIELDS) {
    for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
      if (!name.startsWith('@anhlp/')) continue;
      if (!RELEASE_NAMES.includes(name)) problems.push(`${pkg.name}: ${field} ${name} is not one of the released packages`);
      else if (spec !== version) problems.push(`${pkg.name}: ${field} ${name}@${spec}, not pinned to ${version}`);
    }
  }
  return problems;
}

/** The launcher's own rules: no dependencies or install scripts, and exactly the five platform packages, pinned. */
export function launcherProblems(pkg, version) {
  const problems = [];
  if (Object.keys(pkg.dependencies ?? {}).length || Object.keys(pkg.peerDependencies ?? {}).length) problems.push(`${LAUNCHER}: the launcher must have no dependencies`);
  for (const script of ['preinstall', 'install', 'postinstall', 'prepare']) if (pkg.scripts?.[script]) problems.push(`${LAUNCHER}: no ${script} script (nothing is downloaded after install)`);
  const expected = Object.fromEntries(PLATFORM_NAMES.map(name => [name, version]));
  if (JSON.stringify(pkg.optionalDependencies ?? {}) !== JSON.stringify(expected)) problems.push(`${LAUNCHER}: optionalDependencies must be exactly ${PLATFORM_NAMES.map(name => `${name}@${version}`).join(', ')}`);
  if (JSON.stringify(pkg.bin) !== JSON.stringify({ alp: 'bin/alp.js' })) problems.push(`${LAUNCHER}: bin must be { alp: bin/alp.js }`);
  return problems;
}

/** A platform package's own rules: its os/cpu/libc, only its executable, nothing else to run. */
export function platformProblems(pkg, files) {
  const platform = platformOf(pkg.name);
  if (!platform) return [`${pkg.name}: not a platform package`];
  const problems = [];
  if (JSON.stringify(pkg.os) !== JSON.stringify([platform.os]) || JSON.stringify(pkg.cpu) !== JSON.stringify([platform.cpu])) problems.push(`${pkg.name}: os/cpu must be [${platform.os}]/[${platform.cpu}]`);
  if (JSON.stringify(pkg.libc) !== JSON.stringify(platform.libc ? [platform.libc] : undefined)) problems.push(`${pkg.name}: libc must be ${platform.libc ? `[${platform.libc}]` : 'absent'}`);
  for (const field of ['bin', 'scripts', 'dependencies', 'optionalDependencies', 'peerDependencies', 'main', 'exports']) if (pkg[field] !== undefined) problems.push(`${pkg.name}: must have no ${field}`);
  if (files && !files.has(`bin/${platform.executable}`)) problems.push(`${pkg.name}: no bin/${platform.executable}`);
  const allowed = ['package.json', 'README.md', 'LICENSE', 'NOTICE', THIRD_PARTY_NOTICES, `bin/${platform.executable}`];
  const extra = files ? [...files.keys()].filter(file => !allowed.includes(file)) : [];
  if (extra.length) problems.push(`${pkg.name}: a platform package ships only its executable and licence files, found ${extra.join(', ')}`);
  if (files && !files.has(THIRD_PARTY_NOTICES)) problems.push(`${pkg.name}: no ${THIRD_PARTY_NOTICES}`);
  return problems;
}

/**
 * Source checks before packing: exactly the release packages are public, all at `version` with
 * internal dependencies pinned to it, and package-lock.json agrees with the workspace manifests.
 * `workspaces` is `[{ location, pkg }]` for the root (`.`), every workspace and the launcher
 * (npm/alp, outside the workspaces). The platform packages are generated at pack time.
 */
export function sourceProblems({ workspaces, lock, version }) {
  const problems = [];
  if (!VERSION.test(version ?? '')) return [`release version ${JSON.stringify(version)} is not a semver version`];
  const publicNames = workspaces.filter(({ pkg }) => !pkg.private).map(({ pkg }) => pkg.name);
  for (const name of publicNames) if (!RELEASE_NAMES.includes(name)) problems.push(`${name} is public but not a release package; mark it "private": true`);
  for (const expected of RELEASE_PACKAGES) {
    if (expected.kind === 'platform') continue;
    const found = workspaces.find(({ pkg }) => pkg.name === expected.name);
    if (!found) { problems.push(`${expected.name}: no workspace has this name`); continue; }
    if (found.location !== expected.location) problems.push(`${expected.name}: found at ${found.location}, expected ${expected.location}`);
    if (found.pkg.private) problems.push(`${expected.name}: is private, but it is released`);
    if (found.pkg.version !== version) problems.push(`${expected.name}: version ${found.pkg.version}, expected ${version}`);
    problems.push(...internalDependencyProblems(found.pkg, version));
    if (expected.kind === 'launcher') { problems.push(...launcherProblems(found.pkg, version)); continue; }
    const locked = lock?.packages?.[expected.location === '.' ? '' : expected.location];
    if (!locked) { problems.push(`${expected.name}: package-lock.json has no entry for ${expected.location}`); continue; }
    if (locked.version !== version) problems.push(`${expected.name}: package-lock.json records ${locked.version}, expected ${version}`);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(found.pkg[field] ?? {})) {
        if (name.startsWith('@anhlp/') && locked[field]?.[name] !== spec) problems.push(`${expected.name}: package-lock.json ${field} ${name}@${locked[field]?.[name]} differs from package.json ${spec}; run npm install`);
      }
    }
  }
  return problems;
}

/** The release manifest (§7.2 P3): where and from what the tarballs were packed, and each tarball's identity. */
export function createReleaseManifest({ version, git, build, pack, artifacts, sha256sums }) {
  return {
    schema: 1,
    version,
    distTag: 'beta',
    git,
    build,
    pack,
    sha256sums,
    packages: artifacts.map(({ name, version, filename, size, sha256, integrity, shasum, entryCount, binary }) => ({ name, version, filename, size, sha256, integrity, shasum, entryCount, ...(binary ? { binary } : {}) })),
  };
}

/**
 * `alp web` runs alp-web (docs/alp/web.md): its service bundle, the browser app and their notices
 * ship inside the CLI package (the executable embeds them too). The gateway it inlines stays private
 * (A5 refuses a tarball outside the release); this list is checked beside A5, not as part of it.
 */
const ALP_WEB_FILES = ['dist/alp-web.js', 'dist/alp-web/index.html', `dist/alp-web/${THIRD_PARTY_NOTICES}`, `dist/${THIRD_PARTY_NOTICES}`];
export const SHIPPED_WEB_FILES = Object.freeze({
  '@anhlp/alp-cli': ALP_WEB_FILES,
});

/**
 * Missing alp-web assets or bundled-only source leaked into a packed package.
 * @param {string} name @param {Iterable<string>} files the packed paths, relative to the package root
 */
export function shippedWebProblems(name, files) {
  const packed = new Set(files);
  const problems = (SHIPPED_WEB_FILES[name] ?? []).filter(file => !packed.has(file)).map(file => `${name}: ${file} is not packed; alp web cannot run (build the CLI with apps/gateway and apps/web present)`);
  const sourcePrefix = name === '@anhlp/alp-cli' ? 'src/web/' : undefined;
  if (sourcePrefix && [...packed].some(file => file.startsWith(sourcePrefix))) problems.push(`${name}: bundled-only ${sourcePrefix} is packed; it imports the unpublished gateway (ship dist/alp-web.js instead)`);
  return problems;
}

/** Problems a single packed package has, from its own files (no repository source involved). */
function contentProblems(name, files, version, rootFiles, entry = {}) {
  const problems = [];
  const text = file => files.get(file)?.toString('utf8');
  let pkg;
  try { pkg = JSON.parse(text('package.json')); } catch { return { problems: [`${name}: package.json missing or unreadable`] }; }
  if (pkg.name !== name) problems.push(`${name}: packed package.json is ${pkg.name}`);
  if (pkg.version !== version) problems.push(`${name}: packed version ${pkg.version}, expected ${version}`);
  if (pkg.private) problems.push(`${name}: packed package.json is private`);
  problems.push(...internalDependencyProblems(pkg, version));
  if (pkg.license !== 'Apache-2.0') problems.push(`${name}: license is ${pkg.license}, not Apache-2.0`);
  if (!files.has('LICENSE')) problems.push(`${name}: no LICENSE`);
  else if (rootFiles?.has('LICENSE') && !files.get('LICENSE').equals(rootFiles.get('LICENSE'))) problems.push(`${name}: LICENSE differs from @anhlp/alp's`);
  if (!files.has('NOTICE')) problems.push(`${name}: no NOTICE`);
  for (const bin of Object.values(typeof pkg.bin === 'string' ? { [name]: pkg.bin } : pkg.bin ?? {})) {
    if (!files.has(bin.replace(/^\.\//, ''))) problems.push(`${name}: missing executable ${bin}`);
  }
  if (name === LAUNCHER) {
    problems.push(...launcherProblems(pkg, version));
    const extra = [...files.keys()].filter(file => !['package.json', 'README.md', 'LICENSE', 'NOTICE', 'bin/alp.js', 'lib/launcher.js'].includes(file));
    if (extra.length) problems.push(`${name}: the launcher ships only bin/alp.js and lib/launcher.js, found ${extra.join(', ')}`);
  }
  if (PLATFORM_NAMES.includes(name)) {
    problems.push(...platformProblems(pkg, files));
    const binary = files.get(`bin/${platformOf(name).executable}`);
    if (!entry.binary?.sha256) problems.push(`${name}: ${MANIFEST_FILE} records no binary sha256`);
    else if (binary && createHash('sha256').update(binary).digest('hex') !== entry.binary.sha256) problems.push(`${name}: bin/${platformOf(name).executable} is not the executable ${MANIFEST_FILE} recorded from ${entry.binary.archive}`);
  }
  if (name === PLUGIN) {
    // The plugin carries code taken from Paseo (the bridge in server/dist): Paseo's licence ships with it.
    if (!files.has('LICENSE.paseo.txt')) problems.push(`${name}: no LICENSE.paseo.txt`);
    // Paseo's web app was removed (t-55ce.3); a checkout that built it before still has it in server/dist.
    if ([...files.keys()].some(file => file.startsWith('server/dist/web-app/'))) problems.push(`${name}: carries a stale server/dist/web-app (Paseo's removed web app); delete it and pack again`);
    const notice = text('NOTICE') ?? '';
    const rootNotice = rootFiles?.get('NOTICE')?.toString('utf8');
    if (!/Paseo/.test(notice) || (rootNotice && !notice.startsWith(rootNotice))) problems.push(`${name}: NOTICE is not ALP's NOTICE followed by Paseo's attribution`);
  } else {
    problems.push(...corePackageProblems(pkg, [...files.keys()]));
    if (rootFiles?.has('NOTICE') && files.has('NOTICE') && !files.get('NOTICE').equals(rootFiles.get('NOTICE'))) problems.push(`${name}: NOTICE differs from @anhlp/alp's`);
  }
  // Every package esbuild inlined (its `// node_modules/...` module comments) is listed in a notices file.
  const notices = [...files].filter(([file]) => file.endsWith(THIRD_PARTY_NOTICES)).map(([, body]) => body.toString('utf8')).join('\n');
  const bundled = new Set();
  for (const [file, body] of files) {
    if (!file.endsWith('.js')) continue;
    for (const [, comment] of body.toString('utf8').matchAll(/^\/\/ (\S+)$/gm)) {
      const directory = packageDirectory(comment);
      if (directory) bundled.add(packageName(directory));
    }
  }
  for (const bundle of bundled) if (!notices.includes(`\n${bundle}@`)) problems.push(`${name}: bundles ${bundle} but no ${THIRD_PARTY_NOTICES} lists it`);
  return { problems, pkg };
}

/**
 * Reads a release directory and checks only what is in it (A5): exactly the manifest's thirteen
 * tarballs (eight in a rehearsal packed without release archives), each matching SHA256SUMS and the manifest's sha256/integrity/shasum/size/entryCount,
 * at one version, with their licences and without Paseo in the core packages.
 * Returns `{ manifest, artifacts, problems, checksumProblems, notes }`: `checksumProblems` (also in
 * `problems`) are the files that are not the ones the manifest pinned; `artifacts` carry each packed package.json.
 * `rehearsal` accepts a dirty or script-less pack, reported in `notes`; such a pack is not gate evidence.
 */
export function verifyRelease(directory, { sha, version, rehearsal = false } = {}) {
  const problems = [];
  const checksumProblems = [];
  const notes = [];
  const read = file => readFileSync(path.join(directory, file));
  const fail = (...found) => ({ manifest, problems: found, checksumProblems: found, notes, artifacts: [] });
  let manifest;
  try { manifest = JSON.parse(read(MANIFEST_FILE).toString('utf8')); } catch (error) { return fail(`${MANIFEST_FILE}: ${error.code === 'ENOENT' ? 'missing' : error.message}`); }
  let sums;
  let sumsBuffer;
  try { sumsBuffer = read(SUMS_FILE); sums = parseSha256Sums(sumsBuffer.toString('utf8')); } catch (error) { return fail(`${SUMS_FILE}: ${error.code === 'ENOENT' ? 'missing' : error.message}`); }

  if (manifest.schema !== 1) problems.push(`${MANIFEST_FILE}: unknown schema ${manifest.schema}`);
  const expectedVersion = version ?? manifest.version;
  if (manifest.version !== expectedVersion) problems.push(`${MANIFEST_FILE}: version ${manifest.version}, expected ${expectedVersion}`);
  if (sha && manifest.git?.sha !== sha) problems.push(`${MANIFEST_FILE}: packed from ${manifest.git?.sha}, not the release SHA ${sha}`);
  if (manifest.sha256sums !== digests(sumsBuffer).sha256) checksumProblems.push(`${MANIFEST_FILE}: sha256sums does not match ${SUMS_FILE}`);
  const rehearsalOnly = [];
  if (!/^[0-9a-f]{40}$/.test(manifest.git?.sha ?? '')) rehearsalOnly.push('no git SHA recorded');
  if (manifest.git?.dirty !== false) rehearsalOnly.push('packed from a checkout with uncommitted changes');
  if (!manifest.git?.tag) rehearsalOnly.push('no release tag at the packed commit');
  if (manifest.pack?.ignoreScripts !== false) rehearsalOnly.push('packed with --ignore-scripts (prepack did not run as for publish)');
  const platforms = manifest.pack?.platforms !== false;
  if (!platforms) rehearsalOnly.push('packed without the release archives: no platform packages, so the launcher has no executable');
  else {
    // The archives must be tied to the release-binaries run that drafted the GitHub release (release-acceptance sets it).
    if (!/^\d+$/.test(String(manifest.pack?.binariesRun ?? '')) && !/^v\d/.test(manifest.pack?.binariesRelease?.tag ?? '')) rehearsalOnly.push('platform packages not tied to a release-binaries run (pack.binariesRun) or a published GitHub release (pack.binariesRelease)');
    if (!/^[0-9a-f]{64}$/.test(manifest.pack?.archiveSha256Sums ?? '')) rehearsalOnly.push('no SHA256SUMS digest of the release archives (pack.archiveSha256Sums)');
  }
  for (const reason of rehearsalOnly) (rehearsal ? notes : problems).push(`${MANIFEST_FILE}: ${reason}`);

  const listed = (manifest.packages ?? []).map(entry => entry.name);
  const expectedNames = releaseNames({ platforms });
  if (JSON.stringify(listed) !== JSON.stringify(expectedNames)) problems.push(`${MANIFEST_FILE}: packages are ${listed.join(', ')}; expected ${expectedNames.join(', ')} in publish order`);
  const tarballs = readdirSync(directory).filter(file => file.endsWith('.tgz')).sort();
  const expectedFiles = (manifest.packages ?? []).map(entry => entry.filename).sort();
  for (const file of tarballs) if (!expectedFiles.includes(file)) checksumProblems.push(`${file}: tarball not in ${MANIFEST_FILE}`);
  for (const file of sums.keys()) if (!expectedFiles.includes(file)) checksumProblems.push(`${SUMS_FILE}: lists ${file}, which is not in ${MANIFEST_FILE}`);

  const artifacts = [];
  for (const entry of manifest.packages ?? []) {
    const label = `${entry.name} (${entry.filename})`;
    if (entry.version !== expectedVersion) problems.push(`${label}: version ${entry.version}, expected ${expectedVersion}`);
    if (entry.filename !== tarballFilename(entry.name, expectedVersion)) problems.push(`${label}: expected file name ${tarballFilename(entry.name, expectedVersion)}`);
    let buffer;
    try { buffer = read(entry.filename); } catch { checksumProblems.push(`${label}: tarball missing`); continue; }
    const actual = digests(buffer);
    if (sums.get(entry.filename) !== actual.sha256) checksumProblems.push(`${label}: SHA-256 ${actual.sha256} does not match ${SUMS_FILE} (${sums.get(entry.filename) ?? 'not listed'})`);
    for (const key of ['sha256', 'integrity', 'shasum', 'size']) if (entry[key] !== actual[key]) checksumProblems.push(`${label}: ${key} ${actual[key]} does not match ${MANIFEST_FILE} (${entry[key]})`);
    let files;
    try { files = readTarball(buffer); } catch (error) { checksumProblems.push(`${label}: unreadable tarball: ${error.message}`); continue; }
    artifacts.push({ ...entry, file: path.join(directory, entry.filename), files });
  }
  const rootFiles = artifacts.find(artifact => artifact.name === LAUNCHER)?.files;
  for (const artifact of artifacts) {
    // npm's entryCount is the number of files it packed.
    if (artifact.files.size !== artifact.entryCount) problems.push(`${artifact.name}: ${artifact.files.size} files, but npm packed ${artifact.entryCount}`);
    const { problems: found, pkg } = contentProblems(artifact.name, artifact.files, expectedVersion, rootFiles, artifact);
    problems.push(...found);
    artifact.manifest = pkg;
  }
  return { manifest, artifacts, problems: [...checksumProblems, ...problems], checksumProblems, notes };
}

/**
 * The tarballs of a saved release, after their SHA-256 matches SHA256SUMS and the manifest, for the
 * consumer checks to install as they are (no repacking). Throws on any mismatch.
 */
export function releaseArtifacts(directory, options = {}) {
  const { checksumProblems, artifacts } = verifyRelease(directory, options);
  if (checksumProblems.length) throw new Error(`release artifacts in ${directory} do not match their checksums:\n${checksumProblems.join('\n')}`);
  const names = artifacts.map(artifact => artifact.name);
  const expected = names.some(name => PLATFORM_NAMES.includes(name)) ? RELEASE_NAMES : releaseNames({ platforms: false });
  if (JSON.stringify(names) !== JSON.stringify(expected)) throw new Error(`release artifacts in ${directory} are ${names.join(', ')}, not the ${RELEASE_NAMES.length} release packages`);
  return artifacts;
}

/**
 * Problems with what a consumer's package-lock.json installed, against the release manifest. Of the
 * platform packages only the host's is installed (`host`; none on an unsupported machine).
 * `installed(key)` says whether a lockfile entry is in the consumer's node_modules (unknown: yes).
 */
export function installedProblems(lock, manifest, host = hostPlatformName(), { installed = () => true } = {}) {
  const problems = [];
  const expected = new Map(manifest.packages.map(entry => [entry.name, entry]));
  const seen = new Set();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const name = /(?:^|\/)node_modules\/(@anhlp\/[^/]+)$/.exec(key)?.[1];
    if (!name) continue;
    seen.add(name);
    // Another platform's package: npm resolves the launcher's optional dependency from the registry
    // (once published) or skips it; it is never installed on this machine, so its entry is not checked.
    if (PLATFORM_NAMES.includes(name) && name !== host) continue;
    const release = expected.get(name);
    // The host's platform package when the release does not carry it (a rehearsal packed without the
    // archives): npm locks the launcher's optional dependency from the registry, and SAVED_INSTALL_FLAGS
    // keep it out of node_modules, so the launcher has no executable, as packed.
    if (!release && name === host && entry.optional && !installed(key)) continue;
    if (!release) { problems.push(`${key}: ${name} is not part of the release${entry.resolved ? ` (installed from ${entry.resolved})` : ''}`); continue; }
    if (entry.version !== manifest.version) problems.push(`${key}: installed ${entry.version}, expected ${manifest.version}`);
    if (entry.integrity !== release.integrity) problems.push(`${key}: integrity ${entry.integrity} is not the saved tarball's ${release.integrity}`);
    if (!entry.resolved?.startsWith('file:') || !entry.resolved.endsWith(release.filename)) problems.push(`${key}: resolved from ${entry.resolved}, not the saved ${release.filename}`);
  }
  for (const { name } of manifest.packages) if (!seen.has(name) && (!PLATFORM_NAMES.includes(name) || name === host)) problems.push(`${name}: not installed`);
  return problems;
}

/**
 * The acceptance rows of §6.1 and §7.5. `binds` says what a pass must name: `sha` the release SHA,
 * `artifacts` also the SHA-256 of the saved SHA256SUMS (the exact thirteen tarballs).
 */
export const GATE_ROWS = [
  { id: 'H1', title: 'CI core + paseo (validate:core, validate:paseo), Ubuntu, Node 22 and 24', blocking: true, binds: 'sha' },
  { id: 'H2', title: 'validate:core + validate:paseo on macOS (CI core-paseo-macos, Node 24)', blocking: true, binds: 'sha' },
  { id: 'H3', title: 'CI packages-and-web (validate:packages), Ubuntu, Node 22', blocking: true, binds: 'sha' },
  { id: 'H4', title: 'CI windows-daemon, Node 22 and 24', blocking: true, binds: 'sha' },
  { id: 'H5', title: 'CI alp-web, Ubuntu and macOS', blocking: false, binds: 'sha' },
  { id: 'L1', title: 'Licence, license field, repository metadata (T4)', blocking: true, binds: 'sha' },
  { id: 'S1', title: 'npm audit high/critical triage of runtime dependencies (T6)', blocking: true, binds: 'sha' },
  { id: 'A5', title: 'Saved artifacts: SHA256SUMS, 13 tarballs (5 platform packages holding the release archives\' executables), version, licences, no gateway, no Paseo in core (release-verify)', blocking: true, binds: 'artifacts' },
  { id: 'R1', title: 'macOS, Codex, CLI/alpd C1–C9 on the tarballs', blocking: true, binds: 'artifacts' },
  { id: 'R2', title: 'macOS, Claude Code, CLI/alpd C1–C9 on the tarballs', blocking: true, binds: 'artifacts' },
  // D7: macOS is the primary test platform; Linux rows are run when possible and do not block.
  { id: 'R3', title: 'Linux, Codex, CLI/alpd C1–C9 on the tarballs', blocking: false, binds: 'artifacts' },
  { id: 'R4', title: 'Linux, Claude Code, CLI/alpd C1–C9 on the tarballs', blocking: false, binds: 'artifacts' },
  { id: 'R5', title: 'macOS, Codex and Claude, plugin in Paseo 0.11.x + alp web W1–W6 on the tarballs', blocking: true, binds: 'artifacts' },
  { id: 'R6', title: 'Linux, Codex or Claude, plugin in Paseo 0.11.x + alp web W1–W6 on the tarballs', blocking: false, binds: 'artifacts' },
  { id: 'R7', title: 'macOS (Linux when possible), Codex and Claude, test/e2e/worktree-e2e.mjs at the release SHA', blocking: true, binds: 'sha' },
  { id: 'Q1', title: 'Registry: beta dist-tag and integrity of all 13 match the manifest', blocking: true, binds: 'artifacts', phase: 'post' },
  { id: 'Q2', title: 'Clean install from the registry on macOS (Linux when possible); lockfile integrity matches', blocking: true, binds: 'artifacts', phase: 'post' },
  { id: 'Q3', title: 'Smoke on the registry install: C1, C2, C4, W2, W6', blocking: true, binds: 'artifacts', phase: 'post' },
  { id: 'Q4', title: 'latest moved to the release for all 13 (D2: only after Q1–Q3)', blocking: true, binds: 'artifacts', phase: 'post' },
  { id: 'Q5', title: 'Untagged install resolves every @anhlp/* to the release', blocking: true, binds: 'artifacts', phase: 'post' },
];

/**
 * What each decision needs (§7.3–7.5, D2): `publish` the whole pre-publish gate; `latest` that and
 * Q1–Q3 (moving `latest` is decided by D2 only after them); `announce` everything through Q5.
 */
export const GATE_PHASES = {
  publish: GATE_ROWS.filter(row => !row.phase).map(row => row.id),
  latest: [...GATE_ROWS.filter(row => !row.phase).map(row => row.id), 'Q1', 'Q2', 'Q3'],
  announce: GATE_ROWS.map(row => row.id),
};

/** An evidence file with every row pending, bound to one release manifest. */
export const gateTemplate = manifest => ({
  schema: 1,
  version: manifest.version,
  releaseSha: manifest.git?.sha ?? null,
  artifacts: manifest.sha256sums ?? null,
  rows: Object.fromEntries(GATE_ROWS.map(row => [row.id, { status: 'pending', sha: null, artifacts: null, environment: null, runner: null, evidence: null, date: null }])),
});

/**
 * Decides one phase from the evidence. A row counts only when it passed and names the manifest's
 * release SHA (and, for artifact rows, its SHA256SUMS digest); anything missing keeps the gate closed.
 */
export function evaluateGate(evidence, manifest, phase = 'publish') {
  if (!GATE_PHASES[phase]) throw new Error(`unknown gate phase ${phase}; one of ${Object.keys(GATE_PHASES).join(', ')}`);
  const releaseSha = manifest.git?.sha;
  const rows = GATE_ROWS.filter(row => GATE_PHASES[phase].includes(row.id)).map(row => {
    const recorded = evidence?.rows?.[row.id] ?? {};
    const reasons = [];
    if (recorded.status !== 'pass') reasons.push(recorded.status ? `status ${recorded.status}` : 'not recorded');
    else {
      if (!releaseSha || recorded.sha !== releaseSha) reasons.push(`ran on ${recorded.sha ?? 'no SHA'}, not the release SHA ${releaseSha ?? '(none in manifest)'}`);
      if (row.binds === 'artifacts' && recorded.artifacts !== manifest.sha256sums) reasons.push(`used artifacts ${recorded.artifacts ?? '(not recorded)'}, not this release's SHA256SUMS ${manifest.sha256sums}`);
      if (!recorded.evidence) reasons.push('no evidence (CI link, log or session ids)');
    }
    return { ...row, status: recorded.status ?? 'missing', ok: reasons.length === 0, reasons };
  });
  const blocking = rows.filter(row => row.blocking && !row.ok);
  if (evidence?.version !== undefined && evidence.version !== manifest.version) blocking.push({ id: 'evidence', reasons: [`evidence is for ${evidence.version}, manifest is ${manifest.version}`] });
  return { phase, passed: blocking.length === 0, rows, blocking };
}
