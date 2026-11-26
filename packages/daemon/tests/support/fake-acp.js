#!/usr/bin/env node
// A stand-in ACP agent (Agent Client Protocol over stdio) for the bundle smoke (scripts/binary-smoke.ts,
// t-81b0.9). On session/new it starts the MCP bridge alpd hands it (the `node -e` bridge, so this proves
// the native alpd names a Node that evaluates it), asks it for alpd's tools, and on each prompt answers
// with what it found: `bridge <command> tools <names>`, or `bridge failed: <reason>`.
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const send = value => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
let report = 'bridge not started';

/** Starts the bridge server, sends MCP initialize and tools/list, resolves the tool names. */
function probe(server) {
  return new Promise(resolve => {
    const env = { ...process.env, ...Object.fromEntries((server.env ?? []).map(({ name, value }) => [name, value])) };
    const child = spawn(server.command, server.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => { child.kill(); resolve(`bridge failed: no answer (${stderr.trim().slice(0, 200)})`); }, 15_000);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); resolve(`bridge failed: ${error.message}`); });
    readline.createInterface({ input: child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id === 1) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
      if (message.id === 2) {
        clearTimeout(timer);
        child.kill();
        resolve(`bridge ${server.command} tools ${(message.result?.tools ?? []).map(tool => tool.name).join(',')}`);
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-acp', version: '1' } } })}\n`);
  });
}

readline.createInterface({ input: process.stdin }).on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id === undefined || !message.method) return;
  const { id, method, params } = message;
  if (method === 'initialize') return send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
  if (method === 'session/new') {
    const server = (params.mcpServers ?? []).find(entry => entry.name === 'alp');
    report = server ? await probe(server) : 'bridge failed: alpd passed no alp MCP server';
    return send({ id, result: { sessionId: `fake-acp-${Date.now()}` } });
  }
  if (method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: report } } } });
    return send({ id, result: { stopReason: 'end_turn' } });
  }
  send({ id, error: { code: -32601, message: `fake-acp: ${method} is not supported` } });
});
