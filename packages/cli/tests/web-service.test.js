import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { bootId, bootTime } from '@anhlp/alp-client/index';
import { isWebClaimed, isWebReady, refusal, webOwner } from '../src/web-service.js';

test('webOwner accepts live integration across clock jumps when bootId matches', async (t) => {
  const curId = bootId();
  if (!curId) return;

  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-web-owner-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  await mkdir(path.join(home, 'integrations'), { recursive: true });

  // Spawn a long-running child process as the simulated web service
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  });

  // Lock written with clock jump of 120s forward, but matching bootId and valid startedUptime
  await writeFile(
    path.join(home, 'integrations', 'web.lock'),
    JSON.stringify({
      pid: child.pid,
      bootTime: bootTime() - 120,
      bootId: curId,
      startedUptime: Math.floor(os.uptime()),
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      ready: true,
      lockVersion: 1,
      owner: '00000000-0000-0000-0000-000000000001',
    }),
    { mode: 0o600 }
  );

  await writeFile(
    path.join(home, 'web.json'),
    JSON.stringify({
      pid: child.pid,
      app: 'alp-web',
      url: 'http://127.0.0.1:7433',
    }),
    { mode: 0o600 }
  );

  const owner = await webOwner(home);
  assert.equal(owner.pid, child.pid);
  assert.equal(owner.app, 'alp-web');
});

test('webOwner refuses lock from another boot as foreign (cross-boot PID reuse protection)', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-web-owner-cross-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  await mkdir(path.join(home, 'integrations'), { recursive: true });

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  });

  // Lock with different bootId
  await writeFile(
    path.join(home, 'integrations', 'web.lock'),
    JSON.stringify({
      pid: child.pid,
      bootTime: bootTime(),
      bootId: 'other-boot-uuid-prior-reboot',
      startedUptime: Math.floor(os.uptime()),
      startedAt: new Date().toISOString(),
      ready: true,
      lockVersion: 1,
      owner: '00000000-0000-0000-0000-000000000002',
    }),
    { mode: 0o600 }
  );

  await writeFile(
    path.join(home, 'web.json'),
    JSON.stringify({
      pid: child.pid,
      app: 'alp-web',
      url: 'http://127.0.0.1:7433',
    }),
    { mode: 0o600 }
  );

  const owner = await webOwner(home);
  assert.equal(owner.alive, true);
  assert.equal(owner.kind, 'foreign');
  assert.match(owner.reason, /from another boot/);
});

test('webOwner detects reused PID via startedUptime even if wall clock stepped backward', async (t) => {
  const curId = bootId();
  if (!curId) return;

  const home = await mkdtemp(path.join(os.tmpdir(), 'alp-web-owner-reuse-'));
  t.after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  await mkdir(path.join(home, 'integrations'), { recursive: true });

  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {}
  });

  // Wait a small moment so child has positive elapsed time
  await new Promise((resolve) => setTimeout(resolve, 1500));

  // Lock was recorded with startedUptime: 0 (way in the past relative to child start)
  // Wall clock stepped backward: startedAt is set to the future or past
  await writeFile(
    path.join(home, 'integrations', 'web.lock'),
    JSON.stringify({
      pid: child.pid,
      bootTime: bootTime(),
      bootId: curId,
      startedUptime: 0, // Lock claimed at uptime 0
      startedAt: new Date(Date.now() + 3_600_000).toISOString(), // Clock backward artifact
      ready: true,
      lockVersion: 1,
      owner: '00000000-0000-0000-0000-000000000003',
    }),
    { mode: 0o600 }
  );

  await writeFile(
    path.join(home, 'web.json'),
    JSON.stringify({
      pid: child.pid,
      app: 'alp-web',
      url: 'http://127.0.0.1:7433',
    }),
    { mode: 0o600 }
  );

  const owner = await webOwner(home);
  assert.equal(owner.alive, true);
  assert.equal(owner.kind, 'foreign');
  assert.match(owner.reason, /reused pid/);
});

test('isWebReady verifies reachable loopback HTTP endpoints and rejects closed or invalid endpoints', async (t) => {
  assert.equal(await isWebReady(undefined), false);
  assert.equal(await isWebReady(''), false);
  assert.equal(await isWebReady('not-a-url'), false);
  assert.equal(await isWebReady('ftp://127.0.0.1:7433'), false);
  assert.equal(await isWebReady('http://example.com:7433'), false);
  assert.equal(await isWebReady('http://192.168.1.1:7433'), false);

  // Closed port
  assert.equal(await isWebReady('http://127.0.0.1:59999/'), false);

  // Active loopback server
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  assert.ok(port > 0);

  assert.equal(await isWebReady(`http://127.0.0.1:${port}/`), true);
  assert.equal(await isWebReady(`http://localhost:${port}/`), true);
});

test('isWebClaimed rejects stale metadata on reused PID, cross-boot, or unreachable service', async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const addr = server.address();
  const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
  const liveUrl = `http://127.0.0.1:${port}/`;
  const deadUrl = 'http://127.0.0.1:59998/';

  const validPublished = { app: 'alp-web', pid: 12345, url: liveUrl };

  // App mismatch
  assert.equal(await isWebClaimed({ app: 'other', pid: 12345, url: liveUrl }, 12345, { alive: false }), false);

  // PID mismatch
  assert.equal(await isWebClaimed(validPublished, 99999, { alive: false }), false);

  // Reused PID proof: must be rejected even if published.pid matches lockPid and server answers
  const reusedHeld = {
    alive: true,
    kind: 'foreign',
    reason: 'pid 12345 started after the lock was written (a reused pid)',
  };
  assert.equal(await isWebClaimed(validPublished, 12345, reusedHeld), false);

  // Cross-boot proof: must be rejected
  const crossBootHeld = {
    alive: true,
    kind: 'foreign',
    reason: 'its lock is from another boot',
  };
  assert.equal(await isWebClaimed(validPublished, 12345, crossBootHeld), false);

  // Unreachable service URL: must be rejected
  const deadPublished = { app: 'alp-web', pid: 12345, url: deadUrl };
  assert.equal(await isWebClaimed(deadPublished, 12345, { alive: false }), false);

  // Valid claimed service: live process, matching PID, answering URL
  assert.equal(await isWebClaimed(validPublished, 12345, { pid: 12345, app: 'alp-web' }), true);
});
