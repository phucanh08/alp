import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backup } from '@anhlp/alp-core';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { worktreeMappings } from '@anhlp/alp-daemon/worktrees';

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-restore-authority-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const target = path.join(root, 'checkout');
  await mkdir(path.join(home, 'state'), { recursive: true });
  await mkdir(target);
  const file = path.join(home, 'state', 'assignment-results.json');
  const options = home => ({ assignmentResultFile: path.join(home, 'state', 'assignment-results.json'), recallFile: path.join(home, 'state', 'recall.json'), liveFile: path.join(home, 'state', 'live.json') });
  const runtime = createAlpRuntime(options(home));
  await runtime.registerWorkspace(target);
  await runtime.shutdown();
  const ledger = JSON.parse(await readFile(file, 'utf8'));
  ledger.results.push({ assignmentId: 'retained', checkout: target, worktree: path.join(root, 'retained-worktree') });
  await writeFile(file, JSON.stringify(ledger));
  return { root, home, target, file, options, ledger };
}
const refused = (runtime, target) => assert.rejects(runtime.withWorkspaceMutation(target, async () => assert.fail('restore certified an old checkout')), error => error.data?.reason === 'workspace_assignment_result');

test('fresh and same-home restore preserve permanent owners without certifying old checkouts', async t => {
  const f = await fixture(t);
  const archive = path.join(f.root, 'backup.alpbackup');
  await backup.createBackup({ home: f.home, out: archive });
  assert.ok((await backup.verifyBackup(archive)).units.includes('state/assignment-results.json'));
  for (const home of [path.join(f.root, 'fresh'), f.home]) {
    await mkdir(home, { recursive: true });
    await backup.restoreBackup({ home, file: archive, safety: false });
    const restored = JSON.parse(await readFile(path.join(home, 'state', 'assignment-results.json'), 'utf8'));
    assert.deepEqual(restored.results, f.ledger.results);
    assert.deepEqual(restored.workspaces, []);
    assert.equal(await readFile(path.join(home, 'state', 'assignment-results.json.initialized'), 'utf8'), '1\n');
    if (process.platform !== 'win32') assert.equal((await stat(path.join(home, 'state', 'assignment-results.json'))).mode & 0o777, 0o600);
    const runtime = createAlpRuntime(f.options(home));
    try {
      await refused(runtime, f.target);
      // Even an explicit new birth elsewhere cannot discard ownership retained from the archive.
      const fresh = path.join(f.root, 'new-' + path.basename(home));
      await mkdir(fresh);
      await runtime.registerWorkspace(fresh);
      assert.equal(await runtime.withWorkspaceMutation(fresh, async () => 'new'), 'new');
      await refused(runtime, f.target);
    } finally { await runtime.shutdown(); }
  }
});

test('legacy backups preserve newer owners, lost markers and unknown checkout refusal', async t => {
  const f = await fixture(t);
  const archive = path.join(f.root, 'legacy.alpbackup');
  await backup.createBackup({ home: f.home, out: archive, units: ['state/sessions'] });
  await writeFile(path.join(f.home, 'worktree-destinations.json'), '{}', { mode: 0o600 });
  await backup.restoreBackup({ home: f.home, file: archive, safety: false });
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), { version: 1, workspaces: [], results: f.ledger.results });
  assert.deepEqual(await worktreeMappings(f.home), []);
  await rm(f.file);
  await backup.restoreBackup({ home: f.home, file: archive, safety: false });
  assert.equal(await readFile(f.file + '.initialized', 'utf8'), '1\n');
  const runtime = createAlpRuntime(f.options(f.home));
  try {
    await refused(runtime, f.target);
    await assert.rejects(runtime.registerWorkspace(f.target), error => error.data.reason === 'workspace_assignment_result');
  } finally { await runtime.shutdown(); }
  const fresh = path.join(f.root, 'old-fresh');
  await mkdir(fresh);
  await backup.restoreBackup({ home: fresh, file: archive, safety: false });
  await assert.rejects(readFile(path.join(fresh, 'state', 'assignment-results.json.initialized')), { code: 'ENOENT' });
  const unknown = createAlpRuntime(f.options(fresh));
  try { await refused(unknown, f.target); } finally { await unknown.shutdown(); }
});

test('snapshot rollback cannot erase newer retained owners or choose conflicting ownership', async t => {
  const f = await fixture(t);
  const archive = path.join(f.root, 'owners.alpbackup');
  await backup.createBackup({ home: f.home, out: archive });
  f.ledger.results.push({ assignmentId: 'newer', checkout: path.join(f.root, 'newer') });
  await writeFile(f.file, JSON.stringify(f.ledger));
  await backup.restoreBackup({ home: f.home, file: archive, safety: false });
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).results, f.ledger.results);
  f.ledger.results[0].checkout = path.join(f.root, 'conflicting');
  await writeFile(f.file, JSON.stringify(f.ledger));
  await assert.rejects(backup.restoreBackup({ home: f.home, file: archive, safety: false }), /ownership conflicts/);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), f.ledger);
});

test('restore keeps result evidence and the archive, but never how a result was handled', async t => {
  const f = await fixture(t);
  const result = { agent: 'peer', status: 'completed', finishedAt: '2026-10-30T00:00:00.000Z', project: f.target, requesters: ['root'], brief: 'Write', summary: '{}' };
  const handled = { outcome: 'applied', by: 'main in root', at: '2026-10-30T01:00:00.000Z' };
  f.ledger.results.push({ assignmentId: 'shared', checkout: f.target, result, handled }, { assignmentId: 'forged', checkout: f.target, result: { agent: 1 } });
  await writeFile(f.file, JSON.stringify(f.ledger));
  const archived = path.join(f.home, 'state', 'assignment-archive');
  await mkdir(archived);
  await writeFile(path.join(archived, '2026-10.jsonl'), JSON.stringify({ assignmentId: 'earlier', handled }) + '\n');
  const archive = path.join(f.root, 'evidence.alpbackup');
  await backup.createBackup({ home: f.home, out: archive });
  assert.ok((await backup.verifyBackup(archive)).units.includes('state/assignment-archive'));
  // The current data's evidence wins over the snapshot's.
  f.ledger.results[1] = { assignmentId: 'shared', checkout: f.target, result: { ...result, status: 'failed' } };
  await writeFile(f.file, JSON.stringify(f.ledger));
  for (const home of [f.home, path.join(f.root, 'fresh')]) {
    await mkdir(home, { recursive: true });
    await backup.restoreBackup({ home, file: archive, safety: false });
    const restored = JSON.parse(await readFile(path.join(home, 'state', 'assignment-results.json'), 'utf8')).results;
    assert.deepEqual(restored.find(owner => owner.assignmentId === 'shared'), { assignmentId: 'shared', checkout: f.target, result: { ...result, status: home === f.home ? 'failed' : 'completed' } });
    assert.deepEqual(restored.find(owner => owner.assignmentId === 'forged'), { assignmentId: 'forged', checkout: f.target });
    assert.match(await readFile(path.join(home, 'state', 'assignment-archive', '2026-10.jsonl'), 'utf8'), /"earlier"/);
    const runtime = createAlpRuntime(f.options(home));
    try { await refused(runtime, f.target); } finally { await runtime.shutdown(); }
  }
});

test('malformed, truncated, missing and linked security evidence fails before changing authority', async t => {
  const { symlink } = await import('node:fs/promises');
  const f = await fixture(t);
  const map = path.join(f.home, 'worktree-destinations.json');
  await writeFile(map, '{historical-map-bytes}', { mode: 0o644 });
  const archive = path.join(f.root, 'bad.alpbackup');
  const destination = path.join(f.root, 'destination');
  await mkdir(path.join(destination, 'state'), { recursive: true });
  const sentinel = path.join(destination, 'worktree-destinations.json');
  await writeFile(sentinel, 'original', { mode: 0o600 });
  const good = await readFile(f.file);
  for (const content of ['{', JSON.stringify({ version: 99 }), JSON.stringify({ version: 1, workspaces: ['relative'], results: [] })]) {
    await writeFile(f.file, content);
    await backup.createBackup({ home: f.home, out: archive });
    await assert.rejects(backup.restoreBackup({ home: destination, file: archive, safety: false }), { code: 'BACKUP_INVALID' });
    assert.equal(await readFile(sentinel, 'utf8'), 'original');
  }
  await writeFile(f.file, good);
  await writeFile(f.file + '.initialized', 'truncated');
  await backup.createBackup({ home: f.home, out: archive });
  await assert.rejects(backup.restoreBackup({ home: destination, file: archive, safety: false }), { code: 'BACKUP_INVALID' });
  await writeFile(f.file + '.initialized', '1\n');
  await rm(f.file);
  await symlink(map, f.file);
  await backup.createBackup({ home: f.home, out: archive });
  await assert.rejects(backup.restoreBackup({ home: destination, file: archive, safety: false }), { code: 'BACKUP_INVALID' });
  assert.equal(await readFile(sentinel, 'utf8'), 'original');
  await rm(f.file);
  await writeFile(f.file, good);
  await backup.createBackup({ home: f.home, out: archive });
  const bytes = await readFile(archive);
  await writeFile(archive, bytes.subarray(0, bytes.length - 12));
  await assert.rejects(backup.restoreBackup({ home: destination, file: archive, safety: false }), { code: 'BACKUP_INVALID' });
  await assert.rejects(backup.restoreBackup({ home: destination, file: archive + '.missing', safety: false }), { code: 'BACKUP_NOT_FOUND' });
  assert.equal(await readFile(sentinel, 'utf8'), 'original');
});

test('mapping evidence is private and inert even with stale paths; each failed swap restores exact authority', async t => {
  const f = await fixture(t);
  const map = path.join(f.home, 'worktree-destinations.json');
  const evidence = JSON.stringify({ version: 1, mappings: [{ id: 'old', source: '/missing/source', commonDir: '/missing/git', parent: '/missing/parent' }] });
  await writeFile(map, evidence, { mode: 0o644 });
  const archive = path.join(f.root, 'authority.alpbackup');
  await backup.createBackup({ home: f.home, out: archive });
  const beforeLedger = await readFile(f.file, 'utf8');
  let count;
  await assert.rejects(backup.restoreBackup({ home: f.home, file: archive, safety: false, beforeSwap(_index, total) { count = total; throw new Error('stop'); } }), { code: 'RESTORE_FAILED' });
  for (let fail = 0; fail <= count; fail++) {
    await assert.rejects(backup.restoreBackup({ home: f.home, file: archive, safety: false, beforeSwap(index) { if (index === fail) throw new Error('stop'); } }), { code: 'RESTORE_FAILED' });
    assert.equal(await readFile(map, 'utf8'), evidence);
    assert.equal(await readFile(f.file, 'utf8'), beforeLedger);
    assert.equal(await readFile(f.file + '.initialized', 'utf8'), '1\n');
  }
  const quarantine = path.join(f.home, 'state', 'worktree-destinations.quarantined.json');
  await writeFile(quarantine, 'prior quarantine evidence', { mode: 0o600 });
  const restored = await backup.restoreBackup({ home: f.home, file: archive });
  assert.ok(restored.warnings.some(w => w.includes('explicit host approval')));
  assert.deepEqual(await worktreeMappings(f.home), []);
  assert.equal(await readFile(quarantine, 'utf8'), evidence);
  if (process.platform !== 'win32') assert.equal((await stat(quarantine)).mode & 0o777, 0o600);
  // The safety archive preserves originals, but replaying it is another sanitized restore.
  assert.ok((await backup.verifyBackup(restored.safety)).units.includes('worktree-destinations.json'));
  const { gunzipSync } = await import('node:zlib');
  const records = gunzipSync(await readFile(restored.safety)).toString().trimEnd().split('\n').map(JSON.parse);
  const evidenceIndex = records.findIndex(entry => entry.t === 'file' && entry.path === 'state/worktree-destinations.quarantined.json');
  assert.ok(evidenceIndex > 0, 'safety archive must retain replaced quarantine evidence');
  assert.equal(Buffer.from(records[evidenceIndex + 1].b, 'base64').toString(), 'prior quarantine evidence');
  await backup.restoreBackup({ home: f.home, file: restored.safety, safety: false });
  assert.deepEqual(await worktreeMappings(f.home), []);
  const settings = path.join(f.root, 'settings.alpbackup');
  await backup.createBackup({ home: f.home, out: settings, units: ['settings.json'] });
  await writeFile(map, evidence, { mode: 0o600 });
  const ledgerBeforeSettings = await readFile(f.file, 'utf8');
  await backup.restoreBackup({ home: f.home, file: settings, safety: false });
  assert.equal(await readFile(map, 'utf8'), evidence);
  assert.equal(await readFile(f.file, 'utf8'), ledgerBeforeSettings);
});

test('moved targets and replacement canonical identities are never certified by archive paths', async t => {
  const { rename, symlink } = await import('node:fs/promises');
  const f = await fixture(t);
  const archive = path.join(f.root, 'move.alpbackup');
  await backup.createBackup({ home: f.home, out: archive });
  const moved = path.join(f.root, 'moved-checkout');
  await rename(f.target, moved);
  const replacement = path.join(f.root, 'replacement');
  await mkdir(replacement);
  await symlink(replacement, f.target);
  await backup.restoreBackup({ home: f.home, file: archive, safety: false });
  const runtime = createAlpRuntime(f.options(f.home));
  try {
    await refused(runtime, moved);
    await refused(runtime, f.target);
    await refused(runtime, replacement);
    assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')).results, f.ledger.results);
  } finally { await runtime.shutdown(); }
});
