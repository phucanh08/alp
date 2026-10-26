#!/usr/bin/env node
// Verify packed modules without repository source, workspace links, or a provider login.
// `--packs <release directory>` (scripts/release-pack.mjs) installs that release's saved tarballs,
// after checking them against its SHA256SUMS, instead of packing the workspaces.
import { cleanupFakeWeb, freeWebPort } from './beta-web-lifecycle.mjs';
import { spawnSync } from 'node:child_process';
import { spawnCommand } from './spawn-command.mjs';
import { releaseArtifacts } from './release-lib.mjs';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root = path.resolve(import.meta.dirname, '..');
const packsAt = process.argv.indexOf('--packs');
const saved = packsAt >= 0 ? releaseArtifacts(path.resolve(process.argv[packsAt + 1] ?? '')) : undefined;
const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-package-smoke-'));
function run(command, args, options = {}) {
  const result = spawnSync(...spawnCommand(command, args), { cwd: directory, encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}${result.error ?? ''}`);
  return result.stdout;
}
const env = { ...process.env, ALP_HOME: path.join(directory, 'home') };
let cli;
try {
  await mkdir(env.ALP_HOME, { recursive: true, mode: 0o700 });
  await writeFile(path.join(env.ALP_HOME, 'settings.json'), JSON.stringify({ web: { port: await freeWebPort(), relay: { enabled: false } } }));
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const dependencies = {};
  const workspaceNames = [];
  for (const artifact of saved ?? []) {
    dependencies[artifact.name] = `file:${artifact.file}`;
    if (artifact.name !== manifest.name) workspaceNames.push(artifact.name);
  }
  for (const location of saved ? [] : manifest.workspaces) {
    const pkg = JSON.parse(await readFile(path.join(root, location, 'package.json'), 'utf8'));
    if (pkg.private) continue;
    const packed = JSON.parse(run('npm', ['pack', '--workspace', pkg.name, '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root }))[0];
    dependencies[pkg.name] = `file:${path.join(directory, packed.filename)}`;
    workspaceNames.push(pkg.name);
  }
  const savedRoot = saved?.find(artifact => artifact.name === manifest.name);
  const legacy = savedRoot ? undefined : JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', directory], { cwd: root }))[0];
  if (legacy) dependencies[manifest.name] = `file:${path.join(directory, legacy.filename)}`;
  // Core distribution stays neutral even in a checkout with built plugin artifacts.
  const shipped = new Set(savedRoot ? savedRoot.files.keys() : legacy.files.map(file => file.path));
  for (const file of ['packages/cli/dist/cli.js', 'packages/core/dist/index.js', 'packages/client/dist/index.js', 'dist/alpd.js']) {
    if (!shipped.has(file)) throw new Error(`the root distribution must ship ${file}`);
  }
  for (const file of shipped) {
    if (/integrations\/|@getpaseo\//.test(file)) throw new Error(`core tarball leaks ${file}`);
  }
  // The plugin package's server entry needs its host SDK peers; pin the versions this repository
  // resolved. The React client-host peers stay out of this server-only smoke.
  const plugin = saved?.find(artifact => artifact.name === '@anhlp/alp-paseo')?.manifest ?? JSON.parse(await readFile(path.join(root, 'integrations/paseo/package.json'), 'utf8'));
  for (const [name, range] of Object.entries(plugin.peerDependencies ?? {})) {
    if (name === 'react' || name === 'react-native') continue;
    const resolved = await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8').then(JSON.parse, () => undefined);
    dependencies[name] = resolved?.version ?? range;
  }
  await writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }));
  // Client-side plugin peers are supplied by Paseo; no React Native host is needed for this server smoke.
  run('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund']);
  const imports = workspaceNames.filter(name => name !== '@anhlp/alp-paseo');
  run(process.execPath, ['--input-type=module', '-e', `for (const name of ${JSON.stringify(imports)}) await import(name).catch(error => { if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; }); await import('./node_modules/@anhlp/alp-paseo/server/dist/index.js'); await import('./node_modules/@anhlp/alp-cli/dist/acp.js'); await import('./node_modules/@anhlp/alp/packages/core/dist/index.js'); await import('./node_modules/@anhlp/alp/packages/client/dist/index.js');`]);
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
  // `alp web` runs alp-web, which ships in the CLI: it needs no plugin. It starts from an unrelated
  // directory through a symlink, as its own process, with the alpgw1 token of a live credential.
  const bin = path.join(directory, 'bin');
  const elsewhere = path.join(directory, 'elsewhere');
  await mkdir(bin, { recursive: true });
  await mkdir(elsewhere, { recursive: true });
  const alpLink = path.join(bin, 'alp');
  await symlink(path.relative(bin, legacyCli), alpLink);
  const fromElsewhere = (...args) => run(process.execPath, [alpLink, ...args], { cwd: elsewhere, env });
  const line = fromElsewhere('web', '--print').trim().split('\n').pop();
  const match = /^(http:\/\/127\.0\.0\.1:\d+)\/#token=(alpgw1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43})$/.exec(line);
  if (!match) throw new Error(`alp web --print printed no loopback address with an alpgw1 token: ${line}`);
  const [, origin, token] = match;
  const alpd = JSON.parse(await readFile(path.join(env.ALP_HOME, 'alpd.lock'), 'utf8'));
  const web = JSON.parse(await readFile(path.join(env.ALP_HOME, 'integrations', 'web.lock'), 'utf8'));
  if (!web.pid || web.pid === alpd.pid) throw new Error(`alp web must run as its own process (alpd ${alpd.pid}, alp-web ${web.pid})`);
  for (const pid of [alpd.pid, web.pid]) { try { process.kill(pid, 0); } catch { throw new Error(`process ${pid} is not alive`); } }
  const served = await fetch(`${origin}/`);
  if (served.status !== 200) throw new Error(`GET ${origin}/ answered ${served.status}`);
  await served.body?.cancel();
  const ticket = await fetch(`${origin}/v1/tickets`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  if (ticket.status !== 201) throw new Error(`POST ${origin}/v1/tickets with the printed token answered ${ticket.status}`);
  await ticket.body?.cancel();
  // Explicitly register the separately installed plugin, using its existing public command; `alp web
  // pair` then starts the Paseo integration beside alp-web.
  run(process.execPath, [path.join(directory, 'node_modules/@anhlp/alp-paseo/server/dist/main.js'), '--register'], { env });
  const paired = fromElsewhere('web', 'pair', '--off');
  if (!/relay is off/i.test(paired)) throw new Error(`alp web pair --off did not report the relay off: ${paired}`);
  console.log(`Standalone installation verified: ${imports.length} module APIs, Paseo server, ACP, CLI and daemon lifecycle, the legacy @anhlp/alp distribution, alp web (alp-web, no plugin) and the separately installed Paseo integration.`);
} finally {
  await cleanupFakeWeb(env.ALP_HOME, () => {
    if (cli) spawnSync(process.execPath, [cli, 'daemon', 'stop'], { cwd: directory, env, stdio: 'ignore', timeout: 20_000 });
  });
  await rm(directory, { recursive: true, force: true });
}
