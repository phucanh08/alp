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
  expect(preferences).toEqual({ v: 1, sendBehavior: 'queue', theme: 'light', newSession: {} });
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
