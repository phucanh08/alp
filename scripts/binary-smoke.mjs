#!/usr/bin/env node
// Smoke test of the ALP executable (t-1e02), in a throwaway ALP_HOME: init, daemon start/status,
// alp web (HTTP, token gate, ticket, WebSocket), a terminal through the extracted native helper,
// a provider turn with the fake Codex, the ACP bridge subcommand, and daemon stop.
//
//   node scripts/binary-smoke.mjs [path/to/alp]   (default dist/bin/alp; build it with scripts/build-binary.mjs)
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { AlpRpcClient, hello } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';

const ROOT = path.resolve(import.meta.dirname, '..');
const binary = path.resolve(process.argv[2] ?? path.join(ROOT, 'dist/bin', process.platform === 'win32' ? 'alp.exe' : 'alp'));
if (!existsSync(binary)) throw new Error(`${binary} is missing; build it with node scripts/build-binary.mjs`);
const log = message => console.log(`[binary-smoke] ${message}`);
const run = promisify(execFile);
const work = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-binary-smoke-')));
const home = path.join(work, 'home');
const env = { ...process.env, ALP_HOME: home, SHELL: '/bin/sh', ALP_CODEX_BIN: path.join(ROOT, 'packages/daemon/tests/support/fake-codex.js'), ALP_DAEMON_ENTRY: '', ALP_WEB_APP: '' };
delete env.ALP_DAEMON_ENTRY; delete env.ALP_WEB_APP;
const alp = async (args, cwd = work) => (await run(binary, args, { env, cwd, timeout: 60_000 })).stdout.trim();
const check = (condition, message) => { if (!condition) throw new Error(message); log(`ok: ${message}`); };

try {
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ web: { permissions: ['terminal.exec'] } }));
  check(/^\d+\.\d+\.\d+/.test(await alp(['--version'])), 'alp --version');
  const project = path.join(work, 'project');
  await mkdir(project);
  await alp(['init', project]);
  check(existsSync(path.join(project, '.alp', 'ALP.md')) || existsSync(path.join(project, 'ALP.md')), 'alp init writes the embedded templates');
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  await alp(['terminal', 'allow', '--yes']);
  check(/running \(pid \d+\)/.test(await alp(['daemon', 'start'])), 'alp daemon start (detached alpd from the executable)');
  check((await alp(['daemon', 'status'])).includes('ready'), 'alp daemon status');
  const record = JSON.parse(await readFile(path.join(home, 'alpd.json'), 'utf8'));
  check(record.entry === binary, `the install record names the executable (${record.entry})`);
  const url = await alp(['web', '--print'], project);
  const token = url.split('#token=')[1];
  const base = url.replace(/\/#.*$/, '');
  check((await fetch(base)).status === 200, 'alp web serves the embedded app over HTTP');
  check((await fetch(`${base}/v1/tickets`, { method: 'POST' })).status === 401, 'a ticket without a token is refused');
  check((await fetch(`${base}/v1/tickets`, { method: 'POST', headers: { authorization: 'Bearer alpgw1.x.y' } })).status === 401, 'a ticket with a wrong token is refused');
  const ticket = await (await fetch(`${base}/v1/tickets`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json();
  const client = new AlpRpcClient(await connectWebSocket(base.replace(/^http/, 'ws') + ticket.websocket, { WebSocket, protocols: ticket.subprotocols }));
  try {
    const greeting = await hello(client, { name: 'binary-smoke', version: '0' });
    check(greeting.capabilities.includes('terminal.watch'), 'WebSocket upgrade and hello through the gateway');
    const events = [], output = [];
    client.onEvent(envelope => events.push(envelope.event.type));
    client.onNotification((method, event) => { if (method === 'terminal.event' && event.type === 'output') output.push(event.data); });
    if (process.platform !== 'win32') {
      const { workspaces } = await client.request('workspace.list', {});
      const workspace = workspaces.find(row => row.directory === project || row.canonical === project);
      const { terminal } = await client.request('terminal.create', { workspaceId: workspace.id, cols: 80, rows: 24, requestId: 'smoke' });
      await client.request('terminal.attach', { terminalId: terminal.terminalId });
      await client.request('terminal.input', { terminalId: terminal.terminalId, data: 'echo SMOKE-$((19*19))\r' });
      for (let i = 0; !output.join('').includes('SMOKE-361') && i < 400; i++) await new Promise(resolve => setTimeout(resolve, 25));
      check(output.join('').includes('SMOKE-361'), 'a terminal through the extracted native helper');
      await client.request('terminal.close', { terminalId: terminal.terminalId });
      check(existsSync(path.join(home, 'cache', record.version, 'terminal-native')), 'the native helper was extracted to <ALP_HOME>/cache/<version>');
    }
    const { session } = await client.request('session.create', { spec: { cwd: project, model: 'codex:gpt-5.6-sol' }, history: 'skip' });
    await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'smoke-1', content: [{ type: 'text', text: 'hello' }] });
    for (let i = 0; !events.includes('turn.ended') && i < 400; i++) await new Promise(resolve => setTimeout(resolve, 25));
    check(events.includes('turn.ended'), 'a provider turn with the fake Codex');
  } finally { client.close(); }

  // alp bridge acp: speaks MCP on stdio to alpd's bridge socket; here a stand-in socket that accepts the token.
  if (process.platform !== 'win32') {
    const socket = path.join(work, 'bridge.sock');
    const server = net.createServer(connection => connection.on('data', () => {}));
    await new Promise(resolve => server.listen(socket, resolve));
    const bridge = spawn(binary, ['bridge', 'acp'], { env: { ...env, ALP_BRIDGE_SOCKET: socket, ALP_BRIDGE_TOKEN: 't' }, stdio: ['pipe', 'pipe', 'inherit'] });
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    const reply = await new Promise((resolve, reject) => { bridge.stdout.once('data', chunk => resolve(String(chunk))); setTimeout(() => reject(new Error('alp bridge acp did not answer')), 10_000); });
    check(JSON.parse(reply).result?.serverInfo?.name === 'alp', 'alp bridge acp answers initialize');
    bridge.kill(); server.close();
  }
  const refused = await run(binary, [path.join(ROOT, 'packages/daemon/tests/support/fake-codex.js')], { env, timeout: 20_000 }).then(() => 0, error => error.code);
  check(refused === 2, 'the executable refuses a script path instead of re-entering itself');
  check((await alp(['daemon', 'stop'])).includes('stopped'), 'alp daemon stop');
  log('ok');
} finally {
  const web = await readFile(path.join(home, 'web.json'), 'utf8').then(text => JSON.parse(text).pid, () => undefined);
  if (web) try { process.kill(web, 'SIGTERM'); } catch {}
  await run(binary, ['daemon', 'stop'], { env, timeout: 20_000 }).catch(() => {});
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
