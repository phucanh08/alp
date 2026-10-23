// The runtime's staging of attachment copies (packages/runtime/src/attachments.ts, §12.6 Runtimes),
// alone: what a drop racing a stage leaves, and the names copies get.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createAttachmentStager, stagedName } from '@anhlp/alp-runtime/attachments';

const skip = process.platform === 'win32' && 'attachments are macOS and Linux only';
const bytes = Buffer.from('slow bytes');
const attachment = { type: 'attachment', attachmentId: `att_${'a'.repeat(32)}`, name: 'slow.txt', mimeType: 'text/plain', detectedMimeType: 'text/plain', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };

test('a drop while the same attachment is being staged waits for it: no copy of a collected object stays', { skip }, async t => {
  const root = path.join(await mkdtemp(path.join(tmpdir(), 'alp-stager-')), 'staged');
  t.after(() => rm(path.dirname(root), { recursive: true, force: true }));
  const stager = createAttachmentStager(root);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const reader = { async open() { await gate; return { stream: Readable.from([bytes]), attachment }; } };
  const staging = stager.stage(reader, attachment, 's1');
  await new Promise(resolve => setTimeout(resolve, 20));
  const dropping = stager.drop(attachment.attachmentId);
  release();
  assert.equal(path.basename(await staging), `${attachment.attachmentId}.txt`);
  await dropping;
  assert.deepEqual((await readdir(root)).filter(name => !name.startsWith('.')), [], 'the copy went with its object');
});

test('copies are named by id and a plain extension only', () => {
  assert.equal(stagedName({ ...attachment, name: '../../x.SH' }), `${attachment.attachmentId}.sh`);
  assert.equal(stagedName({ ...attachment, name: 'a.$(x)', detectedMimeType: 'application/pdf' }), `${attachment.attachmentId}.pdf`);
  assert.equal(stagedName({ ...attachment, name: 'noext', detectedMimeType: 'application/octet-stream' }), attachment.attachmentId);
});

test('stagingExposure finds a writable directory holding the staging directory, even before it exists', async t => {
  const { stagingExposure } = await import('@anhlp/alp-runtime/attachments');
  const base = await mkdtemp(path.join(tmpdir(), 'alp-exposure-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, 'project');
  assert.equal(stagingExposure(path.join(workspace, '.alp-home', 'state', 'staged'), [workspace]), workspace);
  assert.equal(stagingExposure(path.join(base, 'home', 'state', 'staged'), [workspace]), undefined);
  assert.equal(stagingExposure(path.join(base, 'home', 'state', 'staged'), [path.join(base, 'proj')]), undefined, 'a sibling that merely starts alike is not a parent');
  assert.equal(stagingExposure(path.join(base, 'h', 'state', 'staged'), [tmpdir()]), tmpdir());
});
