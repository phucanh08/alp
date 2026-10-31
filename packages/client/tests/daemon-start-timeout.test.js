// How long a start waits for alpd to be ready (t-53aa): 60 s by default, so a loaded host does not
// make `alp restore --stop` or `alp daemon install` report a failed start; ALP_DAEMON_START_TIMEOUT_MS
// sets another wait. A lock that is alive but not ready stands in for an alpd still starting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DAEMON_START_TIMEOUT_MS, acquireDaemonLock, daemonPaths, daemonStartTimeoutMs, releaseDaemonLock } from '@anhlp/alp-client/index';
import { startDaemon } from '@anhlp/alp-client/supervise';

async function startingHome(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-start-timeout-'));
  await chmod(home, 0o700);
  t.after(() => rm(home, { recursive: true, force: true }));
  // This process holds the lock, alive and not ready: an alpd that is still starting.
  await acquireDaemonLock(home, { version: 'test', protocolVersion: 1, socket: daemonPaths(home).socket });
  t.after(() => releaseDaemonLock(home).catch(() => {}));
  return home;
}

test('the default start wait is 60 s; ALP_DAEMON_START_TIMEOUT_MS takes a positive whole number of ms up to one hour', () => {
  assert.equal(DAEMON_START_TIMEOUT_MS, 60_000);
  assert.equal(daemonStartTimeoutMs({}), 60_000);
  assert.equal(daemonStartTimeoutMs({ ALP_DAEMON_START_TIMEOUT_MS: '120000' }), 120_000);
  assert.equal(daemonStartTimeoutMs({ ALP_DAEMON_START_TIMEOUT_MS: ' 500 ' }), 500);
  assert.equal(daemonStartTimeoutMs({ ALP_DAEMON_START_TIMEOUT_MS: '3600000' }), 3_600_000);
  for (const value of ['', '0', '-1', '1.5', '1e3', 'abc', '3600001', '99999999999999999999']) {
    assert.equal(daemonStartTimeoutMs({ ALP_DAEMON_START_TIMEOUT_MS: value }), 60_000, `ignores ${JSON.stringify(value)}`);
  }
});

test('startDaemon waits as long as ALP_DAEMON_START_TIMEOUT_MS says when no timeout is passed', async t => {
  const home = await startingHome(t);
  const started = Date.now();
  await assert.rejects(startDaemon({ home, env: { ...process.env, ALP_DAEMON_START_TIMEOUT_MS: '300' } }), /did not become ready within 0\.3 s/);
  const waited = Date.now() - started;
  assert.ok(waited >= 250 && waited < 10_000, `waited ${waited} ms`);
});

test('startDaemon returns once a slow alpd becomes ready within the wait', async t => {
  const home = await startingHome(t);
  const lock = daemonPaths(home).lock;
  const ready = setTimeout(async () => {
    const contents = JSON.parse(await readFile(lock, 'utf8'));
    await writeFile(lock, JSON.stringify({ ...contents, ready: true }));
  }, 400);
  t.after(() => clearTimeout(ready));
  const socket = await startDaemon({ home, env: { ...process.env, ALP_DAEMON_START_TIMEOUT_MS: '10000' } });
  assert.equal(socket, daemonPaths(home).socket);
});
