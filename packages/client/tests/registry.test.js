// The portable registry helpers (packages/client/src/rpc/registry.js): each sends its method with
// exactly the params given, so a caller's requestId and cursor reach the daemon unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceRegistry } from '@anhlp/alp-client/portable';

test('gitStatus and gitDiff send workspace.git.status and workspace.git.diff as given (capability workspace.git)', async () => {
  const sent = [];
  const registry = workspaceRegistry({ request: async (method, params) => { sent.push([method, params]); return { method }; } });
  assert.deepEqual(await registry.gitStatus('wks_a'), { method: 'workspace.git.status' });
  const page = { workspaceId: 'wks_a', compare: { mode: 'base', baseRef: 'main', ignoreWhitespace: true }, path: 'src/app.ts', cursor: 'c1' };
  assert.deepEqual(await registry.gitDiff(page), { method: 'workspace.git.diff' });
  assert.deepEqual(sent, [['workspace.git.status', { workspaceId: 'wks_a' }], ['workspace.git.diff', page]]);
});

test('attachment helpers send their methods as given; upload chunks within the advertised size, resumes and commits (capability attachments)', async () => {
  const { attachments, base64Encode, sha256Hex } = await import('@anhlp/alp-client/portable');
  const { createHash, randomBytes } = await import('node:crypto');
  for (const length of [0, 1, 2, 3, 4, 5, 255, 1000]) {
    const bytes = randomBytes(length);
    assert.equal(base64Encode(new Uint8Array(bytes)), bytes.toString('base64'), `${length} bytes`);
  }
  const sample = new TextEncoder().encode('hello');
  assert.equal(await sha256Hex(sample), createHash('sha256').update('hello').digest('hex'));

  const sent = [];
  const plain = attachments({ request: async (method, params) => { sent.push([method, params]); return { method }; } });
  await plain.abort('upl_x');
  await plain.get('att_x');
  await plain.delete('att_x');
  assert.deepEqual(sent, [['attachment.abort', { uploadId: 'upl_x' }], ['attachment.get', { attachmentId: 'att_x' }], ['attachment.delete', { attachmentId: 'att_x' }]]);

  // A daemon that already holds 4 bytes (a resumed upload) and once answers offset_mismatch.
  const data = new Uint8Array(randomBytes(23));
  const stored = [];
  const calls = [];
  let mismatched = false;
  const daemon = {
    async request(method, params) {
      calls.push(method);
      if (method === 'attachment.begin') { stored.push(...data.subarray(0, 4)); return { uploadId: 'upl_1', state: 'uploading', received: 4, size: data.length, maxChunkBytes: 8, expiresAt: 'later' }; }
      if (method === 'attachment.chunk') {
        const bytes = Buffer.from(params.data, 'base64');
        assert.ok(bytes.length <= 5, 'within the smaller of the two chunk sizes');
        if (!mismatched && params.offset === 9) { mismatched = true; stored.push(...bytes); throw Object.assign(new Error('mismatch'), { code: 1004, data: { reason: 'offset_mismatch', received: stored.length } }); }
        assert.equal(params.offset, stored.length);
        stored.push(...bytes);
        return { received: stored.length, size: data.length };
      }
      if (method === 'attachment.commit') {
        assert.equal(params.sha256, createHash('sha256').update(data).digest('hex'));
        assert.deepEqual(Buffer.from(stored), Buffer.from(data));
        return { attachment: { attachmentId: 'att_1', size: data.length } };
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const progress = [];
  const attachment = await attachments(daemon).upload({ sessionId: 's', name: 'x.bin', mimeType: 'application/octet-stream', data, requestId: 'r', maxChunkBytes: 5, onProgress: received => progress.push(received) });
  assert.deepEqual(attachment, { attachmentId: 'att_1', size: data.length });
  assert.equal(calls[0], 'attachment.begin');
  assert.equal(calls.at(-1), 'attachment.commit');
  assert.equal(progress.at(-1), data.length);
  // A repeat after the commit only reads the attachment back.
  const done = await attachments({ request: async method => method === 'attachment.begin' ? { uploadId: 'upl_1', state: 'committed', received: 3, size: 3, maxChunkBytes: 8, attachmentId: 'att_1' } : { attachment: { attachmentId: 'att_1' } } }).upload({ sessionId: 's', name: 'x', mimeType: 'text/plain', data: new Uint8Array(3), requestId: 'r', sha256: '0'.repeat(64) });
  assert.deepEqual(done, { attachmentId: 'att_1' });
});

test('conversation helpers send session.fork and session.rewind exactly as given (capabilities session.fork, session.rewind)', async () => {
  const { conversation } = await import('@anhlp/alp-client/portable');
  const sent = [];
  const api = conversation({ request: async (method, params) => { sent.push([method, params]); return { method }; } });
  const fork = { sessionId: 'ses_1', requestId: 'fork-1', ifGeneration: '0123456789abcdef0123456789abcdef', boundary: { throughTurnId: 'turn-1' }, workspaceId: 'wks_1', newSessionId: 'ses_f1', title: 'Try another way' };
  const rewind = { sessionId: 'ses_1', requestId: 'rewind-1', ifGeneration: '0123456789abcdef0123456789abcdef', beforeTurnId: 'turn-2' };
  assert.deepEqual(await api.fork(fork), { method: 'session.fork' });
  assert.deepEqual(await api.rewind(rewind), { method: 'session.rewind' });
  assert.deepEqual(sent, [['session.fork', fork], ['session.rewind', rewind]]);
});
