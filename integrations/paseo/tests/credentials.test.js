import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWebServer, credentialDir, legacyRelayKeyFile, relayKeyFile, serveToken, tokenFile, tokenSocketPath, webFile } from '@anhlp/alp-paseo/web';
import { relayKeyPair } from '@anhlp/alp-paseo/paseo/relay';
import { teardown } from '../../../test/support/teardown.js';

/**
 * t-cde5: the Paseo password and the relay's secret key live only in the credential directory
 * <home>/paseo/ (0700, files 0600), which read-only agents may not read; paseo.json keeps no token;
 * an older home's copies move there once and leave their old places; the password reaches
 * `alp dashboard pair` only over a 0600 socket in a 0700 directory.
 */

const posix = process.platform !== 'win32';
const mode = async file => (await stat(file)).mode & 0o777;

async function scratch(t) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-cde5-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const home = path.join(directory, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  // A home whose socket path is too long (a long TMPDIR, as on macOS CI) has its socket under /tmp.
  const socketDirectory = path.dirname(tokenSocketPath(home));
  if (socketDirectory !== credentialDir(home)) defer(() => rm(socketDirectory, { recursive: true, force: true }));
  return { defer, home };
}

/** Every regular file under `root` whose bytes contain `needle`, relative to root. */
async function filesHolding(root, needle) {
  const found = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    if ((await readFile(file, 'utf8').catch(() => '')).includes(needle)) found.push(path.relative(root, file));
  }
  return found.sort();
}

/** Asks the socket at `socketPath` with one request line; resolves with what it answered. */
const ask = (socketPath, line) => new Promise((resolve, reject) => {
  const socket = net.connect(socketPath);
  let received = '';
  socket.setEncoding('utf8');
  socket.on('connect', () => { if (line !== undefined) socket.write(line); });
  socket.on('data', chunk => { received += chunk; });
  socket.on('error', reject);
  socket.on('close', () => resolve(received));
  setTimeout(() => socket.destroy(), 2_000).unref();
});

test('t-cde5: a fresh start keeps the password only in <home>/paseo/token.json (0600, in 0700), paseo.json names no token', async t => {
  const { defer, home } = await scratch(t);
  const web = createWebServer({ home });
  const info = await web.listen();
  defer(() => web.close());
  assert.match(info.token, /^[a-f0-9]{64}$/);
  const published = JSON.parse(await readFile(webFile(home), 'utf8'));
  assert.deepEqual(Object.keys(published).sort(), ['pid', 'port', 'serverId', 'url']);
  assert.equal(JSON.parse(await readFile(tokenFile(home), 'utf8')).token === info.token, true);
  assert.deepEqual(await filesHolding(home, info.token), ['paseo/token.json'], 'no file outside the credential directory holds the password');
  await relayKeyPair(home);
  assert.deepEqual((await readdir(credentialDir(home))).filter(name => name.endsWith('.json')).sort(), ['relay-keypair.json', 'token.json']);
  if (posix) {
    assert.equal(await mode(credentialDir(home)), 0o700);
    assert.equal(await mode(tokenFile(home)), 0o600);
    assert.equal(await mode(relayKeyFile(home)), 0o600);
    assert.equal(await mode(webFile(home)), 0o600);
  }
  assert.deepEqual((await readdir(home)).filter(name => name.endsWith('.tmp')), [], 'no temporary file is left');
});

test('t-cde5: an older home\'s password (paseo.json), pre-rename identity (web.json) and relay key move into <home>/paseo/ and leave their old places', async t => {
  const { defer, home } = await scratch(t);
  const token = 'e'.repeat(64);
  const serverId = 'alp-00112233445566aa';
  await writeFile(webFile(home), JSON.stringify({ port: 1, token, url: 'http://127.0.0.1:1/', pid: 1, serverId }), { mode: 0o600 });
  // A pre-rename web.json beside it (paseo.json wins; web.json's copy is dead and still leaves).
  await writeFile(path.join(home, 'web.json'), JSON.stringify({ port: 2, token: 'f'.repeat(64), serverId: 'alp-ffffffffffffffff', pid: 2 }), { mode: 0o600 });
  const keys = { v: 2, publicKeyB64: 'public', secretKeyB64: 'secret-key-before-t-cde5' };
  await writeFile(legacyRelayKeyFile(home), JSON.stringify(keys), { mode: 0o600 });

  const web = createWebServer({ home });
  const info = await web.listen();
  defer(() => web.close());
  assert.equal(info.token === token, true, 'the password is kept: paired devices stay paired');
  assert.equal(info.serverId, serverId);
  assert.equal('token' in JSON.parse(await readFile(webFile(home), 'utf8')), false, 'paseo.json lost its token');
  assert.deepEqual(JSON.parse(await readFile(path.join(home, 'web.json'), 'utf8')), { port: 2, serverId: 'alp-ffffffffffffffff', pid: 2 }, 'web.json lost its token, nothing else');
  await assert.rejects(stat(legacyRelayKeyFile(home)), { code: 'ENOENT' }, 'the old relay key file is gone');
  assert.deepEqual(JSON.parse(await readFile(relayKeyFile(home), 'utf8')), keys, 'the relay key moved unchanged');
  assert.deepEqual(await filesHolding(home, token), ['paseo/token.json']);
  assert.deepEqual(await filesHolding(home, 'f'.repeat(64)), []);
  assert.deepEqual(await filesHolding(home, keys.secretKeyB64), ['paseo/relay-keypair.json']);
  if (posix) assert.equal(await mode(relayKeyFile(home)), 0o600);
});

test('t-cde5: a home with only a pre-rename web.json carries its password into <home>/paseo/ and strips web.json', async t => {
  const { defer, home } = await scratch(t);
  const token = 'c'.repeat(64);
  await writeFile(path.join(home, 'web.json'), JSON.stringify({ port: 2, token, serverId: 'alp-0123456789abcdef', pid: 2 }), { mode: 0o600 });
  const web = createWebServer({ home });
  const info = await web.listen();
  defer(() => web.close());
  assert.equal(info.token === token, true);
  assert.equal(info.serverId, 'alp-0123456789abcdef');
  assert.deepEqual(await filesHolding(home, token), ['paseo/token.json']);
});

test('t-cde5: the token socket answers only a request line, with the password, and only a private socket in a private directory is served', { skip: !posix && 'POSIX modes' }, async t => {
  const { defer, home } = await scratch(t);
  const web = createWebServer({ home });
  const info = await web.listen();
  defer(() => web.close());
  const socketPath = tokenSocketPath(home);
  assert.equal(web.tokenSocket, socketPath);
  const preferred = path.join(home, 'paseo', 'token.sock');
  assert.equal(socketPath, Buffer.byteLength(preferred) < 100 ? preferred : tokenSocketPath(home));
  assert.equal((await stat(socketPath)).isSocket(), true);
  assert.equal(await mode(socketPath), 0o600);
  assert.equal(await mode(path.dirname(socketPath)), 0o700);
  assert.equal(await ask(socketPath), '', 'nothing is written on connect');
  assert.equal(await ask(socketPath, '{"op":"other"}\n'), '', 'an unknown request is closed without an answer');
  const answer = JSON.parse(await ask(socketPath, '{"op":"token"}\n'));
  assert.equal(answer.token === info.token, true);
  assert.equal(answer.serverId, info.serverId);
  assert.equal(answer.pid, process.pid);

  // A socket that is not 0600 stops the start, and none is left.
  const other = (await scratch(t)).home;
  await assert.rejects(serveToken({ home: other, answer: async () => ({}), afterListen: file => chmod(file, 0o644) }), /must have mode 0600, not 0644/);
  await assert.rejects(stat(tokenSocketPath(other)), { code: 'ENOENT' });
  if (path.dirname(tokenSocketPath(other)) !== credentialDir(other)) await assert.rejects(stat(path.dirname(tokenSocketPath(other))), { code: 'ENOENT' }, 'the /tmp directory goes too');
  // A credential directory that is not 0700 (and holds something) stops the start.
  const shared = (await scratch(t)).home;
  await mkdir(credentialDir(shared), { mode: 0o755 });
  await chmod(credentialDir(shared), 0o755);
  await writeFile(path.join(credentialDir(shared), 'other'), '');
  await assert.rejects(createWebServer({ home: shared }).listen(), /must be a directory owned by you with mode 0700/);
  assert.deepEqual(await filesHolding(shared, '"token"'), [], 'nothing was written');
});

test('t-cde5: rotating replaces the password on disk and in memory, and the socket answers the new one', async t => {
  const { defer, home } = await scratch(t);
  const web = createWebServer({ home });
  const info = await web.listen();
  defer(() => web.close());
  const rotated = posix ? JSON.parse(await ask(tokenSocketPath(home), '{"op":"rotate"}\n')).token : await web.rotate();
  assert.match(rotated, /^[a-f0-9]{64}$/);
  assert.equal(rotated !== info.token, true);
  assert.equal(web.token === rotated, true);
  assert.equal(JSON.parse(await readFile(tokenFile(home), 'utf8')).token === rotated, true);
  if (posix) assert.equal(JSON.parse(await ask(tokenSocketPath(home), '{"op":"token"}\n')).token === rotated, true);
  await web.close();
  // The next start keeps the rotated password.
  const again = createWebServer({ home });
  const next = await again.listen();
  defer(() => again.close());
  assert.equal(next.token === rotated, true);
});

test('t-cde5: the token socket path: in the credential directory, under /tmp for a long home (not TMPDIR), a named pipe on Windows', () => {
  const home = '/Users/someone/.alp';
  assert.equal(tokenSocketPath(home, { platform: 'darwin', uid: 501 }), '/Users/someone/.alp/paseo/token.sock');
  const long = `/Users/someone/${'x'.repeat(120)}/.alp`;
  const fallback = tokenSocketPath(long, { platform: 'linux', uid: 1000 });
  assert.match(fallback, /^\/tmp\/alp-paseo-1000-[0-9a-f]{12}\/token\.sock$/);
  assert.ok(Buffer.byteLength(fallback) < 100);
  assert.notEqual(tokenSocketPath(`${long}2`, { platform: 'linux', uid: 1000 }), fallback, 'each home has its own');
  const pipe = tokenSocketPath('C:\\Users\\someone\\.alp', { platform: 'win32' });
  assert.match(pipe, /^\\\\\.\\pipe\\alp-paseo-[0-9a-f]{24}$/);
  assert.notEqual(pipe, tokenSocketPath('C:\\Users\\other\\.alp', { platform: 'win32' }));
});
