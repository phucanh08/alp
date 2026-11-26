// The protocol's conformance suite (docs/protocol/alp-json-rpc-v1.md §11) against a real alpd
// process with a fake Codex app-server: the runner reaches it only through its socket, as it
// would another implementation. No model is called.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { initProject } from '@anhlp/alp-core/init';
import { readLock } from '@anhlp/alp-client';
import { runConformance, PROFILES } from '@anhlp/alp-protocol/conformance';

const ALPD = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./support/fake-codex.js', import.meta.url));
const RUNNER = fileURLToPath(import.meta.resolve('@anhlp/alp-protocol/conformance'));
const skip = process.platform === 'win32' && 'the fake provider is a Node script run as an executable';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function daemon(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alpd-conformance-'));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), '{}');
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const logFile = path.join(directory, 'alpd.log');
  const log = openSync(logFile, 'a');
  const child = spawn(process.execPath, [ALPD], { detached: true, stdio: ['ignore', log, log], env: { ...process.env, ALP_HOME: home, ALP_CODEX_BIN: FAKE_CODEX } });
  closeSync(log);
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} await Promise.race([exited, sleep(3000)]); }
    if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  for (let i = 0; ; i++) {
    const lock = await readLock(home);
    if (lock?.ready && lock.pid === child.pid) return { socket: lock.socket, project, logFile };
    if (child.exitCode !== null || i > 400) assert.fail(`alpd did not start:\n${await readFile(logFile, 'utf8')}`);
    await sleep(25);
  }
}

test('alpd passes every conformance profile', { skip, timeout: 120_000 }, async t => {
  const { socket, project, logFile } = await daemon(t);
  const results = await runConformance({ socket, profiles: PROFILES, project, model: 'codex:gpt-5.6-sol', hold: '[hold]' });
  const failed = results.filter(result => !result.ok);
  assert.deepEqual(failed, [], `${failed.map(result => `${result.id}: ${result.error}`).join('\n')}\n--- alpd log ---\n${(await readFile(logFile, 'utf8')).slice(-4000)}`);
  assert.deepEqual(results.filter(result => result.note), [], 'no scenario may be skipped against alpd');
  assert.ok(results.length >= 25);
});

test('the runner works as a separate process against the daemon endpoint', { skip, timeout: 60_000 }, async t => {
  const { socket } = await daemon(t);
  const { stdout } = await promisify(execFile)(process.execPath, [RUNNER, '--socket', socket, '--profiles', 'handshake,wire,errors', '--json']);
  const results = JSON.parse(stdout);
  assert.ok(results.length > 10);
  assert.deepEqual(results.filter(result => !result.ok), []);
});
