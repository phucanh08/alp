import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { validateWSOutboundMessage } from '@getpaseo/protocol/validation/ws-outbound';
import { AlpRpcError } from '@anhlp/alp-protocol';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer } from '@anhlp/alp-daemon';
import { createWebServer, createPaseoBridge } from '@anhlp/alp-paseo';
import { seedLibrary } from '@anhlp/alp-core/library';
import { fakeTransport } from '../../../test/support/fake-agent.js';

/**
 * The Paseo checkout panels over alpd's workspace.git (issue #121, G1): the bridge runs no Git of
 * its own, so nothing a repository names runs, secrets stay hidden, and an alpd without the
 * capability gets Paseo's error shape.
 */

const posix = process.platform !== 'win32';
const hasGit = (() => { try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const skip = !hasGit ? 'git is not installed' : !posix ? 'the traps are POSIX shell scripts' : false;
const cleanEnv = () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^GIT_/i.test(key)) env[key] = value;
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
};

async function setup(t, { without = [] } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alp-paseo-git-')));
  const home = path.join(directory, 'home');
  await seedLibrary(home);
  for (const id of ['opencode', 'antigravity']) {
    const file = path.join(home, 'providers', `${id}.json`);
    const config = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...config, command: `alp-test-missing-${id}` }));
  }
  const runtime = createAlpRuntime({ language: 'English', transport: fakeTransport([]), supervisor: false, libraryDir: home });
  const daemon = createDaemonServer({ runtime, socketPath: '', version: 'test', home });
  const calls = [];
  let web;
  const gateway = createPaseoBridge({ clientFactory: async onEvent => {
    const client = daemon.local();
    client.onEvent(onEvent);
    return {
      // An older alpd: the methods it lacks are unknown to it.
      request: (method, params) => { calls.push(method); return without.includes(method) ? Promise.reject(new AlpRpcError({ code: -32601, message: `Unknown method '${method}'` })) : client.request(method, params); },
      close: client.close.bind(client), onClose: client.onClose.bind(client),
    };
  }, version: 'test', home, token: () => web.token, serverId: () => web.serverId });
  web = createWebServer({ home, port: 0, gateway });
  const info = await web.listen();
  t.after(async () => { await web.close(); await runtime.shutdown(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const client = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/ws`, []);
    const frames = [];
    const waiting = [];
    ws.on('message', data => {
      const frame = JSON.parse(String(data));
      const checked = validateWSOutboundMessage(frame);
      assert.ok(checked.success, `a frame Paseo's app drops: ${JSON.stringify(frame).slice(0, 300)}\n${checked.error}`);
      frames.push(frame);
      for (const wait of [...waiting]) if (wait.test(frame)) { waiting.splice(waiting.indexOf(wait), 1); wait.resolve(frame); }
    });
    ws.on('error', reject);
    ws.on('open', () => {
      t.after(() => ws.close());
      const next = test => new Promise(done => { const found = frames.find(test); if (found) done(found); else waiting.push({ test, resolve: done }); });
      resolve({ ws, frames, next, send: frame => ws.send(JSON.stringify(frame)) });
    });
  });
  client.send({ type: 'hello', clientId: 'cid-git', clientType: 'browser', protocolVersion: 1, capabilities: { helloRejection: true }, auth: { kind: 'password', password: info.token } });
  await client.next(frame => frame.message?.payload?.status === 'server_info');
  const ask = async message => {
    client.send({ type: 'session', message });
    return (await client.next(frame => frame.message?.payload?.requestId === message.requestId)).message.payload;
  };
  let opened = 0;
  const open = async cwd => assert.equal((await ask({ type: 'open_project_request', requestId: `open-${opened++}`, cwd })).error, null);
  return { directory, ask, open, calls, client };
}

async function repository(root) {
  await mkdir(root, { recursive: true });
  const git = (...args) => execFileSync('git', ['-c', 'user.name=ALP', '-c', 'user.email=alp@example.com', ...args], { cwd: root, env: cleanEnv(), encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  return git;
}

test('the checkout panels run nothing the repository names, and never show its secrets', { skip }, async t => {
  const { directory, ask, open, client } = await setup(t);
  const root = path.join(directory, 'repo');
  const git = await repository(root);
  await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
  await writeFile(path.join(root, 'b.txt'), 'kept\n');
  await writeFile(path.join(root, '.env'), 'TOKEN=hunter2\n');
  await writeFile(path.join(root, '.gitattributes'), '* diff=evil filter=evil\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  await open(root);
  git('mv', '.env', 'settings.txt');
  await writeFile(path.join(root, 'a.txt'), 'one\n2\n');
  // The repository's traps, set after the test's own git is done with it.
  const traps = path.join(directory, 'traps');
  await mkdir(traps);
  const trap = async (name, body = '') => {
    const file = path.join(directory, `${name}.sh`);
    await writeFile(file, `#!/bin/sh\necho ran >> '${path.join(traps, name)}'\n${body}\n`);
    await chmod(file, 0o755);
    return file;
  };
  git('config', 'core.fsmonitor', await trap('fsmonitor'));
  git('config', 'filter.evil.clean', await trap('clean', 'cat'));
  git('config', 'filter.evil.process', await trap('process'));
  git('config', 'diff.evil.textconv', await trap('textconv', 'cat "$1"'));
  git('config', 'diff.evil.command', await trap('command'));
  git('config', 'diff.external', await trap('external'));
  const later = new Date(Date.now() + 5_000);
  await utimes(path.join(root, 'b.txt'), later, later);

  const status = await ask({ type: 'checkout_status_request', requestId: 's1', cwd: root });
  assert.deepEqual([status.isGit, status.repoRoot, status.mainRepoRoot, status.isDirty, status.error], [true, root, null, true, null]);
  const diff = await ask({ type: 'subscribe_checkout_diff_request', requestId: 'd1', subscriptionId: 'sub-1', cwd: root, compare: { mode: 'uncommitted' } });
  assert.deepEqual(await readdir(traps), [], 'no trap ran');
  assert.deepEqual(diff.files.map(file => [file.path, file.status]), [['a.txt', 'ok']], 'the .env rename is not listed, on either side');
  assert.deepEqual(diff.files[0].hunks[0].lines.map(line => [line.type, line.content]), [['header', '@@ -1,2 +1,2 @@'], ['context', 'one'], ['remove', 'two'], ['add', '2']]);
  assert.ok(!JSON.stringify(client.frames).includes('hunter2'));
  const refreshed = await ask({ type: 'checkout.refresh.request', requestId: 'r1', cwd: root });
  assert.equal(refreshed.success, true);
  assert.deepEqual(await readdir(traps), [], 'no trap ran');
});

test('only a registry workspace at its repository\'s top level is a checkout; base and errors in Paseo\'s shapes', { skip }, async t => {
  const { directory, ask, open } = await setup(t);
  const root = path.join(directory, 'repo');
  const git = await repository(root);
  await mkdir(path.join(root, 'pkg'));
  await writeFile(path.join(root, 'pkg', 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  git('checkout', '-q', '-b', 'feature');
  await writeFile(path.join(root, 'pkg', 'a.txt'), 'b\n');
  git('commit', '-q', '-am', 'second');
  const plain = path.join(directory, 'plain');
  await mkdir(plain);
  for (const cwd of [root, path.join(root, 'pkg'), plain]) await open(cwd);

  const status = await ask({ type: 'checkout_status_request', requestId: 's1', cwd: root });
  assert.deepEqual([status.currentBranch, status.baseRef, status.aheadBehind, status.upstreamRef, status.aheadOfOrigin], ['feature', 'main', { ahead: 1, behind: 0 }, null, null]);
  const base = await ask({ type: 'subscribe_checkout_diff_request', requestId: 'd1', cwd: root, compare: { mode: 'base', baseRef: 'main' } });
  assert.deepEqual([base.error, base.files.map(file => file.path)], [null, ['pkg/a.txt']]);
  const unknown = await ask({ type: 'subscribe_checkout_diff_request', requestId: 'd2', cwd: root, compare: { mode: 'base', baseRef: 'no-such-branch' } });
  assert.deepEqual([unknown.error, unknown.files], [null, []], 'as before: no such base compares nothing');
  const option = await ask({ type: 'subscribe_checkout_diff_request', requestId: 'd3', cwd: root, compare: { mode: 'base', baseRef: '--output=/tmp/alp-x' } });
  assert.deepEqual([option.error, option.files], [null, []]);

  const sub = await ask({ type: 'checkout_status_request', requestId: 's2', cwd: path.join(root, 'pkg') });
  assert.deepEqual([sub.isGit, sub.error?.code], [false, 'NOT_ALLOWED'], 'a directory inside a repository is not read');
  const subDiff = await ask({ type: 'subscribe_checkout_diff_request', requestId: 'd4', cwd: path.join(root, 'pkg'), compare: { mode: 'uncommitted' } });
  assert.deepEqual([subDiff.error?.code, subDiff.files], ['NOT_GIT_REPO', []]);
  const none = await ask({ type: 'checkout_status_request', requestId: 's3', cwd: plain });
  assert.deepEqual([none.isGit, none.error], [false, null]);
  const noneDiff = await ask({ type: 'subscribe_checkout_diff_request', requestId: 'd5', cwd: plain, compare: { mode: 'uncommitted' } });
  assert.equal(noneDiff.error.code, 'NOT_GIT_REPO');
  const stranger = path.join(directory, 'stranger');
  await mkdir(stranger);
  const unregistered = await ask({ type: 'checkout_status_request', requestId: 's4', cwd: stranger });
  assert.deepEqual([unregistered.isGit, unregistered.error?.code], [false, 'NOT_ALLOWED']);
});

test('an alpd without workspace.git gets Paseo\'s error shape; the bridge never falls back to a Git of its own', { skip }, async t => {
  const { directory, ask, open, calls } = await setup(t, { without: ['workspace.git.status', 'workspace.git.diff'] });
  const root = path.join(directory, 'repo');
  const git = await repository(root);
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  await writeFile(path.join(root, 'a.txt'), 'b\n');
  await open(root);
  const marker = path.join(directory, 'fsmonitor-ran');
  git('config', 'core.fsmonitor', `touch '${marker}'`);
  const status = await ask({ type: 'checkout_status_request', requestId: 's1', cwd: root });
  assert.deepEqual([status.isGit, status.error?.code], [false, 'UNKNOWN']);
  assert.match(status.error.message, /workspace\.git/);
  const diff = await ask({ type: 'subscribe_checkout_diff_request', requestId: 'd1', cwd: root, compare: { mode: 'uncommitted' } });
  assert.deepEqual([diff.files, diff.error?.code], [[], 'UNKNOWN']);
  assert.ok(calls.includes('workspace.git.status') && calls.includes('workspace.git.diff'));
  await assert.rejects(readFile(marker), 'no local Git ran');
});
