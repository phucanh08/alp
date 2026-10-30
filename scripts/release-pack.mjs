#!/usr/bin/env node
// Pack a release once (docs/alp/beta-scope.md §7.2 P2–P3): the thirteen tarballs in publish order
// into a new directory, npm's pack JSON for each, SHA256SUMS and release-manifest.json, then A5 on them.
// Run it in a clean clone at the release tag, after `npm ci` and `npm run build:packages`. It never publishes, tags or commits.
//
//   release-pack.mjs --out <new directory> --binaries <dir> [--rehearsal] [--ignore-scripts]
//
// --binaries is the directory of the GitHub release archives (alp-<version>-<platform>.tar.gz|zip,
// release-binaries.yml, with their SHA256SUMS); --binaries-release v<version> downloads them from that
// published GitHub release with gh instead: the five platform packages carry the executables taken out of them, so npm
// and install.sh install the same bytes (t-cd7f). The manifest records each executable's SHA-256 and
// its archive's. --rehearsal accepts a dirty or untagged checkout and no --binaries (then without
// platform packages), and --ignore-scripts skips prepack; each marks the manifest so release-verify
// refuses it as gate evidence (it stays usable for practice runs).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCommand } from './spawn-command.mjs';
import { checkArchiveSums, packPlatforms } from './npm-platform.mjs';
import { LAUNCHER_LOCATION, MANIFEST_FILE, RELEASE_PACKAGES, SUMS_FILE, createReleaseManifest, digests, formatSha256Sums, shippedWebProblems, sourceProblems, verifyRelease } from './release-lib.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); if (index >= 0) args.splice(index, 1); return index >= 0; };
const rehearsal = flag('--rehearsal');
const ignoreScripts = flag('--ignore-scripts');
const option = name => { const index = args.indexOf(name); if (index < 0) return undefined; const [, value] = args.splice(index, 2); if (!value) throw new Error(`${name} needs a value`); return value; };
const outArg = option('--out');
const binariesArg = option('--binaries');
const binariesRelease = option('--binaries-release');
const USAGE = 'Usage: release-pack.mjs --out <new directory> (--binaries <release archives> | --binaries-release v<version>) [--rehearsal] [--ignore-scripts]';
if (!outArg || args.length || (binariesArg && binariesRelease)) throw new Error(USAGE);
if (!binariesArg && !binariesRelease && !rehearsal) throw new Error(`--binaries or --binaries-release is required: the platform packages carry the GitHub release's executables (only a --rehearsal may pack without them)\n${USAGE}`);
const out = path.resolve(outArg);
let binaries = binariesArg && path.resolve(binariesArg);

function run(command, commandArgs) {
  const result = spawnSync(...spawnCommand(command, commandArgs), { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result.stdout;
}
const git = (...gitArgs) => spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' });

const readJson = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const manifest = readJson('package.json');
const version = manifest.version;
const workspaces = ['.', ...manifest.workspaces, LAUNCHER_LOCATION].map(location => ({ location, pkg: location === '.' ? manifest : readJson(path.join(location, 'package.json')) }));
const problems = sourceProblems({ workspaces, lock: readJson('package-lock.json'), version });
if (problems.length) throw new Error(`release source check failed:\n- ${problems.join('\n- ')}`);

const sha = git('rev-parse', 'HEAD').stdout?.trim() || null;
const dirty = git('status', '--porcelain').stdout?.trim() !== '';
const tag = git('describe', '--exact-match', '--tags', 'HEAD').stdout?.trim() || null;
if (!rehearsal && (dirty || !tag || !sha)) {
  throw new Error(`refusing to pack a release from ${sha ?? 'no commit'} (${dirty ? 'uncommitted changes' : 'clean'}, tag ${tag ?? 'none'}): pack in a clean clone at the release tag (§7.2), or pass --rehearsal`);
}
if (existsSync(out) && readdirSync(out).length) throw new Error(`${out} is not empty; every release is packed once into a new directory (§7.2)`);
mkdirSync(out, { recursive: true });

// The platform packages first, from the release archives (npm pack of a generated directory).
const platforms = new Map();
// --binaries-release: the archives and SHA256SUMS of a PUBLISHED GitHub release, downloaded with gh
// (t-cd7f: npm 0.0.1-beta.5 carries the executables of the GitHub release v0.0.1-beta.5).
let releaseSource = null;
if (binariesRelease) {
  const repo = process.env.ALP_INSTALL_REPO || 'phucanh08/alp';
  if (binariesRelease !== `v${version}`) throw new Error(`--binaries-release ${binariesRelease}: the npm packages are ${version}, so the release must be v${version}`);
  const view = spawnSync('gh', ['release', 'view', binariesRelease, '--repo', repo, '--json', 'tagName,isDraft,isPrerelease,targetCommitish,url'], { encoding: 'utf8' });
  if (view.status !== 0) throw new Error(`gh release view ${binariesRelease} --repo ${repo} failed: ${view.stderr}`);
  const info = JSON.parse(view.stdout);
  if (info.isDraft) throw new Error(`${repo} ${binariesRelease} is still a draft; publish the GitHub release first (or use --binaries with the release-binaries artifact)`);
  binaries = mkdtempSync(path.join(os.tmpdir(), 'alp-release-binaries-'));
  const download = spawnSync('gh', ['release', 'download', binariesRelease, '--repo', repo, '--dir', binaries, '--pattern', 'alp-*', '--pattern', 'SHA256SUMS'], { encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] });
  if (download.status !== 0) throw new Error(`gh release download ${binariesRelease} --repo ${repo} failed`);
  releaseSource = { repo, tag: info.tagName, targetCommitish: info.targetCommitish, url: info.url };
  console.log(`[release-pack] downloaded the archives and SHA256SUMS of ${repo} ${info.tagName} (built from ${info.targetCommitish}) into ${binaries}`);
}
// The archives must be the GitHub release's: each listed in its SHA256SUMS with the same digest.
const archiveSums = binaries ? await checkArchiveSums(binaries, version) : null;
if (binaries) {
  console.log(`[release-pack] platform packages from the release archives in ${binaries}`);
  for (const { platform, packed, binary } of await packPlatforms({ binaries, version, out })) {
    // What release-verify checks the packed executable against, and what ties it to the release asset.
    platforms.set(platform.name, { packed: [packed], binary: { file: binary.binary, sha256: binary.binarySha256, size: binary.binarySize, archive: binary.archive, archiveSha256: binary.archiveSha256 } });
  }
}
const artifacts = [];
for (const { name, location, kind } of RELEASE_PACKAGES) {
  let packed;
  let binary;
  if (kind === 'platform') {
    if (!binaries) continue;
    ({ packed, binary } = platforms.get(name));
  } else {
    console.log(`[release-pack] npm pack ${name}`);
    const where = kind === 'launcher' ? [`./${location}`] : ['--workspace', name];
    const output = run('npm', ['pack', ...where, '--pack-destination', out, '--json', ...(ignoreScripts ? ['--ignore-scripts'] : [])]);
    // Lifecycle output can precede npm's JSON array.
    const start = output.search(/^\[/m);
    packed = JSON.parse(output.slice(start >= 0 ? start : 0));
  }
  if (packed.length !== 1 || packed[0].name !== name) throw new Error(`npm pack ${name} reported ${packed.map(entry => entry.name).join(', ')}`);
  writeFileSync(path.join(out, `pack-${name.replace('@anhlp/', '')}.json`), `${JSON.stringify(packed, null, 2)}\n`);
  const [{ filename, integrity, shasum, entryCount }] = packed;
  const actual = digests(readFileSync(path.join(out, filename)));
  if (actual.integrity !== integrity || actual.shasum !== shasum) throw new Error(`${filename}: the file on disk is not the tarball npm reported (${integrity}, ${shasum})`);
  artifacts.push({ name, version: packed[0].version, filename, entryCount, ...actual, ...(binary ? { binary } : {}) });
}

const sums = formatSha256Sums(artifacts);
writeFileSync(path.join(out, SUMS_FILE), sums);
const npmVersion = run('npm', ['--version']).trim();
const release = createReleaseManifest({
  version,
  git: { sha, tag, dirty },
  build: { node: process.version, npm: npmVersion, platform: process.platform, arch: process.arch, os: `${os.type()} ${os.release()}`, date: new Date().toISOString() },
  pack: { ignoreScripts, rehearsal, platforms: Boolean(binaries), archiveSha256Sums: archiveSums, binariesRun: process.env.ALP_BINARIES_RUN || null, binariesRelease: releaseSource },
  artifacts,
  sha256sums: digests(Buffer.from(sums)).sha256,
});
writeFileSync(path.join(out, MANIFEST_FILE), `${JSON.stringify(release, null, 2)}\n`);

const result = verifyRelease(out, { rehearsal });
for (const note of result.notes) console.log(`[release-pack] rehearsal only: ${note}`);
if (result.problems.length) {
  console.error(`[release-pack] A5 failed on the packed artifacts in ${out}:\n- ${result.problems.join('\n- ')}`);
  process.exit(1);
}
// Beside A5: the CLI's alp web files (alp-web.js, its app and notices) are in the CLI package.
const missing = result.artifacts.flatMap(artifact => shippedWebProblems(artifact.name, artifact.files.keys()));
if (missing.length) {
  console.error(`[release-pack] the packed artifacts in ${out} cannot run alp web:\n- ${missing.join('\n- ')}`);
  process.exit(1);
}
console.log(`[release-pack] ${artifacts.length} tarballs, ${SUMS_FILE} and ${MANIFEST_FILE} in ${out}`);
console.log(`[release-pack] ${rehearsal ? 'REHEARSAL: not gate evidence.' : `Next (§7.2): chmod -R a-w "${out}", keep a copy off this machine, then run release-verify and release-consumer on it.`}`);
