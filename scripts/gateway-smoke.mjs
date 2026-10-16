#!/usr/bin/env node
// Standalone smoke of the remote gateway package (docs/alp/remote-gateway.md §9): packs protocol,
// core, client and gateway, installs only those tarballs into an empty project (no Paseo, no
// React, no repository links), then runs the installed `alp-gateway` against a real alpd from this
// checkout with a fake Codex app-server: credential create, serve, readiness, a ticket, and a
// session created and prompted over the WebSocket with the installed client SDK. Temporary homes
// only; nothing reads or writes ~/.alp. Needs the builds (node scripts/build-workspace.mjs gateway
// and daemon).
import { spawn, spawnSync } from 'node:child_process';
import { spawnCommand } from './spawn-command.mjs';
import { once } from 'node:events';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const work = await mkdtemp(path.join(tmpdir(), 'alp-gateway-smoke-'));
const log = message => console.log(`[gateway-smoke] ${message}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function run(command, args, options = {}) {
  const result = spawnSync(...spawnCommand(command, args), { encoding: 'utf8', timeout: 180_000, maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}${result.error ?? ''}`);
  return result.stdout;
}

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
try {
  const packs = path.join(work, 'packs');
  await mkdir(packs);
  for (const name of ['@anhlp/alp-protocol', '@anhlp/alp-core', '@anhlp/alp-client', '@anhlp/alp-gateway']) run('npm', ['pack', '--ignore-scripts', '--pack-destination', packs, '--workspace', name], { cwd: root });
  const consumer = path.join(work, 'consumer');
  await mkdir(consumer);
  await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'gateway-consumer', private: true, type: 'module' }));
  run('npm', ['install', '--no-audit', '--no-fund', '--offline', '--ignore-scripts', ...(await readdir(packs)).map(file => path.join(packs, file))], { cwd: consumer });
  const installed = (await readdir(path.join(consumer, 'node_modules'))).flatMap(name => name.startsWith('@') ? [] : [name]);
  const scoped = await readdir(path.join(consumer, 'node_modules/@anhlp'));
  const leaked = [...installed.filter(name => ['@anhlp/alp-paseo', 'react', 'react-native', 'react-dom'].includes(name)), ...(await readdir(path.join(consumer, 'node_modules')).then(names => names.filter(name => name === '@getpaseo')))];
  if (leaked.length) throw new Error(`the gateway install must not carry Paseo or React: ${leaked.join(', ')}`);
  if (scoped.some(name => !['alp-protocol', 'alp-core', 'alp-client', 'alp-gateway'].includes(name))) throw new Error(`unexpected ALP packages: ${scoped.join(', ')}`);
  log(`installed without Paseo: @anhlp/${scoped.join(', @anhlp/')}`);

  // A real alpd from this checkout, with a fake provider, in a throwaway home.
  const home = path.join(work, 'home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), '{}');
  const project = path.join(work, 'project');
  const { initProject } = await import(pathToFileURL(path.join(root, 'packages/core/src/init.js')).href);
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const env = { ...process.env, ALP_HOME: home, ALP_GATEWAY_HOME: path.join(work, 'gateway'), ALP_CODEX_BIN: path.join(root, 'packages/daemon/tests/support/fake-codex.js') };
  const alpd = spawn(process.execPath, [path.join(root, 'packages/daemon/dist/alpd.js')], { env, stdio: 'ignore', detached: true });
  children.push(alpd);
  const { readLock } = await import(pathToFileURL(path.join(consumer, 'node_modules/@anhlp/alp-client/src/index.js')).href);
  for (let i = 0; ; i++) {
    const lock = await readLock(home);
    if (lock?.ready && lock.pid === alpd.pid) break;
    if (alpd.exitCode !== null || i > 400) throw new Error('alpd did not start');
    await sleep(25);
  }

  // The installed CLI: a credential, then the server.
  // The installed bin script under this Node: on Windows .bin holds shell shims spawn cannot run.
  const cli = path.join(consumer, 'node_modules/@anhlp/alp-gateway/src/cli.js');
  const { token } = JSON.parse(run(process.execPath, [cli, 'credential', 'create', '--label', 'smoke', '--workspace', project, '--json'], { env, cwd: consumer }));
  const server = spawn(process.execPath, [cli, 'serve', '--port', '0'], { env, cwd: consumer, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(server);
  const stderr = [];
  server.stderr.on('data', chunk => stderr.push(String(chunk)));
  const [line] = await Promise.race([once(createInterface({ input: server.stdout }), 'line'), sleep(10_000).then(() => { throw new Error(`alp-gateway serve printed nothing:\n${stderr.join('')}`); })]);
  const { listening } = JSON.parse(line);
  log(`alp-gateway listening on ${listening}`);
  for (let i = 0; (await fetch(`${listening}/readyz`)).status !== 200; i++) { if (i > 200) throw new Error('never ready'); await sleep(50); }

  // A client from the installed SDK, the way a remote client connects.
  await writeFile(path.join(consumer, 'client.mjs'), `
import WebSocket from 'ws';
import { AlpRpcClient, hello } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';
const [base, token, project] = process.argv.slice(2);
const ticket = await (await fetch(base + '/v1/tickets', { method: 'POST', headers: { authorization: 'Bearer ' + token } })).json();
const client = new AlpRpcClient(await connectWebSocket(base.replace(/^http/, 'ws') + ticket.websocket, { WebSocket, protocols: ticket.subprotocols }));
const greeting = await hello(client, { name: 'smoke', version: '0' });
if (!greeting.capabilities.includes('attach.after')) throw new Error('no attach.after');
const events = [];
client.onEvent(envelope => events.push(envelope.event.type));
const { session } = await client.request('session.create', { spec: { cwd: project, model: 'codex:gpt-5.6-sol' }, history: 'skip' });
await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'smoke-1', content: [{ type: 'text', text: 'hello' }] });
for (let i = 0; !events.includes('turn.ended'); i++) { if (i > 400) throw new Error('no turn.ended: ' + events); await new Promise(r => setTimeout(r, 25)); }
const { id } = await client.request('task.create', { projectRoot: project, title: 'smoke task' });
if (!(await client.request('task.list', { projectRoot: project })).tasks.some(task => task.id === id)) throw new Error('task not listed');
await client.request('daemon.shutdown').then(() => { throw new Error('daemon.shutdown was allowed'); }, error => { if (error.code !== -32601) throw error; });
client.close();
console.log(JSON.stringify({ events: events.length }));
`);
  const outcome = JSON.parse(run(process.execPath, ['client.mjs', listening, token, project], { cwd: consumer, env }));
  log(`session created and prompted, a task created and listed through the installed gateway (${outcome.events} events); daemon.shutdown refused`);
  const logText = stderr.join('');
  if (logText.includes(token.split('.').at(-1))) throw new Error('the token reached the gateway log');
  log('ok');
} finally {
  for (const child of children) { try { child.pid && process.kill(child === children[0] ? -child.pid : child.pid, 'SIGTERM'); } catch {} }
  await sleep(300);
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}
