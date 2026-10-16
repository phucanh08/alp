// A disposable ALP host for the web app's end-to-end runs: a real alpd process with its own
// temporary home and a fake Codex, a real alp-gateway process with its own credentials, and the
// built web app served by Vite's preview server, each on a free loopback port. Nothing touches the
// user's ~/.alp, a running alpd, Paseo or the default ports (7433/7434/7435).
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, closeSync, existsSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEB = path.resolve(here, '../..');
export const REPOSITORY = path.resolve(WEB, '../..');
const ALPD = path.join(REPOSITORY, 'packages/daemon/dist/alpd.js');
const CLI = path.join(REPOSITORY, 'packages/cli/dist/cli.js');
const GATEWAY = path.join(REPOSITORY, 'apps/gateway/src/cli.js');
const FAKE_CODEX = path.join(here, 'fake-codex.js');
const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** A loopback port nobody listens on now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function readJson(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch { return undefined; } }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

/**
 * Serves the built app on 127.0.0.1:`port`, as any static host would (unknown paths get
 * index.html). Vite's preview server is not used here: it exits the process on SIGTERM before
 * the host's processes are stopped.
 */
export async function serveStatic(root, port) {
  const server = http.createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://web').pathname);
    let file = path.join(root, path.normalize(pathname).replace(/^([/\\])+/, ''));
    if (!file.startsWith(root) || pathname.endsWith('/')) file = path.join(root, 'index.html');
    let body;
    try { body = await readFile(file); } catch { file = path.join(root, 'index.html'); body = await readFile(file); }
    response.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    response.end(body);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  return { close: () => new Promise(resolve => { server.close(() => resolve(undefined)); server.closeAllConnections(); }) };
}

/** Stops a detached process group, politely first. */
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
  await Promise.race([exited, sleep(5000)]);
  if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await exited; }
}

/**
 * @param {{ webPort?: number, gatewayPort?: number, provider?: 'fake' | 'real', serveWeb?: boolean }} [options]
 */
export async function startWorld({ webPort, gatewayPort, provider = 'fake', serveWeb = true } = {}) {
  for (const file of [ALPD, CLI]) if (!existsSync(file)) throw new Error(`${path.relative(REPOSITORY, file)} is missing: run npm run build:alp-web:e2e-deps (node scripts/build-workspace.mjs cli && node scripts/build-workspace.mjs daemon)`);
  if (serveWeb && !existsSync(path.join(WEB, 'dist/index.html'))) throw new Error('apps/web/dist is missing: run npm run build:alp-web');
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-web-e2e-'));
  const home = path.join(directory, 'home');
  const gatewayHome = path.join(directory, 'gateway');
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), '{}');
  const journal = path.join(directory, 'codex.jsonl');
  const env = { ...process.env, ALP_HOME: home, ALP_GATEWAY_HOME: gatewayHome, ALP_LOG_LEVEL: 'info' };
  delete env.ALP_GATEWAY_URL;
  delete env.ALP_GATEWAY_TOKEN;
  if (provider === 'fake') Object.assign(env, { ALP_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_JOURNAL: journal });
  chmodSync(FAKE_CODEX, 0o755);

  // Two projects: one granted to the web credentials, one never granted (it must stay invisible).
  const projects = { main: path.join(directory, 'projects', 'shop'), other: path.join(directory, 'projects', 'secret') };
  for (const project of Object.values(projects)) {
    await mkdir(project, { recursive: true });
    await run(process.execPath, [CLI, 'init', project], { env });
    const settings = provider === 'fake'
      ? { workflow: { supervisor: false }, team: { pho: { main: { profiles: ['codex:gpt-5.6-sol'] } }, cafe: { main: { profiles: ['codex:gpt-5.6-sol'] } } } }
      : { workflow: { supervisor: false } };
    await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify(settings, null, 2));
  }

  const logs = { alpd: path.join(directory, 'alpd.log'), gateway: path.join(directory, 'gateway.log') };
  let daemon;
  let socket = '';
  async function startDaemon() {
    const log = openSync(logs.alpd, 'a');
    daemon = spawn(process.execPath, [ALPD], { detached: true, stdio: ['ignore', log, log], env });
    closeSync(log);
    for (let i = 0; ; i++) {
      const lock = await readJson(path.join(home, 'alpd.lock'));
      if (lock?.ready && lock.pid === daemon.pid && lock.socket) { socket = lock.socket; return; }
      if (daemon.exitCode !== null || i > 600) throw new Error(`alpd did not start:\n${await readFile(logs.alpd, 'utf8').catch(() => '')}`);
      await sleep(25);
    }
  }
  await startDaemon();

  const credential = async (label, extra = []) => {
    const { stdout } = await run(process.execPath, [GATEWAY, 'credential', 'create', '--label', label, ...extra, '--json'], { env });
    return JSON.parse(stdout);
  };
  const created = {
    owner: await credential('web-e2e', ['--workspace', projects.main]),
    viewer: await credential('viewer', ['--workspace', projects.main, '--permission', 'session.read', '--permission', 'project.read']),
    readOnlyMode: await credential('read-only-mode', ['--workspace', projects.main, '--mode', 'read-only']),
    other: await credential('other', ['--workspace', projects.other]),
    revocable: await credential('revocable', ['--workspace', projects.main]),
  };
  const tokens = Object.fromEntries(Object.entries(created).map(([name, entry]) => [name, entry.token]));
  const credentialIds = Object.fromEntries(Object.entries(created).map(([name, entry]) => [name, entry.credential.id]));

  webPort ??= await freePort();
  gatewayPort ??= await freePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  let gateway;
  async function startGateway() {
    const log = openSync(logs.gateway, 'a');
    gateway = spawn(process.execPath, [GATEWAY, 'serve', '--port', String(gatewayPort), '--origin', webOrigin, '--socket', socket], { detached: true, stdio: ['ignore', 'pipe', log], env });
    closeSync(log);
    let output = '';
    gateway.stdout.setEncoding('utf8');
    gateway.stdout.on('data', chunk => { output += chunk; });
    for (let i = 0; ; i++) {
      if (output.includes('"listening"')) break;
      if (gateway.exitCode !== null || i > 400) throw new Error(`gateway did not start:\n${await readFile(logs.gateway, 'utf8').catch(() => '')}`);
      await sleep(25);
    }
    for (let i = 0; i < 400; i++) {
      const ready = await fetch(`http://127.0.0.1:${gatewayPort}/readyz`).then(response => response.ok, () => false);
      if (ready) return;
      await sleep(25);
    }
    throw new Error('gateway never became ready');
  }
  await startGateway();

  const web = serveWeb ? await serveStatic(path.join(WEB, 'dist'), webPort) : undefined;

  const turnStarts = async () => (await readFile(journal, 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(entry => entry.method === 'turn/start');

  return {
    directory, home, projects, tokens, credentialIds, logs, journal, turnStarts,
    webUrl: webOrigin,
    gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    get socket() { return socket; },
    /** Runs the alp CLI on the host as its owner would. */
    alp: async (...args) => (await run(process.execPath, [CLI, ...args], { env, cwd: projects.main })).stdout,
    /** Runs alp-gateway's CLI on the host (credential list/revoke/rotate). */
    gatewayCli: async (...args) => (await run(process.execPath, [GATEWAY, ...args], { env })).stdout,
    startDaemon, startGateway,
    stopDaemon: () => stop(daemon),
    stopGateway: () => stop(gateway),
    async restartGateway() { await stop(gateway); await startGateway(); },
    async restartDaemon() { await stop(daemon); await startDaemon(); await stop(gateway); await startGateway(); },
    async gatewayLog() { return readFile(logs.gateway, 'utf8').catch(() => ''); },
    async close() {
      // Processes first: a browser keeping a connection open can hold the web server's close.
      await stop(gateway);
      await stop(daemon);
      await web?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
