import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const client = new URL('../src/index.js', import.meta.url).href;
function paths(platform, homes) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', `
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platform)} });
    const { daemonPaths } = await import(${JSON.stringify(client)});
    console.log(JSON.stringify(${JSON.stringify(homes)}.map(home => daemonPaths(home))));
  `], { encoding: 'utf8' }));
}

test('Windows daemon endpoints are deterministic named pipes isolated by ALP_HOME', () => {
  const home = 'C:\\Users\\anhlp\\.alp';
  const [first, same, other, long] = paths('win32', [home, home, `${home}-other`, home.repeat(30)]);
  for (const entry of [first, other, long]) assert.match(entry.socket, /^\\\\\.\\pipe\\alpd-[a-f0-9]+$/);
  assert.equal(first.socket, same.socket);
  assert.notEqual(first.socket, other.socket);
  assert.ok(long.socket.length < 100);
  assert.equal(first.home, home);
  assert.match(first.lock, /alpd\.lock$/);
});

test('Unix daemon endpoints retain the short-home socket and bounded long-home fallback', () => {
  const [short, long, same] = paths('linux', ['/tmp/alp', '/tmp/' + 'x'.repeat(200), '/tmp/' + 'x'.repeat(200)]);
  assert.equal(short.socket, path.join('/tmp/alp', 'alpd.sock'));
  assert.ok(Buffer.byteLength(long.socket) < 100);
  assert.match(long.socket, /alpd-\d+-[a-f0-9]+[/\\]rpc\.sock$/);
  assert.notEqual(path.dirname(long.socket), path.dirname('/tmp/alp'));
  assert.equal(long.socket, same.socket);
});
