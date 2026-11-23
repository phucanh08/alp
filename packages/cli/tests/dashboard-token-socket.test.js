import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { serveToken } from '../src/dashboard/token-socket.js';
import { readToken, tokenSocketPath } from '../src/dashboard-service.js';

/**
 * The token socket of alp dashboard (t-cee3): the only way to the token of the running service. It is
 * 0600 inside a 0700 directory, or the service does not run; it answers only a written request.
 */

const posix = process.platform !== 'win32';
const TOKEN = `alpgw1.${'a'.repeat(16)}.${'B'.repeat(43)}`;

async function scratchHome(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'alp-token-socket-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return home;
}

/** Connects and returns everything the server sends before it closes, after writing `request` (if any). */
function exchange(socketPath, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(socketPath);
    let text = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => { if (request !== undefined) socket.write(request); else setTimeout(() => socket.end(), 300); });
    socket.on('data', chunk => { text += chunk; });
    socket.on('error', reject);
    socket.on('close', () => resolve(text));
  });
}

test('the token socket path: <home>/dashboard/token.sock, a private temp directory for long homes, a pipe on Windows', () => {
  assert.equal(tokenSocketPath('/h/.alp', { platform: 'darwin' }), path.join('/h/.alp', 'dashboard', 'token.sock'));
  const long = `/${'x'.repeat(120)}`;
  const fallback = tokenSocketPath(long, { platform: 'linux' });
  assert.equal(path.basename(fallback), 'token.sock');
  assert.match(path.basename(path.dirname(fallback)), /^alp-dashboard-.+-[0-9a-f]{12}$/);
  assert.match(tokenSocketPath('C:\\Users\\u\\.alp', { platform: 'win32' }), /^\\\\\.\\pipe\\alp-dashboard-[0-9a-f]{24}$/);
  assert.notEqual(tokenSocketPath('/a', { platform: 'win32' }), tokenSocketPath('/b', { platform: 'win32' }), 'one pipe per home');
});

test('the service hands its token over a 0600 socket in a 0700 directory, only to a written request', async t => {
  const home = await scratchHome(t);
  const served = await serveToken({ home, token: () => TOKEN, credentialId: () => 'a'.repeat(16) });
  t.after(() => served.close());
  if (posix) {
    assert.equal(served.path, path.join(home, 'dashboard', 'token.sock'));
    assert.equal((await stat(served.path)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(served.path))).mode & 0o777, 0o700);
  }
  assert.deepEqual(await readToken(home), { token: TOKEN, credentialId: 'a'.repeat(16), pid: process.pid });
  // A client that only reads (on Windows, a handle opened with read access alone) gets nothing.
  assert.equal(await exchange(served.path), '');
  assert.equal(await exchange(served.path, 'token\n'), '', 'another request is closed unanswered');
  await served.close();
  if (posix) assert.equal(existsSync(served.path), false, 'closing removes the socket');
  await assert.rejects(readToken(home), 'no service, no token');
});

test('the service refuses to run when its socket is not 0600 (t-cee3)', { skip: !posix && 'POSIX file modes' }, async t => {
  const home = await scratchHome(t);
  await assert.rejects(
    serveToken({ home, token: () => TOKEN, credentialId: () => undefined, afterListen: socketPath => chmod(socketPath, 0o666) }),
    /token socket .* must have mode 0600, not 0666/,
  );
  assert.equal(existsSync(path.join(home, 'dashboard', 'token.sock')), false, 'no socket is left listening');
});

test('the service refuses to run when the socket directory is not 0700 (t-cee3)', { skip: !posix && 'POSIX file modes' }, async t => {
  const home = await scratchHome(t);
  // A directory that holds something is never tightened by ALP: it must be fixed by the user.
  await mkdir(path.join(home, 'dashboard', 'kept'), { recursive: true });
  await chmod(path.join(home, 'dashboard'), 0o755);
  await assert.rejects(serveToken({ home, token: () => TOKEN, credentialId: () => undefined }), /must be a directory owned by you with private permissions \(0700\)/);
  assert.equal(existsSync(path.join(home, 'dashboard', 'token.sock')), false);
  // And a directory widened after the socket was made.
  await chmod(path.join(home, 'dashboard'), 0o700);
  await assert.rejects(
    serveToken({ home, token: () => TOKEN, credentialId: () => undefined, afterListen: socketPath => chmod(path.dirname(socketPath), 0o750) }),
    /token socket must be in a directory owned by you with mode 0700/,
  );
  assert.equal(existsSync(path.join(home, 'dashboard', 'token.sock')), false);
});

test('the client refuses a socket that is not private, before it connects', { skip: !posix && 'POSIX file modes' }, async t => {
  const home = await scratchHome(t);
  const served = await serveToken({ home, token: () => TOKEN, credentialId: () => undefined });
  t.after(() => served.close());
  await chmod(served.path, 0o666);
  await assert.rejects(readToken(home), /must have mode 0600/);
});
