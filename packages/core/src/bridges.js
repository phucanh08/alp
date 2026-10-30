import { createRequire } from 'node:module';
import { isExecutableName, isPackaged, isSelf, ROLE_ARGS } from './packaged.js';

/**
 * The stdio MCP bridges an agent CLI starts to reach alpd's tools (ACP agents and Antigravity).
 * Under Node they run as `node -e <source>`; the ALP executable cannot evaluate `-e`, so it runs
 * them as `alp bridge acp|antigravity`, which calls runBridge (t-1e02).
 */

export const ACP_BRIDGE = `
const net = require('node:net');
const readline = require('node:readline');
const socket = net.connect(process.env.ALP_BRIDGE_SOCKET);
const waiting = new Map();
let sequence = 0;
let buffer = '';
socket.setEncoding('utf8');
socket.write(JSON.stringify({ token: process.env.ALP_BRIDGE_TOKEN }) + '\\n');
socket.on('data', data => {
  buffer += data;
  for (let index; (index = buffer.indexOf('\\n')) >= 0;) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    try { const message = JSON.parse(line); const waiter = waiting.get(message.id); if (waiter) { waiting.delete(message.id); waiter(message); } } catch {}
  }
});
socket.on('close', () => process.exit(0));
socket.on('error', () => process.exit(1));
const ask = message => new Promise(resolve => { const id = ++sequence; waiting.set(id, resolve); socket.write(JSON.stringify({ ...message, id }) + '\\n'); });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || message.id === null) return;
  try {
    if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'alp', version: '1' } } });
    if (message.method === 'ping') return send({ id: message.id, result: {} });
    if (message.method === 'tools/list') { const reply = await ask({ op: 'list' }); return send({ id: message.id, result: { tools: reply.tools } }); }
    if (message.method === 'tools/call') { const reply = await ask({ op: 'call', name: message.params.name, arguments: message.params.arguments || {} }); return send({ id: message.id, result: reply.result }); }
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  } catch (error) { send({ id: message.id, error: { code: -32603, message: String((error && error.message) || error) } }); }
});
process.stdin.on('end', () => process.exit(0));
`;

export const ANTIGRAVITY_BRIDGE = `// ALP Antigravity bridge v1

const net = require('node:net');
const readline = require('node:readline');
const socket = process.env.ALP_BRIDGE_SOCKET ? net.connect(process.env.ALP_BRIDGE_SOCKET) : null;
const waiting = new Map();
let sequence = 0;
let buffer = '';
socket?.setEncoding('utf8');
socket?.write(JSON.stringify({ token: process.env.ALP_BRIDGE_TOKEN }) + '\\n');
socket?.on('data', data => {
  buffer += data;
  for (let index; (index = buffer.indexOf('\\n')) >= 0;) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    try { const message = JSON.parse(line); const waiter = waiting.get(message.id); if (waiter) { waiting.delete(message.id); waiter(message); } } catch {}
  }
});
socket?.on('close', () => process.exit(0));
socket?.on('error', () => process.exit(1));
const ask = message => !socket ? Promise.resolve({ tools: [], result: { content: [{ type: 'text', text: 'No ALP session' }], isError: true } }) : new Promise(resolve => { const id = ++sequence; waiting.set(id, resolve); socket.write(JSON.stringify({ ...message, id }) + '\\n'); });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
readline.createInterface({ input: process.stdin }).on('line', async line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || message.id === null) return;
  try {
    if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: (message.params && message.params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'alp', version: '1' } } });
    if (message.method === 'ping') return send({ id: message.id, result: {} });
    if (message.method === 'tools/list') { const reply = await ask({ op: 'list' }); return send({ id: message.id, result: { tools: reply.tools } }); }
    if (message.method === 'tools/call') { const reply = await ask({ op: 'call', name: message.params.name, arguments: message.params.arguments || {} }); return send({ id: message.id, result: reply.result }); }
    send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
  } catch (error) { send({ id: message.id, error: { code: -32603, message: String((error && error.message) || error) } }); }
});
process.stdin.on('end', () => process.exit(0));
`;

const BRIDGES = { acp: ACP_BRIDGE, antigravity: ANTIGRAVITY_BRIDGE };

/** Runs a bridge in this process, as `node -e` would. @param {string} kind */
export function runBridge(kind) {
  const source = Object.hasOwn(BRIDGES, kind) ? BRIDGES[/** @type {'acp' | 'antigravity'} */ (kind)] : undefined;
  if (!source) throw new Error(`Unknown bridge: ${kind}; expected acp or antigravity`);
  // eslint-disable-next-line no-new-func
  new Function('require', source)(createRequire(import.meta.url));
}

/**
 * The command an agent CLI runs to start a bridge: `node -e <source>` under Node, the executable's
 * `bridge <kind>` subcommand when packaged.
 * @param {'acp' | 'antigravity'} kind
 * @returns {{ command: string, args: string[] }}
 */
export function bridgeCommand(kind) {
  if (!Object.hasOwn(BRIDGES, kind)) throw new Error(`Unknown bridge: ${kind}; expected acp or antigravity`);
  if (isPackaged()) return { command: process.execPath, args: [...ROLE_ARGS[kind === 'acp' ? 'bridge-acp' : 'bridge-antigravity']] };
  return { command: process.execPath, args: ['-e', BRIDGES[kind]] };
}

/**
 * Whether an MCP server entry is one of ALP's bridge launchers: the `-e` source, or the ALP
 * executable's `bridge <kind>` (only when its command is named alp, so another server is kept).
 * @param {'acp' | 'antigravity'} kind
 * @param {unknown} args
 * @param {unknown} [command]
 */
export function isBridgeArgs(kind, args, command = undefined) {
  if (!Array.isArray(args)) return false;
  const marker = kind === 'antigravity' ? '// ALP Antigravity bridge v1' : undefined;
  if (marker && args.some(arg => typeof arg === 'string' && arg.startsWith(marker))) return true;
  return typeof command === 'string' && (isExecutableName(command) || isSelf(command)) && args.length === 2 && args[0] === 'bridge' && args[1] === kind;
}
