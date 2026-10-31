// `alp daemon install` waits for alpd with ready() (t-53aa): 60 s by default, or as long as
// ALP_DAEMON_START_TIMEOUT_MS says. A lock that is alive but not ready stands in for an alpd that is
// still starting; ALP_HOME is a private throwaway directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { acquireDaemonLock, daemonPaths, releaseDaemonLock } from '@anhlp/alp-client/index';
import { ready } from '../src/daemon.js';

async function startingHome(t, timeout) {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-cli-ready-'));
  await chmod(home, 0o700);
  const saved = { ALP_HOME: process.env.ALP_HOME, ALP_DAEMON_START_TIMEOUT_MS: process.env.ALP_DAEMON_START_TIMEOUT_MS };
  process.env.ALP_HOME = home;
  process.env.ALP_DAEMON_START_TIMEOUT_MS = timeout;
  await acquireDaemonLock(home, { version: 'test', protocolVersion: 1, socket: daemonPaths(home).socket });
  t.after(async () => {
    await releaseDaemonLock(home).catch(() => {});
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await rm(home, { recursive: true, force: true });
  });
  return home;
}

test('ready() gives up after ALP_DAEMON_START_TIMEOUT_MS, not a fixed 15 s', async t => {
  await startingHome(t, '300');
  const started = Date.now();
  await assert.rejects(ready(), /alpd did not become ready within 0\.3 s/);
  assert.ok(Date.now() - started < 10_000);
});

test('ready() returns the socket of an alpd that becomes ready within the wait', async t => {
  const home = await startingHome(t, '10000');
  const lock = daemonPaths(home).lock;
  const flip = setTimeout(async () => {
    await writeFile(lock, JSON.stringify({ ...JSON.parse(await readFile(lock, 'utf8')), ready: true }));
  }, 400);
  t.after(() => clearTimeout(flip));
  assert.equal(await ready(), daemonPaths(home).socket);
});
