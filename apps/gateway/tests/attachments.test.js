// Non-image attachments through the gateway (docs/protocol/alp-json-rpc-v1.md §12.6,
// docs/alp/remote-gateway.md §5.14, issue #121 branch I): attachments.write with session.write
// (session.read for get), never a default and implying nothing; the session checked against the
// grant before begin; the gateway's own principal context (credential, grant epoch, authorized
// roots) on every call, whatever the client sends; chunks over the advertised size refused before
// alpd; answers projected and alpd's errors rewritten. alpd's binding itself is proven against the
// real store in packages/daemon/tests/attachments.test.js and test/integration/gateway.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ATTACHMENTS, attachmentChunkBytes } from '@anhlp/alp-protocol';
import { CONTENT_TYPES, DEFAULT_PERMISSIONS, EXPOSURE, FORWARDED_CAPABILITIES, PERMISSIONS, gatewayAttachmentLimits, projectAttachment, projectUploadBegun } from '../src/policy.js';
import { reissueCredential, revokeCredential } from '../src/credentials.js';
import { fakeDaemon, summary } from './support/fake-daemon.js';
import { startGateway, until } from './support/harness.js';

const CAPABILITIES = ['attach.after', 'prompt.receipts', 'prompt.images', 'attachments'];
const UPLOAD = `upl_${'1'.repeat(32)}`;
const ATTACHMENT = `att_${'1'.repeat(32)}`;
const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const info = (extra = {}) => ({ attachmentId: ATTACHMENT, sessionId: 'sa', name: 'report.pdf', mimeType: 'application/pdf', detectedMimeType: 'application/pdf', size: 3, sha256: SHA, createdAt: '2026-10-22T00:00:00.000Z', committedAt: '2026-10-22T00:00:01.000Z', referenced: false, ...extra });
const daemonLimits = { ...Object.fromEntries(Object.entries(ATTACHMENTS).filter(([key]) => key !== 'maxNameBytes')), maxObjectBytes: 1024 * 1024 };

async function world(t, { maxFrame, capabilities = CAPABILITIES } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'alp-gw-attach-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const a = path.join(directory, 'a');
  const b = path.join(directory, 'b');
  const credentials = {
    uploader: { workspaces: [a], permissions: ['session.read', 'session.write', 'attachments.write'] },
    sessions: { workspaces: [a], permissions: ['session.read', 'session.write'] },
    reader: { workspaces: [a], permissions: ['session.read', 'attachments.write'] },
    other: { workspaces: [b], permissions: ['session.read', 'session.write', 'attachments.write'] },
  };
  // The workspaces exist before their canonical paths are read.
  const { mkdir } = await import('node:fs/promises');
  await mkdir(a, { recursive: true });
  await mkdir(b, { recursive: true });
  const canonicalA = await realpath(a);
  const canonicalB = await realpath(b);
  const daemon = fakeDaemon({ capabilities, sessions: [summary('sa', canonicalA), summary('sb', canonicalB)] });
  daemon.state.handlers['daemon.hello'] = () => ({ protocolVersion: 1, daemonVersion: 'fake', pid: 4242, hostname: 'fake-host', capabilities, attachmentLimits: daemonLimits });
  daemon.state.handlers['attachment.begin'] = params => ({ uploadId: UPLOAD, state: 'uploading', received: 0, size: params.size, maxChunkBytes: ATTACHMENTS.maxChunkBytes, expiresAt: '2026-10-22T01:00:00.000Z' });
  daemon.state.handlers['attachment.chunk'] = params => ({ received: params.offset + Buffer.from(params.data, 'base64').length, size: 3 });
  daemon.state.handlers['attachment.commit'] = () => ({ attachment: info() });
  daemon.state.handlers['attachment.abort'] = () => ({ aborted: true });
  daemon.state.handlers['attachment.get'] = () => ({ attachment: info() });
  daemon.state.handlers['attachment.delete'] = () => ({ deleted: true });
  daemon.state.handlers['session.prompt'] = () => ({ outcome: 'accepted', durable: true });
  const gw = await startGateway(t, { daemon, credentials, ...(maxFrame ? { config: { limits: { maxFrame } } } : {}) });
  return { daemon, a, b, canonicalA, canonicalB, ...gw };
}

const attachmentCalls = (daemon, mark) => daemon.calls().slice(mark).filter(call => call.method.startsWith('attachment.') || call.method === 'session.prompt');

test('the matrix: attachments.write with session.write (session.read for get), never a default, implying nothing', () => {
  assert.ok(PERMISSIONS.includes('attachments.write'));
  assert.ok(!DEFAULT_PERMISSIONS.includes('attachments.write'));
  assert.ok(FORWARDED_CAPABILITIES.includes('attachments'));
  assert.ok(CONTENT_TYPES.includes('attachment'));
  for (const method of ['attachment.begin', 'attachment.chunk', 'attachment.commit', 'attachment.abort', 'attachment.delete']) {
    assert.equal(EXPOSURE[method].permission, 'attachments.write', method);
    assert.deepEqual(EXPOSURE[method].alsoRequires, ['session.write'], method);
    assert.equal(EXPOSURE[method].capability, 'attachments');
  }
  assert.equal(EXPOSURE['attachment.get'].permission, 'attachments.write');
  assert.deepEqual(EXPOSURE['attachment.get'].alsoRequires, ['session.read']);
  // No principal context from the client is ever forwarded.
  for (const method of Object.keys(EXPOSURE).filter(name => name.startsWith('attachment.'))) {
    for (const field of ['principalId', 'principalEpoch', 'authorizedRoots']) assert.ok(!EXPOSURE[method].params.includes(field), `${method} ${field}`);
  }
});

test('projections: limits never above ATTACHMENTS and the frame; answers keep the schema\'s fields only', () => {
  const limits = gatewayAttachmentLimits({ ...daemonLimits, maxPerPrompt: 99, maxChunkBytes: 'x' }, 256 * 1024);
  assert.equal(limits.maxPerPrompt, ATTACHMENTS.maxPerPrompt, 'never raised');
  assert.equal(limits.maxObjectBytes, 1024 * 1024, 'alpd lowered it');
  assert.equal(limits.maxChunkBytes, attachmentChunkBytes(256 * 1024), 'lowered to the gateway\'s frame');
  assert.deepEqual(gatewayAttachmentLimits(undefined), { ...daemonLimits, maxObjectBytes: ATTACHMENTS.maxObjectBytes });
  assert.deepEqual(projectAttachment({ ...info(), path: '/home/u/.alp/state/attachments/x/payload', url: 'file:///x' }), info());
  for (const bad of [{ name: 'a/b' }, { name: '‮x' }, { name: 'x'.repeat(256) }, { attachmentId: '../x' }, { sha256: 'X' }, { size: -1 }, { referenced: 'yes' }, { mimeType: 'text/plain; charset=utf-8' }]) {
    assert.equal(projectAttachment(info(bad)), undefined, JSON.stringify(bad));
  }
  assert.deepEqual(projectUploadBegun({ uploadId: UPLOAD, state: 'uploading', received: 0, size: 3, maxChunkBytes: 999_999, expiresAt: 'later', path: '/x' }, 1000), { uploadId: UPLOAD, state: 'uploading', received: 0, size: 3, maxChunkBytes: 1000, expiresAt: 'later' });
  assert.equal(projectUploadBegun({ uploadId: '/tmp/x', state: 'uploading', received: 0, size: 3, maxChunkBytes: 1 }, 1000), undefined);
});

test('hello: the capability and effective limits, lowered to the gateway\'s frame; nothing without alpd\'s capability', async t => {
  const { sdk } = await world(t, { maxFrame: 256 * 1024 });
  const { hello } = await sdk('uploader');
  assert.ok(hello.capabilities.includes('attachments'));
  assert.equal(hello.attachmentLimits.maxChunkBytes, attachmentChunkBytes(256 * 1024));
  assert.equal(hello.attachmentLimits.maxObjectBytes, 1024 * 1024);
  const without = await world(t, { capabilities: ['attach.after', 'prompt.receipts'] });
  const plain = (await without.sdk('uploader')).hello;
  assert.ok(!plain.capabilities.includes('attachments'));
  assert.equal(plain.attachmentLimits, undefined);
});

test('permissions: refused with 1003 grant naming what is missing, before alpd hears of it', async t => {
  const { daemon, sdk } = await world(t);
  const cases = [
    ['sessions', 'attachment.begin', { sessionId: 'sa', name: 'x', size: 3, mimeType: 'text/plain', requestId: 'r' }, 'attachments.write'],
    ['sessions', 'attachment.chunk', { uploadId: UPLOAD, offset: 0, data: 'AAAA' }, 'attachments.write'],
    ['sessions', 'attachment.commit', { uploadId: UPLOAD, sha256: SHA }, 'attachments.write'],
    ['sessions', 'attachment.abort', { uploadId: UPLOAD }, 'attachments.write'],
    ['sessions', 'attachment.get', { attachmentId: ATTACHMENT }, 'attachments.write'],
    ['sessions', 'attachment.delete', { attachmentId: ATTACHMENT }, 'attachments.write'],
    ['sessions', 'session.prompt', { sessionId: 'sa', clientMessageId: 'm', content: [{ type: 'text', text: 'x' }, { type: 'attachment', attachmentId: ATTACHMENT }] }, 'attachments.write'],
    ['reader', 'attachment.begin', { sessionId: 'sa', name: 'x', size: 3, mimeType: 'text/plain', requestId: 'r' }, 'session.write'],
    ['reader', 'attachment.chunk', { uploadId: UPLOAD, offset: 0, data: 'AAAA' }, 'session.write'],
    ['reader', 'attachment.commit', { uploadId: UPLOAD, sha256: SHA }, 'session.write'],
    ['reader', 'attachment.delete', { attachmentId: ATTACHMENT }, 'session.write'],
  ];
  for (const [label, method, params, permission] of cases) {
    const { client } = await sdk(label);
    const mark = daemon.calls().length;
    await assert.rejects(client.request(method, params), error => error.code === 1003 && error.data?.reason === 'grant' && error.data.permission === permission, `${label} ${method}`);
    assert.deepEqual(attachmentCalls(daemon, mark), [], `${label} ${method} reached alpd`);
  }
  // attachments.write and session.read read metadata (only its own, alpd decides); session.write's prompts without attachments are unchanged.
  const { client: reader } = await sdk('reader');
  assert.equal((await reader.request('attachment.get', { attachmentId: ATTACHMENT })).attachment.attachmentId, ATTACHMENT);
  const { client: sessions } = await sdk('sessions');
  assert.equal((await sessions.request('session.prompt', { sessionId: 'sa', clientMessageId: 'plain', content: [{ type: 'text', text: 'x' }] })).outcome, 'accepted');
});

test('begin: a session outside the grant answers as a missing one; alpd gets the gateway\'s principal context, never the client\'s', async t => {
  const { daemon, sdk, canonicalA, ids, store } = await world(t);
  const { client } = await sdk('uploader');
  const mark = daemon.calls().length;
  for (const sessionId of ['sb', 'ses_missing']) {
    await assert.rejects(client.request('attachment.begin', { sessionId, name: 'x', size: 3, mimeType: 'text/plain', requestId: 'r' }), error => error.code === 1001, sessionId);
  }
  assert.deepEqual(attachmentCalls(daemon, mark), [], 'alpd never heard of a begin outside the grant');
  // A client naming a principal of its own: dropped; the gateway's is sent.
  const begun = await client.request('attachment.begin', { sessionId: 'sa', name: 'r.pdf', size: 3, mimeType: 'application/pdf', requestId: 'r', principalId: 'owner', principalEpoch: 'owner', authorizedRoots: ['/'] });
  assert.deepEqual(Object.keys(begun).sort(), ['expiresAt', 'maxChunkBytes', 'received', 'size', 'state', 'uploadId']);
  const sent = daemon.calls('attachment.begin').at(-1).params;
  const grant = store.grant(ids.uploader);
  assert.deepEqual(sent, { sessionId: 'sa', name: 'r.pdf', size: 3, mimeType: 'application/pdf', requestId: 'r', principalId: ids.uploader, principalEpoch: grant.scopeId, authorizedRoots: [canonicalA] });
  for (const [method, params] of [['attachment.chunk', { uploadId: UPLOAD, offset: 0, data: 'AAAA', principalId: 'owner' }], ['attachment.commit', { uploadId: UPLOAD, sha256: SHA }], ['attachment.abort', { uploadId: UPLOAD }], ['attachment.get', { attachmentId: ATTACHMENT }], ['attachment.delete', { attachmentId: ATTACHMENT }]]) {
    await client.request(method, params);
    const forwarded = daemon.calls(method).at(-1).params;
    assert.deepEqual([forwarded.principalId, forwarded.principalEpoch, forwarded.authorizedRoots], [ids.uploader, grant.scopeId, [canonicalA]], method);
  }
  // A prompt with an attachment carries the context too; one without stays as before.
  await client.request('session.prompt', { sessionId: 'sa', clientMessageId: 'm1', content: [{ type: 'text', text: 'see' }, { type: 'attachment', attachmentId: ATTACHMENT }] });
  assert.equal(daemon.calls('session.prompt').at(-1).params.principalId, ids.uploader);
  await client.request('session.prompt', { sessionId: 'sa', clientMessageId: 'm2', content: [{ type: 'text', text: 'see' }] });
  assert.equal(daemon.calls('session.prompt').at(-1).params.principalId, undefined);
  // An attachment part with anything but its id fails the schema before alpd.
  const before = daemon.calls().length;
  await assert.rejects(client.request('session.prompt', { sessionId: 'sa', clientMessageId: 'm3', content: [{ type: 'attachment', attachmentId: ATTACHMENT, path: '/etc/passwd' }] }), error => error.code === -32602);
  assert.deepEqual(attachmentCalls(daemon, before), []);
});

test('chunks over the advertised size are refused before alpd; answers and errors leave without host paths', async t => {
  const { daemon, sdk } = await world(t, { maxFrame: 256 * 1024 });
  const { client, hello } = await sdk('uploader');
  const max = hello.attachmentLimits.maxChunkBytes;
  const mark = daemon.calls().length;
  const over = await client.request('attachment.chunk', { uploadId: UPLOAD, offset: 0, data: Buffer.alloc(max + 1).toString('base64') }).catch(error => error);
  assert.deepEqual([over.code, over.data?.reason], [-32602, 'invalid_data']);
  assert.deepEqual(attachmentCalls(daemon, mark), []);
  await client.request('attachment.chunk', { uploadId: UPLOAD, offset: 0, data: Buffer.alloc(max).toString('base64') });
  // alpd's answer with a field the schema does not name is cut to its fields.
  daemon.state.handlers['attachment.get'] = () => ({ attachment: { ...info(), path: '/home/u/.alp/state/attachments/1/payload' } });
  assert.deepEqual((await client.request('attachment.get', { attachmentId: ATTACHMENT })).attachment, info());
  // One the gateway cannot pass on is refused whole.
  daemon.state.handlers['attachment.get'] = () => ({ attachment: info({ name: '../../etc/passwd' }) });
  assert.equal((await client.request('attachment.get', { attachmentId: ATTACHMENT }).catch(error => error)).code, 1000);
  // alpd's refusals: fixed text, code, reason and the numbers a client resumes with; nothing else.
  daemon.state.handlers['attachment.chunk'] = () => { throw { code: 1004, message: 'offset wrong at /home/u/.alp/state/attachments/1/payload', data: { reason: 'offset_mismatch', received: 5, file: '/home/u/x' } }; };
  const mismatch = await client.request('attachment.chunk', { uploadId: UPLOAD, offset: 9, data: 'AAAA' }).catch(error => error);
  assert.deepEqual([mismatch.code, mismatch.data], [1004, { reason: 'offset_mismatch', received: 5 }]);
  assert.ok(!mismatch.message.includes('/home'), mismatch.message);
  daemon.state.handlers['attachment.commit'] = () => { throw { code: 1000, message: 'EACCES /home/u/.alp/state/attachments/1/meta.json', data: { reason: 'persistence_failed' } }; };
  const failed = await client.request('attachment.commit', { uploadId: UPLOAD, sha256: SHA }).catch(error => error);
  assert.deepEqual([failed.code, failed.data], [1000, { reason: 'persistence_failed' }]);
  assert.ok(!failed.message.includes('/home'));
  daemon.state.handlers['attachment.get'] = () => { throw { code: 1005, message: 'bytes missing at /home/u/store', data: { reason: 'attachment_unavailable', attachmentId: ATTACHMENT, internalPath: '/secret' } }; };
  const unavail = await client.request('attachment.get', { attachmentId: ATTACHMENT }).catch(error => error);
  assert.deepEqual([unavail.code, unavail.data], [1005, { reason: 'attachment_unavailable', attachmentId: ATTACHMENT }]);
  assert.ok(!JSON.stringify(unavail).includes('/home') && !JSON.stringify(unavail).includes('/secret'));
});

test('a credential revoked mid-upload loses its connection at once: no further chunk or commit reaches alpd; a reissued grant is another epoch', async t => {
  const { daemon, sdk, rawSession, ticket, tokens, ids, home, store } = await world(t);
  const session = await rawSession('uploader');
  assert.equal((await session.call('daemon.hello', { protocolVersion: 1 })).result.protocolVersion, 1);
  const begun = (await session.call('attachment.begin', { sessionId: 'sa', name: 'x.bin', size: 3, mimeType: 'application/octet-stream', requestId: 'rev' })).result;
  assert.ok(begun.uploadId);
  await session.call('attachment.chunk', { uploadId: begun.uploadId, offset: 0, data: 'QQ==' });
  const chunks = daemon.calls('attachment.chunk').length;
  await revokeCredential(home, ids.uploader);
  const closed = await session.closed;
  assert.equal(closed.code, 4401);
  // Anything the client still sends goes nowhere; its token gets no ticket.
  try { session.socket.send(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'attachment.chunk', params: { uploadId: begun.uploadId, offset: 1, data: 'QUI=' } })); } catch {}
  try { session.socket.send(JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'attachment.commit', params: { uploadId: begun.uploadId, sha256: SHA } })); } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(daemon.calls('attachment.chunk').length, chunks);
  assert.equal(daemon.calls('attachment.commit').length, 0);
  assert.equal((await ticket(tokens.uploader)).status, 401);

  // A reissued credential (same id, new grant) is another epoch: alpd binds its uploads apart.
  const before = await rawSession('other');
  await before.call('daemon.hello', { protocolVersion: 1 });
  await before.call('attachment.begin', { sessionId: 'sb', name: 'x', size: 1, mimeType: 'text/plain', requestId: 'e1' });
  const first = daemon.calls('attachment.begin').at(-1).params;
  const { token } = await reissueCredential(home, ids.other, { permissions: ['session.read', 'session.write', 'attachments.write'] });
  assert.equal((await before.closed).code, 4401, 'a reissue replaces the secret: its connections close');
  tokens.other = token;
  await until(() => store.verify(token) !== undefined, 'the reissued credential to load');
  const after = await rawSession('other');
  await after.call('daemon.hello', { protocolVersion: 1 });
  await after.call('attachment.begin', { sessionId: 'sb', name: 'x', size: 1, mimeType: 'text/plain', requestId: 'e1' });
  const second = daemon.calls('attachment.begin').at(-1).params;
  assert.equal(second.principalId, first.principalId);
  assert.notEqual(second.principalEpoch, first.principalEpoch);
});
