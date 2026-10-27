import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { connect, daemonPaths, readLock } from '@anhlp/alp-client/index';
import { fixtureProcesses } from '../../../test/support/fixture-processes.js';

/**
 * alp-web (packages/cli/dist/alp-web.js), the service behind `alp web`, as a real process under a
 * temporary ALP_HOME: one loopback listener with the gateway and the built app, its lock and
 * web.json, its least-privilege credential and grant refresh, and the static server's own path
 * normalization (the gateway hands it the raw request target).
 */

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const SERVICE = path.join(root, 'packages/cli/dist/alp-web.js');
const BUILT_APP = path.join(root, 'packages/cli/dist/alp-web');
const DEFAULT_GRANT = ['session.read', 'session.write', 'project.read', 'project.write', 'workspace.write'];
const SECRET = 'TOP-SECRET-alp-web-fixture';
const INDEX = '<!doctype html><title>alp-web fixture</title>';
const posix = process.platform !== 'win32';
/** Each test starts real processes; none may hang the run. */
const limit = { timeout: 120_000 };

/** Waits until `probe` answers something truthy; polls a condition, never sleeps for ordering. */
async function waitFor(probe, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

/** A port P with P and P + 1 free on 127.0.0.1 right now. */
async function freePorts() {
  for (;;) {
    const server = net.createServer();
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    await new Promise(resolve => server.close(resolve));
    if (port >= 65_000) continue;
    const next = net.createServer();
    const free = await new Promise(resolve => { next.once('error', () => resolve(false)); next.listen(port + 1, '127.0.0.1', () => resolve(true)); });
    if (free) { await new Promise(resolve => next.close(resolve)); return port; }
  }
}

/** One HTTP exchange with the raw request target exactly as given. */
function request(port, target, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const sent = http.request({ host: '127.0.0.1', port, method, path: target, headers: { host: `127.0.0.1:${port}`, ...headers }, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    sent.on('error', reject);
    sent.end(body);
  });
}

/** A request line written to the socket byte for byte, for targets an HTTP client refuses to send. */
function rawRequest(port, line) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end(`${line}\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    let text = '';
    socket.setEncoding('latin1');
    socket.on('data', chunk => { text += chunk; });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
}

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const tickets = (port, token, headers = {}) => request(port, '/v1/tickets', { method: 'POST', headers: { authorization: `Bearer ${token}`, ...headers } });

/** A temporary ALP_HOME whose detached descendants (the service, the alpd it starts) are stopped after the test. */
async function createHome(t, settings = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-web-service-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), JSON.stringify(settings));
  const processes = await fixtureProcesses(home);
  t.after(async () => {
    await processes.stop();
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { directory, home, env: processes.env };
}

/** The fixture app: an index, a content-named asset, a dot file, and symlinks that point outside. */
async function fixtureApp(directory) {
  const app = path.join(directory, 'app');
  const outside = path.join(directory, 'outside');
  await mkdir(path.join(app, 'assets'), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(app, 'index.html'), INDEX);
  await writeFile(path.join(app, 'assets', 'app-0123abcd.js'), 'export const app = 1;\n');
  await writeFile(path.join(app, '.hidden'), SECRET);
  await writeFile(path.join(directory, 'secret.txt'), SECRET);
  await writeFile(path.join(outside, 'secret.txt'), SECRET);
  await symlink(outside, path.join(app, 'escape'), posix ? 'dir' : 'junction');
  if (posix) await symlink(path.join(outside, 'secret.txt'), path.join(app, 'leak.txt'));
  return app;
}

/** Starts the service; resolves once its lock is ready and web.json names it. */
async function startService(context, { args = [], env = {}, wait = true } = {}) {
  const child = spawn(process.execPath, [SERVICE, '--service', ...args], { stdio: 'ignore', env: { ...process.env, ...context.env, ...env } });
  const exited = once(child, 'exit');
  if (!wait) return { child, exited };
  const web = await waitFor(async () => {
    if (child.exitCode !== null) assert.fail(`alp-web exited ${child.exitCode}:\n${await serviceLog(context.home)}`);
    const lock = await readJson(path.join(context.home, 'integrations', 'web.lock'));
    const info = await readJson(path.join(context.home, 'web.json'));
    return lock.ready && lock.pid === child.pid && info.pid === child.pid ? info : undefined;
  }, 'alp-web to become ready').catch(async error => {
    // What the service was doing, and what it left on disk, when it never became ready.
    const lock = await readFile(path.join(context.home, 'integrations', 'web.lock'), 'utf8').catch(() => '(none)');
    const info = await readFile(path.join(context.home, 'web.json'), 'utf8').catch(() => '(none)');
    throw new Error(`${error.message} (pid ${child.pid})\nweb.lock: ${lock}\nweb.json: ${info}\nlog:\n${await serviceLog(context.home)}`, { cause: error });
  });
  return { child, exited, web };
}

const serviceLog = home => readFile(path.join(home, 'logs', 'integrations', 'alp-web.log'), 'utf8').catch(() => '(no log)');

/** The process's exit [code, signal], or a failure after `timeoutMs` (a hang fails the test, it never waits forever). */
async function exitOf(service, timeoutMs = 30_000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`alp-web (pid ${service.child.pid}) did not exit within ${timeoutMs} ms`)), timeoutMs); });
  try { return await Promise.race([service.exited, timeout]); } finally { clearTimeout(timer); }
}

/**
 * The exit code a stop gives: on POSIX, SIGTERM is alp-web's graceful shutdown (exit 0, lock
 * released). Windows has no signals: kill() ends the process at once (exit code null), its lock is
 * left behind and the next start reclaims it from the dead pid.
 */
const STOPPED = posix ? 0 : null;

async function stopService(service) {
  service.child.kill('SIGTERM');
  const [code] = await exitOf(service);
  return code;
}

const credentialsOf = async home => (await readJson(path.join(home, 'web', 'credentials.json'))).credentials;

test('alp-web serves the app and the gateway on one loopback listener, with its own credential', limit, async t => {
  const port = await freePorts();
  const context = await createHome(t, { web: { port } });
  const project = path.join(context.directory, 'project');
  await mkdir(project);
  const app = await fixtureApp(context.directory);
  const service = await startService(context, { args: ['--project', project], env: { ALP_WEB_APP: app } });
  t.after(() => stopService(service).catch(() => {}));
  const { web } = service;

  // web.json v2: where it listens and the alpgw1 token of its credential, private.
  assert.deepEqual(Object.keys(web).sort(), ['app', 'credentialId', 'pid', 'port', 'token', 'url', 'version']);
  assert.equal(web.version, 2);
  assert.equal(web.app, 'alp-web');
  assert.equal(web.port, port);
  assert.equal(web.url, `http://127.0.0.1:${port}/`);
  assert.match(web.token, /^alpgw1\.[a-f0-9]{16}\.[A-Za-z0-9_-]{43}$/);
  assert.equal(web.token.split('.')[1], web.credentialId);
  if (posix) for (const file of ['web.json', 'web/credentials.json']) assert.equal((await stat(path.join(context.home, file))).mode & 0o777, 0o600, file);
  if (posix) assert.equal((await stat(path.join(context.home, 'web'))).mode & 0o777, 0o700, 'its credentials directory is private');

  // The credential: the default grant plus workspace.write, the project it was given, nothing else.
  const [credential, ...others] = await credentialsOf(context.home);
  assert.deepEqual(others, []);
  assert.equal(credential.id, web.credentialId);
  assert.equal(credential.label, 'alp web (this machine)');
  assert.deepEqual(credential.permissions, DEFAULT_GRANT);
  assert.deepEqual(credential.workspaces.map(entry => entry.path), [project]);

  // alpd is supervised: /readyz turns 200 once it answers.
  await waitFor(async () => (await request(port, '/readyz')).status === 200, '/readyz 200');
  assert.equal((await request(port, '/healthz')).status, 200);

  // The page, its routes and assets, with the security headers.
  const page = await request(port, '/');
  assert.equal(page.status, 200);
  assert.equal(page.body, INDEX);
  assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(page.headers['cache-control'], 'no-cache');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.headers['content-security-policy'], new RegExp(`connect-src 'self' http://127\\.0\\.0\\.1:${port} ws://127\\.0\\.0\\.1:${port}`));
  const head = await request(port, '/', { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-length'], String(Buffer.byteLength(INDEX)));
  const asset = await request(port, '/assets/app-0123abcd.js');
  assert.equal(asset.status, 200);
  assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8');
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  for (const route of ['/sessions/abc', '/settings/', '/index.html']) {
    const answer = await request(port, route);
    assert.equal(answer.status, 200, route);
    assert.equal(answer.body, INDEX, route);
  }
  for (const missing of ['/assets/missing.js', '/missing.css']) assert.equal((await request(port, missing)).status, 404, missing);
  assert.equal((await request(port, '/', { method: 'POST' })).status, 404, 'only GET and HEAD reach the files');

  // Host before anything else: an unknown name or another port is refused before any file is looked up.
  for (const host of ['evil.example', `evil.example:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1']) {
    for (const target of ['/', '/assets/app-0123abcd.js', '/escape/secret.txt', '/readyz']) {
      const answer = await request(port, target, { headers: { host } });
      assert.equal(answer.status, 421, `${host} ${target}`);
      assert.ok(!answer.body.includes(SECRET) && !answer.body.includes(INDEX), `${host} ${target} served nothing`);
    }
  }
  for (const host of [`localhost:${port}`, `[::1]:${port}`]) assert.equal((await request(port, '/', { headers: { host } })).status, 200, host);

  // Raw targets the static server must normalize itself: never a file outside the app, never the index.
  const attempts = [
    ['/../secret.txt', 404], ['/%2e%2e/secret.txt', 404], ['/assets/../../secret.txt', 404], ['/%252e%252e/secret.txt', 404],
    ['/..%2fsecret.txt', 400], ['/%2e%2e%2fsecret.txt', 400], ['/assets/..%2f..%2fsecret.txt', 400], ['/%2fsecret.txt', 400],
    ['//secret.txt', 400], ['//etc/passwd', 400], ['/assets//app-0123abcd.js', 400],
    ['/..\\secret.txt', 400], ['/\\..\\secret.txt', 400], ['/%5c..%5csecret.txt', 400], ['/assets%5capp-0123abcd.js', 400],
    ['/%00', 400], ['/index.html%00', 400], ['/index.html%00.js', 400], ['/%E0%A4%A', 400],
    ['/.hidden', 400], ['/C:/secret.txt', 400], ['/index.html::$DATA', 400], ['/escape/secret.txt', 404], ...(posix ? [['/leak.txt', 404]] : []),
  ];
  for (const [target, status] of attempts) {
    const answer = await request(port, target);
    assert.equal(answer.status, status, target);
    assert.ok(!answer.body.includes(SECRET), `${target} leaked a file outside the app`);
    assert.ok(!answer.body.includes(INDEX), `${target} fell back to the index`);
  }
  // A NUL in the request line itself never reaches the hook.
  const nul = await rawRequest(port, 'GET /index.html\0../../secret.txt HTTP/1.1');
  assert.match(nul, /^HTTP\/1\.1 400/);
  assert.ok(!nul.includes(SECRET));
  // A target the URL parser cannot read is a 400 from the gateway, not a crash of the service.
  for (const target of ['//[', '//x:99999/']) assert.match(await rawRequest(port, `GET ${target} HTTP/1.1`), /^HTTP\/1\.1 400 /, target);
  assert.equal((await request(port, '/healthz')).status, 200, 'still serving');
  assert.equal(service.child.exitCode, null, 'still running');

  // The token: a ticket from POST /v1/tickets, then a WebSocket with it.
  const ticket = await tickets(port, web.token);
  assert.equal(ticket.status, 201, ticket.body);
  const issued = JSON.parse(ticket.body);
  assert.equal(issued.principal.id, web.credentialId);
  assert.deepEqual(issued.principal.permissions, DEFAULT_GRANT);
  assert.deepEqual(issued.principal.workspaces, [project]);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`, issued.subprotocols);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = () => reject(new Error('the ticket did not open a WebSocket')); });
  assert.equal(socket.protocol, 'alp.v1');
  socket.close();
  assert.equal((await tickets(port, `${web.token.slice(0, -1)}${web.token.endsWith('A') ? 'B' : 'A'}`)).status, 401, 'another secret');
  // Browsers: the page's own origins only.
  assert.equal((await tickets(port, web.token, { origin: `http://localhost:${port}` })).status, 201);
  assert.equal((await tickets(port, web.token, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await tickets(port, web.token, { origin: `http://127.0.0.1:${port + 1}` })).status, 403);

  // A second start finds the lock held, exits and writes nothing.
  const before = await readFile(path.join(context.home, 'web', 'credentials.json'), 'utf8');
  const second = await startService(context, { args: ['--project', context.directory], env: { ALP_WEB_APP: app }, wait: false });
  assert.deepEqual(await exitOf(second), [0, null]);
  assert.equal(await readFile(path.join(context.home, 'web', 'credentials.json'), 'utf8'), before);
  assert.equal((await readJson(path.join(context.home, 'web.json'))).pid, service.child.pid);

  // SIGTERM: it stops, exits 0 and releases its lock (POSIX; on Windows the process just ends).
  assert.equal(await stopService(service), STOPPED);
  if (posix) {
    assert.equal(existsSync(path.join(context.home, 'integrations', 'web.lock')), false);
    assert.equal(existsSync(path.join(context.home, 'integrations', 'web.lock.reclaim')), false);
  }
});

test('the token survives a restart, and the built app is served when no override is set', limit, async t => {
  const port = await freePorts();
  const context = await createHome(t, { web: { port } });
  const first = await startService(context, { env: { ALP_SUPERVISE: '0' } });
  assert.equal(await stopService(first), STOPPED);
  const second = await startService(context, { env: { ALP_SUPERVISE: '0' } });
  t.after(() => stopService(second).catch(() => {}));
  assert.notEqual(second.web.pid, first.web.pid);
  assert.equal(second.web.token, first.web.token);
  assert.equal(second.web.credentialId, first.web.credentialId);
  const credentials = await credentialsOf(context.home);
  assert.deepEqual(credentials.map(entry => [entry.id, entry.revokedAt ?? null]), [[first.web.credentialId, null]]);
  // With nothing registered and no --project, a private empty directory stands in for a workspace.
  assert.deepEqual(credentials[0].workspaces.map(entry => entry.path), [path.join(context.home, 'web', 'no-project')]);
  assert.equal((await tickets(port, first.web.token)).status, 201);

  // packages/cli/dist/alp-web, as built beside the service, with the notices of its npm packages.
  const page = await request(port, '/');
  assert.equal(page.status, 200);
  assert.equal(page.body, await readFile(path.join(BUILT_APP, 'index.html'), 'utf8'));
  const script = /src="(\/assets\/[^"]+\.js)"/.exec(page.body)?.[1];
  assert.ok(script, 'the built index names its script');
  const served = await request(port, script);
  assert.equal(served.status, 200);
  assert.equal(served.headers['cache-control'], 'public, max-age=31536000, immutable');
  const notices = await readFile(path.join(BUILT_APP, 'THIRD-PARTY-NOTICES.txt'), 'utf8');
  for (const name of ['react', 'react-dom', '@xterm/xterm', 'tailwindcss', 'vite']) assert.match(notices, new RegExp(`\\n${name.replace(/[/.]/g, '\\$&')}@\\d`), name);
});

test('a stale web.json token is replaced and its credential revoked', limit, async t => {
  const port = await freePorts();
  const context = await createHome(t, { web: { port } });
  const first = await startService(context, { env: { ALP_SUPERVISE: '0' } });
  assert.equal(await stopService(first), STOPPED);
  // The token in web.json no longer matches its credential (lost secret, hand edit).
  const forged = { ...first.web, token: `alpgw1.${first.web.credentialId}.${'A'.repeat(43)}` };
  await writeFile(path.join(context.home, 'web.json'), JSON.stringify(forged), { mode: 0o600 });
  const second = await startService(context, { env: { ALP_SUPERVISE: '0' } });
  t.after(() => stopService(second).catch(() => {}));
  assert.notEqual(second.web.credentialId, first.web.credentialId);
  const credentials = await credentialsOf(context.home);
  assert.ok(credentials.find(entry => entry.id === first.web.credentialId).revokedAt, 'the old credential is revoked');
  assert.equal(credentials.filter(entry => !entry.revokedAt).length, 1);
  assert.equal((await tickets(port, first.web.token)).status, 401);
  assert.equal((await tickets(port, second.web.token)).status, 201);
});

test('a SIGTERM while startup waits on alpd exits 0, publishes nothing and releases the lock', { ...limit, skip: !posix && 'a Unix socket stands in for alpd' }, async t => {
  const context = await createHome(t, { web: { port: await freePorts() } });
  // An "alpd" that accepts and never answers: the first grant refresh of startup waits on it (bounded).
  const connections = [];
  const silent = net.createServer(socket => connections.push(socket));
  const socketPath = daemonPaths(context.home).socket;
  await new Promise(resolve => silent.listen(socketPath, resolve));
  await chmod(socketPath, 0o600);
  t.after(() => { for (const socket of connections) socket.destroy(); return new Promise(resolve => silent.close(resolve)); });
  const service = await startService(context, { env: { ALP_SUPERVISE: '0' }, wait: false });
  // Startup has made its credential and now waits in the registry call.
  await waitFor(async () => connections.length > 0 || service.child.exitCode !== null, 'startup to ask alpd for its projects');
  assert.equal(service.child.exitCode, null);
  service.child.kill('SIGTERM');
  assert.deepEqual(await exitOf(service), [0, null]);
  assert.equal(existsSync(path.join(context.home, 'web.json')), false, 'no web.json after the shutdown began');
  assert.equal(existsSync(path.join(context.home, 'integrations', 'web.lock')), false, 'the lock is released');
  assert.equal(existsSync(path.join(context.home, 'integrations', 'web.lock.reclaim')), false, 'and its guard');
  for (const directory of [context.home, path.join(context.home, 'web')]) {
    assert.deepEqual((await readdir(directory)).filter(name => name.endsWith('.tmp')), [], `no temporary file left in ${directory}`);
  }
});

test('web.enabled=false starts nothing', limit, async t => {
  const context = await createHome(t, { web: { enabled: false, port: await freePorts() } });
  const service = await startService(context, { env: { ALP_SUPERVISE: '0' }, wait: false });
  assert.deepEqual(await exitOf(service), [0, null]);
  for (const file of ['web.json', 'integrations/web.lock', 'web/credentials.json']) assert.equal(existsSync(path.join(context.home, file)), false, file);
});

test('a busy web.port moves to the next port, and web.permissions adds only known permissions', limit, async t => {
  const port = await freePorts();
  const busy = net.createServer();
  await new Promise(resolve => busy.listen(port, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => busy.close(resolve)));
  const context = await createHome(t, { web: { port, permissions: ['files.read'] } });
  const service = await startService(context, { env: { ALP_SUPERVISE: '0' } });
  t.after(() => stopService(service).catch(() => {}));
  assert.equal(service.web.port, port + 1);
  assert.equal(service.web.url, `http://127.0.0.1:${port + 1}/`);
  // The page's origin and Host follow the port it got.
  assert.equal((await tickets(port + 1, service.web.token, { origin: `http://127.0.0.1:${port + 1}` })).status, 201);
  assert.equal((await tickets(port + 1, service.web.token, { origin: `http://127.0.0.1:${port}` })).status, 403);
  assert.deepEqual((await credentialsOf(context.home))[0].permissions, ['session.read', 'session.write', 'project.read', 'project.write', 'files.read', 'workspace.write']);
});

test('an unknown web.permissions entry leaves the default grant, and says so', limit, async t => {
  const context = await createHome(t, { web: { port: await freePorts(), permissions: ['files.read', 'host.admin'] } });
  const service = await startService(context, { env: { ALP_SUPERVISE: '0' } });
  t.after(() => stopService(service).catch(() => {}));
  assert.deepEqual((await credentialsOf(context.home))[0].permissions, DEFAULT_GRANT);
  const warnings = (await serviceLog(context.home)).split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(record => record.code === 'ALP_WEB_PERMISSIONS_IGNORED');
  assert.equal(warnings.length, 1, 'one warning');
  assert.equal(warnings[0].level, 'warn');
  assert.match(warnings[0].msg, /"host\.admin" is not a permission/);
  assert.doesNotMatch(warnings[0].msg, /"files\.read"/, 'only the bad entry is named');
  assert.match(warnings[0].msg, /the default grant \(session\.read, session\.write, project\.read, project\.write, workspace\.write\) is in use/);
});

test('the credentials directory and file keep the gateway\'s private-mode checks', { ...limit, skip: !posix && 'POSIX file modes' }, async t => {
  const context = await createHome(t, { web: { port: await freePorts() } });
  const first = await startService(context, { env: { ALP_SUPERVISE: '0' } });
  assert.equal(await stopService(first), STOPPED);
  const file = path.join(context.home, 'web', 'credentials.json');
  const kept = { credentials: await readFile(file, 'utf8'), web: await readFile(path.join(context.home, 'web.json'), 'utf8') };
  const refused = async (what, pattern) => {
    const service = await startService(context, { env: { ALP_SUPERVISE: '0' }, wait: false });
    assert.deepEqual(await exitOf(service), [1, null], `${what}: it does not start`);
    assert.match(await serviceLog(context.home), pattern, what);
    assert.equal(await readFile(file, 'utf8'), kept.credentials, `${what}: no credential written`);
    assert.equal(await readFile(path.join(context.home, 'web.json'), 'utf8'), kept.web, `${what}: web.json untouched`);
    assert.equal(existsSync(path.join(context.home, 'integrations', 'web.lock')), false, `${what}: the lock is released`);
  };
  await chmod(file, 0o644);
  await refused('a credentials file others can read', /readable by other users/);
  await chmod(file, 0o600);
  await chmod(path.join(context.home, 'web'), 0o755);
  await refused('a credentials directory others can list', /alp web keeps its credentials in .*web, which must be a directory owned by you with private permissions \(0700\)/);
  await chmod(path.join(context.home, 'web'), 0o700);
  const again = await startService(context, { env: { ALP_SUPERVISE: '0' } });
  t.after(() => stopService(again).catch(() => {}));
  assert.equal(again.web.token, first.web.token, 'private again: the same credential');
});

test('without the built files the page says how to build them and the gateway stays up', limit, async t => {
  const port = await freePorts();
  const context = await createHome(t, { web: { port } });
  const empty = path.join(context.directory, 'empty');
  await mkdir(empty);
  const service = await startService(context, { env: { ALP_SUPERVISE: '0', ALP_WEB_APP: empty } });
  t.after(() => stopService(service).catch(() => {}));
  const page = await request(port, '/');
  assert.equal(page.status, 503);
  assert.match(page.body, /not built/);
  assert.match(page.body, /build-alp-web\.mjs/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal((await request(port, '/healthz')).status, 200);
  assert.equal((await tickets(port, service.web.token)).status, 201);
});

test('the grant follows alpd\'s project registry without a new token', limit, async t => {
  const port = await freePorts();
  const context = await createHome(t, { web: { port } });
  const [first, second] = [path.join(context.directory, 'first'), path.join(context.directory, 'second')];
  await mkdir(first);
  await mkdir(second);
  const service = await startService(context, { args: ['--project', first], env: { ALP_WEB_GRANT_REFRESH_MS: '100' } });
  t.after(() => stopService(service).catch(() => {}));
  const lock = await waitFor(async () => { const value = await readLock(context.home); return value?.ready ? value : undefined; }, 'alpd ready');
  assert.equal(lock.socket, daemonPaths(context.home).socket);
  const client = await connect(lock.socket);
  try {
    const { revision } = await client.request('project.list', {});
    await client.request('project.register', { directory: second, ifRevision: revision, requestId: 'alp-web-test' });
  } finally { client.close(); }

  const granted = await waitFor(async () => {
    const [credential] = await credentialsOf(context.home);
    return credential.workspaces.some(entry => entry.path === second) ? credential : undefined;
  }, 'the registered project in the grant');
  assert.deepEqual(granted.workspaces.map(entry => entry.path).sort(), [first, second].sort());
  assert.ok(granted.updatedAt, 'updated in place');
  assert.equal(granted.id, service.web.credentialId);
  const web = await readJson(path.join(context.home, 'web.json'));
  assert.equal(web.token, service.web.token, 'the token in web.json is unchanged');
  const ticket = await tickets(port, service.web.token);
  assert.equal(ticket.status, 201);
  assert.deepEqual(JSON.parse(ticket.body).principal.workspaces.sort(), [first, second].sort());
});

// A real dead process with prior-boot metadata must remain refused (never reclaimed).
async function priorBootLock(context) {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await once(child, 'exit');
  const file = path.join(context.home, 'integrations', 'web.lock');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const bytes = JSON.stringify({ pid: child.pid, bootTime: 1, startedAt: new Date().toISOString(), ready: true });
  await writeFile(file, bytes, { mode: 0o600 });
  return { file, bytes };
}

test('bootstrap lock refusal is logged privately and preserves the refused lock', limit, async t => {
  const context = await createHome(t);
  const kept = await priorBootLock(context);
  const token = `alpgw1.${'a'.repeat(16)}.${'B'.repeat(43)}`;
  await writeFile(path.join(context.home, 'web.json'), JSON.stringify({ token }));
  const service = await startService(context, { env: { ALP_SUPERVISE: '0' }, wait: false });
  assert.deepEqual(await exitOf(service), [1, null]);
  const log = await serviceLog(context.home);
  assert.ok(log.trim(), 'bootstrap failure must reach the service log');
  const record = log.trim().split('\n').map(line => JSON.parse(line)).find(line => line.code === 'ALP_WEB_START_FAILED');
  assert.ok(record, log);
  assert.match(log, /Integration owner boot context is uncertain/);
  assert.match(log, /manual lock-only recovery/);
  assert.ok(!log.includes(token));
  assert.equal(await readFile(kept.file, 'utf8'), kept.bytes);
  assert.equal(existsSync(path.join(context.home, 'web/credentials.json')), false);
  if (posix) assert.equal((await stat(path.join(context.home, 'logs/integrations/alp-web.log'))).mode & 0o777, 0o600);
});

test('a delayed web bootstrap refusal reports failed startup before the readiness deadline', limit, async t => {
  const context = await createHome(t);
  const kept = await priorBootLock(context);
  // Force exit after the launcher's initial 150ms observation, using the real built service.
  const preload = path.join(context.directory, 'delay.mjs');
  await writeFile(preload, `if (process.argv[1] === ${JSON.stringify(SERVICE)}) await new Promise(resolve => setTimeout(resolve, 400));`);
  const runner = path.join(context.directory, 'runner.mjs');
  await writeFile(runner, `import { startIntegration } from ${JSON.stringify(pathToFileURL(path.join(root, 'packages/client/src/index.js')).href)};
try { await startIntegration({ name: 'web', home: process.env.ALP_HOME, entry: ${JSON.stringify(SERVICE)} }); process.exitCode = 2; }
catch (error) { console.error(error.message); process.exitCode = 1; }`);
  const child = spawn(process.execPath, [runner], { env: { ...process.env, ...context.env, ALP_SUPERVISE: '0', NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }, stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostic = '';
  child.stderr.on('data', chunk => { diagnostic += chunk; });
  const service = { child, exited: once(child, 'exit') };
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await service.exited; });
  assert.deepEqual(await exitOf(service, 10_000), [1, null]);
  assert.match(diagnostic, /alp web .*failed to start; see .*alp-web\.log/);
  assert.match(await serviceLog(context.home), /Integration owner boot context is uncertain/);
  assert.equal(await readFile(kept.file, 'utf8'), kept.bytes);
});
