// A file uploaded to Paseo reaches the runtime through a real alpd (issue #121 J): the provider reads
// it from Paseo's uploads (server/uploads.ts), uploads it into alpd's attachment store, alpd pins it
// and the ALP runtime stages a read-only copy whose path the native turn names. The native runtime is
// scripted; real Codex and Claude runs are test/e2e/attachments-real-e2e.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { daemonPaths } from '@anhlp/alp-client';
import { ATTACHMENT_HEADER, attachmentStageDir, createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';
import { createUploadReader } from '../server/dist/uploads.js';
import { createAlpProvider } from '../server/dist/provider-core.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const skip = process.platform === 'win32' && 'attachments are macOS and Linux only';

async function until(check, what = 'condition') {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${what} did not happen`);
}

function fakeTransport(transports) {
  return () => {
    const transport = {
      calls: [], threadId: `thread-${transports.length}`,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() {},
      async request(method, params) {
        this.calls.push({ method, params });
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') {
          const id = `turn-${this.calls.length}`;
          setTimeout(() => this.notification?.('turn/completed', { threadId: this.threadId, turn: { id, status: 'completed' } }), 5);
          return { turn: { id } };
        }
        return {};
      },
    };
    transports.push(transport);
    return transport;
  };
}

test('a Paseo upload becomes one alpd object the runtime reads from a staged copy; a repeat sends nothing again', { skip }, async t => {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'alp-paseo-alpd-')));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const home = path.join(directory, 'alp-home');
  await mkdir(home, { mode: 0o700 });
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const transports = [];
  const runtime = createAlpRuntime({ supervisor: false, transport: fakeTransport(transports), runLogDir: path.join(directory, 'runs'), attachmentStageDir: attachmentStageDir(home) });
  const store = createStore(path.join(home, 'state'));
  const server = createDaemonServer({ runtime, socketPath: daemonPaths(path.join(directory, 'd')).socket, version: 'test', store, home });
  t.after(async () => { await store.flush().catch(() => {}); await server.close().catch(() => {}); await runtime.shutdown(); });
  const alpd = server.local();
  await alpd.request('daemon.status');

  // Paseo's daemon wrote the upload where it writes them.
  const paseoHome = path.join(directory, 'paseo-home');
  const id = `upload_${randomUUID()}`;
  const bytes = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from([0, 1, 2, 0xff, 0])]);
  await mkdir(path.join(paseoHome, 'uploads', id), { recursive: true });
  const file = path.join(paseoHome, 'uploads', id, 'report.pdf');
  await writeFile(file, bytes);
  const part = { type: 'uploaded_file', id, fileName: 'report.pdf', mimeType: 'application/pdf', size: bytes.length, path: file };

  const registration = createAlpProvider({
    description: 'test',
    open: async () => ({ client: alpd, async shutdown() {} }),
    teams: async () => [],
    spec: () => ({ spec: { cwd: project, persist: true } }),
    projectRoot: cwd => cwd,
    modes: () => ({ modes: [{ id: 'full-access', label: 'Full access' }], defaultMode: 'full-access' }),
    cursors: false,
    repeatAfterRelink: false,
    readUpload: createUploadReader({ home: () => paseoHome }),
  });
  const connection = await registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  t.after(() => connection.close());
  const events = [];
  connection.onEvent(event => events.push(event));
  await connection.send({ type: 'session.open', requestId: 'open', sessionId: 's', config: { cwd: project, model: 'pho', mode: 'full-access', settings: {}, env: {}, mcpServers: {}, persist: true }, history: 'skip' });
  const prompt = content => connection.send({ type: 'session.prompt', sessionId: 's', prompt: { clientMessageId: 'p1', delivery: 'auto', input: { type: 'message', content } } });
  await prompt([{ type: 'text', text: 'read it' }, part]);
  await until(() => transports.some(transport => transport.calls.some(call => call.method === 'turn/start')), 'turn started');
  const results = () => events.filter(event => event.type === 'session.prompt_result');
  await until(() => results().length, 'prompt answered');
  assert.deepEqual(results().map(event => event.result.type), ['turn']);

  const start = transports.flatMap(transport => transport.calls).find(call => call.method === 'turn/start');
  const named = start.params.input.filter(input => input.type === 'text' && input.text.startsWith(ATTACHMENT_HEADER)).map(input => JSON.parse(input.text.slice(ATTACHMENT_HEADER.length).split('\n', 1)[0]));
  assert.equal(named.length, 1);
  assert.equal(named[0].name, 'report.pdf');
  assert.equal(named[0].sha256, sha256(bytes));
  assert.equal(path.dirname(named[0].path), attachmentStageDir(home), 'staged in alpd\'s directory, not Paseo\'s');
  assert.equal(sha256(await readFile(named[0].path)), sha256(bytes));
  assert.equal((await lstat(named[0].path)).mode & 0o777, 0o400);
  assert.ok(!JSON.stringify(start.params.input).includes(paseoHome), 'Paseo\'s upload path never reaches the runtime');

  // The same prompt again (a relink, a retry): the receipt answers it; one object stays.
  await prompt([{ type: 'text', text: 'read it' }, part]);
  await until(() => results().length >= 1, 'repeat answered');
  assert.equal(transports.flatMap(transport => transport.calls).filter(call => call.method === 'turn/start').length, 1, 'sent once');
  const objects = (await readdir(path.join(home, 'state', 'attachments'))).filter(name => /^[0-9a-f]{32}$/.test(name));
  assert.equal(objects.length, 1, 'one immutable object');
});
