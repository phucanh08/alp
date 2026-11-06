import test from 'node:test';
import assert from 'node:assert/strict';
import { antigravityModeArgs, antigravityModeText, antigravityReadOnlyCommandAllowed } from '@anhlp/alp-runtime/antigravity-transport';

test('agy read-only matches its allowlist the way agy does, on a word boundary', () => {
  // agy matches an allow rule by command prefix, so ALP's own reading of the allowlist has to
  // accept flags and subcommands after an entry and refuse a longer command name.
  for (const line of ['pwd', 'pwd -L', 'pwd   -L']) assert.equal(antigravityReadOnlyCommandAllowed(line), true, String(line));
  for (const line of ['pwdx', 'pwd-x', 'cat x', 'rm x', 'pwd; ls', 'pwd && ls', 'pwd $(id)', 'pwd > out', undefined, 3]) {
    assert.equal(antigravityReadOnlyCommandAllowed(line), false, String(line));
  }
  // The instructions name exactly what the allowlist allows, so the agent never spends a turn
  // on a command that would be denied, and never believes a removed one still runs.
  const text = antigravityModeText('read-only');
  for (const command of ['pwd']) assert.match(text, new RegExp(command.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
  assert.doesNotMatch(text, /pwd and ls/);
  const args = antigravityModeArgs('read-only', '/tmp');
  const settings = JSON.parse(args[args.indexOf('--settings') + 1]);
  assert.deepEqual(settings.permissions.allow, ['mcp(alp/*)', 'command(pwd)']);
  const write = JSON.parse(antigravityModeArgs('workspace-write', '/tmp').at(-1));
  assert.deepEqual(write.permissions.allow, ['mcp(alp/*)']);
});
