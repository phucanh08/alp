import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { acpDecision, claudePermissions } from '@anhlp/alp-runtime';
import { credentialDenials, namesCredential } from '@anhlp/alp-runtime/claude-transport';

/**
 * t-cde5, a permission narrowing: read-only Claude and ACP sessions may not read the Paseo
 * credentials (<home>/paseo/** and relay-keypair.json). Roles reached: reviewer, oracle, supervisor,
 * read-only team members (advisor, reviewer) and user-written read-only profiles. Everything else
 * such a session could do before stays as it was.
 */

const home = path.join(os.tmpdir(), 'alp-cde5-home');
const root = path.join(os.tmpdir(), 'alp-cde5-repo');
const rule = file => `/${file}`;
const DENY = [`Read(${rule(path.join(home, 'paseo'))}/**)`, `Read(${rule(path.join(home, 'relay-keypair.json'))})`];
const BUILT_IN = ['Agent', 'Task', 'TeamCreate', 'EnterPlanMode', 'ExitPlanMode'];

test('t-cde5: a read-only Claude session denies Read of the credentials, in its rules and its sandbox; nothing else changes', () => {
  // The built-in read-only profile of reviewer, oracle and supervisor (permissions.js profileFor), with the read-only floor.
  const advisor = claudePermissions('read-only', undefined, { base: 'read-only', allow: [], ask: [], deny: [], beyondMode: 'refuse', floor: 'read-only', floorRoot: root }, undefined, home);
  assert.deepEqual(advisor.disallowedTools, [...BUILT_IN, ...DENY]);
  assert.deepEqual(advisor.sandbox.filesystem, { denyWrite: [root], denyRead: [path.join(home, 'paseo'), path.join(home, 'relay-keypair.json')] });
  assert.deepEqual(advisor.tools, ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Skill', 'Bash'], 'the same tools as before');
  assert.equal(advisor.permissionMode, 'default');
  assert.equal(advisor.allowedTools, undefined);
  // Without an OS sandbox (no floor): the deny rules still hold.
  const noFloor = claudePermissions('read-only', () => 'read-only', { allow: [], deny: [] }, undefined, home);
  assert.deepEqual(noFloor.disallowedTools, [...BUILT_IN, ...DENY]);
  assert.equal(noFloor.sandbox, undefined);
});

test('t-cde5: a user-written read-only profile with a broad Read allow: the deny wins (Claude applies deny before allow), its other rules are unchanged', () => {
  const profile = { name: 'reader', base: 'read-only', allow: ['Read', 'Grep', 'Bash(git diff:*)', `Read(${rule(home)}/**)`], ask: ['Bash(npm test:*)'], deny: ['WebFetch'], beyondMode: 'ask' };
  const gate = claudePermissions('read-only', () => 'read-only', { ...profile, floor: 'read-only', floorRoot: root }, undefined, home);
  assert.deepEqual(gate.allowedTools, profile.allow, 'every allow rule is passed as before');
  assert.deepEqual(gate.disallowedTools, [...BUILT_IN, 'WebFetch', ...DENY], 'the user\'s deny rules, then the credentials\'');
  assert.deepEqual(gate.settings, { permissions: { ask: profile.ask } });
});

test('t-cde5: workspace-write and full-access Claude sessions are not narrowed; a read-only profile in a writable copy is', () => {
  for (const mode of ['workspace-write', 'full-access']) {
    const gate = claudePermissions(mode, () => mode, { allow: [], deny: [], floor: mode === 'workspace-write' ? 'workspace-write' : undefined, floorRoot: root }, undefined, home);
    assert.deepEqual(gate.disallowedTools, BUILT_IN, mode);
    assert.equal(gate.sandbox?.filesystem, undefined, mode);
  }
  // An advisor working in a copy runs with a workspace-write floor in its copy; its profile is read-only.
  const copy = claudePermissions('workspace-write', () => 'workspace-write', { base: 'read-only', allow: [], deny: [], floor: 'workspace-write', floorRoot: root }, undefined, home);
  assert.deepEqual(copy.disallowedTools, [...BUILT_IN, ...DENY]);
  assert.deepEqual(copy.sandbox.filesystem, { denyRead: [path.join(home, 'paseo'), path.join(home, 'relay-keypair.json')] });
});

test('t-cde5: a read-only session\'s Bash leaving the sandbox is refused when it names the credentials, even with an allow rule', async () => {
  const gate = claudePermissions('read-only', () => 'read-only', { base: 'read-only', allow: ['Bash(cat:*)'], deny: [], floor: 'read-only', floorRoot: root }, undefined, home);
  const run = command => gate.canUseTool('Bash', { command, dangerouslyDisableSandbox: true }, {});
  for (const command of [`cat ${path.join(home, 'paseo', 'token.json')}`, 'cat ~/.alp/paseo/token.json', 'cat "$ALP_HOME/paseo/token.json"', 'cat relay-keypair.json']) {
    assert.equal((await run(command)).behavior, 'deny', command);
  }
  assert.equal((await run('cat README.md')).behavior, 'allow', 'the allow rule still allows other commands');
  // Inside the sandbox Bash runs as before (the OS denies the read).
  assert.equal((await gate.canUseTool('Bash', { command: 'git diff' }, {})).behavior, 'allow');
  assert.equal(namesCredential('git log --stat', credentialDenials(home).denyRead), false);
});

test('t-cde5: ACP read-only sessions refuse reads and searches of the credentials and commands naming them, whatever a rule allows', () => {
  const profile = { name: 'reader', base: 'read-only', allow: ['Bash(cat:*)'], ask: [], deny: [], beyondMode: 'refuse' };
  const request = (kind, paths, command) => ({ kind, title: kind, paths, alpTool: false, ...(command ? { command } : {}) });
  const token = path.join(home, 'paseo', 'token.json');
  assert.equal(acpDecision(request('read', [token]), 'read-only', null, root, home), 'deny');
  assert.equal(acpDecision(request('read', [path.join(home, 'relay-keypair.json')]), 'read-only', null, root, home), 'deny');
  assert.equal(acpDecision(request('search', [home]), 'read-only', null, root, home), 'deny', 'a search from a directory holding them');
  assert.equal(acpDecision(request('execute', [], `cat ${token}`), 'read-only', profile, root, home), 'deny', 'the deny wins over an allow rule');
  // Everything else is decided as before.
  assert.equal(acpDecision(request('read', [path.join(root, 'README.md')]), 'read-only', null, root, home), 'allow');
  assert.equal(acpDecision(request('read', [path.join(home, 'paseo.json')]), 'read-only', null, root, home), 'allow', 'paseo.json holds no secret');
  assert.equal(acpDecision(request('search', [root]), 'read-only', null, root, home), 'allow');
  assert.equal(acpDecision(request('execute', [], 'cat README.md'), 'read-only', profile, root, home), 'allow');
  assert.equal(acpDecision(request('execute', [], 'git diff'), 'read-only', null, root, home), 'mode');
  // Writable and full-access sessions are not narrowed.
  assert.equal(acpDecision(request('read', [token]), 'workspace-write', null, root, home), 'allow');
  assert.equal(acpDecision(request('read', [token]), 'full-access', null, root, home), 'allow');
});
