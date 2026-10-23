// Files attached to a message (#121 J), through the real UI, a real gateway and a real alpd (fake
// Codex): drop and pick any file, a chip each, refusals before anything is sent, the upload into
// alpd's attachment store, what the runtime read (the fake Codex echoes each staged file's SHA-256
// and length), and one stored object and one receipt across a connection dropped mid-upload.
//
// Which runtime reads attachment parts is alpd's to say (a session's `promptAttachments`). Until a
// host's Codex runtime does, alpd refuses such a prompt (1005 attachment_unsupported) after the
// upload: the refusal tests show that honestly, with the snapshot field put in on the wire so the
// app tries; the success test then skips itself (set ALP_WEB_E2E_REQUIRE_FILES=1 to fail instead).
import { createHash } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { assistant, connect, idle, newSession } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
/** 3000 bytes of every value, NULs included: a file no text path could carry. */
const BINARY = Buffer.from(Array.from({ length: 3000 }, (_, index) => (index * 7) % 256));
const TEXT = Buffer.from('hello\nworld\n');
const RUNTIME_REFUSAL = /cannot read attachments yet; they stay stored and the prompt was not sent/;

/**
 * Watches the app's gateway WebSocket. `snapshot`: 'keep' passes frames as they are; 'strip'
 * removes `promptAttachments` from every session row (the runtime reads no files); 'add' puts
 * ['file.path'] in rows without it (so the app tries and alpd answers). `native` tells whether
 * alpd itself listed promptAttachments for a session. `dropOnChunk` closes the page's socket right
 * after the first attachment.chunk went out, before its answer.
 * @param {import('@playwright/test').Page} page
 * @param {{ snapshot?: 'keep' | 'strip' | 'add', dropOnChunk?: boolean }} [options]
 */
async function watchGateway(page, { snapshot = 'keep', dropOnChunk = false } = {}) {
  const seen = { native: false, sockets: 0, begins: /** @type {any[]} */ ([]), dropped: false };
  const rewrite = value => {
    if (Array.isArray(value)) { value.forEach(rewrite); return; }
    if (!value || typeof value !== 'object') return;
    if (typeof value.id === 'string' && typeof value.runtime === 'string') {
      if (Array.isArray(value.promptAttachments) && value.promptAttachments.length) seen.native = true;
      if (snapshot === 'strip') delete value.promptAttachments;
      if (snapshot === 'add' && !value.promptAttachments) value.promptAttachments = ['file.path'];
    }
    for (const inner of Object.values(value)) rewrite(inner);
  };
  await page.routeWebSocket(() => true, ws => {
    seen.sockets += 1;
    const server = ws.connectToServer();
    let closed = false;
    ws.onMessage(message => {
      if (closed) return;
      let request;
      try { request = JSON.parse(String(message)); } catch {}
      if (request?.method === 'attachment.begin') seen.begins.push(request.params);
      server.send(message);
      if (dropOnChunk && !seen.dropped && request?.method === 'attachment.chunk') {
        seen.dropped = true;
        closed = true;
        void ws.close({ code: 4000, reason: 'dropped by the test' });
        void server.close();
      }
    });
    server.onMessage(message => {
      if (closed) return;
      if (snapshot === 'keep' && seen.native) { ws.send(message); return; }
      let frame;
      try { frame = JSON.parse(String(message)); } catch { ws.send(message); return; }
      rewrite(frame);
      ws.send(JSON.stringify(frame));
    });
  });
  return seen;
}

/** Drops files onto the composer, as a person drags them from the desktop. */
async function dropFiles(page, files) {
  await page.getByTestId('composer-box').evaluate((box, entries) => {
    const transfer = new DataTransfer();
    for (const entry of entries) transfer.items.add(new File([Uint8Array.from(atob(entry.base64), char => char.charCodeAt(0))], entry.name, { type: entry.type }));
    box.dispatchEvent(new DragEvent('dragover', { dataTransfer: transfer, bubbles: true, cancelable: true }));
    box.dispatchEvent(new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }));
  }, files.map(file => ({ name: file.name, type: file.type, base64: file.buffer.toString('base64') })));
}

const composer = page => page.getByLabel('Message', { exact: true });

test('files a token or a runtime cannot take are refused before anything is uploaded', async ({ page }) => {
  const before = (await world.storedAttachments()).length;
  // The owner's token has no attachments.write (never a default).
  await connect(page, world);
  await newSession(page, 'No uploads here');
  await expect(page.getByRole('button', { name: 'Attach images' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Attach files' })).toHaveCount(0);
  await dropFiles(page, [{ name: 'notes.txt', type: 'text/plain', buffer: TEXT }]);
  await expect(page.getByRole('alert')).toContainText('Your access token cannot upload files (it needs attachments.write).');
  await expect(page.getByTestId('composer-file')).toHaveCount(0);

  // A token that may upload, on a session whose runtime reads no files.
  const other = await page.context().newPage();
  await watchGateway(other, { snapshot: 'strip' });
  await connect(other, world, world.tokens.fileWriter);
  await newSession(other, 'Runtime reads no files');
  await expect(other.getByRole('button', { name: 'Attach files' })).toHaveCount(0);
  await dropFiles(other, [{ name: 'notes.txt', type: 'text/plain', buffer: TEXT }]);
  await expect(other.getByRole('alert')).toContainText('main runs on codex here, which cannot read attached files.');
  await expect(other.getByTestId('composer-file')).toHaveCount(0);
  expect((await world.storedAttachments()).length).toBe(before);
  await other.close();
});

test('alpd refusing the prompt (attachment_unsupported) is shown, never as sent; Retry uploads nothing again', async ({ page }) => {
  const seen = await watchGateway(page, { snapshot: 'add' });
  await connect(page, world, world.tokens.fileWriter);
  await newSession(page, 'Files the runtime refuses');
  test.skip(seen.native, 'This host\'s Codex runtime reads attachment parts: the success test covers it.');
  const input = page.getByTestId('composer-attach-input');
  await input.setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: TEXT }, { name: 'extra.txt', mimeType: 'text/plain', buffer: TEXT }]);
  const chips = page.getByTestId('composer-file');
  await expect(chips).toHaveCount(2);
  await expect(chips.first()).toContainText('notes.txt');
  await expect(chips.first()).toContainText('12 B');
  await page.getByRole('button', { name: 'Remove extra.txt' }).click();
  await expect(chips).toHaveCount(1);
  await composer(page).fill('Please read the notes');
  await composer(page).press('Enter');
  const pending = page.getByTestId('pending-message');
  await expect(pending.getByRole('alert')).toContainText(RUNTIME_REFUSAL);
  await expect(pending.getByTestId('pending-file')).toContainText('notes.txt');
  // Not sent: no user message, no reply.
  await expect(page.getByTestId('user-message')).toHaveCount(0);
  await expect(page.getByTestId('user-message-file')).toHaveCount(0);
  await expect(assistant(page)).toHaveCount(0);
  const stored = (await world.storedAttachments()).filter(entry => entry.name === 'notes.txt' && entry.sessionId === seen.begins[0]?.sessionId);
  expect(stored).toEqual([expect.objectContaining({ state: 'committed', size: TEXT.length, sha256: sha256(TEXT) })]);
  expect(await world.promptReceipts(seen.begins[0].sessionId)).toEqual([]);

  await pending.getByRole('button', { name: 'Retry' }).click();
  await expect(pending.getByRole('alert')).toContainText(RUNTIME_REFUSAL);
  expect(seen.begins).toHaveLength(1);
  expect((await world.storedAttachments()).filter(entry => entry.sessionId === seen.begins[0].sessionId)).toHaveLength(1);
  await pending.getByRole('button', { name: 'Discard' }).click();
  await expect(pending).toHaveCount(0);
});

test('a dropped and a picked file reach the runtime byte for byte; the timeline names them, never a path', async ({ page }) => {
  const seen = await watchGateway(page);
  await connect(page, world, world.tokens.fileWriter);
  await newSession(page, 'Read my files');
  test.skip(!seen.native && process.env.ALP_WEB_E2E_REQUIRE_FILES !== '1', 'Waits for the runtime integration (#121 J): this host\'s Codex runtime does not list promptAttachments yet.');
  await expect(page.getByRole('button', { name: 'Attach files' })).toBeVisible();
  await dropFiles(page, [{ name: 'blob.bin', type: 'application/octet-stream', buffer: BINARY }]);
  await page.getByTestId('composer-attach-input').setInputFiles([{ name: 'notes.txt', mimeType: 'text/plain', buffer: TEXT }]);
  await expect(page.getByTestId('composer-file')).toHaveCount(2);
  await composer(page).fill('Read both files');
  await composer(page).press('Enter');
  await expect(page.getByTestId('composer-file')).toHaveCount(0);
  const chips = page.getByTestId('user-message-file');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toContainText('blob.bin');
  await expect(chips.nth(0)).toContainText('3 KB');
  await expect(chips.nth(1)).toContainText('notes.txt');
  await expect(chips.nth(1)).toContainText('12 B');
  await expect(assistant(page).last()).toContainText(`file blob.bin: sha256 ${sha256(BINARY)}, ${BINARY.length} bytes`);
  await expect(assistant(page).last()).toContainText(`file notes.txt: sha256 ${sha256(TEXT)}, ${TEXT.length} bytes`);
  await idle(page);

  const sessionId = seen.begins[0].sessionId;
  expect((await world.storedAttachments()).filter(entry => entry.sessionId === sessionId).map(entry => [entry.name, entry.state, entry.sha256]).sort()).toEqual([['blob.bin', 'committed', sha256(BINARY)], ['notes.txt', 'committed', sha256(TEXT)]]);
  expect(await world.promptReceipts(sessionId)).toHaveLength(1);
  const withFiles = (await world.turnStarts()).filter(entry => entry.files);
  expect(withFiles.at(-1).files.map(({ name, sha256: digest, bytes }) => ({ name, digest, bytes }))).toEqual([{ name: 'blob.bin', digest: sha256(BINARY), bytes: BINARY.length }, { name: 'notes.txt', digest: sha256(TEXT), bytes: TEXT.length }]);
  // The browser never sees where the host keeps or stages them.
  const html = await page.content();
  expect(html).not.toContain(world.home);
  expect(html).not.toContain(world.directory);
});

test('a connection dropped mid-upload continues the same upload: one object, at most one receipt', async ({ page }) => {
  const seen = await watchGateway(page, { snapshot: 'add', dropOnChunk: true });
  await connect(page, world, world.tokens.fileWriter);
  await newSession(page, 'Upload across a drop');
  // Over three chunks (256 KiB each through the gateway), so the drop comes mid-upload.
  const big = Buffer.from(Array.from({ length: 700_000 }, (_, index) => (index * 31 + (index >> 8)) % 256));
  await page.getByTestId('composer-attach-input').setInputFiles([{ name: 'big.bin', mimeType: 'application/octet-stream', buffer: big }]);
  await composer(page).fill('Read the big file');
  await composer(page).press('Enter');
  if (seen.native) {
    await expect(assistant(page).last()).toContainText(`file big.bin: sha256 ${sha256(big)}, ${big.length} bytes`, { timeout: 60_000 });
    await expect(page.getByTestId('user-message-file')).toContainText('big.bin');
  } else {
    await expect(page.getByTestId('pending-message').getByRole('alert')).toContainText(RUNTIME_REFUSAL, { timeout: 60_000 });
    await expect(page.getByTestId('user-message')).toHaveCount(0);
  }
  expect(seen.dropped).toBe(true);
  expect(seen.sockets).toBeGreaterThanOrEqual(2);
  // Begun again on the new connection under the same requestId: the same upload, continued.
  expect(seen.begins.length).toBeGreaterThanOrEqual(2);
  expect(new Set(seen.begins.map(begin => begin.requestId)).size).toBe(1);
  const sessionId = seen.begins[0].sessionId;
  const stored = (await world.storedAttachments()).filter(entry => entry.sessionId === sessionId);
  expect(stored).toEqual([expect.objectContaining({ name: 'big.bin', state: 'committed', size: big.length, sha256: sha256(big) })]);
  expect(await world.promptReceipts(sessionId)).toHaveLength(seen.native ? 1 : 0);
});
