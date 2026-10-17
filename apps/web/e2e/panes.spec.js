// Split panes and the command center's ALP commands (docs/paseo-parity.md §3.1, t-7679.9), through
// the real UI, gateway and alpd: split from a pane's menu, drag tabs between panes and onto a
// pane's edge, the pane commands, resize, maximize, the panes kept across a reload, the narrow
// window; Open ALP tasks and its full-screen board.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect, newSession } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const pane = (page, id) => page.getByTestId(`workspace-pane-${id}`);
const paneTabs = (page, id) => pane(page, id).getByTestId('workspace-tab');
const panes = page => page.getByTestId('workspace-panes');

/** Presses `tab` and moves it to (x, y), as a person drags it. */
async function dragTo(page, tab, x, y) {
  const from = await tab.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 10 });
  await page.mouse.up();
}

/** Runs a command center action by its words. */
async function command(page, words, id) {
  await page.keyboard.press('ControlOrMeta+K');
  const center = page.getByRole('dialog', { name: 'Command center' });
  await center.getByRole('combobox').fill(words);
  await center.getByTestId(`command-center-action-${id}`).click();
  await expect(center).toBeHidden();
}

test('split panes: split, focus, drag between panes and to an edge, resize, maximize, kept across a reload', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Split work');
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.press('ControlOrMeta+Shift+T');
  await page.getByTestId('workspace-new-tab').click();
  await page.getByRole('menuitem', { name: 'Diff' }).click();
  await expect(panes(page)).toHaveAttribute('data-panes', '1');
  await expect(paneTabs(page, 'main')).toHaveText(['Split work', 'Terminal', 'Diff']);

  // The pane's menu: Split pane right opens a New tab in a new pane, which has focus; its
  // launcher turns into what is picked (Agent: the New session draft).
  await pane(page, 'main').getByTestId('workspace-split-pane-menu').click();
  await expect(page.getByRole('menuitem')).toHaveText([/^Split pane right/, /^Split pane down/]);
  await page.getByRole('menuitem', { name: /^Split pane right/ }).click();
  await expect(panes(page)).toHaveAttribute('data-panes', '2');
  await expect(paneTabs(page, 'pane-1')).toHaveText(['New tab']);
  await expect(pane(page, 'pane-1')).toHaveAttribute('data-focused', 'true');
  await expect(pane(page, 'main')).toHaveAttribute('data-focused', 'false');
  const launcher = pane(page, 'pane-1').getByTestId('workspace-pane-new-tab-panel');
  await expect(launcher.getByRole('button')).toHaveText(['Agent', 'Terminal', 'Diff', 'Tasks', 'Agents']);
  await expect(launcher.getByRole('button', { name: 'Agent', exact: true })).toBeFocused();
  await launcher.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(paneTabs(page, 'pane-1')).toHaveText(['New session']);
  await expect(pane(page, 'pane-1').getByTestId('new-session-screen')).toBeVisible();
  // Both panes show their tab in front: Diff on the left still.
  await expect(pane(page, 'main').getByTestId('panel-unavailable-diff')).toBeVisible();
  const left = await pane(page, 'main').boundingBox();
  const right = await pane(page, 'pane-1').boundingBox();
  expect(Math.abs(left.width - right.width)).toBeLessThan(4);
  expect(right.x).toBeGreaterThan(left.x + left.width - 2);

  // A press in a pane gives it focus; the tab keys then go through its row.
  await pane(page, 'main').getByRole('tab', { name: 'Terminal' }).click();
  await expect(pane(page, 'main')).toHaveAttribute('data-focused', 'true');
  await page.keyboard.press('Alt+Shift+BracketRight');
  await expect(pane(page, 'main').getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
  await expect(pane(page, 'pane-1').getByRole('tab', { name: 'New session' })).toHaveAttribute('aria-selected', 'true');

  // Drag Diff onto the other pane's tab row: it moves there and comes forward, with the focus.
  const row = await pane(page, 'pane-1').locator('[data-pane-row]').boundingBox();
  await dragTo(page, pane(page, 'main').getByRole('tab', { name: 'Diff' }), row.x + row.width - 140, row.y + row.height / 2);
  await expect(paneTabs(page, 'main')).toHaveText(['Split work', 'Terminal']);
  await expect(paneTabs(page, 'pane-1')).toHaveText(['New session', 'Diff']);
  await expect(pane(page, 'pane-1').getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
  await expect(pane(page, 'pane-1')).toHaveAttribute('data-focused', 'true');

  // The pane commands: focus the pane to the left, move its tab right, from the command center.
  await command(page, 'focus pane left', 'pane-focus-left');
  await expect(pane(page, 'main')).toHaveAttribute('data-focused', 'true');
  await expect(pane(page, 'main').getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  await command(page, 'move tab right', 'pane-move-tab-right');
  await expect(paneTabs(page, 'main')).toHaveText(['Split work']);
  await expect(paneTabs(page, 'pane-1')).toHaveText(['New session', 'Diff', 'Terminal']);
  await expect(pane(page, 'pane-1')).toHaveAttribute('data-focused', 'true');

  // Closing the draft keeps the pane with its other tabs.
  await pane(page, 'pane-1').getByRole('button', { name: 'Close New session' }).click();
  await expect(paneTabs(page, 'pane-1')).toHaveText(['Diff', 'Terminal']);

  // The handle between them resizes; the keyboard moves it too.
  const handle = page.getByTestId('workspace-split-resize-handle');
  const at = await handle.boundingBox();
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(at.x - 150, at.y + at.height / 2, { steps: 6 });
  await page.mouse.up();
  const narrower = await pane(page, 'main').boundingBox();
  expect(narrower.width).toBeLessThan(left.width - 120);
  await handle.focus();
  const before = Number(await handle.getAttribute('aria-valuenow'));
  expect(before).toBeLessThan(45);
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', String(before + 2));

  // Maximize shows the pane alone; Restore brings the split back.
  await pane(page, 'pane-1').getByTestId('workspace-maximize-pane').click();
  await expect(pane(page, 'main')).toHaveCount(0);
  await pane(page, 'pane-1').getByTestId('workspace-restore-pane').click();
  await expect(pane(page, 'main')).toBeVisible();

  // A reload brings the panes back: their tabs, the one in front of each, the focus.
  await page.reload();
  await connect(page, world);
  await expect(panes(page)).toHaveAttribute('data-panes', '2');
  await expect(paneTabs(page, 'main')).toHaveText(['Split work']);
  await expect(paneTabs(page, 'pane-1')).toHaveText(['Diff', 'Terminal']);
  await expect(pane(page, 'pane-1')).toHaveAttribute('data-focused', 'true');
  await expect(pane(page, 'main').getByPlaceholder(/^Message main/)).toBeVisible();

  // A tab dropped on a pane's lower edge splits that pane down with it.
  const body = await pane(page, 'pane-1').locator('[data-pane-body]').boundingBox();
  const tab = pane(page, 'pane-1').getByRole('tab', { name: 'Terminal' });
  const from = await tab.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(body.x + body.width / 2, body.y + body.height - 20, { steps: 10 });
  await expect(pane(page, 'pane-1').getByTestId('workspace-drop-zone')).toHaveAttribute('data-position', 'bottom');
  await page.mouse.up();
  await expect(panes(page)).toHaveAttribute('data-panes', '3');
  await expect(paneTabs(page, 'pane-2')).toHaveText(['Terminal']);
  const upper = await pane(page, 'pane-1').boundingBox();
  const lower = await pane(page, 'pane-2').boundingBox();
  expect(lower.y).toBeGreaterThan(upper.y + upper.height - 2);

  // Close pane closes its tabs; a pane whose last tab closes goes too.
  await command(page, 'close pane', 'pane-close');
  await expect(panes(page)).toHaveAttribute('data-panes', '2');
  await pane(page, 'pane-1').getByRole('button', { name: 'Close Diff' }).click();
  await expect(panes(page)).toHaveAttribute('data-panes', '1');
  await expect(paneTabs(page, 'main')).toHaveText(['Split work']);
  await expect(page.getByTestId('workspace-maximize-pane')).toHaveCount(0);
});

test('a narrow window shows the focused pane with every tab, without the split actions; a New tab pane comes back after a reload', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Narrow split');
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await pane(page, 'main').getByTestId('workspace-split-pane-menu').click();
  await page.getByRole('menuitem', { name: /^Split pane down/ }).click();
  await expect(panes(page)).toHaveAttribute('data-panes', '2');
  await expect(page.getByTestId('workspace-split-group')).toHaveAttribute('data-direction', 'vertical');
  // A panel picked in the New tab takes its place in that pane.
  await pane(page, 'pane-1').getByTestId('workspace-pane-new-tab-tasks').click();
  await expect(paneTabs(page, 'pane-1')).toHaveText(['Tasks']);
  await expect(pane(page, 'pane-1').getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');
  await page.setViewportSize({ width: 700, height: 900 });
  await expect(pane(page, 'pane-1')).toBeVisible();
  await expect(pane(page, 'main')).toHaveCount(0);
  await expect(page.getByTestId('workspace-split-pane-menu')).toHaveCount(0);
  // One row of every pane's tabs: the other pane's tab is still in reach, and picking it gives
  // its pane the focus.
  await expect(paneTabs(page, 'pane-1')).toHaveText(['Narrow split', 'Tasks']);
  // The tab keys go through that row too: ⌥⇧1 is its first tab.
  await page.keyboard.press('Alt+Shift+Digit1');
  await expect(pane(page, 'main')).toBeVisible();
  await expect(pane(page, 'main').getByPlaceholder(/^Message main/)).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(pane(page, 'main')).toBeVisible();
  await expect(pane(page, 'pane-1')).toBeVisible();
  await expect(paneTabs(page, 'main')).toHaveText(['Narrow split']);

  // A pane holding only a New tab (not kept) comes back with a fresh one, as Paseo's.
  await pane(page, 'pane-1').getByTestId('workspace-split-pane-menu').click();
  await page.getByRole('menuitem', { name: /^Split pane right/ }).click();
  await expect(panes(page)).toHaveAttribute('data-panes', '3');
  await page.reload();
  await connect(page, world);
  await expect(panes(page)).toHaveAttribute('data-panes', '3');
  await expect(paneTabs(page, 'pane-2')).toHaveText(['New tab']);
  await expect(paneTabs(page, 'main')).toHaveText(['Narrow split']);
});

test('command center: Open ALP tasks, and the full-screen board', async ({ page }) => {
  await connect(page, world);
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await command(page, 'alp tasks', 'alp-open-tasks');
  await expect(panes(page).getByRole('tab', { name: 'Tasks' })).toHaveAttribute('aria-selected', 'true');

  await command(page, 'full screen', 'alp-open-tasks-screen');
  // The board in place of the workspace, as paseo-web's Tasks screen: the sidebar stays.
  const screen = page.getByRole('region', { name: 'ALP tasks' });
  await expect(screen).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'ALP tasks' })).toBeVisible();
  await expect(page.getByTestId('sidebar-column')).toBeVisible();
  await expect(page.getByTestId('workspace-panes')).toHaveCount(0);
  await expect(screen.getByRole('button', { name: 'Close tasks' })).toBeFocused();
  await screen.getByPlaceholder('New task…').fill('Board task');
  // Escape in a field with text keeps the board (and the text).
  await page.keyboard.press('Escape');
  await expect(screen.getByPlaceholder('New task…')).toHaveValue('Board task');
  await screen.getByRole('button', { name: 'Add task' }).click();
  const row = screen.getByTestId('task-row').filter({ hasText: 'Board task' });
  await expect(row).toBeVisible();
  // A task shows beside the list on a wide window, not in a tab behind the board.
  await row.click();
  await expect(screen.getByTestId('task-detail').getByRole('heading', { name: 'Board task' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Board task' })).toHaveCount(0);
  // Escape closes it: the workspace and its tabs come back.
  await page.keyboard.press('Escape');
  await expect(screen).toBeHidden();
  await expect(panes(page).getByRole('tab', { name: 'Tasks' })).toBeFocused();

  // On a phone-sized window the detail takes the board's place; its back arrow shows the list.
  await page.setViewportSize({ width: 412, height: 900 });
  await page.keyboard.press('ControlOrMeta+K');
  const center = page.getByRole('dialog', { name: 'Command center' });
  await expect(center.getByRole('group', { name: 'ALP' }).getByRole('option')).toHaveText(['Open ALP tasks', 'Open ALP tasks full screen']);
  await center.getByTestId('command-center-action-alp-open-tasks-screen').click();
  await expect(screen).toBeVisible();
  await screen.getByTestId('task-row').filter({ hasText: 'Board task' }).click();
  await expect(screen.getByTestId('task-row')).toBeHidden();
  await screen.getByRole('button', { name: 'Back to tasks' }).click();
  await expect(screen.getByTestId('task-row').filter({ hasText: 'Board task' })).toBeVisible();
  await screen.getByRole('button', { name: 'Close tasks' }).click();
  await expect(screen).toBeHidden();
});
