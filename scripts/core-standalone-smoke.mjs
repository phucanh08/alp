#!/usr/bin/env node
// Standalone core smoke: the six neutral core tarballs are packed and installed into their own
// project (no repository node_modules, no `@getpaseo/*`, no `alp-paseo-plugin`, no React), then the
// installed CLI's daemon and runtime are exercised end to end with a deterministic fake ACP agent
// acting as a temporary provider — no real credentials, no user home.
//
// Covered: ACP adapter handshake, prompt + stream, a real unix-socket RPC, an IPC client disconnect
// with a reconnect that replays the retained session, and an alpd start that succeeds while the
// optional web integration is absent.
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { corePackageProblems } from './core-package-boundary.mjs';

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const TYPES_NODE = '@types/node@22.20.5';
const CORE_NAMES = ['@anhlp/alp-protocol', '@anhlp/alp-core', '@anhlp/alp-runtime', '@anhlp/alp-client', '@anhlp/alp-daemon', '@anhlp/alp-cli'];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: { ...process.env, ...options.env },
    maxBuffer: 256 * 1024 * 1024,
    timeout: options.timeout,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (options.allowFailure) return { status: result.status, output, stdout: result.stdout ?? '' };
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}${output ? `\n${output}` : ''}`);
  return result.stdout ?? '';
}

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

const work = mkdtempSync(path.join(os.tmpdir(), 'alp-core-standalone-'));
const packs = path.join(work, 'packs');
const core = path.join(work, 'core');
mkdirSync(packs, { recursive: true });

try {
  // A clean source copy has neither integrations/paseo nor Paseo web/node_modules. Real npm
  // prepack lifecycles here prove builds do not silently depend on an existing plugin checkout.
  const source = path.join(work, 'source');
  mkdirSync(source);
  const sourceManifest = { ...manifest, workspaces: manifest.workspaces.filter(location => location.startsWith('packages/')) };
  writeFileSync(path.join(source, 'package.json'), JSON.stringify(sourceManifest));
  for (const location of sourceManifest.workspaces) {
    mkdirSync(path.join(source, location), { recursive: true });
    copyFileSync(path.join(root, location, 'package.json'), path.join(source, location, 'package.json'));
    cpSync(path.join(root, location, 'src'), path.join(source, location, 'src'), { recursive: true });
  }
  for (const location of ['scripts', 'templates', 'packages/protocol/schema', 'packages/protocol/fixtures']) cpSync(path.join(root, location), path.join(source, location), { recursive: true });
  mkdirSync(path.join(source, 'docs'));
  copyFileSync(path.join(root, 'docs/modular-monorepo.md'), path.join(source, 'docs/modular-monorepo.md'));
  for (const file of ['README.md', 'tsconfig.core.json']) copyFileSync(path.join(root, file), path.join(source, file));
  run('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: source, capture: true, timeout: 420_000 });
  if (installedPackages(source).some(name => name.startsWith('@getpaseo/'))) throw new Error('core build source installed Paseo');
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.core.json'], { cwd: source });
  const tarballs = [];
  const byName = new Map();
  for (const name of CORE_NAMES) {
    const output = run('npm', ['pack', '--workspace', name, '--pack-destination', packs, '--json'], { cwd: source, capture: true });
    const [packed] = JSON.parse(output.slice(output.indexOf('[')));
    const pkg = JSON.parse(readFileSync(path.join(root, 'packages', name.replace('@anhlp/alp-', ''), 'package.json')));
    const problems = corePackageProblems(pkg, packed.files.map(file => file.path));
    if (problems.length) throw new Error(problems.join('\n'));
    tarballs.push(path.join(packs, packed.filename));
    byName.set(name, path.join(packs, packed.filename));
  }

  // Install them into their own project, alone.
  mkdirSync(core, { recursive: true });
  writeFileSync(path.join(core, 'package.json'), `${JSON.stringify({ name: 'alp-standalone-core', private: true, version: '0.0.0', type: 'module' }, null, 2)}\n`);
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--save-exact', ...tarballs, TYPES_NODE], { cwd: core, timeout: 420_000 });

  const leaked = installedPackages(core).filter(name =>
    name.startsWith('@getpaseo/') || name === 'alp-paseo-plugin' ||
    ['react', 'react-dom', 'react-native', 'react-is'].includes(name) || name.startsWith('@types/react'));
  if (leaked.length) throw new Error(`the core-only install must not carry the Paseo plugin or React, found: ${leaked.join(', ')}`);
  console.log(`core-only install ok (${installedPackages(core).length} packages, no plugin/SDK/React)`);

  // The deterministic fake ACP agent and the driver, both run from inside the isolated project.
  copyFileSync(path.join(root, 'test/support/fake-acp.js'), path.join(core, 'fake-acp.js'));
  copyFileSync(path.join(root, 'scripts/core-standalone-driver.mjs'), path.join(core, 'driver.mjs'));
  const noHome = path.join(work, 'no-home');
  mkdirSync(noHome, { recursive: true });

  const { status, output } = run(process.execPath, ['driver.mjs'], { cwd: core, capture: true, allowFailure: true, timeout: 300_000, env: { HOME: noHome, ALP_HOME: path.join(noHome, 'alp'), USERPROFILE: noHome } });
  process.stdout.write(output);
  if (status !== 0 || !output.includes('STANDALONE_CORE_SMOKE_PASSED')) {
    throw new Error(`standalone core driver exited ${status} without passing\n${output}`);
  }
  // Exercise the actual CLI/ACP executable in both distributions. Root gets only its three
  // declared ALP dependencies, not the CLI/daemon/runtime workspaces that could mask omissions.
  const [packedRoot] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packs], { cwd: source, capture: true }).replace(/^[\s\S]*?(?=\[\n)/, ''));
  const problems = corePackageProblems(manifest, packedRoot.files.map(file => file.path));
  if (problems.length) throw new Error(problems.join('\n'));
  const distribution = path.join(work, 'distribution');
  mkdirSync(distribution);
  writeFileSync(path.join(distribution, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', path.join(packs, packedRoot.filename), ...Object.keys(manifest.dependencies).filter(name => byName.has(name)).map(name => byName.get(name))], { cwd: distribution, timeout: 420_000 });
  for (const [directory, cli] of [[core, 'node_modules/@anhlp/alp-cli/dist/cli.js'], [distribution, 'node_modules/@anhlp/alp/packages/cli/dist/cli.js']]) {
    // Installs use --legacy-peer-deps, so only missing peers of an installed package are expected.
    const { stdout: tree } = run('npm', ['ls', '--all', '--json'], { cwd: directory, capture: true, allowFailure: true });
    const unexpected = (JSON.parse(tree).problems ?? []).filter(problem => {
      const missing = /^missing: ((?:@[^/@]+\/)?[^@]+)@[^,]+, required by ((?:@[^/@]+\/)?[^@]+)@/.exec(problem);
      if (!missing) return true;
      const requirer = JSON.parse(readFileSync(path.join(directory, 'node_modules', missing[2], 'package.json'), 'utf8'));
      return !Object.hasOwn(requirer.peerDependencies ?? {}, missing[1]);
    });
    if (unexpected.length) throw new Error(`installed dependency graph has problems:\n${unexpected.join('\n')}`);
    if (/@getpaseo\/|alp-paseo-plugin/.test(tree)) throw new Error('Paseo found in installed dependency graph');
    // Inspect actual installed source, declarations, JSON and JS including nested dependencies.
    const modules = path.join(directory, 'node_modules');
    for (const file of readdirSync(modules, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !/\.(?:[cm]?js|ts|json)$/.test(file.name)) continue;
      const absolute = path.join(file.parentPath ?? file.path, file.name);
      if (readFileSync(absolute, 'utf8').includes('@getpaseo/')) throw new Error(`installed artifact contains Paseo: ${absolute}`);
    }
    copyFileSync(path.join(root, 'test/support/fake-acp.js'), path.join(directory, 'fake-acp.js'));
    copyFileSync(path.join(root, 'scripts/cli-standalone-driver.mjs'), path.join(directory, 'cli-driver.mjs'));
    run(process.execPath, ['cli-driver.mjs', cli], { cwd: directory, timeout: 180_000, env: { HOME: noHome, USERPROFILE: noHome, ALP_HOME: path.join(directory, 'cli-home'), ALP_WEB_INTEGRATION: '', ALP_INTEGRATION_ENTRY: '', PATH: path.dirname(process.execPath), NODE_PATH: '' } });
  }
  console.log('Standalone core and main distribution smoke passed');
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
