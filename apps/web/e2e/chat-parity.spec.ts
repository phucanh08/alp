// Paseo parity batch 3 (t-de48), through the real UI, gateway and alpd (fake Codex): find in the
// chat pane (Cmd/Ctrl+F), "@" file suggestions in the composer, the open session's model, thinking
// and mode from the command center, the tab switcher with search, and the notices as a stack of
// toasts with an error boundary around each pane.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { startWorld } from './support/world.ts';
import type { World } from './support/world.ts';
import { assistant, connect, idle, newSession, send, users } from './support/app.ts';

let world: World;
// The page's own toLocaleTimeString, kept by the init script below while it breaks the chat's clock times.
declare global {
  var __realClock: Date['toLocaleTimeString'];
}
test.beforeAll(async () => {
  world = await startWorld();
  const root = world.projects.main;
  await mkdir(path.join(root, 'src', 'checkout'), { recursive: true });
  await writeFile(path.join(root, 'src', 'checkout', 'cart-total.ts'), 'export const total = 0;\n');
  await writeFile(path.join(root, 'README.md'), '# Readme\n');
});
test.afterAll(async () => { await world?.close(); });

const center = (page: Page) => page.getByRole('dialog', { name: 'Command center' });
const composer = (page: Page) => page.getByLabel('Message', { exact: true });
const highlights = (page: Page, name: string) => page.evaluate((key: string) => globalThis.CSS?.highlights?.get(key)?.size ?? 0, name);

async function command(page: Page, query: string) {
  await page.keyboard.press('ControlOrMeta+K');
  await expect(center(page)).toBeVisible();
  await center(page).getByTestId('command-center-input').fill(query);
}

test('Cmd/Ctrl+F finds in the chat: counts, moves between matches, marks them, Escape closes', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Find me');
  await send(page, 'alpha bravo');
  await expect(assistant(page).last()).toHaveText('Echo: alpha bravo');
  await idle(page);
  await send(page, 'charlie ALPHA');
  await expect(assistant(page).last()).toHaveText('Echo: charlie ALPHA');
  await idle(page);

  await composer(page).focus();
  await page.keyboard.press('ControlOrMeta+F');
  const find = page.getByTestId('pane-find');
  await expect(find).toBeVisible();
  await expect(find.getByTestId('pane-find-input')).toBeFocused();
  await page.keyboard.type('alpha');
  // Two messages and two echoes, case aside.
  await expect(find.getByTestId('pane-find-status')).toHaveText('1 of 4');
  await expect.poll(() => highlights(page, 'alp-find')).toBe(4);
  await expect.poll(() => highlights(page, 'alp-find-current')).toBe(1);
  await page.keyboard.press('Enter');
  await expect(find.getByTestId('pane-find-status')).toHaveText('2 of 4');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.press('Shift+Enter');
  await expect(find.getByTestId('pane-find-status')).toHaveText('4 of 4');
  await find.getByTestId('pane-find-next').click();
  await expect(find.getByTestId('pane-find-status')).toHaveText('1 of 4');

  // New text in the chat is searched too.
  await send(page, 'delta alpha');
  await expect(assistant(page).last()).toHaveText('Echo: delta alpha');
  await idle(page);
  await expect(find.getByTestId('pane-find-status')).toHaveText(/ of 6$/);

  await find.getByTestId('pane-find-input').fill('nothing-like-this');
  await expect(find.getByTestId('pane-find-status')).toHaveText('No matches');
  await expect.poll(() => highlights(page, 'alp-find')).toBe(0);

  // Escape closes it (and does not interrupt anything); the marks go.
  await find.getByTestId('pane-find-input').fill('bravo');
  await expect(find.getByTestId('pane-find-status')).toHaveText('1 of 2');
  await page.keyboard.press('Escape');
  await expect(find).toBeHidden();
  await expect.poll(() => highlights(page, 'alp-find')).toBe(0);
  await expect(composer(page)).toBeFocused();
  // Opened again, it keeps the last query, selected.
  await page.keyboard.press('ControlOrMeta+F');
  await expect(find.getByTestId('pane-find-input')).toHaveValue('bravo');
  await find.getByTestId('pane-find-close').click();
  await expect(find).toBeHidden();
});

test('"@" in the composer suggests the workspace\'s files; Enter puts @<path> in the message', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Mention files');
  await composer(page).fill('look at @cart');
  const popover = page.getByTestId('composer-autocomplete-popover');
  await expect(popover).toBeVisible();
  const first = popover.getByTestId('composer-file-suggestion').first();
  await expect(first).toHaveAttribute('data-path', 'src/checkout/cart-total.ts');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(popover).toBeHidden();
  await expect(composer(page)).toHaveValue('look at @src/checkout/cart-total.ts ');
  // The caret sits after the inserted path: typing goes on from there.
  await page.keyboard.type('please');
  await expect(composer(page)).toHaveValue('look at @src/checkout/cart-total.ts please');

  // A query that matches nothing says so; Escape closes the list without touching the agent.
  await composer(page).fill('and @zzzz-no-such-file');
  await expect(popover.getByTestId('composer-autocomplete-empty')).toHaveText('No files match “zzzz-no-such-file”');
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();

  // A click chooses too; the message goes with the path in it.
  await composer(page).fill('read @READ');
  await popover.locator('[data-path="README.md"]').click();
  await expect(composer(page)).toHaveValue('read @README.md ');
  await composer(page).press('Enter');
  await expect(users(page).last()).toHaveText('read @README.md');
  await expect(assistant(page).last()).toHaveText('Echo: read @README.md');

  // An e-mail address is not a mention.
  await composer(page).fill('mail me@example');
  await expect(popover).toBeHidden();
});

test('the command center changes the open session\'s model, thinking and mode; the notices stack', async ({ page }) => {
  test.setTimeout(180_000);
  await connect(page, world, world.tokens.teamWriter);
  await newSession(page, 'Agent from center');
  await send(page, 'hello');
  await expect(assistant(page).last()).toHaveText('Echo: hello');
  await idle(page);
  await expect(page.getByTestId('model-label')).toHaveText('codex · GPT-5.6-Sol');

  // An empty query does not list the agent rows; "model" lists the runtime's models, current marked.
  await page.keyboard.press('ControlOrMeta+K');
  await expect(center(page).getByRole('group', { name: 'Agent' })).toHaveCount(0);
  await center(page).getByTestId('command-center-input').fill('model');
  const agent = center(page).getByRole('group', { name: 'Agent' });
  await expect(agent.getByRole('option', { name: /Model: codex · GPT-5.6-Sol/ })).toHaveAttribute('aria-current', 'true');
  await expect(agent.getByRole('option', { name: /Opus|Sonnet|Gemini/ })).toHaveCount(0);
  await agent.getByRole('option', { name: /Model: codex · GPT-5.6-Terra/ }).click();
  await expect(center(page)).toBeHidden();
  await expect(page.getByTestId('model-label')).toHaveText('codex · GPT-5.6-Terra');
  const stack = page.getByTestId('notice-stack');
  await expect(stack.getByTestId('notice')).toHaveCount(1);
  await expect(stack.getByTestId('notice').first()).toContainText('GPT-5.6-Terra');

  // Thinking: another effort than the current one.
  await command(page, 'thinking');
  const efforts = center(page).getByRole('group', { name: 'Agent' }).getByRole('option');
  const other = efforts.filter({ hasNot: page.getByTestId('command-center-action-current') }).first();
  const label = (await other.textContent())!.replace(/^Thinking: /, '').trim();
  await other.click();
  await expect(page.getByTestId('session-thinking-label')).toHaveText(label);
  // Two notices now, the newest last.
  await expect(stack.getByTestId('notice')).toHaveCount(2);
  await expect(stack.getByTestId('notice').last()).toContainText(label);

  // Mode: Read only.
  await command(page, 'mode read');
  await center(page).getByRole('option', { name: /Mode: Read only/ }).click();
  await expect(page.getByTestId('mode-control-label')).toHaveText('Read only');
  await command(page, 'permissions');
  await expect(center(page).getByRole('option', { name: /Mode: Read only/ })).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('Escape');

  // Each toast closes on its own: the oldest's x leaves the newer one.
  const notices = stack.getByTestId('notice');
  await expect(notices).toHaveCount(2);
  const newest = await notices.last().textContent();
  await notices.first().getByRole('button', { name: 'Dismiss' }).click();
  await expect(notices).toHaveCount(1);
  await expect(notices.first()).toHaveText(newest!);
});

test('the tab switcher lists the pane\'s tabs, filters as typed, and shows the one chosen', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Switch tabs');
  for (const name of ['Open Changes', 'Open Agents']) {
    await command(page, name);
    await page.keyboard.press('Enter');
    await expect(center(page)).toBeHidden();
  }
  await expect(page.getByRole('main').locator('[role="tab"][data-tab="panel:agents"]')).toHaveAttribute('aria-selected', 'true');
  // The session's tab, Changes and Agents.
  const count = 3;
  const trigger = page.getByTestId('workspace-tab-switcher-trigger');
  await expect(trigger).toHaveAccessibleName(`Switch tabs (${count} open)`);
  await trigger.click();
  const switcher = page.getByTestId('workspace-tab-switcher');
  await expect(switcher).toBeVisible();
  await expect(switcher.getByTestId('workspace-tab-switcher-input')).toBeFocused();
  await expect(switcher.getByTestId('workspace-tab-switcher-option')).toHaveCount(count);
  // The tab in front is marked and selected first.
  await expect(switcher.locator('[aria-current="true"]')).toHaveAttribute('data-tab', 'panel:agents');
  await page.keyboard.type('changes');
  await expect(switcher.getByTestId('workspace-tab-switcher-option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(switcher).toBeHidden();
  await expect(page.getByRole('main').locator('[role="tab"][data-tab="panel:changes"]')).toHaveAttribute('aria-selected', 'true');

  // From the command center, on the focused pane: arrows move, Enter shows the tab; Escape closes.
  await command(page, 'switch tab');
  await page.keyboard.press('Enter');
  await expect(switcher).toBeVisible();
  await page.keyboard.type('switch');
  await expect(switcher.getByTestId('workspace-tab-switcher-option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main').locator('[role="tab"][aria-selected="true"]')).toHaveAttribute('data-tab', /^agent:/);
  await trigger.click();
  await page.keyboard.press('Escape');
  await expect(switcher).toBeHidden();
  await expect(trigger).toBeFocused();
  // A click outside closes it too.
  await trigger.click();
  await page.getByRole('main').locator('header').click({ position: { x: 5, y: 5 } });
  await expect(switcher).toBeHidden();
});

test('a render error in a tab shows in its pane, the rest of the app stays; Try again renders it again', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Break me');
  await send(page, 'first');
  await expect(assistant(page).last()).toHaveText('Echo: first');
  await idle(page);
  // The chat's clock times fail to render, as a real bug in a tab would.
  await page.evaluate(() => {
    globalThis.__realClock = Date.prototype.toLocaleTimeString;
    Date.prototype.toLocaleTimeString = function () { throw new Error('clock broke in a test'); };
  });
  await send(page, 'second');
  const fallback = page.getByTestId('pane-error-boundary');
  await expect(fallback).toBeVisible();
  await expect(fallback.getByTestId('pane-error-boundary-message')).toHaveText('clock broke in a test');
  // The window around it still works: the sidebar, the header, the tabs and the command center.
  await expect(page.getByRole('heading', { level: 1, name: 'Break me' })).toBeVisible();
  await expect(page.getByTestId('root-error-boundary')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+K');
  await expect(center(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() => { Date.prototype.toLocaleTimeString = globalThis.__realClock; });
  await fallback.getByTestId('pane-error-boundary-retry').click();
  await expect(fallback).toBeHidden();
  await expect(users(page).last()).toHaveText('second');
  await expect(assistant(page).last()).toHaveText('Echo: second');
});
