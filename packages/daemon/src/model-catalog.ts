/** Production catalog wiring, shared with daemon integration tests. No model prompts. */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadProvider, listProviders } from '@anhlp/alp-core/providers';
import { probeAcp } from '@anhlp/alp-client/acp-probe';
import { antigravityProbe, liveProbes, ModelCatalog } from '@anhlp/alp-runtime/index';

export function createModelCatalog(home: string, warn: (message: string) => void = console.error) {
  let warnings = new Set<string>();
  const probes = liveProbes();
  probes.antigravity = async signal => {
    const provider = await loadProvider(home, 'antigravity');
    if (provider?.enabled === false) return [];
    return antigravityProbe(provider?.command, { ...process.env, ...provider?.env }, provider?.args)(signal);
  };
  return new ModelCatalog({ home, probes,
    acpProviders: async () => {
      const errors: string[] = [];
      const current = new Set<string>();
      const providers = await listProviders(home, { onError: (error: unknown, name: string) => {
        const message = `skipping provider ${name}: ${error instanceof Error ? error.message : String(error)}`;
        errors.push(message); current.add(message);
        if (!warnings.has(message)) warn(`alpd: ${message}`);
      } });
      warnings = current;
      return { providers, ...(errors.length ? { error: errors.join('\n') } : {}) };
    },
    acpProbe: async (provider, signal) => {
      signal.throwIfAborted();
      const cwd = await mkdtemp(path.join(os.tmpdir(), 'alp-model-probe-'));
      try { return (await probeAcp(provider as Parameters<typeof probeAcp>[0], { cwd, signal, discover: true, timeoutMs: 15_000 })).models ?? []; }
      finally { await rm(cwd, { recursive: true, force: true }); }
    },
  });
}
