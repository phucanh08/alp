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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  if (options.allowFailure) return { status: result.status, output };
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status}${output ? `\n${output}` : ''}`);
  return output;
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
  // Pack only the neutral core workspaces.
  const tarballs = [];
  for (const name of CORE_NAMES) {
    const output = run('npm', ['pack', '--workspace', name, '--pack-destination', packs, '--ignore-scripts', '--json'], { capture: true });
    const [{ filename }] = JSON.parse(output.slice(output.indexOf('[')));
    tarballs.push(path.join(packs, filename));
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
  console.log('Standalone core smoke passed');
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
