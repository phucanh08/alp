import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const outer = await mkdtemp(path.join(tmpdir(), 'alp-integration-lock-'));
process.env.ALP_HOME = path.join(outer, 'outer-home');
await mkdir(process.env.ALP_HOME, { mode: 0o700 });
after(() => rm(outer, { recursive: true, force: true }));
// Any integration name works; the Paseo plugin passes `web` (its shutdown regression lives in integrations/paseo/tests).
const NAME = 'sample';
const worker = new URL('./support/integration-lock-worker.mjs', import.meta.url);
async function fixture(t) {
  const home = await mkdtemp(path.join(outer, 'home-'));
  const file = path.join(home, 'integrations', `${NAME}.lock`);
  await mkdir(path.dirname(file), { mode: 0o700 });
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(async child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = once(child, 'exit'); child.kill('SIGKILL'); await stopped;
    }));
  });
  async function start(gate = '', extraEnv = {}) {
    const child = fork(worker, [], { env: { ...process.env, ...extraEnv, ALP_HOME: home, ALP_LOCK_FIXTURE: outer, ALP_LOCK_GATE: gate, ALP_LOCK_NAME: NAME }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    children.push(child);
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
    const queued = [], waiting = [];
    child.on('message', message => { const next = waiting.shift(); next ? next(message) : queued.push(message); });
    const next = () => {
      if (queued.length) return Promise.resolve(queued.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('lock worker stalled: ' + stderr)), 10_000);
        waiting.push(message => { clearTimeout(timer); resolve(message); });
      });
    };
    assert.equal((await next()).event, 'started', stderr);
    return { child, next, send: command => child.send(command), async call(command) { child.send(command); return next(); } };
  }
  return { home, file, guard: file + '.reclaim', start };
}
async function age(file) { const old = new Date(Date.now() - 60_000); await utimes(file, old, old); }

for (const boundary of ['initialize', 'reclaim']) {
  test(`a stalled ${boundary} cannot admit a second live owner, regardless of age`, async t => {
    const f = await fixture(t);
    if (boundary === 'reclaim') {
      const dead = await f.start(); assert.equal((await dead.call({ command: 'acquire' })).value.acquired, true);
      const stopped = once(dead.child, 'exit'); dead.child.kill('SIGKILL'); await stopped;
      await age(f.file);
    }
    const first = await f.start(boundary);
    first.send({ command: 'acquire' }); assert.equal((await first.next()).event, 'gate');
    await age(f.file); await age(f.guard).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const second = await f.start(); second.send({ command: 'acquire' });
    const observed = await second.next();
    // New protocol waits on the real exclusive mkdir. Old age-pruning runs through to a result.
    assert.ok(['blocked', 'result'].includes(observed.event), JSON.stringify(observed));
    first.send({ command: 'resume' });
    const winner = await first.next(); assert.equal(winner.value.acquired, true);
    const loser = observed.event === 'result' ? observed : await second.next();
    assert.equal(loser.value.acquired, false, 'two live processes must never both return acquired=true');
    assert.doesNotThrow(() => process.kill(first.child.pid, 0));
    assert.doesNotThrow(() => process.kill(second.child.pid, 0));
    assert.equal(JSON.parse(await readFile(f.file, 'utf8')).pid, first.child.pid);
  });
}

test('complete killed owners recover, concurrent contenders converge, and normal release permits restart', async t => {
  const f = await fixture(t), dead = await f.start();
  assert.equal((await dead.call({ command: 'acquire' })).value.acquired, true);
  const stopped = once(dead.child, 'exit'); dead.child.kill('SIGKILL'); await stopped;
  const a = await f.start(), b = await f.start();
  a.send({ command: 'acquire' }); b.send({ command: 'acquire' });
  const result = async child => { let m; do { m = await child.next(); } while (m.event === 'blocked'); return m; };
  const [ra, rb] = await Promise.all([result(a), result(b)]);
  assert.deepEqual([ra.value.acquired, rb.value.acquired].sort(), [false, true]);
  const owner = ra.value.acquired ? a : b;
  assert.equal((await owner.call({ command: 'release' })).value, true);
  const retired = await owner.call({ command: 'acquire' }); assert.equal(retired.event, 'error'); assert.match(retired.message, /already been used/);
  const next = await f.start(); assert.equal((await next.call({ command: 'acquire' })).value.acquired, true);
});

test('malformed locks are retained and require manual recovery even when arbitrarily old', async t => {
  for (const raw of ['', 'malformed', '{"pid":0}', '{"pid":-1}', 'null']) {
    const f = await fixture(t); await writeFile(f.file, raw); await age(f.file);
    const contender = await f.start(); const result = await contender.call({ command: 'acquire' });
    assert.equal(result.event, 'error'); assert.match(result.message, /manual|recovery/i);
    assert.equal(await readFile(f.file, 'utf8'), raw);
  }
});

for (const marker of ['legacy-file', 'empty-directory', 'crashed-initializer', 'crashed-reclaimer']) {
  test(`${marker} guard cannot be stolen by age and is retained`, async t => {
    const f = await fixture(t);
    if (marker === 'legacy-file') await writeFile(f.guard, '');
    else if (marker === 'empty-directory') await mkdir(f.guard);
    else {
      if (marker === 'crashed-reclaimer') {
        const dead = await f.start(); await dead.call({ command: 'acquire' });
        const stopped = once(dead.child, 'exit'); dead.child.kill('SIGKILL'); await stopped;
      }
      const owner = await f.start(marker === 'crashed-initializer' ? 'initialize' : 'reclaim');
      owner.send({ command: 'acquire' }); assert.equal((await owner.next()).event, 'gate');
      const stopped = once(owner.child, 'exit'); owner.child.kill('SIGKILL'); await stopped;
    }
    await age(f.guard); const before = await stat(f.guard);
    const contender = await f.start(); contender.send({ command: 'acquire' });
    assert.equal((await contender.next()).event, 'blocked');
    assert.equal((await stat(f.guard)).ino, before.ino);
    // Kill the waiter while blocked; no owner death/age is permission to remove this marker.
    const stopped = once(contender.child, 'exit'); contender.child.kill('SIGKILL'); await stopped;
    assert.equal((await stat(f.guard)).ino, before.ino);
  });
}

test('ready publication, clearing and release serialize, with no lock resurrection', async t => {
  const f = await fixture(t), owner = await f.start('ready');
  assert.equal((await owner.call({ command: 'acquire' })).value.acquired, true);
  owner.send({ command: 'ready', ready: true }); assert.equal((await owner.next()).event, 'gate');
  owner.send({ command: 'release' }); assert.equal((await owner.next()).event, 'blocked');
  owner.send({ command: 'resume' });
  const first = await owner.next(), second = await owner.next();
  assert.equal(first.value, true); assert.equal(second.value, true);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  assert.equal((await owner.call({ command: 'ready', ready: false })).value, false);
  await assert.rejects(readFile(f.file), { code: 'ENOENT' });
  const next = await f.start(); await next.call({ command: 'acquire' });
  assert.equal((await next.call({ command: 'ready', ready: true })).value, true);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).ready, true);
  assert.equal((await next.call({ command: 'ready', ready: false })).value, true);
  assert.equal(JSON.parse(await readFile(f.file, 'utf8')).ready, false);
});

test('readiness and release cannot overwrite or remove a replacement, even for the same PID', async t => {
  for (const sameContents of [false, true]) {
    const f = await fixture(t), owner = await f.start(); await owner.call({ command: 'acquire' });
    const raw = await readFile(f.file, 'utf8'); const replacement = JSON.parse(raw);
    if (!sameContents) replacement.owner = 'replacement-owner';
    await writeFile(f.file + '.replacement', JSON.stringify(replacement)); await rename(f.file + '.replacement', f.file);
    const before = await stat(f.file);
    assert.equal((await owner.call({ command: 'ready', ready: true })).value, false);
    assert.equal((await owner.call({ command: 'release' })).value, false);
    assert.equal((await stat(f.file)).ino, before.ino);
    assert.equal(await readFile(f.file, 'utf8'), JSON.stringify(replacement));
  }
});


test('legacy live locks survive boot drift and live PID reuse; EPERM and unknown liveness fail closed', async t => {
  for (const code of ['', 'EPERM', 'EIO']) {
    const f = await fixture(t);
    const legacy = { pid: process.pid, bootTime: 1, startedAt: new Date().toISOString(), ready: false };
    const raw = JSON.stringify(legacy); await writeFile(f.file, raw); await age(f.file);
    const contender = await f.start('', { ALP_LOCK_KILL_ERROR: code });
    const result = await contender.call({ command: 'acquire' });
    assert.equal(result.event, 'result'); assert.equal(result.value.acquired, false);
    assert.equal(await readFile(f.file, 'utf8'), raw);
  }
});

test('complete legacy dead locks remain automatically recoverable', async t => {
  const f = await fixture(t), dead = await f.start(); await dead.call({ command: 'acquire' });
  const legacy = JSON.parse(await readFile(f.file, 'utf8')); delete legacy.owner; delete legacy.lockVersion;
  await writeFile(f.file, JSON.stringify(legacy));
  const stopped = once(dead.child, 'exit'); dead.child.kill('SIGKILL'); await stopped;
  const next = await f.start(); const result = await next.call({ command: 'acquire' });
  assert.equal(result.value.acquired, true); assert.equal(result.value.lock.pid, next.child.pid);
});

for (const boundary of ['guard-initialize', 'guard-cleanup']) {
  for (const crash of [false, true]) {
    test(`${boundary} ${crash ? 'crash' : 'stall'} retains exclusion before/after its token exists`, async t => {
      const f = await fixture(t), owner = await f.start(boundary);
      owner.send({ command: 'acquire' }); assert.equal((await owner.next()).event, 'gate');
      await age(f.guard);
      if (crash) { const stopped = once(owner.child, 'exit'); owner.child.kill('SIGKILL'); await stopped; }
      const before = await stat(f.guard);
      const second = await f.start(); second.send({ command: 'acquire' });
      assert.equal((await second.next()).event, 'blocked');
      assert.equal((await stat(f.guard)).ino, before.ino);
      if (!crash) {
        owner.send({ command: 'resume' }); assert.equal((await owner.next()).value.acquired, true);
        assert.equal((await second.next()).value.acquired, false);
      }
    });
  }
}

test('a stale guard finalizer missing its token never rmdirs a successor stalled before token creation', async t => {
  const f = await fixture(t), old = await f.start('guard-unlink');
  old.send({ command: 'acquire' }); assert.equal((await old.next()).event, 'gate');
  // Deliberate out-of-protocol replacement tests defensive cleanup, not permission for live repair.
  await rename(f.guard, f.guard + '.old');
  const next = await f.start('guard-initialize'); next.send({ command: 'acquire' });
  assert.equal((await next.next()).event, 'gate'); const before = await stat(f.guard);
  old.send({ command: 'resume' }); const lost = await old.next();
  assert.equal(lost.event, 'error'); assert.match(lost.message, /ownership was lost/);
  assert.equal((await stat(f.guard)).ino, before.ino);
  next.send({ command: 'resume' }); assert.equal((await next.next()).value.acquired, false);
});

for (const point of ['main-write', 'main-stat', 'main-close', 'guard-open', 'guard-close', 'guard-unlink', 'guard-rmdir']) {
  test(`acquisition ${point} failure never reports ownership and closes opened descriptors`, async t => {
    const f = await fixture(t), owner = await f.start('', { ALP_LOCK_FAIL: point });
    const result = await owner.call({ command: 'acquire' }); assert.equal(result.event, 'error');
    const state = (await owner.call({ command: 'state' })).value; assert.equal(state.opened, state.closed);
    assert.equal((await owner.call({ command: 'ready', ready: true })).value, false);
    assert.equal((await owner.call({ command: 'release' })).value, false);
    if (point.startsWith('guard-')) {
      assert.match(result.message, /manual lock-only recovery/); await stat(f.guard);
      const second = await f.start(); second.send({ command: 'acquire' }); assert.equal((await second.next()).event, 'blocked');
    } else {
      await assert.rejects(stat(f.guard), { code: 'ENOENT' });
      const next = await f.start(); assert.equal((await next.call({ command: 'acquire' })).event, point === 'main-write' ? 'error' : 'result');
    }
  });
}

for (const point of ['ready-write', 'ready-stat', 'ready-close', 'ready-rename', 'release-unlink']) {
  test(`${point} failure retains the existing mainfile and closes opened descriptors`, async t => {
    const f = await fixture(t), owner = await f.start('', { ALP_LOCK_FAIL: point });
    assert.equal((await owner.call({ command: 'acquire' })).value.acquired, true);
    const before = await readFile(f.file, 'utf8'); const identity = await stat(f.file);
    const result = await owner.call({ command: point === 'release-unlink' ? 'release' : 'ready', ready: true });
    assert.equal(result.event, 'error');
    assert.equal(await readFile(f.file, 'utf8'), before); assert.equal((await stat(f.file)).ino, identity.ino);
    const state = (await owner.call({ command: 'state' })).value; assert.equal(state.opened, state.closed);
    await assert.rejects(stat(f.guard), { code: 'ENOENT' });
  });
}


test('unsupported metadata and dead owners with uncertain boot context are retained', async t => {
  for (const unknownVersion of [false, true]) {
    const f = await fixture(t), dead = await f.start(); await dead.call({ command: 'acquire' });
    const value = JSON.parse(await readFile(f.file, 'utf8'));
    if (unknownVersion) value.lockVersion = 999;
    else value.bootTime = 1;
    const raw = JSON.stringify(value); await writeFile(f.file, raw);
    const stopped = once(dead.child, 'exit'); dead.child.kill('SIGKILL'); await stopped;
    const next = await f.start(); const result = await next.call({ command: 'acquire' });
    assert.equal(result.event, 'error'); assert.match(result.message, /manual lock-only recovery/);
    assert.equal(await readFile(f.file, 'utf8'), raw);
  }
});

test('the name selects integrations/<name>.lock and its guard; names are single path segments', async () => {
  const { createIntegrationLock } = await import('@anhlp/alp-client/integration-lock');
  for (const bad of [undefined, '', 'Web', '../web', 'a/b', 'a\\b', '.hidden', 'web.lock', '-web']) {
    assert.throws(() => createIntegrationLock(outer, bad), TypeError, String(bad));
  }
  const home = await mkdtemp(path.join(outer, 'names-'));
  const paseo = createIntegrationLock(home, 'paseo'), web = createIntegrationLock(home, 'web');
  // Distinct names are distinct locks: one process may own both.
  assert.equal((await paseo.acquire()).acquired, true);
  assert.equal((await web.acquire()).acquired, true);
  assert.equal(JSON.parse(await readFile(path.join(home, 'integrations/paseo.lock'), 'utf8')).pid, process.pid);
  assert.equal(JSON.parse(await readFile(path.join(home, 'integrations/web.lock'), 'utf8')).pid, process.pid);
  // A second instance for a live owner's name is refused and reports that owner.
  const again = await createIntegrationLock(home, 'paseo').acquire();
  assert.deepEqual([again.acquired, again.lock.pid], [false, process.pid]);
  assert.equal(await paseo.release(), true);
  await assert.rejects(stat(path.join(home, 'integrations/paseo.lock')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(home, 'integrations/paseo.lock.reclaim')), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(path.join(home, 'integrations/web.lock'), 'utf8')).pid, process.pid);
  // Recovery errors name the selected lock and guard.
  await writeFile(path.join(home, 'integrations/broken.lock'), 'malformed');
  await assert.rejects(createIntegrationLock(home, 'broken').acquire(), error => {
    assert.ok(error.message.includes(path.join(home, 'integrations/broken.lock')) && error.message.includes('broken.lock.reclaim'), error.message);
    return true;
  });
  assert.equal(await web.release(), true);
});
