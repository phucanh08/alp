import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acpDecision, claudePermissions } from '@anhlp/alp-runtime';
import { caseInsensitive, credentialDenials, credentialPaths, namesCredential, tokenSocketFallback } from '@anhlp/alp-runtime/claude-transport';

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
  assert.deepEqual(gate.allowedTools, profile.allow.filter(rule => !rule.startsWith('Bash(')), 'every non-Bash allow rule is passed as before (Bash allow rules are decided in canUseTool, t-6dc5)');
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
  assert.equal(gate.allowedTools, undefined, 'Bash allow rules are decided by ALP in canUseTool (t-6dc5), not handed to Claude');
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

test('t-cde5 M2: where the filesystem ignores case (macOS, Windows), a case variant of the credential paths is refused too', () => {
  const variant = path.join(path.dirname(home), path.basename(home).toUpperCase(), 'PASEO', 'Token.json');
  const command = `cat ${variant}`;
  const paths = credentialDenials(home).denyRead;
  assert.equal(namesCredential(command, paths, 'darwin'), true);
  assert.equal(namesCredential(command, paths, 'win32'), true);
  assert.equal(namesCredential('cat ~/.ALP/Paseo/token.json', paths, 'darwin'), true);
  assert.equal(namesCredential('cat ~/.ALP/Paseo/token.json', paths, 'linux'), false, 'on Linux that is another file');
  assert.equal(namesCredential(command, paths, 'linux'), false);
  // ACP read-only sessions, on this platform.
  const read = acpDecision({ kind: 'read', title: 'read', paths: [variant], alpTool: false }, 'read-only', null, root, home);
  assert.equal(read, caseInsensitive() ? 'deny' : 'allow');
  // Claude's own deny rules matched a case variant in a real read-only session on macOS (PR #386, T12).
});

test('t-cde5 M2: a symlinked home is denied as named and as resolved', t => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'alp-cde5-link-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const real = path.join(scratch, 'real-home');
  mkdirSync(real);
  const link = path.join(scratch, 'linked-home');
  symlinkSync(real, link, 'dir');
  const resolved = realpathSync(real);
  const { rules, denyRead } = credentialDenials(link);
  for (const root of [link, resolved]) {
    assert.ok(denyRead.includes(path.join(root, 'paseo')), root);
    assert.ok(denyRead.includes(path.join(root, 'relay-keypair.json')), root);
    assert.ok(rules.includes(`Read(${rule(path.join(root, 'paseo'))}/**)`), root);
    assert.ok(rules.includes(`Read(${rule(path.join(root, 'relay-keypair.json'))})`), root);
  }
  assert.equal(new Set(denyRead).size, denyRead.length, 'no duplicates');
});

test('t-cde5 M3: the /tmp directory of a long home\'s token socket is denied, as /tmp names it and as it resolves', () => {
  const uid = process.getuid?.() ?? 'user';
  const long = path.join(os.tmpdir(), 'x'.repeat(100), '.alp');
  const name = `alp-paseo-${uid}-${createHash('sha256').update(long).digest('hex').slice(0, 12)}`;
  if (process.platform === 'win32') {
    assert.deepEqual(tokenSocketFallback(long), [], 'a named pipe on Windows');
    return;
  }
  const expected = [...new Set([path.posix.join('/tmp', name), path.posix.join(realpathSync('/tmp'), name)])];
  assert.deepEqual(tokenSocketFallback(long), expected);
  assert.deepEqual(tokenSocketFallback(home), [], 'a short home keeps its socket in <home>/paseo/');
  const { rules, denyRead } = credentialDenials(long);
  for (const directory of expected) {
    assert.ok(denyRead.includes(directory), directory);
    assert.ok(rules.includes(`Read(/${directory}/**)`), directory);
  }
  assert.ok(credentialPaths(long).directories.includes(path.join(long, 'paseo')));
  // ACP read-only sessions refuse it too.
  const request = { kind: 'read', title: 'read', paths: [path.join(expected[0], 'token.sock')], alpTool: false };
  assert.equal(acpDecision(request, 'read-only', null, root, long), 'deny');
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

test('t-cde5 g4: a read-only profile leaves the sandbox only for a command its checked rules (Bash(@…)) cover entirely; nothing else does', async t => {
  // The librarian's shape: read-only base, a checked clone rule, and a plain allow rule beside it. Its root is a scratch 0700 dir.
  const libRoot = mkdtempSync(path.join(os.tmpdir(), 'alp-g4-lib-'));
  t.after(() => rmSync(libRoot, { recursive: true, force: true }));
  const profile = { base: 'read-only', allow: [`Bash(@git-clone-public ${libRoot})`, 'Bash(cat:*)'], ask: [], deny: [], beyondMode: 'refuse', floor: 'read-only', floorRoot: root };
  const gate = claudePermissions('read-only', () => 'read-only', profile, async () => ({ allow: true, always: true }), home);
  assert.equal(gate.sandbox.allowUnsandboxedCommands, true, 'the SDK must let the checked clone out');
  assert.equal(gate.allowedTools, undefined, 'no Bash rule goes to Claude, so Claude never lets a command out by itself');
  // A public clone below the root, covered by the checked rule: it leaves the sandbox (it needs the network).
  const clone = `git clone --depth 1 https://github.com/sindresorhus/is-plain-obj ${libRoot}/is-plain-obj`;
  assert.deepEqual(await gate.canUseTool('Bash', { command: clone, dangerouslyDisableSandbox: true }, {}), { behavior: 'allow', updatedInput: { command: clone, dangerouslyDisableSandbox: true } });
  // Everything else is decided as the sandboxed command it is: the parameter is dropped.
  const token = `cat ${path.join(home, 'paseo', 'token.json')}`;
  for (const command of [token, 'cat README.md', 'git diff', `${clone}; ${token}`, `${clone} && curl https://example.com`, `git clone https://github.com/a/b ${path.join(os.tmpdir(), 'elsewhere')}`,
    // A shell wrapper that hides a second command after a covered one (t-cde5 review: greedy sh -c), or wraps it at all.
    `sh -c '${clone}' ; ${token} 'b'`, `bash -c "${clone}" ; touch x "b"`, `sh -c '${clone}'`]) {
    const decided = await gate.canUseTool('Bash', { command, dangerouslyDisableSandbox: true }, {});
    assert.equal(decided.updatedInput?.dangerouslyDisableSandbox, undefined, command);
  }
  // A plain allow rule alone never opens the way out.
  const plain = claudePermissions('read-only', () => 'read-only', { ...profile, allow: ['Bash(cat:*)', 'Bash(git clone:*)'] }, undefined, home);
  assert.equal(plain.sandbox.allowUnsandboxedCommands, false);
  assert.deepEqual(await plain.canUseTool('Bash', { command: clone, dangerouslyDisableSandbox: true }, {}), { behavior: 'allow', updatedInput: { command: clone } });
  // "Always allow" in a confined session adds no native Bash rule Claude could use to let a command out unchecked.
  const asked = claudePermissions('read-only', () => 'read-only', { ...profile, ask: ['Bash(touch *)'], beyondMode: 'ask' }, async () => ({ allow: true, always: true }), home);
  const answer = await asked.canUseTool('Bash', { command: 'touch x' }, { decisionReasonType: 'rule', suggestions: [] });
  assert.equal(answer.behavior, 'allow');
  assert.equal(answer.updatedPermissions, undefined);
});
