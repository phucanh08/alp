import { defineRpc } from '@getpaseo/plugin';
import { z } from 'zod';

/**
 * Compact an ALP agent's context (t-de1a): alpd's session.compact on the root the agent runs as.
 * `sessions` are the ids the provider may know the agent's session by (its persistence handle's
 * sessionId first, then the Paseo agent id), tried in order.
 */
export const agentCompact = defineRpc({
  name: 'alp.agent.compact',
  input: z.object({ sessions: z.array(z.string().min(1).max(128)).min(1).max(4) }),
  output: z.object({ sessionId: z.string(), status: z.enum(['started', 'deferred', 'running']) }),
});

/** What a compaction answer means for people. */
export function compactNotice(status: 'started' | 'deferred' | 'running') {
  if (status === 'deferred') return 'Compaction will start when the main agent finishes its current turn.';
  if (status === 'running') return 'The main agent is already compacting its context.';
  return 'Compacting the main agent\'s context: it writes a checkpoint first.';
}

type Request = (method: string, params: Record<string, unknown>) => Promise<any>;

/**
 * session.compact for the first of the agent's ids alpd knows. An id alpd answers "no such session"
 * (1001) for is skipped; any other refusal (not a root, not open, beyond the grant) is the answer.
 * Shared by the local plugin (alpd's socket) and remote mode (the gateway).
 */
export async function compactFirst(request: Request, sessions: string[]) {
  let missing: unknown;
  for (const sessionId of sessions) {
    try {
      const { status } = await request('session.compact', { sessionId });
      return { sessionId, status: status as 'started' | 'deferred' | 'running' };
    } catch (error) {
      if ((error as { code?: unknown })?.code !== 1001) throw error;
      missing = error;
    }
  }
  throw missing ?? new Error('This agent has no ALP session');
}
