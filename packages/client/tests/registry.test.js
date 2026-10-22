// The portable registry helpers (packages/client/src/rpc/registry.js): each sends its method with
// exactly the params given, so a caller's requestId and cursor reach the daemon unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceRegistry } from '@anhlp/alp-client/portable';

test('gitStatus and gitDiff send workspace.git.status and workspace.git.diff as given (capability workspace.git)', async () => {
  const sent = [];
  const registry = workspaceRegistry({ request: async (method, params) => { sent.push([method, params]); return { method }; } });
  assert.deepEqual(await registry.gitStatus('wks_a'), { method: 'workspace.git.status' });
  const page = { workspaceId: 'wks_a', compare: { mode: 'base', baseRef: 'main', ignoreWhitespace: true }, path: 'src/app.ts', cursor: 'c1' };
  assert.deepEqual(await registry.gitDiff(page), { method: 'workspace.git.diff' });
  assert.deepEqual(sent, [['workspace.git.status', { workspaceId: 'wks_a' }], ['workspace.git.diff', page]]);
});
