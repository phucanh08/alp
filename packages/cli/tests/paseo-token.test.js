import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { paseoTokenSocketPath, readPaseoToken } from '../dist/commands/dashboard/paseo.js';
import { teardown } from '../../../test/support/teardown.ts';

/**
 * t-cde5: `alp dashboard pair` gets the Paseo password over the integration's private token socket.
 * That the CLI's path matches the integration's (integrations/paseo/server/web.ts tokenSocketPath)
 * and that it reads a live integration is in test/integration/dashboard-process.test.js: the CLI does
 * not depend on the Paseo integration package.
 */

const posix = process.platform !== 'win32';

test('t-cde5: the token socket: in <home>/paseo, under /tmp (not TMPDIR) for a long home, a named pipe on Windows', () => {
  assert.equal(paseoTokenSocketPath('/Users/someone/.alp', { platform: 'darwin', uid: 501 }), '/Users/someone/.alp/paseo/token.sock');
  assert.match(paseoTokenSocketPath(`/home/someone/${'y'.repeat(110)}/.alp`, { platform: 'linux', uid: 1000 }), /^\/tmp\/alp-paseo-1000-[0-9a-f]{12}\/token\.sock$/);
  assert.match(paseoTokenSocketPath('C:\\Users\\someone\\.alp', { platform: 'win32' }), /^\\\\\.\\pipe\\alp-paseo-[0-9a-f]{24}$/);
});

/** A socket as the integration serves it: 0600 in a 0700 <home>/paseo; it answers one request line. */
async function fakeIntegration(t, answers) {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-cli-cde5-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const home = path.join(directory, 'home');
  await mkdir(path.join(home, 'paseo'), { recursive: true, mode: 0o700 });
  const requests = [];
  const server = net.createServer(socket => {
    let received = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      received += chunk;
      if (!received.includes('\n')) return;
      const line = received.slice(0, received.indexOf('\n'));
      requests.push(line);
      socket.end(`${JSON.stringify(answers[line] ?? {})}\n`);
    });
  });
  // A home whose socket path is too long (a long TMPDIR, as on macOS CI) is served under /tmp.
  const socketPath = paseoTokenSocketPath(home);
  if (path.dirname(socketPath) !== path.join(home, 'paseo')) {
    await mkdir(path.dirname(socketPath), { recursive: true, mode: 0o700 });
    defer(() => rm(path.dirname(socketPath), { recursive: true, force: true }));
  }
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  defer(() => new Promise(resolve => server.close(resolve)));
  await chmod(socketPath, 0o600);
  return { home, requests };
}

test('t-cde5: readPaseoToken asks for the password, or a rotation, with one request line', { skip: !posix && 'Unix socket checks' }, async t => {
  const kept = 'a'.repeat(64);
  const rotated = 'b'.repeat(64);
  const { home, requests } = await fakeIntegration(t, { '{"op":"token"}': { token: kept, serverId: 'alp-0123456789abcdef', pid: 7 }, '{"op":"rotate"}': { token: rotated, pid: 7 } });
  const read = await readPaseoToken(home);
  assert.equal(read.token === kept, true);
  assert.deepEqual([read.serverId, read.pid], ['alp-0123456789abcdef', 7]);
  assert.equal((await readPaseoToken(home, { rotate: true })).token === rotated, true);
  assert.deepEqual(requests, ['{"op":"token"}', '{"op":"rotate"}']);
  // An answer that is not a password is refused.
  const other = await fakeIntegration(t, { '{"op":"token"}': { token: 'not-a-token' } });
  await assert.rejects(readPaseoToken(other.home), /gave no password/);
});

test('t-cde5: readPaseoToken refuses a socket that is not 0600 in a 0700 directory of the user\'s, and a missing one', { skip: !posix && 'POSIX modes' }, async t => {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-cli-cde5-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const shared = path.join(directory, 'shared');
  await mkdir(shared, { mode: 0o700 });
  const socketPath = path.join(shared, 'token.sock');
  const answered = [];
  const server = net.createServer(socket => { answered.push(socket); socket.end(`${JSON.stringify({ token: 'a'.repeat(64) })}\n`); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  defer(() => new Promise(resolve => server.close(resolve)));
  await chmod(socketPath, 0o600);
  await chmod(shared, 0o755);
  await assert.rejects(readPaseoToken(directory, { socketPath }), /directory owned by you with mode 0700/);
  await chmod(shared, 0o700);
  await chmod(socketPath, 0o666);
  await assert.rejects(readPaseoToken(directory, { socketPath }), /must have mode 0600, not 0666/);
  assert.equal(answered.length, 0, 'the client never connected to a socket that is not private');
  await assert.rejects(readPaseoToken(path.join(directory, 'no-home')), /token socket/, 'no integration, no password');
});
