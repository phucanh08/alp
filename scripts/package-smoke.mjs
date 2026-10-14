#!/usr/bin/env node
// Verify packed modules without repository source, workspace links, or a provider login.
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root = path.resolve(import.meta.dirname, '..');
const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-package-smoke-'));
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: directory, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}${result.error ?? ''}`);
  return result.stdout;
}
const env = { ...process.env, ALP_HOME: path.join(directory, 'home') };
let cli;
try {
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const dependencies = {};
  for (const location of manifest.workspaces) {
    const pkg = JSON.parse(await readFile(path.join(root, location, 'package.json'), 'utf8'));
    if (pkg.private) continue;
    const packed = JSON.parse(run('npm', ['pack', '--workspace', pkg.name, '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root }))[0];
    dependencies[pkg.name] = `file:${path.join(directory, packed.filename)}`;
  }
  const legacy = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root }))[0];
  dependencies[manifest.name] = `file:${path.join(directory, legacy.filename)}`;
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }));
  // Client-side plugin peers are supplied by Paseo; no React Native host is needed for this server smoke.
  run('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund']);
  const imports = Object.keys(dependencies).filter(name => name !== 'alp-paseo-plugin' && name !== manifest.name);
  run(process.execPath, ['--input-type=module', '-e', `for (const name of ${JSON.stringify(imports)}) await import(name); await import('./node_modules/alp-paseo-plugin/server/dist/index.js'); await import('./node_modules/@anhlp/alp-cli/dist/acp.js'); await import('./node_modules/@anhlp/alp/packages/core/dist/index.js'); await import('./node_modules/@anhlp/alp/packages/client/dist/index.js');`]);
  await writeFile(path.join(directory, 'consumer.ts'), `import { createAlpRuntime, createProviderRegistry, type RuntimeOptions } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { connect } from '@anhlp/alp-client';
import type { Envelope, SessionSpec, RpcRequest } from '@anhlp/alp-protocol';
import { createTask } from '@anhlp/alp-core/tasks';
const spec: SessionSpec = { cwd: '/tmp/project' };
const options: RuntimeOptions = { providerRegistry: createProviderRegistry() };
const runtime = createAlpRuntime(options);
void runtime.preview(spec);
void createDaemonServer; void connect; void createTask;
const frame: RpcRequest = { jsonrpc: '2.0', id: 1, method: 'session.preview', params: { spec } };
const observe = (envelope: Envelope) => envelope.event.type;
void frame; void observe;
`);
  run(process.execPath, [path.join(root, 'node_modules/typescript/lib/tsc.js'), '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--typeRoots', path.join(root, 'node_modules/@types'), 'consumer.ts']);
  cli = path.join(directory, 'node_modules/@anhlp/alp-cli/dist/cli.js');
  const alp = (...args) => run(process.execPath, [cli, ...args], { env });
  const project = path.join(directory, 'project');
  alp('init', project);
  alp('upgrade', project);
  alp('language');
  alp('agents', '--project', project, '--json');
  alp('teams', '--project', project, '--json');
  alp('daemon', 'start');
  alp('daemon', 'status');
  alp('daemon', 'stop');
  const legacyCli = path.join(directory, 'node_modules/@anhlp/alp/packages/cli/dist/cli.js');
  for (const args of [['init', path.join(directory, 'legacy-project')], ['upgrade', path.join(directory, 'legacy-project')], ['language'], ['daemon', 'start'], ['daemon', 'status'], ['daemon', 'stop']]) run(process.execPath, [legacyCli, ...args], { env });
  console.log(`Standalone installation verified: ${imports.length} module APIs, Paseo server, ACP, CLI and daemon lifecycle, plus the legacy @anhlp/alp distribution.`);
} finally {
  if (cli) spawnSync(process.execPath, [cli, 'daemon', 'stop'], { cwd: directory, env, stdio: 'ignore', timeout: 20_000 });
  await rm(directory, { recursive: true, force: true });
}
