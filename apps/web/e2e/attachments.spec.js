// Images attached to a message (t-7679.11), through the real UI, a real gateway and a real alpd
// (fake Codex): the + button, paste, previews with Remove, the limits, and what reaches Codex: the
// image inline as a data URL, never a path.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { assistant, connect, idle, newSession } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test('attach, preview, remove, send; paste; refusals; Codex gets inline data only', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Screenshots');
  const attach = page.getByRole('button', { name: 'Attach images' });
  await expect(attach).toBeVisible();
  const input = page.getByTestId('composer-attach-input');
  const previews = page.getByTestId('composer-attachment');

  // Picked with the + button's file input: a preview each, and Remove takes one out.
  await input.setInputFiles([{ name: 'one.png', mimeType: 'image/png', buffer: PNG }, { name: 'two.png', mimeType: 'image/png', buffer: PNG }]);
  await expect(previews).toHaveCount(2);
  await expect(previews.first().getByRole('img', { name: 'one.png' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove two.png' }).click();
  await expect(previews).toHaveCount(1);

  // What the host does not take is refused before sending, with the reason.
  await input.setInputFiles([{ name: 'vector.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') }]);
  await expect(page.getByRole('alert')).toContainText('vector.svg is not a PNG, JPEG, GIF or WebP image.');
  await input.setInputFiles([{ name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) }]);
  await expect(page.getByRole('alert')).toContainText('an image is at most 2 MB');
  await expect(previews).toHaveCount(1);

  const composer = page.getByLabel('Message', { exact: true });
  await composer.fill('What is on this screen?');
  await composer.press('Enter');
  await expect(previews).toHaveCount(0);
  await expect(page.getByTestId('user-message-images').last()).toHaveText('1 image');
  await expect(assistant(page).last()).toContainText('Echo: What is on this screen? (+1 image)');
  await idle(page);

  // Pasted into the box; an image-only message goes too.
  await composer.focus();
  await page.evaluate(base64 => {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, PNG.toString('base64'));
  await expect(previews).toHaveCount(1);
  await composer.press('Enter');
  await expect(page.getByTestId('user-message-images')).toHaveCount(2);
  await expect(assistant(page).last()).toContainText('(+1 image)');
  await idle(page);

  // Codex got each image inline as a data URL ALP built, never a path or another URL.
  const withImages = (await world.turnStarts()).filter(entry => entry.images);
  expect(withImages.map(entry => entry.images)).toEqual([[{ mimeType: 'image/png', bytes: PNG.length }], [{ mimeType: 'image/png', bytes: PNG.length }]]);
});
