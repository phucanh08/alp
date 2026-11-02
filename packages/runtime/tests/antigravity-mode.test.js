import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravityModeArgs, antigravityReadOnlyCommandAllowed } from '@anhlp/alp-runtime/antigravity-transport';

test('agy read-only allows pwd only; ls cannot be scoped to the workspace by a prefix rule', () => {
  assert.equal(antigravityReadOnlyCommandAllowed('pwd'), true);
  for (const line of ['ls', 'ls /', 'ls ~/.ssh', 'ls ../..', 'ls -la src', 'cat x', 'pwd; ls', 'pwd && ls', 'pwd $(id)', undefined, 3]) {
    assert.equal(antigravityReadOnlyCommandAllowed(line), false, String(line));
  }
  const args = antigravityModeArgs('read-only', '/tmp');
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(settings.permissions.allow, ['mcp(alp/*)', 'command(pwd)']);
  const write = JSON.parse(antigravityModeArgs('workspace-write', '/tmp').at(-1));
  assert.deepEqual(write.permissions.allow, ['mcp(alp/*)']);
});
