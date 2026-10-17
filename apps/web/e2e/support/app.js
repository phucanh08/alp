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

/**
 * Starts a session from the New session screen (Paseo's new agent tab) with a title and, when
 * given, a first message; waits until it is ready for a message.
 */
export async function newSession(page, title, { from = page.getByRole('navigation').getByRole('button', { name: 'New session' }), prompt } = {}) {
  await from.click();
  const screen = page.getByTestId('new-session-screen');
  await expect(screen).toBeVisible();
  await screen.getByLabel('Title (optional)').fill(title);
  if (prompt) await screen.getByLabel('Message', { exact: true }).fill(prompt);
  await expect(screen.getByRole('button', { name: 'Start session' })).toBeEnabled();
  await screen.getByRole('button', { name: 'Start session' }).click();
  await expect(screen).toBeHidden();
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
