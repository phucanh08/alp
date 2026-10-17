// Images attached to a message (t-7679.11): read in the browser within the gateway's limits and
// sent inline in session.prompt, never as a path. Against the in-memory host; no runtime is reached.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Controller } from '../src/lib/controller.js';
import { IMAGE_LIMITS, addImages, filesOf, fitImages, imageType, promptContent, readImages, toBase64 } from '../src/lib/attachments.js';
import { FakeHost, until } from './support/fake-host.js';

/** A File-like value of `size` bytes. */
const file = (name, type, size = 4) => ({ name, type, size, arrayBuffer: async () => new Uint8Array(size).fill(65).buffer });

test('imageType takes PNG, JPEG, GIF and WebP only (image/jpg as JPEG)', () => {
  assert.deepEqual(['image/png', 'image/jpg', 'IMAGE/WEBP', 'image/gif; x=1', 'image/svg+xml', 'application/pdf', ''].map(type => imageType({ type })),
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif', null, null, null]);
});

test('addImages reads what fits and says why the rest was left out', async () => {
  const one = await addImages([], [file('a.png', 'image/png')]);
  assert.equal(one.error, null);
  assert.deepEqual(one.attachments.map(({ type, mimeType, data, name, size }) => ({ type, mimeType, data, name, size })), [{ type: 'image', mimeType: 'image/png', data: 'QUFBQQ==', name: 'a.png', size: 4 }]);
  assert.match((await addImages([], [file('doc.pdf', 'application/pdf')])).error, /doc\.pdf is not a PNG, JPEG, GIF or WebP image/);
  assert.match((await addImages([], [file('big.png', 'image/png', IMAGE_LIMITS.maxBytes + 1)])).error, /an image is at most 2 MB/);
  const five = await addImages([], Array.from({ length: 5 }, (_, index) => file(`${index}.png`, 'image/png')));
  assert.equal(five.attachments.length, 4);
  assert.match(five.error, /at most 4 images/);
  const half = IMAGE_LIMITS.maxBytes - 1;
  const two = await addImages([], [file('x.png', 'image/png', half), file('y.png', 'image/png', half)]);
  assert.equal(two.attachments.length, 1);
  assert.match(two.error, /at most 2\.5 MB together/);
});

test('images read while the attached list changed join the list as it is then, within the limits again', async () => {
  const { attachments: three } = await addImages([], [file('1.png', 'image/png'), file('2.png', 'image/png'), file('3.png', 'image/png')]);
  // Read next to nothing, e.g. just after a send cleared the box: joins an empty list.
  const { added } = await readImages([], [file('late.png', 'image/png'), file('later.png', 'image/png')]);
  assert.deepEqual(fitImages([], added).attachments.map(image => image.name), ['late.png', 'later.png']);
  // Meanwhile another paste filled the box: only what still fits joins, with the reason.
  const fitted = fitImages(three, added);
  assert.deepEqual(fitted.attachments.map(image => image.name), ['1.png', '2.png', '3.png', 'late.png']);
  assert.match(fitted.error, /at most 4 images/);
});

test('toBase64 handles more than one chunk; filesOf reads files or file items', () => {
  const bytes = new Uint8Array(0x8000 * 2 + 7).map((_, index) => index % 256);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  const a = file('a.png', 'image/png');
  assert.deepEqual(filesOf({ files: [a] }), [a]);
  assert.deepEqual(filesOf({ files: [], items: [{ kind: 'string' }, { kind: 'file', getAsFile: () => a }] }), [a]);
  assert.deepEqual(filesOf(null), []);
});

test('promptContent: the text, then each image inline; an image-only message has no empty text', () => {
  const image = { id: 'i', type: 'image', mimeType: 'image/png', data: 'QUFBQQ==', name: 'a.png', size: 4 };
  assert.deepEqual(promptContent('hi'), [{ type: 'text', text: 'hi' }]);
  assert.deepEqual(promptContent('hi', [image]), [{ type: 'text', text: 'hi' }, { type: 'image', mimeType: 'image/png', data: 'QUFBQQ==', name: 'a.png' }]);
  assert.deepEqual(promptContent('', [image]), [{ type: 'image', mimeType: 'image/png', data: 'QUFBQQ==', name: 'a.png' }]);
});

test('the controller sends attached images inline in session.prompt, also without text', async t => {
  const host = new FakeHost();
  const controller = new Controller({ open: host.open, backoff: { initialMs: 5, maxMs: 20, jitter: 0 }, stableMs: 1, taskPollMs: 60_000, sessionPollMs: 60_000, requestTimeoutMs: 2_000, releaseTimeoutMs: 500 });
  t.after(() => controller.disconnect());
  const state = () => controller.getState();
  host.seed('ses_a');
  controller.connect({ url: 'http://127.0.0.1:7434', token: 'alpgw1.0123456789abcdef.secret' });
  await until(() => state().connection.phase === 'open', 'open');
  controller.selectWorkspace('/w/a');
  await until(() => state().sessions.status === 'ready', 'sessions');
  controller.selectSession('ses_a');
  await until(() => state().tree?.status === 'attached', 'attached');
  const { attachments } = await addImages([], [file('shot.png', 'image/png')]);
  await controller.sendPrompt('look', undefined, attachments);
  const sent = () => host.calls.filter(call => call.method === 'session.prompt').map(call => call.params.content);
  assert.deepEqual(sent().at(-1), [{ type: 'text', text: 'look' }, { type: 'image', mimeType: 'image/png', data: 'QUFBQQ==', name: 'shot.png' }]);
  await until(() => !state().prompts.length && !controller.rootBusy('ses_a'), 'the first turn ends');
  await controller.sendPrompt('', undefined, attachments);
  await until(() => sent().length === 2, 'the image-only message');
  assert.deepEqual(sent().at(-1), [{ type: 'image', mimeType: 'image/png', data: 'QUFBQQ==', name: 'shot.png' }]);
  await controller.sendPrompt('   ');
  assert.equal(sent().length, 2, 'an empty message without images is not sent');
});
