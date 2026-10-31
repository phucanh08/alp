import type { PluginAgentCommandContext, PluginClientContext } from '@getpaseo/plugin/client';
import { agentCompact } from '../shared/compact';

/**
 * Compact context for an ALP agent (t-de1a): main writes a checkpoint, then its context is compacted
 * natively or replaced by a fresh conversation seeded with it, now or at the end of its turn. The
 * runtime's own notice in the timeline says when it starts and ends; a refusal is thrown to the host.
 */
export async function compactAgent({ agent, paseo, rpc }: Pick<PluginAgentCommandContext, 'agent' | 'paseo' | 'rpc'>) {
  if (agent.provider !== 'alp') throw new Error('Compact context is for ALP agents only');
  // The provider knows a session by the id in its persistence handle, which is not the agent's id.
  let persisted: string | undefined;
  try {
    const handle = paseo.agents.ref(agent.id);
    if (!handle.current()) await handle.refresh();
    persisted = handle.current()?.persistence?.sessionId ?? undefined;
  } catch { /* the agent id alone */ }
  const sessions = [...new Set([persisted, agent.id].filter((id): id is string => Boolean(id)))];
  return rpc(agentCompact, { sessions });
}

/** The command-center item and the "/alp-compact" slash command of an ALP agent. */
export function addCompactCommands(client: PluginClientContext) {
  const removeItem = client.addCommandCenterItem({
    id: 'alp-compact-agent',
    title: 'Compact ALP agent context',
    icon: 'Shrink',
    keywords: ['compact', 'context', 'checkpoint', 'alp'],
    context: 'agent',
    async onSelect(context) { await compactAgent(context); },
  });
  // Not "/compact": Claude Code has its own, which skips ALP's checkpoint.
  const removeSlash = client.addSlashCommand({
    name: 'alp-compact',
    description: 'Compact this ALP agent\'s context after a checkpoint',
    argumentHint: '',
    context: 'agent',
    async onSubmit(context) { await compactAgent(context); },
  });
  return () => { removeItem(); removeSlash(); };
}
