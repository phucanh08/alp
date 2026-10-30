// A full disk (t-2831): alpd must not stop. On 2026-10-29 the disk filled and alpd ended
// in the middle of an assignment; its own log line failing with ENOSPC became an uncaught
// 'error' event. Now alpd pauses its work, keeps answering, and resumes once space returns.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect, readLock } from '@anhlp/alp-client';
import { initProject } from '@anhlp/alp-core/init';
import { createDiskGuard, isDiskError } from '@anhlp/alp-daemon';

const ALPD = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./support/fake-codex.js', import.meta.url));
const PRELOAD = pathToFileURL(fileURLToPath(new URL('./support/enospc-preload.mjs', import.meta.url))).href;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, what) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await sleep(25); }
  assert.fail(`${what} did not happen`);
}
const enospc = () => Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });

test('disk errors are ENOSPC, EDQUOT and EROFS, also wrapped', () => {
  for (const code of ['ENOSPC', 'EDQUOT', 'EROFS']) assert.equal(isDiskError(Object.assign(new Error(code), { code })), true);
  assert.equal(isDiskError(new Error('wrapped', { cause: enospc() })), true);
  for (const error of [new Error('x'), Object.assign(new Error('EACCES'), { code: 'EACCES' }), undefined, 'ENOSPC']) assert.equal(isDiskError(error), false);
});

function fakeRuntime() {
  const calls = [];
  let held = false;
  return {
    calls,
    holdForDisk(reason) { calls.push(['hold', reason]); held = true; },
    releaseDisk(by) { calls.push(['release', by]); held = false; },
    diskHeld: () => held,
    diskLow(free) { calls.push(['low', free]); },
    resumeByUser() { held = false; },
  };
}
const quiet = { warn() {}, info() {} };

test('the disk guard holds on a disk error, ignores others, and releases once writes work and space returns', async () => {
  const runtime = fakeRuntime();
  let free = 50 * 1024 ** 2;
  let writable = false;
  const guard = createDiskGuard({ home: '/nowhere', runtime, log: quiet, free: async () => free, probe: async () => { if (!writable) throw enospc(); } });
  assert.equal(guard.report(new Error('other')), false);
  assert.deepEqual(runtime.calls, []);
  assert.equal(guard.report(enospc()), true);
  assert.equal(guard.report(enospc()), true);
  assert.deepEqual(runtime.calls, [['hold', 'the disk is full']]);
  // Still full, then writable but under the resume margin: held.
  await guard.check();
  writable = true;
  await guard.check();
  assert.equal(runtime.diskHeld(), true);
  free = 5 * 1024 ** 3;
  // Two good checks in a row resume, so a borderline disk does not flap.
  await guard.check();
  assert.equal(runtime.diskHeld(), true);
  await guard.check();
  assert.deepEqual(runtime.calls.at(-1), ['release', 'alpd, after disk space returned']);
  assert.equal(guard.status().held, false);
  assert.equal(guard.status().last.free, free);
});

test('a log line about the full disk that itself fails does not hold again or recurse (review of t-2831)', () => {
  const runtime = fakeRuntime();
  let guard;
  let depth = 0;
  // The log writes to the full disk: its failure is reported straight back, as guardOutput does.
  const log = { warn() { if (++depth > 50) throw new Error('recursion'); guard.report(enospc()); }, info() {} };
  guard = createDiskGuard({ home: '/nowhere', runtime, log, free: async () => 0, probe: async () => { throw enospc(); } });
  assert.equal(guard.report(enospc()), true);
  assert.deepEqual(runtime.calls, [['hold', 'the disk is full']]);
  assert.equal(depth, 1);
  // While the user's pause keeps ALP's hold a no-op, further errors log nothing more.
  runtime.resumeByUser();
  guard.report(enospc());
  assert.equal(depth, 1);
});

test('a hanging disk check gives up and checks go on', async () => {
  const runtime = fakeRuntime();
  const guard = createDiskGuard({ home: '/nowhere', runtime, log: quiet, checkTimeoutMs: 20, free: () => new Promise(() => {}), probe: () => new Promise(() => {}) });
  await guard.check();
  await guard.check();
  assert.deepEqual(runtime.calls, []);
});

test('the disk guard warns once when space runs low and holds before it runs out', async () => {
  const runtime = fakeRuntime();
  let free = 1.5 * 1024 ** 3;
  const guard = createDiskGuard({ home: '/nowhere', runtime, log: quiet, free: async () => free, probe: async () => {} });
  await guard.check();
  await guard.check();
  assert.deepEqual(runtime.calls, [['low', '1.5 GB']]);
  free = 40 * 1024 ** 2;
  await guard.check();
  assert.deepEqual(runtime.calls.at(-1), ['hold', 'the disk is almost full (40 MB free)']);
  // The user resumed by hand while still full: alpd holds again at the next check.
  runtime.resumeByUser();
  await guard.check();
  assert.deepEqual(runtime.calls.at(-1), ['hold', 'the disk is almost full (40 MB free)']);
});

test('a real alpd on a full disk keeps running and answering, pauses its work, and resumes when space returns', { skip: process.platform === 'win32' && 'POSIX file descriptors' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-disk-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const flag = path.join(directory, 'disk-full');
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const logFile = path.join(directory, 'alpd.log');
  const log = openSync(logFile, 'a');
  const child = spawn(process.execPath, ['--import', PRELOAD, ALPD], {
    detached: true, stdio: ['ignore', log, log],
    env: { ...process.env, ALP_HOME: home, ALP_MODEL_CATALOG: 'static', ALP_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_JOURNAL: path.join(directory, 'provider.jsonl'), ALP_TEST_DISK_FULL: flag, ALP_DISK_CHECK_MS: '100' },
  });
  closeSync(log);
  let exit;
  const exited = once(child, 'exit').then(([code, signal]) => { exit = { code, signal }; });
  t.after(async () => { if (!exit) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await exited; } });
  await until(async () => {
    if (exit) assert.fail(`alpd exited (${JSON.stringify(exit)}):\n${await readFile(logFile, 'utf8')}`);
    return (await readLock(home))?.ready;
  }, 'alpd to be ready');
  const client = await connect((await readLock(home)).socket, { name: 'disk-test', version: '0' });
  t.after(() => client.close());
  // The disk fills while alpd runs.
  await writeFile(flag, '');
  // A session whose record cannot be written: on the old alpd the failed log line of that write ended the process.
  await client.request('session.create', { spec: { cwd: project, persist: true, model: 'codex:gpt-5.6-sol' } }).catch(() => {});
  await until(async () => (await client.request('daemon.pauses')).all?.cause === 'disk', 'the disk pause');
  const pause = (await client.request('daemon.pauses')).all;
  assert.deepEqual([pause.by, pause.reason], ['alpd', 'the disk is full']);
  // Long enough for the ready log line and several checks to fail.
  await sleep(500);
  assert.equal(exit, undefined, 'alpd must not stop on a full disk');
  // Reads go on while the disk is full.
  assert.ok(Array.isArray((await client.request('daemon.pauses')).parked));

  await unlink(flag);
  await until(async () => !(await client.request('daemon.pauses')).all, 'the disk pause to lift');
  assert.match(await readFile(logFile, 'utf8'), /ALP_DISK_BACK/);
  await client.request('daemon.shutdown').catch(() => {});
  await exited;
  assert.equal(exit.code, 0);
});
