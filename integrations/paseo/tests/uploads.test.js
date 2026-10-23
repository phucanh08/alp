// Paseo's uploaded files as ALP attachments (issue #121 J, docs/protocol/alp-json-rpc-v1.md §12.6):
// the reader that only takes files from Paseo's uploads directory (server/uploads.ts), and the
// provider's translation of `uploaded_file` parts into attachment parts against a fake alpd
// attachment store (server/provider-core.ts). The web facade's side is facade-attachments.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_CAPABILITIES } from '@getpaseo/plugin/server/provider';
import { createUploadReader, paseoHome } from '../server/dist/uploads.js';
import { createAlpProvider } from '../server/dist/provider-core.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const posix = process.platform !== 'win32';

/** A Paseo home with one upload written as Paseo writes it, and a directory outside it. */
async function paseoFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'alp-paseo-uploads-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'paseo-home');
  const outside = path.join(root, 'outside');
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, 'secret.txt'), 'top secret');
  const upload = async (fileName, content) => {
    const id = `upload_${randomUUID()}`;
    const dir = path.join(home, 'uploads', id);
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, fileName);
    await writeFile(file, content);
    return { type: 'uploaded_file', id, fileName, mimeType: 'text/plain', size: Buffer.byteLength(content), path: file };
  };
  return { root, home, outside, upload };
}

/** The refusal names the file and no host path. */
async function refused(promise, fixture, pattern) {
  const error = await promise.then(() => assert.fail('expected a refusal'), error => error);
  assert.match(error.message, pattern);
  assert.ok(!error.message.includes(fixture.root), `the message names no host path: ${error.message}`);
  assert.ok(!error.message.includes(os.tmpdir()), `the message names no host path: ${error.message}`);
  return error;
}

test('paseoHome resolves as Paseo does: PASEO_HOME, ~ expanded, else ~/.paseo', () => {
  assert.equal(paseoHome({}), path.join(os.homedir(), '.paseo'));
  assert.equal(paseoHome({ PASEO_HOME: '~/other' }), path.join(os.homedir(), 'other'));
  assert.equal(paseoHome({ PASEO_HOME: '~' }), os.homedir());
  assert.equal(paseoHome({ PASEO_HOME: '/srv/paseo/../paseo' }), path.resolve('/srv/paseo'));
  assert.equal(paseoHome({ PASEO_HOME: 'relative' }), path.resolve('relative'));
});

test('the reader reads a file Paseo stored in its uploads', { skip: !posix }, async t => {
  const fixture = await paseoFixture(t);
  const file = await fixture.upload('notes.txt', 'hello file');
  const read = createUploadReader({ home: () => fixture.home });
  assert.equal(Buffer.from(await read(file, 1024)).toString(), 'hello file');
  // An empty upload (size 0) is a file too.
  const empty = await fixture.upload('empty.txt', '');
  assert.equal((await read(empty, 1024)).byteLength, 0);
});

test('the reader refuses anything that is not exactly one of Paseo\'s uploads', { skip: !posix }, async t => {
  const fixture = await paseoFixture(t);
  const read = createUploadReader({ home: () => fixture.home });
  const notUpload = /ALP cannot attach "[^"]+": it is not a file uploaded to this Paseo daemon/;

  // A link as the file itself, to a file outside.
  const linked = await fixture.upload('placeholder.txt', 'x');
  const linkPath = path.join(path.dirname(linked.path), 'link.txt');
  await symlink(path.join(fixture.outside, 'secret.txt'), linkPath);
  await refused(read({ ...linked, fileName: 'link.txt', path: linkPath, size: 10 }, 1024), fixture, notUpload);

  // The upload's directory is a link to a directory outside.
  const id = `upload_${randomUUID()}`;
  await symlink(fixture.outside, path.join(fixture.home, 'uploads', id));
  await refused(read({ type: 'uploaded_file', id, fileName: 'secret.txt', mimeType: 'text/plain', size: 10, path: path.join(fixture.home, 'uploads', id, 'secret.txt') }, 1024), fixture, notUpload);

  // `..` in the path, even when it resolves back inside.
  const good = await fixture.upload('good.txt', 'good');
  await refused(read({ ...good, path: `${path.join(fixture.home, 'uploads', good.id)}/../${good.id}/good.txt` }, 1024), fixture, notUpload);
  await refused(read({ ...good, path: `${path.join(fixture.home, 'uploads', good.id)}//good.txt` }, 1024), fixture, notUpload);

  // An absolute path outside the uploads, a relative one, and one in another upload's directory.
  await refused(read({ ...good, path: path.join(fixture.outside, 'secret.txt'), size: 10 }, 1024), fixture, notUpload);
  await refused(read({ ...good, path: '/etc/hosts' }, 1024), fixture, notUpload);
  await refused(read({ ...good, path: `uploads/${good.id}/good.txt` }, 1024), fixture, notUpload);
  const other = await fixture.upload('other.txt', 'other');
  await refused(read({ ...good, path: other.path }, 1024), fixture, notUpload);
  // A nested file below an upload directory, and an id that is not Paseo's.
  await mkdir(path.join(fixture.home, 'uploads', good.id, 'deeper'));
  await writeFile(path.join(fixture.home, 'uploads', good.id, 'deeper', 'x.txt'), 'good');
  await refused(read({ ...good, path: path.join(fixture.home, 'uploads', good.id, 'deeper', 'x.txt') }, 1024), fixture, notUpload);
  await refused(read({ ...good, id: '../outside' }, 1024), fixture, notUpload);

  // The uploads directory itself is a link.
  const swapped = await paseoFixture(t);
  const real = await swapped.upload('real.txt', 'real');
  await rename(path.join(swapped.home, 'uploads'), path.join(swapped.root, 'elsewhere'));
  await symlink(path.join(swapped.root, 'elsewhere'), path.join(swapped.home, 'uploads'));
  await refused(createUploadReader({ home: () => swapped.home })(real, 1024), swapped, notUpload);

  // A hard link to a file outside: it has two links.
  const hard = await fixture.upload('placeholder2.txt', 'x');
  const hardPath = path.join(path.dirname(hard.path), 'hard.txt');
  await link(path.join(fixture.outside, 'secret.txt'), hardPath);
  await refused(read({ ...hard, fileName: 'hard.txt', path: hardPath, size: 10 }, 1024), fixture, /ALP cannot attach "hard\.txt": it has other links/);

  // A size other than declared, a size over the limit (not read at all), a FIFO (never blocks), a file gone.
  const sized = await fixture.upload('sized.txt', '12345');
  await refused(read({ ...sized, size: 4 }, 1024), fixture, /ALP cannot attach "sized\.txt": it holds 5 bytes, not the 4 Paseo declared/);
  await refused(read(sized, 4), fixture, /ALP cannot attach "sized\.txt": it is larger than ALP takes \(4 bytes\)/);
  const fifo = await fixture.upload('fifo-placeholder', 'x');
  const fifoPath = path.join(path.dirname(fifo.path), 'pipe');
  execFileSync('mkfifo', [fifoPath]);
  await refused(read({ ...fifo, fileName: 'pipe', path: fifoPath, size: 0 }, 1024), fixture, notUpload);
  await refused(read({ ...sized, path: path.join(path.dirname(sized.path), 'gone.txt'), fileName: 'gone.txt' }, 1024), fixture, /ALP cannot attach "gone\.txt": it is no longer among Paseo's uploads/);

  // A name that is a path is shown by its last segment only.
  await refused(read({ ...good, fileName: `${fixture.outside}/secret.txt`, path: '/etc/hosts' }, 1024), fixture, /ALP cannot attach "secret\.txt"/);
});

/**
 * A fake alpd connection with an attachment store: uploads by requestId (a repeat answers the same
 * upload, or the committed object), chunks appended at `received`, commit checks the SHA-256.
 * `fail` lets a test make one method throw.
 */
function fakeAlpd({ limits = {}, capabilities = ['attachments', 'prompt.images'], handshake = true, hello, fail = () => undefined } = {}) {
  const uploads = new Map();
  const objects = new Map();
  const connection = {
    // handshake: false is an adapter without handshake capabilities; the provider asks daemon.hello.
    ...(handshake ? { capabilities } : {}),
    requests: [],
    closed: false,
    onEvent: () => () => {},
    onClose: () => () => {},
    close() { connection.closed = true; },
    sent: method => connection.requests.filter(request => request.method === method),
    objects,
    async request(method, params) {
      connection.requests.push({ method, params });
      const failure = fail(method, params, connection);
      if (failure) throw failure;
      switch (method) {
        case 'daemon.hello': return hello ?? { protocolVersion: 1, capabilities, attachmentLimits: { maxObjectBytes: 1024, maxPerPrompt: 8, maxPromptBytes: 4096, maxChunkBytes: 4, ...limits } };
        case 'session.create': return { session: { id: params.sessionId } };
        case 'attachment.begin': {
          let upload = uploads.get(params.requestId);
          if (upload && JSON.stringify(upload.params) !== JSON.stringify(params)) throw Object.assign(new Error('request_conflict'), { code: 1004, data: { reason: 'request_conflict' } });
          if (!upload) { upload = { params, uploadId: `up-${uploads.size + 1}`, bytes: Buffer.alloc(0) }; uploads.set(params.requestId, upload); }
          if (upload.attachmentId) return { uploadId: upload.uploadId, state: 'committed', received: params.size, size: params.size, maxChunkBytes: 8, attachmentId: upload.attachmentId };
          return { uploadId: upload.uploadId, state: 'uploading', received: upload.bytes.length, size: params.size, maxChunkBytes: 8 };
        }
        case 'attachment.chunk': {
          const upload = [...uploads.values()].find(entry => entry.uploadId === params.uploadId);
          if (params.offset > upload.bytes.length) throw Object.assign(new Error('offset_mismatch'), { code: 1004, data: { reason: 'offset_mismatch', received: upload.bytes.length } });
          const data = Buffer.from(params.data, 'base64');
          upload.bytes = Buffer.concat([upload.bytes.subarray(0, params.offset), data]);
          return { received: upload.bytes.length, size: upload.params.size };
        }
        case 'attachment.commit': {
          const upload = [...uploads.values()].find(entry => entry.uploadId === params.uploadId);
          assert.equal(sha256(upload.bytes), params.sha256);
          upload.attachmentId ??= `att-${objects.size + 1}`;
          objects.set(upload.attachmentId, { bytes: upload.bytes, name: upload.params.name, mimeType: upload.params.mimeType, requestId: upload.params.requestId });
          return { attachment: { attachmentId: upload.attachmentId, sessionId: upload.params.sessionId, name: upload.params.name, size: upload.bytes.length, sha256: params.sha256 } };
        }
        case 'attachment.get': return { attachment: { attachmentId: params.attachmentId } };
        case 'session.prompt': return { outcome: 'accepted' };
        default: return {};
      }
    },
  };
  return connection;
}

/** The ALP provider over `alpd`, with one root `s` open and Paseo's uploads at `home`. */
async function providerOver(t, alpd, { home, reader = true } = {}) {
  const registration = createAlpProvider({
    description: 'test',
    open: async () => ({ client: alpd, async shutdown() {} }),
    teams: async () => [],
    spec: () => ({ spec: { cwd: '/w' } }),
    projectRoot: cwd => cwd,
    modes: () => ({ modes: [{ id: 'full-access', label: 'Full access' }], defaultMode: 'full-access' }),
    cursors: false,
    repeatAfterRelink: false,
    ...(reader ? { readUpload: createUploadReader({ home: () => home }) } : {}),
  });
  const connection = await registration.connect({ versions: [1], capabilities: PROVIDER_CAPABILITIES });
  t.after(() => connection.close());
  const events = [];
  connection.onEvent(event => events.push(event));
  await connection.send({ type: 'session.open', requestId: 'open', sessionId: 's', config: { cwd: '/w', model: 'pho', mode: 'full-access', settings: {}, env: {}, mcpServers: {}, persist: true }, history: 'skip' });
  const prompt = (clientMessageId, content) => connection.send({ type: 'session.prompt', sessionId: 's', prompt: { clientMessageId, delivery: 'auto', input: { type: 'message', content } } });
  const failures = () => events.filter(event => event.type === 'session.prompt_result' && event.result.type === 'failed');
  return { connection, events, prompt, failures };
}

const IMAGE = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' };

test('uploaded files become attachment parts in place, order kept, other parts unchanged', { skip: !posix }, async t => {
  const fixture = await paseoFixture(t);
  const alpd = fakeAlpd();
  const { prompt, failures } = await providerOver(t, alpd, { home: fixture.home });
  const first = await fixture.upload('report.md', '# Report\nbody text');
  const second = await fixture.upload('data.csv', 'a,b\n1,2\n');
  await prompt('m1', [{ type: 'text', text: 'Look' }, first, { type: 'text', text: 'and' }, { ...second, mimeType: 'text/csv; charset=utf-8' }]);
  assert.deepEqual(failures(), []);
  const [sent] = alpd.sent('session.prompt');
  assert.deepEqual(sent.params.content, [{ type: 'text', text: 'Look' }, { type: 'attachment', attachmentId: 'att-1' }, { type: 'text', text: 'and' }, { type: 'attachment', attachmentId: 'att-2' }]);
  assert.equal(alpd.objects.get('att-1').bytes.toString(), '# Report\nbody text');
  assert.equal(alpd.objects.get('att-2').bytes.toString(), 'a,b\n1,2\n');
  assert.equal(alpd.objects.get('att-1').name, 'report.md');
  assert.equal(alpd.objects.get('att-2').mimeType, 'text/csv');
  // Chunks kept to the smaller of hello's maxChunkBytes and begin's: 4 bytes.
  assert.ok(alpd.sent('attachment.chunk').every(request => Buffer.from(request.params.data, 'base64').length <= 4));
  // The requestIds are of this prompt and part: 1 and 3. No host path went to alpd.
  const begins = alpd.sent('attachment.begin');
  assert.match(begins[0].params.requestId, /^paseo-upload:[0-9a-f]{40}:1$/);
  assert.match(begins[1].params.requestId, /^paseo-upload:[0-9a-f]{40}:3$/);
  assert.ok(!JSON.stringify(alpd.requests).includes(fixture.root), 'no host path is sent to alpd');

  // A text prompt passes as it was, without touching the store.
  await prompt('m2', [{ type: 'text', text: 'plain' }]);
  assert.deepEqual(alpd.sent('session.prompt')[1].params.content, [{ type: 'text', text: 'plain' }]);
  assert.equal(alpd.sent('attachment.begin').length, 2);
  // Images keep their handling: this provider does not advertise prompt.image, so Paseo's contract
  // refuses the prompt before the provider reads or uploads anything, with or without a file.
  await prompt('m3', [IMAGE, await fixture.upload('c.txt', 'c')]);
  assert.match(failures().at(-1).result.error.message, /does not support prompt\.image/);
  assert.equal(alpd.sent('attachment.begin').length, 2);
  assert.equal(alpd.sent('session.prompt').length, 2);
});

test('the same prompt sent again reuses its upload and object; an interrupted upload resumes', { skip: !posix }, async t => {
  const fixture = await paseoFixture(t);
  let dropChunks = 1;
  const alpd = fakeAlpd({ fail: (method, params) => method === 'attachment.chunk' && params.offset >= 4 && dropChunks-- > 0 ? Object.assign(new Error('ALP daemon connection closed'), { reason: 'disconnected' }) : undefined });
  const { prompt, failures } = await providerOver(t, alpd, { home: fixture.home });
  const file = await fixture.upload('long.txt', 'abcdefghijkl');
  // The first attempt fails after the first chunk: the prompt fails and nothing is sent.
  await prompt('m1', [file]);
  assert.equal(failures().length, 1);
  assert.equal(alpd.sent('session.prompt').length, 0);
  // Sent again (a retry): the same begin resumes at 4 bytes, one object is committed.
  await prompt('m1', [file]);
  assert.equal(failures().length, 1);
  const begins = alpd.sent('attachment.begin');
  assert.equal(begins.length, 2);
  assert.equal(begins[0].params.requestId, begins[1].params.requestId);
  assert.equal(alpd.sent('attachment.chunk').filter(request => request.params.offset === 0).length, 1, 'the bytes held are not sent again');
  assert.equal(alpd.objects.size, 1);
  assert.equal(alpd.objects.get('att-1').bytes.toString(), 'abcdefghijkl');
  // Repeated once more (a reconnect resending it): the committed object answers, no chunk moves.
  const chunks = alpd.sent('attachment.chunk').length;
  await prompt('m1', [file]);
  assert.equal(alpd.sent('attachment.chunk').length, chunks);
  assert.equal(alpd.objects.size, 1);
  const prompts = alpd.sent('session.prompt');
  assert.equal(prompts.length, 2);
  assert.deepEqual(prompts[0].params.content, prompts[1].params.content);
  assert.deepEqual(prompts[0].params.content, [{ type: 'attachment', attachmentId: 'att-1' }]);
  // Another message with the same file is another upload request.
  await prompt('m2', [file]);
  assert.notEqual(alpd.sent('attachment.begin').at(-1).params.requestId, begins[0].params.requestId);
});

test('a runtime that cannot read attachments (1005) fails the prompt, never succeeds', { skip: !posix }, async t => {
  const fixture = await paseoFixture(t);
  const alpd = fakeAlpd({ fail: method => method === 'session.prompt' ? Object.assign(new Error('This session\'s runtime cannot read attachments yet; they stay stored and the prompt was not sent'), { code: 1005, data: { reason: 'attachment_unsupported' } }) : undefined });
  const { prompt, events, failures } = await providerOver(t, alpd, { home: fixture.home });
  await prompt('m1', [{ type: 'text', text: 'see file' }, await fixture.upload('a.txt', 'aaa')]);
  assert.equal(failures().length, 1);
  assert.match(failures()[0].result.error.message, /cannot read attachments/);
  assert.ok(!events.some(event => event.type === 'session.prompt_result' && event.result.type !== 'failed'));
});

test('refusals happen before anything is sent and name files, never host paths', { skip: !posix }, async t => {
  const fixture = await paseoFixture(t);
  const check = async (alpd, content, pattern, options = {}) => {
    const { prompt, failures } = await providerOver(t, alpd, { home: fixture.home, ...options });
    await prompt(`m-${randomUUID()}`, content);
    assert.equal(failures().length, 1);
    const { message } = failures()[0].result.error;
    assert.match(message, pattern);
    assert.ok(!message.includes(fixture.root), `no host path: ${message}`);
    assert.equal(alpd.sent('session.prompt').length, 0, 'nothing is sent');
    assert.equal(alpd.sent('attachment.begin').length, 0, 'nothing is uploaded');
  };
  const file = await fixture.upload('a.txt', 'aaa');
  // A path outside Paseo's uploads.
  await check(fakeAlpd(), [{ type: 'text', text: 'x' }, { ...file, path: path.join(fixture.outside, 'secret.txt'), size: 10 }], /ALP cannot attach "a\.txt": it is not a file uploaded/);
  // No reader (the remote entry reads nothing on this machine).
  await check(fakeAlpd(), [file], /ALP cannot attach "a\.txt": files uploaded to Paseo are not sent to this ALP host/, { reader: false });
  // An alpd without the attachments capability.
  await check(fakeAlpd({ capabilities: ['prompt.images'] }), [file], /this alpd does not take file attachments/);
  // Over alpd's limits: too many, too large together, one too large.
  const other = await fixture.upload('b.txt', 'bbb');
  await check(fakeAlpd({ limits: { maxPerPrompt: 1 } }), [file, other], /at most 1/);
  await check(fakeAlpd({ limits: { maxPromptBytes: 5 } }), [file, other], /together they are larger/);
  await check(fakeAlpd({ limits: { maxObjectBytes: 2 } }), [file], /ALP cannot attach "a\.txt": it is larger than ALP takes \(2 bytes\)/);
  // Every file is read and checked before any upload: a refused later file leaves no object behind.
  await check(fakeAlpd(), [file, { type: 'text', text: 'x' }, { ...other, size: 7 }], /ALP cannot attach "b\.txt": /);
  await check(fakeAlpd(), [file, { ...other, path: path.join(fixture.outside, 'secret.txt') }], /ALP cannot attach "b\.txt": it is not a file uploaded/);
});

test('the provider fails closed on what alpd offers: capability and attachmentLimits from daemon.hello', { skip: !posix }, async t => {
  const fixture = await paseoFixture(t);
  const file = await fixture.upload('a.txt', 'aaa');
  const refused = async (alpd, pattern) => {
    const { prompt, failures } = await providerOver(t, alpd, { home: fixture.home });
    await prompt(`m-${randomUUID()}`, [file]);
    assert.equal(failures().length, 1);
    assert.match(failures()[0].result.error.message, pattern);
    assert.ok(!failures()[0].result.error.message.includes(fixture.root));
    assert.equal(alpd.sent('attachment.begin').length, 0, 'nothing is uploaded');
    assert.equal(alpd.sent('session.prompt').length, 0, 'nothing is sent');
  };
  const LIMITS = { maxObjectBytes: 1024, maxPerPrompt: 8, maxPromptBytes: 4096, maxChunkBytes: 4 };
  const noLimits = /ALP cannot attach "a\.txt": this alpd names no valid attachment limits/;
  // No attachmentLimits, or limits that are not safe non-negative integers, or zero counts: no files.
  await refused(fakeAlpd({ hello: { protocolVersion: 1, capabilities: ['attachments'] } }), noLimits);
  await refused(fakeAlpd({ hello: { protocolVersion: 1, capabilities: ['attachments'], attachmentLimits: [] } }), noLimits);
  for (const bad of [{ maxPerPrompt: 0 }, { maxPromptBytes: 0 }, { maxChunkBytes: 0 }, { maxObjectBytes: -1 }, { maxPerPrompt: 1.5 }, { maxChunkBytes: '4' }, { maxObjectBytes: 2 ** 60 }, { maxPerPrompt: undefined }]) {
    await refused(fakeAlpd({ limits: bad }), noLimits);
  }
  // A connection without handshake capabilities: the hello's list decides.
  await refused(fakeAlpd({ handshake: false, capabilities: ['prompt.images'] }), /this alpd does not take file attachments/);
  await refused(fakeAlpd({ handshake: false, hello: { protocolVersion: 1, attachmentLimits: LIMITS } }), /this alpd does not take file attachments/);
  {
    const alpd = fakeAlpd({ handshake: false });
    const { prompt, failures } = await providerOver(t, alpd, { home: fixture.home });
    await prompt('m-listed', [file]);
    assert.deepEqual(failures(), []);
    assert.deepEqual(alpd.sent('session.prompt')[0].params.content, [{ type: 'attachment', attachmentId: 'att-1' }]);
  }
  // A failed hello refuses the files, and is asked again for the next prompt.
  {
    let helloFails = 1;
    const alpd = fakeAlpd({ fail: method => method === 'daemon.hello' && helloFails-- > 0 ? new Error('hello went wrong') : undefined });
    const { prompt, failures } = await providerOver(t, alpd, { home: fixture.home });
    await prompt('m-1', [file]);
    assert.equal(failures().length, 1);
    assert.match(failures()[0].result.error.message, /ALP cannot attach "a\.txt": alpd did not say whether it takes file attachments/);
    assert.equal(alpd.sent('attachment.begin').length, 0);
    await prompt('m-1', [file]);
    assert.equal(failures().length, 1);
    assert.equal(alpd.sent('daemon.hello').length, 2);
    assert.equal(alpd.sent('session.prompt').length, 1);
    // Answered once, the offer is kept for the connection.
    await prompt('m-2', [file]);
    assert.equal(alpd.sent('daemon.hello').length, 2);
  }
});
