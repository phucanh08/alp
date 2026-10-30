// "/" in the composer (t-f628) through the real gateway and a real alpd with the fake Codex: the list
// holds main's ALP skills (session.commands), filters as the name is typed, and Enter, Tab or a click
// puts the chosen one in the box; Escape closes the list without interrupting the agent.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect, newSession } from './support/app.js';

let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const MAIN_SKILLS = ['bug-loop', 'compact', 'curate', 'goal-griller', 'prompt-leverage', 'sequence-execution-plan', 'smart-commits', 'xia'];

test('"/" suggests every command and skill of main, filters as it is typed, and inserts the chosen one', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Slash');
  const composer = page.getByLabel('Message', { exact: true });
  const list = page.getByRole('listbox', { name: 'Commands and skills' });
  const options = list.getByRole('option');

  await composer.fill('/');
  await expect(list).toBeVisible();
  await expect(options).toHaveCount(MAIN_SKILLS.length);
  for (const name of MAIN_SKILLS) await expect(options.filter({ hasText: `/${name}` })).toHaveCount(1);
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  await expect(options.filter({ hasText: '/xia' })).toContainText('skill');
  await page.screenshot({ path: process.env.ALP_SLASH_SCREENSHOT ?? test.info().outputPath('slash.png') });

  await composer.pressSequentially('se');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('/sequence-execution-plan');
  await composer.press('Enter');
  await expect(list).toBeHidden();
  await expect(composer).toHaveValue('/sequence-execution-plan ');

  // Arrow keys move, Tab chooses; Escape only closes the list.
  await composer.fill('/');
  await expect(options).toHaveCount(MAIN_SKILLS.length);
  await composer.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await composer.press('Tab');
  await expect(composer).toHaveValue(`/${MAIN_SKILLS[1]} `);
  await composer.fill('/xi');
  await expect(options).toHaveCount(1);
  await composer.press('Escape');
  await expect(list).toBeHidden();
  await expect(composer).toHaveValue('/xi');

  // A click inserts too; text that is not a command being typed shows no list.
  await composer.fill('/bug');
  await options.first().click();
  await expect(composer).toHaveValue('/bug-loop ');
  await composer.fill('hello /x');
  await expect(list).toBeHidden();
});
