// Non-image attachments (docs/protocol/alp-json-rpc-v1.md §12.6, issue #121 branch I): alpd's store
// of uploaded files, in process with a real store and a scripted native runtime. Every refusal is
// checked for its code and reason, and every answer for host paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initProject } from '@anhlp/alp-core/init';
import { ATTACHMENTS, CAPABILITY } from '@anhlp/alp-protocol';
import { validateResult } from '@anhlp/alp-protocol/contract';
import { createAlpRuntime } from '@anhlp/alp-runtime';
import { createDaemonServer, createStore } from '@anhlp/alp-daemon';
import { attachmentLimits, attachmentName, createAttachmentStore, readAttachmentConfig, sniffMimeType } from '@anhlp/alp-daemon/attachments';

const skip = process.platform === 'win32' && 'attachments are not served on Windows (no O_NOFOLLOW, no POSIX modes)';
const sha = data => createHash('sha256').update(data).digest('hex');
const b64 = data => Buffer.from(data).toString('base64');
const text = body => [{ type: 'text', text: body }];

/** A scripted native runtime (as persistence.test.js): every turn starts and is accepted. */
function fakeTransport(runtimes) {
  return () => {
    const index = runtimes.length;
    let turns = 0;
    const runtime = {
      calls: [], threadId: `thread-${index}`,
      async initialize() {},
      onNotification(fn) { this.notification = fn; }, onFailure(fn) { this.failure = fn; }, onRequest(fn) { this.serverRequest = fn; },
      async close() {},
      async request(method, params) {
        this.calls.push({ method, params });
        if (method === 'thread/resume') return { thread: { id: params.threadId } };
        if (method.startsWith('thread/')) return { thread: { id: this.threadId } };
        if (method === 'turn/start') {
          const id = `turn-${index}-${++turns}`;
          // Each turn ends at once, so the next prompt starts a turn of its own.
          setTimeout(() => this.notification?.('turn/completed', { threadId: this.threadId, turn: { id, status: 'completed' } }), 5);
          return { turn: { id } };
        }
        return {};
      },
    };
    runtimes.push(runtime);
    return runtime;
  };
}

/**
 * The runtime of the seam (branch J): `accepts` decides whether a session's runtime takes attachment
 * parts; what alpd delivered is recorded, and the native turn gets the text only. `failNext` makes
 * the next prompt throw before it reaches the provider.
 */
function attachmentRuntime(base, control) {
  return {
    ...base,
    takesAttachments: sessionId => control.accepts && !!base.snapshot(sessionId),
    bindAttachments: reader => { control.reader = reader; },
    async prompt(sessionId, input) {
      control.delivered.push(structuredClone(input));
      if (control.failNext) { control.failNext = false; throw new Error('Session is not open'); }
      const content = input.content.filter(part => part.type !== 'attachment');
      return base.prompt(sessionId, { ...input, content: content.length ? content : text('(attachments)') });
    },
  };
}

async function until(check, what = 'condition') {
  for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`${what} did not happen`);
}

/** A home, a project and alpd in process; `start` again is a restart on the same home. */
async function setup(t, { accepts = true, limits, io } = {}) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-attach-')));
  const home = path.join(directory, 'home');
  await mkdir(home, { mode: 0o700 });
  const project = path.join(directory, 'project');
  await initProject(project);
  await writeFile(path.join(project, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const other = path.join(directory, 'other');
  await initProject(other);
  await writeFile(path.join(other, '.alp/settings.json'), JSON.stringify({ workflow: { supervisor: false } }));
  const clock = { now: Date.now() };
  const control = { accepts, delivered: [], reader: undefined, failNext: false };
  const stops = [];
  t.after(async () => { for (const stop of stops.reverse()) await stop(); await rm(directory, { recursive: true, force: true }); });
  let count = 0;
  async function start() {
    const runtimes = [];
    const base = createAlpRuntime({ transport: fakeTransport(runtimes), runLogDir: path.join(directory, 'runs') });
    const runtime = attachmentRuntime(base, control);
    const store = createStore(path.join(home, 'state'));
    const server = createDaemonServer({ runtime, socketPath: path.join(directory, `s${count++}`, 'alpd.sock'), version: 'test', store, home, attachmentOptions: { now: () => clock.now, sweepMs: 0, ...(limits ? { limits } : {}), ...(io ? { io } : {}) } });
    const owner = server.local();
    let stopped = false;
    const stop = async () => { if (stopped) return; stopped = true; owner.close(); await store.flush().catch(() => {}); await server.close().catch(() => {}); await base.shutdown(); };
    stops.push(stop);
    await owner.request('daemon.status');
    const request = (method, params) => owner.request(method, params);
    const create = async (cwd = project) => (await request('session.create', { spec: { cwd, persist: true } })).session.id;
    return { server, store, runtime, owner, request, stop, create };
  }
  return { directory, home, project, other, clock, control, root: path.join(home, 'state', 'attachments'), start };
}

const alice = { principalId: 'aaaaaaaaaaaaaaaa', principalEpoch: 'e1' };
const bob = { principalId: 'bbbbbbbbbbbbbbbb', principalEpoch: 'e1' };

/** Uploads `data` in chunks of `chunk` bytes and commits it. */
async function upload(request, sessionId, data, { name = 'notes.txt', mimeType = 'text/plain', chunk = 4096, requestId = `r-${Math.random()}`, as = {} } = {}) {
  const bytes = Buffer.from(data);
  const begun = await request('attachment.begin', { sessionId, name, size: bytes.length, mimeType, requestId, ...as });
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    await request('attachment.chunk', { uploadId: begun.uploadId, offset, data: b64(bytes.subarray(offset, offset + chunk)), ...as });
  }
  const { attachment } = await request('attachment.commit', { uploadId: begun.uploadId, sha256: sha(bytes), ...as });
  return { begun, attachment };
}

/** The refusal of a promise: code, reason, message and data, checked free of host paths. */
async function refusal(promise, directory) {
  try { await promise; } catch (error) {
    if (directory) assert.ok(!JSON.stringify({ message: error.message, data: error.data }).includes(directory), `no host path in ${error.message}`);
    return { code: error.code, reason: error.data?.reason, message: error.message, data: error.data };
  }
  assert.fail('expected a refusal');
}

const unknownUpload = `upl_${'0'.repeat(32)}`;
const unknownAttachment = `att_${'0'.repeat(32)}`;

test('helpers: display names, sniffing and lower-only limits', { skip }, async t => {
  assert.equal(attachmentName('../x'), '..x');
  assert.equal(attachmentName('a/b\\c'), 'abc');
  assert.equal(attachmentName('a\0b'), 'ab');
  assert.equal(attachmentName('‮gnp.exe​'), 'gnp.exe', 'bidi override and zero-width removed');
  assert.equal(attachmentName('café.txt'), 'café.txt', 'NFC');
  assert.equal(attachmentName('line\nbreak\r x'), 'linebreakx');
  for (const bad of ['', '   ', '.', '..', '/', '\0\0', 'é'.repeat(128), 'a'.repeat(256)]) assert.equal(attachmentName(bad), undefined, JSON.stringify(bad));
  assert.equal(attachmentName('a'.repeat(255)), 'a'.repeat(255));
  assert.equal(sniffMimeType(Buffer.from('%PDF-1.7\n')), 'application/pdf');
  assert.equal(sniffMimeType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])), 'image/png');
  assert.equal(sniffMimeType(Buffer.from('plain words ✓')), 'text/plain');
  assert.equal(sniffMimeType(Buffer.from([0, 1, 2, 3])), 'application/octet-stream');
  assert.equal(sniffMimeType(Buffer.alloc(0)), 'application/octet-stream');
  const lowered = attachmentLimits({ maxObjectBytes: 1024, maxPerPrompt: 99, maxChunkBytes: -5, uploadTimeoutMs: 1.5 });
  assert.equal(lowered.maxObjectBytes, 1024);
  assert.equal(lowered.maxPerPrompt, ATTACHMENTS.maxPerPrompt, 'never raised');
  assert.equal(lowered.maxChunkBytes, ATTACHMENTS.maxChunkBytes, 'a bad value is ignored');
  assert.equal(lowered.uploadTimeoutMs, ATTACHMENTS.uploadTimeoutMs);
  assert.equal(attachmentLimits({}, 256 * 1024).maxChunkBytes, Math.floor((256 - 64) * 1024 * 3 / 4), 'lowered to fit the frame');
  const home = await mkdtemp(path.join(tmpdir(), 'alpd-attach-config-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await readAttachmentConfig(home), { limits: {}, problems: [] });
  await writeFile(path.join(home, 'attachments.json'), JSON.stringify({ limits: { maxObjectBytes: 1000, maxPerPrompt: 100, nope: 1, maxDaemonBytes: -1 } }));
  const config = await readAttachmentConfig(home);
  assert.deepEqual(config.limits, { maxObjectBytes: 1000 });
  assert.equal(config.problems.length, 3);
});

test('hello lists attachments with effective limits; an upload round trip stores an immutable private object and answers no host path', { skip }, async t => {
  const env = await setup(t, { limits: { maxObjectBytes: 1024 * 1024 } });
  const daemon = await env.start();
  const hello = await daemon.request('daemon.hello', { protocolVersion: 1 });
  assert.ok(hello.capabilities.includes(CAPABILITY.attachments));
  assert.equal(hello.attachmentLimits.maxObjectBytes, 1024 * 1024);
  assert.equal(hello.attachmentLimits.maxChunkBytes, ATTACHMENTS.maxChunkBytes);
  assert.deepEqual(validateResult('daemon.hello', hello), []);
  const sessionId = await daemon.create();
  const data = Buffer.from('%PDF-1.4\n' + 'x'.repeat(10_000));
  const begun = await daemon.request('attachment.begin', { sessionId, name: 'report.pdf', size: data.length, mimeType: 'application/pdf', sha256: sha(data), requestId: 'r1' });
  assert.deepEqual(validateResult('attachment.begin', begun), []);
  assert.equal(begun.state, 'uploading');
  assert.equal(begun.received, 0);
  const first = await daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 0, data: b64(data.subarray(0, 4096)) });
  assert.deepEqual(first, { received: 4096, size: data.length });
  // A repeat of begin (same requestId and params) answers the same upload and what it holds: resume from there.
  const again = await daemon.request('attachment.begin', { sessionId, name: 'report.pdf', size: data.length, mimeType: 'application/pdf', sha256: sha(data), requestId: 'r1' });
  assert.equal(again.uploadId, begun.uploadId);
  assert.equal(again.received, 4096);
  assert.equal((await refusal(daemon.request('attachment.begin', { sessionId, name: 'other.pdf', size: data.length, mimeType: 'application/pdf', requestId: 'r1' }))).reason, 'request_conflict');
  await daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 4096, data: b64(data.subarray(4096)) });
  const { attachment } = await daemon.request('attachment.commit', { uploadId: begun.uploadId, sha256: sha(data) });
  assert.deepEqual(validateResult('attachment.commit', { attachment }), []);
  assert.equal(attachment.name, 'report.pdf');
  assert.equal(attachment.size, data.length);
  assert.equal(attachment.sha256, sha(data));
  assert.equal(attachment.detectedMimeType, 'application/pdf');
  assert.equal(attachment.referenced, false);
  assert.equal(attachment.attachmentId.slice(4), begun.uploadId.slice(4));
  assert.ok(!JSON.stringify([begun, attachment]).includes(env.directory), 'no host path');
  // A repeated commit answers the same attachment; the begin's repeat now says committed.
  assert.deepEqual((await daemon.request('attachment.commit', { uploadId: begun.uploadId, sha256: sha(data) })).attachment, attachment);
  assert.equal((await daemon.request('attachment.begin', { sessionId, name: 'report.pdf', size: data.length, mimeType: 'application/pdf', sha256: sha(data), requestId: 'r1' })).attachmentId, attachment.attachmentId);
  assert.deepEqual((await daemon.request('attachment.get', { attachmentId: attachment.attachmentId })).attachment, attachment);
  // On disk: an opaque id, private modes, the bytes as sent, read-only once committed, never executable.
  const id = begun.uploadId.slice(4);
  assert.deepEqual((await readdir(env.root)).filter(name => !name.startsWith('refs.json')), [id]);
  assert.equal((await stat(env.root)).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(env.root, id))).mode & 0o777, 0o700);
  assert.equal((await stat(path.join(env.root, id, 'payload'))).mode & 0o777, 0o400);
  assert.equal((await stat(path.join(env.root, id, 'meta.json'))).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(path.join(env.root, id, 'payload')), data);
  // Chunks to a committed upload, and its abort, find no upload.
  assert.equal((await refusal(daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 0, data: 'AAAA' }))).reason, 'not_found');
  assert.deepEqual(await daemon.request('attachment.delete', { attachmentId: attachment.attachmentId }), { deleted: true });
  assert.deepEqual((await readdir(env.root)).filter(name => !name.startsWith('refs.json')), []);
  assert.equal((await refusal(daemon.request('attachment.get', { attachmentId: attachment.attachmentId }))).reason, 'not_found');
});

test('zero-size, oversize and invalid base64 uploads', { skip }, async t => {
  const env = await setup(t, { limits: { maxObjectBytes: 1000, maxChunkBytes: 100 } });
  const daemon = await env.start();
  const sessionId = await daemon.create();
  const empty = await daemon.request('attachment.begin', { sessionId, name: 'empty.txt', size: 0, mimeType: 'text/plain', requestId: 'z' });
  assert.equal((await refusal(daemon.request('attachment.chunk', { uploadId: empty.uploadId, offset: 0, data: 'AAAA' }))).reason, 'attachment_too_large', 'no byte beyond the declared size');
  const { attachment } = await daemon.request('attachment.commit', { uploadId: empty.uploadId, sha256: sha('') });
  assert.equal(attachment.size, 0);
  assert.equal(attachment.detectedMimeType, 'application/octet-stream');
  // Oversize at begin, and nothing reserved.
  const big = await refusal(daemon.request('attachment.begin', { sessionId, name: 'big.bin', size: 1001, mimeType: 'application/octet-stream', requestId: 'b' }));
  assert.deepEqual([big.code, big.reason], [-32602, 'attachment_too_large']);
  const begun = await daemon.request('attachment.begin', { sessionId, name: 'x.bin', size: 300, mimeType: 'application/octet-stream', requestId: 'x' });
  assert.equal(begun.maxChunkBytes, 100);
  // A chunk over the decoded chunk limit, past the declared size, non-canonical or malformed base64.
  assert.equal((await refusal(daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 0, data: b64(Buffer.alloc(101)) }))).reason, 'invalid_data');
  assert.equal((await refusal(daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 250, data: b64(Buffer.alloc(50)) }))).reason, 'offset_mismatch', 'a gap');
  assert.equal((await refusal(daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 250, data: b64(Buffer.alloc(51)) }))).reason, 'attachment_too_large', 'past the declared size');
  assert.equal((await refusal(daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 0, data: 'QR==' }))).reason, 'invalid_data', 'non-canonical padding bits');
  for (const data of ['not base64!', 'AAA', '', 'AA=A']) {
    const refused = await refusal(daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 0, data }));
    assert.deepEqual([refused.code, refused.reason], [-32602, 'invalid_params'], data);
  }
  await daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 0, data: b64(Buffer.alloc(100, 1)) });
  await daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 100, data: b64(Buffer.alloc(100, 2)) });
  // Commit before every byte arrived, then with a wrong digest: the upload is aborted.
  const partial = Buffer.concat([Buffer.alloc(100, 1), Buffer.alloc(100, 2)]);
  const short = await daemon.request('attachment.begin', { sessionId, name: 'short.bin', size: 201, mimeType: 'application/octet-stream', requestId: 's' });
  await daemon.request('attachment.chunk', { uploadId: short.uploadId, offset: 0, data: b64(partial.subarray(0, 100)) });
  assert.equal((await refusal(daemon.request('attachment.commit', { uploadId: short.uploadId, sha256: sha(partial) }))).reason, 'upload_incomplete');
  const wrong = await refusal(daemon.request('attachment.commit', { uploadId: begun.uploadId, sha256: sha('something else') }));
  assert.deepEqual([wrong.code, wrong.reason], [1004, 'upload_incomplete'], 'only 200 of 300 bytes yet');
  await daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 200, data: b64(Buffer.alloc(100, 3)) });
  const mismatch = await refusal(daemon.request('attachment.commit', { uploadId: begun.uploadId, sha256: sha('something else') }));
  assert.deepEqual([mismatch.code, mismatch.reason], [1004, 'hash_mismatch']);
  assert.equal((await refusal(daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 0, data: 'AAAA' }))).reason, 'not_found', 'aborted with its reservation');
  // A digest declared at begin must also match.
  const declared = await daemon.request('attachment.begin', { sessionId, name: 'd.bin', size: 3, mimeType: 'application/octet-stream', sha256: sha('abd'), requestId: 'd' });
  await daemon.request('attachment.chunk', { uploadId: declared.uploadId, offset: 0, data: b64('abc') });
  assert.equal((await refusal(daemon.request('attachment.commit', { uploadId: declared.uploadId, sha256: sha('abc') }))).reason, 'hash_mismatch');
});

test('a chunk sent again at its offset is accepted when its bytes match and refused when they differ; a partly stored one is completed', { skip }, async t => {
  const env = await setup(t);
  const daemon = await env.start();
  const sessionId = await daemon.create();
  const data = Buffer.from('0123456789abcdefghij');
  const { uploadId } = await daemon.request('attachment.begin', { sessionId, name: 'r.txt', size: data.length, mimeType: 'text/plain', requestId: 'replay' });
  assert.deepEqual(await daemon.request('attachment.chunk', { uploadId, offset: 0, data: b64(data.subarray(0, 8)) }), { received: 8, size: 20 });
  assert.deepEqual(await daemon.request('attachment.chunk', { uploadId, offset: 0, data: b64(data.subarray(0, 8)) }), { received: 8, size: 20 }, 'exact replay');
  assert.deepEqual(await daemon.request('attachment.chunk', { uploadId, offset: 4, data: b64(data.subarray(4, 8)) }), { received: 8, size: 20 }, 'replay of a part');
  const changed = await refusal(daemon.request('attachment.chunk', { uploadId, offset: 0, data: b64('01234567'.replace('3', 'X')) }));
  assert.deepEqual([changed.code, changed.reason, changed.data.received], [1004, 'chunk_conflict', 8]);
  const gap = await refusal(daemon.request('attachment.chunk', { uploadId, offset: 12, data: b64(data.subarray(12, 16)) }));
  assert.deepEqual([gap.code, gap.reason, gap.data.received], [1004, 'offset_mismatch', 8]);
  // Overlapping the stored end: the stored part must match, the rest is appended.
  assert.deepEqual(await daemon.request('attachment.chunk', { uploadId, offset: 6, data: b64(data.subarray(6, 14)) }), { received: 14, size: 20 });
  const overlapChanged = await refusal(daemon.request('attachment.chunk', { uploadId, offset: 12, data: b64('XX' + 'ghij') }));
  assert.equal(overlapChanged.reason, 'chunk_conflict');
  // Concurrent copies of the same chunk: one writes, the others are replays; the size never exceeds the declared one.
  const results = await Promise.all(Array.from({ length: 6 }, () => daemon.request('attachment.chunk', { uploadId, offset: 14, data: b64(data.subarray(14)) })));
  assert.ok(results.every(result => result.received === 20 && result.size === 20));
  const { attachment } = await daemon.request('attachment.commit', { uploadId, sha256: sha(data) });
  assert.deepEqual(await readFile(path.join(env.root, attachment.attachmentId.slice(4), 'payload')), data);
});

test('concurrent begins cannot oversubscribe the per-principal or daemon quota or the active uploads, retained objects included', { skip }, async t => {
  const env = await setup(t, { limits: { maxPrincipalBytes: 100, maxDaemonBytes: 150 } });
  const daemon = await env.start();
  const sessionId = await daemon.create();
  const carol = { principalId: 'cccccccccccccccc', principalEpoch: 'e1' };
  const begin = (as, i, size) => daemon.request('attachment.begin', { sessionId, name: `f${i}.bin`, size, mimeType: 'application/octet-stream', requestId: `q${i}`, ...as });
  const race = async (as, from, count, size) => {
    const settled = await Promise.allSettled(Array.from({ length: count }, (_, i) => begin(as, from + i, size)));
    const lost = settled.filter(result => result.status === 'rejected').map(result => result.reason);
    for (const error of lost) assert.deepEqual([error.code, error.data?.reason], [1005, 'quota_exceeded'], error.message);
    return { won: settled.filter(result => result.status === 'fulfilled').map(result => result.value), limits: lost.map(error => error.data.limit) };
  };
  // Ten parallel begins of 60 bytes for one principal: one fits its 100 bytes.
  const alices = await race(alice, 0, 10, 60);
  assert.equal(alices.won.length, 1);
  assert.ok(alices.limits.every(limit => limit === 'principal_bytes'), alices.limits.join());
  // The daemon's 150 bytes count every principal: one of bob's parallel 50-byte begins fits beside alice's 60.
  const bobs = await race(bob, 20, 4, 50);
  assert.equal(bobs.won.length, 1);
  assert.ok(bobs.limits.every(limit => limit === 'daemon_bytes'), bobs.limits.join());
  // Active uploads are their own limit (2 by default), whatever their size.
  const carols = await race(carol, 40, 5, 1);
  assert.equal(carols.won.length, ATTACHMENTS.maxActiveUploads);
  assert.ok(carols.limits.every(limit => limit === 'active_uploads'), carols.limits.join());
  // A committed object still counts (referenced or not) until it is deleted.
  const [mine] = alices.won;
  await daemon.request('attachment.chunk', { uploadId: mine.uploadId, offset: 0, data: b64(Buffer.alloc(60, 7)), ...alice });
  const { attachment } = await daemon.request('attachment.commit', { uploadId: mine.uploadId, sha256: sha(Buffer.alloc(60, 7)), ...alice });
  assert.equal((await refusal(begin(alice, 60, 50))).data.limit, 'principal_bytes', '60 kept + 50 > 100');
  await daemon.request('attachment.delete', { attachmentId: attachment.attachmentId, ...alice });
  await begin(alice, 61, 50);
  // An aborted upload frees its reservation at once.
  await daemon.request('attachment.abort', { uploadId: bobs.won[0].uploadId, ...bob });
  await begin(bob, 62, 50);
});

test('spoofed MIME types and names: the declared type is advisory, names are sanitized and never become paths', { skip }, async t => {
  const env = await setup(t);
  const daemon = await env.start();
  const sessionId = await daemon.create();
  const pdf = Buffer.from('%PDF-1.7 not an image');
  const { attachment } = await upload(daemon.request, sessionId, pdf, { name: '../../etc/passwd\u0000', mimeType: 'IMAGE/PNG' });
  assert.equal(attachment.name, '....etcpasswd');
  assert.equal(attachment.mimeType, 'image/png', 'kept as declared (lower case), advisory');
  assert.equal(attachment.detectedMimeType, 'application/pdf', 'what the bytes look like, for display');
  for (const [name, expected] of [['a/b', 'ab'], ['dir\\file.txt', 'dirfile.txt'], ['‮txt.exe', 'txt.exe'], ['tab\there', 'tabhere']]) {
    assert.equal((await upload(daemon.request, sessionId, 'x', { name })).attachment.name, expected);
  }
  for (const name of ['..', '/', '\u0000', '​', 'a'.repeat(256), 'é'.repeat(128)]) {
    const refused = await refusal(daemon.request('attachment.begin', { sessionId, name, size: 1, mimeType: 'text/plain', requestId: `n-${name.length}-${name.charCodeAt(0)}` }));
    assert.deepEqual([refused.code, refused.reason], [-32602, 'invalid_name'], JSON.stringify(name));
  }
  // Nothing outside the store was created, nothing inside is named after a client's string.
  assert.ok((await readdir(env.root)).every(name => /^[0-9a-f]{32}$/.test(name) || name === 'refs.json'));
  await assert.rejects(stat(path.join(env.root, '..', '..', 'etc')), { code: 'ENOENT' });
});

test('a payload or object directory swapped for a link, a hard link or another file between chunk and commit is refused, never followed', { skip }, async t => {
  const env = await setup(t);
  const daemon = await env.start();
  const sessionId = await daemon.create();
  const outside = path.join(env.directory, 'outside.txt');
  const begin = async (requestId, bytes = 'abcdef') => {
    const begun = await daemon.request('attachment.begin', { sessionId, name: 'f.txt', size: bytes.length, mimeType: 'text/plain', requestId });
    await daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 0, data: b64(bytes.slice(0, 3)) });
    return { ...begun, dir: path.join(env.root, begun.uploadId.slice(4)), bytes };
  };
  const refusedAfter = async (upload, why) => {
    const chunk = await refusal(daemon.request('attachment.chunk', { uploadId: upload.uploadId, offset: 3, data: b64(upload.bytes.slice(3)) }), env.directory);
    assert.deepEqual([chunk.code, chunk.reason], [1000, 'persistence_failed'], why);
    // The upload is gone with its reservation: nothing of it can be committed.
    assert.equal((await refusal(daemon.request('attachment.commit', { uploadId: upload.uploadId, sha256: sha(upload.bytes) }))).reason, 'not_found', why);
  };

  // The payload replaced by a symbolic link to a file outside the store.
  await writeFile(outside, 'secret');
  const linked = await begin('link');
  await unlink(path.join(linked.dir, 'payload'));
  await symlink(outside, path.join(linked.dir, 'payload'));
  await refusedAfter(linked, 'symlinked payload');
  assert.equal(await readFile(outside, 'utf8'), 'secret', 'the link target was not written');

  // A hard link to the payload elsewhere: the file has two names.
  const hard = await begin('hard');
  await link(path.join(hard.dir, 'payload'), path.join(env.directory, 'second-name'));
  await refusedAfter(hard, 'hard-linked payload');

  // Another regular file put in the payload's place (another inode).
  const replaced = await begin('replace');
  await rename(path.join(replaced.dir, 'payload'), path.join(env.directory, 'moved'));
  await writeFile(path.join(replaced.dir, 'payload'), 'abc', { mode: 0o600 });
  await refusedAfter(replaced, 'replaced payload');

  // The object directory swapped for a link to a look-alike directory.
  const swapped = await begin('swap');
  const decoy = path.join(env.directory, 'decoy');
  await rename(swapped.dir, decoy);
  await symlink(decoy, swapped.dir);
  await refusedAfter(swapped, 'directory swapped for a link');

  // Swapped between the last chunk and commit: commit refuses.
  const late = await begin('late', 'abc');
  await unlink(path.join(late.dir, 'payload'));
  await symlink(outside, path.join(late.dir, 'payload'));
  const commit = await refusal(daemon.request('attachment.commit', { uploadId: late.uploadId, sha256: sha('abc') }), env.directory);
  assert.deepEqual([commit.code, commit.reason], [1000, 'persistence_failed']);
  assert.equal(await readFile(outside, 'utf8'), 'secret');
  assert.equal((await daemon.request('daemon.status')).pid, process.pid, 'alpd still serves');
});

test('ids of another principal, epoch, project or session answer exactly as unknown ones', { skip }, async t => {
  const env = await setup(t);
  const daemon = await env.start();
  const sessionId = await daemon.create();
  const otherSession = await daemon.create();
  const elsewhere = await daemon.create(env.other);
  const project = await realpath(env.project);
  const as = { ...alice, authorizedRoots: [project] };
  const pending = await daemon.request('attachment.begin', { sessionId, name: 'p.txt', size: 4, mimeType: 'text/plain', requestId: 'pending', ...as });
  const { attachment } = await upload(daemon.request, sessionId, 'done', { as });
  const strangers = {
    'another principal': { ...bob, authorizedRoots: [project] },
    'another epoch of the same principal': { ...alice, principalEpoch: 'e2', authorizedRoots: [project] },
    'the owner': {},
    'a grant without this project': { ...alice, authorizedRoots: [await realpath(env.other)] },
  };
  const unknown = {
    chunk: await refusal(daemon.request('attachment.chunk', { uploadId: unknownUpload, offset: 0, data: 'AAAA', ...as })),
    commit: await refusal(daemon.request('attachment.commit', { uploadId: unknownUpload, sha256: sha(''), ...as })),
    abort: await refusal(daemon.request('attachment.abort', { uploadId: unknownUpload, ...as })),
    get: await refusal(daemon.request('attachment.get', { attachmentId: unknownAttachment, ...as })),
    delete: await refusal(daemon.request('attachment.delete', { attachmentId: unknownAttachment, ...as })),
  };
  for (const answer of Object.values(unknown)) assert.equal(answer.code, 1001);
  for (const [who, context] of Object.entries(strangers)) {
    assert.deepEqual(await refusal(daemon.request('attachment.chunk', { uploadId: pending.uploadId, offset: 0, data: 'AAAA', ...context })), unknown.chunk, `chunk by ${who}`);
    assert.deepEqual(await refusal(daemon.request('attachment.commit', { uploadId: pending.uploadId, sha256: sha(''), ...context })), unknown.commit, `commit by ${who}`);
    assert.deepEqual(await refusal(daemon.request('attachment.abort', { uploadId: pending.uploadId, ...context })), unknown.abort, `abort by ${who}`);
    assert.deepEqual(await refusal(daemon.request('attachment.get', { attachmentId: attachment.attachmentId, ...context })), unknown.get, `get by ${who}`);
    assert.deepEqual(await refusal(daemon.request('attachment.delete', { attachmentId: attachment.attachmentId, ...context })), unknown.delete, `delete by ${who}`);
  }
  // A begin for a session the grant does not cover answers as a session that does not exist.
  const outside = await refusal(daemon.request('attachment.begin', { sessionId: elsewhere, name: 'x', size: 1, mimeType: 'text/plain', requestId: 'o', ...as }));
  const missing = await refusal(daemon.request('attachment.begin', { sessionId: 'ses_missing', name: 'x', size: 1, mimeType: 'text/plain', requestId: 'm', ...as }));
  assert.deepEqual(outside, missing);
  // A prompt to another session, even of the same principal and project, cannot use it.
  const unknownPrompt = await refusal(daemon.request('session.prompt', { sessionId: otherSession, clientMessageId: 'u', content: [{ type: 'attachment', attachmentId: unknownAttachment }], ...as }));
  const foreignPrompt = await refusal(daemon.request('session.prompt', { sessionId: otherSession, clientMessageId: 'f', content: [{ type: 'attachment', attachmentId: attachment.attachmentId }], ...as }));
  assert.deepEqual(foreignPrompt, unknownPrompt);
  assert.equal(foreignPrompt.code, 1001);
  // Its owner still has it, unchanged.
  assert.equal((await daemon.request('attachment.get', { attachmentId: attachment.attachmentId, ...as })).attachment.sha256, sha('done'));
});

test('a failed write (ENOSPC) aborts the upload: nothing half published, its reservation released', { skip }, async t => {
  const failing = { next: false };
  const env = await setup(t, { limits: { maxPrincipalBytes: 10 }, io: {
    async write(handle, buffer, position) {
      if (failing.next) { failing.next = false; await handle.write(buffer, 0, 1, position); throw Object.assign(new Error(`ENOSPC: no space left on device, write ${path.join(tmpdir(), 'x')}`), { code: 'ENOSPC' }); }
      await handle.write(buffer, 0, buffer.length, position);
    },
  } });
  const daemon = await env.start();
  const sessionId = await daemon.create();
  const begun = await daemon.request('attachment.begin', { sessionId, name: 'f.bin', size: 10, mimeType: 'application/octet-stream', requestId: 'full' });
  await daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 0, data: b64('abcd') });
  failing.next = true;
  const full = await refusal(daemon.request('attachment.chunk', { uploadId: begun.uploadId, offset: 4, data: b64('efghij') }), tmpdir());
  assert.deepEqual([full.code, full.reason], [1000, 'persistence_failed']);
  assert.deepEqual((await readdir(env.root)).filter(name => name !== 'refs.json'), [], 'no object left behind');
  assert.equal((await refusal(daemon.request('attachment.commit', { uploadId: begun.uploadId, sha256: sha('abcdefghij') }))).reason, 'not_found');
  // The 10 bytes are free again.
  const again = await daemon.request('attachment.begin', { sessionId, name: 'f.bin', size: 10, mimeType: 'application/octet-stream', requestId: 'full-2' });
  await daemon.request('attachment.chunk', { uploadId: again.uploadId, offset: 0, data: b64('abcdefghij') });
  assert.equal((await daemon.request('attachment.commit', { uploadId: again.uploadId, sha256: sha('abcdefghij') })).attachment.size, 10);
});

test('prompts: attachments are refused honestly when the runtime cannot read them, and pinned before delivery when it can', { skip }, async t => {
  const env = await setup(t, { accepts: false, limits: { maxPerPrompt: 3, maxPromptBytes: 20 } });
  const daemon = await env.start();
  const sessionId = await daemon.create();
  const { attachment } = await upload(daemon.request, sessionId, 'twelve bytes');
  const prompt = (clientMessageId, ids, extra = {}) => daemon.request('session.prompt', { sessionId, clientMessageId, content: [...text('read this'), ...ids.map(attachmentId => ({ type: 'attachment', attachmentId }))], ...extra });

  // Today's runtimes: 1005 attachment_unsupported, before any receipt; nothing pinned, nothing sent.
  const unsupported = await refusal(prompt('m1', [attachment.attachmentId]));
  assert.deepEqual([unsupported.code, unsupported.reason], [1005, 'attachment_unsupported']);
  assert.deepEqual(env.control.delivered, []);
  assert.equal((await daemon.request('attachment.get', { attachmentId: attachment.attachmentId })).attachment.referenced, false);
  assert.deepEqual(await readdir(path.join(env.home, 'state', 'receipts')).catch(() => []), []);

  // A runtime that takes them (branch J's seam): ids, names and digests, never a path.
  env.control.accepts = true;
  const accepted = await prompt('m1', [attachment.attachmentId]);
  assert.equal(accepted.outcome, 'accepted');
  const delivered = env.control.delivered.at(-1).content;
  assert.deepEqual(delivered[1], { type: 'attachment', attachmentId: attachment.attachmentId, name: 'notes.txt', mimeType: 'text/plain', detectedMimeType: 'text/plain', size: 12, sha256: sha('twelve bytes') });
  assert.ok(!JSON.stringify(env.control.delivered).includes(env.directory), 'no host path reaches the runtime');
  // Pinned: get says referenced, delete refuses, the runtime's reader streams the exact bytes.
  assert.equal((await daemon.request('attachment.get', { attachmentId: attachment.attachmentId })).attachment.referenced, true);
  const referenced = await refusal(daemon.request('attachment.delete', { attachmentId: attachment.attachmentId }));
  assert.deepEqual([referenced.code, referenced.reason], [1004, 'attachment_referenced']);
  const { stream, attachment: described } = await env.control.reader.open(attachment.attachmentId, sessionId);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'twelve bytes');
  assert.equal(described.sha256, sha('twelve bytes'));
  await assert.rejects(env.control.reader.open(attachment.attachmentId, 'ses_other'), { code: 1001 }, 'only for a session that pins it');
  // When an attachment's payload changes on disk, reader.open fails with attachment_unavailable and includes attachmentId.
  const payloadFile = path.join(env.directory, 'home', 'state', 'attachments', attachment.attachmentId.slice(4), 'payload');
  await chmod(payloadFile, 0o600);
  await writeFile(payloadFile, 'changed');
  await chmod(payloadFile, 0o400);
  await assert.rejects(
    env.control.reader.open(attachment.attachmentId, sessionId),
    err => err.code === 1005 && err.data?.reason === 'attachment_unavailable' && err.data?.attachmentId === attachment.attachmentId
  );
  await chmod(payloadFile, 0o600);
  await writeFile(payloadFile, 'twelve bytes');
  await chmod(payloadFile, 0o400);
  // The receipt covers the attachments: the same prompt is a duplicate; another attachment is a conflict.
  assert.equal((await prompt('m1', [attachment.attachmentId])).duplicate, true);
  const second = (await upload(daemon.request, sessionId, 'other')).attachment;
  assert.equal((await refusal(prompt('m1', [second.attachmentId]))).reason, 'key_conflict');
  assert.equal(env.control.delivered.length, 1, 'delivered once');
  // Prompt limits: count and total size.
  const many = await refusal(prompt('m2', [second.attachmentId, second.attachmentId, second.attachmentId, second.attachmentId]));
  assert.deepEqual([many.code, many.reason], [-32602, 'attachment_limit']);
  const heavy = await refusal(prompt('m3', [attachment.attachmentId, attachment.attachmentId]));
  assert.deepEqual([heavy.code, heavy.reason], [-32602, 'attachment_limit']);
  // A prompt the runtime refuses before it reaches the provider releases what it pinned.
  env.control.failNext = true;
  await assert.rejects(prompt('m4', [second.attachmentId]), { code: 1001 });
  assert.equal((await daemon.request('attachment.get', { attachmentId: second.attachmentId })).attachment.referenced, false);
  assert.deepEqual(await daemon.request('attachment.delete', { attachmentId: second.attachmentId }), { deleted: true });
  // Inline images are unchanged beside attachments.
  const image = { type: 'image', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64') };
  assert.equal((await daemon.request('session.prompt', { sessionId, clientMessageId: 'img', content: [...text('see'), image] })).outcome, 'accepted');
  assert.deepEqual(env.control.delivered.at(-1).content, [...text('see'), image]);
});

test('expiry and collection: incomplete uploads expire, unreferenced objects are purged, referenced ones survive archive, collection and restart', { skip }, async t => {
  const env = await setup(t);
  let daemon = await env.start();
  const sessionId = await daemon.create();
  const kept = (await upload(daemon.request, sessionId, 'kept by a prompt', { name: 'kept.txt' })).attachment;
  const loose = (await upload(daemon.request, sessionId, 'nobody needs me', { name: 'loose.txt' })).attachment;
  assert.equal((await daemon.request('session.prompt', { sessionId, clientMessageId: 'p', content: [...text('x'), { type: 'attachment', attachmentId: kept.attachmentId }] })).outcome, 'accepted');
  const stale = await daemon.request('attachment.begin', { sessionId, name: 'stale.bin', size: 8, mimeType: 'application/octet-stream', requestId: 'stale' });
  await daemon.request('attachment.chunk', { uploadId: stale.uploadId, offset: 0, data: b64('1234') });
  await daemon.request('session.archive', { sessionId });

  // An hour later the incomplete upload has expired: its owner is told so, and its space is free.
  env.clock.now += ATTACHMENTS.uploadTimeoutMs + 1;
  const expired = await refusal(daemon.request('attachment.chunk', { uploadId: stale.uploadId, offset: 4, data: b64('5678') }));
  assert.deepEqual([expired.code, expired.reason], [1001, 'upload_expired']);
  assert.equal((await refusal(daemon.request('attachment.chunk', { uploadId: stale.uploadId, offset: 4, data: b64('5678') }))).reason, 'not_found', 'then gone');

  // A day later the unreferenced object is purged; the referenced one stays, its session archived.
  env.clock.now += ATTACHMENTS.unreferencedRetentionMs + 1;
  await daemon.server.close();
  await daemon.stop();
  daemon = await env.start();
  await until(async () => !(await readdir(env.root)).includes(loose.attachmentId.slice(4)), 'the unreferenced object to be collected');
  assert.equal((await refusal(daemon.request('attachment.get', { attachmentId: loose.attachmentId }))).reason, 'not_found');
  const after = (await daemon.request('attachment.get', { attachmentId: kept.attachmentId })).attachment;
  assert.equal(after.referenced, true, 'the reference survived the restart');
  assert.equal(after.sha256, sha('kept by a prompt'));

  // A month on, still there: references never expire. Releasing the session's history (the seam
  // for deleting it) lets it go after the grace period.
  env.clock.now += 30 * 24 * 60 * 60 * 1000;
  await daemon.stop();
  const second = await env.start();
  await until(async () => (await second.request('daemon.status')).pid === process.pid);
  assert.equal((await second.request('attachment.get', { attachmentId: kept.attachmentId })).attachment.referenced, true);
});

test('restart recovery: a corrupt reference index keeps every object, leftovers of a cut-short begin go after the grace period', { skip }, async t => {
  const env = await setup(t);
  const daemon = await env.start();
  const sessionId = await daemon.create();
  const { attachment } = await upload(daemon.request, sessionId, 'precious');
  await daemon.stop();
  // A crash left a half-written index and a directory without meta (a begin cut short).
  await writeFile(path.join(env.root, 'refs.json'), '{"version":1,"hold');
  await writeFile(path.join(env.root, 'refs.json.abc.tmp'), 'partial');
  const orphan = path.join(env.root, 'f'.repeat(32));
  await mkdir(orphan, { mode: 0o700 });
  await writeFile(path.join(orphan, 'payload'), 'x', { mode: 0o600 });
  await writeFile(path.join(orphan, 'meta.json.1234.tmp'), '{');
  const restarted = await env.start();
  await restarted.request('daemon.status');
  const recovered = (await restarted.request('attachment.get', { attachmentId: attachment.attachmentId })).attachment;
  assert.equal(recovered.referenced, true, 'kept as referenced: nothing is collected on a guess');
  const names = await readdir(env.root);
  assert.ok(names.some(name => name.startsWith('refs.json.corrupt-')), 'the unreadable index is kept aside');
  assert.ok(!names.includes('refs.json.abc.tmp'));
  assert.ok(names.includes('f'.repeat(32)), 'a recent leftover waits for the grace period');
  await restarted.stop();
  const old = new Date(Date.now() - ATTACHMENTS.uploadTimeoutMs - 60_000);
  await utimes(orphan, old, old);
  const again = await env.start();
  await again.request('daemon.status');
  await until(async () => !(await readdir(env.root)).includes('f'.repeat(32)), 'the leftover to be removed');
  assert.equal((await again.request('attachment.get', { attachmentId: attachment.attachmentId })).attachment.sha256, sha('precious'));
  // A referenced object whose meta became unreadable is never collected, however old.
  await again.stop();
  const id = attachment.attachmentId.slice(4);
  await writeFile(path.join(env.root, id, 'meta.json'), '{"broken');
  await utimes(path.join(env.root, id), old, old);
  const third = await env.start();
  await third.request('daemon.status');
  await third.store.flush();
  assert.ok((await readdir(env.root)).includes(id), 'kept: refs.json names it');
  assert.equal((await refusal(third.request('attachment.get', { attachmentId: attachment.attachmentId }))).reason, 'not_found', 'not served while its meta is unreadable');
});

test('the store alone: release by session (the deletion seam) starts the grace period; a fork holder (the C seam) keeps an object', { skip }, async t => {
  const root = path.join(await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-attach-store-'))), 'attachments');
  t.after(() => rm(path.dirname(root), { recursive: true, force: true }));
  const project = path.dirname(root);
  const clock = { now: Date.now() };
  const store = createAttachmentStore({ root, sessionProject: () => project, now: () => clock.now, sweepMs: 0 });
  t.after(() => store.close());
  const owner = { id: 'owner', epoch: 'owner' };
  const begun = await store.begin(owner, { sessionId: 's1', name: 'a.txt', size: 3, mimeType: 'text/plain', requestId: 'a' });
  await store.chunk(owner, { uploadId: begun.uploadId, offset: 0, data: b64('abc') });
  const { attachment } = await store.commit(owner, { uploadId: begun.uploadId, sha256: sha('abc') });
  await store.pin('prompt:k1', 's1', [attachment.attachmentId]);
  await store.pin('fork:s2', 's2', [attachment.attachmentId], 'fork');
  await store.releaseSessions(['s1']);
  clock.now += ATTACHMENTS.releasedGraceMs + 1;
  await store.sweep();
  assert.equal((await store.get(owner, { attachmentId: attachment.attachmentId })).attachment.referenced, true, 'the fork still holds it');
  await store.releaseSessions(['s2']);
  clock.now += ATTACHMENTS.releasedGraceMs - 1000;
  await store.sweep();
  assert.equal((await store.get(owner, { attachmentId: attachment.attachmentId })).attachment.referenced, false, 'released, within its grace');
  clock.now += 2000;
  await store.sweep();
  await assert.rejects(store.get(owner, { attachmentId: attachment.attachmentId }), { code: 1001 });
  assert.equal(store.usage().bytes, 0);
});

/** A store alone on a fresh root (the session's project is the root's parent), closed after the test. */
async function bareStore(t, options = {}) {
  const root = options.root ?? path.join(await realpath(await mkdtemp(path.join(tmpdir(), 'alpd-attach-store-'))), 'attachments');
  if (!options.root) t.after(() => rm(path.dirname(root), { recursive: true, force: true }));
  const store = createAttachmentStore({ root, sessionProject: () => path.dirname(root), sweepMs: 0, ...options, ...{ root } });
  t.after(() => store.close());
  return { root, store };
}

test('collection while alpd runs waits for start-up recovery: objects not yet loaded are never taken for leftovers', { skip }, async t => {
  const { root, store } = await bareStore(t);
  const owner = { id: 'owner', epoch: 'owner' };
  const ids = [];
  for (let i = 0; i < 200; i++) {
    const begun = await store.begin(owner, { sessionId: 's1', name: `f${i}.txt`, size: 1, mimeType: 'text/plain', requestId: `r${i}` });
    await store.chunk(owner, { uploadId: begun.uploadId, offset: 0, data: b64('x') });
    ids.push((await store.commit(owner, { uploadId: begun.uploadId, sha256: sha('x') })).attachment.attachmentId);
  }
  store.close();
  // Older than the upload timeout, well within their 24 h retention.
  const old = new Date(Date.now() - ATTACHMENTS.uploadTimeoutMs - 60_000);
  for (const id of ids) await utimes(path.join(root, id.slice(4)), old, old);
  const { store: restarted } = await bareStore(t, { root, sweepMs: 1 });
  await restarted.ready();
  await new Promise(resolve => setTimeout(resolve, 50));
  await restarted.sweep();
  const left = (await readdir(root)).filter(name => /^[0-9a-f]{32}$/.test(name));
  assert.equal(left.length, ids.length, 'every committed object within its retention is kept');
  for (const id of ids) assert.equal((await restarted.get(owner, { attachmentId: id })).attachment.size, 1);
  assert.equal(restarted.usage().bytes, ids.length);
});

test('a begin of a newer grant epoch releases the principal\'s uploads of earlier epochs; concurrent repeats of an expired begin make one upload', { skip }, async t => {
  const clock = { now: Date.now() };
  const { store } = await bareStore(t, { now: () => clock.now });
  const before = { id: 'pppppppppppppppp', epoch: 'e1' };
  const after = { id: 'pppppppppppppppp', epoch: 'e2' };
  const begin = (as, requestId, size = 4) => store.begin(as, { sessionId: 's1', name: 'a.bin', size, mimeType: 'application/octet-stream', requestId });
  const stale = [await begin(before, 'a'), await begin(before, 'b')];
  await assert.rejects(begin(before, 'c'), { code: 1005 }, 'the earlier epoch holds every active upload slot');
  // The reissued credential (another epoch) is not locked out by uploads nobody can continue.
  const fresh = await begin(after, 'a');
  assert.notEqual(fresh.uploadId, stale[0].uploadId);
  assert.deepEqual(store.usage(after.id), { bytes: 4, uploads: 1 });
  for (const { uploadId } of stale) {
    await assert.rejects(store.chunk(before, { uploadId, offset: 0, data: b64('abcd') }), { code: 1001 });
    await assert.rejects(store.chunk(after, { uploadId, offset: 0, data: b64('abcd') }), { code: 1001 });
  }
  // An expired upload repeated twice at once is begun again once.
  clock.now += ATTACHMENTS.uploadTimeoutMs + 1;
  const [one, two] = await Promise.all([begin(after, 'a'), begin(after, 'a')]);
  assert.equal(one.uploadId, two.uploadId);
  assert.notEqual(one.uploadId, fresh.uploadId);
  assert.deepEqual(store.usage(after.id), { bytes: 4, uploads: 1 });
});

test('AttachmentStore.close() waits for in-flight operations to drain, then throws attachment_unavailable', { skip }, async t => {
  const clock = { now: Date.now() };
  const { store } = await bareStore(t, { now: () => clock.now });
  const owner = { id: 'owner1', epoch: 'e1' };

  const begun = await store.begin(owner, { sessionId: 's1', name: 'drain.bin', size: 10, mimeType: 'application/octet-stream', requestId: 'req-drain' });
  await store.close();

  await assert.rejects(
    store.begin(owner, { sessionId: 's1', name: 'after.bin', size: 1, mimeType: 'text/plain', requestId: 'after' }),
    { code: 1005, message: 'alpd attachment store is closed' }
  );
  await assert.rejects(
    store.chunk(owner, { uploadId: begun.uploadId, offset: 0, data: b64('abc') }),
    { code: 1005, message: 'alpd attachment store is closed' }
  );
});

test('daemon IPC dispatcher sanitizes unexpected attachment errors without exposing host store paths', { skip }, async t => {
  const world = await setup(t);
  const daemon = await world.start();
  const sessionId = await daemon.create();

  const { uploadId } = await daemon.request('attachment.begin', { sessionId, name: 'leak.txt', size: 10, mimeType: 'text/plain', requestId: 'leak-req' });
  const payloadPath = path.join(world.root, uploadId.slice(4), 'payload');
  await chmod(payloadPath, 0o000);

  const error = await daemon.request('attachment.chunk', { uploadId, offset: 0, data: b64('test') }).catch(err => err);
  assert.equal(error.code, 1000);
  assert.equal(error.data?.reason, 'persistence_failed');
  assert.ok(!error.message.includes(world.root), 'message must not contain host filesystem paths');

  await chmod(payloadPath, 0o600).catch(() => {});
});
