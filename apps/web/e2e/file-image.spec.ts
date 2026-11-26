// t-a35b item 5, through the real UI, gateway and alpd: a raster image (PNG, JPEG, GIF, WebP by
// extension, any case) opened in a file tab shows as an image with its size and pixel dimensions,
// read through workspace.files.preview (files.read) or, on the host owner's own dashboard, through
// host.files.preview; SVG stays text (never rendered); an image over 1 MiB says it is too large; a
// token without files.read is refused as for any file; images are never edited.
import { deflateSync, crc32 } from 'node:zlib';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { connect as hostConnect } from '@anhlp/alp-client';
import { startWorld } from './support/world.ts';
import type { World } from './support/world.ts';
import { connect } from './support/app.ts';
import { dashboardSettings, startDashboard } from './support/dashboard.ts';
import type { Dashboard } from './support/dashboard.ts';
import { closeWorldAfter } from './support/cleanup.ts';

/** A PNG of `width` × `height` opaque pixels of one colour. */
function png(width: number, height: number, [r, g, b] = [200, 40, 40]) {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const pixels = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const PICTURE = png(3, 2);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>window.__svgRan = true</script></svg>\n';

let world: World;
let dashboard: Dashboard;
let project: string;
// The page global the SVG's script would set if the page ever ran it.
declare global {
  interface Window { __svgRan?: boolean }
}

async function host(method: string, params: unknown) {
  const client = await hostConnect(world.socket);
  try { return await client.request(method, params); } finally { client.close(); }
}

test.beforeAll(async () => {
  world = await startWorld({ settings: await dashboardSettings() });
  project = await realpath(world.projects.main);
  await writeFile(path.join(project, 'picture.PNG'), PICTURE);
  await writeFile(path.join(project, 'icon.svg'), SVG);
  // Over 1 MiB, with a valid PNG start.
  await writeFile(path.join(project, 'huge.png'), Buffer.concat([PICTURE, Buffer.alloc(1024 * 1024)]));
  // The project in alpd's registry, so the dashboard's owner may read it.
  const { revision } = await host('project.list', {});
  await host('project.register', { directory: project, ifRevision: revision, requestId: 'file-image-e2e' });
  dashboard = await startDashboard(world);
});
test.afterAll(async () => {
  if (!world) return;
  await closeWorldAfter(world, async () => { await dashboard?.stop(); });
});

const dock = (page: Page) => page.getByRole('complementary', { name: 'Explorer' });
const fileView = (page: Page) => page.getByRole('main').getByTestId('file-view');
const entry = (page: Page, file: string) => dock(page).locator(`[data-testid="files-entry"][data-path="${file}"]`);

async function open(page: Page, file: string) {
  await dock(page).getByRole('tab', { name: 'Files' }).click();
  await expect(dock(page).getByTestId('files-panel')).toBeVisible();
  await entry(page, file).click();
  await expect(fileView(page).getByTestId('file-view-path')).toHaveText(file);
}

/** The image the view shows: drawn from a data: URL of the raster type, at its natural size. */
async function expectPicture(page: Page) {
  const view = fileView(page);
  const image = view.getByTestId('file-view-image-img');
  await expect(image).toBeVisible();
  expect(await image.getAttribute('src')).toBe(`data:image/png;base64,${PICTURE.toString('base64')}`);
  await expect.poll(() => image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(3);
  expect(await image.evaluate(node => (node as HTMLImageElement).naturalHeight)).toBe(2);
  await expect(view.getByTestId('file-view-meta')).toHaveText(`${PICTURE.length} B · 3 × 2`);
  // Never edited, never a text view.
  await expect(view.getByTestId('file-view-edit')).toHaveCount(0);
  await expect(view.getByTestId('file-view-content')).toHaveCount(0);
}

test('a token with files.read sees a PNG as an image; Copy path and Refresh work; SVG stays text; over 1 MiB is too large', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  // any: workspace.files.preview requests the page sent, parsed from the socket.
  const previews: any[] = [];
  page.on('websocket', socket => socket.on('framesent', frame => { if (String(frame.payload).includes('"workspace.files.preview"')) previews.push(JSON.parse(String(frame.payload))); }));
  await connect(page, world, world.tokens.filesReader);
  await open(page, 'picture.PNG');
  await expectPicture(page);
  expect(previews.at(-1)?.params).toEqual({ projectRoot: expect.any(String), path: 'picture.PNG' });

  await fileView(page).getByTestId('file-view-copy-path').click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('picture.PNG');
  const before = previews.length;
  await fileView(page).getByTestId('file-view-refresh').click();
  await expect.poll(() => previews.length).toBeGreaterThan(before);
  await expectPicture(page);

  // SVG: its text, as before; never an image or a document in the page.
  await open(page, 'icon.svg');
  await expect(fileView(page).getByTestId('file-view-content')).toContainText('<script>window.__svgRan = true</script>');
  await expect(fileView(page).getByTestId('file-view-image-img')).toHaveCount(0);
  await expect(page.locator('main svg script')).toHaveCount(0);
  expect(await page.evaluate(() => window.__svgRan)).toBeUndefined();

  await open(page, 'huge.png');
  await expect(fileView(page).getByTestId('file-view-error')).toHaveAttribute('data-reason', 'too_large');
  await expect(fileView(page).getByTestId('file-view-error')).toContainText('This file is too large to display');
  await expect(fileView(page).getByTestId('file-view-image-img')).toHaveCount(0);
});

test('a token without files.read is refused as for any file: no image tab, the pick copies the path, no preview is asked', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const previews: (string | Buffer)[] = [];
  page.on('websocket', socket => socket.on('framesent', frame => { if (String(frame.payload).includes('"workspace.files.preview"')) previews.push(frame.payload); }));
  await connect(page, world, world.tokens.owner);
  await dock(page).getByRole('tab', { name: 'Files' }).click();
  await expect(dock(page).getByTestId('files-forbidden')).toContainText('This access token cannot read files (needs files.read).');
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.press('ControlOrMeta+P');
  const center = page.getByRole('dialog', { name: 'Command center' });
  await center.getByTestId('command-center-input').fill('picture');
  await expect(center.getByTestId('command-center-file').first()).toHaveAttribute('data-path', 'picture.PNG');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: 'Copied picture.PNG (this access token cannot read files)' })).toBeVisible();
  await expect(page.getByRole('main').locator('[data-tab^="file:"]')).toHaveCount(0);
  expect(previews).toEqual([]);
});

test('the host owner (alp dashboard, no files.read) sees the image through host.files.preview; it offers no Edit', async ({ page }) => {
  await page.goto(dashboard.url);
  await expect(page.locator(`[data-testid="project-row"][data-workspace="${project}"]`)).toBeVisible();
  await expect(page.locator('main header')).toBeVisible();
  await open(page, 'picture.PNG');
  await expectPicture(page);
  await open(page, 'huge.png');
  await expect(fileView(page).getByTestId('file-view-error')).toHaveAttribute('data-reason', 'too_large');
});
