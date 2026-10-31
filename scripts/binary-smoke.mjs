#!/usr/bin/env node
// Smoke test of the ALP bundle (t-1807), in a throwaway ALP_HOME, run by the bundle's own Node:
// its launcher, init, daemon start/status, alp web (HTTP, token gate, ticket, WebSocket), a terminal
// (the native helper; node-pty on Windows), provider turns with the fake Codex and the fake Claude
// (the Claude Agent SDK from the bundle's node_modules), the ACP bridge subcommand, and daemon stop.
//
//   node scripts/binary-smoke.mjs [dist/bundle/alp-<version>-<platform>]   (build it with scripts/build-bundle.mjs)
import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import WebSocket from 'ws';
import { AlpRpcClient, hello } from '@anhlp/alp-client/portable';
import { connectWebSocket } from '@anhlp/alp-client/websocket';

import { bundleCommand } from '../packages/cli/src/self-update.js';
import { hostPlatform } from './build-bundle.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const version = JSON.parse(await readFile(path.join(ROOT, 'packages/cli/package.json'), 'utf8')).version;
const bundle = await realpath(path.resolve(process.argv[2] ?? path.join(ROOT, 'dist/bundle', `alp-${version}-${hostPlatform()}`))).catch(() => undefined);
if (!bundle || !existsSync(path.join(bundle, 'alp-bundle.json'))) throw new Error(`${process.argv[2] ?? 'dist/bundle'} is not a built bundle; build it with node scripts/build-bundle.mjs`);
const windows = process.platform === 'win32';
const launcher = path.join(bundle, 'bin', windows ? 'alp.cmd' : 'alp');
// The bundle's own Node and CLI (bin/alp runs exactly this); Windows starts alp.cmd only through a shell.
const { command: node, args: cliArgs } = bundleCommand(bundle);
const alpd = path.join(bundle, 'lib/node_modules/@anhlp/alp-cli/dist/alpd.js');
const log = message => console.log(`[binary-smoke] ${message}`);
const run = promisify(execFile);
const work = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-binary-smoke-')));
const home = path.join(work, 'home');
const env = { ...process.env, ALP_HOME: home, SHELL: '/bin/sh', ALP_CODEX_BIN: path.join(ROOT, 'packages/daemon/tests/support/fake-codex.js'), ALP_CLAUDE_BIN: path.join(ROOT, 'packages/daemon/tests/support/fake-claude.js'), ALP_DAEMON_ENTRY: '', ALP_WEB_APP: '' };
delete env.ALP_DAEMON_ENTRY; delete env.ALP_WEB_APP;
const alp = async (args, cwd = work) => (await run(node, [...cliArgs, ...args], { env, cwd, timeout: 60_000 })).stdout.trim();
const check = (condition, message) => { if (!condition) throw new Error(message); log(`ok: ${message}`); };

try {
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ web: { permissions: ['terminal.exec'] } }));
  check(await alp(['--version']) === version, 'alp --version');
  check((await run(launcher, ['--version'], { env, timeout: 60_000, shell: windows })).stdout.trim() === version, 'the launcher runs the bundle');
  if (!windows) {
    // ~/.alp/bin/alp is a symlink to the launcher: it must still find its bundle.
    const link = path.join(work, 'alp-link');
    await symlink(launcher, link);
    check((await run(link, ['--version'], { env, timeout: 60_000 })).stdout.trim() === version, 'the launcher reached through a symlink');
  }
  const sdk = readdirSync(path.join(bundle, 'lib/node_modules/@anthropic-ai'));
  check(sdk.includes('claude-agent-sdk') && !sdk.some(name => name.startsWith('claude-agent-sdk-')), `the Claude Agent SDK is bundled without its native claude (${sdk.join(', ')})`);
  const { findDaemonEntry } = await import('@anhlp/alp-client/index');
  check(await findDaemonEntry({ home: path.join(work, 'none'), env: { PATH: path.join(bundle, 'bin') } }) === alpd, 'discovery finds alpd.js behind the launcher on PATH');
  const project = path.join(work, 'project');
  await mkdir(project);
  await alp(['init', project]);
  check(existsSync(path.join(project, '.alp', 'ALP.md')) || existsSync(path.join(project, 'ALP.md')), 'alp init writes its templates');
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  await alp(['terminal', 'allow', '--yes']);
  check(/running \(pid \d+\)/.test(await alp(['daemon', 'start'])), 'alp daemon start (detached alpd under the bundled Node)');
  check((await alp(['daemon', 'status'])).includes('ready'), 'alp daemon status');
  const record = JSON.parse(await readFile(path.join(home, 'alpd.json'), 'utf8'));
  check(record.entry === alpd, `the install record names the bundle's alpd.js (${record.entry})`);
  const url = await alp(['web', '--print'], project);
  const token = url.split('#token=')[1];
  const base = url.replace(/\/#.*$/, '');
  check((await fetch(base)).status === 200, 'alp web serves its app over HTTP');
  check((await fetch(`${base}/v1/tickets`, { method: 'POST' })).status === 401, 'a ticket without a token is refused');
  check((await fetch(`${base}/v1/tickets`, { method: 'POST', headers: { authorization: 'Bearer alpgw1.x.y' } })).status === 401, 'a ticket with a wrong token is refused');
  const ticket = await (await fetch(`${base}/v1/tickets`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json();
  const client = new AlpRpcClient(await connectWebSocket(base.replace(/^http/, 'ws') + ticket.websocket, { WebSocket, protocols: ticket.subprotocols }));
  try {
    const greeting = await hello(client, { name: 'binary-smoke', version: '0' });
    check(greeting.capabilities.includes('terminal.watch'), 'WebSocket upgrade and hello through the gateway');
    const events = [], output = [], payloads = [];
    client.onEvent(envelope => { events.push(envelope.event.type); payloads.push(JSON.stringify(envelope.event)); });
    const exits = [];
    client.onNotification((method, event) => {
      if (method === 'terminal.event' && event.type === 'output') output.push(event.data);
      if (method === 'terminal.event' && event.type === 'exit') exits.push(event);
    });
    {
      // POSIX: the native helper running /bin/sh. Windows: node-pty (ConPTY) running cmd.exe.
      const { workspaces } = await client.request('workspace.list', {});
      const workspace = workspaces.find(row => row.directory === project || row.canonical === project || row.directory?.toLowerCase() === project.toLowerCase());
      const { terminal } = await client.request('terminal.create', { workspaceId: workspace.id, cols: 80, rows: 24, requestId: 'smoke' });
      await client.request('terminal.attach', { terminalId: terminal.terminalId });
      // The typed line echoes back too, so the expected text is one the input does not contain.
      const [input, expected] = windows ? ['set /a 19*19+1000\r', '1361'] : ['echo SMOKE-$((19*19))\r', 'SMOKE-361'];
      // Type only once the shell shows its prompt (cmd.exe may drop input sent while ConPTY starts), then retry.
      const prompt = windows ? />\s*(\u001b\][^\u0007]*\u0007)?(\u001b\[\?25h)?\s*$/ : /./;
      for (let i = 0; !prompt.test(output.join('')) && i < 400; i++) await new Promise(resolve => setTimeout(resolve, 25));
      for (let attempt = 0; attempt < 3 && !output.join('').includes(expected); attempt++) {
        await client.request('terminal.input', { terminalId: terminal.terminalId, data: input });
        for (let i = 0; !output.join('').includes(expected) && i < 300; i++) await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (!output.join('').includes(expected)) log(`terminal output so far (${output.length} chunks): ${JSON.stringify(output.join('').slice(-2000))}`);
      check(output.join('').includes(expected), windows ? 'a terminal through node-pty (ConPTY)' : 'a terminal through the native helper');
      await client.request('terminal.close', { terminalId: terminal.terminalId });
      for (let i = 0; exits.length === 0 && i < 400; i++) await new Promise(resolve => setTimeout(resolve, 25));
      check(exits.length > 0, 'the terminal ended on close');
    }
    const { session } = await client.request('session.create', { spec: { cwd: project, model: 'codex:gpt-5.6-sol' }, history: 'skip' });
    await client.request('session.prompt', { sessionId: session.id, clientMessageId: 'smoke-1', content: [{ type: 'text', text: 'hello' }] });
    for (let i = 0; !events.includes('turn.ended') && i < 400; i++) await new Promise(resolve => setTimeout(resolve, 25));
    check(events.includes('turn.ended'), 'a provider turn with the fake Codex');
    // beta.5 regression: the Claude transport must load the Claude Agent SDK (here from the bundle's node_modules).
    events.length = 0;
    const claude = await client.request('session.create', { spec: { cwd: project, model: 'claude:claude-opus-5-5' }, history: 'skip' });
    await client.request('session.prompt', { sessionId: claude.session.id, clientMessageId: 'smoke-2', content: [{ type: 'text', text: 'hello' }] });
    for (let i = 0; !events.includes('turn.ended') && i < 400; i++) await new Promise(resolve => setTimeout(resolve, 25));
    check(events.includes('turn.ended') && payloads.some(text => text.includes('ok 1: hello')), 'a provider turn with the fake Claude through the bundled Claude Agent SDK');
  } finally { client.close(); }

  // alp bridge acp: speaks MCP on stdio to alpd's bridge socket; here a stand-in socket that accepts the token.
  if (process.platform !== 'win32') {
    const socket = path.join(work, 'bridge.sock');
    const server = net.createServer(connection => connection.on('data', () => {}));
    await new Promise(resolve => server.listen(socket, resolve));
    const bridge = spawn(node, [...cliArgs, 'bridge', 'acp'], { env: { ...env, ALP_BRIDGE_SOCKET: socket, ALP_BRIDGE_TOKEN: 't' }, stdio: ['pipe', 'pipe', 'inherit'] });
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    const reply = await new Promise((resolve, reject) => { bridge.stdout.once('data', chunk => resolve(String(chunk))); setTimeout(() => reject(new Error('alp bridge acp did not answer')), 10_000); });
    check(JSON.parse(reply).result?.serverInfo?.name === 'alp', 'alp bridge acp answers initialize');
    bridge.kill(); server.close();
  }
  check((await alp(['daemon', 'stop'])).includes('stopped'), 'alp daemon stop');
  log('ok');
} finally {
  const web = await readFile(path.join(home, 'web.json'), 'utf8').then(text => JSON.parse(text).pid, () => undefined);
  if (web) try { process.kill(web, 'SIGTERM'); } catch {}
  await run(node, [...cliArgs, 'daemon', 'stop'], { env, timeout: 20_000 }).catch(() => {});
  await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
