// Backup, restore, migration and downgrade with a real alpd (ALPD §68): a fake Codex app-server
// stands in for the provider, `alp backup` and `alp restore` run as the user runs them, and alpd
// is started on the result. No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { initProject } from '../../packages/core/src/init.js';
import { closeTask, createTask, loadTasks } from '../../packages/core/src/tasks.js';
import { createBackup } from '../../packages/core/src/backup.js';
import { connect, lockAlive, readLock } from '../../packages/client/src/index.js';

const ALPD = fileURLToPath(new URL('../../dist/alpd.js', import.meta.url));
const CLI = fileURLToPath(new URL('../../packages/cli/src/cli.js', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('../../packages/daemon/tests/support/fake-codex.js', import.meta.url));
const BACKUP_MODULE = fileURLToPath(new URL('../../packages/core/src/backup.js', import.meta.url));
const MODEL = 'codex:gpt-5.6-sol';
const skip = process.platform === 'win32' && 'POSIX processes and sockets only';
const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = body => [{ type: 'text', text: body }];

async function until(check, what) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await sleep(25); }
  assert.fail(`${what} did not happen`);
}

/** Every file under `root` with its hash; logs, backups and alpd's process files are left out. */
async function tree(root) {
  const found = {};
  async function walk(relative) {
    for (const entry of await readdir(path.join(root, relative), { withFileTypes: true }).catch(() => [])) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (['logs', 'backups', 'alpd.lock', 'alpd.sock', 'alpd.json', 'state/alpd.running', 'state/alpd.held'].includes(name)) continue;
      if (entry.isDirectory()) { found[name] = 'dir'; await walk(name); }
      else found[name] = createHash('sha256').update(await readFile(path.join(root, name))).digest('hex').slice(0, 16);
    }
  }
  await walk('');
  return found;
}

async function harness(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-backup-it-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ language: 'English' }));
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const logFile = path.join(directory, 'alpd.log');
  const env = { ...process.env, ALP_HOME: home, ALP_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_JOURNAL: path.join(directory, 'provider.jsonl'), ALP_SUPERVISE: '0' };
  const started = [];

  /** alpd as `alpd --detach` leaves it: its own process group, output to a log. Resolves once ready, or with its exit. */
  async function start({ expectExit = false } = {}) {
    const log = openSync(logFile, 'a');
    const child = spawn(process.execPath, [ALPD], { detached: true, stdio: ['ignore', log, log], env });
    closeSync(log);
    started.push(child);
    const exited = once(child, 'exit').then(([code]) => code);
    if (expectExit) return { code: await exited };
    let gone = false;
    void exited.then(() => { gone = true; });
    await until(async () => {
      if (gone) assert.fail(`alpd exited while starting:\n${await readFile(logFile, 'utf8')}`);
      const lock = await readLock(home);
      return lock?.ready && lock.pid === child.pid;
    }, 'alpd to be ready');
    const client = await connect((await readLock(home)).socket, { name: 'backup-test', version: '0' });
    return {
      pid: child.pid,
      request: (method, params) => client.request(method, params),
      async stop() { await client.request('daemon.shutdown').catch(() => {}); client.close(); await exited; },
    };
  }

  /** `alp …` as the user runs it, against this home. */
  const alp = (...args) => execute(process.execPath, [CLI, ...args], { env, cwd: directory }).then(({ stdout }) => stdout, error => { throw Object.assign(error, { message: `${error.message}\n${error.stdout}${error.stderr}` }); });
  /** alp doctor --json, with no provider on PATH to probe; it exits 1 when a check fails. */
  const doctor = () => execute(process.execPath, [CLI, 'doctor', '--json'], { env: { ...env, PATH: path.join(directory, 'empty') }, cwd: directory })
    .then(({ stdout }) => JSON.parse(stdout), error => JSON.parse(error.stdout));
  /** Log records of the alpd processes this test started and of those `alp` started (they log in the home). */
  const logRecords = async () => [logFile, path.join(home, 'logs', 'alpd.log')]
    .flatMap(async file => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line)))
    .reduce(async (all, part) => [...await all, ...await part], []);

  t.after(async () => {
    for (const child of started) if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    for (const line of (await readFile(env.FAKE_CODEX_JOURNAL, 'utf8').catch(() => '')).split('\n').filter(Boolean)) try { process.kill(JSON.parse(line).pid, 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { directory, home, project, start, alp, doctor, logRecords, create: (daemon, params = {}) => daemon.request('session.create', { spec: { cwd: project, persist: true, model: MODEL }, ...params }) };
}

test('alp backup and alp restore round-trip sessions, receipts, timelines, tasks and settings through alpd', { skip }, async t => {
  const h = await harness(t);
  const first = await h.start();
  const { session } = await h.create(first);
  assert.equal((await first.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('kept') })).outcome, 'accepted');
  await until(async () => (await first.request('session.list', { includeClosed: true })).sessions.find(row => row.id === session.id)?.status === 'idle', 'the turn to end');
  await first.request('session.rename', { sessionId: session.id, title: 'before the backup' });
  const kept = await createTask(h.project, { title: 'kept task' }, 'user');
  await first.stop();
  const homeAtBackup = await tree(h.home);
  const tasksAtBackup = (await loadTasks(h.project)).tasks;

  // Taken while alpd is stopped; the project is found from the sessions.
  const file = path.join(h.directory, 'all.alpbackup');
  assert.match(await h.alp('backup', '-o', file), /1 session record.*1 task in 1 project/s);
  assert.match(await h.alp('backup', 'verify', file), /complete and intact/);

  // Work goes on after the backup: a second session, a closed task, a changed setting.
  const second = await h.start();
  const { session: later } = await h.create(second);
  await second.request('session.prompt', { sessionId: later.id, clientMessageId: 'm2', content: text('later') });
  await closeTask(h.project, kept.id, { reason: 'done' }, 'user');
  await createTask(h.project, { title: 'later task' }, 'user');
  await writeFile(path.join(h.home, 'settings.json'), JSON.stringify({ language: 'Vietnamese' }));

  // alpd is running: the restore asks for --stop rather than replacing data under it.
  await assert.rejects(h.alp('restore', file), /alpd is running.*--stop/s);
  const restored = await h.alp('restore', file, '--stop');
  assert.match(restored, /restored .*all\.alpbackup/);
  assert.match(restored, /alp restore .*pre-restore-.*puts it back/);
  await until(async () => { const lock = await readLock(h.home); return lockAlive(lock) && lock.ready && lock.pid !== second.pid; }, 'alpd to start again');

  const third = await (async () => {
    const lock = await readLock(h.home);
    const client = await connect(lock.socket, { name: 'backup-test', version: '0' });
    t.after(async () => { await client.request('daemon.shutdown').catch(() => {}); client.close(); await until(async () => !lockAlive(await readLock(h.home)), 'alpd to stop'); });
    return { request: (method, params) => client.request(method, params) };
  })();
  const { sessions } = await third.request('session.list', { includeClosed: true });
  assert.deepEqual(sessions.map(row => [row.id, row.title]), [[session.id, 'before the backup']]);
  // The receipt came back with its timeline: a retried prompt is answered, not sent again.
  await h.create(third, { sessionId: session.id });
  const repeat = await third.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('kept') });
  assert.equal(repeat.duplicate, true);
  assert.deepEqual((await loadTasks(h.project)).tasks.map(task => [task.id, task.status, task.title]), tasksAtBackup.map(task => [task.id, task.status, task.title]));
  assert.equal(JSON.parse(await readFile(path.join(h.home, 'settings.json'), 'utf8')).language, 'English');
  assert.ok((await h.logRecords()).some(record => record.code === 'ALP_STATE_RESTORED'));
  assert.ok(homeAtBackup['state/schema.json']);
});

test('state from a newer ALP: alpd refuses to start and changes nothing; alp restore refuses too', { skip }, async t => {
  const h = await harness(t);
  const daemon = await h.start();
  await h.create(daemon);
  await daemon.stop();
  const file = path.join(h.directory, 'older.alpbackup');
  await h.alp('backup', '-o', file);
  await writeFile(path.join(h.home, 'state', 'schema.json'), JSON.stringify({ schema: 99, by: 'alpd 9.0.0' }));
  const before = await tree(h.home);

  const { code } = await h.start({ expectExit: true });
  assert.equal(code, 1);
  const failure = (await h.logRecords()).find(record => record.level === 'error' && record.phase === 'state');
  assert.equal(failure.code, 'ALP_STATE_SCHEMA_TOO_NEW');
  assert.match(failure.msg, /alpd 9\.0\.0/);
  assert.deepEqual(await tree(h.home), before);
  assert.equal(lockAlive(await readLock(h.home)), false);

  await assert.rejects(h.alp('restore', file), /STATE_SCHEMA_TOO_NEW|schema 99/);
  assert.deepEqual(await tree(h.home), before);
  assert.equal((await h.doctor()).checks.find(check => check.id === 'schema').status, 'fail');
});

test('alpd migrates schema 1 state at start, keeps a backup of it, and continues a migration cut short', { skip }, async t => {
  const h = await harness(t);
  const daemon = await h.start();
  const { session } = await h.create(daemon);
  await daemon.request('session.prompt', { sessionId: session.id, clientMessageId: 'm1', content: text('legacy') });
  await until(async () => (await daemon.request('session.list', { includeClosed: true })).sessions.find(row => row.id === session.id)?.status === 'idle', 'the turn to end');
  await daemon.stop();
  // Make it a schema 1 state as an ALP before 0.11 left it: no marker, timeline lines without cursors.
  const timeline = path.join(h.home, 'state', 'timeline', `${session.id}.jsonl`);
  const lines = (await readFile(timeline, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  await writeFile(timeline, lines.map(({ cursor, ...line }) => `${JSON.stringify(line)}\n`).join(''));
  await rm(path.join(h.home, 'state', 'schema.json'));
  // A migration cut short: its journal and backup are there, the marker is not.
  const backup = path.join(h.home, 'backups', 'pre-migrate-v1-v2-cut.alpbackup');
  await createBackup({ home: h.home, out: backup, units: ['state/schema.json', 'state/sessions', 'state/timeline', 'state/receipts'], kind: 'pre-migrate' });
  await writeFile(path.join(h.home, 'state', 'migration.json'), JSON.stringify({ from: 1, to: 2, name: 'timeline-cursors', backup }));

  const migrated = await h.start();
  t.after(() => migrated.stop());
  const record = (await h.logRecords()).find(entry => entry.code === 'ALP_STATE_MIGRATED');
  assert.match(record.msg, /schema 1 to 2/);
  assert.equal(JSON.parse(await readFile(path.join(h.home, 'state', 'schema.json'), 'utf8')).schema, 2);
  assert.deepEqual((await readFile(timeline, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line).cursor), lines.map(line => line.cursor));
  assert.deepEqual(await readdir(path.join(h.home, 'backups')), ['pre-migrate-v1-v2-cut.alpbackup']);
  // A cursor a client held before the migration still replays from where it was.
  await h.create(migrated, { sessionId: session.id });
  const attached = await migrated.request('session.attach', { sessionId: session.id, after: lines.at(-1).cursor });
  assert.notEqual(attached.reset, true);
  assert.ok(attached.cursor >= lines.at(-1).cursor);
});

test('a restore killed part way is rolled back when alpd next starts', { skip }, async t => {
  const h = await harness(t);
  const daemon = await h.start();
  const { session } = await h.create(daemon);
  await daemon.stop();
  const file = path.join(h.directory, 'one.alpbackup');
  await h.alp('backup', '-o', file);
  await writeFile(path.join(h.home, 'settings.json'), JSON.stringify({ language: 'Vietnamese' }));
  const before = await tree(h.home);
  const script = `import { restoreBackup } from ${JSON.stringify(BACKUP_MODULE)};
    await restoreBackup({ home: process.argv[1], file: process.argv[2], beforeSwap: index => { if (index === 5) process.kill(process.pid, 'SIGKILL'); } });`;
  await assert.rejects(execute(process.execPath, ['--input-type=module', '-e', script, h.home, file]));
  assert.ok((await readdir(h.home)).includes('restore-journal.json'));
  assert.equal((await h.doctor()).checks.find(check => check.id === 'restore').status, 'warn');

  const next = await h.start();
  t.after(() => next.stop());
  assert.ok((await h.logRecords()).some(record => record.code === 'ALP_RESTORE_SETTLED'));
  const { sessions } = await next.request('session.list', { includeClosed: true });
  assert.deepEqual(sessions.map(row => row.id), [session.id]);
  const after = await tree(h.home);
  assert.equal(after['settings.json'], before['settings.json']);
  assert.ok(!Object.keys(after).some(name => name.includes('pre-restore-') || name.startsWith('.restore-')));
});
