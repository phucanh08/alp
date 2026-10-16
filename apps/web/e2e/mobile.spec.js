// The same app on a phone-sized screen: the session list is a drawer, agents and tasks a sheet.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { assistant, connect, newSession, send } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

test('drawer, new session, prompt and tasks sheet on a phone', async ({ page }) => {
  await connect(page, world);
  await expect(page.getByRole('button', { name: 'Open sessions' })).toBeVisible();
  await newSession(page, 'From my phone', { from: page.getByRole('main').getByRole('button', { name: 'New session' }) });
  await send(page, 'hello from a phone [tool]');
  await expect(assistant(page).last()).toContainText('three files');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(width).toBeLessThanOrEqual(page.viewportSize().width);

  await page.getByRole('button', { name: 'Open sessions' }).click();
  await expect(page.getByTestId('session-row')).toContainText('From my phone');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Agents and tasks' }).click();
  await page.getByRole('tab', { name: /Tasks/ }).click();
  await page.getByPlaceholder('New task…').fill('Check on mobile');
  await page.getByRole('button', { name: 'Add task' }).click();
  await expect(page.getByTestId('task-row').filter({ hasText: 'Check on mobile' })).toBeVisible();
  await page.getByRole('button', { name: 'Close panel' }).click();
  await expect(page.getByRole('tab', { name: /Tasks/ })).toBeHidden();
});
