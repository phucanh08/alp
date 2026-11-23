import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acpDecision, acpEnv, claudePermissions } from '@anhlp/alp-runtime';

test('security: permission gates resolve symlinks and refuse malformed writer paths', { skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'inside'));
  // /etc is read-only fixture data here: only permission decisions, never writes.
  const outside = path.parse(root).root === '/' ? '/etc' : path.parse(root).root;
  await symlink(outside, path.join(root, 'escape'), 'dir');
  await mkdir(path.join(root, 'etc'));
  await writeFile(path.join(root, 'etc/hosts'), 'decoy');
  await symlink('escape/../etc/hosts', path.join(root, 'indirect'));
  await symlink('missing', path.join(root, 'dangling'));
  await symlink('loop', path.join(root, 'loop'));
  await symlink(path.join(root, 'inside'), path.join(root, 'safe'), 'dir');
  const gate = claudePermissions('workspace-write', undefined, { allow: [], deny: [], floor: 'workspace-write', floorRoot: root });
  for (const file of ['indirect', 'dangling/file', 'loop/file', 'bad\0path', 'escape/new/file.txt', 'escape/../outside.txt', `${root}/escape/../outside.txt`, path.join(outside, 'outside.txt')]) {
    assert.equal(acpDecision({ kind: 'edit', title: 'edit', paths: [file], alpTool: false }, 'workspace-write', null, root), 'mode');
    assert.equal((await gate.canUseTool('Write', { file_path: file, content: 'x' })).behavior, 'deny');
  }
  assert.equal((await gate.canUseTool('NotebookEdit', { notebook_path: path.join(outside, 'outside.ipynb') })).behavior, 'deny');
  assert.equal((await gate.canUseTool('Write', {})).behavior, 'deny');
  assert.equal(acpDecision({ kind: 'edit', title: 'edit', paths: [], alpTool: false }, 'workspace-write', null, root), 'mode');
  for (const file of ['safe/new/file.txt', 'inside/new.txt', 'inside/../ok.txt']) {
    assert.equal(acpDecision({ kind: 'edit', title: 'edit', paths: [file], alpTool: false }, 'workspace-write', null, root), 'allow');
    assert.equal((await gate.canUseTool('Write', { file_path: file, content: 'x' })).behavior, 'allow');
  }
});

test('OpenCode is told to ask before it edits, runs or fetches, over the config the user passed; other agents start as they are', () => {
  const user = JSON.stringify({ model: 'x/y', permission: { edit: 'allow', read: 'allow' } });
  for (const command of ['opencode', '/usr/local/bin/opencode', 'C:\\tools\\OpenCode.exe']) {
    const env = acpEnv({ command, env: { OPENCODE_CONFIG_CONTENT: user } }, { PATH: '/bin' });
    assert.equal(env.PATH, '/bin');
    assert.deepEqual(JSON.parse(env.OPENCODE_CONFIG_CONTENT), { model: 'x/y', permission: { edit: 'ask', read: 'allow', bash: 'ask', webfetch: 'ask' } });
  }
  assert.deepEqual(JSON.parse(acpEnv({ command: 'opencode', env: {} }, { OPENCODE_CONFIG_CONTENT: 'not json' }).OPENCODE_CONFIG_CONTENT), { permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' } });
  assert.deepEqual(acpEnv({ command: 'gemini', env: { A: '1' } }, { PATH: '/bin' }), { PATH: '/bin', A: '1' });
});

test('security: claude sandbox floors do not grant broad host socket access', async () => {
  const root = path.join(os.tmpdir(), 'alp-test-repo-root');

  // A host service can write on a caller's behalf; denyWrite alone cannot constrain it.
  const readOnly = claudePermissions('read-only', () => 'read-only', { allow: [], ask: [], deny: [], floor: 'read-only', floorRoot: root });
  assert.deepEqual(readOnly.sandbox, {
    enabled: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: true,
    filesystem: {
      denyWrite: [root],
    },
  });

  // Workspace-write retains the same restrictive host-network defaults.
  const workspace = claudePermissions('workspace-write', () => 'workspace-write', { allow: [], ask: [], deny: [], floor: 'workspace-write', floorRoot: root });
  assert.deepEqual(workspace.sandbox, {
    enabled: true,
    autoAllowBashIfSandboxed: false,
    allowUnsandboxedCommands: true,
  });

  for (const permissions of [readOnly, workspace]) {
    assert.notEqual(permissions.sandbox.network?.allowAllUnixSockets, true, 'no arbitrary host Unix service access');
    assert.notEqual(permissions.sandbox.network?.allowLocalBinding, true, 'no broad macOS localhost access');
  }

  // Without floor: sandbox configuration is omitted
  const noFloor = claudePermissions('read-only', () => 'read-only', { allow: [], ask: [], deny: [] });
  assert.equal(noFloor.sandbox, undefined);
});

// t-6dc5 G5-B: Bash allow rules are decided by ALP's commandDecision in canUseTool, never by Claude's allowedTools,
// which would match them as written and run them (outside the sandbox too) without asking canUseTool.
test('security: Bash allow rules reach canUseTool; every role keeps the outcome it had', async () => {
  const root = path.join(os.tmpdir(), 'alp-test-repo-root');
  const bash = (gate, command, leave = false) => gate.canUseTool('Bash', { command, ...(leave ? { dangerouslyDisableSandbox: true } : {}) }).then(result => result.behavior);
  const verify = ['git diff', 'git diff HEAD~1 --stat', 'git log --oneline -5', 'git show HEAD:package.json', 'node scripts/test.mjs unit'];

  // Reviewer, its default profile (read-only, no rules) under the read-only floor: its checks run in the sandbox, as before.
  const reviewer = claudePermissions('read-only', () => 'read-only', { allow: [], ask: [], deny: [], beyondMode: 'refuse', floor: 'read-only', floorRoot: root });
  assert.equal(reviewer.allowedTools, undefined);
  for (const command of verify) assert.equal(await bash(reviewer, command), 'allow', command);
  // Leaving the sandbox needed an allow rule before and still does.
  for (const command of verify) assert.equal(await bash(reviewer, command, true), 'deny', command);

  // A reviewer given allow rules (the docs' review profile): what they cover runs, in the sandbox or out of it.
  const review = { allow: ['Bash(npm test:*)', 'Bash(node --test:*)', 'Bash(node scripts/test.mjs:*)', 'Bash(git diff:*)'], ask: ['Bash(npm install *)'], deny: ['Bash(rm:*)', 'Bash(git push:*)'], beyondMode: 'refuse' };
  const reviewing = claudePermissions('read-only', () => 'read-only', { ...review, floor: 'read-only', floorRoot: root });
  assert.equal(reviewing.allowedTools, undefined, 'no Bash allow rule goes to Claude');
  assert.deepEqual(reviewing.disallowedTools.slice(-2), ['Bash(rm:*)', 'Bash(git push:*)'], 'deny rules stay native');
  for (const command of ['npm test', 'node scripts/test.mjs unit', 'git diff --stat']) {
    assert.equal(await bash(reviewing, command), 'allow', command);
    assert.equal(await bash(reviewing, command, true), 'allow', `${command} outside the sandbox`);
  }
  assert.equal(await bash(reviewing, 'touch x', true), 'deny');
  assert.equal(await bash(reviewing, 'npm test; git push', true), 'deny');
  // Read-only without a floor (no OS sandbox): an allowed command still runs, anything else is refused.
  const unsandboxed = claudePermissions('read-only', () => 'read-only', review);
  assert.equal(await bash(unsandboxed, 'npm test'), 'allow');
  assert.equal(await bash(unsandboxed, 'touch x'), 'deny');

  // A workspace-write peer: no profile, or one with only deny rules, is unchanged; an allow rule still lets a command out.
  for (const rules of [{ allow: [], ask: [], deny: [] }, { allow: [], ask: [], deny: ['Bash(git push:*)'] }]) {
    const peer = claudePermissions('workspace-write', () => 'workspace-write', { ...rules, floor: 'workspace-write', floorRoot: root });
    assert.equal(peer.allowedTools, undefined);
    assert.equal(await bash(peer, 'npm run build'), 'allow');
    assert.equal(await bash(peer, 'npm install', true), 'deny');
  }
  const builder = claudePermissions('workspace-write', () => 'workspace-write', { allow: ['Bash(npm install:*)'], ask: [], deny: [], floor: 'workspace-write', floorRoot: root });
  assert.equal(await bash(builder, 'npm install left-pad', true), 'allow');

  // The research pack's librarian: its checked rules decide; Claude gets only the WebFetch allow rules.
  // A scratch 0700 directory stands in for its per-user root (~/.alp-librarian-cache), so nothing is made in /tmp or ~.
  const clones = await mkdtemp(path.join(os.tmpdir(), 'alp-librarian-gate-'));
  try {
    const librarian = {
      allow: [`Bash(@git-clone-public ${clones})`, `Bash(@git-read ${clones})`, 'WebFetch(domain:github.com)'],
      ask: ['Bash(git clone:*)', 'Bash(git -C:*)'], deny: ['Bash(@git-unsafe)', 'Bash(git push:*)', 'Bash(rm:*)'], beyondMode: 'refuse',
    };
    const library = claudePermissions('read-only', () => 'read-only', { ...librarian, floor: 'read-only', floorRoot: root });
    assert.deepEqual(library.allowedTools, ['WebFetch(domain:github.com)']);
    if (process.platform !== 'win32') {
      assert.equal(await bash(library, `git clone --depth 50 https://github.com/a/b ${clones}/a-b`, true), 'allow');
      assert.equal(await bash(library, `git -C ${clones}/a-b fetch --depth 50`, true), 'allow');
      assert.equal(await bash(library, `git -C ${clones}/a-b grep -n -e foo -- lib`), 'allow');
    }
    assert.equal(await bash(library, `git -C ${clones}/../x push`, true), 'deny');
    assert.equal(await bash(library, `git -C ${clones}/a-b -c core.sshCommand=x fetch`, true), 'deny');
    // Asked about with no one to ask (no ask callback here): refused.
    assert.equal(await bash(library, `git clone https://evil.example/a/b ${clones}/a-b`, true), 'deny');
    assert.equal(await bash(library, `git -C ${clones}X log`, true), 'deny');
    // Round 2: abbreviated and clustered options that run a pager command, and path options that read outside the
    // clone, are not allowed, in the sandbox or out of it.
    for (const args of ["grep --open-f='touch /tmp/pwn #' hi", "grep --open='sh -c id' hi", 'grep -iOtouch hi', 'grep -nOtouch hi', 'grep --file=/etc/passwd', 'blame --contents=/etc/passwd a.js', 'blame --ignore-revs-file=/etc/passwd a.js', 'ls-files --exclude-from=/etc/passwd']) {
      assert.equal(await bash(library, `git -C ${clones}/a-b ${args}`, true), 'deny', args);
    }
    // A checked deny rule holds inside the sandbox too: Claude cannot match Bash(@git-unsafe) itself.
    for (const command of ['g\\it push $X', `git -C ${clones}/a-b pu\\sh`, `git -C ${clones}/a-b -c core.pager=x log`]) {
      assert.equal(await bash(library, command), 'deny', command);
    }
    // Commands no rule covers still run in the read-only sandbox, as before.
    assert.equal(await bash(library, 'git log --oneline -5'), 'allow');
  } finally { await rm(clones, { recursive: true, force: true }); }
});
