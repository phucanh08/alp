/** Live model probes for the catalog (t-e5ee): each asks a provider's own CLI, read-only, and closes it. */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { CodexTransport } from './transport.js';
import { ClaudeTransport } from './claude-transport.js';
import type { CatalogRuntime, LiveModel, Probe } from './model-catalog.js';

export function codexProbe(command = process.env.ALP_CODEX_BIN ?? 'codex', env: NodeJS.ProcessEnv = process.env): Probe {
  return async signal => {
    const transport = new CodexTransport(command, os.tmpdir(), env);
    const stop = () => { void transport.close(); };
    signal.addEventListener('abort', stop);
    try {
      await transport.initialize();
      const models: LiveModel[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const result = await transport.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }, 10_000, false);
        for (const model of result?.data ?? []) {
          if (typeof model?.model !== 'string' || model.hidden) continue;
          models.push({ id: model.model, label: model.displayName, description: model.description,
            efforts: (model.supportedReasoningEfforts ?? []).map((effort: any) => typeof effort === 'string' ? effort : effort?.reasoningEffort).filter((effort: unknown) => typeof effort === 'string'),
            effort: model.defaultReasoningEffort });
        }
        cursor = result?.nextCursor ?? undefined;
        if (!cursor) break;
      }
      return models;
    } finally { signal.removeEventListener('abort', stop); await transport.close(); }
  };
}

export function claudeProbe(command = process.env.ALP_CLAUDE_BIN ?? 'claude', env: NodeJS.ProcessEnv = process.env): Probe {
  return async () => new ClaudeTransport(command, os.tmpdir(), env).probeModels();
}

/** `agy models` prints one model per line, `id<TAB>label`. */
export function parseAgyModels(stdout: string): LiveModel[] {
  return stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const [id, label] = line.split('\t').map(part => part.trim());
    return { id, label: label || id };
  }).filter(model => model.id && /^[\w.:\-\[\]/]+$/.test(model.id));
}

export function antigravityProbe(command = process.env.ALP_ANTIGRAVITY_BIN ?? 'agy', env: NodeJS.ProcessEnv = process.env): Probe {
  return signal => new Promise((resolve, reject) => {
    const child = spawn(command, ['models'], { cwd: os.tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, signal });
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(parseAgyModels(stdout)) : reject(new Error(`${command} models exited with ${code}`)));
  });
}

export function liveProbes(env: NodeJS.ProcessEnv = process.env): Record<CatalogRuntime, Probe> {
  return { codex: codexProbe(undefined, env), claude: claudeProbe(undefined, env), antigravity: antigravityProbe(undefined, env) };
}
