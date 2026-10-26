// Release artifacts for docs/alp/beta-scope.md §6–7: which packages a release is, the manifest and
// SHA256SUMS that pin the tarballs packed once, the checks run on those saved files (A5), and the
// gate table that decides whether they may be published. Nothing here packs, builds or publishes.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { corePackageProblems } from './core-package-boundary.mjs';
import { THIRD_PARTY_NOTICES, packageDirectory, packageName } from './third-party-notices.mjs';

/** The eight public packages, in publish order (§7.4). Every other workspace must be private. */
export const RELEASE_PACKAGES = [
  { name: '@anhlp/alp-protocol', location: 'packages/protocol' },
  { name: '@anhlp/alp-core', location: 'packages/core' },
  { name: '@anhlp/alp-runtime', location: 'packages/runtime' },
  { name: '@anhlp/alp-client', location: 'packages/client' },
  { name: '@anhlp/alp-daemon', location: 'packages/daemon' },
  { name: '@anhlp/alp-cli', location: 'packages/cli' },
  { name: '@anhlp/alp-paseo', location: 'integrations/paseo' },
  { name: '@anhlp/alp', location: '.' },
];
export const RELEASE_NAMES = RELEASE_PACKAGES.map(pkg => pkg.name);
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

/**
 * Source checks before packing: exactly the eight release packages are public, all at `version`
 * with internal dependencies pinned to it, and package-lock.json agrees with the manifests.
 * `workspaces` is `[{ location, pkg }]` for the root (`.`) and every workspace.
 */
export function sourceProblems({ workspaces, lock, version }) {
  const problems = [];
  if (!VERSION.test(version ?? '')) return [`release version ${JSON.stringify(version)} is not a semver version`];
  const publicNames = workspaces.filter(({ pkg }) => !pkg.private).map(({ pkg }) => pkg.name);
  for (const name of publicNames) if (!RELEASE_NAMES.includes(name)) problems.push(`${name} is public but not a release package; mark it "private": true`);
  for (const expected of RELEASE_PACKAGES) {
    const found = workspaces.find(({ pkg }) => pkg.name === expected.name);
    if (!found) { problems.push(`${expected.name}: no workspace has this name`); continue; }
    if (found.location !== expected.location) problems.push(`${expected.name}: found at ${found.location}, expected ${expected.location}`);
    if (found.pkg.private) problems.push(`${expected.name}: is private, but it is released`);
    if (found.pkg.version !== version) problems.push(`${expected.name}: version ${found.pkg.version}, expected ${version}`);
    problems.push(...internalDependencyProblems(found.pkg, version));
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
    packages: artifacts.map(({ name, version, filename, size, sha256, integrity, shasum, entryCount }) => ({ name, version, filename, size, sha256, integrity, shasum, entryCount })),
  };
}

/**
 * `alp web` runs alp-web (docs/alp/web.md): its service bundle, the browser app and their notices
 * ship inside the CLI, so both packages that carry the CLI must have them. The gateway it inlines
 * stays private (A5 refuses a ninth tarball); this list is checked beside A5, not as part of it.
 */
const ALP_WEB_FILES = ['dist/alp-web.js', 'dist/alp-web/index.html', `dist/alp-web/${THIRD_PARTY_NOTICES}`, `dist/${THIRD_PARTY_NOTICES}`];
export const SHIPPED_WEB_FILES = Object.freeze({
  '@anhlp/alp-cli': ALP_WEB_FILES,
  '@anhlp/alp': ALP_WEB_FILES.map(file => `packages/cli/${file}`),
});

/**
 * The alp-web files a packed package lacks, as problems; none for packages that do not carry the CLI.
 * @param {string} name @param {Iterable<string>} files the packed paths, relative to the package root
 */
export function shippedWebProblems(name, files) {
  const packed = new Set(files);
  return (SHIPPED_WEB_FILES[name] ?? []).filter(file => !packed.has(file)).map(file => `${name}: ${file} is not packed; alp web cannot run (build the CLI with apps/gateway and apps/web present)`);
}

/** Problems a single packed package has, from its own files (no repository source involved). */
function contentProblems(name, files, version, rootFiles) {
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
  if (name === PLUGIN) {
    // The plugin carries Paseo's web app: Paseo's licence and the notice of ALP's changes ship with it.
    for (const file of ['server/dist/web-app/LICENSE.paseo.txt', 'server/dist/web-app/NOTICE.txt']) if (!files.has(file)) problems.push(`${name}: no ${file}`);
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
    if (!file.endsWith('.js') || file.includes('/web-app/')) continue;
    for (const [, comment] of body.toString('utf8').matchAll(/^\/\/ (\S+)$/gm)) {
      const directory = packageDirectory(comment);
      if (directory) bundled.add(packageName(directory));
    }
  }
  for (const bundle of bundled) if (!notices.includes(`\n${bundle}@`)) problems.push(`${name}: bundles ${bundle} but no ${THIRD_PARTY_NOTICES} lists it`);
  return { problems, pkg };
}

/**
 * Reads a release directory and checks only what is in it (A5): exactly the manifest's eight
 * tarballs, each matching SHA256SUMS and the manifest's sha256/integrity/shasum/size/entryCount,
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
  for (const reason of rehearsalOnly) (rehearsal ? notes : problems).push(`${MANIFEST_FILE}: ${reason}`);

  const listed = (manifest.packages ?? []).map(entry => entry.name);
  if (JSON.stringify(listed) !== JSON.stringify(RELEASE_NAMES)) problems.push(`${MANIFEST_FILE}: packages are ${listed.join(', ')}; expected ${RELEASE_NAMES.join(', ')} in publish order`);
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
  const rootFiles = artifacts.find(artifact => artifact.name === '@anhlp/alp')?.files;
  for (const artifact of artifacts) {
    // npm's entryCount is the number of files it packed.
    if (artifact.files.size !== artifact.entryCount) problems.push(`${artifact.name}: ${artifact.files.size} files, but npm packed ${artifact.entryCount}`);
    const { problems: found, pkg } = contentProblems(artifact.name, artifact.files, expectedVersion, rootFiles);
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
  if (JSON.stringify(names) !== JSON.stringify(RELEASE_NAMES)) throw new Error(`release artifacts in ${directory} are ${names.join(', ')}, not the ${RELEASE_NAMES.length} release packages`);
  return artifacts;
}

/** Problems with what a consumer's package-lock.json installed, against the release manifest. */
export function installedProblems(lock, manifest) {
  const problems = [];
  const expected = new Map(manifest.packages.map(entry => [entry.name, entry]));
  const seen = new Set();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const name = /(?:^|\/)node_modules\/(@anhlp\/[^/]+)$/.exec(key)?.[1];
    if (!name) continue;
    seen.add(name);
    const release = expected.get(name);
    if (!release) { problems.push(`${key}: ${name} is not part of the release`); continue; }
    if (entry.version !== manifest.version) problems.push(`${key}: installed ${entry.version}, expected ${manifest.version}`);
    if (entry.integrity !== release.integrity) problems.push(`${key}: integrity ${entry.integrity} is not the saved tarball's ${release.integrity}`);
    if (!entry.resolved?.startsWith('file:') || !entry.resolved.endsWith(release.filename)) problems.push(`${key}: resolved from ${entry.resolved}, not the saved ${release.filename}`);
  }
  for (const name of RELEASE_NAMES) if (!seen.has(name)) problems.push(`${name}: not installed`);
  return problems;
}

/**
 * The acceptance rows of §6.1 and §7.5. `binds` says what a pass must name: `sha` the release SHA,
 * `artifacts` also the SHA-256 of the saved SHA256SUMS (the exact eight tarballs).
 */
export const GATE_ROWS = [
  { id: 'H1', title: 'CI core + paseo (validate:core, validate:paseo), Ubuntu, Node 22 and 24', blocking: true, binds: 'sha' },
  { id: 'H2', title: 'validate:core + validate:paseo on macOS (CI core-paseo-macos, Node 24)', blocking: true, binds: 'sha' },
  { id: 'H3', title: 'CI packages-and-web (validate:packages, web-app-smoke), Ubuntu, Node 22', blocking: true, binds: 'sha' },
  { id: 'H4', title: 'CI windows-daemon, Node 22 and 24', blocking: true, binds: 'sha' },
  { id: 'H5', title: 'CI alp-web, Ubuntu and macOS', blocking: false, binds: 'sha' },
  { id: 'L1', title: 'Licence, license field, repository metadata (T4)', blocking: true, binds: 'sha' },
  { id: 'S1', title: 'npm audit high/critical triage of runtime dependencies (T6)', blocking: true, binds: 'sha' },
  { id: 'A5', title: 'Saved artifacts: SHA256SUMS, 8 tarballs, version, licences, no gateway, no Paseo in core (release-verify)', blocking: true, binds: 'artifacts' },
  { id: 'R1', title: 'macOS, Codex, CLI/alpd C1–C9 on the tarballs', blocking: true, binds: 'artifacts' },
  { id: 'R2', title: 'macOS, Claude Code, CLI/alpd C1–C9 on the tarballs', blocking: true, binds: 'artifacts' },
  // D7: macOS is the primary test platform; Linux rows are run when possible and do not block.
  { id: 'R3', title: 'Linux, Codex, CLI/alpd C1–C9 on the tarballs', blocking: false, binds: 'artifacts' },
  { id: 'R4', title: 'Linux, Claude Code, CLI/alpd C1–C9 on the tarballs', blocking: false, binds: 'artifacts' },
  { id: 'R5', title: 'macOS, Codex and Claude, plugin in Paseo 0.11.x + alp web W1–W6 on the tarballs', blocking: true, binds: 'artifacts' },
  { id: 'R6', title: 'Linux, Codex or Claude, plugin in Paseo 0.11.x + alp web W1–W6 on the tarballs', blocking: false, binds: 'artifacts' },
  { id: 'R7', title: 'macOS (Linux when possible), Codex and Claude, test/e2e/worktree-e2e.mjs at the release SHA', blocking: true, binds: 'sha' },
  { id: 'Q1', title: 'Registry: beta dist-tag and integrity of all 8 match the manifest', blocking: true, binds: 'artifacts', phase: 'post' },
  { id: 'Q2', title: 'Clean install from the registry on macOS (Linux when possible); lockfile integrity matches', blocking: true, binds: 'artifacts', phase: 'post' },
  { id: 'Q3', title: 'Smoke on the registry install: C1, C2, C4, W2, W6', blocking: true, binds: 'artifacts', phase: 'post' },
  { id: 'Q4', title: 'latest moved to the release for all 8 (D2: only after Q1–Q3)', blocking: true, binds: 'artifacts', phase: 'post' },
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
