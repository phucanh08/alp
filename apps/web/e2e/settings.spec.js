// Settings that persist (docs/paseo-parity.md §3.3, §3.4): Default send and the theme survive a
// reload through localStorage, the access token never does, garbage in storage gives the defaults,
// and Reset goes back to them. Through the real UI, gateway and alpd.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const openSettings = async page => {
  await page.getByRole('button', { name: 'Settings' }).click();
  return page.getByRole('region', { name: 'Settings' });
};
const theme = page => page.evaluate(() => document.documentElement.dataset.theme);

test('Default send and the theme survive a reload; the token does not; garbage and Reset give the defaults', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await connect(page, world);
  let settings = await openSettings(page);
  await expect(settings.getByLabel('Default send')).toHaveValue('steer');
  await expect(settings).toContainText('Saved in this browser');
  await settings.getByLabel('Default send').selectOption('queue');
  await settings.getByTestId('settings-appearance').click();
  await expect(settings.getByLabel('Theme')).toHaveValue('system');
  expect(await theme(page)).toBe('dark');
  await settings.getByLabel('Theme').selectOption('light');
  expect(await theme(page)).toBe('light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  // What storage holds: the versioned preferences; the token nowhere (the connect form keeps only
  // the gateway address, as before).
  const preferences = JSON.parse(await page.evaluate(() => localStorage.getItem('alp-web:preferences')));
  expect(preferences).toEqual({ v: 1, sendBehavior: 'queue', theme: 'light', contentWidth: 'default', toolCalls: 'collapsed', newSession: {}, terminal: { fontFamily: 'mono', fontSize: 13, theme: 'dark' } });
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(world.tokens.owner);
  expect(stored).not.toContain(world.tokens.owner.split('.').at(-1));

  // A reload: the token is gone (the connect form is empty), the preferences are not.
  await page.reload();
  await expect(page.getByLabel('Access token')).toHaveValue('');
  expect(await theme(page)).toBe('light');
  await connect(page, world);
  settings = await openSettings(page);
  await expect(settings.getByLabel('Default send')).toHaveValue('queue');
  await expect(settings).toContainText('Enter queues. Command/Ctrl+Enter steers');
  await settings.getByTestId('settings-appearance').click();
  await expect(settings.getByLabel('Theme')).toHaveValue('light');

  // System follows the device.
  await settings.getByLabel('Theme').selectOption('system');
  expect(await theme(page)).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => theme(page)).toBe('light');

  // Reset: the defaults, in the page and in storage.
  await settings.getByTestId('settings-general').click();
  await settings.getByRole('button', { name: 'Reset' }).click();
  await expect(settings.getByLabel('Default send')).toHaveValue('steer');
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('alp-web:preferences')))).toMatchObject({ v: 1, sendBehavior: 'steer', theme: 'system' });

  // Garbage in storage: the defaults, and the app still connects.
  await page.evaluate(() => localStorage.setItem('alp-web:preferences', '{"v":1,"sendBehavior":"sideways","theme":42'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  expect(await theme(page)).toBe('dark');
  await connect(page, world);
  settings = await openSettings(page);
  await expect(settings.getByLabel('Default send')).toHaveValue('steer');
});

const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('alp-web:preferences') ?? '{}'));
const contentWidth = page => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--content-width').trim());

test('content width, tool calls and the terminal display are set in Settings and survive a reload', async ({ page }) => {
  await connect(page, world);
  let settings = await openSettings(page);
  await settings.getByTestId('settings-appearance').click();
  expect(await contentWidth(page)).toBe('820px');
  await settings.getByLabel('Content width').selectOption('wide');
  await expect.poll(() => contentWidth(page)).toBe('1100px');
  // The columns read it: Tailwind's max-w-(--content-width) is in the built CSS and resolves.
  expect(await page.evaluate(() => {
    const probe = Object.assign(document.createElement('div'), { className: 'max-w-(--content-width)' });
    document.body.append(probe);
    try { return getComputedStyle(probe).maxWidth; } finally { probe.remove(); }
  })).toBe('1100px');

  await settings.getByTestId('settings-chat').click();
  await expect(settings.getByLabel('Tool call details')).toHaveValue('collapsed');
  await settings.getByLabel('Tool call details').selectOption('expanded');
  await expect(settings).toContainText('Tool calls open with their command');

  await settings.getByTestId('settings-terminal').click();
  await settings.getByLabel('Terminal font size').selectOption('16');
  await settings.getByLabel('Terminal font', { exact: true }).selectOption('menlo');
  await settings.getByLabel('Terminal theme').selectOption('light');
  await expect(settings).toContainText('not a sandbox');
  expect(await stored(page)).toMatchObject({ contentWidth: 'wide', toolCalls: 'expanded', terminal: { fontSize: 16, fontFamily: 'menlo', theme: 'light' } });

  await page.reload();
  expect(await contentWidth(page)).toBe('1100px');
  await connect(page, world);
  settings = await openSettings(page);
  await settings.getByTestId('settings-chat').click();
  await expect(settings.getByLabel('Tool call details')).toHaveValue('expanded');
  await settings.getByTestId('settings-terminal').click();
  await expect(settings.getByLabel('Terminal font size')).toHaveValue('16');
  await settings.getByTestId('settings-general').click();
  await settings.getByRole('button', { name: 'Reset' }).click();
  await expect.poll(() => contentWidth(page)).toBe('820px');
  expect(await stored(page)).toMatchObject({ contentWidth: 'default', toolCalls: 'collapsed', terminal: { fontSize: 13 } });
});

test('Diagnostics shows and copies what this browser sees, without the token; Host › Terminals says why none opens', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await connect(page, world);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-diagnostics').click();
  await expect(settings.getByTestId('diagnostics-gateway')).toHaveText(world.gatewayUrl);
  await expect(settings.getByTestId('diagnostics-state')).toHaveText('open');
  await settings.getByTestId('settings-diagnostics-copy').click();
  await expect(settings.getByTestId('settings-diagnostics-copy')).toHaveText('Copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('ALP web diagnostics');
  expect(copied).toContain('## Connection');
  expect(copied).not.toContain(world.tokens.owner);
  expect(copied).not.toContain(world.tokens.owner.split('.').at(-1));

  await settings.getByTestId('settings-terminals').click();
  await expect(settings.getByTestId('terminals-host')).toContainText('Not allowed');
  await expect(settings).toContainText('alp terminal allow --yes');
});

test('Settings › Projects registers a granted directory; Workspaces renames and pins it for the sidebar too', async ({ page }) => {
  await connect(page, world, world.tokens.registryWriter);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-projects').click();
  await settings.getByLabel('Directory to register').selectOption(world.projects.main);
  await settings.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(settings.getByTestId('project-registered').first()).toHaveText('Registered');

  await settings.getByTestId('settings-workspaces').click();
  const row = settings.getByTestId('settings-workspace-row').first();
  await expect(row).toContainText(world.projects.main);
  await row.getByRole('button', { name: /^Rename workspace/ }).click();
  await row.getByLabel(/^New name for/).fill('Storefront');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('Storefront');
  await row.getByRole('button', { name: 'Pin workspace Storefront' }).click();
  await expect(row.getByRole('button', { name: 'Unpin workspace Storefront' })).toHaveAttribute('aria-pressed', 'true');

  await settings.getByRole('button', { name: 'Back' }).click();
  const shared = page.getByTestId('shared-workspace-row').filter({ hasText: 'Storefront' });
  await expect(shared).toHaveCount(1);
  await expect(shared.getByRole('button', { name: 'Unpin workspace Storefront' })).toHaveAttribute('aria-pressed', 'true');
});

test('a token without workspace.write sees Workspaces read only', async ({ page }) => {
  await connect(page, world);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-workspaces').click();
  await expect(settings).toContainText('Read only');
  for (const button of await settings.getByRole('button', { name: /^(Pin|Unpin|Rename) workspace/ }).all()) await expect(button).toBeDisabled();
});
