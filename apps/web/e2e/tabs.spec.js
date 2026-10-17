// The workspace P1 slice of the Paseo parity work (docs/paseo-parity.md §3.1, t-7679.5): the tab
// context menu, drag reordering of the tab row and the tabs kept across a reload, through the
// real UI, gateway and alpd.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect, newSession } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const tabs = page => page.getByTestId('workspace-tab');
const tabMenu = page => page.getByRole('menu', { name: 'Tab actions' });

/** Presses `tab` and moves it over `target`'s left edge, as a person drags it. */
async function drag(page, tab, target) {
  const from = await tab.boundingBox();
  const to = await target.boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + 4, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
}

test('tab menu, drag order and the tabs kept across a reload', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await connect(page, world);
  await newSession(page, 'Tab work');
  const body = () => page.locator('body').click({ position: { x: 700, y: 300 } });
  await body();
  await page.keyboard.press('ControlOrMeta+Shift+T');
  await page.getByTestId('workspace-new-tab').click();
  await page.getByRole('menuitem', { name: 'Diff' }).click();
  await expect(tabs(page)).toHaveText(['Tab work', 'Terminal', 'Diff']);

  // The agent's tab: Copy agent id (with its first characters), Rename, then the close actions.
  await page.getByRole('tab', { name: 'Tab work' }).click({ button: 'right' });
  const menu = tabMenu(page);
  await expect(menu.getByRole('menuitem')).toHaveText([/^Copy agent id\s*\w{7}$/, 'Rename', 'Close to the left', 'Close to the right', 'Close other tabs', 'Close']);
  await expect(menu.getByRole('menuitem', { name: 'Close to the left' })).toBeDisabled();
  await menu.getByRole('menuitem', { name: /^Copy agent id/ }).click();
  await expect(menu).toBeHidden();
  const hint = await page.evaluate(() => navigator.clipboard.readText());
  expect(hint).toMatch(/^.{8,}$/);

  // Rename from the menu renames the session.
  await page.getByRole('tab', { name: 'Tab work' }).click({ button: 'right' });
  await tabMenu(page).getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('dialog', { name: 'Rename session' });
  await rename.getByLabel('Title').fill('Tab plan');
  await rename.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Tab plan' })).toBeVisible();
  await expect(tabs(page).first()).toHaveText('Tab plan');

  // A panel's tab has the close actions only; Shift+F10 opens it from the keyboard, Escape closes it.
  await page.getByRole('tab', { name: 'Terminal' }).focus();
  await page.keyboard.press('Shift+F10');
  await expect(tabMenu(page).getByRole('menuitem')).toHaveText(['Close to the left', 'Close to the right', 'Close other tabs', 'Close']);
  await expect(tabMenu(page).getByRole('menuitem', { name: 'Close to the left' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(tabMenu(page)).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Terminal' })).toBeFocused();

  // Drag Diff before Terminal; a click without moving still just selects.
  await drag(page, page.getByRole('tab', { name: 'Diff' }), page.getByRole('tab', { name: 'Terminal' }));
  await expect(tabs(page)).toHaveText(['Tab plan', 'Diff', 'Terminal']);
  await page.getByRole('tab', { name: 'Diff' }).click();
  await expect(page.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
  await drag(page, page.getByRole('tab', { name: 'Diff' }), page.getByRole('tab', { name: 'Tab plan' }));
  await expect(tabs(page)).toHaveText(['Diff', 'Tab plan', 'Terminal']);
  await expect(page.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');

  // Closed from the keyboard (Shift+F10, End, Enter): focus lands on the tab now in front.
  await page.getByTestId('workspace-new-tab').click();
  await page.getByRole('menuitem', { name: 'Agents' }).click();
  await page.getByRole('tab', { name: 'Diff' }).click();
  await page.getByRole('tab', { name: /^Agents/ }).focus();
  await page.keyboard.press('Shift+F10');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: /^Agents/ })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Diff' })).toBeFocused();

  // Close to the right of the session's tab: Terminal goes, Diff stays in front.
  await page.getByRole('tab', { name: 'Tab plan' }).click({ button: 'right' });
  await tabMenu(page).getByRole('menuitem', { name: 'Close to the right' }).click();
  await expect(tabs(page)).toHaveText(['Diff', 'Tab plan']);
  await expect(page.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');

  // A reload (and connecting again: the token is never stored) brings the tabs back: the session,
  // the order, the active tab.
  await page.reload();
  await connect(page, world);
  await expect(tabs(page)).toHaveText(['Diff', 'Tab plan']);
  await expect(page.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { level: 1, name: 'Tab plan' })).toBeVisible();
  await page.getByRole('tab', { name: 'Tab plan' }).click();
  await expect(page.getByPlaceholder(/^Message main/)).toBeEnabled();

  // Close other tabs from Diff closes the session view too; its work goes on on the host.
  await page.getByRole('tab', { name: 'Diff' }).click({ button: 'right' });
  await tabMenu(page).getByRole('menuitem', { name: 'Close other tabs' }).click();
  await expect(tabs(page)).toHaveText(['Diff']);
  await expect(page.getByRole('tab', { name: 'Diff' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Diff' }).click({ button: 'right' });
  await expect(tabMenu(page).getByRole('menuitem', { name: 'Close other tabs' })).toBeDisabled();
  await tabMenu(page).getByRole('menuitem', { name: 'Close', exact: true }).click();
  await expect(tabs(page)).toHaveCount(0);

  // Nothing open is what the next reload shows.
  await page.reload();
  await connect(page, world);
  await expect(page.locator('main header')).toBeVisible();
  await expect(tabs(page)).toHaveCount(0);
  const stored = await page.evaluate(() => localStorage.getItem('alp-web:layout'));
  expect(stored).not.toContain(world.tokens.owner);
});

test('command center: actions and sessions, search, keys, open a session', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Palette alpha');
  await newSession(page, 'Palette beta');
  await page.locator('body').click({ position: { x: 700, y: 300 } });

  // Mod+K opens it with the input focused: the actions always shown, then the sessions.
  await page.keyboard.press('ControlOrMeta+K');
  const center = page.getByRole('dialog', { name: 'Command center' });
  const input = center.getByRole('combobox', { name: 'Search commands and sessions' });
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('placeholder', 'Search commands, sessions and agents...');
  await expect(center.getByRole('group')).toHaveText([/^Workspace actions/, /^Actions/, /^ALP/, /^Sessions/]);
  await expect(center.getByRole('group', { name: 'Workspace actions' }).getByRole('option')).toHaveText([/^New session/]);
  await expect(center.getByRole('group', { name: 'Actions', exact: true }).getByRole('option')).toHaveText([/^History/, /^Settings/, /^Keyboard shortcuts/]);
  // ALP's own commands, as its plugin adds them to paseo-web's command center (t-7679.9).
  await expect(center.getByRole('group', { name: 'ALP' }).getByRole('option')).toHaveText(['Open ALP tasks', 'Open ALP tasks full screen']);
  await expect(center.getByRole('group', { name: 'Sessions' }).getByRole('option')).toContainText(['Palette beta', 'Palette alpha']);
  await expect(center.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  // Mod+K again closes it.
  await page.keyboard.press('ControlOrMeta+K');
  await expect(center).toBeHidden();

  // A query narrows to what matches; arrows move and wrap; Enter opens the session.
  await page.keyboard.press('ControlOrMeta+K');
  await input.fill('alpha');
  await expect(center.getByRole('option')).toHaveCount(1);
  await expect(center.getByRole('option')).toContainText('Palette alpha');
  await page.keyboard.press('Enter');
  await expect(center).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: 'Palette alpha' })).toBeVisible();

  // An action by its words: "terminal" finds New terminal, with its shortcut.
  await page.keyboard.press('ControlOrMeta+K');
  await input.fill('terminal');
  await expect(center.getByTestId('command-center-action-new-terminal')).toContainText(/New terminal/);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowDown');
  await expect(center.getByTestId('command-center-action-new-terminal')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');

  // Nothing matching says so; Escape closes and focus goes back.
  await page.getByRole('tab', { name: 'Terminal' }).focus();
  await page.keyboard.press('ControlOrMeta+K');
  await input.fill('zzzz qqqq');
  await expect(center).toContainText('No matches');
  await page.keyboard.press('Escape');
  await expect(center).toBeHidden();
  await expect(page.getByRole('tab', { name: 'Terminal' })).toBeFocused();

  // Close other tabs, then Settings, from the command center; a click on a row runs it too.
  await page.keyboard.press('ControlOrMeta+K');
  await input.fill('close other');
  await center.getByTestId('command-center-action-tab-close-others').click();
  await expect(tabs(page)).toHaveText(['Terminal']);
  await page.keyboard.press('ControlOrMeta+K');
  await input.fill('settings');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: 'Settings' })).toBeVisible();
});

test('sidebar and explorer resize, kept across a reload', async ({ page }) => {
  await connect(page, world);
  const sidebar = page.getByTestId('sidebar-column');
  const explorer = page.getByTestId('explorer-column');
  await expect(sidebar).toHaveCSS('width', '320px');
  await expect(explorer).toHaveCSS('width', '320px');

  const dragBy = async (handle, dx) => {
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2, { steps: 6 });
    await page.mouse.up();
  };
  await dragBy(page.getByTestId('left-sidebar-resize-handle'), 100);
  await expect(sidebar).toHaveCSS('width', '420px');
  // The explorer grows as its left edge moves left.
  await dragBy(page.getByTestId('workspace-explorer-sidebar-resize-handle'), -80);
  await expect(explorer).toHaveCSS('width', '400px');
  // Clamped to Paseo's bounds: the sidebar never under 200px.
  await dragBy(page.getByTestId('left-sidebar-resize-handle'), -600);
  await expect(sidebar).toHaveCSS('width', '200px');
  // The handle is a separator the keyboard moves too.
  const handle = page.getByRole('separator', { name: 'Resize sidebar' });
  await handle.focus();
  await page.keyboard.press('ArrowRight');
  await expect(sidebar).toHaveCSS('width', '216px');
  await expect(handle).toHaveAttribute('aria-valuenow', '216');

  await page.reload();
  await connect(page, world);
  await expect(page.getByTestId('sidebar-column')).toHaveCSS('width', '216px');
  await expect(page.getByTestId('explorer-column')).toHaveCSS('width', '400px');

  // A narrower window: the explorer gets the room the sidebar leaves, less 400px for the rest
  // (Paseo's container width), so the center column keeps its room.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('separator', { name: 'Resize sidebar' }).focus();
  await page.keyboard.press('End');
  await expect(page.getByTestId('sidebar-column')).toHaveCSS('width', '600px');
  await expect(page.getByTestId('explorer-column')).toHaveCSS('width', '280px');
  expect((await page.locator('main').boundingBox()).width).toBeGreaterThanOrEqual(399);
  // Hiding the sidebar gives the explorer its saved width back.
  await page.locator('body').click({ position: { x: 900, y: 400 } });
  await page.keyboard.press('ControlOrMeta+B');
  await expect(page.getByTestId('explorer-column')).toHaveCSS('width', '400px');
});

test('favicon, title and a browser notification when a session waits for an answer', async ({ page }) => {
  // The browser's Notification, recorded (headless Chromium shows none); hasFocus under the test's control.
  await page.addInitScript(() => {
    window.__notes = [];
    window.__focused = true;
    class FakeNotification {
      static permission = 'default';
      static async requestPermission() { window.__asked = (window.__asked ?? 0) + 1; FakeNotification.permission = 'granted'; return 'granted'; }
      constructor(title, options) { this.title = title; this.body = options?.body; window.__notes.push({ title, body: options?.body }); window.__last = this; }
      close() {}
    }
    window.Notification = FakeNotification;
    document.hasFocus = () => window.__focused;
  });
  const notes = () => page.evaluate(() => window.__notes);
  const favicon = page.locator('link[rel="icon"]');
  await connect(page, world);

  // Permission is asked from Settings, on the click; nothing asks before.
  expect(await page.evaluate(() => window.__asked ?? 0)).toBe(0);
  await page.keyboard.press('ControlOrMeta+Comma');
  const settings = page.getByRole('region', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Enable' }).click();
  await expect(settings.getByTestId('notification-permission')).toHaveText('Allowed');
  expect(await page.evaluate(() => window.__asked)).toBe(1);
  await page.keyboard.press('ControlOrMeta+Comma');
  await expect(settings).toHaveCount(0);

  await newSession(page, 'Watcher');
  await expect(page).toHaveTitle('Watcher');
  await expect(favicon).toHaveAttribute('data-status', 'none');

  // The user is elsewhere (window without focus): the question comes as a notification and the
  // favicon shows the waiting badge.
  await page.evaluate(() => { window.__focused = false; });
  const composer = page.getByLabel('Message', { exact: true });
  await composer.fill('Ship it? [ask]');
  await composer.press('Enter');
  await expect(page.getByTestId('question')).toContainText('Deploy to staging now?');
  await expect(favicon).toHaveAttribute('data-status', 'attention');
  await expect(favicon).toHaveAttribute('href', '/favicon-attention.svg');
  await expect.poll(notes).toEqual([{ title: 'Agent needs attention', body: 'Watcher: Deploy to staging now?' }]);

  // Back on the page and on another session; the notification's click opens the waiting one.
  await page.evaluate(() => { window.__focused = true; });
  await newSession(page, 'Elsewhere');
  await expect(page).toHaveTitle('Elsewhere');
  await expect(favicon).toHaveAttribute('data-status', 'attention');
  await page.evaluate(() => window.__last.onclick());
  await expect(page.getByRole('heading', { level: 1, name: 'Watcher' })).toBeVisible();
  await expect(page).toHaveTitle('Watcher');

  // Answered: the badge goes. Asked again while the user looks at that session: no notification.
  const question = page.getByTestId('question');
  await question.getByRole('radio', { name: 'yes' }).click();
  await question.getByRole('button', { name: 'Submit' }).click();
  await expect(question).toBeHidden();
  await expect(favicon).toHaveAttribute('data-status', 'none');
  await expect(composer).toBeEnabled();
  await composer.fill('Again? [ask]');
  await composer.press('Enter');
  await expect(page.getByTestId('question')).toBeVisible();
  await expect(favicon).toHaveAttribute('data-status', 'attention');
  await page.waitForTimeout(500);
  expect(await notes()).toHaveLength(1);
});
