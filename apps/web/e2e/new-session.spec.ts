// The New session screen (docs/paseo-parity.md §3.2): Paseo's new agent tab with the composer,
// team/model/thinking/permissions controls and ALP's session.preview, a first message that starts
// the session, the chosen effort reaching Codex, and the choices remembered for the next one.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { assistant, connect, idle, users } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const screen = page => page.getByTestId('new-session-screen');
const preview = page => screen(page).getByTestId('session-preview');

test('pick team, model and thinking with a live preview; the first message starts the session with that effort', async ({ page }) => {
  await connect(page, world);
  await page.getByRole('navigation').getByRole('button', { name: 'New session' }).click();
  await expect(screen(page)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'New session' })).toHaveAttribute('aria-selected', 'true');

  // The preview says what the workspace's defaults run: its team's main agent on Codex.
  await expect(preview(page).getByTestId('preview-agent')).toHaveText('main');
  await expect(preview(page).getByTestId('preview-runtime')).toHaveText('Codex');
  await expect(preview(page).getByTestId('preview-model')).toContainText('GPT-5.6-Sol');
  const defaultTeam = await preview(page).getByTestId('preview-team').textContent();

  // Another team: the preview follows.
  await screen(page).getByRole('button', { name: 'Team' }).click();
  const teamItems = page.getByRole('menu', { name: 'Team' }).getByRole('menuitemradio');
  // The team the preview named is the one checked (and the one sent).
  await expect(page.getByRole('menu', { name: 'Team' }).getByRole('menuitemradio', { name: defaultTeam, exact: true })).toHaveAttribute('aria-checked', 'true');
  const other = (await teamItems.allTextContents()).find(label => label !== defaultTeam);
  expect(other).toBeTruthy();
  await page.getByRole('menu', { name: 'Team' }).getByRole('menuitemradio', { name: other, exact: true }).click();
  await expect(preview(page).getByTestId('preview-team')).toHaveText(other);

  // The model's efforts (library.models) in the Thinking control; High goes into the preview.
  await screen(page).getByRole('button', { name: 'Model' }).click();
  await page.getByRole('menu', { name: 'Model' }).getByRole('menuitemradio', { name: 'codex · GPT-5.6-Sol' }).click();
  await screen(page).getByRole('button', { name: 'Thinking' }).click();
  const efforts = page.getByRole('menu', { name: 'Thinking' }).getByRole('menuitemradio');
  await expect(efforts).toHaveText(['Default (Low)', 'Low', 'Medium', 'High', 'Extra high', 'Max', 'Ultra']);
  await page.getByRole('menu', { name: 'Thinking' }).getByRole('menuitemradio', { name: 'High', exact: true }).click();
  await expect(screen(page).getByTestId('thinking-label')).toHaveText('High');
  await expect(preview(page).getByTestId('preview-thinking')).toHaveText('High');
  await expect(preview(page)).toHaveAttribute('aria-busy', 'false');

  // The first message starts it: named after the message, sent once, answered.
  const composer = screen(page).getByLabel('Message', { exact: true });
  await expect(composer).toBeFocused();
  await composer.fill('Plan the release');
  await composer.press('Enter');
  await expect(screen(page)).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: 'Plan the release' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Plan the release' })).toHaveAttribute('aria-selected', 'true');
  await expect(users(page)).toHaveText(['Plan the release']);
  await expect(assistant(page).last()).toContainText('Echo: Plan the release');
  await idle(page);
  await expect(page.getByRole('tab', { name: 'New session' })).toHaveCount(0);

  // The effort reached Codex with the message.
  const turns = (await world.turnStarts()).filter(entry => entry.text?.includes('Plan the release'));
  expect(turns).toHaveLength(1);
  expect(turns[0].effort).toBe('high');

  // The next New session starts from the same choices (remembered in this browser, also after a reload).
  await page.reload();
  await connect(page, world);
  await page.getByRole('navigation').getByRole('button', { name: 'New session' }).click();
  await expect(screen(page).getByRole('button', { name: 'Team' })).toContainText(other);
  await expect(screen(page).getByRole('button', { name: 'Model' })).toContainText('GPT-5.6-Sol');
  await expect(screen(page).getByTestId('thinking-label')).toHaveText('High');
  await expect(preview(page).getByTestId('preview-thinking')).toHaveText('High');

  // Starting without a message works too; the session waits for one.
  await screen(page).getByLabel('Title (optional)').fill('Empty start');
  // A double click starts one session, not two.
  await screen(page).getByRole('button', { name: 'Start session' }).dblclick();
  await expect(page.getByRole('heading', { level: 1, name: 'Empty start' })).toBeVisible();
  await expect(page.getByPlaceholder(/^Message main/)).toBeEnabled();
  await expect(users(page)).toHaveCount(0);
  // The list comes from the host's session.list after a reload: a second session would show here.
  await page.reload();
  await connect(page, world);
  await expect(page.getByRole('navigation').getByText('Empty start', { exact: true })).toHaveCount(1);
});

test('a workspace whose settings name no team offers Custom, which can be chosen back after another team', async ({ page }) => {
  await connect(page, world, world.tokens.custom);
  await page.getByRole('navigation').getByRole('button', { name: 'New session' }).click();
  await expect(screen(page)).toBeVisible();
  const menu = page.getByRole('menu', { name: 'Team' });
  const item = name => menu.getByRole('menuitemradio', { name, exact: true });
  await expect(screen(page).getByRole('button', { name: 'Team' })).toContainText('Custom');
  await screen(page).getByRole('button', { name: 'Team' }).click();
  await expect(item('Custom')).toHaveAttribute('aria-checked', 'true');
  await item('Phở').click();
  await expect(preview(page).getByTestId('preview-team')).toHaveText('Phở');
  await screen(page).getByRole('button', { name: 'Team' }).click();
  await expect(item('Custom')).toHaveAttribute('aria-checked', 'false');
  await item('Custom').click();
  await expect(screen(page).getByRole('button', { name: 'Team' })).toContainText('Custom');
  await expect(preview(page)).toHaveAttribute('aria-busy', 'false');
  await expect(preview(page).getByTestId('preview-team')).toHaveText('Custom');
  await expect(screen(page).getByRole('button', { name: 'Start session' })).toBeEnabled();

  // A returning person whose last session ran Phở starts with Phở chosen: Custom is still offered.
  await page.evaluate(() => localStorage.setItem('alp-web:preferences', JSON.stringify({ v: 1, sendBehavior: 'steer', theme: 'system', newSession: { team: 'pho' } })));
  await page.reload();
  await connect(page, world, world.tokens.custom);
  await page.getByRole('navigation').getByRole('button', { name: 'New session' }).click();
  await expect(screen(page).getByRole('button', { name: 'Team' })).toContainText('Phở');
  await screen(page).getByRole('button', { name: 'Team' }).click();
  await expect(item('Phở')).toHaveAttribute('aria-checked', 'true');
  await item('Custom').click();
  await expect(preview(page).getByTestId('preview-team')).toHaveText('Custom');
  // Nothing was started in this workspace.
  expect(await world.nonFakeSessions()).toEqual([]);
});

test('a token without session.write cannot open the New session screen', async ({ page }) => {
  await connect(page, world, world.tokens.viewer);
  // The sidebar's New session is disabled; ⌘N does nothing either.
  await expect(page.getByRole('navigation').getByRole('button', { name: 'New session' })).toBeDisabled();
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.press('ControlOrMeta+N');
  await expect(screen(page)).toHaveCount(0);
});
