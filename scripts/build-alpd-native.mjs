#!/usr/bin/env node
// The native alpd (t-81b0.9, docs/alp/binary-install.md): alpd compiled with `bun build --compile` into
// one executable, `<bundle>/bin/alpd`, for the platforms in NATIVE_PLATFORMS. Only alpd is native; the
// `alp` CLI keeps running on the bundle's official Node (plans/261030-node-runtime-bundle).
//
// Two steps: esbuild bundles packages/daemon/src/native-entry.ts as alpd.js is built (templates embedded,
// the version defined), with the Claude Agent SDK inside instead of external; Bun (the version pinned in
// apps/desktop/package.json) compiles that one file. The build fails when the executable carries a path
// of the build machine (bun inlines __dirname and import.meta paths; t-81b0.7 shipped a blank window
// that way).
//
//   node scripts/build-alpd-native.mjs --platform darwin-arm64 --out <file> [--bun <path>]
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { ROOT, requireShim, resources, sourceConditions } from './workspace-build-lib.mjs';

/** The platforms whose bundle ships the native alpd; the others keep alpd.js on the bundle's Node. */
export const NATIVE_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

/**
 * Bun's --target for an ALP platform. Linux builds are glibc (the bundle's Node is glibc too). x64 uses
 * Bun's baseline build: the default one needs AVX2, which older Intel CPUs lack and Node does not require.
 * @param {string} platform
 */
export function bunTarget(platform) {
  if (!NATIVE_PLATFORMS.includes(platform)) throw new Error(`No native alpd for ${platform}; expected one of ${NATIVE_PLATFORMS.join(', ')}`);
  return `bun-${platform}${platform.endsWith('-x64') ? '-baseline' : ''}`;
}

/** The Bun version the repository pins (apps/desktop/package.json packageManager). */
export async function pinnedBun() {
  const { packageManager } = JSON.parse(await readFile(path.join(ROOT, 'apps/desktop/package.json'), 'utf8'));
  const version = /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager ?? '')?.[1];
  if (!version) throw new Error(`apps/desktop/package.json packageManager ${JSON.stringify(packageManager)} pins no Bun version`);
  return version;
}

/**
 * Paths of this build machine that must not appear in the executable: the checkout, the scratch
 * directory and the home directory (each also with forward slashes on Windows).
 * @param {Buffer} bytes @param {string[]} paths
 */
export function leakedPaths(bytes, paths) {
  const found = [];
  for (const candidate of new Set(paths.flatMap(item => [item, item.replaceAll('\\', '/')]).filter(item => item && item.length > 4))) {
    if (bytes.includes(Buffer.from(candidate))) found.push(candidate);
  }
  return found;
}

/**
 * Builds the native alpd for `platform` at `out` and returns its path.
 * @param {{ platform: string, out: string, bun?: string, version: string }} options
 */
export async function buildNativeDaemon({ platform, out, bun = 'bun', version }) {
  const target = bunTarget(platform);
  const pinned = await pinnedBun();
  const have = spawnSync(bun, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout?.trim();
  if (have !== pinned) throw new Error(`The native alpd is built with Bun ${pinned} (apps/desktop/package.json); ${bun} is ${have || 'missing'}`);
  const work = await mkdtemp(path.join(os.tmpdir(), 'alpd-native-'));
  try {
    const entry = path.join(work, 'alpd-native.mjs');
    await build({
      absWorkingDir: ROOT, entryPoints: ['packages/daemon/src/native-entry.ts'], outfile: entry, bundle: true, format: 'esm', platform: 'node', target: 'node20',
      conditions: sourceConditions, external: ['node-pty'], plugins: await resources(), banner: requireShim,
      define: { __ALP_VERSION__: JSON.stringify(version) }, logLevel: 'warning',
    });
    await mkdir(path.dirname(out), { recursive: true });
    // .env and bunfig.toml in alpd's working directory must not change it: alpd is not a Bun app.
    const result = spawnSync(bun, ['build', '--compile', `--target=${target}`, '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', entry, '--outfile', out], { cwd: work, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
    if (result.status !== 0) throw new Error(`bun build --compile failed (${result.status ?? result.error})`);
    if (!platform.startsWith('windows-')) await chmod(out, 0o755);
    const leaked = leakedPaths(await readFile(out), [ROOT, await realpathOr(ROOT), work, await realpathOr(work), os.homedir()]);
    if (leaked.length) throw new Error(`${out} carries paths of the build machine: ${leaked.join(', ')}`);
  } finally { await rm(work, { recursive: true, force: true }); }
  return out;
}

const realpathOr = file => realpath(file).catch(() => file);

async function main() {
  const { values } = parseArgs({ options: { platform: { type: 'string' }, out: { type: 'string' }, bun: { type: 'string' } } });
  if (!values.platform || !values.out) throw new Error('Usage: build-alpd-native.mjs --platform <platform> --out <file> [--bun <path>]');
  const { version } = JSON.parse(await readFile(path.join(ROOT, 'packages/cli/package.json'), 'utf8'));
  console.log(await buildNativeDaemon({ platform: values.platform, out: path.resolve(values.out), version, ...(values.bun ? { bun: values.bun } : {}) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main();
