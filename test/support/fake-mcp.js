#!/usr/bin/env node
// A scripted stdio MCP server: answers initialize and lists its tools over two pages.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

const pages = [[{ name: 'search', description: 'Search the docs', inputSchema: { type: 'object' } }], [{ name: 'fetch', inputSchema: { type: 'object' } }]];
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
if (process.env.FAKE_MCP_FAIL) { console.error('fake-mcp: cannot start'); process.exit(4); }
if (process.env.FAKE_MCP_PID_FILE) writeFileSync(process.env.FAKE_MCP_PID_FILE, String(process.pid));
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize' && process.env.FAKE_MCP_HANG_INITIALIZE) return;
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1.2.3' } } });
  else if (message.method === 'tools/list') {
    const page = Number(message.params?.cursor ?? 0);
    // Oversized listings: a cursor that never ends, too many tools, or one page too large.
    if (process.env.FAKE_MCP_ENDLESS) return send({ id: message.id, result: { tools: [{ name: `tool${page}`, inputSchema: { type: 'object' } }], nextCursor: String(page + 1) } });
    if (process.env.FAKE_MCP_TOOLS) return send({ id: message.id, result: { tools: Array.from({ length: Number(process.env.FAKE_MCP_TOOLS) }, (_, i) => ({ name: `tool${i}`, inputSchema: { type: 'object' } })) } });
    if (process.env.FAKE_MCP_DESCRIPTION) return send({ id: message.id, result: { tools: [{ name: 'big', description: 'x'.repeat(Number(process.env.FAKE_MCP_DESCRIPTION)), inputSchema: { type: 'object' } }] } });
    send({ id: message.id, result: { tools: pages[page], ...(page + 1 < pages.length ? { nextCursor: String(page + 1) } : {}) } });
  } else if (message.method === 'tools/call') send({ id: message.id, result: { content: [{ type: 'text', text: JSON.stringify({ server: process.env.FAKE_MCP_LABEL ?? 'fake', tool: message.params.name, arguments: message.params.arguments, cwd: process.cwd() }) }] } });
  else send({ id: message.id, error: { code: -32601, message: `no ${message.method}` } });
});
