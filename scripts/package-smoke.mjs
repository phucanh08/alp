#!/usr/bin/env node
// Verify packed modules without repository source, workspace links, or a provider login.
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
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
  const workspaceNames = [];
  for (const location of manifest.workspaces) {
    const pkg = JSON.parse(await readFile(path.join(root, location, 'package.json'), 'utf8'));
    if (pkg.private) continue;
    const packed = JSON.parse(run('npm', ['pack', '--workspace', pkg.name, '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root }))[0];
    dependencies[pkg.name] = `file:${path.join(directory, packed.filename)}`;
    workspaceNames.push(pkg.name);
  }
  const legacy = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root }))[0];
  dependencies[manifest.name] = `file:${path.join(directory, legacy.filename)}`;
  // Core distribution stays neutral even in a checkout with built plugin/web artifacts.
  const shipped = new Set(legacy.files.map(file => file.path));
  for (const file of ['packages/cli/dist/cli.js', 'packages/core/dist/index.js', 'packages/client/dist/index.js', 'dist/alpd.js']) {
    if (!shipped.has(file)) throw new Error(`the root distribution must ship ${file}`);
  }
  for (const file of shipped) {
    if (/integrations\/|web-app\/|@getpaseo\//.test(file)) throw new Error(`core tarball leaks ${file}`);
  }
  // The plugin package's server entry needs its host SDK peers; pin the versions this repository
  // resolved. The React client-host peers stay out of this server-only smoke.
  const plugin = JSON.parse(await readFile(path.join(root, 'integrations/paseo/package.json'), 'utf8'));
  for (const [name, range] of Object.entries(plugin.peerDependencies ?? {})) {
    if (name === 'react' || name === 'react-native') continue;
    const resolved = await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8').then(JSON.parse, () => undefined);
    dependencies[name] = resolved?.version ?? range;
  }
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }));
  // Client-side plugin peers are supplied by Paseo; no React Native host is needed for this server smoke.
  run('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund']);
  const imports = workspaceNames.filter(name => name !== 'alp-paseo-plugin');
  run(process.execPath, ['--input-type=module', '-e', `for (const name of ${JSON.stringify(imports)}) await import(name).catch(error => { if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }); await import('./node_modules/alp-paseo-plugin/server/dist/index.js'); await import('./node_modules/@anhlp/alp-cli/dist/acp.js'); await import('./node_modules/@anhlp/alp/packages/core/dist/index.js'); await import('./node_modules/@anhlp/alp/packages/client/dist/index.js');`]);
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
  // Explicitly register the separately installed plugin, using its existing public command.
  run(process.execPath, [path.join(directory, 'node_modules/alp-paseo-plugin/server/dist/main.js'), '--register'], { env });
  // The optional integration starts as a separate process from an unrelated directory through a symlink.
  const bin = path.join(directory, 'bin');
  const elsewhere = path.join(directory, 'elsewhere');
  await mkdir(bin, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  const alpLink = path.join(bin, 'alp');
  await symlink(path.relative(bin, legacyCli), alpLink);
  const fromElsewhere = (...args) => run(process.execPath, [alpLink, ...args], { cwd: elsewhere, env });
  const line = fromElsewhere('web', '--print').trim().split('\n').pop();
  const token = line.match(/#token=([0-9a-f]{32,})$/)?.[1];
  if (!token) throw new Error(`alp web --print printed no authentication token: ${line}`);
  const alpd = JSON.parse(await readFile(path.join(env.ALP_HOME, 'alpd.lock'), 'utf8'));
  const integration = JSON.parse(await readFile(path.join(env.ALP_HOME, 'integrations', 'web.lock'), 'utf8'));
  if (!integration.pid || integration.pid === alpd.pid) throw new Error(`the web integration must run as its own process (alpd ${alpd.pid}, web ${integration.pid})`);
  for (const pid of [alpd.pid, integration.pid]) { try { process.kill(pid, 0); } catch { throw new Error(`process ${pid} is not alive`); } }
  const served = await fetch(line.replace(/#.*$/, ''));
  if (served.status >= 400) throw new Error(`the web app did not serve over HTTP: ${served.status}`);
  const paired = fromElsewhere('web', 'pair', '--off');
  if (!/relay is off/i.test(paired)) throw new Error(`alp web pair --off did not report the relay off: ${paired}`);
  console.log(`Standalone installation verified: ${imports.length} module APIs, Paseo server, ACP, CLI and daemon lifecycle, plus the legacy @anhlp/alp distribution and the separately installed web integration.`);
} finally {
  if (cli) spawnSync(process.execPath, [cli, 'daemon', 'stop'], { cwd: directory, env, stdio: 'ignore', timeout: 20_000 });
  // The web integration is a separate process; stop it before removing its temporary home.
  try {
    const integration = JSON.parse(await readFile(path.join(env.ALP_HOME, 'integrations', 'web.lock'), 'utf8'));
    if (integration?.pid) process.kill(integration.pid);
  } catch {}
  await rm(directory, { recursive: true, force: true });
}
