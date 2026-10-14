import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

type Tool = { name: string; description: string; inputSchema: unknown };
type Server = { command?: string; args?: string[]; env?: Record<string, string>; cwd?: string; url?: string; http_headers?: Record<string, string> };

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
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
          const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 20_000, signal });
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
