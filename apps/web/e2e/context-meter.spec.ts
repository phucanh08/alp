// The context window meter (t-7679.12), through the real UI, a real gateway and a real alpd (fake
// Codex reporting token usage as Codex does): Paseo's ring in the composer, its colours, its
// details on hover, and the usage kept across a reload.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { assistant, connect, idle, newSession } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

test('the meter fills with the session\'s context, shows the details, and keeps them across a reload', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Token usage');
  const meter = page.getByTestId('context-window-meter');
  // Before the runtime reports anything: an empty track and Paseo's "No context data".
  await expect(meter).toHaveAccessibleName('Context window: No context data');
  // The pointer rests where Start session was, now the meter: it enters from elsewhere, as a user's would.
  await page.mouse.move(0, 0);
  await meter.hover();
  await expect(page.getByTestId('context-window-details')).toContainText('No context data');

  const composer = page.getByLabel('Message', { exact: true });
  await composer.fill('How big is it? [usage:54000]');
  await composer.press('Enter');
  await assistant(page, 'Echo: How big is it?');
  await idle(page);
  await expect(meter).toHaveAccessibleName('Context window 21% used');
  await expect(meter).toHaveAttribute('data-level', 'normal');
  await page.mouse.move(0, 0);
  await meter.hover();
  const details = page.getByTestId('context-window-details');
  await expect(details).toContainText('Context window');
  await expect(details).toContainText('21% used');
  await expect(details).toContainText('54k / 258k tokens');
  await expect(details).toContainText('Last reported 53k input (27k cached) · 1k output');
  await expect(details).not.toContainText('Session cost', { useInnerText: true });

  // Nearly full: red, as Paseo's above 90%.
  await page.mouse.move(0, 0);
  await expect(details).toBeHidden();
  await composer.fill('Fill it [usage:240000]');
  await composer.press('Enter');
  await assistant(page, 'Echo: Fill it');
  await expect(meter).toHaveAccessibleName('Context window 93% used');
  await expect(meter).toHaveAttribute('data-level', 'danger');

  // Focus shows the details too, and Escape hides them.
  await meter.focus();
  await expect(details).toContainText('240k / 258k tokens');
  await meter.press('Escape');
  await expect(details).toBeHidden();

  // A reload replays the session's usage from the host.
  await page.reload();
  await connect(page, world);
  await page.getByTestId('session-row').filter({ hasText: 'Token usage' }).click();
  await expect(page.getByTestId('context-window-meter')).toHaveAccessibleName('Context window 93% used');
});
