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
  // web.port belongs to alp-web: the integration must leave it free and pick its own port.
  const webPort = await freePort();
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ web: { port: webPort, relay: { enabled: false } } }));

  const child = spawn(process.execPath, [entry], { stdio: 'ignore', env: { ...process.env, ALP_HOME: home, ALP_SUPERVISE: '0' } });
  const exit = new Promise(resolve => child.once('exit', code => resolve(code)));
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });

  assert.ok(await waitFor(logFile(home)), 'the entry creates the log the launcher advertises, with no --service flag');
  const info = await waitFor(path.join(home, 'paseo.json')) && JSON.parse(await readFile(path.join(home, 'paseo.json'), 'utf8'));
  assert.ok(Number.isSafeInteger(info.pid), 'the entry published its paseo.json');
  assert.equal(JSON.parse(await readFile(path.join(home, 'integrations', 'paseo.lock'), 'utf8')).pid, info.pid, 'it owns integrations/paseo.lock');
  assert.equal(existsSync(path.join(home, 'integrations', 'web.lock')), false, 'and never the web lock');
  assert.equal(existsSync(path.join(home, 'web.json')), false, 'nor web.json');
  assert.notEqual(info.port, webPort, 'it does not listen on web.port');
  const free = await listen(webPort);
  assert.ok(free, 'web.port stays free for alp-web');
  await close(free);
  // The entry publishes paseo.json inside listen() and logs the listening line only afterwards, so
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
  // paseo.json cannot be replaced while a directory stands in its place, so listen() fails.
  await mkdir(path.join(home, 'paseo.json'));
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ web: { relay: { enabled: false } } }));

  const child = spawn(process.execPath, [entry], { stdio: 'ignore', env: { ...process.env, ALP_HOME: home, ALP_SUPERVISE: '0' } });
  const code = await new Promise(resolve => child.once('exit', resolve));

  assert.equal(code, 1, 'the entry fails when it cannot publish its address');
  assert.ok(existsSync(logFile(home)), 'the log exists on the failure path too');
  assert.match(await readFile(logFile(home), 'utf8'), /web app not started/);
});

test('--register records the entry as integration paseo, not web', async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'alp-integration-register-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const code = await new Promise(resolve => spawn(process.execPath, [entry, '--register'], { stdio: 'ignore', env: { ...process.env, ALP_HOME: home, ALP_SUPERVISE: '0' } }).once('exit', resolve));
  assert.equal(code, 0);
  assert.equal(JSON.parse(await readFile(path.join(home, 'integrations', 'paseo.json'), 'utf8')).main, entry);
  assert.equal(existsSync(path.join(home, 'integrations', 'web.json')), false, 'the pre-rename descriptor is not written');
});
