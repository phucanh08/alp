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
  assert.equal(advisor.sandbox.allowUnsandboxedCommands, false, 't-cde5 g2: a read-only profile\'s Bash never leaves the sandbox');
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

test('t-cde5 g2: a read-only profile\'s Bash never leaves the sandbox, even under an allow rule; its commands run inside it as before', async () => {
  // Claude itself lets an allow rule's command out of the sandbox without asking canUseTool, so the SDK must refuse the way out.
  const gate = claudePermissions('read-only', () => 'read-only', { base: 'read-only', allow: ['Bash(cat:*)'], deny: [], floor: 'read-only', floorRoot: root }, undefined, home);
  assert.equal(gate.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(gate.allowedTools, ['Bash(cat:*)'], 'the allow rule is passed as before');
  // canUseTool decides such a call as the sandboxed command it is, without the parameter Claude ignores.
  for (const command of [`cat ${path.join(home, 'paseo', 'token.json')}`, 'cat README.md', 'git diff']) {
    assert.deepEqual(await gate.canUseTool('Bash', { command, dangerouslyDisableSandbox: true }, {}), { behavior: 'allow', updatedInput: { command } }, command);
    assert.deepEqual(await gate.canUseTool('Bash', { command }, {}), { behavior: 'allow', updatedInput: { command } }, command);
  }
  // An ask rule the user approves runs inside the sandbox too.
  const ruled = claudePermissions('read-only', () => 'read-only', { base: 'read-only', allow: [], ask: ['Bash(touch *)'], deny: [], beyondMode: 'ask', floor: 'read-only', floorRoot: root }, async () => ({ allow: true }), home);
  assert.deepEqual(await ruled.canUseTool('Bash', { command: 'touch once.txt' }, { decisionReasonType: 'rule' }), { behavior: 'allow', updatedInput: { command: 'touch once.txt' } });
  // An advisor in a copy (workspace-write floor, read-only profile) is confined as well.
  const copy = claudePermissions('workspace-write', () => 'workspace-write', { base: 'read-only', allow: ['Bash(npm test *)'], deny: [], floor: 'workspace-write', floorRoot: root }, undefined, home);
  assert.equal(copy.sandbox.allowUnsandboxedCommands, false);
});

test('t-cde5: a session merely started read-only keeps the way out of the sandbox; a command naming the credentials is refused there by its text', async () => {
  // It may be switched to full access later, when Bash must leave the read-only floor to write.
  const gate = claudePermissions('read-only', () => 'read-only', { base: 'full-access', allow: ['Bash(cat:*)'], deny: [], floor: 'read-only', floorRoot: root }, undefined, home);
  assert.equal(gate.sandbox.allowUnsandboxedCommands, true);
  const run = command => gate.canUseTool('Bash', { command, dangerouslyDisableSandbox: true }, {});
  for (const command of [`cat ${path.join(home, 'paseo', 'token.json')}`, 'cat ~/.alp/paseo/token.json', 'cat "$ALP_HOME/paseo/token.json"', 'cat relay-keypair.json']) {
    assert.equal((await run(command)).behavior, 'deny', command);
  }
  assert.equal((await run('cat README.md')).behavior, 'allow', 'the allow rule still allows other commands');
  // Inside the sandbox Bash runs as before (the OS denies the read).
  assert.equal((await gate.canUseTool('Bash', { command: 'git diff' }, {})).behavior, 'allow');
  assert.equal(namesCredential('git log --stat', credentialDenials(home).denyRead), false);
  // No profile, no allow rule: the way out stays, and Claude asks canUseTool, which refuses it in read-only.
  const plain = claudePermissions('read-only', () => 'read-only', { allow: [], deny: [], floor: 'read-only', floorRoot: root }, undefined, home);
  assert.equal(plain.sandbox.allowUnsandboxedCommands, true);
  assert.equal((await plain.canUseTool('Bash', { command: 'cat README.md', dangerouslyDisableSandbox: true }, {})).behavior, 'deny');
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
