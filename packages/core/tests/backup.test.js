// Backups, restores and state migrations (ALPD §68): round trips, refused backups that leave the
// current data as it was, restores and migrations cut short, and state from a newer ALP.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync, gzipSync } from 'node:zlib';
import { createBackup, knownProjects, recoverInterruptedRestore, restoreBackup, verifyBackup, readRestoredMarker, clearRestoredMarker } from '../src/backup.js';
import { MIGRATIONS, migrateState } from '../src/migrations.js';
import { STATE_SCHEMA, readStateSchema } from '../src/state-schema.js';
import { createTask, loadTasks } from '../src/tasks.js';

const run = promisify(execFile);
const BACKUP_MODULE = new URL('../src/backup.js', import.meta.url).href;
const MIGRATIONS_MODULE = new URL('../src/migrations.js', import.meta.url).href;
const posix = process.platform !== 'win32';

/** Every file, directory and link under `root` by relative path; `backups/` is left out. */
async function tree(root) {
  const found = {};
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => [])) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (name === 'backups') continue;
      const full = path.join(root, name);
      if (entry.isSymbolicLink()) found[name] = `link:${await readlink(full)}`;
      else if (entry.isDirectory()) { found[name] = 'dir'; await walk(name); }
      else found[name] = createHash('sha256').update(await readFile(full)).digest('hex').slice(0, 16);
    }
  }
  await walk('');
  return found;
}

const record = (id, rootId, extra = {}) => JSON.stringify({ version: 1, id, rootId, status: 'closed', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', session: { id, runtime: 'codex', threadId: `thread-${id}`, projectRoot: extra.project }, spec: { cwd: extra.project } });

/** A home with sessions, a timeline, a receipt, settings and library, and one project with tasks. */
async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-backup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  const project = path.join(directory, 'project');
  await mkdir(path.join(home, 'state', 'sessions'), { recursive: true });
  await mkdir(path.join(home, 'state', 'timeline'), { recursive: true });
  await mkdir(path.join(home, 'state', 'receipts'), { recursive: true });
  await mkdir(path.join(home, 'skills', 'mine'), { recursive: true });
  await mkdir(path.join(home, 'logs'), { recursive: true });
  await writeFile(path.join(home, 'state', 'schema.json'), JSON.stringify({ schema: STATE_SCHEMA }));
  await writeFile(path.join(home, 'state', 'sessions', 'root-1.json'), record('root-1', 'root-1', { project }));
  await writeFile(path.join(home, 'state', 'sessions', 'child-1.json'), record('child-1', 'root-1', { project }));
  await writeFile(path.join(home, 'state', 'timeline', 'root-1.jsonl'), [1, 2, 3].map(cursor => JSON.stringify({ sessionId: 'root-1', epoch: 'e', seq: cursor, cursor, ts: 't', event: { type: 'item', text: 'xin chào ✓' } })).join('\n') + '\n');
  await writeFile(path.join(home, 'state', 'receipts', 'abc.json'), JSON.stringify({ version: 1, sessionId: 'root-1', clientMessageId: 'm1', fingerprint: 'f', state: 'completed', outcome: 'accepted', updatedAt: 't' }));
  await writeFile(path.join(home, 'state', 'live.json'), '[]');
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ language: 'Vietnamese' }));
  await writeFile(path.join(home, 'skills', 'mine', 'SKILL.md'), '---\nname: mine\n---\nbody\n');
  // A large file, so content spans several chunks.
  await writeFile(path.join(home, 'lessons.md'), Buffer.alloc(2.5 * 1024 * 1024, 'a'));
  await writeFile(path.join(home, 'logs', 'alpd.log'), 'not backed up\n');
  if (posix) await symlink('mine', path.join(home, 'skills', 'alias'));
  await mkdir(path.join(project, '.alp'), { recursive: true });
  await writeFile(path.join(project, 'ALP.md'), '# Project\n');
  await writeFile(path.join(project, '.alp', 'settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  await createTask(project, { title: 'first task' }, 'user');
  await createTask(project, { title: 'second task' }, 'user');
  return { directory, home, project };
}

test('a backup restores sessions, tasks and settings exactly, and the restore can be undone', async t => {
  const { directory, home, project } = await fixture(t);
  assert.deepEqual(await knownProjects(home), [project]);
  const homeBefore = await tree(home);
  const projectBefore = await tree(project);
  const file = path.join(directory, 'one.alpbackup');
  const summary = await createBackup({ home, out: file, projects: [project] });
  assert.equal(summary.sessions, 2);
  assert.equal(summary.tasks, 2);
  const contents = await verifyBackup(file);
  assert.equal(contents.stateSchema, STATE_SCHEMA);
  assert.deepEqual(contents.projects, [project]);
  assert.equal(contents.external, 2);
  assert.ok(!contents.units.includes('logs'));

  // Work goes on: a session goes, another comes, settings and tasks change.
  await rm(path.join(home, 'state', 'sessions', 'child-1.json'));
  await writeFile(path.join(home, 'state', 'sessions', 'root-2.json'), record('root-2', 'root-2', { project }));
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ language: 'English' }));
  await writeFile(path.join(home, 'state', 'live.json'), JSON.stringify([{ assignmentId: 'later' }]));
  await createTask(project, { title: 'third task' }, 'user');
  await rm(path.join(project, 'ALP.md'));
  const homeChanged = await tree(home);
  const projectChanged = await tree(project);

  const result = await restoreBackup({ home, file });
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.warnings, []);
  assert.ok(result.safety);
  // Live work of the later time is cleared, and alpd is told not to start anything by itself.
  const marker = await readRestoredMarker(home);
  await clearRestoredMarker(home);
  assert.equal(marker.from, file);
  const expected = { ...homeBefore };
  delete expected['state/live.json'];
  assert.deepEqual(await tree(home), expected);
  assert.deepEqual(await tree(project), projectBefore);
  assert.deepEqual((await loadTasks(project)).tasks.map(task => task.title).sort(), ['first task', 'second task']);
  assert.ok(!(await readdir(home)).some(name => name.startsWith('.restore-') || name === 'restore-journal.json'));

  // The automatic backup taken before the restore brings the later state back.
  await restoreBackup({ home, file: result.safety, safety: false });
  await clearRestoredMarker(home);
  const back = { ...homeChanged };
  delete back['state/live.json'];
  assert.deepEqual(await tree(home), back);
  assert.deepEqual(await tree(project), projectChanged);
});

test('corrupt, cut-short, tampered, missing and unsupported backups are refused and change nothing', async t => {
  const { directory, home, project } = await fixture(t);
  const file = path.join(directory, 'good.alpbackup');
  await createBackup({ home, out: file, projects: [project] });
  const good = await readFile(file);
  const lines = gunzipSync(good).toString('utf8').split('\n').filter(Boolean);
  const before = { home: await tree(home), project: await tree(project) };
  const write = async (name, body) => { const target = path.join(directory, name); await writeFile(target, body); return target; };
  const rebuild = list => gzipSync(list.map(line => `${line}\n`).join(''));

  const flipped = Buffer.from(good);
  flipped[Math.floor(flipped.length / 2)] ^= 0xff;
  const fileLine = lines.findIndex(line => JSON.parse(line).t === 'data');
  const tampered = [...lines];
  tampered[fileLine] = JSON.stringify({ t: 'data', b: Buffer.from('something else').toString('base64') });
  const header = JSON.parse(lines[0]);
  const cases = [
    ['flipped.alpbackup', flipped, /BACKUP_INVALID/],
    ['cut.alpbackup', good.subarray(0, Math.floor(good.length / 2)), /BACKUP_INVALID/],
    ['no-end.alpbackup', rebuild(lines.slice(0, -1)), /BACKUP_INVALID/],
    ['tampered.alpbackup', rebuild(tampered), /BACKUP_INVALID/],
    ['not-gzip.alpbackup', Buffer.from('hello'), /BACKUP_INVALID/],
    ['format.alpbackup', rebuild([JSON.stringify({ ...header, version: 99 }), ...lines.slice(1)]), /BACKUP_UNSUPPORTED/],
    ['schema.alpbackup', rebuild([JSON.stringify({ ...header, stateSchema: STATE_SCHEMA + 1 }), ...lines.slice(1)]), /BACKUP_SCHEMA_TOO_NEW/],
    ['escape.alpbackup', rebuild([JSON.stringify({ ...header, units: [...header.units, { path: '../outside', kind: 'file' }] }), ...lines.slice(1)]), /BACKUP_INVALID/],
  ];
  for (const [name, body, code] of cases) {
    const target = await write(name, body);
    await assert.rejects(verifyBackup(target), error => code.test(error.code), name);
    await assert.rejects(restoreBackup({ home, file: target }), error => code.test(error.code), name);
    assert.deepEqual({ home: await tree(home), project: await tree(project) }, before, `${name} left the data as it was`);
  }
  await assert.rejects(restoreBackup({ home, file: path.join(directory, 'missing.alpbackup') }), { code: 'BACKUP_NOT_FOUND' });
  assert.deepEqual(await tree(home), before.home);
  // No automatic backup was taken for a refused restore.
  assert.deepEqual(await readdir(path.join(home, 'backups')).catch(() => []), []);
});

test('a restore that fails part way is rolled back; one whose process dies is rolled back at the next start', async t => {
  const { directory, home, project } = await fixture(t);
  const file = path.join(directory, 'one.alpbackup');
  await createBackup({ home, out: file, projects: [project] });
  await rm(path.join(home, 'state', 'sessions', 'child-1.json'));
  await writeFile(path.join(home, 'settings.json'), '{"language":"English"}');
  await createTask(project, { title: 'later' }, 'user');
  const now = { home: await tree(home), project: await tree(project) };

  await assert.rejects(restoreBackup({ home, file, beforeSwap: index => { if (index === 4) throw new Error('disk full'); } }), { code: 'RESTORE_FAILED' });
  assert.deepEqual({ home: await tree(home), project: await tree(project) }, now);

  // Killed between swaps, in the home's units and after the project's tasks moved: the journal
  // remains, and the next restore or start rolls it back, task lock included.
  for (const at of [6, 26]) {
    const script = `import { restoreBackup } from ${JSON.stringify(BACKUP_MODULE)};
      await restoreBackup({ home: process.argv[1], file: process.argv[2], beforeSwap: index => { if (index === ${at}) process.kill(process.pid, 'SIGKILL'); } });`;
    await assert.rejects(run(process.execPath, ['--input-type=module', '-e', script, home, file]));
    const journal = JSON.parse(await readFile(path.join(home, 'restore-journal.json'), 'utf8'));
    assert.ok(journal.units.length > at, 'the kill happened between swaps');
    const recovered = await recoverInterruptedRestore(home);
    assert.equal(recovered.outcome, 'rolled back');
    assert.deepEqual({ home: await tree(home), project: await tree(project) }, now, `killed before swap ${at}`);
    assert.equal(await recoverInterruptedRestore(home), undefined);
  }
});

test('a restore past its commit is finished at the next start', async t => {
  const { home } = await fixture(t);
  const target = path.join(home, 'settings.json');
  const aside = `${target}.pre-restore-abc`;
  await writeFile(aside, '{"old":true}');
  await writeFile(path.join(home, 'restore-journal.json'), JSON.stringify({ id: 'abc', phase: 'committed', units: [{ unit: 'settings.json', target, aside, existed: true }], staging: [path.join(home, '.restore-abc')] }));
  assert.equal((await recoverInterruptedRestore(home)).outcome, 'completed');
  assert.equal(JSON.parse(await readFile(target, 'utf8')).language, 'Vietnamese');
  await assert.rejects(lstat(aside));
});

test('state of a newer schema is neither restored over nor migrated, and stays untouched', async t => {
  const { directory, home, project } = await fixture(t);
  const file = path.join(directory, 'one.alpbackup');
  await createBackup({ home, out: file, projects: [project] });
  await writeFile(path.join(home, 'state', 'schema.json'), JSON.stringify({ schema: STATE_SCHEMA + 1, by: 'alpd 9.9.9' }));
  const before = await tree(home);
  await assert.rejects(restoreBackup({ home, file }), { code: 'STATE_SCHEMA_TOO_NEW' });
  await assert.rejects(migrateState(home), error => error.code === 'STATE_SCHEMA_TOO_NEW' && /alpd 9\.9\.9/.test(error.message));
  assert.deepEqual(await tree(home), before);
  await writeFile(path.join(home, 'state', 'schema.json'), 'not json');
  await assert.rejects(migrateState(home), { code: 'STATE_SCHEMA_UNREADABLE' });
  // An unreadable marker is what a restore repairs.
  await restoreBackup({ home, file });
  assert.equal((await readStateSchema(home)).schema, STATE_SCHEMA);
});

/** A schema 1 state: no marker, and timeline lines from before cursors. */
async function legacyHome(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, 'home');
  await mkdir(path.join(home, 'state', 'sessions'), { recursive: true });
  await mkdir(path.join(home, 'state', 'timeline'), { recursive: true });
  await writeFile(path.join(home, 'state', 'sessions', 'r.json'), record('r', 'r', { project: directory }));
  for (const name of ['a', 'b', 'c']) {
    const lines = [{ seq: 1 }, { seq: 2, cursor: 5 }, { seq: 3 }, { seq: 4, cursor: 2 }].map(line => JSON.stringify({ sessionId: 'r', epoch: 'e', ts: 't', event: { type: 'item' }, ...line }));
    await writeFile(path.join(home, 'state', 'timeline', `${name}.jsonl`), [...lines.slice(0, 2), 'not json', ...lines.slice(2)].join('\n') + '\n');
  }
  return { directory, home };
}

const cursors = async (home, name) => (await readFile(path.join(home, 'state', 'timeline', `${name}.jsonl`), 'utf8')).split('\n').filter(Boolean).map(line => { try { return JSON.parse(line).cursor; } catch { return line; } });

test('schema 1 state is migrated: cursors written, marker set, a backup kept; running it again changes nothing', async t => {
  const { home } = await legacyHome(t);
  assert.deepEqual(await readStateSchema(home), { schema: 1, fresh: false, marked: false });
  const result = await migrateState(home, { by: 'test' });
  assert.deepEqual(result.steps.map(step => [step.name, step.from, step.to, step.resumed]), [['timeline-cursors', 1, 2, false]]);
  for (const name of ['a', 'b', 'c']) assert.deepEqual(await cursors(home, name), [1, 5, 'not json', 6, 7]);
  assert.equal((await readStateSchema(home)).schema, 2);
  assert.match(path.basename(result.steps[0].backup), /^pre-migrate-v1-v2-/);
  assert.equal((await verifyBackup(result.steps[0].backup)).stateSchema, 1);
  const after = await tree(home);
  assert.deepEqual((await migrateState(home)).steps, []);
  assert.deepEqual(await tree(home), after);
});

test('a migration cut short continues at the next start; a failing one is rolled back', async t => {
  const { home } = await legacyHome(t);
  const before = await tree(home);
  // The process dies after migrating one timeline of three.
  const script = `import { MIGRATIONS, migrateState } from ${JSON.stringify(MIGRATIONS_MODULE)};
    const [step] = MIGRATIONS;
    await migrateState(process.argv[1], { migrations: [{ ...step, async run(home) {
      const { readdir, rename, mkdir } = await import('node:fs/promises');
      const path = await import('node:path');
      const dir = path.join(home, 'state', 'timeline');
      await mkdir(path.join(home, 'hidden'));
      for (const name of ['b.jsonl', 'c.jsonl']) await rename(path.join(dir, name), path.join(home, 'hidden', name));
      await step.run(home);
      for (const name of ['b.jsonl', 'c.jsonl']) await rename(path.join(home, 'hidden', name), path.join(dir, name));
      process.kill(process.pid, 'SIGKILL');
    } }] });`;
  await assert.rejects(run(process.execPath, ['--input-type=module', '-e', script, home]));
  await rm(path.join(home, 'hidden'), { recursive: true });
  assert.deepEqual(await cursors(home, 'a'), [1, 5, 'not json', 6, 7]);
  assert.deepEqual(await cursors(home, 'b'), [undefined, 5, 'not json', undefined, 2]);
  assert.equal((await readStateSchema(home)).schema, 1);
  const journal = JSON.parse(await readFile(path.join(home, 'state', 'migration.json'), 'utf8'));
  const resumed = await migrateState(home);
  assert.deepEqual(resumed.steps.map(step => [step.name, step.resumed, step.backup]), [['timeline-cursors', true, journal.backup]]);
  for (const name of ['a', 'b', 'c']) assert.deepEqual(await cursors(home, name), [1, 5, 'not json', 6, 7]);
  await assert.rejects(lstat(path.join(home, 'state', 'migration.json')));

  // A step that throws: the state is put back from the backup taken before it.
  const { home: other } = await legacyHome(t);
  const original = await tree(other);
  const failing = [{ ...MIGRATIONS[0], async run(home) { await MIGRATIONS[0].run(home); throw new Error('cannot migrate'); } }];
  await assert.rejects(migrateState(other, { migrations: failing }), error => error.code === 'STATE_MIGRATION_FAILED' && /cannot migrate/.test(error.message));
  assert.deepEqual(await tree(other), original);
  assert.equal((await readStateSchema(other)).schema, 1);
  assert.equal((await readdir(path.join(other, 'backups'))).length, 1);
  void before;
});

test('a fresh home is marked with the current schema and needs no migration', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-fresh-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.deepEqual(await migrateState(directory), { from: STATE_SCHEMA, to: STATE_SCHEMA, steps: [] });
  assert.deepEqual(await readStateSchema(directory), { schema: STATE_SCHEMA, fresh: false, marked: true, by: 'alp' });
  await assert.rejects(lstat(path.join(directory, 'backups')));
});

test('a backup cannot write through its own links, list a unit twice, or leave a project .alp behind when refused', async t => {
  const { directory, home, project } = await fixture(t);
  const file = path.join(directory, 'good.alpbackup');
  await createBackup({ home, out: file, projects: [project] });
  const lines = gunzipSync(await readFile(file)).toString('utf8').split('\n').filter(Boolean);
  const header = JSON.parse(lines[0]);
  const outside = path.join(directory, 'outside');
  await mkdir(outside);
  /** A crafted backup with a consistent end, so only the new rules can refuse it. */
  const craft = async (name, list) => {
    const digest = createHash('sha256');
    let files = 0;
    let bytes = 0;
    for (const line of list) { digest.update(`${line}\n`); const record = JSON.parse(line); if (record.t === 'file') { files++; bytes += record.size; } }
    const target = path.join(directory, name);
    await writeFile(target, gzipSync([...list, JSON.stringify({ t: 'end', files, bytes, sha256: digest.digest('hex') })].map(line => `${line}\n`).join('')));
    return target;
  };
  const body = Buffer.from('escaped');
  const fileEntry = entryPath => [JSON.stringify({ t: 'file', area: 'home', path: entryPath, mode: 0o644, size: body.length, sha256: createHash('sha256').update(body).digest('hex'), chunks: 1 }), JSON.stringify({ t: 'data', b: body.toString('base64') })];
  const units = [{ path: 'skills', kind: 'dir' }, { path: 'settings.json', kind: 'file' }];
  const before = { home: await tree(home), project: await tree(project) };
  const cases = {
    'through-link.alpbackup': [JSON.stringify({ ...header, units, projects: [] }), JSON.stringify({ t: 'dir', area: 'home', path: 'skills', mode: 0o755 }), JSON.stringify({ t: 'link', area: 'home', path: 'skills/evil', target: outside }), ...fileEntry('skills/evil/pwned.txt'), ...fileEntry('settings.json')],
    'twice.alpbackup': [JSON.stringify({ ...header, units: [{ path: 'settings.json', kind: 'file' }, { path: 'settings.json', kind: 'file' }], projects: [] }), ...fileEntry('settings.json')],
    'nested.alpbackup': [JSON.stringify({ ...header, units: [{ path: 'skills', kind: 'dir' }, { path: 'skills/mine', kind: 'dir' }], projects: [] })],
    'repeated.alpbackup': [JSON.stringify({ ...header, units, projects: [] }), JSON.stringify({ t: 'dir', area: 'home', path: 'skills', mode: 0o755 }), ...fileEntry('settings.json'), ...fileEntry('settings.json')],
  };
  for (const [name, list] of Object.entries(cases)) {
    const target = await craft(name, list);
    await assert.rejects(restoreBackup({ home, file: target }), { code: 'BACKUP_INVALID' }, name);
    assert.deepEqual(await readdir(outside), [], `${name} wrote nothing outside`);
    assert.deepEqual({ home: await tree(home), project: await tree(project) }, before, `${name} changed nothing`);
    assert.ok(!(await readdir(home)).includes('restore-journal.json'));
  }

  // A project root without .alp: a refused restore does not leave one there.
  const bare = path.join(directory, 'bare');
  await mkdir(bare);
  const withBare = lines.map((line, index) => index === 0 ? JSON.stringify({ ...header, projects: [...header.projects, { root: bare, units: [{ path: 'ALP.md', kind: 'file' }] }] }) : line).filter(line => JSON.parse(line).t !== 'end');
  const broken = [...withBare.slice(0, -1), JSON.stringify({ t: 'file', area: 'project:1', path: 'ALP.md', mode: 0o644, size: 3, sha256: 'wrong', chunks: 1 }), JSON.stringify({ t: 'data', b: Buffer.from('abc').toString('base64') })];
  await assert.rejects(restoreBackup({ home, file: await craft('bare.alpbackup', broken) }), { code: 'BACKUP_INVALID' });
  assert.deepEqual(await readdir(bare), []);
});

test('a restore failing after the tasks moved rolls back under the task lock, marker included; --replace-newer replaces newer state after saving it', async t => {
  const { directory, home, project } = await fixture(t);
  const file = path.join(directory, 'one.alpbackup');
  await createBackup({ home, out: file, projects: [project] });
  await createTask(project, { title: 'later' }, 'user');
  await writeFile(path.join(home, 'state', 'migration.json'), '{"from":1,"to":2}');
  const now = { home: await tree(home), project: await tree(project) };
  // The commit fails after every swap and the marker: all of it, the tasks and the marker included, goes back.
  await assert.rejects(restoreBackup({ home, file, beforeSwap: (index, total) => { if (index === total) throw new Error('disk full'); } }), { code: 'RESTORE_FAILED' });
  assert.deepEqual({ home: await tree(home), project: await tree(project) }, now);
  assert.equal(await readRestoredMarker(home), undefined);
  // The task lock is free at once: a writer does not wait for it to go stale.
  await createTask(project, { title: 'right after' }, 'user');

  // A restore clears an unfinished migration's journal with the state it belonged to.
  await restoreBackup({ home, file });
  await assert.rejects(lstat(path.join(home, 'state', 'migration.json')));

  await writeFile(path.join(home, 'state', 'schema.json'), JSON.stringify({ schema: STATE_SCHEMA + 1 }));
  await assert.rejects(restoreBackup({ home, file }), error => error.code === 'STATE_SCHEMA_TOO_NEW' && /--replace-newer/.test(error.message));
  const result = await restoreBackup({ home, file, replaceNewer: true });
  assert.equal((await readStateSchema(home)).schema, STATE_SCHEMA);
  await assert.rejects(verifyBackup(result.safety), { code: 'BACKUP_SCHEMA_TOO_NEW' });
});
