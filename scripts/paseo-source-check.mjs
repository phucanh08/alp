#!/usr/bin/env node
// Install the packed plugin the way Paseo installs a `paseo plugin add npm:<spec>` source, and prove
// Paseo can compile it there (issue #111).
//
// Paseo (packages/server/src/server/plugins/managed-source/npm.ts) runs
// `npm install --ignore-scripts --legacy-peer-deps --omit=dev` in a directory of its own, so no
// peer dependency is installed. Its runtime-boundary check (plugins/compiler.ts) then follows every
// import of the plugin's sources and declarations, type-only ones too; only host modules (the
// plugin SDK, zod, react, react-native, @tanstack/react-query, Node builtins) are exempt. One type
// import of a peer-only package such as `@getpaseo/relay` or `@getpaseo/client` fails the whole
// install with `Could not resolve type dependency`.
//
// This check installs the same way, then
//   1. asserts no shipped TypeScript source or declaration imports a non-host package that is not
//      installed beside it, and
//   2. runs Paseo's own compiler (from the pinned checkout scripts/build-paseo-web.mjs makes) on
//      the installed plugin's server and client entries, which also follows the declarations of
//      installed dependencies. Without that checkout it is skipped, unless
//      ALP_REQUIRE_PASEO_COMPILER=1 (validate:packages sets it after building the checkout).
// The scan in 1 resolves imports as Paseo's compiler-imports.ts does, but only the plugin's own
// files: it is a fast, readable pre-check; the compile in 2 is the authoritative one. The compiler
// is bundled against this repository's esbuild and typescript, not Paseo's pinned versions.
//
//   paseo-source-check.mjs <plugin.tgz> [dependency.tgz ...]
//
// The dependency tarballs stand in for the `@anhlp/alp-*` versions the registry would supply.
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import ts from 'typescript';
import { spawnCommand } from './spawn-command.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export const PASEO_NPM_INSTALL = ['install', '--ignore-scripts', '--legacy-peer-deps', '--omit=dev'];
const PASEO_SOURCE = path.resolve(process.env.ALP_PASEO_SRC ?? path.join(ROOT, '.cache/paseo-web'));
const PASEO_COMPILER = 'packages/server/src/server/plugins/compiler.ts';
// Paseo's plugin-sdk-specifiers.ts and the host-module test in compiler.ts.
const HOST_SDK = new Set(['@getpaseo/plugin', '@getpaseo/plugin/server', '@getpaseo/plugin/server/provider', '@getpaseo/plugin/server/usage', '@getpaseo/plugin/server/acp', '@getpaseo/plugin/client', '@getpaseo/plugin/client/ui', '@getpaseo/plugin/client/react-native']);
const HOST_MODULE = /^(zod|react|react-native|@tanstack\/react-query)(\/|$)/;
const builtins = new Set(builtinModules);

function packageName(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function hostModule(specifier) {
  return HOST_SDK.has(specifier) || HOST_MODULE.test(specifier) || specifier.startsWith('node:') || builtins.has(specifier) || builtins.has(packageName(specifier)) || specifier === '@types/node';
}

// Paseo's compiler-imports.ts: TypeScript's bundler resolution, JavaScript allowed.
const RESOLUTION = { module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true };
const typesPackage = name => `@types/${name.replace(/^@/, '').replace('/', '__')}`;

/** The package's own TypeScript sources and declarations (`.ts`, `.tsx`, `.d.ts`, …). */
function typeScriptFiles(directory) {
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && /\.[cm]?tsx?$/.test(entry.name))
    .map(entry => path.join(entry.parentPath, entry.name))
    .filter(file => !path.relative(directory, file).split(path.sep).includes('node_modules'));
}

/** Every bare, non-host import of a shipped TypeScript file that does not resolve inside `project`. */
export function unresolvedTypeScriptImports(project, packageDirectory) {
  const files = typeScriptFiles(packageDirectory);
  const problems = new Set();
  for (const file of files) {
    const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    const imports = [...info.importedFiles.map(ref => ({ specifier: ref.fileName, reference: false })), ...info.typeReferenceDirectives.map(ref => ({ specifier: ref.fileName, reference: true }))];
    for (const { specifier, reference } of imports) {
      if (specifier.startsWith('.') || path.isAbsolute(specifier)) continue;
      // Paseo checks a type reference as its @types package (`types="node"` is @types/node, a host module).
      if (hostModule(specifier) || (reference && hostModule(typesPackage(specifier)))) continue;
      // No ambient exemption: Paseo resolves every specifier to a file, so `declare module` does not help.
      const resolved = reference
        ? ts.resolveTypeReferenceDirective(specifier, file, RESOLUTION, ts.sys).resolvedTypeReferenceDirective?.resolvedFileName
        : ts.resolveModuleName(specifier, file, RESOLUTION, ts.sys).resolvedModule?.resolvedFileName;
      // TypeScript returns real paths (on macOS the temporary directory is a symlink into /private).
      if (!resolved || !realpathSync.native(resolved).startsWith(realpathSync.native(project) + path.sep)) problems.add(`${path.relative(packageDirectory, file)} imports "${specifier}", which does not resolve in the install (peer-only or missing)`);
    }
  }
  return { files: files.length, declarations: files.filter(file => /\.d\.[cm]?ts$/.test(file)).length, problems: [...problems] };
}

/** Compile the installed plugin with Paseo's own compiler, as `paseo plugin add` does. */
async function paseoCompile(packageDirectory) {
  const compiler = path.join(PASEO_SOURCE, PASEO_COMPILER);
  if (!existsSync(compiler)) {
    if (process.env.ALP_REQUIRE_PASEO_COMPILER === '1') throw new Error(`Paseo's plugin compiler is missing at ${compiler}; run scripts/build-paseo-web.mjs first`);
    return { skipped: `no Paseo checkout at ${PASEO_SOURCE}` };
  }
  // Bundled into this repository's .cache so its own esbuild and typescript imports resolve here.
  const outfile = path.join(ROOT, '.cache/paseo-compiler/compiler.mjs');
  await build({ entryPoints: [compiler], outfile, bundle: true, format: 'esm', platform: 'node', target: 'node22', external: ['esbuild', 'typescript'], logLevel: 'warning' });
  const { compilePlugin } = await import(`${pathToFileURL(outfile).href}?${Date.now()}`);
  // Paseo's runtime.ts entry file names.
  const entry = names => names.map(name => path.join(packageDirectory, name)).find(file => existsSync(file)) ?? null;
  const entries = { server: entry(['index.server.ts', 'index.server.tsx']), client: entry(['index.client.ts', 'index.client.tsx']) };
  if (!entries.server && !entries.client) throw new Error(`no Paseo plugin entry (index.server.ts[x] or index.client.ts[x]) in ${packageDirectory}`);
  let bundles;
  try {
    bundles = await compilePlugin(entries);
  } catch (error) {
    throw new Error(`Paseo's compiler rejects the installed plugin (#111):\n  ${String(error?.message ?? error)}`);
  }
  for (const target of ['server', 'client']) {
    if (entries[target] && !bundles[`${target}Bundle`]) throw new Error(`Paseo's compiler produced no ${target} bundle for ${entries[target]}`);
  }
  return { server: bundles.serverBundle?.length ?? 0, client: bundles.clientBundle?.length ?? 0 };
}

/** Install `plugin` as Paseo installs an npm: source, check its imports and compile it. */
export async function checkPaseoNpmSource({ plugin, dependencies = [], work }) {
  const project = path.join(work, 'paseo-npm-source');
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'package.json'), `${JSON.stringify({ name: 'paseo-plugin-installation', version: '1.0.0', private: true }, null, 2)}\n`);
  const args = [...PASEO_NPM_INSTALL, '--no-audit', '--no-fund', plugin, ...dependencies];
  const result = spawnSync(...spawnCommand('npm', args), { cwd: project, encoding: 'utf8', stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} exited ${result.status}`);
  const name = JSON.parse(spawnSync('tar', ['-xOzf', plugin, 'package/package.json'], { encoding: 'utf8' }).stdout).name;
  const packageDirectory = path.join(project, 'node_modules', name);
  const manifest = JSON.parse(readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
  // A peer that is also a dependency (ws) is installed as the dependency; only peer-only ones must be absent.
  const peers = Object.keys(manifest.peerDependencies ?? {}).filter(peer => !manifest.dependencies?.[peer]);
  const leakedPeers = peers.filter(peer => existsSync(path.join(project, 'node_modules', peer, 'package.json')));
  if (leakedPeers.length) throw new Error(`the Paseo-style install must not carry peers, found: ${leakedPeers.join(', ')}`);
  const report = unresolvedTypeScriptImports(project, packageDirectory);
  if (report.problems.length) {
    throw new Error(`${name} cannot be added with \`paseo plugin add npm:\`: shipped TypeScript imports packages Paseo does not install (#111)\n  ${report.problems.join('\n  ')}`);
  }
  return { name, ...report, compiled: await paseoCompile(packageDirectory) };
}

export function describe({ name, files, declarations, compiled }) {
  const compile = compiled.skipped ? `Paseo compiler skipped (${compiled.skipped})` : `Paseo's compiler built server ${compiled.server} B, client ${compiled.client} B`;
  return `${name}: installed as a Paseo npm: source (no peers); ${files} shipped TypeScript file(s), ${declarations} declaration(s), none imports an uninstalled package; ${compile}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [plugin, ...dependencies] = process.argv.slice(2).map(file => path.resolve(file));
  if (!plugin) throw new Error('Usage: paseo-source-check.mjs <plugin.tgz> [dependency.tgz ...]');
  const work = mkdtempSync(path.join(os.tmpdir(), 'alp-paseo-source-'));
  try {
    console.log(describe(await checkPaseoNpmSource({ plugin, dependencies, work })));
  } finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
