import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { existsSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { cp, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

import { createAlpRuntime } from '../../dist/runtime/index.js';
import { createDaemonServer } from '../../dist/daemon/index.js';
import { createPaseoBridge } from '../../integrations/paseo/server/dist/index.js';
import { initProject } from '../../packages/core/src/init.js';
import { seedLibrary } from '../../packages/core/src/library.js';
import { fakeTransport } from '../support/fake-agent.js';
import { fixtureProcesses } from '../support/fixture-processes.js';

const root = path.resolve(import.meta.dirname, '..', '..');
const cli = path.join(root, 'packages', 'cli', 'dist', 'cli.js');
const integrationDescriptor = path.join(root, 'integrations', 'paseo.json');
const paseoEntry = path.join(root, 'integrations', 'paseo', 'server', 'dist', 'main.js');
const cliDist = path.join(root, 'packages', 'cli', 'dist');
const alpWebService = path.join(cliDist, 'alp-web.js');
const clientDist = path.join(root, 'packages', 'client', 'dist');
const execFileAsync = promisify(execFile);
const processFixtures = new Map();

// alp-web serves the built apps/web files; these tests exercise the process lifecycle, so a stand-in
// page keeps them independent of the web build (ALP_WEB_APP is the override).
const standInApp = await mkdtemp(path.join(tmpdir(), 'alp-web-stand-in-'));
await writeFile(path.join(standInApp, 'index.html'), '<!doctype html><title>ALP</title>');
process.env.ALP_WEB_APP = standInApp;
// The outer test process must never fall back to the developer's live home either.
process.env.ALP_HOME = path.join(standInApp, 'outer-home');
await mkdir(process.env.ALP_HOME, { mode: 0o700 });
after(() => rm(standInApp, { recursive: true, force: true }));
const { bootTime, connect, readLock, lockAlive } = await import('../../packages/client/dist/index.js');

/**
 * Runs the CLI in a child process and never rejects: the caller reads the exit code and output.
 * A timeout is reported as `signal: 'SIGKILL'` with a code that is not 0, so a hang fails the test.
 */
async function run(args, home, timeout = 60_000, extraEnv = {}, script = cli) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [script, ...args], {
      env: { ...process.env, ...extraEnv, ...processFixtures.get(home).env },
      encoding: 'utf8',
      timeout,
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr, signal: null };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      signal: error.signal ?? null,
    };
  }
}

async function homeJson(home, name) {
  return readFile(path.join(home, name), 'utf8').then(JSON.parse, () => undefined);
}

// alp-web (`alp web`) is integration `web`: web.json and integrations/web.lock. The Paseo integration
// (`alp web pair`) is integration `paseo`: paseo.json and integrations/paseo.lock.
const webJson = home => homeJson(home, 'web.json');
const webLock = home => homeJson(home, path.join('integrations', 'web.lock'));
const paseoJson = home => homeJson(home, 'paseo.json');
const paseoLock = home => homeJson(home, path.join('integrations', 'paseo.lock'));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

/** The address `alp web --print` printed: its port and the alpgw1 token in the fragment. */
function printedUrl(result) {
  const match = /^http:\/\/127\.0\.0\.1:(\d+)\/#token=(alpgw1\.[0-9a-f]{16}\.[A-Za-z0-9_-]{43})$/m.exec(result.stdout);
  assert.ok(match, `no loopback address with an alpgw1 token in: ${result.stdout}${result.stderr}`);
  return { url: match[0], port: Number(match[1]), token: match[2] };
}

/** POST /v1/tickets with `token`: 201 for a live credential, 401 otherwise. */
async function ticketStatus(port, token) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/tickets`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
  await response.body?.cancel();
  return response.status;
}

async function freePort() {
  return new Promise((resolve, reject) => { const server = createNetServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
}

async function waitGone(pid) {
  for (let i = 0; i < 200; i++) { try { process.kill(pid, 0); } catch { return; } await sleep(25); }
  assert.fail(`process ${pid} did not exit`);
}

/** A private home whose detached Node descendants are admitted before their entry points run. */
async function createHome(t, web = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-integration-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  // A free web.port of its own, so parallel tests do not meet at the default 7433.
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ web: { port: await freePort(), relay: { enabled: false }, ...web } }));
  const processes = await fixtureProcesses(home);
  processFixtures.set(home, processes);
  t.after(async () => {
    await processes.stop();
    processFixtures.delete(home);
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { directory, home };
}

async function startDaemon(home) {
  const started = await run(['daemon', 'start'], home, 30_000);
  assert.equal(started.code, 0, started.signal ? `alp daemon start timed out (${started.signal})` : started.stderr || started.stdout);
  for (let i = 0; i < 100; i++) {
    const lock = await readLock(home).catch(() => undefined);
    if (lock?.ready) return lock;
    await sleep(100);
  }
  assert.ok((await readLock(home).catch(() => undefined))?.ready, 'alpd did not become ready');
}

async function callDaemon(socket, method, params = {}) {
  const client = await connect(socket);
  try { return await client.request(method, params); } finally { client.close(); }
}

async function waitFor(fn, what, tries = 300, gap = 50) {
  for (let i = 0; i < tries; i++) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    await sleep(gap);
  }
  assert.fail(`Expected ${what} did not arrive`);
}

test('cleanup stops unpublished detached daemon and service under gated startup load', async t => {
  let cleanup;
  const { home } = await createHome({ after: hook => { cleanup = hook; } });
  const owned = processFixtures.get(home);
  // Preserve a private emergency shutdown controller even when exercising old teardown.
  t.after(async () => { await owned.stop(); await rm(path.dirname(home), { recursive: true, force: true }); });
  const gate = path.join(home, 'startup-gate.mjs');
  const arrived = path.join(home, 'arrived');
  await writeFile(gate, `
    import fs from 'node:fs/promises';
    import { appendFileSync } from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const open = fs.open;
    fs.open = async function(file, ...args) {
      if ([${JSON.stringify(path.join(home, 'alpd.lock'))}, ${JSON.stringify(path.join(home, 'integrations', 'paseo.lock'))}].includes(String(file))) {
        appendFileSync(${JSON.stringify(arrived)}, process.pid + '\\n');
        // Bound synchronous startup load. The fixture watchdog has its own event loop.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30_000);
      }
      return open.call(this, file, ...args);
    };
    syncBuiltinESMExports();
  `);
  const env = { ...process.env, ...owned.env, NODE_OPTIONS: owned.env.NODE_OPTIONS + ' --import=' + pathToFileURL(gate).href };
  const children = [path.join(root, 'dist', 'alpd.js'), path.join(root, 'integrations', 'paseo', 'server', 'dist', 'main.js')].map(entry => {
    const child = spawn(process.execPath, [entry, '--service'], { env, detached: true, stdio: 'ignore' });
    child.unref();
    return child;
  });
  const pids = children.map(child => child.pid);
  await waitFor(async () => (await readFile(arrived, 'utf8')).trim().split('\n').length === 2, 'both real processes blocked before metadata');
  assert.equal(await paseoJson(home), undefined);
  assert.equal(await paseoLock(home), undefined);
  assert.equal(await readLock(home), undefined);
  assert.ok(pids.every(pid => { try { process.kill(pid, 0); return true; } catch { return false; } }));
  await cleanup();
  for (const pid of pids) await waitGone(pid);
  // A delayed launch holding a copied env must fail closed after the home is removed.
  const late = await execFileAsync(process.execPath, ['-e', 'process.exit(42)'], { env: { ...env, NODE_OPTIONS: owned.env.NODE_OPTIONS } }).catch(error => error);
  assert.equal(late.code, 1, 'closed admission must prevent the entry point');
  assert.match(late.stderr, /owner\.json/);
});

test('cleanup ignores foreign metadata PIDs and drains an unrecorded detached descendant', async t => {
  let cleanup;
  const { home } = await createHome({ after: hook => { cleanup = hook; } });
  const owned = processFixtures.get(home);
  const sentinel = await createHome(t);
  const foreign = processFixtures.get(sentinel.home);
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: { ...process.env, ...foreign.env }, stdio: 'ignore' });
  await waitFor(async () => (await foreign.running()).some(entry => entry.pid === child.pid), 'foreign sentinel admission');
  t.after(async () => { await owned.stop(); await rm(path.dirname(home), { recursive: true, force: true }); });
  // A real detached descendant is launched without publishing any ALP lock.
  const script = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: process.env, detached: true, stdio: 'ignore' }).unref();
  `;
  await execFileAsync(process.execPath, ['-e', script], { env: { ...process.env, ...owned.env } });
  await waitFor(async () => (await owned.running()).length === 1, 'unrecorded detached descendant');
  for (const file of ['paseo.json', 'integrations/paseo.lock', 'alpd.lock']) {
    await mkdir(path.dirname(path.join(home, file)), { recursive: true });
    await writeFile(path.join(home, file), JSON.stringify({ pid: child.pid }));
  }
  const pids = (await owned.running()).map(entry => entry.pid);
  await cleanup();
  for (const pid of pids) await waitGone(pid);
  assert.doesNotThrow(() => process.kill(child.pid, 0), 'another home survives stale/foreign metadata');
});

// ---- alp web: alp-web, integration `web` ----

test('cold alp web starts alpd and alp-web on web.port, prints a working token, and reuses it', async t => {
  const { home } = await createHome(t);
  const { port: webPort } = JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')).web;

  const first = await run(['web', '--print'], home);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const printed = printedUrl(first);
  const daemon = await readLock(home);
  assert.ok(lockAlive(daemon), 'alp web starts alpd when it is not running');
  const info = await webJson(home);
  assert.equal(info.app, 'alp-web');
  assert.equal((await webLock(home)).pid, info.pid, 'alp-web owns the web lock');
  assert.ok(info.pid !== daemon.pid && info.pid > 0, 'alp-web is its own process');
  assert.equal(info.port, webPort, 'alp-web listens on web.port');
  assert.equal(printed.port, webPort);
  assert.equal(printed.token, info.token, 'the printed fragment carries web.json\'s token');
  assert.equal(await paseoLock(home), undefined, 'alp web no longer starts the Paseo integration');

  const page = await fetch(`http://127.0.0.1:${printed.port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>ALP<\/title>/);
  assert.equal(await ticketStatus(printed.port, printed.token), 201, 'the token is a live gateway credential');

  const second = await run(['web', '--print'], home);
  assert.equal(second.code, 0, second.stderr || second.stdout);
  assert.equal(printedUrl(second).url, printed.url, 'a second call prints the same address');
  assert.equal((await webJson(home)).pid, info.pid, 'and reuses the running alp-web');
});

test('alp web passes an ALP project it runs in to alp-web\'s grant', async t => {
  const { directory, home } = await createHome(t);
  await mkdir(path.join(directory, 'project', '.alp'), { recursive: true });
  // The process's cwd is a real path (macOS's tmpdir is a symlink), and so is the granted workspace.
  const project = await realpath(path.join(directory, 'project'));
  const elsewhere = path.join(directory, 'elsewhere');
  await mkdir(elsewhere);
  const runIn = (cwd, args) => execFileAsync(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...processFixtures.get(home).env }, encoding: 'utf8', timeout: 60_000 });
  await runIn(project, ['web', '--print']);
  const workspaces = async () => (await homeJson(home, path.join('web', 'credentials.json'))).credentials.filter(entry => !entry.revokedAt).flatMap(entry => entry.workspaces.map(workspace => workspace.path));
  assert.ok((await workspaces()).includes(project), 'the project is granted');
  // From elsewhere, rotating grants no project: the cwd is not one.
  await runIn(elsewhere, ['web', 'rotate']);
  assert.ok(!(await workspaces()).includes(project));
});

test('two concurrent cold alp web invocations converge on one alp-web', async t => {
  const { home } = await createHome(t);
  await startDaemon(home);
  const [a, b] = await Promise.all([run(['web', '--print'], home), run(['web', '--print'], home)]);
  assert.equal(a.code, 0, a.stderr || a.stdout);
  assert.equal(b.code, 0, b.stderr || b.stdout);
  const info = await webJson(home);
  assert.equal((await webLock(home)).pid, info.pid, 'the web lock and web.json name the one winner');
  assert.equal(printedUrl(a).url, `${info.url}#token=${info.token}`);
  assert.equal(printedUrl(b).url, printedUrl(a).url, 'both callers print the winner');
});

test('a killed alp-web keeps its token when alp web starts it again', async t => {
  const { home } = await createHome(t);
  const first = await run(['web', '--print'], home);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const info1 = await webJson(home);
  process.kill(info1.pid, 'SIGKILL');
  await waitGone(info1.pid);
  assert.ok(lockAlive(await readLock(home)), 'alpd survives alp-web dying');
  assert.equal((await webLock(home))?.pid, info1.pid, 'the dead owner left its lock');

  const again = await run(['web', '--print'], home);
  assert.equal(again.code, 0, again.stderr || again.stdout);
  const info2 = await webJson(home);
  assert.notEqual(info2.pid, info1.pid, 'a new alp-web took the dead owner\'s lock');
  assert.equal(info2.token, info1.token, 'the token is kept, so open pages keep working');
  assert.equal(info2.credentialId, info1.credentialId);
  assert.equal(printedUrl(again).token, info1.token);
  assert.equal(await ticketStatus(info2.port, info1.token), 201);
});

test('web.enabled=false: alp web refuses without starting anything, and rotate still replaces the token', async t => {
  const { home } = await createHome(t, { enabled: false });
  const refused = await run(['web', '--print'], home);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /alp web is disabled by settings \("web\.enabled": false\)/);
  assert.equal(await webLock(home), undefined);
  assert.equal(await webJson(home), undefined);

  const rotated = await run(['web', 'rotate'], home);
  assert.equal(rotated.code, 0, rotated.stderr || rotated.stdout);
  assert.match(rotated.stdout, /new token[\s\S]*disabled by settings[\s\S]*not started/);
  const info = await webJson(home);
  assert.equal(info.app, 'alp-web');
  assert.match(info.token, /^alpgw1\./, 'the new token waits in web.json for the next start');
  assert.equal(info.pid, undefined, 'no service runs');
  assert.equal(await webLock(home), undefined, 'the rotation released the lock');
});

test('a CLI built without alp-web.js says so before starting anything', async t => {
  const { directory, home } = await createHome(t);
  // A copy of the CLI's dist without the service; its imports resolve through the workspace.
  const copy = path.join(directory, 'cli');
  await mkdir(copy);
  await symlink(path.join(root, 'node_modules'), path.join(copy, 'node_modules'));
  await cp(cliDist, path.join(copy, 'dist'), { recursive: true, filter: source => !/alp-web(\.js)?$/.test(path.basename(source)) });
  assert.ok(!existsSync(path.join(copy, 'dist', 'alp-web.js')));
  for (const args of [['web', '--print'], ['web', 'rotate']]) {
    const refused = await run(args, home, 60_000, {}, path.join(copy, 'dist', 'cli.js'));
    assert.notEqual(refused.code, 0, refused.stdout);
    assert.match(refused.stderr, /alp web is not built: .*alp-web\.js is missing/);
  }
  assert.equal(await readLock(home).catch(() => undefined), undefined, 'alpd was not started');
});

test('without the built app files alp web still starts, and the page says how to build them', async t => {
  const { directory, home } = await createHome(t);
  const empty = path.join(directory, 'no-app');
  await mkdir(empty);
  const served = await run(['web', '--print'], home, 60_000, { ALP_WEB_APP: empty });
  assert.equal(served.code, 0, served.stderr || served.stdout);
  const { port, token } = printedUrl(served);
  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.match(await page.text(), /build/i);
  assert.equal(await ticketStatus(port, token), 201, 'the gateway serves regardless');
});

test('stale web.json and a dead owner\'s web lock are replaced by a live alp-web', async t => {
  const { home } = await createHome(t);
  const dead = 2 ** 31 - 1;
  await mkdir(path.join(home, 'integrations'), { recursive: true, mode: 0o700 });
  // A complete lock of this boot whose owner is gone: the next acquire may reclaim it (ESRCH).
  await writeFile(path.join(home, 'integrations', 'web.lock'), JSON.stringify({ pid: dead, bootTime: bootTime(), startedAt: new Date().toISOString(), ready: true, lockVersion: 1, owner: randomUUID() }), { mode: 0o600 });
  await writeFile(path.join(home, 'web.json'), JSON.stringify({ version: 2, app: 'alp-web', pid: dead, port: 1, url: 'http://127.0.0.1:1/', token: `alpgw1.${'0'.repeat(16)}.${'A'.repeat(43)}`, credentialId: '0'.repeat(16) }), { mode: 0o600 });
  const served = await run(['web', '--print'], home);
  assert.equal(served.code, 0, served.stderr || served.stdout);
  const info = await webJson(home);
  assert.notEqual(info.pid, dead);
  assert.ok(alive(info.pid));
  assert.notEqual(info.token, `alpgw1.${'0'.repeat(16)}.${'A'.repeat(43)}`, 'a token without a credential is not reused');
  assert.equal(printedUrl(served).token, info.token);
});

test('alp web rotate replaces the token: the old one gets 401, never while the service writes', async t => {
  const { home } = await createHome(t);
  const first = await run(['web', '--print'], home);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const before = printedUrl(first);
  const info1 = await webJson(home);
  const credentials = path.join(home, 'web', 'credentials.json');
  const stored = await readFile(credentials, 'utf8');

  // Single writer: while alp-web holds the lock, the rotation refuses (exit 3) and writes nothing.
  const direct = await run(['--rotate'], home, 30_000, {}, alpWebService);
  assert.equal(direct.code, 3, direct.stderr || direct.stdout);
  assert.match(direct.stderr, new RegExp(`alp web runs \\(pid ${info1.pid}\\)`));
  assert.equal(await readFile(credentials, 'utf8'), stored, 'credentials untouched while the service runs');
  assert.equal((await webJson(home)).token, before.token);

  const rotated = await run(['web', 'rotate'], home);
  assert.equal(rotated.code, 0, rotated.stderr || rotated.stdout);
  const after = printedUrl(rotated);
  await waitGone(info1.pid);
  const info2 = await webJson(home);
  assert.notEqual(info2.pid, info1.pid, 'the service was stopped and started again');
  assert.equal(after.token, info2.token);
  assert.notEqual(after.token, before.token, 'a new token');
  assert.equal(after.port, before.port, 'on the same port');
  assert.equal(await ticketStatus(after.port, before.token), 401, 'an open page with the old token loses access');
  assert.equal(await ticketStatus(after.port, after.token), 201);
  const list = (await homeJson(home, path.join('web', 'credentials.json'))).credentials;
  assert.ok(list.find(entry => entry.id === info1.credentialId)?.revokedAt, 'the old credential is revoked');
  assert.deepEqual(list.filter(entry => !entry.revokedAt).map(entry => entry.id), [info2.credentialId]);
});

/**
 * The Paseo integration as it ran before its rename: integration `web` under the real lock protocol,
 * with an app-less web.json holding its token and server id. SIGTERM releases the lock, as it did.
 */
async function preRenamePaseo(t, home, identity) {
  const script = path.join(home, 'old-paseo.mjs');
  await writeFile(script, `
    import { writeFileSync } from 'node:fs';
    import { createIntegrationLock } from ${JSON.stringify(pathToFileURL(path.join(clientDist, 'integration-lock.js')).href)};
    const home = process.env.ALP_HOME;
    const lock = createIntegrationLock(home, 'web');
    const { acquired } = await lock.acquire();
    if (!acquired) process.exit(2);
    writeFileSync(home + '/web.json', JSON.stringify({ pid: process.pid, port: 1, url: 'http://127.0.0.1:1/', ...${JSON.stringify(identity)} }), { mode: 0o600 });
    await lock.setReady(true);
    process.on('SIGTERM', async () => { writeFileSync(home + '/old-paseo.stopped', 'SIGTERM'); await lock.release(); process.exit(0); });
    setInterval(() => {}, 1000);
  `);
  const child = spawn(process.execPath, [script], { stdio: 'ignore', env: { ...process.env, ...processFixtures.get(home).env } });
  t.after(() => { try { child.kill('SIGKILL'); } catch {} });
  await waitFor(async () => (await webLock(home))?.ready && (await webJson(home))?.pid === child.pid, 'the pre-rename Paseo integration');
  return child;
}

const IDENTITY = { token: 'c'.repeat(64), serverId: 'alp-0123456789abcdef' };

test('a live pre-rename Paseo integration is stopped, alp-web takes over, and its identity moves to paseo.json', async t => {
  const { home } = await createHome(t);
  const old = await preRenamePaseo(t, home, IDENTITY);
  const exited = new Promise(resolve => old.once('exit', code => resolve(code)));

  const served = await run(['web', '--print'], home);
  assert.equal(served.code, 0, served.stderr || served.stdout);
  assert.equal(await exited, 0, 'the old integration exited on its own SIGTERM handler');
  assert.equal(await readFile(path.join(home, 'old-paseo.stopped'), 'utf8'), 'SIGTERM');
  const info = await webJson(home);
  assert.equal(info.app, 'alp-web');
  assert.equal((await webLock(home)).pid, info.pid);
  assert.equal(printedUrl(served).token, info.token);
  assert.deepEqual(await paseoJson(home), IDENTITY, 'paired devices keep the token and server id');

  // The Paseo integration, started by alp web pair, picks the identity up.
  const paired = await run(['web', 'pair', '--off'], home);
  assert.equal(paired.code, 0, paired.stderr || paired.stdout);
  const paseo = await paseoJson(home);
  assert.equal(paseo.token, IDENTITY.token);
  assert.equal(paseo.serverId, IDENTITY.serverId);
  assert.equal((await paseoLock(home)).pid, paseo.pid);
});

test('the identity moves only into a home without paseo.json, and rotate moves it too', async t => {
  const { home } = await createHome(t);
  const kept = { token: 'd'.repeat(64), serverId: 'alp-fedcba9876543210' };
  await writeFile(path.join(home, 'paseo.json'), JSON.stringify(kept), { mode: 0o600 });
  await preRenamePaseo(t, home, IDENTITY);
  const served = await run(['web', '--print'], home);
  assert.equal(served.code, 0, served.stderr || served.stdout);
  assert.deepEqual(await paseoJson(home), kept, 'an existing paseo.json is never replaced');

  const other = await createHome(t);
  const old = await preRenamePaseo(t, other.home, IDENTITY);
  const rotated = await run(['web', 'rotate'], other.home);
  assert.equal(rotated.code, 0, rotated.stderr || rotated.stdout);
  await waitGone(old.pid);
  assert.deepEqual(await paseoJson(other.home), IDENTITY, 'rotate stops the old integration and keeps its identity');
  assert.equal((await webJson(other.home)).app, 'alp-web');
});

test('a web lock whose pid alp cannot prove is the integration is never signalled', async t => {
  const { home } = await createHome(t);
  await startDaemon(home);
  // An unrelated live process of this user, named by a lock written an hour before it started (a
  // reused pid), with an app-less web.json naming it too.
  const bystander = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, ...processFixtures.get(home).env } });
  t.after(() => { try { bystander.kill('SIGKILL'); } catch {} });
  await waitFor(async () => (await processFixtures.get(home).running()).some(entry => entry.pid === bystander.pid), 'the bystander');
  await mkdir(path.join(home, 'integrations'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(home, 'web.json'), JSON.stringify({ pid: bystander.pid, port: 1, url: 'http://127.0.0.1:1/', ...IDENTITY }), { mode: 0o600 });

  const reusedLock = { pid: bystander.pid, bootTime: bootTime(), startedAt: new Date(Date.now() - 3_600_000).toISOString(), lockVersion: 1, owner: randomUUID() };
  // Ready with an app-less web.json naming it, then not ready with no web.json at all: a foreign
  // owner is reported at once, not after a wait for a web.json it will never write.
  for (const ready of [true, false]) {
    await writeFile(path.join(home, 'integrations', 'web.lock'), JSON.stringify({ ...reusedLock, ready }), { mode: 0o600 });
    if (!ready) await rm(path.join(home, 'web.json'));
    for (const args of [['web', '--print'], ['web', 'rotate']]) {
      const began = Date.now();
      const refused = await run(args, home, 90_000);
      assert.notEqual(refused.code, 0, refused.stdout);
      assert.match(refused.stderr, /cannot prove[\s\S]*started after the lock was written/);
      assert.ok(Date.now() - began < 20_000, `${args.join(' ')} refused without waiting (${Date.now() - began} ms)`);
      assert.ok(alive(bystander.pid), `${args.join(' ')} left the bystander alone`);
    }
  }
  assert.equal((await webLock(home)).pid, bystander.pid, 'its lock is untouched');
  // Root may signal any pid, so EPERM is only observable for an unprivileged user.
  if (process.getuid?.() === 0 || process.platform === 'win32') return;
  // Another user's process (pid 1) is refused as well.
  await writeFile(path.join(home, 'integrations', 'web.lock'), JSON.stringify({ pid: 1, bootTime: bootTime(), startedAt: new Date().toISOString(), ready: true, lockVersion: 1, owner: randomUUID() }), { mode: 0o600 });
  await writeFile(path.join(home, 'web.json'), JSON.stringify({ pid: 1, port: 1, url: 'http://127.0.0.1:1/', ...IDENTITY }), { mode: 0o600 });
  const other = await run(['web', '--print'], home);
  assert.notEqual(other.code, 0, other.stdout);
  assert.match(other.stderr, /cannot prove[\s\S]*pid 1 belongs to another user/);
});

// ---- alp web pair: the Paseo integration, integration `paseo` ----

test('cold alp web pair --off starts the Paseo integration and reports the relay off', async t => {
  const { home } = await createHome(t);
  const daemon = await startDaemon(home);
  // No precondition: the CLI only returns from starting the integration once web.pairing is
  // registered, so a cold `pair` cannot race the RPC. Readiness itself guarantees the extension.
  const paired = await run(['web', 'pair', '--off'], home);
  assert.equal(paired.code, 0, paired.stderr || paired.stdout);
  assert.match(paired.stdout, /relay is off/i);
  const info = await paseoJson(home);
  assert.ok(info?.pid && info.pid !== daemon.pid, 'pair starts the integration as its own process');
  assert.equal((await paseoLock(home)).pid, info.pid);
  assert.equal(await webLock(home), undefined, 'pair does not start alp-web');
});

test('a killed Paseo integration keeps its token and server id when pair starts it again', async t => {
  const { home } = await createHome(t);
  await startDaemon(home);
  const first = await run(['web', 'pair', '--off'], home);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const info1 = await paseoJson(home);
  process.kill(info1.pid, 'SIGKILL');
  await waitGone(info1.pid);
  assert.ok(lockAlive(await readLock(home)), 'the core daemon survives the integration dying');
  const again = await run(['web', 'pair', '--off'], home);
  assert.equal(again.code, 0, again.stderr || again.stdout);
  const info2 = await paseoJson(home);
  assert.notEqual(info2.pid, info1.pid);
  assert.equal(info2.token, info1.token, 'the password paired devices use is kept');
  assert.equal(info2.serverId, info1.serverId, 'the server id is kept');
});

test('a restarted daemon is re-registered by the surviving Paseo integration', async t => {
  const { home } = await createHome(t);
  const daemon1 = await startDaemon(home);
  const first = await run(['web', 'pair', '--off'], home);
  assert.equal(first.code, 0, first.stderr || first.stdout);
  const info = await paseoJson(home);
  await waitFor(async () => (await callDaemon(daemon1.socket, 'web.pairing', {})) && true, 'web.pairing on the first daemon');

  const stopped = await run(['daemon', 'stop'], home, 20_000);
  assert.equal(stopped.code, 0, stopped.stderr || stopped.stdout);
  await waitGone(daemon1.pid);
  assert.ok(!lockAlive(await readLock(home)), 'the old daemon is gone');

  const daemon2 = await startDaemon(home);
  assert.notEqual(daemon2.pid, daemon1.pid, 'a new daemon process');
  const pairing = await waitFor(async () => await callDaemon(daemon2.socket, 'web.pairing', {}), 'web.pairing after the daemon restarted');
  assert.equal(typeof pairing.relayEnabled, 'boolean');
  assert.equal((await paseoJson(home)).pid, info.pid, 'the integration survives the daemon restart');
});

test('stale paseo.json from a dead process is replaced by a live Paseo integration', async t => {
  const { home } = await createHome(t);
  const daemon = await startDaemon(home);
  const dead = 2 ** 31 - 1;
  await writeFile(path.join(home, 'paseo.json'), JSON.stringify({ pid: dead, port: 1, token: 'a'.repeat(64), serverId: 'alp-0000000000000000', url: 'http://127.0.0.1:1/' }));
  const paired = await run(['web', 'pair', '--off'], home);
  assert.equal(paired.code, 0, paired.stderr || paired.stdout);
  const info = await paseoJson(home);
  assert.notEqual(info.pid, dead, 'the stale pid is not reported');
  assert.ok(info.pid !== daemon.pid && info.port > 1, 'a live integration serves');
});

/** A globally installed integration binary that discovery always finds, whatever PATH says. */
function installedIntegration() {
  return ['/opt/homebrew/bin', '/usr/local/bin'].flatMap(directory => ['alp-paseo-integration', 'alp-web-integration'].map(binary => path.join(directory, binary))).find(file => existsSync(file));
}

/** Runs `fn` with the distribution descriptor hidden and an environment that reaches no installed integration. */
async function withoutDiscovery(t, fn) {
  const hidden = `${integrationDescriptor}.hidden`;
  await rename(integrationDescriptor, hidden);
  t.after(async () => { await rename(hidden, integrationDescriptor).catch(() => {}); });
  const empty = await mkdtemp(path.join(tmpdir(), 'alp-no-home-'));
  t.after(() => rm(empty, { recursive: true, force: true }));
  try {
    return await fn({ PATH: empty, HOME: empty, USERPROFILE: empty, ALP_WEB_INTEGRATION: '', ALP_INTEGRATION_ENTRY: '', ALP_PASEO_INTEGRATION: '' });
  } finally {
    await rename(hidden, integrationDescriptor).catch(() => {});
  }
}

test('a home registered before the rename still starts the Paseo integration, with a hint', async t => {
  const installed = installedIntegration();
  if (installed) { t.skip(`${path.basename(installed)} is installed at ${installed}, which discovery always searches`); return; }
  const { home } = await createHome(t);
  await startDaemon(home);
  await mkdir(path.join(home, 'integrations'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(home, 'integrations', 'web.json'), JSON.stringify({ main: paseoEntry }));
  await withoutDiscovery(t, async env => {
    const paired = await run(['web', 'pair', '--off'], home, 60_000, env);
    assert.equal(paired.code, 0, paired.stderr || paired.stdout);
    assert.match(paired.stderr, /registered before its rename[\s\S]*alp-paseo-integration --register/);
    assert.equal((await paseoLock(home))?.pid, (await paseoJson(home))?.pid, 'the legacy entry runs as integration paseo');
    // alp web itself never runs that descriptor: it starts alp-web under the web lock.
    const served = await run(['web', '--print'], home, 60_000, env);
    assert.equal(served.code, 0, served.stderr || served.stdout);
    assert.equal((await webJson(home)).app, 'alp-web');
  });
});

test('the pre-rename fallback reads only the home descriptor, never PATH or other discovery', async t => {
  const installed = installedIntegration();
  if (installed) { t.skip(`${path.basename(installed)} is installed at ${installed}, which discovery always searches`); return; }
  const { directory, home } = await createHome(t);
  await startDaemon(home);
  // A stale home descriptor, and an `alp-web-integration` binary on PATH that a lookup for `web`
  // once found: neither may run, under the paseo lock or the web lock.
  await mkdir(path.join(home, 'integrations'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(home, 'integrations', 'web.json'), JSON.stringify({ main: path.join(directory, 'gone.js') }));
  const bin = path.join(directory, 'bin');
  await mkdir(bin);
  await symlink(paseoEntry, path.join(bin, 'alp-web-integration'));
  await withoutDiscovery(t, async env => {
    const refused = await run(['web', 'pair', '--off'], home, 60_000, { ...env, PATH: bin });
    assert.notEqual(refused.code, 0, refused.stdout);
    assert.match((refused.stderr || '') + (refused.stdout || ''), /optional integration package/i);
    assert.equal(await paseoLock(home), undefined, 'nothing ran as integration paseo');
    // A corrupt home descriptor is no registration either: the same guidance, not a parse error.
    await writeFile(path.join(home, 'integrations', 'web.json'), '{bad');
    const corrupt = await run(['web', 'pair', '--off'], home, 60_000, { ...env, PATH: bin });
    assert.notEqual(corrupt.code, 0, corrupt.stdout);
    assert.match((corrupt.stderr || '') + (corrupt.stdout || ''), /optional integration package/i);
    assert.equal(await paseoLock(home), undefined);
  });
});

test('a missing Paseo integration names the optional package, and alp web works without it', async t => {
  // Discovery always searches these system bin directories, whatever PATH and HOME say; an
  // integration installed there cannot be hidden from the CLI, so the refusal cannot be observed.
  const installed = installedIntegration();
  if (installed) { t.skip(`${path.basename(installed)} is installed at ${installed}, which discovery always searches`); return; }
  const { home } = await createHome(t);
  await startDaemon(home);
  // Hide the distribution descriptor so discovery finds no integration. Discovery also searches
  // PATH and the well-known bin directories under HOME, so the CLI gets an empty PATH and HOME and
  // no explicit overrides, and no installed integration is reachable.
  await withoutDiscovery(t, async env => {
    const refused = await run(['web', 'pair', '--off'], home, 60_000, env);
    assert.notEqual(refused.code, 0);
    assert.match((refused.stderr || '') + (refused.stdout || ''), /optional integration package/i);
    const served = await run(['web', '--print'], home, 60_000, env);
    assert.equal(served.code, 0, served.stderr || served.stdout);
    printedUrl(served);
  });
});

test('alp web pair prints the password kept in paseo.json', async t => {
  // A relay nobody answers: the link is offered whether or not it connects.
  const { home } = await createHome(t, { relay: { enabled: false, endpoint: '127.0.0.1:9' } });
  await startDaemon(home);
  const paired = await run(['web', 'pair', '--on'], home);
  assert.equal(paired.code, 0, paired.stderr || paired.stdout);
  const info = await paseoJson(home);
  assert.match(info?.token ?? '', /^[0-9a-f]{64}$/);
  assert.ok(paired.stdout.includes(`give it: ${info.token}`), paired.stdout);
  assert.doesNotMatch(paired.stdout, /#token=/);
  const off = await run(['web', 'pair', '--off'], home);
  assert.equal(off.code, 0, off.stderr || off.stdout);
});

test('alp-web and the Paseo integration run side by side in one home', async t => {
  const { home } = await createHome(t);
  const { port } = JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')).web;
  const paired = await run(['web', 'pair', '--off'], home);
  assert.equal(paired.code, 0, paired.stderr || paired.stdout);
  const paseo = await paseoJson(home);
  assert.notEqual(paseo.port, port, 'the Paseo integration leaves web.port to alp-web');
  const served = await run(['web', '--print'], home);
  assert.equal(served.code, 0, served.stderr || served.stdout);
  const web = await webJson(home);
  assert.equal(web.port, port, 'alp-web owns web.port');
  assert.notEqual(web.pid, paseo.pid);
  // Neither displaced the other.
  assert.deepEqual(await paseoJson(home), paseo);
  assert.equal((await paseoLock(home)).pid, paseo.pid);
  process.kill(web.pid, 'SIGTERM');
  await waitGone(web.pid);
  assert.ok(alive(paseo.pid), 'stopping alp-web leaves the Paseo integration alone');
  assert.equal(await webLock(home), undefined, 'alp-web released its lock');
});

// A minimal Paseo socket, so the bridge can be driven without a browser (FrameSocket in gateway.ts).
function fakeSocket() {
  const emitter = new EventEmitter();
  const frames = [];
  const socket = {
    readyState: 1,
    frames,
    send(data) { frames.push(JSON.parse(String(data))); return undefined; },
    close() { if (socket.readyState === 3) return; socket.readyState = 3; emitter.emit('close', 1000, ''); },
    on(event, listener) { emitter.on(event, listener); return socket; },
    receive(frame) { emitter.emit('message', JSON.stringify(frame), false); },
  };
  return socket;
}

async function untilValue(check, what, tries = 2000, gap = 5) {
  for (let i = 0; i < tries; i++) { const value = await check(); if (value) return value; await sleep(gap); }
  assert.fail(`Expected ${what} did not arrive`);
}

test('a reconnected bridge re-attaches roots with a fresh epoch and streams without duplicates', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-integration-reconnect-'));
  const home = path.join(directory, 'home');
  const project = path.join(directory, 'project');
  await seedLibrary(home);
  await initProject(project, { library: home });

  const agents = [];
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport(agents), supervisor: false, libraryDir: home });
  const daemon = createDaemonServer({ runtime, home, socketPath: '', version: 'test' });
  const attachCalls = [];
  const connections = [];
  let factoryCalls = 0;
  const clientFactory = async onEvent => {
    factoryCalls += 1;
    const client = daemon.local();
    client.onEvent(onEvent);
    connections.push(client);
    return {
      request: (method, params) => { if (method === 'session.attach') attachCalls.push(params); return client.request(method, params); },
      onEvent: listener => client.onEvent(listener),
      onClose: listener => client.onClose(listener),
      close: () => client.close(),
    };
  };
  const token = 'f'.repeat(64);
  const gateway = createPaseoBridge({ clientFactory, version: 'test', home, token: () => token, serverId: () => 'alp-0000000000000000' });
  t.after(async () => { await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });

  const socket = fakeSocket();
  gateway.attach(socket);
  socket.receive({ type: 'hello', clientId: 'cid-test', protocolVersion: 1, auth: { kind: 'password', password: token } });
  await untilValue(() => socket.frames.some(frame => frame.message?.payload?.status === 'server_info'), 'server_info');

  const session = message => socket.receive({ type: 'session', message });
  const ask = async message => {
    session(message);
    const frame = await untilValue(() => socket.frames.find(candidate => candidate.message?.payload?.requestId === message.requestId), `reply to ${message.type}`);
    return frame.message;
  };

  const created = await ask({ type: 'create_agent_request', requestId: 'a1', config: { provider: 'alp', cwd: project, title: 'Reconnect' }, initialPrompt: 'Hello', clientMessageId: 'm1', labels: {} });
  const agentId = created.payload.agentId;
  // Keep the first turn running across the connection loss: alpd retains a busy root and its log,
  // so the reconnect must replay the history rather than start from nothing.
  await untilValue(() => agents[0]?.started.length === 1, 'the first turn');

  const before = (await ask({ type: 'fetch_agent_timeline_request', requestId: 'tl1', agentId })).payload;
  assert.equal(before.error, null);
  const epochBefore = before.epoch;
  const texts = list => list.map(entry => entry.item.text);
  assert.deepEqual(texts(before.entries).filter(text => text === 'Hello'), ['Hello']);

  // Lose the daemon connection: the bridge must reconnect through the factory and re-subscribe.
  const attachesBefore = attachCalls.length;
  connections.at(-1).close();
  await untilValue(() => factoryCalls > 1, 'a reconnect');
  await untilValue(() => attachCalls.length > attachesBefore && attachCalls.at(-1)?.replay === true, 'a replay attach on the new connection');

  const after = (await ask({ type: 'fetch_agent_timeline_request', requestId: 'tl2', agentId })).payload;
  assert.equal(after.error, null);
  assert.notEqual(after.epoch, epochBefore, 'the replayed snapshot opens a new epoch');
  assert.equal(texts(after.entries).filter(text => text === 'Hello').length, 1, 'the replayed user message is not duplicated');

  // The turn finishes on the reconnected subscription and streams to the app.
  agents[0].finish('First answer.');
  await untilValue(
    () => socket.frames.some(frame => frame.message?.type === 'agent_stream' && frame.message.payload.event.type === 'timeline' && frame.message.payload.event.item?.text === 'First answer.'),
    'the resumed stream',
  );

  const done = (await ask({ type: 'fetch_agent_timeline_request', requestId: 'tl3', agentId })).payload;
  assert.equal(texts(done.entries).filter(text => text === 'Hello').length, 1, 'the user message stays single');
  assert.equal(texts(done.entries).filter(text => text === 'First answer.').length, 1, 'the answer appears once');
});
