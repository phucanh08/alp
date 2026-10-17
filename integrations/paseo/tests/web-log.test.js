import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const entry = path.resolve(import.meta.dirname, '..', 'server', 'dist', 'main.js');
const logFile = home => path.join(home, 'logs', 'integrations', 'paseo.log');

// The advertised log path is what the launcher's failure messages point at. A normal, detached
// `alp web` launch must create it and capture a startup failure there; before the fix the entry only
// logged under `--service`, which the launcher never passed, so the file never appeared.

function listen(port) {
  return new Promise(resolve => {
    const server = createServer();
    server.once('error', () => resolve(undefined));
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function close(server) {
  return new Promise(resolve => server.close(() => resolve()));
}

/** Ten consecutive in-use ports, so the entry's listen retries are exhausted and it fails. */
async function occupyTenPorts() {
  for (let base = 20_000; base <= 40_000; base += 10) {
    const servers = [];
    let ok = true;
    for (let i = 0; i < 10; i++) {
      const server = await listen(base + i);
      if (!server) { ok = false; break; }
      servers.push(server);
    }
    if (ok) return { base, servers };
    for (const server of servers) await close(server);
  }
  throw new Error('could not reserve ten consecutive ports');
}

async function freePort() {
  const server = await listen(0);
  const { port } = server.address();
  await close(server);
  return port;
}

async function waitFor(file, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file)) return true;
    await sleep(50);
  }
  return false;
}

/** Polls `file` until its text matches `pattern`; returns the last text read (empty if never). */
async function waitForText(file, pattern, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    text = await readFile(file, 'utf8').catch(() => '');
    if (pattern.test(text)) return text;
    await sleep(50);
  }
  return text;
}

test('a normal detached launch writes the advertised integration log', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-integration-log-'));
  await mkdir(home, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ web: { port: await freePort() } }));

  const child = spawn(process.execPath, [entry], { stdio: 'ignore', env: { ...process.env, ALP_HOME: home, ALP_SUPERVISE: '0' } });
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)));
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });

  assert.ok(await waitFor(logFile(home)), 'the entry creates the log the launcher advertises, with no --service flag');
  const info = await waitFor(path.join(home, 'web.json')) && JSON.parse(await readFile(path.join(home, 'web.json'), 'utf8'));
  assert.ok(Number.isSafeInteger(info.pid), 'the entry published its web.json');
  // The entry publishes web.json inside listen() and logs the listening line only afterwards, so
  // under load the line can trail the file: wait for it rather than reading once.
  const listening = /web app on http:\/\/127\.0\.0\.1:\d+\//;
  assert.match(await waitForText(logFile(home), listening), listening);

  // Shut the entry down through the pid its own metadata names; no other process is touched.
  process.kill(info.pid, 'SIGTERM');
  // Windows has no SIGTERM to handle: it terminates the process outright, so only a POSIX stop exits cleanly.
  const code = await exit;
  if (process.platform !== 'win32') assert.equal(code, 0);
});

test('an injected startup failure is captured in the advertised log', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-integration-fail-'));
  await mkdir(home, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));
  const { base, servers } = await occupyTenPorts();
  t.after(() => Promise.all(servers.map(close)));
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ web: { port: base } }));

  const child = spawn(process.execPath, [entry], { stdio: 'ignore', env: { ...process.env, ALP_HOME: home, ALP_SUPERVISE: '0' } });
  const code = await new Promise(resolve => child.once('exit', resolve));

  assert.equal(code, 1, 'the entry fails when it cannot bind');
  assert.ok(existsSync(logFile(home)), 'the log exists on the failure path too');
  assert.match(await readFile(logFile(home), 'utf8'), /web app not started/);
});
