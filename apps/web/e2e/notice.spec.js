// Real host notices must leave every composer control usable, even on a narrow phone.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect, newSession } from './support/app.js';

let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 700 }, { width: 320, height: 568 }]) {
  test.describe(`${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport, isMobile: viewport.width < 768, hasTouch: viewport.width < 768 });
    test('notice leaves composer controls clickable', async ({ page }) => {
      await page.clock.install();
      await connect(page, world, world.tokens.teamWriter);
      await newSession(page, `Notice ${viewport.width}`, { from: page.getByRole('main').getByRole('button', { name: 'New session', exact: true }) });
      await page.clock.pauseAt(new Date(Date.now() + 1000));
      await page.getByTestId('session-model').click();
      await page.getByRole('menuitemradio', { name: 'codex · GPT-5.6-Terra', exact: true }).click();
      const notice = page.getByRole('status').filter({ hasText: /^Changed:/ });
      await expect(notice).toContainText('GPT-5.6-Terra');
      const controls = [page.getByTestId('session-team'), page.getByTestId('session-model'), page.getByTestId('session-thinking'), page.getByRole('button', { name: 'Permissions', exact: true })];
      for (const control of controls) {
        // No forced click or dismissal: Chromium's hit testing must reach the actual trigger.
        await expect(notice).toBeVisible();
        if (viewport.width < 768) await control.tap({ timeout: 1500 });
        else await control.click({ timeout: 1500 });
        await expect(page.getByRole('menu')).toBeVisible();
        await expect(page.getByRole('menu').getByRole('menuitemradio').first()).toBeFocused();
        await page.keyboard.press('Escape');
        await expect(control).toBeFocused();
        await control.press('Enter');
        await expect(page.getByRole('menu')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(control).toBeFocused();
        await expect(notice).toBeVisible();
        const [button, toast] = await Promise.all([control.boundingBox(), notice.boundingBox()]);
        expect(button.y + button.height <= toast.y || toast.y + toast.height <= button.y || button.x + button.width <= toast.x || toast.x + toast.width <= button.x).toBe(true);
      }
      const [workspace, toast] = await Promise.all([page.getByTestId('workspace-panes').boundingBox(), notice.boundingBox()]);
      expect(workspace.y + workspace.height).toBeLessThanOrEqual(toast.y);
      expect(toast.y + toast.height).toBeLessThanOrEqual(viewport.height);
      await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
      await page.getByLabel('Message', { exact: true }).fill('Still composing');
      await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await page.clock.runFor(7999);
      await expect(notice).toBeVisible();
      await page.clock.runFor(1);
      await expect(notice).toBeHidden();
    });
  });
}
