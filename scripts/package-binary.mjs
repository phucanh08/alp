#!/usr/bin/env node
// Packs a built ALP bundle (scripts/build-bundle.mjs, t-1807, docs/alp/binary-install.md) as a release
// archive: alp-<version>-<os>-<arch>.tar.gz holding the alp-<version>-<os>-<arch>/ directory, or
// alp-<version>-windows-x64.zip on Windows. `sums` writes SHA256SUMS for every archive (and install.sh,
// install.ps1) in a directory.
//
//   node scripts/package-binary.mjs pack --bundle dist/bundle/alp-<version>-<platform> [--out dist/release]
//   node scripts/package-binary.mjs sums dist/release
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'windows-x64'];

/** The archive's base name. @param {string} version @param {string} platform */
export function archiveName(version, platform) {
  if (!/^[0-9][0-9A-Za-z.+-]*$/.test(version)) throw new Error(`Invalid version ${JSON.stringify(version)}`);
  if (!PLATFORMS.includes(platform)) throw new Error(`No release archive for ${platform}; expected one of ${PLATFORMS.join(', ')}`);
  return `alp-${version}-${platform}`;
}

/**
 * Archives `bundle` (its alp-bundle.json names the version and platform) into `out`, returning the archive.
 * @param {{ bundle: string, out: string }} options
 */
export async function pack({ bundle, out }) {
  const { version, platform } = JSON.parse(await readFile(path.join(bundle, 'alp-bundle.json'), 'utf8'));
  const name = archiveName(version, platform);
  if (path.basename(bundle) !== name) throw new Error(`${bundle} holds ${name}; its directory must have that name`);
  const windows = platform.startsWith('windows-');
  await mkdir(out, { recursive: true });
  const archive = path.resolve(out, `${name}${windows ? '.zip' : '.tar.gz'}`);
  // bsdtar (Windows' tar.exe, macOS) writes a zip with --format zip; GNU tar cannot.
  const args = windows ? ['--format', 'zip', '-cf', archive, '-C', path.dirname(bundle), name] : ['-czf', archive, '-C', path.dirname(bundle), name];
  // On Windows, Git's GNU tar may come first on PATH; use the system's bsdtar.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const result = spawnSync(tar, args, { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (result.status !== 0) throw new Error(`tar failed (${result.status ?? result.error})`);
  return archive;
}

/** Writes `SHA256SUMS` (sha256sum format) for the archives and installers in `directory`. @param {string} directory */
export async function sums(directory) {
  const archive = name => /^alp-.+\.(tar\.gz|zip)$/.test(name);
  const names = (await readdir(directory)).filter(name => archive(name) || name === 'install.sh' || name === 'install.ps1').sort();
  if (!names.some(archive)) throw new Error(`No alp-*.tar.gz or alp-*.zip archive in ${directory}`);
  const lines = [];
  for (const name of names) lines.push(`${createHash('sha256').update(await readFile(path.join(directory, name))).digest('hex')}  ${name}`);
  await writeFile(path.join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  return lines;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (command === 'pack') {
    const { values } = parseArgs({ args: rest, options: { bundle: { type: 'string' }, out: { type: 'string' } } });
    if (!values.bundle) throw new Error('pack needs --bundle');
    console.log(await pack({ bundle: path.resolve(values.bundle), out: path.resolve(values.out ?? 'dist/release') }));
  } else if (command === 'sums' && rest.length === 1) {
    for (const line of await sums(path.resolve(rest[0]))) console.log(line);
  } else throw new Error('Usage: package-binary.mjs pack --bundle <dir> [--out <dir>] | sums <dir>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main();
