import type { AgentUsage } from '@getpaseo/protocol/agent-types';
import type { SessionUsage } from '@anhlp/alp-protocol';

const USAGE_FIELDS = ['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalCostUsd', 'contextWindowMaxTokens', 'contextWindowUsedTokens'] as const;

/**
 * ALP's SessionUsage (t-7679.12) as Paseo's AgentUsage (and the plugin SDK's ProviderUsage, the
 * same shape): the same counts by the same names, finite numbers only, and nothing else.
 */
export function agentUsage(usage: SessionUsage): AgentUsage {
  const out: AgentUsage = {};
  for (const key of USAGE_FIELDS) {
    const value = usage?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return out;
}
