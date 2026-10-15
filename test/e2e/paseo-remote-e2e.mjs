#!/usr/bin/env node
// Opt-in, real model: the Paseo remote mode on one machine standing in for two (docs/alp/paseo-remote.md §7).
// Never part of the default tests. Needs an authenticated `codex` on PATH and `paseo` (0.11.x).
//
// From the release tarballs (npm pack, as package-smoke does), two clean installs share nothing:
//   host:   alpd (temporary ALP_HOME A, real Codex) and alp-gateway serving it on 127.0.0.1;
//   client: an isolated Paseo daemon (its own --home, port and ALP_HOME B) with the plugin from
//           its tarball, configured by ALP_GATEWAY_URL and ALP_GATEWAY_TOKEN only.
// Driven through Paseo's own client SDK: teams, create, prompt with a tool call and streaming, a
// question answered and one dismissed, cancel, a gateway restart in the middle of a turn, an alpd
// restart, and checks that B stays empty and no token reaches a log. Prints one JSON line per flow.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { createPaseoClient } from '@getpaseo/client';

const root = path.resolve(import.meta.dirname, '../..');
const keep = process.env.ALP_E2E_KEEP === '1';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise(resolve => { const server = createServer(); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
const base = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-paseo-remote-e2e-')));
const dirs = Object.fromEntries(['tarballs', 'host', 'client', 'host-alp-home', 'client-alp-home', 'paseo-home', 'project', 'logs'].map(name => [name, path.join(base, name)]));
for (const directory of Object.values(dirs)) await mkdir(directory, { recursive: true, mode: 0o700 });
const results = [];
function record(flow, status, detail = {}) {
  const line = { flow, ...detail, status };
  results.push(line);
  if (status === 'fail') process.exitCode = 1;
  console.log(JSON.stringify(line));
}
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: base, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}${result.error ?? ''}`);
  return result.stdout;
}
async function until(check, what, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await check()) return; await sleep(100); }
  throw new Error(`${what} never happened`);
}
const children = new Set();
function background(name, command, args, env) {
  const log = openSync(path.join(dirs.logs, `${name}.log`), 'a');
  const child = spawn(command, args, { cwd: base, env, stdio: ['ignore', log, log], detached: true });
  closeSync(log);
  children.add(child);
  return child;
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await Promise.race([exited, sleep(10_000)]);
  children.delete(child);
}

const hostEnv = { ...process.env, ALP_HOME: dirs['host-alp-home'] };
for (const key of Object.keys(hostEnv)) if (key.startsWith('ALP_') && key !== 'ALP_HOME' && key !== 'ALP_CODEX_BIN') delete hostEnv[key];
let alpCli;
let paseoClient;
const token = `BETA_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
try {
  // 1. Clean installs from the release tarballs.
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const tarballs = {};
  for (const location of manifest.workspaces) {
    const pkg = JSON.parse(await readFile(path.join(root, location, 'package.json'), 'utf8'));
    if (pkg.private) continue;
    const packed = JSON.parse(run('npm', ['pack', '--workspace', pkg.name, '--ignore-scripts', '--json', '--pack-destination', dirs.tarballs], { cwd: root }))[0];
    tarballs[pkg.name] = `file:${path.join(dirs.tarballs, packed.filename)}`;
  }
  const plugin = JSON.parse(await readFile(path.join(root, 'integrations/paseo/package.json'), 'utf8'));
  const hostDeps = Object.fromEntries(Object.entries(tarballs).filter(([name]) => name !== plugin.name));
  const clientDeps = { ...tarballs };
  for (const name of Object.keys(plugin.peerDependencies ?? {})) {
    if (name === 'react' || name === 'react-native') continue;
    clientDeps[name] = JSON.parse(await readFile(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  }
  for (const [directory, dependencies] of [[dirs.host, hostDeps], [dirs.client, clientDeps]]) {
    await writeFile(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies }));
    run('npm', ['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund'], { cwd: directory });
  }
  record('install.tarballs', 'pass', { tarballs: Object.values(tarballs).map(file => path.basename(file)) });

  // 2. The host: alpd with real Codex and the gateway, both from the host install.
  alpCli = path.join(dirs.host, 'node_modules/@anhlp/alp-cli/dist/cli.js');
  const gatewayCli = path.join(dirs.host, 'node_modules/@anhlp/alp-gateway/src/cli.js');
  const alp = (...args) => run(process.execPath, [alpCli, ...args], { env: hostEnv });
  await writeFile(path.join(dirs['host-alp-home'], 'settings.json'), JSON.stringify({ language: 'English' }));
  alp('init', dirs.project);
  // Phở's main on Codex with low effort, no supervisor: one real model, quick turns.
  await writeFile(path.join(dirs.project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false }, team: { pho: { main: { profiles: ['codex:gpt-5.6-sol'] } } }, runtime: { reasoning: 'low' } }));
  await writeFile(path.join(dirs.project, 'token.txt'), `${token}\n`);
  alp('daemon', 'start');
  const credential = JSON.parse(run(process.execPath, [gatewayCli, 'credential', 'create', '--label', 'paseo-beta', '--workspace', dirs.project, '--json'], { env: hostEnv }));
  assert.ok(credential.token);
  const gatewayPort = await freePort();
  let gateway;
  async function startGateway() {
    gateway = background('gateway', process.execPath, [gatewayCli, 'serve', '--port', String(gatewayPort)], hostEnv);
    await until(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/readyz`).catch(() => ({ status: 0 }))).status === 200, 'gateway ready');
  }
  await startGateway();
  const ticketWithoutToken = await fetch(`http://127.0.0.1:${gatewayPort}/v1/tickets`, { method: 'POST' });
  assert.equal(ticketWithoutToken.status, 401);
  record('host.start+auth', 'pass', { gateway: `http://127.0.0.1:${gatewayPort}`, ticketWithoutToken: ticketWithoutToken.status });

  // 3. The client: an isolated Paseo daemon with the plugin from its tarball, remote mode by env only.
  const paseoPort = await freePort();
  await writeFile(path.join(dirs['paseo-home'], 'config.json'), JSON.stringify({ version: 1, daemon: { listen: `127.0.0.1:${paseoPort}`, relay: { enabled: false }, mcp: { enabled: false } }, pluginsEnabled: true }, null, 2));
  const paseoEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ALP_HOME: dirs['client-alp-home'], ALP_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}`, ALP_GATEWAY_TOKEN: credential.token };
  const paseoDaemon = background('paseo', 'paseo', ['daemon', 'run', '--home', dirs['paseo-home']], paseoEnv);
  const url = `ws://127.0.0.1:${paseoPort}/ws`;
  await until(async () => (await fetch(`http://127.0.0.1:${paseoPort}/`).catch(() => undefined)) !== undefined, 'paseo daemon listening');
  run('paseo', ['plugin', 'install', path.join(dirs.client, 'node_modules', plugin.name), '--home', dirs['paseo-home'], '--json'], { env: paseoEnv });
  paseoClient = createPaseoClient({ url, clientId: `alp-remote-e2e-${Date.now()}` });
  await paseoClient.connect();
  let models;
  await until(async () => { models = await paseoClient.providers.listModels('alp', { cwd: dirs.project }); return !models.error && models.models?.length; }, 'ALP teams in Paseo', 60_000);
  const ids = models.models.map(model => model.id);
  assert.ok(ids.includes('pho'), JSON.stringify(ids));
  record('paseo.plugin+teams', 'pass', { teams: ids });

  // 4. Create, prompt with a tool call, stream.
  const agent = await paseoClient.agents.create({ config: { provider: 'alp/pho', modeId: 'full-access' }, cwd: dirs.project, title: 'ALP remote beta' });
  const streamed = [];
  const unsubscribe = agent.timeline.subscribe(event => streamed.push(event));
  await unsubscribe.ready?.catch(() => {});
  const first = await agent.run('Run the shell command `cat token.txt` in this project and reply with only what it printed.', { timeoutMs: 240_000 });
  assert.match(first.lastMessage ?? '', new RegExp(token), JSON.stringify(first));
  const kinds = streamed.map(event => event.event?.item?.type ?? event.event?.type).filter(Boolean);
  record('session.create+prompt+tool+stream', 'pass', { agentStatus: first.status, reply: first.lastMessage, streamedEvents: streamed.length, kinds: [...new Set(kinds)] });

  // 5. A question answered, then one dismissed.
  async function question(answer) {
    // run() resolves when the turn needs attention, so the answer is awaited with waitForFinish().
    await agent.send('Use the alp_ask tool once to ask me exactly "Proceed with the beta?" with options "yes" and "no". Then reply with only the answer you received, or DISMISSED if the question was dismissed.');
    let request;
    await until(async () => { await agent.refresh(); request = agent.pendingPermissions?.[0]; return !!request; }, 'question shown in Paseo', 180_000);
    await agent.respondToPermission(answer ? { requestId: request.id, response: { behavior: 'allow', updatedInput: { answers: { Answer: answer } } } } : { requestId: request.id, response: { behavior: 'deny', message: 'Not now' } });
    await until(async () => { await agent.refresh(); return !agent.pendingPermissions?.length; }, 'question resolved', 60_000);
    const result = await agent.waitForFinish(240_000);
    return { request: { name: request.name, kind: request.kind }, agentStatus: result.status, reply: result.lastMessage };
  }
  const allowed = await question('yes');
  assert.match(allowed.reply ?? '', /yes/i);
  record('question.allow', 'pass', allowed);
  const denied = await question(undefined);
  assert.doesNotMatch(denied.reply ?? '', /^yes$/i);
  record('question.deny', 'pass', denied);

  // 6. Cancel a running turn.
  await agent.send('Run the shell command `sleep 120` and then reply with SLEPT.');
  await until(async () => { await agent.refresh(); return agent.status === 'running'; }, 'turn running', 60_000);
  await sleep(3000);
  const canceledAt = Date.now();
  run('paseo', ['stop', agent.id, '--home', dirs['paseo-home'], '--json'], { env: paseoEnv });
  const afterCancel = await agent.waitForFinish(60_000);
  assert.ok(Date.now() - canceledAt < 60_000);
  assert.doesNotMatch(afterCancel.lastMessage ?? '', /SLEPT/);
  record('turn.cancel', 'pass', { agentStatus: afterCancel.status, ms: Date.now() - canceledAt });

  // 7. The gateway restarts in the middle of a turn: the plugin reconnects and the turn's end arrives once.
  const marker = `AFTER_${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const before = (await agent.timeline.refetch()).entries?.length ?? 0;
  await agent.send(`Run the shell command \`sleep 8\`, then reply with only ${marker}.`);
  await until(async () => { await agent.refresh(); return agent.status === 'running'; }, 'turn running', 60_000);
  await sleep(1500);
  await stop(gateway);
  await sleep(1500);
  await startGateway();
  const resumed = await agent.waitForFinish(240_000);
  assert.match(resumed.lastMessage ?? '', new RegExp(marker), JSON.stringify(resumed));
  const timeline = await agent.timeline.refetch();
  const texts = (timeline.entries ?? []).map(entry => JSON.stringify(entry.item ?? entry)).filter(text => text.includes(marker) && /assistant/.test(text));
  record('gateway.restart.mid-turn+replay', texts.length <= 1 ? 'pass' : 'fail', { agentStatus: resumed.status, markerMessages: texts.length, entriesBefore: before, entriesAfter: timeline.entries?.length });

  // 7b. The gateway goes down again right after it came back, while the plugin is attaching its
  // sessions again: it must keep them and reconnect once more.
  await stop(gateway);
  await startGateway();
  await sleep(150);
  await stop(gateway);
  await sleep(1500);
  await startGateway();
  const twice = await agent.run('Reply with only TWICE_OK.', { timeoutMs: 240_000 });
  assert.match(twice.lastMessage ?? '', /TWICE_OK/, JSON.stringify(twice));
  record('gateway.restart.twice', 'pass', { agentStatus: twice.status });

  // 8. alpd restarts: the session resumes on the next prompt.
  alp('daemon', 'stop');
  alp('daemon', 'start');
  await sleep(1500);
  const restarted = await agent.run('Reply with only RESTARTED_OK.', { timeoutMs: 240_000 });
  assert.match(restarted.lastMessage ?? '', /RESTARTED_OK/, JSON.stringify(restarted));
  record('alpd.restart+resume', 'pass', { agentStatus: restarted.status });

  // 9. Nothing on the client side, no token in a log.
  const clientHome = await readdir(dirs['client-alp-home']);
  const logs = await Promise.all((await readdir(dirs.logs)).map(file => readFile(path.join(dirs.logs, file), 'utf8')));
  const paseoLogs = await readdir(dirs['paseo-home']).then(files => Promise.all(files.filter(file => file.endsWith('.log')).map(file => readFile(path.join(dirs['paseo-home'], file), 'utf8'))));
  const leaked = [...logs, ...paseoLogs].some(text => text.includes(credential.token));
  assert.deepEqual(clientHome, []);
  assert.equal(leaked, false);
  record('isolation+secrets', 'pass', { clientAlpHome: clientHome, tokenInLogs: leaked });
  unsubscribe?.();
  await agent.archive().catch(() => {});
  await stop(paseoDaemon);
} catch (error) {
  record('run', 'fail', { error: String(error?.stack ?? error) });
  process.exitCode = 1;
} finally {
  await paseoClient?.close().catch(() => {});
  for (const child of children) await stop(child);
  if (alpCli) spawnSync(process.execPath, [alpCli, 'daemon', 'stop'], { env: hostEnv, stdio: 'ignore', timeout: 20_000 });
  await writeFile(path.join(base, 'evidence.json'), JSON.stringify(results, null, 2)).catch(() => {});
  if (keep || process.exitCode) console.log(JSON.stringify({ kept: base }));
  else await rm(base, { recursive: true, force: true });
}
