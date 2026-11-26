import path from 'node:path';
import { AlpError } from '@anhlp/alp-core/errors';
import { getEntry } from '@anhlp/alp-core/library-edit';
import { runHook, samplePayload } from '@anhlp/alp-core/hook-run';
import { normalizeMcp } from '@anhlp/alp-core/validation';
import { probeMcp } from './mcp-probe.ts';
import { probeAcp } from './acp-probe.ts';
import { probeAntigravity } from './antigravity-probe.ts';
import { loadProvider } from '@anhlp/alp-core/providers';
import type { McpServer } from './mcp-probe.ts';

/** A library hook as testEntry runs it: the fields of a hook entry it reads. */
type LibraryHook = { event: string, command: string, timeoutSec?: number, match?: { agent?: string }, blocking?: boolean };

/**
 * Tries an MCP server, a hook or an ACP provider out (ALPD §43, §46). An MCP server is
 * started and its tools listed; a provider is started and initialized; a hook runs once with a sample payload for its event, in the project (or the
 * library when there is none), with the variables ALP gives hooks.
 */
export async function testEntry(kind: string, name: string, { root, library, templates, scope, timeoutMs }: { root?: string, library?: string, templates?: Record<string, string>, scope?: string, timeoutMs?: number } = {}) {
  const entry = await getEntry(kind as Parameters<typeof getEntry>[0], name, { root, library, templates, scope } as Parameters<typeof getEntry>[2]);
  const home = entry.source === 'project' ? path.join(path.resolve(root!), '.alp') : library;
  if (kind === 'mcp') {
    const server = normalizeMcp({ mcpServers: { [name]: entry.content.server } }, path.join(home!, 'mcp'), `${name}.json`).mcpServers[name] as McpServer;
    const result = await probeMcp(server, { cwd: root ? path.resolve(root) : library, ...(timeoutMs ? { timeoutMs } : {}) });
    return { kind, name, source: entry.source, ok: true, ...result };
  }
  if (kind === 'hooks') {
    const hook = entry.content.hook as LibraryHook;
    const project = root ? path.resolve(root) : undefined;
    const payload = samplePayload(hook.event, { project, agent: hook.match?.agent ?? 'main' });
    const env = { ALP_EVENT: hook.event, ALP_SESSION: payload.session, ALP_AGENT: payload.agent, ALP_PROJECT: project ?? '', ALP_TASK: payload.task ?? '' };
    const result = await runHook(hook, payload, { cwd: project ?? library, env, ...(timeoutMs ? { timeoutMs } : {}) });
    const ok = result.exitCode === 0 && !result.timedOut;
    return { kind, name, source: entry.source, ok, ...(hook.blocking && !ok ? { wouldBlock: true } : {}), payload, ...result };
  }
  if (kind === 'providers') {
    const provider = (await loadProvider(library, name))!;
    const result = provider.kind === 'antigravity'
      ? await probeAntigravity(provider, { cwd: root ? path.resolve(root) : library, ...(timeoutMs ? { timeoutMs } : {}) })
      : await probeAcp(provider, { cwd: root ? path.resolve(root) : library, ...(timeoutMs ? { timeoutMs } : {}) });
    return { kind, name, source: entry.source, ok: true, ...result };
  }
  throw new AlpError('INVALID_KIND', `Only mcp servers, hooks and providers can be tested, not ${kind}`);
}
