// The chat slice of the Paseo parity work (docs/paseo-parity.md §2): the composer's keys and
// controls, a second message sent before the first one's turn shows, the question card in the
// stream, the jump-to-bottom button and ALP's Tasks pill, through the real UI, gateway and alpd.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { assistant, connect, idle, newSession, send } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const composer = page => page.getByLabel('Message', { exact: true });

test('composer: focus key, a quick second message steers, Escape interrupts, mode control', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Chat parity');

  // Paseo's hint and Cmd/Ctrl+L, from anywhere on the page.
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await expect(page.getByTestId('composer-focus-hint')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+L');
  await expect(composer(page)).toBeFocused();
  await expect(page.getByTestId('composer-focus-hint')).toBeHidden();

  // A second message right after the first, before its turn shows as running: it joins that
  // turn (steer) instead of being refused as a second turn.
  await composer(page).fill('Long job [hold]');
  await composer(page).press('Enter');
  await composer(page).fill('Also this [finish]');
  await composer(page).press('Enter');
  await expect(assistant(page).last()).toContainText('Steered: Also this');
  await expect(page.getByTestId('pending-message')).toHaveCount(0);
  await idle(page);
  const steps = (await world.turnStarts()).map(entry => entry.text);
  expect(steps.filter(text => text.includes('Long job [hold]'))).toHaveLength(1);
  expect(steps.filter(text => text.includes('Also this'))).toHaveLength(0);

  // Cmd/Ctrl+Enter right after a message queues behind its turn: the box counts the agent as
  // working from the moment the message leaves, not from turn.started.
  await composer(page).fill('Third long job [hold]');
  await composer(page).press('Enter');
  await composer(page).fill('Queued right away');
  await composer(page).press('ControlOrMeta+Enter');
  await expect(page.getByTestId('queued-message')).toContainText('Queued right away');
  await expect(page.getByTestId('pending-message')).toHaveCount(0);
  await page.getByRole('button', { name: 'Interrupt agent' }).click();
  await expect(page.getByText('Stopped.')).toHaveCount(1);
  await expect(assistant(page).last()).toContainText('Echo: Queued right away');
  await idle(page);

  // Escape in the box interrupts a running turn.
  await send(page, 'Another long job [hold]');
  await expect(page.getByRole('button', { name: 'Interrupt agent' })).toBeVisible();
  await composer(page).focus();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Stopped.')).toHaveCount(2);
  await idle(page);

  // Paseo's mode control: a menu of the modes the token allows; Shift+Tab in the box cycles.
  const mode = page.getByRole('button', { name: 'Permissions' });
  await expect(page.getByTestId('mode-control-label')).toHaveText('Full access');
  await mode.click();
  await expect(page.getByRole('menuitemradio', { name: 'Full access' })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: 'Read only' }).click();
  await expect(page.getByTestId('mode-control-label')).toHaveText('Read only');
  await composer(page).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByTestId('mode-control-label')).not.toHaveText('Read only');
  await expect(composer(page)).toBeFocused();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('stream: question card in the stream, other answer, jump to bottom, Tasks pill', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Stream parity');

  // The question card sits at the end of the conversation, inside the scrolling log.
  await send(page, 'Ship it? [ask]');
  const question = page.getByTestId('question');
  await expect(question).toContainText('Deploy to staging now?');
  await expect(page.getByRole('log', { name: 'Conversation' }).getByTestId('question')).toBeVisible();
  await question.getByRole('radio', { name: 'no' }).click();
  await question.getByLabel('Other answer').fill('after lunch');
  await expect(question.getByRole('radio', { name: 'no' })).toHaveAttribute('aria-checked', 'false');
  await question.getByLabel('Other answer').press('Enter');
  await expect(question).toBeHidden();
  await expect(assistant(page).last()).toContainText('you said "after lunch"');
  await idle(page);

  // Enough conversation to scroll; away from the end, the jump-to-bottom button shows.
  for (let i = 0; i < 4; i++) {
    await send(page, `Look again ${i} [tool]`);
    await expect(assistant(page)).toHaveCount(i + 2);
    await idle(page);
  }
  const log = page.getByRole('log', { name: 'Conversation' });
  await expect(page.getByTestId('scroll-to-bottom')).toBeHidden();
  await log.evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect(page.getByTestId('scroll-to-bottom')).toBeVisible();
  await page.getByTestId('scroll-to-bottom').click();
  await expect(page.getByTestId('scroll-to-bottom')).toBeHidden();
  await expect.poll(() => log.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(80);

  // ALP's Tasks pill above the composer: the project's open tasks; a task opens in a tab.
  const pill = page.getByRole('button', { name: 'Tasks', exact: true });
  await expect(pill).toBeVisible();
  await world.alp('task', 'add', 'Polish the chat', '-p', '1');
  await pill.click();
  await expect(page.getByTestId('tasks-pill-label')).toHaveText('Tasks · 1');
  await expect(page.getByRole('menuitem', { name: 'Ready · Polish the chat' })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Ready · Polish the chat' }).click();
  await expect(page.getByRole('tab', { name: 'Polish the chat' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('task-detail').getByRole('heading', { name: 'Polish the chat' })).toBeVisible();
});
