// Files attached to a message (#121 J): read in the browser within the hello's attachmentLimits,
// uploaded into alpd's attachment store under the message's session with a requestId derived from
// the message and the file's place, then named by attachment id in session.prompt. Against the
// in-memory host with a small attachment store; no runtime is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Controller } from '../src/lib/controller.js';
import { NO_FILES, abortUpload, fileLimits, fileName, fileRefusal, fileSize, fileType, fitFiles, messageContent, messageFiles, readFiles, uploadRequestId } from '../src/lib/attachments.js';
import { describe as describeError } from '../src/lib/errors.js';
import { FakeHost, until } from './support/fake-host.js';

const LIMITS = { maxObjectBytes: 64, maxPerPrompt: 3, maxPromptBytes: 100, maxChunkBytes: 16 };
/** A File-like value with these bytes. */
const file = (name, bytes, type = 'application/octet-stream') => ({ name, type, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

test('fileLimits fails closed and keeps an object within the prompt total', () => {
  assert.deepEqual(fileLimits(LIMITS, true), LIMITS);
  assert.deepEqual(fileLimits({ ...LIMITS, maxObjectBytes: 500 }, true).maxObjectBytes, 100);
  assert.deepEqual(fileLimits(LIMITS, false), NO_FILES, 'no capability: no files');
  for (const malformed of [undefined, null, [], {}, { ...LIMITS, maxChunkBytes: -1 }, { ...LIMITS, maxPerPrompt: 1.5 }, { ...LIMITS, maxChunkBytes: 0 }]) assert.deepEqual(fileLimits(malformed, true), NO_FILES);
});

test('fileRefusal: the host, the token, the limits, then the runtime, each with its reason', () => {
  const ok = { capable: true, permitted: true, writable: true, limits: LIMITS, session: { promptAttachments: ['file.path'], runtime: 'codex', agent: 'main' } };
  assert.equal(fileRefusal(ok), null);
  assert.match(fileRefusal({ ...ok, capable: false }), /does not store files/);
  assert.match(fileRefusal({ ...ok, permitted: false }), /needs attachments\.write/);
  assert.match(fileRefusal({ ...ok, writable: false }), /cannot send messages/);
  assert.match(fileRefusal({ ...ok, limits: NO_FILES }), /takes no files/);
  assert.equal(fileRefusal({ ...ok, session: { runtime: 'acp', agent: 'main' } }), 'main runs on acp here, which cannot read attached files.');
  assert.match(fileRefusal({ ...ok, session: { promptAttachments: [], runtime: 'codex' } }), /cannot read attached files/);
  assert.equal(fileRefusal({ ...ok, session: undefined, known: false }), null, 'a session not created yet: its runtime is checked once it exists');
  assert.match(fileRefusal({ ...ok, permitted: false, known: false }), /attachments\.write/);
});

test('fileName and fileType: display metadata as alpd keeps it, never a path', () => {
  assert.equal(fileName('re\u0000port‮.txt'), 'report.txt');
  assert.equal(fileName('../../etc/passwd'), '....etcpasswd');
  assert.equal(fileName('a\\b/c'), 'abc');
  assert.equal(fileName('\u0000​'), 'file');
  assert.equal(new TextEncoder().encode(fileName('é'.repeat(300))).length, 254);
  assert.equal(fileType({ type: 'Text/Plain; charset=utf-8' }), 'text/plain');
  assert.equal(fileType({ type: '' }), 'application/octet-stream');
  assert.equal(fileType({ type: 'not a type' }), 'application/octet-stream');
  assert.equal(fileSize(0), '0 B');
  assert.equal(fileSize(12), '12 B');
  assert.equal(fileSize(4096), '4 KB');
});

test('readFiles reads what fits (count, per file, together) and says why the rest was left out', async () => {
  const read = await readFiles([], [file('a.bin', [0, 1, 0]), file('big.bin', new Array(65).fill(1)), file('b.txt', [104, 105], 'text/plain')], LIMITS);
  assert.deepEqual(read.added.map(({ name, mimeType, size }) => ({ name, mimeType, size })), [{ name: 'a.bin', mimeType: 'application/octet-stream', size: 3 }, { name: 'b.txt', mimeType: 'text/plain', size: 2 }]);
  assert.deepEqual([...read.added[0].data], [0, 1, 0]);
  assert.match(read.error, /big\.bin is 1 KB; a file is at most 1 KB/);
  const four = await readFiles([], [1, 2, 3, 4].map(index => file(`${index}`, [index])), LIMITS);
  assert.equal(four.added.length, 3);
  assert.match(four.error, /at most 3 files/);
  const total = await readFiles([], [file('x', new Array(60).fill(1)), file('y', new Array(60).fill(2))], LIMITS);
  assert.equal(total.added.length, 1);
  assert.match(total.error, /together/);
  // Read next to nothing, then joined to what is attached now: the limits again.
  assert.equal(fitFiles(four.added, total.added, LIMITS).attachments.length, 3);
  assert.equal((await readFiles([], [file('a', [1])], NO_FILES)).added.length, 0);
});

test('uploadRequestId is stable per message and slot; messageContent names uploaded files by id only', () => {
  assert.equal(uploadRequestId('web-msg-1', 0), uploadRequestId('web-msg-1', 0));
  assert.notEqual(uploadRequestId('web-msg-1', 0), uploadRequestId('web-msg-1', 1));
  const image = { id: 'i', type: 'image', mimeType: 'image/png', data: 'QUFBQQ==', name: 'a.png', size: 4 };
  assert.deepEqual(messageContent('hi', [image], [{ attachmentId: 'att_1' }]), [{ type: 'text', text: 'hi' }, { type: 'image', mimeType: 'image/png', data: 'QUFBQQ==', name: 'a.png' }, { type: 'attachment', attachmentId: 'att_1' }]);
  assert.deepEqual(messageContent('', [], [{ attachmentId: 'att_1' }]), [{ type: 'attachment', attachmentId: 'att_1' }], 'a file-only message has no empty text');
  assert.deepEqual(messageContent('hi'), [{ type: 'text', text: 'hi' }]);
  assert.throws(() => messageContent('hi', [], [{}]), /not uploaded/);
});

test('messageFiles keeps ids, names and sizes only', () => {
  assert.deepEqual(messageFiles([{ attachmentId: 'att_1', name: 'a.txt', mimeType: 'text/plain', size: 2, path: '/host/secret' }, { name: 'no id', size: 1 }, null, { attachmentId: 'att_2', name: 'b', size: -1 }]), [{ attachmentId: 'att_1', name: 'a.txt', size: 2 }]);
  assert.deepEqual(messageFiles(undefined), []);
});

test('attachment refusals show the host\'s reason', () => {
  const error = Object.assign(new Error('This session\'s runtime cannot read attachments yet; they stay stored and the prompt was not sent'), { code: 1005, data: { reason: 'attachment_unsupported' } });
  const failure = describeError(error);
  assert.equal(failure.sent, 'yes');
  assert.equal(failure.message, 'This session\'s runtime cannot read attachments yet; they stay stored and the prompt was not sent.');
});

/**
 * A host with an attachment store as §12.6 describes it, enough for the controller: begin repeats
 * by requestId answer what is held, chunks append at `received`, commit checks the SHA-256.
 */
function hostWithStore({ promptAttachments = ['file.path'], permissions = ['session.read', 'session.write', 'project.read', 'attachments.write'], capable = true } = {}) {
  const host = new FakeHost({ principal: { id: 'p1', label: 'tests', permissions, workspaces: ['/w/a'], workspaceRoots: [{ path: '/w/a', canonical: '/w/a' }] } });
  if (capable) host.capabilities.push('attachments');
  host.intercept.set('daemon.hello', (_params, _connection, { answer }) => { answer({ protocolVersion: 1, capabilities: host.capabilities, ...(capable ? { attachmentLimits: { ...LIMITS, maxActiveUploads: 2 } } : {}) }); return 'handled'; });
  const store = { uploads: new Map(), objects: new Map(), begins: [], aborts: [], dropOnChunk: 0, failOnChunk: 0, holdChunk: 0, held: undefined, chunks: 0 };
  host.intercept.set('attachment.begin', (params, _connection, { answer, fail }) => {
    store.begins.push(params);
    if (!host.roots.has(params.sessionId)) { fail(1001, 'No such upload or attachment for this credential', { reason: 'not_found' }); return 'handled'; }
    let upload = store.uploads.get(params.requestId);
    if (!upload) store.uploads.set(params.requestId, upload = { uploadId: `upl_${store.uploads.size + 1}`, params, bytes: Buffer.alloc(0) });
    answer({ uploadId: upload.uploadId, state: upload.attachmentId ? 'committed' : 'uploading', received: upload.bytes.length, size: params.size, maxChunkBytes: 32, ...(upload.attachmentId ? { attachmentId: upload.attachmentId } : {}) });
    return 'handled';
  });
  host.intercept.set('attachment.chunk', (params, _connection, { answer, fail }) => {
    const upload = [...store.uploads.values()].find(entry => entry.uploadId === params.uploadId);
    const data = Buffer.from(params.data, 'base64');
    assert.ok(data.length <= LIMITS.maxChunkBytes, 'chunks keep to the hello limit');
    if (params.offset > upload.bytes.length) { fail(1004, 'offset', { reason: 'offset_mismatch', received: upload.bytes.length }); return 'handled'; }
    if (store.failOnChunk && store.chunks + 1 === store.failOnChunk) { store.chunks += 1; fail(1005, 'The attachment store of the daemon host cannot be used now', { reason: 'attachment_unavailable' }); return 'handled'; }
    upload.bytes = Buffer.concat([upload.bytes.subarray(0, params.offset), data]);
    store.chunks += 1;
    // The chunk is kept, but the connection drops before the answer leaves.
    if (store.dropOnChunk && store.chunks === store.dropOnChunk) { host.drop(); return 'handled'; }
    // The answer waits until the test lets it go.
    if (store.holdChunk && store.chunks === store.holdChunk) { store.held = () => answer({ received: upload.bytes.length, size: upload.params.size }); return 'handled'; }
    answer({ received: upload.bytes.length, size: upload.params.size });
    return 'handled';
  });
  host.intercept.set('attachment.commit', (params, _connection, { answer, fail }) => {
    const upload = [...store.uploads.values()].find(entry => entry.uploadId === params.uploadId);
    if (sha(upload.bytes) !== params.sha256) { fail(1004, 'hash', { reason: 'hash_mismatch' }); return 'handled'; }
    upload.attachmentId ??= `att_${store.objects.size + 1}`;
    const attachment = { attachmentId: upload.attachmentId, sessionId: upload.params.sessionId, name: upload.params.name, mimeType: upload.params.mimeType, size: upload.bytes.length, sha256: params.sha256, referenced: false };
    store.objects.set(upload.attachmentId, { ...attachment, bytes: upload.bytes });
    answer({ attachment });
    return 'handled';
  });
  host.intercept.set('attachment.get', (params, _connection, { answer, fail }) => {
    const stored = store.objects.get(params.attachmentId);
    if (!stored) { fail(1001, 'No such upload or attachment for this credential', { reason: 'not_found' }); return 'handled'; }
    const { bytes: _bytes, ...attachment } = stored;
    answer({ attachment });
    return 'handled';
  });
  host.intercept.set('attachment.abort', (params, _connection, { answer, fail }) => {
    store.aborts.push(params.uploadId);
    const [requestId, upload] = [...store.uploads.entries()].find(([, entry]) => entry.uploadId === params.uploadId) ?? [];
    if (!upload || upload.attachmentId) { fail(1001, 'No such upload or attachment for this credential', { reason: 'not_found' }); return 'handled'; }
    store.uploads.delete(requestId);
    answer({ aborted: true });
    return 'handled';
  });
  return { host, store, promptAttachments };
}

async function connected(t, { host, promptAttachments }, root = 'ses_a') {
  const controller = new Controller({ open: host.open, backoff: { initialMs: 5, maxMs: 20, jitter: 0 }, stableMs: 1, taskPollMs: 60_000, sessionPollMs: 60_000, requestTimeoutMs: 2_000, releaseTimeoutMs: 500 });
  t.after(() => controller.disconnect());
  const seeded = host.seed(root);
  if (promptAttachments) seeded.summary.promptAttachments = promptAttachments;
  controller.connect({ url: 'http://127.0.0.1:7434', token: 'alpgw1.0123456789abcdef.secret' });
  await until(() => controller.getState().connection.phase === 'open', 'open');
  controller.selectWorkspace('/w/a');
  await until(() => controller.getState().sessions.status === 'ready', 'sessions');
  controller.selectSession(root);
  await until(() => controller.getState().tree?.status === 'attached', 'attached');
  return controller;
}

const BINARY = [0, 255, 0, 1, 2, 3, 0, 0, 10, 13, 0, 7, 8, 9, 0, 0, 11, 12, 0, 99, 100, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 0];
const prompts = host => host.calls.filter(call => call.method === 'session.prompt').map(call => call.params);

test('the controller uploads each file under the session in chunks, then names it in session.prompt', async t => {
  const world = hostWithStore();
  const controller = await connected(t, world);
  assert.equal(controller.fileGate(), null);
  assert.deepEqual(controller.getState().connection.attachmentLimits, LIMITS);
  const { added } = await readFiles([], [file('blob.bin', BINARY), file('notes.txt', [104, 105], 'text/plain')], LIMITS);
  await controller.sendPrompt('read these', undefined, [], added);
  const [sent] = prompts(world.host);
  assert.deepEqual(sent.content, [{ type: 'text', text: 'read these' }, { type: 'attachment', attachmentId: 'att_1' }, { type: 'attachment', attachmentId: 'att_2' }]);
  assert.deepEqual(world.store.begins.map(begin => [begin.sessionId, begin.name, begin.size, begin.mimeType, begin.requestId, begin.sha256]), [
    ['ses_a', 'blob.bin', BINARY.length, 'application/octet-stream', `${sent.clientMessageId}:file-0`, sha(Buffer.from(BINARY))],
    ['ses_a', 'notes.txt', 2, 'text/plain', `${sent.clientMessageId}:file-1`, sha(Buffer.from([104, 105]))],
  ]);
  assert.deepEqual([...world.store.objects.get('att_1').bytes], BINARY, 'the bytes stored are the file\'s, NULs included');
  assert.equal(world.store.chunks, 4, '35 bytes in chunks of at most 16, then 2 bytes');
  await until(() => !controller.getState().prompts.length, 'the message shows in the timeline');
});

test('files the session, the token or the host cannot take are refused before anything is uploaded', async t => {
  const one = await readFiles([], [file('a.txt', [97], 'text/plain')], LIMITS);
  for (const [options, reason] of [
    [{ promptAttachments: null }, /main runs on codex here, which cannot read attached files/],
    [{ permissions: ['session.read', 'session.write', 'project.read'] }, /needs attachments\.write/],
    [{ capable: false }, /does not store files/],
  ]) {
    const world = hostWithStore(options);
    const controller = await connected(t, world);
    await assert.rejects(controller.sendPrompt('x', undefined, [], one.added), reason);
    assert.equal(world.store.begins.length, 0);
    assert.equal(world.host.count('session.prompt'), 0);
    assert.equal(controller.getState().prompts.length, 0, 'never shown as sent');
    controller.disconnect();
  }
});

test('a connection dropped mid-upload continues the same upload once it is back: one object, one prompt', async t => {
  const world = hostWithStore();
  world.store.dropOnChunk = 2;
  const controller = await connected(t, world);
  const { added } = await readFiles([], [file('blob.bin', BINARY)], LIMITS);
  await controller.sendPrompt('after a drop', undefined, [], added);
  await until(() => world.host.count('session.prompt') === 1 && !controller.getState().prompts.length, 'resumed by itself and delivered');
  const requestIds = new Set(world.store.begins.map(begin => begin.requestId));
  assert.equal(world.store.begins.length, 2, 'begun again after the reconnect');
  assert.equal(requestIds.size, 1, 'under the same requestId');
  assert.equal(world.store.uploads.size, 1);
  assert.equal(world.store.objects.size, 1, 'one object');
  assert.deepEqual([...world.store.objects.get('att_1').bytes], BINARY, 'continued from what the host held, without a gap or a repeat');
  assert.deepEqual(prompts(world.host)[0].content, [{ type: 'text', text: 'after a drop' }, { type: 'attachment', attachmentId: 'att_1' }]);
});

test('a runtime refusal leaves the message failed with the reason; Retry reuses the uploaded file', async t => {
  const world = hostWithStore();
  let refuse = true;
  world.host.intercept.set('session.prompt', (params, _connection, { fail }) => {
    if (!refuse || !params.content.some(part => part.type === 'attachment')) return undefined;
    fail(1005, 'This session\'s runtime cannot read attachments yet; they stay stored and the prompt was not sent', { reason: 'attachment_unsupported' });
    return 'handled';
  });
  const controller = await connected(t, world);
  const { added } = await readFiles([], [file('notes.txt', [104, 105], 'text/plain')], LIMITS);
  await controller.sendPrompt('try', undefined, [], added);
  const [failed] = controller.getState().prompts;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /cannot read attachments yet/);
  assert.equal(failed.files[0].attachmentId, 'att_1');
  assert.equal(world.host.receipts.size, 0, 'nothing was taken');
  refuse = false;
  await controller.retryPrompt(failed.id);
  const sent = prompts(world.host);
  assert.equal(sent.length, 2);
  assert.notEqual(sent[1].clientMessageId, sent[0].clientMessageId, 'a refused message goes again under a new id');
  assert.deepEqual(sent[1].content, sent[0].content, 'with the same attachment');
  assert.equal(world.store.begins.length, 1, 'nothing uploaded again');
  assert.equal(world.store.objects.size, 1);
});

test('a lost prompt answer is sent again under the same id with the same attachment', async t => {
  const world = hostWithStore();
  const controller = await connected(t, world);
  world.host.loseAnswer.add('session.prompt');
  const { added } = await readFiles([], [file('notes.txt', [104, 105], 'text/plain')], LIMITS);
  await controller.sendPrompt('lost [hold]', undefined, [], added);
  await until(() => !controller.getState().prompts.length || controller.getState().prompts[0].status !== 'sending', 'settled');
  const pending = controller.getState().prompts[0];
  if (pending) {
    // Unless the timeline already showed it: then nothing is pending to resend.
    await until(() => controller.getState().connection.phase === 'open', 'reconnected');
    await controller.retryPrompt(pending.id);
  }
  const sent = prompts(world.host);
  assert.ok(sent.every(params => params.clientMessageId === sent[0].clientMessageId), 'one clientMessageId');
  assert.equal(world.host.receipts.size, 1, 'one receipt');
  assert.equal(world.store.objects.size, 1);
  assert.equal(world.store.begins.length, 1);
});

test('a new session uploads its first message\'s files only once it exists, under its own id', async t => {
  const world = hostWithStore();
  const controller = await connected(t, world);
  // As alpd would: the created session's runtime takes attachment parts.
  const set = world.host.roots.set.bind(world.host.roots);
  world.host.roots.set = (id, root) => { root.summary.promptAttachments = ['file.path']; return set(id, root); };
  assert.equal(controller.fileGate(null), null);
  const { added } = await readFiles([], [file('blob.bin', BINARY)], LIMITS);
  const id = await controller.createSession({ prompt: 'start with this', files: added });
  await until(() => world.host.count('session.prompt') === 1, 'the first message');
  const create = world.host.calls.findIndex(call => call.method === 'session.create');
  const begin = world.host.calls.findIndex(call => call.method === 'attachment.begin');
  assert.ok(create >= 0 && begin > create, 'begun after the session was created');
  assert.equal(world.store.begins[0].sessionId, id);
  assert.deepEqual(prompts(world.host)[0].content, [{ type: 'text', text: 'start with this' }, { type: 'attachment', attachmentId: 'att_1' }]);
});

test('a new session whose runtime cannot read files keeps the first message failed, never sent', async t => {
  const world = hostWithStore();
  const controller = await connected(t, world);
  const { added } = await readFiles([], [file('notes.txt', [104, 105], 'text/plain')], LIMITS);
  await controller.createSession({ prompt: 'start', files: added });
  await until(() => controller.getState().prompts.length === 1, 'the message is kept');
  const [kept] = controller.getState().prompts;
  assert.equal(kept.status, 'failed');
  assert.match(kept.error, /cannot read attached files/);
  assert.equal(world.store.begins.length, 0);
  assert.equal(world.host.count('session.prompt'), 0);
});

test('readFiles skips a file the browser cannot read, with its reason, and reads the rest', async () => {
  const unreadable = { name: 'gone.txt', type: 'text/plain', size: 2, arrayBuffer: () => Promise.reject(new DOMException('The file was removed', 'NotReadableError')) };
  const read = await readFiles([], [file('a.bin', [1, 2]), unreadable, file('b.bin', [3])], LIMITS);
  assert.deepEqual(read.added.map(entry => entry.name), ['a.bin', 'b.bin']);
  assert.equal(read.error, 'Could not read gone.txt.');
});

test('uploadRequestId changes only with a fresh attempt', () => {
  assert.equal(uploadRequestId('web-msg-1', 0, 0), 'web-msg-1:file-0');
  assert.equal(uploadRequestId('web-msg-1', 0, 1), 'web-msg-1:file-0.1');
  assert.notEqual(uploadRequestId('web-msg-1', 0, 1), uploadRequestId('web-msg-1', 0));
});

test('abortUpload aborts an upload in progress, leaves a committed one and never throws', async () => {
  const calls = [];
  const api = state => ({ begin: async params => { calls.push(['begin', params.requestId, params.sha256]); return { uploadId: 'upl_1', state, ...(state === 'committed' ? { attachmentId: 'att_1' } : {}) }; }, abort: async uploadId => { calls.push(['abort', uploadId]); return { aborted: true }; } });
  const upload = { sessionId: 'ses_a', file: { name: 'a', mimeType: 'text/plain', data: Uint8Array.of(1) }, requestId: 'k:file-0', digest: async () => 'd' };
  assert.equal(await abortUpload(api('uploading'), upload), true);
  assert.equal(await abortUpload(api('committed'), upload), false);
  assert.deepEqual(calls, [['begin', 'k:file-0', 'd'], ['abort', 'upl_1'], ['begin', 'k:file-0', 'd']]);
  assert.equal(await abortUpload({ begin: async () => { throw new Error('closed'); }, abort: async () => {} }, upload), false);
});

test('discarding a message whose upload failed half-way aborts that upload; a committed file stays', async t => {
  const world = hostWithStore();
  const controller = await connected(t, world);
  // notes.txt (2 bytes) commits in one chunk; blob.bin's second chunk is refused.
  world.store.failOnChunk = 3;
  const { added } = await readFiles([], [file('notes.txt', [104, 105], 'text/plain'), file('blob.bin', BINARY), file('never.bin', [1])], LIMITS);
  await controller.sendPrompt('give up', undefined, [], added);
  const [failed] = controller.getState().prompts;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Could not upload blob\.bin/);
  assert.equal(world.store.begins.length, 2, 'never.bin was not begun');
  controller.discardPrompt(failed.id);
  await controller.abandonedUploads();
  const blob = `${failed.id}:file-1`;
  assert.deepEqual(world.store.begins.map(begin => begin.requestId), [`${failed.id}:file-0`, blob, blob], 'begun again under its requestId, to learn the upload');
  assert.equal(world.store.begins[2].sha256, sha(Buffer.from(BINARY)));
  assert.deepEqual(world.store.aborts, ['upl_2']);
  assert.ok(!world.store.uploads.has(blob), 'the half upload is gone');
  assert.equal(world.store.objects.size, 1, 'the committed file is not aborted');
  assert.equal(world.host.count('session.prompt'), 0);
  assert.equal(controller.getState().prompts.length, 0);
});

test('discarding a message while its file uploads stops the upload, aborts it and sends nothing', async t => {
  const world = hostWithStore();
  const controller = await connected(t, world);
  world.store.holdChunk = 1;
  const { added } = await readFiles([], [file('blob.bin', BINARY), file('later.bin', [1, 2])], LIMITS);
  const sending = controller.sendPrompt('stop', undefined, [], added);
  await until(() => world.store.held, 'the first chunk is waiting for its answer');
  const [pending] = controller.getState().prompts;
  assert.equal(pending.status, 'sending');
  controller.discardPrompt(pending.id);
  world.store.held();
  await sending;
  await controller.abandonedUploads();
  assert.equal(world.store.chunks, 1, 'no chunk after the discard');
  assert.deepEqual(world.store.begins.map(begin => begin.requestId), [`${pending.id}:file-0`, `${pending.id}:file-0`], 'later.bin never begun; blob.bin begun again to abort it');
  assert.deepEqual(world.store.aborts, ['upl_1']);
  assert.equal(world.store.uploads.size, 0);
  assert.equal(world.store.objects.size, 0);
  assert.equal(world.host.count('session.prompt'), 0);
  assert.equal(controller.getState().prompts.length, 0);
});

test('a prompt refused because the host lost a file uploads that file afresh on Retry', async t => {
  const world = hostWithStore();
  let refusal = { code: 1001, message: 'No such upload or attachment for this credential', data: { reason: 'not_found' } };
  world.host.intercept.set('session.prompt', (_params, _connection, { fail }) => {
    if (!refusal) return undefined;
    const { code, message, data } = refusal;
    refusal = undefined;
    fail(code, message, data);
    return 'handled';
  });
  const controller = await connected(t, world);
  const { added } = await readFiles([], [file('kept.txt', [107], 'text/plain'), file('lost.bin', BINARY)], LIMITS);
  // lost.bin's object goes away (alpd collected or lost it) before the prompt names it.
  const commit = world.host.intercept.get('attachment.commit');
  world.host.intercept.set('attachment.commit', (params, connection, tools) => {
    const verdict = commit(params, connection, tools);
    const upload = [...world.store.uploads.values()].find(entry => entry.uploadId === params.uploadId);
    if (upload.params.name === 'lost.bin' && world.store.begins.length === 2) { world.store.objects.delete(upload.attachmentId); world.store.uploads.delete(upload.params.requestId); }
    return verdict;
  });
  await controller.sendPrompt('both', undefined, [], added);
  const [failed] = controller.getState().prompts;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Not found on the host/);
  assert.equal(failed.files[0].attachmentId, 'att_1', 'the file the host still has keeps its attachment');
  assert.equal(failed.files[1].attachmentId, undefined, 'the lost one is to be uploaded again');
  assert.equal(failed.files[1].attempt, 1);
  await controller.retryPrompt(failed.id);
  await until(() => !controller.getState().prompts.length, 'delivered');
  assert.deepEqual(world.store.begins.map(begin => begin.requestId), [`${failed.id}:file-0`, `${failed.id}:file-1`, `${failed.id}:file-1.1`], 'only the lost file, under a requestId of its own');
  const sent = prompts(world.host);
  const fresh = world.store.uploads.get(`${failed.id}:file-1.1`).attachmentId;
  assert.ok(world.store.objects.has(fresh), 'a new object');
  assert.deepEqual(sent.at(-1).content, [{ type: 'text', text: 'both' }, { type: 'attachment', attachmentId: 'att_1' }, { type: 'attachment', attachmentId: fresh }]);
  assert.equal(world.host.receipts.size, 1);
});

test('attachment_unavailable as the gateway sends it (its reason only) re-uploads every committed file of the message', async t => {
  const world = hostWithStore();
  let refused = false;
  world.host.intercept.set('session.prompt', (_params, _connection, { fail }) => {
    if (refused) return undefined;
    refused = true;
    fail(1005, 'The attachment store of the daemon host cannot be used now', { reason: 'attachment_unavailable' });
    return 'handled';
  });
  const controller = await connected(t, world);
  const { added } = await readFiles([], [file('a.txt', [97], 'text/plain'), file('b.txt', [98], 'text/plain')], LIMITS);
  await controller.sendPrompt('two', undefined, [], added);
  const [failed] = controller.getState().prompts;
  assert.deepEqual(failed.files.map(entry => [entry.attachmentId, entry.attempt ?? 0]), [[undefined, 1], [undefined, 1]]);
  await controller.retryPrompt(failed.id);
  await until(() => !controller.getState().prompts.length, 'delivered');
  assert.equal(world.store.begins.length, 4, 'both uploaded again, once each');
});

test('attachment_unavailable from alpd itself re-uploads the file it names; a not_found about the session keeps the files', async t => {
  const world = hostWithStore();
  /** @type {any[]} */
  const refusals = [
    { code: 1005, message: 'The attachment store of the daemon host cannot be used now', data: { reason: 'attachment_unavailable', attachmentId: 'att_2' } },
    { code: 1001, message: 'No such session', data: { reason: 'not_found' } },
  ];
  world.host.intercept.set('session.prompt', (_params, _connection, { fail }) => {
    const refusal = refusals.shift();
    if (!refusal) return undefined;
    fail(refusal.code, refusal.message, refusal.data);
    return 'handled';
  });
  const controller = await connected(t, world);
  const { added } = await readFiles([], [file('a.txt', [97], 'text/plain'), file('b.txt', [98], 'text/plain')], LIMITS);
  await controller.sendPrompt('two', undefined, [], added);
  let [failed] = controller.getState().prompts;
  assert.match(failed.error, /cannot be used now/);
  assert.deepEqual(failed.files.map(entry => [entry.attachmentId, entry.attempt ?? 0]), [['att_1', 0], [undefined, 1]]);
  await controller.retryPrompt(failed.id);
  [failed] = controller.getState().prompts;
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /Not found/);
  assert.deepEqual(failed.files.map(entry => entry.attachmentId), ['att_1', 'att_3'], 'both still stored: kept');
  assert.equal(world.store.begins.length, 3);
  await controller.retryPrompt(failed.id);
  await until(() => !controller.getState().prompts.length, 'delivered');
  assert.equal(world.store.begins.length, 3, 'nothing uploaded again');
  assert.deepEqual(prompts(world.host).at(-1).content.filter(part => part.type === 'attachment'), [{ type: 'attachment', attachmentId: 'att_1' }, { type: 'attachment', attachmentId: 'att_3' }]);
});
