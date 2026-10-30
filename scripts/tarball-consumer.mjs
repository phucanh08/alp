#!/usr/bin/env node
// Proof that the published tarballs are real, independently installable packages, in two isolated
// projects that never reach back into this repository's node_modules:
//
//   1. Core: install only the six neutral workspace tarballs. They must come up with no Paseo SDK,
//      no plugin and no React packages at all, then import at runtime and typecheck strictly.
//   2. Plugin: install the plugin tarball plus its declared Paseo/React peer dependencies at pinned
//      published versions. It must import at runtime and pass its behavioural regressions.
//   3. Paseo npm: source: install the plugin as `paseo plugin add npm:` does (own directory,
//      --legacy-peer-deps, no peers; scripts/paseo-source-check.mjs). No TypeScript it ships may
//      import a non-host package that is not installed there, and Paseo's compiler must build it (#111).
//
// The only addition is `@types/node` (a consumer always needs Node's types); no `paths`, no
// `typeRoots`, and no hand-written SDK stubs point anywhere near this repository.
//
// `--packs <release directory>` (scripts/release-pack.mjs) installs that release's saved tarballs,
// after checking them against its SHA256SUMS, instead of packing the workspaces.
import { spawnSync } from 'node:child_process';
import { spawnCommand } from './spawn-command.mjs';
import { LAUNCHER, PLATFORM_NAMES, releaseArtifacts } from './release-lib.mjs';
import { checkPaseoNpmSource, describe as describePaseoSource } from './paseo-source-check.mjs';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const packsAt = process.argv.indexOf('--packs');
const savedPacks = packsAt >= 0 ? path.resolve(process.argv[packsAt + 1] ?? '') : undefined;
const TYPES_NODE = '@types/node@22.20.5';
const typescript = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function run(command, args, options = {}) {
  const result = spawnSync(...spawnCommand(command, args), { cwd: options.cwd ?? root, encoding: 'utf8', stdio: options.capture ? 'pipe' : 'inherit', maxBuffer: 128 * 1024 * 1024 });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (options.allowFailure) return { status: result.status, output };
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}${output ? `\n${output}` : ''}`);
  return output;
}

/** The concrete published version a dependency/peer is pinned to: what this repository resolved. */
function installedVersion(name) {
  const file = path.join(root, 'node_modules', name, 'package.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).version : undefined;
}

/** Every package name present in a project's node_modules, scopes expanded. */
function installedPackages(directory) {
  const nodeModules = path.join(directory, 'node_modules');
  const names = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.package-lock.json') continue;
    if (entry.name.startsWith('@')) for (const scoped of readdirSync(path.join(nodeModules, entry.name))) names.push(`${entry.name}/${scoped}`);
    else names.push(entry.name);
  }
  return names;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function installProject(directory, specs) {
  mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, 'package.json'), { name: `alp-consumer-${path.basename(directory)}`, private: true, version: '0.0.0', type: 'module' });
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--save-exact', ...specs], { cwd: directory });
}

function typecheck(directory, tsconfig, { expectFailure = false, mustMention } = {}) {
  writeJson(path.join(directory, 'tsconfig.json'), tsconfig);
  const { status, output } = run(process.execPath, [typescript, '-p', path.join(directory, 'tsconfig.json')], { cwd: directory, capture: true, allowFailure: true });
  if (expectFailure) {
    if (status === 0) throw new Error(`expected a type error for ${tsconfig.files.join(', ')} but tsc passed`);
    if (mustMention && !output.includes(mustMention)) throw new Error(`expected tsc to report ${mustMention}\n${output}`);
    return output;
  }
  if (status !== 0) throw new Error(`typecheck failed for ${tsconfig.files.join(', ')}\n${output}`);
  return output;
}

const strictConsumerTsconfig = files => ({ compilerOptions: { module: 'nodenext', moduleResolution: 'nodenext', target: 'es2022', strict: true, skipLibCheck: false, noEmit: true, types: ['node'] }, files });

const work = mkdtempSync(path.join(os.tmpdir(), 'alp-tarball-consumer-'));
const packs = path.join(work, 'packs');
mkdirSync(packs, { recursive: true });
try {
  // Pack every public workspace once, and remember the tarball for each package name. With
  // `--packs <release directory>`, use that release's saved tarballs as they are instead.
  const tarballs = new Map();
  const publicPackages = [];
  for (const artifact of savedPacks ? releaseArtifacts(savedPacks) : []) {
    // The launcher and the platform packages hold no JavaScript API; package-smoke runs them.
    if (artifact.name === LAUNCHER || PLATFORM_NAMES.includes(artifact.name)) continue;
    publicPackages.push(artifact.manifest);
    tarballs.set(artifact.name, artifact.file);
  }
  for (const location of savedPacks ? [] : manifest.workspaces) {
    const pkg = JSON.parse(readFileSync(path.join(root, location, 'package.json'), 'utf8'));
    if (pkg.private) continue;
    publicPackages.push(pkg);
    const output = run('npm', ['pack', '--workspace', pkg.name, '--pack-destination', packs, '--ignore-scripts', '--json'], { capture: true });
    const [{ filename }] = JSON.parse(output.slice(output.indexOf('[')));
    tarballs.set(pkg.name, path.join(packs, filename));
  }
  const plugin = publicPackages.find(pkg => pkg.name === '@anhlp/alp-paseo');
  const corePackages = publicPackages.filter(pkg => pkg.name !== '@anhlp/alp-paseo');
  const coreTarballs = corePackages.map(pkg => tarballs.get(pkg.name));

  // 1. The neutral core installs alone: no Paseo SDK, no plugin, no React.
  const core = path.join(work, 'core');
  installProject(core, [...coreTarballs, TYPES_NODE]);
  const leaked = installedPackages(core).filter(name =>
    name.startsWith('@getpaseo/') || name === '@anhlp/alp-paseo' || ['react', 'react-dom', 'react-native', 'react-is'].includes(name) || name.startsWith('@types/react'));
  if (leaked.length) throw new Error(`the core install must not carry Paseo SDK or React packages, found: ${leaked.join(', ')}`);

  writeFileSync(path.join(core, 'import.mjs'), `
import assert from 'node:assert/strict';
const protocol = await import('@anhlp/alp-protocol');
const coreInit = await import('@anhlp/alp-core/init');
const runtime = await import('@anhlp/alp-runtime');
const client = await import('@anhlp/alp-client');
const daemon = await import('@anhlp/alp-daemon');
const cli = await import('@anhlp/alp-cli');
assert.equal(protocol.PROTOCOL_VERSION, 1);
assert.equal(typeof protocol.encodeFrame, 'function');
assert.equal(typeof coreInit.initProject, 'function');
assert.equal(typeof runtime.createAlpRuntime, 'function');
assert.equal(typeof client.alpHome, 'function');
assert.equal(typeof daemon.createDaemonServer, 'function');
assert.equal(typeof cli.CLI_PACKAGE, 'string');
console.log('core runtime imports ok');
`);
  run(process.execPath, [path.join(core, 'import.mjs')], { cwd: core });

  writeFileSync(path.join(core, 'consumer.ts'), `
import { PROTOCOL_VERSION, ERROR, encodeFrame, type SessionSpec, type SessionSummary, type SessionStatus, type SessionError } from '@anhlp/alp-protocol';
import { initProject } from '@anhlp/alp-core/init';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { alpHome, lockAlive } from '@anhlp/alp-client';
import { createDaemonServer, createStore, type SessionSummary as DaemonSessionSummary } from '@anhlp/alp-daemon';
import { CLI_PACKAGE } from '@anhlp/alp-cli';
export const version: number = PROTOCOL_VERSION;
export const notFound: number = ERROR.notFound;
export const use = (spec: SessionSpec, summary: SessionSummary, status: SessionStatus, error: SessionError) => [encodeFrame, initProject, createAlpRuntime, alpHome, lockAlive, createDaemonServer, createStore, CLI_PACKAGE, spec, summary, status, error] as const;
/** The daemon's alias and the protocol's type are the same neutral shape, both directions. */
export const sameType = (summary: DaemonSessionSummary): SessionSummary => summary;
`);
  typecheck(core, strictConsumerTsconfig(['consumer.ts']));
  writeFileSync(path.join(core, 'removed.ts'), `import { createWebServer } from '@anhlp/alp-daemon/web';\nexport { createWebServer };\n`);
  typecheck(core, strictConsumerTsconfig(['removed.ts']), { expectFailure: true, mustMention: '@anhlp/alp-daemon/web' });
  console.log('core consumer ok (isolated, no SDK or React)');

  // 2. The plugin installs with its declared published peers, pinned to the versions this repository
  //    resolved. Optional peers (react-native, client-side only) are left out.
  const pluginDir = path.join(work, 'plugin');
  const peerSpecs = Object.entries(plugin.peerDependencies ?? {})
    .filter(([name]) => !plugin.peerDependenciesMeta?.[name]?.optional)
    .map(([name, range]) => `${name}@${installedVersion(name) ?? range}`);
  installProject(pluginDir, [tarballs.get('@anhlp/alp-paseo'), ...coreTarballs, ...peerSpecs, TYPES_NODE, `esbuild@${installedVersion('esbuild')}`]);
  const sdkPeers = peerSpecs.filter(spec => spec.startsWith('@getpaseo/'));
  if (sdkPeers.length < 4) throw new Error(`expected the Paseo SDK peers in the plugin install, got: ${sdkPeers.join(', ')}`);

  writeFileSync(path.join(pluginDir, 'import.mjs'), `
import assert from 'node:assert/strict';
const plugin = await import('@anhlp/alp-paseo');
const quiet = await import('@anhlp/alp-paseo/paseo/quiet');
assert.equal(typeof plugin.default, 'function');
assert.equal(typeof plugin.createProvider, 'function');
assert.equal(typeof plugin.createWebServer, 'function');
assert.equal(typeof quiet.quietHandlers, 'object');
console.log('plugin runtime imports ok');
`);
  run(process.execPath, [path.join(pluginDir, 'import.mjs')], { cwd: pluginDir });

  // A Paseo plugin, not a library: it ships no declarations (#111), and its exports stop at its files.
  const shipped = readdirSync(path.join(pluginDir, 'node_modules/@anhlp/alp-paseo'), { recursive: true }).filter(file => /\.d\.[cm]?ts$/.test(file) && !file.split(path.sep).includes('node_modules'));
  if (shipped.length) throw new Error(`@anhlp/alp-paseo must not ship declarations (#111), found: ${shipped.join(', ')}`);
  const missing = run(process.execPath, ['--input-type=module', '-e', "await import('@anhlp/alp-paseo/paseo/does-not-exist')"], { cwd: pluginDir, capture: true, allowFailure: true });
  if (missing.status === 0 || !missing.output.includes('ERR_MODULE_NOT_FOUND')) throw new Error(`an unknown ./paseo/* subpath must not import\n${missing.output}`);
  console.log('plugin consumer ok (isolated, real SDK, no declarations)');

  // Run the existing behavioral regressions against installed public APIs, not workspace links.
  const tests = ['paseo', 'team', 'human', 'web', 'relay', 'bridge-socket', 'workflow', 'transport'];
  const suite = path.join(pluginDir, 'integrations/paseo/tests');
  mkdirSync(suite, { recursive: true });
  mkdirSync(path.join(pluginDir, 'test/support'), { recursive: true });
  const support = readFileSync(path.join(root, 'test/support/fake-agent.js'), 'utf8')
    .replace('../../packages/core/src/init.js', '@anhlp/alp-core/init')
    .replace('../../dist/runtime/index.js', '@anhlp/alp-runtime');
  writeFileSync(path.join(pluginDir, 'test/support/fake-agent.js'), support);
  for (const name of tests) {
    const source = readFileSync(path.join(root, 'integrations/paseo/tests', `${name}.test.js`), 'utf8')
      .replace("new URL('../server/dist/index.js', import.meta.url)", "import.meta.resolve('@anhlp/alp-paseo')");
    writeFileSync(path.join(suite, `${name}.test.js`), source);
  }
  const regression = spawnSync(process.execPath, ['--test', ...tests.map(name => path.join(suite, `${name}.test.js`))], {
    cwd: pluginDir, stdio: 'inherit', timeout: 180_000,
    env: { ...process.env, ALP_HOME: path.join(pluginDir, 'home'), NODE_PATH: '' },
  });
  if (regression.status !== 0) throw new Error(`installed plugin regressions failed: ${regression.status}`);

  // 3. The plugin as Paseo installs an npm: source: no peers, so no shipped type import may need one.
  console.log(describePaseoSource(await checkPaseoNpmSource({ plugin: tarballs.get('@anhlp/alp-paseo'), dependencies: coreTarballs, work })));

  console.log('Tarball consumer check passed');
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
