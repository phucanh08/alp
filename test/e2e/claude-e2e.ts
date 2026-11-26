// Opt-in integration: requires a declared scratch Paseo daemon with the ALP plugin (scratch-daemon.ts)
// and Claude Code authentication. It refuses the user's own daemon and ~/.alp before connecting.
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createPaseoClient } from '@getpaseo/client';
import { requireScratchDaemon } from './scratch-daemon.ts';

const { url } = requireScratchDaemon();

// Default to an ignored fixture: the provider installs ALP starter files into the project.
const root = path.resolve(process.env.ALP_TEST_ROOT ?? path.join('.alp-test', `claude-${Date.now()}`));
await mkdir(root, { recursive: true });
const model = process.env.ALP_TEST_CLAUDE_MODEL ?? 'sonnet';
const client = createPaseoClient({ url, clientId: `alp-claude-e2e-${Date.now()}` });
let agent;

try {
  await client.connect();
  const models = await client.providers.listModels('alp', { cwd: root });
  assert.ok(!models.error, models.error ?? undefined);
  assert.ok(models.models!.some(entry => entry.id === `claude:${model}`));

  agent = await client.agents.create({
    cwd: root,
    title: 'ALP Claude Code smoke test',
    config: {
      provider: `alp/claude:${model}`,
      modeId: 'read-only',
      thinkingOptionId: 'low',
    },
  });
  const result = await agent.run('Reply with exactly: CLAUDE_ALP_OK', {
    timeoutMs: 120_000,
  });
  console.log(JSON.stringify({
    agentId: agent.id,
    status: result.status,
    response: result.lastMessage,
    error: result.error,
  }));
  assert.equal(result.status, 'idle');
  assert.match(result.lastMessage ?? '', /CLAUDE_ALP_OK/);
} finally {
  await agent?.archive().catch(() => {});
  await client.close();
}
