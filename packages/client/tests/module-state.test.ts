// The test seams on module state (_setBootIdForTest, holdOps) are exported by the package entry;
// whatever module owns that state, setting it through the entry must reach every caller inside the
// client: the daemon lock, the lifecycle and the integration checks (t-8cd6.6).
import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { _setBootIdForTest, acquireDaemonLock, bootTime, holdOps, integrationAlive, isSameBoot, lockAlive, readDaemonLifecycle, releaseDaemonLock } from '../dist/index.js';

/**
 * Teardown in reverse order of setup: node:test runs t.after hooks FIFO and stops at the first that
 * throws, so every step runs here and the first error is rethrown (ALP.md, node:test teardown order).
 */
function teardown(t: TestContext) {
  const steps: Array<() => unknown> = [];
  t.after(async () => {
    let failure;
    for (const step of steps.reverse()) try { await step(); } catch (error) { failure ??= error; }
    if (failure) throw failure;
  });
  return (step: () => unknown) => { steps.push(step); };
}

test.afterEach(() => {
  _setBootIdForTest(null);
});

test('a boot id set through the entry is the one the lock, lockAlive and integrationAlive use', async (t) => {
  const defer = teardown(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-module-state-'));
  defer(() => rm(home, { recursive: true, force: true }));
  _setBootIdForTest('module-state-boot');
  const lock = await acquireDaemonLock(home, { version: 'test', protocolVersion: 1, socket: path.join(home, 'test.sock') });
  defer(() => releaseDaemonLock(home));
  assert.equal(lock.bootId, 'module-state-boot');
  const now = bootTime();
  assert.equal(isSameBoot({ bootId: 'module-state-boot', bootTime: now - 1000 }), true);
  assert.equal(lockAlive({ pid: process.pid, bootId: 'module-state-boot', bootTime: now - 1000 }), true);
  assert.equal(integrationAlive({ pid: process.pid, bootId: 'module-state-boot', bootTime: now - 1000 }), true);
  assert.equal(lockAlive({ pid: process.pid, bootId: 'another-boot', bootTime: now }), false);
  assert.equal(integrationAlive({ pid: process.pid, bootId: 'another-boot', bootTime: now }), false);
});

test('a holdOps.taken replaced through the entry is the one lockAlive and readDaemonLifecycle consult', async (t) => {
  const defer = teardown(t);
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-module-state-'));
  defer(() => rm(home, { recursive: true, force: true }));
  const original = holdOps.taken;
  const asked: string[] = [];
  holdOps.taken = (file: string) => { asked.push(file); return false; };
  defer(() => { holdOps.taken = original; });
  assert.equal(lockAlive({ pid: process.pid, bootTime: bootTime(), hold: 'the-hold' }, { platform: 'win32' }), false);
  assert.deepEqual(asked, ['the-hold']);
  // A lifecycle owner proven by a Windows hold ('e'): the replaced probe says nobody holds it.
  const directory = path.join(home, 'state', 'alpd.starting');
  await mkdir(directory, { recursive: true });
  const id = '00000000-0000-4000-8000-000000000001';
  await writeFile(path.join(directory, `owner-${process.pid}-${bootTime()}-start-${id}-e`), '{}');
  assert.equal(await readDaemonLifecycle(home, { platform: 'win32' }), undefined);
  assert.deepEqual(asked.slice(1), [path.join(home, 'state', `alpd.lifecycle-${id}.held`)]);
});
