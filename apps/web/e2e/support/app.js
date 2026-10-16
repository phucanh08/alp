// What a person does in the app, as Playwright actions on the real UI.
import { expect } from '@playwright/test';

/** Opens the app and connects with `token`; waits for the workspace screen. */
export async function connect(page, world, token = world.tokens.owner) {
  await page.goto(world.webUrl);
  await page.getByLabel('Gateway address').fill(world.gatewayUrl);
  await page.getByLabel('Access token').fill(token);
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByLabel('Access token')).toBeHidden();
  await expect(page.locator('main header')).toBeVisible();
}

/** Starts a session from the dialog with a title; waits until it is ready for a message. */
export async function newSession(page, title, { from = page.getByRole('navigation').getByRole('button', { name: 'New session' }) } = {}) {
  await from.click();
  const dialog = page.getByRole('dialog', { name: 'New session' });
  await dialog.getByLabel('Title (optional)').fill(title);
  await dialog.getByRole('button', { name: 'Start session' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByPlaceholder(/^Message main/)).toBeEnabled();
}

/** Types a message in the composer and sends it with Enter. */
export async function send(page, text) {
  const composer = page.getByLabel('Message', { exact: true });
  await expect(composer).toBeEnabled();
  await composer.fill(text);
  await composer.press('Enter');
}

/** Opens a panel in the explorer dock: + then the panel in the New tab's launcher. */
export async function openDockPanel(page, kind, label) {
  await page.getByRole('button', { name: 'New explorer tab' }).click();
  await page.getByTestId(`workspace-new-tab-${kind}`).click();
  await expect(page.getByRole('complementary', { name: 'Explorer' }).getByRole('tab', { name: new RegExp(`^${label}`) })).toHaveAttribute('aria-selected', 'true');
}

export const openTasks = page => openDockPanel(page, 'tasks', 'Tasks');

export const assistant = page => page.getByTestId('assistant-message');
export const users = page => page.getByTestId('user-message');

/** Waits until no turn runs, as a person waits for the reply to finish before the next message. */
export async function idle(page) {
  await expect(page.getByTestId('working')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Interrupt agent' })).toBeHidden();
}
