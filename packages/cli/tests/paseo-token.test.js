import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { paseoTokenSocketPath, readPaseoToken } from '../src/interfaces.js';
import { createWebServer, tokenSocketPath } from '@anhlp/alp-paseo/web';
import { teardown } from '../../../test/support/teardown.js';

/** t-cde5: `alp dashboard pair` gets the Paseo password over the integration's private token socket. */

const posix = process.platform !== 'win32';

test('t-cde5: the CLI finds the integration\'s token socket where the integration serves it, on every platform', () => {
  const homes = ['/Users/someone/.alp', `/home/someone/${'y'.repeat(110)}/.alp`, '/tmp/a b/.alp', 'C:\\Users\\someone\\.alp'];
  for (const home of homes) {
    for (const platform of ['darwin', 'linux', 'win32']) {
      assert.equal(paseoTokenSocketPath(home, { platform, uid: 501 }), tokenSocketPath(home, { platform, uid: 501 }), `${platform} ${home}`);
    }
  }
});

test('t-cde5: readPaseoToken gets the password, and a rotation, from a live integration', { skip: !posix && 'Unix socket checks' }, async t => {
  const defer = teardown(t);
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-cli-cde5-'));
  defer(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const home = path.join(directory, 'home');
  const web = createWebServer({ home });
  const info = await web.listen();
  defer(() => web.close());
  const read = await readPaseoToken(home);
  assert.equal(read.token === info.token, true);
  assert.equal(read.serverId, info.serverId);
  const rotated = await readPaseoToken(home, { rotate: true });
  assert.equal(rotated.token !== info.token && web.token === rotated.token, true);
  assert.equal((await readPaseoToken(home)).token === rotated.token, true);
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
  await new Promise(resolve => server.listen(socketPath, resolve));
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
