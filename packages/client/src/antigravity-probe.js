import { spawn } from 'node:child_process';

const DEFAULT_ANTIGRAVITY_MODELS = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
  { id: 'gemini-3.8-flash-medium', label: 'Gemini 3.8 Flash (Medium)' },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Thinking)' },
  { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)' },
  { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
];

const ANTIGRAVITY_MODES = [
  {
    id: 'read-only',
    label: 'Read only',
    description: 'agy reads and searches; it denies file edits and terminal commands (--sandbox, request-review).',
  },
  {
    id: 'workspace-write',
    label: 'Workspace write',
    description: 'agy edits files and runs commands in its terminal sandbox inside the workspace (--mode accept-edits --sandbox, proceed-in-sandbox).',
  },
  {
    id: 'full-access',
    label: 'Full access',
    description: 'Antigravity runs with full access (--dangerously-skip-permissions).',
  },
];

function runCommand(command, args, { env = process.env, cwd, timeoutMs = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });

    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
    });
  });
}

/**
 * Probes Antigravity CLI for version, status and available models.
 * @param {{ command?: string, args?: string[], env?: Record<string, string>, label?: string, id?: string}} [provider] readOnlyMode, if set, is a legacy setting with no effect: agy enforces read-only itself.
 * @param {{ cwd?: string, timeoutMs?: number }} [options]
 */
export async function probeAntigravity(provider = {}, { cwd, timeoutMs = 20_000 } = {}) {
  const command = provider.command || 'agy';
  const args = provider.args ?? [];
  const env = { ...process.env, ...(provider.env ?? {}) };

  // Check version
  let version = '';
  try {
    const res = await runCommand(command, [...args, '--version'], { env, cwd, timeoutMs: Math.min(timeoutMs, 5000) });
    version = res.stdout.trim().split('\n')[0] ?? '';
  } catch (error) {
    throw new Error(`Antigravity command '${command}' is not available: ${error.message}`);
  }

  // Probe models
  let models = [];
  try {
    const res = await runCommand(command, [...args, 'models'], { env, cwd, timeoutMs });
    for (const line of res.stdout.trim().split(/\r?\n/)) {
      if (!line.trim()) continue;
      const [id, label] = line.split('\t');
      if (id && label) {
        models.push({ id: id.trim(), label: label.trim() });
      } else if (id) {
        models.push({ id: id.trim(), label: id.trim() });
      }
    }
  } catch {
    models = [...DEFAULT_ANTIGRAVITY_MODELS];
  }

  if (!models.length) {
    models = [...DEFAULT_ANTIGRAVITY_MODELS];
  }

  return {
    version,
    agent: { name: 'antigravity', title: 'Antigravity', version },
    models,
    currentModel: models[0]?.id,
    modes: ANTIGRAVITY_MODES,
    currentMode: 'full-access',
  };
}
