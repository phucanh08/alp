import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  bootId,
  bootTime,
  isSameBoot,
  lockAlive,
  integrationAlive,
  acquireDaemonLock,
  _setBootIdForTest,
} from '../src/index.js';
import { createIntegrationLock } from '../src/integration-lock.js';

test.afterEach(() => {
  _setBootIdForTest(null);
});

test('bootId() returns a non-empty string or undefined on unsupported platforms', () => {
  const id = bootId();
  if (['linux', 'darwin'].includes(process.platform)) {
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
  } else {
    assert.ok(id === undefined || typeof id === 'string');
  }
});

test('isSameBoot() evaluates boot identity with clock jump tolerance and cross-boot protection', () => {
  const currentBoot = bootTime();
  const currentId = 'boot-uuid-current';

  // 1. Matching bootId survives wall-clock forward jump > 30s
  assert.equal(
    isSameBoot(
      { bootId: currentId, bootTime: currentBoot - 120 },
      { bootId: currentId, bootTime: currentBoot }
    ),
    true
  );

  // 2. Matching bootId survives wall-clock backward jump > 30s
  assert.equal(
    isSameBoot(
      { bootId: currentId, bootTime: currentBoot + 120 },
      { bootId: currentId, bootTime: currentBoot }
    ),
    true
  );

  // 3. Different bootId (cross-boot) is rejected even if bootTime happens to be identical
  assert.equal(
    isSameBoot(
      { bootId: 'boot-uuid-other', bootTime: currentBoot },
      { bootId: currentId, bootTime: currentBoot }
    ),
    false
  );

  // 4. Legacy lock without bootId: accepted within 30s tolerance
  assert.equal(
    isSameBoot(
      { bootTime: currentBoot - 15 },
      { bootId: currentId, bootTime: currentBoot }
    ),
    true
  );

  // 5. Legacy lock without bootId: rejected outside 30s tolerance (fail-closed)
  assert.equal(
    isSameBoot(
      { bootTime: currentBoot - 45 },
      { bootId: currentId, bootTime: currentBoot }
    ),
    false
  );

  // 6. Invalid / null / empty lock
  assert.equal(isSameBoot(null), false);
  assert.equal(isSameBoot(undefined), false);
  assert.equal(isSameBoot({}), false);
});

test('lockAlive() and integrationAlive() survive clock jumps when bootId matches', () => {
  const curId = bootId();
  if (!curId) return;

  const currentBoot = bootTime();

  // Clock shifted forward by 100 seconds
  const forwardLock = {
    pid: process.pid,
    bootId: curId,
    bootTime: currentBoot - 100,
  };
  assert.equal(lockAlive(forwardLock), true);
  assert.equal(integrationAlive(forwardLock), true);

  // Clock shifted backward by 100 seconds
  const backwardLock = {
    pid: process.pid,
    bootId: curId,
    bootTime: currentBoot + 100,
  };
  assert.equal(lockAlive(backwardLock), true);
  assert.equal(integrationAlive(backwardLock), true);

  // Cross-boot lock with same PID is refused (prevents cross-boot PID reuse)
  const crossBootLock = {
    pid: process.pid,
    bootId: 'other-boot-uuid',
    bootTime: currentBoot,
  };
  assert.equal(lockAlive(crossBootLock), false);
  assert.equal(integrationAlive(crossBootLock), false);

  // Cross-boot lock with foreign-owned PID (throws EPERM on kill(pid, 0)) never bypasses boot identity
  const epermCrossBootLock = {
    pid: 1,
    bootId: 'other-boot-uuid',
    bootTime: currentBoot,
  };
  assert.equal(lockAlive(epermCrossBootLock), false);
  assert.equal(integrationAlive(epermCrossBootLock), false);

  const epermLegacyCrossBootLock = {
    pid: 1,
    bootTime: currentBoot - 3600,
  };
  assert.equal(lockAlive(epermLegacyCrossBootLock), false);
  assert.equal(integrationAlive(epermLegacyCrossBootLock), false);

  // Incomplete lock without boot metadata fails closed
  assert.equal(lockAlive({ pid: 1 }), false);
  assert.equal(integrationAlive({ pid: 1 }), false);
});

test('acquireDaemonLock records bootId and startedUptime', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-boot-daemon-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const lock = await acquireDaemonLock(home, {
    version: 'test',
    protocolVersion: 1,
    socket: path.join(home, 'test.sock'),
  });

  assert.equal(lock.pid, process.pid);
  assert.equal(typeof lock.bootTime, 'number');
  assert.equal(typeof lock.startedUptime, 'number');
  if (['linux', 'darwin'].includes(process.platform)) {
    assert.equal(typeof lock.bootId, 'string');
    assert.equal(lock.bootId, bootId());
  }

  const onDisk = JSON.parse(await readFile(path.join(home, 'alpd.lock'), 'utf8'));
  assert.equal(onDisk.pid, process.pid);
  assert.equal(onDisk.bootTime, lock.bootTime);
  assert.equal(onDisk.bootId, lock.bootId);
  assert.equal(onDisk.startedUptime, lock.startedUptime);
});

test('integration-lock reclaims dead process across clock jumps with matching bootId, fails on cross-boot', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-boot-intlock-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const lockFile = path.join(home, 'integrations', 'web.lock');
  await mkdir(path.dirname(lockFile), { recursive: true });

  const curId = bootId() ?? 'test-boot-uuid';
  _setBootIdForTest(curId);

  // 1. Dead owner with clock jump > 30s but matching bootId -> automatic recovery succeeds
  await writeFile(
    lockFile,
    JSON.stringify({
      pid: 2 ** 22 + 88888, // dead PID
      bootTime: bootTime() - 120, // 2 minutes drifted
      bootId: curId,
      startedUptime: Math.floor(os.uptime()) - 300,
      startedAt: new Date(Date.now() - 300_000).toISOString(),
      ready: true,
      lockVersion: 1,
      owner: '00000000-0000-0000-0000-000000000001',
    }),
    { mode: 0o600 }
  );

  const lockInstance = createIntegrationLock(home, 'web');
  const acquired = await lockInstance.acquire();
  assert.equal(acquired.acquired, true);
  assert.equal(acquired.lock.pid, process.pid);
  assert.equal(acquired.lock.bootId, curId);
  await lockInstance.release();

  // 2. Dead owner from a different boot -> fails closed with uncertain boot context error
  await writeFile(
    lockFile,
    JSON.stringify({
      pid: 2 ** 22 + 88888,
      bootTime: bootTime(),
      bootId: 'other-rebooted-boot-id',
      startedUptime: Math.floor(os.uptime()) - 300,
      startedAt: new Date(Date.now() - 300_000).toISOString(),
      ready: true,
      lockVersion: 1,
      owner: '00000000-0000-0000-0000-000000000002',
    }),
    { mode: 0o600 }
  );

  const contender = createIntegrationLock(home, 'web');
  await assert.rejects(
    async () => contender.acquire(),
    /Integration owner boot context is uncertain/
  );
});
