#!/usr/bin/env node
// The npm platform packages of @anhlp/alp (t-cd7f): @anhlp/alp-<os>-<arch>, each holding only the
// ALP executable taken out of the GitHub release archive for that platform (package-binary.mjs), so
// npm users and install.sh users run the same bytes. They are generated at release time from the
// archives, never kept in the repository.
//
//   node scripts/npm-platform.mjs pack --binaries <dir with alp-<version>-<platform>.tar.gz|zip> --out <dir> [--version <v>] [--platform <id>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnCommand } from './spawn-command.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export const REPOSITORY = 'git+https://github.com/phucanh08/alp.git';

/**
 * The five platforms, in publish order. `release` is the GitHub release archive's platform name
 * (package-binary.mjs releasePlatform), `os`/`cpu`/`libc` npm's install filters.
 */
export const PLATFORMS = Object.freeze([
  { id: 'darwin-arm64', release: 'darwin-arm64', os: 'darwin', cpu: 'arm64', executable: 'alp' },
  { id: 'darwin-x64', release: 'darwin-x64', os: 'darwin', cpu: 'x64', executable: 'alp' },
  { id: 'linux-x64', release: 'linux-x64', os: 'linux', cpu: 'x64', libc: 'glibc', executable: 'alp' },
  { id: 'linux-arm64', release: 'linux-arm64', os: 'linux', cpu: 'arm64', libc: 'glibc', executable: 'alp' },
  { id: 'win32-x64', release: 'windows-x64', os: 'win32', cpu: 'x64', executable: 'alp.exe' },
].map(platform => Object.freeze({ ...platform, name: `@anhlp/alp-${platform.id}` })));
export const PLATFORM_NAMES = PLATFORMS.map(platform => platform.name);
export const platformOf = name => PLATFORMS.find(platform => platform.name === name);

/** The release archive's file name for a platform. */
export const archiveFile = (platform, version) => `alp-${version}-${platform.release}${platform.os === 'win32' ? '.zip' : '.tar.gz'}`;

/** The package.json of a platform package. */
export function platformManifest(platform, version) {
  return {
    name: platform.name,
    version,
    description: `The ALP executable for ${platform.id}${platform.libc ? ` (${platform.libc})` : ''}; installed by @anhlp/alp, which runs it`,
    os: [platform.os],
    cpu: [platform.cpu],
    ...(platform.libc ? { libc: [platform.libc] } : {}),
    files: [`bin/${platform.executable}`, 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt'],
    preferUnplugged: true,
    license: 'Apache-2.0',
    repository: { type: 'git', url: REPOSITORY, directory: 'npm/alp' },
    homepage: 'https://github.com/phucanh08/alp#readme',
    bugs: { url: 'https://github.com/phucanh08/alp/issues' },
    publishConfig: { access: 'public', registry: 'https://registry.npmjs.org/', tag: 'beta' },
  };
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function extract(archive, directory, platform) {
  // .zip: the system's bsdtar on Windows and macOS, unzip on Linux (GNU tar reads no zip).
  const zip = platform.os === 'win32';
  const [command, args] = !zip ? ['tar', ['-xzf', archive, '-C', directory]]
    : process.platform === 'win32' ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', directory]]
    : process.platform === 'darwin' ? ['tar', ['-xf', archive, '-C', directory]]
    : ['unzip', ['-q', archive, '-d', directory]];
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`could not extract ${archive}: ${(result.stderr || result.error?.message || '').trim()}`);
}

/**
 * Stages one platform package from its release archive in `work`. Returns the directory and what
 * the release recorded: the archive's and the executable's SHA-256.
 */
export async function stagePlatform({ platform, version, binaries, work }) {
  const archiveName = archiveFile(platform, version);
  const archive = path.join(binaries, archiveName);
  if (!existsSync(archive)) throw new Error(`${platform.name}: release archive ${archiveName} is missing from ${binaries}`);
  const archiveBytes = await readFile(archive);
  const unpacked = path.join(work, `unpacked-${platform.id}`);
  await mkdir(unpacked, { recursive: true });
  extract(archive, unpacked, platform);
  const inside = path.join(unpacked, archiveName.replace(/\.(tar\.gz|zip)$/, ''));
  const directory = path.join(work, `package-${platform.id}`);
  await mkdir(path.join(directory, 'bin'), { recursive: true });
  const binary = path.join(directory, 'bin', platform.executable);
  await copyFile(path.join(inside, platform.executable), binary);
  if (platform.os !== 'win32') await chmod(binary, 0o755);
  for (const file of ['LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.txt']) await copyFile(path.join(inside, file), path.join(directory, file));
  await writeFile(path.join(directory, 'package.json'), `${JSON.stringify(platformManifest(platform, version), null, 2)}\n`);
  await writeFile(path.join(directory, 'README.md'), `# ${platform.name}\n\nThe ALP executable for ${platform.id}${platform.libc ? ` (${platform.libc})` : ''}, the same file as in the GitHub release archive ${archiveName}. Install \`@anhlp/alp\`, not this package: its \`alp\` command runs this executable.\n\nhttps://github.com/phucanh08/alp\n`);
  const bytes = await readFile(binary);
  return { directory, archive: archiveName, archiveSha256: sha256(archiveBytes), binary: `bin/${platform.executable}`, binarySha256: sha256(bytes), binarySize: bytes.length };
}

/** `npm pack <directory>` into `out`; returns npm's JSON entry. */
export function npmPack(directory, out, { ignoreScripts = true } = {}) {
  const result = spawnSync(...spawnCommand('npm', ['pack', directory, '--pack-destination', out, '--json', ...(ignoreScripts ? ['--ignore-scripts'] : [])]), { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`npm pack ${directory} exited ${result.status}\n${result.stdout}${result.stderr}`);
  const start = result.stdout.search(/^\[/m);
  const packed = JSON.parse(result.stdout.slice(start >= 0 ? start : 0));
  if (packed.length !== 1) throw new Error(`npm pack ${directory} reported ${packed.length} packages`);
  return packed[0];
}

/**
 * The archives' SHA256SUMS (package-binary.mjs sums, the GitHub release asset): every archive packed
 * must be listed with its digest. Returns the file's own SHA-256, which the release manifest records.
 */
export async function checkArchiveSums(binaries, version, platforms = PLATFORMS) {
  let text;
  try { text = await readFile(path.join(binaries, 'SHA256SUMS'), 'utf8'); } catch { throw new Error(`${binaries}/SHA256SUMS is missing: the release archives come with the SHA256SUMS of their GitHub release`); }
  const listed = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error(`SHA256SUMS: unreadable line ${JSON.stringify(line)}`);
    if (listed.has(match[2])) throw new Error(`SHA256SUMS: ${match[2]} listed twice`);
    listed.set(match[2], match[1]);
  }
  for (const platform of platforms) {
    const name = archiveFile(platform, version);
    if (!listed.has(name)) throw new Error(`SHA256SUMS does not list ${name}`);
    const actual = sha256(await readFile(path.join(binaries, name)).catch(() => { throw new Error(`${name} is missing from ${binaries}`); }));
    if (actual !== listed.get(name)) throw new Error(`${name}: SHA-256 ${actual} does not match SHA256SUMS (${listed.get(name)})`);
  }
  return sha256(Buffer.from(text));
}

/** Stages and packs all five (or `only` these ids); returns `[{ platform, packed, binary }]` in publish order. */
export async function packPlatforms({ binaries, version, out, only }) {
  const work = await mkdtemp(path.join(os.tmpdir(), 'alp-npm-platform-'));
  try {
    const results = [];
    for (const platform of PLATFORMS.filter(entry => !only || only.includes(entry.id))) {
      const staged = await stagePlatform({ platform, version, binaries, work });
      const packed = npmPack(staged.directory, out);
      if (packed.name !== platform.name || packed.version !== version) throw new Error(`npm pack ${platform.name} reported ${packed.name}@${packed.version}`);
      const { directory, ...binary } = staged;
      results.push({ platform, packed, binary });
    }
    return results;
  } finally { await rm(work, { recursive: true, force: true }); }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== 'pack') throw new Error('Usage: npm-platform.mjs pack --binaries <dir> --out <dir> [--version <v>]');
  const { values } = parseArgs({ args: rest, options: { binaries: { type: 'string' }, out: { type: 'string' }, version: { type: 'string' }, platform: { type: 'string', multiple: true } } });
  if (values.platform?.some(id => !PLATFORMS.some(entry => entry.id === id))) throw new Error(`--platform must be one of ${PLATFORMS.map(entry => entry.id).join(', ')}`);
  if (!values.binaries || !values.out) throw new Error('pack needs --binaries and --out');
  const version = values.version ?? JSON.parse(await readFile(path.join(ROOT, 'npm/alp/package.json'), 'utf8')).version;
  await mkdir(path.resolve(values.out), { recursive: true });
  for (const { packed, binary } of await packPlatforms({ binaries: path.resolve(values.binaries), version, out: path.resolve(values.out), only: values.platform })) {
    console.log(`${packed.filename}  ${packed.size} bytes  ${binary.binary} sha256 ${binary.binarySha256} (from ${binary.archive})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main();
