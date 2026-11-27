import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { ClaudeTransport } from '@anhlp/alp-runtime';

// `any`: the SDK query is a partial fake and the config is read as JSON; the test reads the fields it asserts on.
type Json = any;
/** ClaudeTransport with the private members this test drives: the SDK query and the thread's config. */
type ClaudeInternals = Omit<ClaudeTransport, never> & { query: Json, config: Json };

test('session/configure switches a live Claude thread\'s permission mode by sandbox (claudePermissionMode) and keeps the new sandbox', async () => {
  const transport = new ClaudeTransport(process.execPath, tmpdir(), process.env) as unknown as ClaudeInternals;
  await assert.rejects(transport.request('session/configure', { sandbox: 'full-access' }), /Claude thread is not initialized/);
  const modes: string[] = [];
  transport.query = { setPermissionMode: async (mode: string) => { modes.push(mode); } };
  transport.config = { sandbox: 'read-only' };
  for (const sandbox of ['full-access', 'read-only', 'workspace-write', 'full-access']) {
    assert.deepEqual(await transport.request('session/configure', { sandbox }), {});
    assert.equal(transport.config.sandbox, sandbox);
  }
  assert.deepEqual(modes, ['bypassPermissions', 'default', 'acceptEdits', 'bypassPermissions']);
  // A refused switch keeps the old sandbox.
  transport.query = { setPermissionMode: async () => { throw new Error('mode refused'); } };
  await assert.rejects(transport.request('session/configure', { sandbox: 'read-only' }), /mode refused/);
  assert.equal(transport.config.sandbox, 'full-access');
});
