import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLock, lockAlive } from '../../packages/client/src/index.js';

// t-1e02: the role subcommands the ALP executable starts itself with work from the npm CLI too.
const CLI = fileURLToPath(new URL('../../packages/cli/src/cli.js', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('alp bridge acp speaks MCP on stdio to the bridge socket, as `node -e <bridge>` does', { skip: process.platform === 'win32' && 'unix socket stand-in' }, async t => {
  const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-bridge-')));
  const socket = path.join(work, 'bridge.sock');
  const received = [];
  const server = net.createServer(connection => {
    connection.setEncoding('utf8');
    connection.on('data', data => {
      for (const line of data.split('\n').filter(Boolean)) {
        const message = JSON.parse(line);
        received.push(message);
        if (message.op === 'list') connection.write(`${JSON.stringify({ id: message.id, tools: [{ name: 'alp_probe' }] })}\n`);
      }
    });
  });
  await new Promise(resolve => server.listen(socket, resolve));
  const bridge = spawn(process.execPath, [CLI, 'bridge', 'acp'], { env: { ...process.env, ALP_BRIDGE_SOCKET: socket, ALP_BRIDGE_TOKEN: 'secret' }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { bridge.kill(); server.close(); await rm(work, { recursive: true, force: true }); });
  const lines = [];
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', data => lines.push(...data.split('\n').filter(Boolean).map(line => JSON.parse(line))));
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })}\n`);
  for (let i = 0; lines.length < 2 && i < 200; i++) await sleep(25);
  assert.equal(lines.find(line => line.id === 1)?.result?.serverInfo?.name, 'alp');
  assert.deepEqual(lines.find(line => line.id === 2)?.result?.tools, [{ name: 'alp_probe' }]);
  assert.equal(received[0].token, 'secret');
});

test('alp bridge refuses an unknown kind', () => {
  const result = spawnSync(process.execPath, [CLI, 'bridge', 'other'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /alp bridge <acp\|antigravity>/);
});

test('alp daemon run --detach starts alpd for the home, as `node alpd.js --detach` does', { timeout: 60_000 }, async t => {
  const work = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-daemon-run-')));
  const home = path.join(work, 'home');
  await mkdir(home, { mode: 0o700 });
  const env = { ...process.env, ALP_HOME: home };
  t.after(async () => {
    spawnSync(process.execPath, [CLI, 'daemon', 'stop'], { env, timeout: 30_000 });
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const started = spawnSync(process.execPath, [CLI, 'daemon', 'run', '--detach'], { env, encoding: 'utf8', timeout: 30_000 });
  assert.equal(started.status, 0, started.stderr);
  const lock = await readLock(home);
  assert.ok(lockAlive(lock) && lock.ready, 'alpd is ready');
  assert.notEqual(lock.pid, started.pid);
});
