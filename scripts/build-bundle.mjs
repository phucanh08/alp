#!/usr/bin/env node
// @ts-check
// Builds the ALP bundle for one platform (t-1807, docs/alp/binary-install.md): the official Node
// release (scripts/node-runtime.json, checksum-pinned), `npm install` of the packed @anhlp/alp-cli
// workspaces, and a launcher, the way Paseo ships its daemon on Electron's Node. ALP then runs
// exactly as the npm package does; there is no single-file executable any more.
//
//   alp-<version>-<platform>/
//     bin/alp (sh) | bin/alp.cmd (Windows)   launcher: node/…/node lib/node_modules/@anhlp/alp-cli/dist/cli.js
//     bin/alpd                               the native alpd (t-81b0.9, scripts/build-alpd-native.mjs) on the
//                                            platforms in NATIVE_PLATFORMS; elsewhere alpd is alpd.js on node/
//     node/bin/node | node/node.exe          + node/LICENSE
//     lib/node_modules/…                     @anhlp/alp-cli and its production dependencies
//     alp-bundle.json  LICENSE  NOTICE  THIRD-PARTY-NOTICES.txt
//
// The Claude Code native packages (@anthropic-ai/claude-agent-sdk-<platform>, ~250 MB) are left out:
// ALP always runs the user's own `claude` (or ALP_CLAUDE_BIN).
//
//   node scripts/build-bundle.mjs [--platform darwin-arm64] [--out dist/bundle] [--no-build] [--node-cache dir]
//                                 [--bun path] [--no-native-daemon]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawnCommand } from './spawn-command.mjs';
import { buildNativeDaemon, NATIVE_PLATFORMS, pinnedBun } from './build-alpd-native.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'windows-x64'];
/** The workspaces @anhlp/alp-cli needs at run time (alpd, the runtime and alp-dashboard are bundled in its dist). */
const WORKSPACES = ['packages/protocol', 'packages/core', 'packages/client', 'packages/cli'];
const CLI = 'lib/node_modules/@anhlp/alp-cli/dist/cli.js';

/** This machine's platform; a Node translated by Rosetta 2 still names the native arm64 Mac. */
export function hostPlatform() {
  // Another OS indexes nothing and names the platform `undefined-<arch>`, as before.
  const osName = /** @type {Partial<Record<NodeJS.Platform, string>>} */ ({ darwin: 'darwin', linux: 'linux', win32: 'windows' })[process.platform];
  let arch = process.arch;
  if (process.platform === 'darwin' && arch === 'x64' && spawnSync('sysctl', ['-n', 'sysctl.proc_translated'], { encoding: 'utf8' }).stdout?.trim() === '1') arch = 'arm64';
  return `${osName}-${arch}`;
}

const npmTarget = /** @param {string} platform */ platform => {
  const [osName, arch] = platform.split('-');
  return { os: osName === 'windows' ? 'win32' : osName, cpu: arch };
};

/** The POSIX launcher: follows symlinks (~/.alp/bin/alp → app/current/bin/alp) to the bundle, then runs its Node. */
export const POSIX_LAUNCHER = `#!/bin/sh
# ALP launcher (scripts/build-bundle.mjs): runs ALP with the Node release shipped beside it.
set -e
self="$0"
while [ -L "$self" ]; do
  link=$(readlink "$self")
  case "$link" in /*) self="$link" ;; *) self="$(dirname "$self")/$link" ;; esac
done
root=$(cd "$(dirname "$self")/.." && pwd -P)
exec "$root/node/bin/node" "$root/${CLI}" "$@"
`;

/** The Windows launcher. */
export const WINDOWS_LAUNCHER = `@echo off\r
rem ALP launcher (scripts/build-bundle.mjs): runs ALP with the Node release shipped beside it.\r
"%~dp0..\\node\\node.exe" "%~dp0..\\${CLI.replaceAll('/', '\\')}" %*\r
`;

const sha256 = /** @param {Buffer} bytes */ bytes => createHash('sha256').update(bytes).digest('hex');

/**
 * @param {string} command
 * @param {readonly string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [options]
 * @returns {string}
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', shell: process.platform === 'win32' && command === 'npm', ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status ?? result.error})`);
  return /** @type {string} */ (result.stdout); // encoding 'utf8' (callers do not override it)
}

/**
 * Downloads (or reuses from `cache`) the pinned Node archive for `platform` and checks its sha256.
 * @param {string} platform
 * @param {string} cache
 */
export async function nodeArchive(platform, cache) {
  /** scripts/node-runtime.json. @type {{ version: string, archives: Record<string, { file: string, sha256: string } | undefined> }} */
  const pinned = JSON.parse(await readFile(path.join(ROOT, 'scripts/node-runtime.json'), 'utf8'));
  const entry = pinned.archives[platform];
  if (!entry) throw new Error(`No pinned Node archive for ${platform}`);
  await mkdir(cache, { recursive: true });
  const file = path.join(cache, entry.file);
  let bytes = existsSync(file) ? await readFile(file) : undefined;
  if (!bytes || sha256(bytes) !== entry.sha256) {
    const url = `https://nodejs.org/dist/v${pinned.version}/${entry.file}`;
    console.log(`[build-bundle] downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== entry.sha256) throw new Error(`${entry.file}: sha256 ${sha256(bytes)} is not the pinned ${entry.sha256}`);
    await writeFile(file, bytes);
  }
  return { file, version: pinned.version, name: entry.file.replace(/\.(tar\.gz|zip)$/, '') };
}

/**
 * Third-party packages the lockfile holds at exactly one version: name → version.
 * @param {{ packages?: Record<string, { link?: boolean, version?: string }> }} lock
 * @returns {Map<string, string>}
 */
export function lockedVersions(lock) {
  /** @type {Map<string, Set<string>>} */
  const seen = new Map();
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    const match = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
    if (!match || entry.link || !entry.version || match[1].startsWith('@anhlp/')) continue;
    const versions = seen.get(match[1]) ?? new Set();
    versions.add(entry.version);
    seen.set(match[1], versions);
  }
  return new Map([...seen].filter(([, versions]) => versions.size === 1).map(([name, versions]) => [name, [...versions][0]]));
}

/** Removes the files only other platforms use: their node-pty prebuilds and native terminal helpers. */
/** @param {string} modules @param {string} platform */
async function prune(modules, platform) {
  const npm = npmTarget(platform);
  for (const name of await readdir(path.join(modules, '@anthropic-ai')).catch(() => [])) {
    // The native Claude Code CLI of each platform: ALP uses the user's claude instead.
    if (/^claude-agent-sdk-/.test(name)) await rm(path.join(modules, '@anthropic-ai', name), { recursive: true, force: true });
  }
  const prebuilds = path.join(modules, 'node-pty', 'prebuilds');
  for (const name of await readdir(prebuilds).catch(() => [])) {
    if (name !== `${npm.os}-${npm.cpu}`) await rm(path.join(prebuilds, name), { recursive: true, force: true });
  }
  for (const pdb of (await readdir(prebuilds, { recursive: true }).catch(() => [])).filter(name => name.endsWith('.pdb'))) await rm(path.join(prebuilds, pdb), { force: true });
  // Nothing at run time reads type declarations or source maps (Node uses maps only with
  // --enable-source-maps), in any package; third-party READMEs and changelogs go too (ALP's own
  // packages keep their markdown: the templates are .md).
  for (const entry of await readdir(modules, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const name = path.relative(modules, path.join(entry.parentPath, entry.name));
    const own = name.startsWith(`@anhlp${path.sep}`);
    if (/\.(map|d\.[cm]?ts)$/.test(name) || (!own && /(^|[\\/])(README|CHANGELOG|HISTORY)(\.md|\.markdown)?$/i.test(name))) await rm(path.join(modules, name), { force: true });
  }
  const helpers = path.join(modules, '@anhlp/alp-cli/dist/terminal-native/prebuilt');
  for (const name of await readdir(helpers).catch(() => [])) {
    if (!name.startsWith(`${npm.os}-${npm.cpu}`)) await rm(path.join(helpers, name), { recursive: true, force: true });
  }
}

/** THIRD-PARTY-NOTICES.txt: Node's licence, then the notices of the bundled JavaScript. */
/** @param {string} nodeLicense @param {string | undefined} bunVersion */
async function notices(nodeLicense, bunVersion) {
  const parts = [`Third-party software in the ALP bundle

node/ is the official Node.js release (https://nodejs.org), under the licence below. lib/node_modules
holds ALP's npm dependencies, each with its own licence file; the notices of the JavaScript bundled
into @anhlp/alp-cli's dist follow Node's.
`];
  parts.push(`\n${'='.repeat(100)}\nNode.js\n${'='.repeat(100)}\n\n${nodeLicense.trim()}\n`);
  // The native alpd (t-81b0.9) is the Bun runtime with alpd's JavaScript inside.
  if (bunVersion) parts.push(`\n${'='.repeat(100)}\nBun ${bunVersion} (bin/alpd)\n${'='.repeat(100)}\n\nbin/alpd is built with \`bun build --compile\` and contains the Bun runtime ${bunVersion}\n(https://github.com/oven-sh/bun, MIT License, Copyright (c) Jarred Sumner and Oven contributors).\nBun statically links JavaScriptCore and WebKit's bmalloc/WTF (LGPL-2.1, source at\nhttps://github.com/oven-sh/WebKit) and other third-party libraries; their licences are listed at\nhttps://bun.com/docs/project/licensing. The JavaScript inside bin/alpd is the same as\nlib/node_modules/@anhlp/alp-cli/dist/alpd.js plus @anthropic-ai/claude-agent-sdk, whose notices follow\nor ship in lib/node_modules.\n`);
  for (const source of ['packages/cli/dist/THIRD-PARTY-NOTICES.txt', 'packages/cli/dist/alp-dashboard/THIRD-PARTY-NOTICES.txt']) {
    const text = await readFile(path.join(ROOT, source), 'utf8').catch(() => { throw new Error(`${source} is missing; run npm run build first`); });
    parts.push(`\n${'='.repeat(100)}\n${source}\n${'='.repeat(100)}\n\n${text.trim()}\n`);
  }
  return parts.join('');
}

/**
 * Builds the bundle directory and returns its path.
 * @param {{ platform: string, out: string, build?: boolean, nodeCache?: string, bun?: string, nativeDaemon?: boolean }} options
 * nativeDaemon: build bin/alpd (default: on the platforms in NATIVE_PLATFORMS)
 */
export async function buildBundle({ platform, out, build = true, nodeCache = path.join(ROOT, '.cache/node'), bun, nativeDaemon = NATIVE_PLATFORMS.includes(platform) }) {
  if (!PLATFORMS.includes(platform)) throw new Error(`Unsupported platform ${platform}; expected one of ${PLATFORMS.join(', ')}`);
  const windows = platform.startsWith('windows-');
  if (build) run('npm', ['run', 'build'], { stdio: 'inherit' });
  const { version } = JSON.parse(await readFile(path.join(ROOT, 'packages/cli/package.json'), 'utf8'));
  const name = `alp-${version}-${platform}`;
  const directory = path.resolve(out, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(path.join(directory, 'lib'), { recursive: true });
  const work = await mkdtemp(path.join(os.tmpdir(), 'alp-bundle-'));
  try {
    // 1. The workspaces as npm would publish them (already built: no prepack).
    const packs = path.join(work, 'packs');
    await mkdir(packs);
    /** @type {Record<string, string>} */
    const tarballs = {};
    for (const location of WORKSPACES) {
      const [packed] = JSON.parse(run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', packs], { cwd: path.join(ROOT, location) }));
      tarballs[packed.name] = path.join(packs, packed.filename);
    }
    // 2. npm install them, with their production dependencies, as `npm install -g @anhlp/alp-cli` lays them out.
    const lib = path.join(directory, 'lib');
    const target = npmTarget(platform);
    // The repository's lockfile decides every third-party version, so the five platforms ship the
    // tree CI tested: each package locked at one version is pinned to it through overrides.
    const overrides = lockedVersions(JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8')));
    await writeFile(path.join(lib, 'package.json'), JSON.stringify({ private: true, dependencies: Object.fromEntries(Object.entries(tarballs).map(([pkg, file]) => [pkg, `file:${file}`])), overrides: Object.fromEntries(overrides) }));
    run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--ignore-scripts', `--os=${target.os}`, `--cpu=${target.cpu}`, ...(target.os === 'linux' ? ['--libc=glibc'] : [])], { cwd: lib, stdio: ['ignore', 'inherit', 'inherit'] });
    await rm(path.join(lib, 'package.json'), { force: true });
    const modules = path.join(lib, 'node_modules');
    await rm(path.join(modules, '.package-lock.json'), { force: true });
    if (!existsSync(path.join(modules, '@anthropic-ai/claude-agent-sdk/package.json'))) throw new Error('@anthropic-ai/claude-agent-sdk was not installed');
    const drift = [];
    for (const [pkg, version] of overrides) {
      const installed = await readFile(path.join(modules, pkg, 'package.json'), 'utf8').then(text => JSON.parse(text).version, () => undefined);
      if (installed !== undefined && installed !== version) drift.push(`${pkg} ${installed} (locked ${version})`);
    }
    if (drift.length) throw new Error(`The bundle's dependencies differ from package-lock.json: ${drift.join(', ')}`);
    await prune(modules, platform);
    // 3. Node itself: only the executable and its licence (no npm, headers or docs).
    const node = await nodeArchive(platform, nodeCache);
    const unpacked = path.join(work, 'node');
    await mkdir(unpacked);
    run(...spawnCommand('tar', [windows ? '-xf' : '-xzf', node.file, '-C', unpacked]));
    await mkdir(path.join(directory, windows ? 'node' : 'node/bin'), { recursive: true });
    const exe = windows ? 'node.exe' : 'bin/node';
    await copyFile(path.join(unpacked, node.name, exe), path.join(directory, 'node', exe));
    if (!windows) await chmod(path.join(directory, 'node', exe), 0o755);
    const nodeLicense = await readFile(path.join(unpacked, node.name, 'LICENSE'), 'utf8');
    await writeFile(path.join(directory, 'node/LICENSE'), nodeLicense);
    // 4. Launcher, manifest and licences.
    await mkdir(path.join(directory, 'bin'));
    if (windows) await writeFile(path.join(directory, 'bin/alp.cmd'), WINDOWS_LAUNCHER);
    else { await writeFile(path.join(directory, 'bin/alp'), POSIX_LAUNCHER); await chmod(path.join(directory, 'bin/alp'), 0o755); }
    // 5. The native alpd: alp starts it instead of alpd.js when it is there (packages/core/src/packaged.ts daemonEntry).
    if (nativeDaemon) await buildNativeDaemon({ platform, out: path.join(directory, 'bin/alpd'), version, ...(bun ? { bun } : {}) });
    await writeFile(path.join(directory, 'alp-bundle.json'), `${JSON.stringify({ name: 'alp', version, platform, node: node.version, daemon: nativeDaemon ? 'native' : 'node' }, null, 2)}\n`);
    await copyFile(path.join(ROOT, 'LICENSE'), path.join(directory, 'LICENSE'));
    await copyFile(path.join(ROOT, 'NOTICE'), path.join(directory, 'NOTICE'));
    await writeFile(path.join(directory, 'THIRD-PARTY-NOTICES.txt'), await notices(nodeLicense, nativeDaemon ? await pinnedBun() : undefined));
  } finally { await rm(work, { recursive: true, force: true }); }
  console.log(`Built ${directory} (ALP ${version}, ${platform})`);
  return directory;
}

async function main() {
  const { values } = parseArgs({ options: { platform: { type: 'string' }, out: { type: 'string' }, 'no-build': { type: 'boolean' }, 'node-cache': { type: 'string' }, bun: { type: 'string' }, 'no-native-daemon': { type: 'boolean' } } });
  await buildBundle({ platform: values.platform ?? hostPlatform(), out: path.resolve(values.out ?? path.join(ROOT, 'dist/bundle')), build: !values['no-build'], ...(values['node-cache'] ? { nodeCache: path.resolve(values['node-cache']) } : {}), ...(values.bun ? { bun: values.bun } : {}), ...(values['no-native-daemon'] ? { nativeDaemon: false } : {}) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main();
