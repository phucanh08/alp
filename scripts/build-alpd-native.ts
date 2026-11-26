#!/usr/bin/env node
// The native alpd (t-81b0.9, docs/alp/binary-install.md): alpd compiled with `bun build --compile` into
// one executable, `<bundle>/bin/alpd`, for the platforms in NATIVE_PLATFORMS. Only alpd is native; the
// `alp` CLI keeps running on the bundle's official Node (plans/261030-node-runtime-bundle).
//
// Two steps: esbuild bundles packages/daemon/src/native-entry.ts as alpd.js is built (templates embedded,
// the version defined), with the Claude Agent SDK inside instead of external; Bun (the version pinned in
// apps/desktop/package.json) compiles that one file onto the Bun runtime of scripts/bun-runtime.json,
// downloaded from Bun's GitHub release and checked against its pinned sha256 (cached in .cache/bun). The
// build fails when the executable carries a path of the build machine that the bare Bun runtime does not
// (bun inlines __dirname and import.meta paths; t-81b0.7 shipped a blank window that way).
//
//   node scripts/build-alpd-native.ts --platform darwin-arm64 --out <file> [--bun <path>]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';
import { ROOT, requireShim, resources, sourceConditions } from './workspace-build-lib.ts';

/** The platforms whose bundle ships the native alpd; the others keep alpd.js on the bundle's Node. */
export const NATIVE_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];

/**
 * Bun's --target for an ALP platform. Linux builds are glibc (the bundle's Node is glibc too). x64 uses
 * Bun's baseline build: the default one needs AVX2, which older Intel CPUs lack and Node does not require.
 */
export function bunTarget(platform: string) {
  if (!NATIVE_PLATFORMS.includes(platform)) throw new Error(`No native alpd for ${platform}; expected one of ${NATIVE_PLATFORMS.join(', ')}`);
  return `bun-${platform}${platform.endsWith('-x64') ? '-baseline' : ''}`;
}

/** The Bun version the repository pins (apps/desktop/package.json packageManager), which scripts/bun-runtime.json must match. */
export async function pinnedBun() {
  const { packageManager } = JSON.parse(await readFile(path.join(ROOT, 'apps/desktop/package.json'), 'utf8'));
  const version = /^bun@(\d+\.\d+\.\d+)$/.exec(packageManager ?? '')?.[1];
  if (!version) throw new Error(`apps/desktop/package.json packageManager ${JSON.stringify(packageManager)} pins no Bun version`);
  const runtime = JSON.parse(await readFile(path.join(ROOT, 'scripts/bun-runtime.json'), 'utf8'));
  if (runtime.version !== version) throw new Error(`scripts/bun-runtime.json pins Bun ${runtime.version}, apps/desktop/package.json ${version}; change them together`);
  return version;
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * The pinned Bun runtime for `platform`: downloaded (or reused from `cache`), its zip checked against
 * scripts/bun-runtime.json, and unpacked. Returns the runtime executable's path.
 */
export async function bunRuntime(platform: string, cache: string) {
  const pinned = JSON.parse(await readFile(path.join(ROOT, 'scripts/bun-runtime.json'), 'utf8'));
  const entry = pinned.archives[platform];
  if (!entry) throw new Error(`No pinned Bun runtime for ${platform}`);
  await mkdir(cache, { recursive: true });
  const zip = path.join(cache, entry.file);
  let bytes = existsSync(zip) ? await readFile(zip) : undefined;
  if (!bytes || sha256(bytes) !== entry.sha256) {
    const url = `https://github.com/oven-sh/bun/releases/download/bun-v${pinned.version}/${entry.file}`;
    console.log(`[build-alpd-native] downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status})`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== entry.sha256) throw new Error(`${entry.file}: sha256 ${sha256(bytes)} is not the pinned ${entry.sha256}`);
    await writeFile(zip, bytes);
  }
  // Always unpacked afresh from the verified zip: nothing extracted earlier is trusted.
  const unpacked = path.join(cache, `${entry.file.replace(/\.zip$/, '')}-${entry.sha256.slice(0, 12)}`);
  const runtime = path.join(unpacked, entry.file.replace(/\.zip$/, ''), 'bun');
  await rm(unpacked, { recursive: true, force: true });
  await mkdir(unpacked, { recursive: true });
  const result = spawnSync('unzip', ['-q', '-o', zip, '-d', unpacked], { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.status !== 0 || !existsSync(runtime)) throw new Error(`Could not unpack ${zip} with unzip (${result.status ?? result.error})`);
  return runtime;
}

/** Whether this machine can run `platform`'s executables (its own platform, or x64 on an Apple silicon Mac with Rosetta). */
function runnable(platform: string) {
  // Another OS indexes nothing (`undefined-<arch>`), which matches no platform, as before.
  const here = `${({ darwin: 'darwin', linux: 'linux' } as Partial<Record<NodeJS.Platform, string>>)[process.platform]}-${process.arch}`;
  if (platform === here) return true;
  return platform === 'darwin-x64' && process.platform === 'darwin' && spawnSync('arch', ['-x86_64', '/usr/bin/true']).status === 0;
}

/**
 * Paths of this build machine that appear in the executable (the checkout, the scratch directory, the
 * home directory; each also with forward slashes for Windows) but not in the bare Bun `runtime` it was
 * built on: Bun's own binary holds strings such as /root and /tmp, which are no leak.
 */
export function leakedPaths(bytes: Buffer, paths: string[], runtime: Buffer = Buffer.alloc(0)) {
  const found = [];
  for (const candidate of new Set(paths.flatMap(item => [item, item.replaceAll('\\', '/')]).filter(item => item && item.length > 4))) {
    const needle = Buffer.from(candidate);
    if (bytes.includes(needle) && !runtime.includes(needle)) found.push(candidate);
  }
  return found;
}

/**
 * Builds the native alpd for `platform` at `out` and returns its path.
 */
export async function buildNativeDaemon({ platform, out, bun = 'bun', version, cache = path.join(ROOT, '.cache/bun') }: { platform: string; out: string; bun?: string; version: string; cache?: string; }) {
  const target = bunTarget(platform);
  const pinned = await pinnedBun();
  const have = spawnSync(bun, ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }).stdout?.trim();
  if (have !== pinned) throw new Error(`The native alpd is built with Bun ${pinned} (apps/desktop/package.json); ${bun} is ${have || 'missing'}`);
  const runtime = await bunRuntime(platform, cache);
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
    // The pinned runtime, never one Bun downloads by itself.
    const result = spawnSync(bun, ['build', '--compile', `--target=${target}`, `--compile-executable-path=${runtime}`, '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig', entry, '--outfile', out], { cwd: work, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' });
    if (result.status !== 0) throw new Error(`bun build --compile failed (${result.status ?? result.error})`);
    if (!platform.startsWith('windows-')) await chmod(out, 0o755);
    const leaked = leakedPaths(await readFile(out), [ROOT, await realpathOr(ROOT), work, await realpathOr(work), os.homedir()], await readFile(runtime));
    if (leaked.length) throw new Error(`${out} carries paths of the build machine: ${leaked.join(', ')}`);
    // It runs here and reports its version without starting alpd (native-register.ts).
    if (runnable(platform)) {
      const reported = spawnSync(out, ['--version'], { encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH ?? '' } });
      if (reported.status !== 0 || reported.stdout.trim() !== version) throw new Error(`${out} --version printed ${JSON.stringify(reported.stdout?.trim())} (${reported.status ?? reported.error}${reported.stderr ? `: ${reported.stderr.trim()}` : ''}), not ${version}`);
    }
  } finally { await rm(work, { recursive: true, force: true }); }
  return out;
}

const realpathOr = (file: string) => realpath(file).catch(() => file);

async function main() {
  const { values } = parseArgs({ options: { platform: { type: 'string' }, out: { type: 'string' }, bun: { type: 'string' } } });
  if (!values.platform || !values.out) throw new Error('Usage: build-alpd-native.ts --platform <platform> --out <file> [--bun <path>]');
  const { version } = JSON.parse(await readFile(path.join(ROOT, 'packages/cli/package.json'), 'utf8'));
  console.log(await buildNativeDaemon({ platform: values.platform, out: path.resolve(values.out), version, ...(values.bun ? { bun: values.bun } : {}) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) await main();
