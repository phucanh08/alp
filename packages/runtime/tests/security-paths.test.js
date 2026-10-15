import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { acpDecision, claudePermissions } from '@anhlp/alp-runtime';

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
