// A lifecycle token (state/alpd.starting/owner-…) used to name its owner by pid alone and the wait
// for it had no end (t-dc0e). When the owner crashed and its pid went to another process, every
// later start and stop of alpd waited forever. The token now carries a proof that the pid is
// still its owner, and the wait is bounded where no proof can be had.
//
// The tests cannot make the kernel hand out a chosen pid. They build what pid reuse leaves behind
// instead: the token a killed owner really wrote, renamed so that its pid is the pid of an
// unrelated process that runs. That is the state the code reads; how the pid got there is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import * as client from '../dist/index.js';
import { teardown } from '../../../test/support/teardown.js';

const { bootTime, holdOps, readDaemonLifecycle, withDaemonLifecycle } = client;
const windows = process.platform === 'win32';
const moduleUrl = new URL('../dist/index.js', import.meta.url).href;
/** What an ALP from before t-dc0e accepts as a token name: it must keep reading ours. */
const LEGACY_NAME = /^owner-(\d+)-(\d+)-(start|stop)-[a-f0-9-]+$/;
const PROOF = /-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})-(c\d+|b\d{14}|e)$/;

const stateOf = home => path.join(home, 'state');
const directoryOf = home => path.join(home, 'state', 'alpd.starting');
const holdOf = (home, id) => path.join(home, 'state', `alpd.lifecycle-${id}.held`);
/** Everything a lifecycle may leave in state/: the published directory, candidates and holds. */
const leftovers = async home => (await readdir(stateOf(home))).filter(name => name.startsWith('alpd.starting') || name.startsWith('alpd.lifecycle-'));

async function scratch(defer, prefix) {
  const home = await mkdtemp(path.join(os.tmpdir(), prefix));
  defer(() => rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return home;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
}

/** A process that is no alp command and holds nothing: the one that got the crashed owner's pid. */
async function unrelated(defer) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  defer(() => stop(child));
  await once(child, 'spawn');
  return child.pid;
}

/** A real process inside withDaemonLifecycle for `home`; it leaves on any message. */
async function holder(defer, home, action = 'start') {
  const fixture = path.join(home, `holder-${randomUUID()}.mjs`);
  await writeFile(fixture, `import { withDaemonLifecycle } from ${JSON.stringify(moduleUrl)};
    let release;
    const released = new Promise(resolve => { release = resolve; });
    process.on('message', release);
    await withDaemonLifecycle(${JSON.stringify(home)}, ${JSON.stringify(action)}, async () => {
      process.send({ holding: true });
      await released;
    });
    process.exit(0);`);
  const child = fork(fixture, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  defer(() => stop(child));
  const [message] = await Promise.race([
    once(child, 'message', { signal: AbortSignal.timeout(20_000) }),
    once(child, 'exit').then(([code]) => { throw new Error(`holder exited ${code}: ${stderr}`); }),
  ]);
  assert.equal(message.holding, true);
  const [token] = await readdir(directoryOf(home));
  return { child, token };
}

/**
 * Runs a lifecycle that must be admitted. The code before t-dc0e never returns here: the signal
 * ends that wait, so the test fails with the reason instead of hanging its file.
 */
async function admitted(home, action, options = {}) {
  const started = Date.now();
  try {
    return await withDaemonLifecycle(home, action, async () => 'admitted', { signal: AbortSignal.timeout(10_000), ...options });
  } catch (error) {
    if (error?.name !== 'AbortError' && error?.name !== 'TimeoutError') throw error;
    return assert.fail(`the lifecycle was still not admitted after ${Date.now() - started} ms: ${(await leftovers(home)).join(', ')}`);
  }
}

/** A lifecycle that must give up by itself with ALP_LIFECYCLE_BUSY, never run, and not hang. */
async function refused(home, action, options) {
  let ran = false;
  const outcome = await withDaemonLifecycle(home, action, async () => { ran = true; }, { signal: AbortSignal.timeout(10_000), ...options }).then(() => undefined, error => error);
  assert.equal(ran, false, 'the lifecycle must not be entered');
  assert.ok(outcome, 'the lifecycle must not be admitted');
  assert.equal(outcome.code, 'ALP_LIFECYCLE_BUSY', `gave up by its own deadline, not by the test's signal: ${outcome.name}: ${outcome.message}`);
  return outcome;
}

test('the token of a killed owner is reaped when its pid runs another process', { timeout: 60_000 }, async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lifecycle-reuse-');
  const reused = await unrelated(defer);
  // ps tells births to the second: the owner must not be born in the second of the process that
  // gets its pid. A real pid cannot come back that fast; two processes of one test can.
  await delay(1_100);
  const { child, token } = await holder(defer, home);
  assert.match(token, new RegExp(`^owner-${child.pid}-`));
  const id = PROOF.exec(token)?.[1];
  if (windows) assert.equal(holdOps.taken(holdOf(home, id)), true, 'the owner has its hold open');
  await stop(child);
  if (windows) assert.equal(holdOps.taken(holdOf(home, id)), false, 'the hold went with the owner');
  // The pid of the dead owner is now the pid of a process that has nothing to do with it.
  await rename(path.join(directoryOf(home), token), path.join(directoryOf(home), token.replace(`owner-${child.pid}-`, `owner-${reused}-`)));
  process.kill(reused, 0);

  assert.equal(await admitted(home, 'start'), 'admitted');
  assert.equal(await readDaemonLifecycle(home), undefined);
  assert.deepEqual(await leftovers(home), [], 'the dead owner left nothing behind');
});

test('a token proves its owner on this system, and an older ALP still reads its name', async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lifecycle-proof-');
  await withDaemonLifecycle(home, 'stop', async () => {
    const [token] = await readdir(directoryOf(home));
    assert.match(token, LEGACY_NAME);
    assert.match(token, new RegExp(`^owner-${process.pid}-\\d+-stop-`));
    // Linux reads /proc, other Unix systems ask ps, Windows holds a file: none may be missing
    // where the tests run, or the fix would do nothing there and no test would say so.
    assert.equal(PROOF.exec(token)?.[2]?.[0], windows ? 'e' : process.platform === 'linux' ? 'c' : 'b', token);
    const owner = await readDaemonLifecycle(home);
    assert.equal(owner.pid, process.pid);
    assert.equal(owner.action, 'stop');
  });
  // A service joins a start with a token of its own, not with the requester's.
  await withDaemonLifecycle(home, 'start', async () => {
    await withDaemonLifecycle(home, 'start', async () => {
      const tokens = await readdir(directoryOf(home));
      assert.equal(tokens.length, 2, 'the service joined the start');
      for (const token of tokens) assert.match(token, PROOF);
    }, { joinStart: true });
    assert.equal((await readdir(directoryOf(home))).length, 1);
  });
  assert.deepEqual(await leftovers(home), []);
});

test('a live owner keeps the lifecycle: the wait ends by itself, names it, and admission follows its release', { timeout: 60_000 }, async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lifecycle-live-');
  const { child, token } = await holder(defer, home);
  const error = await refused(home, 'stop', { waitMs: 500 });
  assert.equal(error.pid, child.pid);
  assert.match(error.message, new RegExp(`^Could not stop alpd: waited \\d+ s for another start of alpd \\(pid ${child.pid}\\) that still runs`));
  assert.deepEqual(await readdir(directoryOf(home)), [token], 'the owner was not reaped');
  assert.equal((await readDaemonLifecycle(home)).pid, child.pid);
  assert.deepEqual((await leftovers(home)).filter(name => name.startsWith('alpd.starting-')), [], 'the one that gave up left no candidate');

  const exited = once(child, 'exit');
  child.send('release');
  assert.equal((await exited)[0], 0);
  assert.equal(await admitted(home, 'stop'), 'admitted');
  assert.deepEqual(await leftovers(home), []);
});

test('a token without proof of a pid that runs is not taken: the wait is bounded and says what to remove', { timeout: 60_000 }, async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lifecycle-legacy-');
  const pid = await unrelated(defer);
  // What an ALP from before t-dc0e wrote, and what its crash leaves once its pid is taken.
  const token = `owner-${pid}-${bootTime()}-start-${randomUUID()}`;
  await mkdir(directoryOf(home), { recursive: true, mode: 0o700 });
  await writeFile(path.join(directoryOf(home), token), '');
  const file = path.join(directoryOf(home), token);
  const error = await refused(home, 'start', { waitMs: 400 });
  assert.equal(error.pid, pid);
  assert.ok(error.message.includes(`for a start of alpd recorded for pid ${pid}, and could not tell whether pid ${pid} is still that command`), error.message);
  assert.ok(error.message.includes(`remove ${file} and try again`), error.message);
  assert.deepEqual(await readdir(directoryOf(home)), [token], 'an owner that may be alive keeps its token');
  // Doing what the message says is enough.
  await rm(file);
  assert.equal(await admitted(home, 'start'), 'admitted');
  assert.deepEqual(await leftovers(home), []);
});

test('admission that cannot take the directory while nobody holds it gives up and says so', { timeout: 60_000 }, async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lifecycle-stuck-');
  const original = fs.rename;
  defer(() => { fs.rename = original; syncBuiltinESMExports(); });
  let attempts = 0;
  fs.rename = async function (from, to, ...rest) {
    if (String(to) !== directoryOf(home)) return original.call(this, from, to, ...rest);
    attempts += 1;
    throw Object.assign(new Error(`EACCES: permission denied, rename '${from}' -> '${to}'`), { code: 'EACCES' });
  };
  syncBuiltinESMExports();
  const error = await refused(home, 'start', { waitMs: 300 });
  assert.ok(attempts > 1, 'it tried again before giving up');
  assert.equal(error.pid, undefined);
  assert.match(error.message, /^Could not start alpd: .* \(EACCES\) although no alp command holds it/);
  assert.ok(error.message.includes(directoryOf(home)), error.message);
  assert.equal(error.cause?.code, 'EACCES');
  assert.deepEqual(await leftovers(home), [], 'no candidate is left');
});

test('processBirth is the same for one process, and gone with it', { skip: windows && 'Windows has no birth to read: the hold is its proof' }, async t => {
  const defer = teardown(t);
  const own = client.processBirth(process.pid);
  assert.match(own, process.platform === 'linux' ? /^c\d+$/ : /^b\d{14}$/);
  assert.equal(client.processBirth(process.pid), own);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  defer(() => stop(child));
  await once(child, 'spawn');
  const born = client.processBirth(child.pid);
  assert.match(born, /^[bc]\d+$/);
  // The caller's time zone and locale do not change the answer: two alp commands must agree.
  const saved = { TZ: process.env.TZ, LC_ALL: process.env.LC_ALL };
  defer(() => { for (const [name, value] of Object.entries(saved)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  process.env.TZ = 'Pacific/Kiritimati';
  process.env.LC_ALL = 'de_DE.UTF-8';
  assert.equal(client.processBirth(child.pid), born);
  await stop(child);
  assert.equal(client.processBirth(child.pid), undefined);
  assert.equal(client.processBirth(child.pid, { platform: 'win32' }), undefined);
  assert.equal(client.processBirth(0), undefined);
});

// The Windows hold with the handle replaced: `take` gives a fake descriptor, `taken` says what
// the test wants, `close` records. The real handle is in the tests above when they run on Windows.
function fakeOps({ taken = () => true } = {}) {
  const taking = [];
  const closed = [];
  return { taking, closed, ops: { take: file => { taking.push(file); return 7; }, taken, close: fd => { closed.push(fd); } } };
}

test('on Windows the owner holds a file for its token and lets go of it after the token', async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lifecycle-hold-');
  const { taking, closed, ops } = fakeOps();
  await withDaemonLifecycle(home, 'start', async () => {
    const [token] = await readdir(directoryOf(home));
    assert.match(token, LEGACY_NAME);
    const [, id, proof] = PROOF.exec(token);
    assert.equal(proof, 'e');
    assert.deepEqual(taking, [holdOf(home, id)], 'the hold is outside the directory that is renamed');
    assert.deepEqual(closed, [], 'the hold stays open while the token is there');
    assert.equal((await readDaemonLifecycle(home, { platform: 'win32', ops })).pid, process.pid);
  }, { platform: 'win32', ops });
  assert.deepEqual(closed, [7]);
  assert.deepEqual(await leftovers(home), []);
});

test('on Windows a hold that does not exclude a second open is no proof', async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lifecycle-weak-');
  const { closed, ops } = fakeOps({ taken: () => false });
  await withDaemonLifecycle(home, 'start', async () => {
    const [token] = await readdir(directoryOf(home));
    assert.doesNotMatch(token, PROOF, 'no marker that would prove nothing');
    assert.equal((await readDaemonLifecycle(home, { platform: 'win32', ops })).pid, process.pid, 'judged by its pid');
  }, { platform: 'win32', ops });
  assert.deepEqual(closed, [7]);
  assert.deepEqual(await leftovers(home), []);
});

test('on Windows a token whose hold is free is reaped although its pid runs; one whose hold is open stays', { timeout: 60_000 }, async t => {
  const defer = teardown(t);
  const home = await scratch(defer, 'alp-lifecycle-free-');
  const pid = await unrelated(defer);
  const id = randomUUID();
  const token = `owner-${pid}-${bootTime()}-stop-${id}-e`;
  await mkdir(directoryOf(home), { recursive: true, mode: 0o700 });
  await writeFile(path.join(directoryOf(home), token), '');
  await writeFile(holdOf(home, id), '');

  const held = fakeOps({ taken: () => true });
  const error = await refused(home, 'start', { waitMs: 300, platform: 'win32', ops: held.ops });
  assert.match(error.message, new RegExp(`for another stop of alpd \\(pid ${pid}\\) that still runs`));
  assert.deepEqual(await readdir(directoryOf(home)), [token]);
  // Elsewhere nobody can look at a Windows hold: the token is judged by its pid, and said so.
  assert.equal((await readDaemonLifecycle(home, { platform: 'linux' })).pid, pid);

  // The owner dies while a start waits behind it and its pid lives on: seen without a new token.
  let open = true;
  const dying = fakeOps({ taken: file => file === holdOf(home, id) ? open : true });
  const waiting = admitted(home, 'start', { waitMs: 9_000, platform: 'win32', ops: dying.ops });
  await delay(300);
  assert.deepEqual((await readdir(directoryOf(home))), [token], 'it waits while the hold is open');
  open = false;
  assert.equal(await waiting, 'admitted');
  assert.deepEqual(await leftovers(home), [], 'the token and the hold of the dead owner are gone');
});
