// alpd killed at the boundaries of an attachment's publication (docs/protocol/alp-json-rpc-v1.md
// §12.6): a real alpd process (dist/alpd.js) with a fake Codex app-server, killed with SIGKILL at a
// crash point, then restarted on the same home. Nothing half written is ever published, and what
// was published survives.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '@anhlp/alp-core/init';
import { connect, readLock } from '@anhlp/alp-client';

const ALPD = fileURLToPath(new URL('../dist/alpd.js', import.meta.url));
const FAKE_CODEX = fileURLToPath(new URL('./support/fake-codex.js', import.meta.url));
const MODEL = 'codex:gpt-5.6-sol';
const skip = process.platform === 'win32' && 'POSIX processes only; attachments are not served on Windows';
const sha = data => createHash('sha256').update(data).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(check, what) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await sleep(25); }
  assert.fail(`${what} did not happen`);
}

async function harness(t, { config } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-attach-crash-')));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  await writeFile(path.join(home, 'settings.json'), '{}');
  if (config) await writeFile(path.join(home, 'attachments.json'), JSON.stringify(config));
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const logFile = path.join(directory, 'alpd.log');
  const started = [];
  t.after(async () => {
    for (const child of started) if (child.exitCode === null && child.signalCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  async function start({ crashAt } = {}) {
    const log = openSync(logFile, 'a');
    const child = spawn(process.execPath, [ALPD], {
      detached: true,
      stdio: ['ignore', log, log],
      env: { ...process.env, ALP_HOME: home, ALP_CODEX_BIN: FAKE_CODEX, FAKE_CODEX_JOURNAL: path.join(directory, 'provider.jsonl'), ...(crashAt ? { ALP_TEST_CRASH_AT: crashAt } : {}) },
    });
    closeSync(log);
    const exited = once(child, 'exit').then(([code, signal]) => ({ code, signal }));
    let gone = false;
    void exited.then(() => { gone = true; });
    started.push(child);
    await until(async () => {
      if (gone) assert.fail(`alpd exited while starting:\n${await readFile(logFile, 'utf8')}`);
      const lock = await readLock(home);
      return lock?.ready && lock.pid === child.pid;
    }, 'alpd to be ready');
    const client = await connect((await readLock(home)).socket, { name: 'attach-crash-test', version: '0' });
    return {
      request: (method, params) => client.request(method, params),
      async crashed() { const result = await exited; client.close(); assert.equal(result.signal, 'SIGKILL'); },
      async stop() { await client.request('daemon.shutdown').catch(() => {}); client.close(); await exited; },
    };
  }
  return { home, root: path.join(home, 'state', 'attachments'), start, create: daemon => daemon.request('session.create', { spec: { cwd: project, persist: true, model: MODEL } }) };
}

const data = Buffer.from('%PDF-1.4\n' + 'payload '.repeat(4000));

/** Begins and fills an upload with `data`; `requestId` lets a restarted client find it again. */
async function filled(daemon, sessionId, requestId) {
  const begun = await daemon.request('attachment.begin', { sessionId, name: 'report.pdf', size: data.length, mimeType: 'application/pdf', requestId });
  for (let offset = 0; offset < data.length; offset += 8192) {
    await daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset, data: data.subarray(offset, offset + 8192).toString('base64') });
  }
  return begun;
}

test('killed after the bytes were verified, before publication: nothing is published; after restart the same upload commits', { skip }, async t => {
  const h = await harness(t);
  const first = await h.start({ crashAt: 'attachment.commit.before-publish' });
  const { session } = await h.create(first);
  const begun = await filled(first, session.id, 'crash-1');
  await assert.rejects(first.request('attachment.commit', { uploadId: begun.uploadId, sha256: sha(data) }));
  await first.crashed();

  const second = await h.start();
  t.after(() => second.stop());
  const attachmentId = `att_${begun.uploadId.slice(4)}`;
  assert.equal((await second.request('attachment.get', { attachmentId }).catch(error => error)).data?.reason, 'not_found', 'never published');
  // The client resumes by repeating its begin: the same upload, every byte already there.
  const resumed = await second.request('attachment.begin', { sessionId: session.id, name: 'report.pdf', size: data.length, mimeType: 'application/pdf', requestId: 'crash-1' });
  assert.deepEqual([resumed.uploadId, resumed.state, resumed.received], [begun.uploadId, 'uploading', data.length]);
  const { attachment } = await second.request('attachment.commit', { uploadId: begun.uploadId, sha256: sha(data) });
  assert.equal(attachment.sha256, sha(data));
  assert.deepEqual(await readFile(path.join(h.root, begun.uploadId.slice(4), 'payload')), data);
});

test('killed right after publication: the attachment is there after restart and its payload is made read-only', { skip }, async t => {
  const h = await harness(t);
  const first = await h.start({ crashAt: 'attachment.commit.after-publish' });
  const { session } = await h.create(first);
  const begun = await filled(first, session.id, 'crash-2');
  await assert.rejects(first.request('attachment.commit', { uploadId: begun.uploadId, sha256: sha(data) }));
  await first.crashed();
  const payload = path.join(h.root, begun.uploadId.slice(4), 'payload');
  assert.equal((await stat(payload)).mode & 0o777, 0o600, 'the crash came before it was made read-only');

  const second = await h.start();
  t.after(() => second.stop());
  const { attachment } = await second.request('attachment.get', { attachmentId: `att_${begun.uploadId.slice(4)}` });
  assert.deepEqual([attachment.sha256, attachment.size, attachment.detectedMimeType], [sha(data), data.length, 'application/pdf']);
  assert.equal((await stat(payload)).mode & 0o777, 0o400);
  // The commit's repeat answers the published attachment.
  assert.deepEqual((await second.request('attachment.commit', { uploadId: begun.uploadId, sha256: sha(data) })).attachment, attachment);
});

test('killed inside begin before its meta: the leftover is never an upload and goes after the (operator-lowered) timeout', { skip }, async t => {
  const h = await harness(t, { config: { limits: { uploadTimeoutMs: 1000 } } });
  const first = await h.start({ crashAt: 'attachment.begin.before-meta' });
  assert.equal((await first.request('daemon.hello', { protocolVersion: 1 })).attachmentLimits.uploadTimeoutMs, 1000, 'the operator lowered it');
  const { session } = await h.create(first);
  await assert.rejects(first.request('attachment.begin', { sessionId: session.id, name: 'a.txt', size: 3, mimeType: 'text/plain', requestId: 'crash-3' }));
  await first.crashed();
  const [leftover] = (await readdir(h.root)).filter(name => /^[0-9a-f]{32}$/.test(name));
  assert.ok(leftover, 'a directory without meta was left');
  await sleep(1200);

  const second = await h.start();
  t.after(() => second.stop());
  await second.request('daemon.status');
  assert.ok(!(await readdir(h.root)).includes(leftover), 'removed at start, past the timeout');
  const again = await second.request('attachment.begin', { sessionId: session.id, name: 'a.txt', size: 3, mimeType: 'text/plain', requestId: 'crash-3' });
  assert.notEqual(again.uploadId.slice(4), leftover);
  assert.equal(again.received, 0);
});
