// A client that shares no filesystem with alpd (Task 09): a separate process with its own HOME,
// ALP_HOME and working directory, importing only the portable SDK and the IPC transport, and run
// under Node's permission model so it cannot read the daemon's home or projects at all. Everything
// it does goes through RPC to a real alpd, and what it wrote is still there after alpd restarts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { initProject } from '@anhlp/alp-core/init';
import { readLock } from '@anhlp/alp-client';
import { validateResult } from '@anhlp/alp-protocol/contract';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const ALPD = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./support/fake-codex.js', import.meta.url));
const CLIENT = fileURLToPath(new URL('./support/remote-client.mjs', import.meta.url));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const skip = process.platform === 'win32' && 'the fake provider is a Node script run as an executable';

/** Node's permission model, by the flag this Node knows; network access only where it is gated. */
function permissionFlags(readable) {
  const flag = spawnSync(process.execPath, ['--permission', '-e', '0']).status === 0 ? '--permission' : '--experimental-permission';
  const major = Number(process.versions.node.split('.')[0]);
  return [flag, ...readable.map(entry => `--allow-fs-read=${entry}`), ...(major >= 25 ? ['--allow-net'] : [])];
}

async function startDaemon(t, home) {
  const logFile = path.join(home, '..', 'alpd.log');
  const log = openSync(logFile, 'a');
  const child = spawn(process.execPath, [ALPD], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ALP_HOME: home, ALP_CODEX_BIN: FAKE_CODEX } });
  closeSync(log);
  const exited = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} await Promise.race([exited, sleep(5000)]); }
    if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  };
  t.after(stop);
  for (let i = 0; ; i++) {
    const lock = await readLock(home);
    if (lock?.ready && lock.pid === child.pid) return { socket: lock.socket, stop };
    if (child.exitCode !== null || i > 400) assert.fail(`alpd did not start:\n${await readFile(logFile, 'utf8')}`);
    await sleep(25);
  }
}

test('a client with no shared filesystem runs tasks, library and settings through alpd, across a restart', { skip, timeout: 120_000 }, async t => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-remote-')));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  // The daemon host: its home and a project.
  const home = path.join(directory, 'daemon-home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), '{}');
  const project = path.join(directory, 'daemon-project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  // The client host: nothing of ALP in it, and the client may read only its own code.
  const clientHome = path.join(directory, 'client-home');
  await mkdir(path.join(clientHome, 'alp'), { recursive: true });
  const readable = [CLIENT, path.join(ROOT, 'package.json'), path.join(ROOT, 'packages/daemon/package.json'), path.join(ROOT, 'node_modules/@anhlp'), path.join(ROOT, 'packages/client'), path.join(ROOT, 'packages/protocol')];
  const flags = permissionFlags(readable);
  const denied = spawnSync(process.execPath, [...flags, '-e', `require('node:fs').readFileSync(${JSON.stringify(path.join(home, 'settings.json'))})`], { cwd: clientHome, encoding: 'utf8' });
  assert.notEqual(denied.status, 0, 'the client process cannot read the daemon home');
  assert.match(denied.stderr, /ERR_ACCESS_DENIED/);

  const remote = async (socket, steps) => {
    const { stdout } = await promisify(execFile)(process.execPath, [...flags, CLIENT, socket, JSON.stringify(steps)], {
      cwd: clientHome, env: { PATH: process.env.PATH, HOME: clientHome, ALP_HOME: path.join(clientHome, 'alp') },
    });
    const report = JSON.parse(stdout);
    for (const call of report.calls) if (call.result) assert.deepEqual(validateResult(call.method, call.result), [], `${call.method}: ${JSON.stringify(call.result)}`);
    return report;
  };
  const by = (report, method, index = 0) => report.calls.filter(call => call.method === method)[index];

  let daemon = await startDaemon(t, home);
  const secret = 'Bearer sk-remote-42';
  const first = await remote(daemon.socket, [
    ['task.create', { projectRoot: project, title: 'Từ máy khác', priority: 1, requestId: 'r-1' }],
    ['task.list', { projectRoot: project }],
    ['team.list', { projectRoot: project }],
    ['library.list', { kind: 'agents', projectRoot: project }],
    ['library.save', { kind: 'mcp', name: 'docs', scope: 'library', content: { server: { url: 'https://example.invalid/mcp', headers: { Authorization: secret } } }, revision: null }],
    ['library.get', { kind: 'mcp', name: 'docs' }],
    ['settings.language.set', { language: 'English' }],
    ['task.list', { projectRoot: path.join(project, 'src') }],
    ['task.list', { projectRoot: `${project}/../daemon-home` }],
  ]);
  for (const name of ['task', 'team', 'library', 'settings.language']) assert.ok(first.hello.capabilities.includes(name), name);
  const { id } = by(first, 'task.create').result;
  assert.deepEqual(by(first, 'task.list').result.tasks.map(task => [task.id, task.title]), [[id, 'Từ máy khác']]);
  assert.ok(by(first, 'team.list').result.teams.some(team => team.id === 'pho'));
  assert.ok(by(first, 'library.list').result.entries.some(entry => entry.name === 'main'));
  assert.deepEqual(by(first, 'library.get').result.secrets, ['/server/headers/Authorization']);
  assert.equal(by(first, 'task.list', 1).error.reason, 'not_alp_project');
  assert.equal(by(first, 'task.list', 2).error.reason, 'invalid_path');
  // What the client received names no secret and no path of the daemon's home.
  const received = JSON.stringify(first);
  assert.equal(received.includes('sk-remote-42'), false);
  assert.equal(received.includes(home), false);
  // The writes happened on the daemon host, by alpd.
  assert.equal(JSON.parse(await readFile(path.join(project, '.alp/tasks', `${id}.json`), 'utf8')).title, 'Từ máy khác');
  assert.equal(JSON.parse(await readFile(path.join(home, 'mcp/docs.json'), 'utf8')).headers.Authorization, secret);
  assert.equal(JSON.parse(await readFile(path.join(home, 'settings.json'), 'utf8')).language, 'English');

  await daemon.stop();
  daemon = await startDaemon(t, home);
  const oldRevision = by(first, 'library.get').result.revision;
  const second = await remote(daemon.socket, [
    ['task.list', { projectRoot: project }],
    ['settings.language.get', {}],
    ['library.get', { kind: 'mcp', name: 'docs' }],
    // Revisions are keyed per alpd process: one read before the restart no longer matches.
    ['library.save', { kind: 'mcp', name: 'docs', scope: 'library', content: by(first, 'library.get').result.content, revision: oldRevision }],
    ['task.update', { projectRoot: project, id, action: 'close', note: 'Đóng từ xa' }],
  ]);
  assert.deepEqual(by(second, 'task.list').result.tasks.map(task => task.id), [id]);
  assert.equal(by(second, 'settings.language.get').result.language, 'English');
  const reread = by(second, 'library.get').result;
  assert.deepEqual(reread.content.server.headers, { Authorization: { $secret: 'keep' } });
  assert.equal(by(second, 'library.save').error.reason, 'revision_conflict');
  assert.equal(by(second, 'task.update').result.status, 'closed');
  const third = await remote(daemon.socket, [
    ['library.save', { kind: 'mcp', name: 'docs', scope: 'library', content: reread.content, revision: reread.revision }],
  ]);
  assert.ok(by(third, 'library.save').result.revision);
  assert.equal(JSON.parse(await readFile(path.join(home, 'mcp/docs.json'), 'utf8')).headers.Authorization, secret, 'the kept secret survived the round trip');
  assert.equal(JSON.parse(await readFile(path.join(project, '.alp/tasks', `${id}.json`), 'utf8')).status, 'closed');
});
