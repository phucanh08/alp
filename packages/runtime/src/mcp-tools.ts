import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { inputLimitError, type InputLimits } from './input-limits.js';

type Tool = { name: string; description: string; inputSchema: unknown };
type Server = { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; http_headers?: Record<string, string> };

/** What one external MCP server may list: pages of tools/list, and tools over all of them. */
export const MCP_TOOLS = { pages: 20, tools: 500 };
/** One tools/list result, checked before the MCP SDK parses it with ListToolsResultSchema. */
export const MCP_TOOLS_PAGE: InputLimits = { bytes: 4 * 1024 * 1024, items: 100_000, depth: 32, string: 64 * 1024 };

/** Turns an oversized tools/list result into an error response before the client parses it.
 * Called after connect, which installs the client's own onmessage. */
function limitToolPages(transport: Wire) {
  const listing = new Set<string | number>();
  const send = transport.send.bind(transport);
  transport.send = (message, ...rest) => {
    if ('method' in message && message.method === 'tools/list' && 'id' in message) listing.add(message.id);
    return send(message, ...rest);
  };
  const deliver = transport.onmessage;
  transport.onmessage = (message, ...rest) => {
    if ('id' in message && 'result' in message && listing.delete(message.id)) {
      const error = inputLimitError(message.result, MCP_TOOLS_PAGE, 'A tools/list page');
      if (error) return deliver?.({ jsonrpc: '2.0', id: message.id, error: { code: -32600, message: error } }, ...rest);
    }
    deliver?.(message, ...rest);
  };
}
type Message = Parameters<StdioClientTransport['send']>[0];
type Wire = { send(message: Message, ...rest: unknown[]): Promise<void>; onmessage?(message: Message, ...rest: unknown[]): void };

/** Client.connect starts cleanup without awaiting it on initialization failure.
 * Keep that promise so session shutdown waits for the same process cleanup.
 */
class SessionClient extends Client {
  private stopping?: Promise<void>;
  override close(): Promise<void> { return this.stopping ??= super.close(); }
}

/** Session-owned MCP clients. Only tool aliases cross the agy bridge; no server
 * command, URL, environment or authorization header is persisted in agy's config.
 */
export async function openMcpTools(servers: Record<string, Server>, cwd: string, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const clients: Client[] = [];
  const tools: Tool[] = [];
  const routes = new Map<string, { client: Client; name: string }>();
  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.allSettled(clients.map(client => client.close())).then(() => {});
  try {
    for (const [name, server] of Object.entries(servers)) {
      signal?.throwIfAborted();
      const client = new SessionClient({ name: 'alp-agy', version: '1' }, { capabilities: {} });
      clients.push(client);
      const transport = server.url
        ? new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers: server.http_headers ?? {} } })
        : new StdioClientTransport({
          command: server.command!, args: server.args ?? [], cwd: server.cwd ?? cwd,
          env: Object.fromEntries(Object.entries({ ...env, ...server.env }).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          stderr: 'ignore',
        });
      try {
        await client.connect(transport, { timeout: 20_000, signal });
        if (!client.getServerCapabilities()?.tools) continue;
        limitToolPages(transport);
        let cursor: string | undefined;
        const seen = new Set<string>();
        let listed = 0;
        do {
          if (seen.size >= MCP_TOOLS.pages) throw new Error(`More than ${MCP_TOOLS.pages} pages of MCP tools`);
          const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 20_000, signal });
          listed += page.tools.length;
          if (listed > MCP_TOOLS.tools) throw new Error(`More than ${MCP_TOOLS.tools} MCP tools`);
          for (const tool of page.tools) {
            const hash = createHash('sha256').update(JSON.stringify([name, tool.name])).digest('hex').slice(0, 10);
            const clean = (value: string, length: number) => value.replace(/[^\w-]/g, '_').slice(0, length);
            const alias = `mcp__${clean(name, 16)}__${clean(tool.name, 24)}_${hash}`;
            if (routes.has(alias)) throw new Error('Duplicate external MCP tool');
            routes.set(alias, { client, name: tool.name });
            tools.push({ name: alias, description: `[MCP ${name}: ${tool.name}] ${tool.description ?? ''}`, inputSchema: tool.inputSchema });
          }
          cursor = page.nextCursor;
          if (cursor && seen.has(cursor)) throw new Error('Repeated MCP tools cursor');
          if (cursor) seen.add(cursor);
        } while (cursor);
      } catch (error) {
        // Name the failing server without echoing its URL, headers or environment.
        throw new Error(`External MCP server '${name}' could not initialize or list tools`, { cause: error });
      }
    }
    return {
      tools,
      has: (name: string) => routes.has(name),
      async call(name: string, args: Record<string, unknown>) {
        const route = routes.get(name);
        if (!route) throw new Error('Unknown external MCP tool');
        return route.client.callTool({ name: route.name, arguments: args }, undefined, { timeout: 60_000 });
      },
      close,
    };
  } catch (error) { await close(); throw error; }
}
