#!/usr/bin/env node
// Packs a built ALP executable as a release archive (t-1e02 P1, docs/alp/binary-install.md):
// alp-<version>-<os>-<arch>.tar.gz holding alp-<version>-<os>-<arch>/{alp, LICENSE, NOTICE,
// THIRD-PARTY-NOTICES.txt}; on Windows (P2) alp-<version>-windows-x64.zip with alp.exe instead.
// `sums` writes SHA256SUMS for every archive (and install.sh, install.ps1) in a directory.
//
//   node scripts/package-binary.mjs pack --binary dist/bin/alp --target bun-linux-x64 [--out dist/release]
//   node scripts/package-binary.mjs sums dist/release
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(import.meta.dirname, '..');

/** The release platform of a Bun target: bun-darwin-arm64 → darwin-arm64, bun-windows-x64 → windows-x64. @param {string} target */
export function releasePlatform(target) {
  const match = /^bun-(darwin|linux)-(x64|arm64)$/.exec(target) ?? /^bun-(windows)-(x64)$/.exec(target);
  if (!match) throw new Error(`No release archive for ${target}; expected bun-(darwin|linux)-(x64|arm64) or bun-windows-x64`);
  return `${match[1]}-${match[2]}`;
}

/** Windows archives are .zip holding alp.exe; the others are .tar.gz holding alp. @param {string} target */
const isWindows = target => releasePlatform(target).startsWith('windows-');

/** The archive's base name. @param {string} version @param {string} target */
export function archiveName(version, target) {
  if (!/^[0-9][0-9A-Za-z.+-]*$/.test(version)) throw new Error(`Invalid version ${JSON.stringify(version)}`);
  return `alp-${version}-${releasePlatform(target)}`;
}

// Every bundle the executable embeds keeps its third-party licences: alpd/acp (dist), the CLI and
// alp-web's server (packages/cli/dist) and the browser app (packages/cli/dist/alp-web).
const NOTICE_SOURCES = ['dist/THIRD-PARTY-NOTICES.txt', 'packages/cli/dist/THIRD-PARTY-NOTICES.txt', 'packages/cli/dist/alp-web/THIRD-PARTY-NOTICES.txt'];

/** The combined THIRD-PARTY-NOTICES.txt of the executable. @param {string} root */
export async function combinedNotices(root = ROOT) {
  const parts = [`Third-party software in the ALP executable

The executable is built with Bun (https://bun.sh, MIT; its embedded JavaScriptCore is LGPL-2.1 and
its other dependencies are listed at https://bun.sh/docs/project/licensing). The JavaScript bundles
it contains include the packages below, grouped by bundle.
`];
  for (const source of NOTICE_SOURCES) {
    const text = await readFile(path.join(root, source), 'utf8').catch(() => { throw new Error(`${source} is missing; run npm run build first`); });
    parts.push(`\n${'='.repeat(100)}\n${source}\n${'='.repeat(100)}\n\n${text.trim()}\n`);
  }
  return parts.join('');
}

/** @param {{ binary: string, target: string, out: string, version?: string, root?: string }} options */
export async function pack({ binary, target, out, version, root = ROOT }) {
  version ??= JSON.parse(await readFile(path.join(root, 'packages/cli/package.json'), 'utf8')).version;
  const name = archiveName(/** @type {string} */ (version), target);
  const work = await mkdtemp(path.join(os.tmpdir(), 'alp-package-'));
  try {
    const directory = path.join(work, name);
    await mkdir(directory);
    const windows = isWindows(target);
    const executable = windows ? 'alp.exe' : 'alp';
    await copyFile(binary, path.join(directory, executable));
    if (!windows) await chmod(path.join(directory, executable), 0o755);
    await copyFile(path.join(root, 'LICENSE'), path.join(directory, 'LICENSE'));
    await copyFile(path.join(root, 'NOTICE'), path.join(directory, 'NOTICE'));
    await writeFile(path.join(directory, 'THIRD-PARTY-NOTICES.txt'), await combinedNotices(root));
    await mkdir(out, { recursive: true });
    const archive = path.resolve(out, `${name}${windows ? '.zip' : '.tar.gz'}`);
    // bsdtar (Windows' tar.exe, macOS) writes a zip with --format zip; GNU tar cannot.
    const args = windows ? ['--format', 'zip', '-cf', archive, '-C', work, name] : ['-czf', archive, '-C', work, name];
    // On Windows, Git's GNU tar may come first on PATH; use the system's bsdtar.
    const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const result = spawnSync(tar, args, { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
    if (result.status !== 0) throw new Error(`tar failed (${result.status ?? result.error})`);
    return archive;
  } finally { await rm(work, { recursive: true, force: true }); }
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
    const { values } = parseArgs({ args: rest, options: { binary: { type: 'string' }, target: { type: 'string' }, out: { type: 'string' }, version: { type: 'string' } } });
    if (!values.binary || !values.target) throw new Error('pack needs --binary and --target');
    console.log(await pack({ binary: path.resolve(values.binary), target: values.target, out: path.resolve(values.out ?? 'dist/release'), version: values.version }));
  } else if (command === 'sums' && rest.length === 1) {
    for (const line of await sums(path.resolve(rest[0]))) console.log(line);
  } else throw new Error('Usage: package-binary.mjs pack --binary <file> --target <bun-target> [--out <dir>] | sums <dir>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main();
