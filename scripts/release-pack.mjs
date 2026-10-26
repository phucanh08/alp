#!/usr/bin/env node
// Pack a release once (docs/alp/beta-scope.md §7.2 P2–P3): the eight tarballs in publish order into
// a new directory, npm's pack JSON for each, SHA256SUMS and release-manifest.json, then A5 on them.
// Run it in a clean clone at the release tag, after `npm ci`, `npm run build:web` and
// `npm run build:packages`. It never publishes, tags or commits.
//
//   release-pack.mjs --out <new directory> [--rehearsal] [--ignore-scripts]
//
// --rehearsal accepts a dirty or untagged checkout and --ignore-scripts skips prepack; either marks
// the manifest so release-verify refuses it as gate evidence (it stays usable for practice runs).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnCommand } from './spawn-command.mjs';
import { MANIFEST_FILE, RELEASE_PACKAGES, SUMS_FILE, createReleaseManifest, digests, formatSha256Sums, shippedWebProblems, sourceProblems, verifyRelease } from './release-lib.mjs';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); if (index >= 0) args.splice(index, 1); return index >= 0; };
const rehearsal = flag('--rehearsal');
const ignoreScripts = flag('--ignore-scripts');
const outAt = args.indexOf('--out');
if (outAt < 0 || !args[outAt + 1] || args.length !== 2) throw new Error('Usage: release-pack.mjs --out <new directory> [--rehearsal] [--ignore-scripts]');
const out = path.resolve(args[outAt + 1]);

function run(command, commandArgs) {
  const result = spawnSync(...spawnCommand(command, commandArgs), { cwd: root, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(' ')} exited ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result.stdout;
}
const git = (...gitArgs) => spawnSync('git', gitArgs, { cwd: root, encoding: 'utf8' });

const readJson = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const manifest = readJson('package.json');
const version = manifest.version;
const workspaces = ['.', ...manifest.workspaces].map(location => ({ location, pkg: location === '.' ? manifest : readJson(path.join(location, 'package.json')) }));
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

const artifacts = [];
for (const { name, location } of RELEASE_PACKAGES) {
  console.log(`[release-pack] npm pack ${name}`);
  const output = run('npm', ['pack', ...(location === '.' ? [] : ['--workspace', name]), '--pack-destination', out, '--json', ...(ignoreScripts ? ['--ignore-scripts'] : [])]);
  // Lifecycle output can precede npm's JSON array.
  const start = output.search(/^\[/m);
  const packed = JSON.parse(output.slice(start >= 0 ? start : 0));
  if (packed.length !== 1 || packed[0].name !== name) throw new Error(`npm pack ${name} reported ${packed.map(entry => entry.name).join(', ')}`);
  writeFileSync(path.join(out, `pack-${location === '.' ? 'root' : name.replace('@anhlp/', '')}.json`), `${JSON.stringify(packed, null, 2)}\n`);
  const [{ filename, integrity, shasum, entryCount }] = packed;
  const actual = digests(readFileSync(path.join(out, filename)));
  if (actual.integrity !== integrity || actual.shasum !== shasum) throw new Error(`${filename}: the file on disk is not the tarball npm reported (${integrity}, ${shasum})`);
  artifacts.push({ name, version: packed[0].version, filename, entryCount, ...actual });
}

const sums = formatSha256Sums(artifacts);
writeFileSync(path.join(out, SUMS_FILE), sums);
const npmVersion = run('npm', ['--version']).trim();
const release = createReleaseManifest({
  version,
  git: { sha, tag, dirty },
  build: { node: process.version, npm: npmVersion, platform: process.platform, arch: process.arch, os: `${os.type()} ${os.release()}`, date: new Date().toISOString() },
  pack: { ignoreScripts, rehearsal },
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
// Beside A5: the CLI's alp web files (alp-web.js, its app and notices) are in both packages that carry the CLI.
const missing = result.artifacts.flatMap(artifact => shippedWebProblems(artifact.name, artifact.files.keys()));
if (missing.length) {
  console.error(`[release-pack] the packed artifacts in ${out} cannot run alp web:\n- ${missing.join('\n- ')}`);
  process.exit(1);
}
console.log(`[release-pack] ${artifacts.length} tarballs, ${SUMS_FILE} and ${MANIFEST_FILE} in ${out}`);
console.log(`[release-pack] ${rehearsal ? 'REHEARSAL: not gate evidence.' : `Next (§7.2): chmod -R a-w "${out}", keep a copy off this machine, then run release-verify and release-consumer on it.`}`);
