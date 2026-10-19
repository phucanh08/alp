// The sidebar/workspace slice of the Paseo parity work (docs/paseo-parity.md §3.1): the session's
// title on its tab, attention on every session of the list (question.watch), History with the
// archived sessions and Unarchive, and Paseo's workspace keyboard shortcuts, through the real UI,
// gateway and alpd.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect, newSession, send } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const nav = page => page.getByRole('navigation', { name: 'Workspaces and sessions' });
const row = (page, title) => nav(page).getByTestId('session-row').filter({ hasText: title });
const heading = (page, title) => page.getByRole('heading', { level: 1, name: title });

test('tab title, attention on every session, History with archived sessions and Unarchive', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Release check');
  // Paseo names the agent's tab after it: the session's title, not "main".
  await expect(page.getByTestId('workspace-tab').first()).toHaveText('Release check');
  await expect(page.getByRole('tab', { name: 'Release check' })).toHaveAttribute('aria-selected', 'true');

  // A question left waiting in one session…
  await send(page, 'Ship it? [ask]');
  await expect(page.getByTestId('question')).toContainText('Deploy to staging now?');
  await expect(page.getByTestId('workspace-tab').first().locator('[data-status="needs_input"]')).toBeVisible();

  // …still shows on its row while another session is open (question.watch, not the open tree).
  await newSession(page, 'Notes');
  await expect(row(page, 'Notes').locator('[data-status]')).toHaveAttribute('data-status', 'done');
  await expect(row(page, 'Release check').locator('[data-status]')).toHaveAttribute('data-status', 'needs_input');

  // Archive the open session with Paseo's shortcut; it leaves the list.
  await page.locator('body').click({ position: { x: 700, y: 300 } });
  await page.keyboard.press('ControlOrMeta+Shift+Backspace');
  const confirm = page.getByRole('dialog', { name: 'Archive session?' });
  await expect(confirm).toContainText('Notes');
  await confirm.getByRole('button', { name: 'Archive' }).click();
  await expect(confirm).toBeHidden();
  await expect(row(page, 'Notes')).toHaveCount(0);

  // History lists both, the archived one with its badge, the waiting one marked.
  await nav(page).getByTestId('sidebar-history').click();
  const history = page.getByTestId('history-screen');
  await expect(history.getByRole('heading', { level: 1, name: 'History' })).toBeVisible();
  await expect(nav(page).getByTestId('sidebar-history')).toHaveAttribute('aria-current', 'page');
  const notes = history.getByTestId('history-row').filter({ hasText: 'Notes' });
  await expect(notes).toContainText('Archived');
  await expect(history.getByTestId('history-row').filter({ hasText: 'Release check' })).toContainText('1 pending');
  await expect(history.getByRole('region', { name: 'Today' })).toBeVisible();
  await history.getByLabel('Search history').fill('notes');
  await expect(history.getByTestId('history-row')).toHaveCount(1);
  await history.getByLabel('Search history').fill('nothing like this');
  await expect(history.getByTestId('history-empty')).toContainText('No sessions match');
  await history.getByRole('button', { name: 'Clear search' }).last().click();
  await expect(history.getByTestId('history-row')).toHaveCount(2);

  // Opening the archived one shows Paseo's callout in place of the composer; Unarchive restores it.
  await notes.click();
  await expect(history).toBeHidden();
  await expect(heading(page, 'Notes')).toBeVisible();
  const callout = page.getByTestId('archived-callout');
  await expect(callout).toContainText('This session is archived');
  await expect(page.getByLabel('Message', { exact: true })).toHaveCount(0);
  await callout.getByRole('button', { name: 'Unarchive' }).click();
  await expect(callout).toBeHidden();
  await expect(page.getByLabel('Message', { exact: true })).toBeEnabled();
  await expect(row(page, 'Notes')).toHaveCount(1);
  await nav(page).getByTestId('sidebar-history').click();
  await expect(page.getByTestId('history-row').filter({ hasText: 'Notes' })).not.toContainText('Archived');
});

test('a question asked in a session that is not open marks its row at once (question.watch)', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Asks later');
  await send(page, 'Check the deploy [ask-later]');
  // Another session opens before the question comes: the first is no longer attached.
  await newSession(page, 'Meanwhile');
  await expect(row(page, 'Asks later').locator('[data-status]')).not.toHaveAttribute('data-status', 'needs_input');
  // The host tells of it as it is asked, with no question.list poll (that one ran every 5 s).
  await expect(row(page, 'Asks later').locator('[data-status]')).toHaveAttribute('data-status', 'needs_input', { timeout: 4_000 });
  await row(page, 'Asks later').click();
  await expect(page.getByTestId('question')).toContainText('Deploy to staging now?');
});

test('keyboard shortcuts: help, sidebars, sessions, tabs, search, settings', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Keys one');
  await newSession(page, 'Keys two');
  const body = () => page.locator('body').click({ position: { x: 700, y: 300 } });
  await body();

  // Shift+? opens Paseo's Shortcuts dialog, searchable.
  await page.keyboard.press('Shift+?');
  const help = page.getByRole('dialog', { name: 'Shortcuts' });
  await expect(help.getByRole('region', { name: 'Tabs & Panes' })).toBeVisible();
  await help.getByLabel('Search shortcuts').fill('previous');
  await expect(help.getByTestId('shortcut-row')).toHaveText([/Previous session/, /Previous tab/]);
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();

  // The sidebar order is newest first. Alt+] and Alt+[ step through it; Alt+digit jumps.
  await expect(heading(page, 'Keys two')).toBeVisible();
  await page.keyboard.press('Alt+BracketRight');
  await expect(heading(page, 'Keys one')).toBeVisible();
  await page.keyboard.press('Alt+BracketLeft');
  await expect(heading(page, 'Keys two')).toBeVisible();
  await page.keyboard.press('Alt+Digit2');
  await expect(heading(page, 'Keys one')).toBeVisible();

  // Tabs: Mod+Shift+T opens a terminal tab; Alt+Shift+digit and Alt+Shift+[ ] move; Alt+Shift+W closes.
  await page.keyboard.press('ControlOrMeta+Shift+T');
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Alt+Shift+Digit1');
  await expect(page.getByRole('tab', { name: 'Keys one' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Alt+Shift+BracketRight');
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Alt+Shift+KeyW');
  await expect(page.getByRole('tab', { name: 'Terminal' })).toHaveCount(0);
  // Mod+T opens the New tab menu.
  await body();
  await page.keyboard.press('ControlOrMeta+T');
  await expect(page.getByRole('menu', { name: 'New tab' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu', { name: 'New tab' })).toBeHidden();

  // A request is taken once: the tab row coming back (after History) does not reopen the menu.
  await nav(page).getByTestId('sidebar-history').click();
  await expect(page.getByTestId('history-screen')).toBeVisible();
  await page.keyboard.press('Alt+Shift+KeyW');
  await page.getByTestId('history-row').filter({ hasText: 'Keys one' }).click();
  await expect(page.getByRole('tab', { name: 'Keys one' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('menu', { name: 'New tab' })).toHaveCount(0);

  // Layout: Mod+B the left sidebar, Mod+E the explorer, Mod+. both.
  const explorer = page.getByRole('complementary', { name: 'Explorer' });
  await expect(nav(page)).toBeVisible();
  await expect(explorer).toBeVisible();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(nav(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(nav(page)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+E');
  await expect(explorer).toBeHidden();
  await page.keyboard.press('ControlOrMeta+Period');
  await expect(nav(page)).toBeHidden();
  await expect(explorer).toBeHidden();
  await page.keyboard.press('ControlOrMeta+Period');
  await expect(nav(page)).toBeVisible();
  await expect(explorer).toBeVisible();

  // Mod+K opens Paseo's command center (tests in e2e/tabs.spec.js); the sidebar's session search
  // stays on its Search row and in the command center.
  await page.keyboard.press('ControlOrMeta+K');
  await expect(page.getByRole('dialog', { name: 'Command center' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Command center' })).toBeHidden();
  await nav(page).getByRole('button', { name: /^Search/ }).click();
  await expect(page.getByLabel('Search sessions')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Search sessions')).toHaveCount(0);
  // …and the sidebar coming back does not open the search again.
  await body();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(nav(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+B');
  await expect(nav(page)).toBeVisible();
  await expect(page.getByLabel('Search sessions')).toHaveCount(0);
  // The command center's search command with the sidebar hidden shows it with the search open.
  await page.keyboard.press('ControlOrMeta+B');
  await expect(nav(page)).toBeHidden();
  await page.keyboard.press('ControlOrMeta+K');
  await page.getByRole('combobox', { name: 'Search commands and sessions' }).fill('search sessions');
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Search sessions')).toBeFocused();
  await page.keyboard.press('Escape');
  await body();
  await page.keyboard.press('ControlOrMeta+N');
  // Paseo's new agent tab: in front, its composer focused.
  await expect(page.getByTestId('new-session-screen')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'New session' })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Message', { exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Close New session' }).click();
  await expect(page.getByTestId('new-session-screen')).toHaveCount(0);

  // Mod+, opens Settings and closes it again.
  await page.keyboard.press('ControlOrMeta+Comma');
  await expect(page.getByRole('region', { name: 'Settings' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Comma');
  await expect(page.getByRole('region', { name: 'Settings' })).toHaveCount(0);

  // The New session row shows its shortcut on hover, as Paseo's does.
  await nav(page).getByRole('button', { name: /^New session/ }).hover();
  await expect(nav(page).getByRole('button', { name: /^New session/ }).locator('kbd')).toBeVisible();
});

// Keep the real gateway/daemon, but hold the rename response so create completion cannot
// race ahead of React's selected/focus effects. A selected tree is not a finished draft.
test('a creating draft stays in front until its final rename response', async ({ page }) => {
  let release;
  let held;
  const intercepted = new Promise(resolve => { held = resolve; });
  await page.routeWebSocket('**/*', socket => {
    const server = socket.connectToServer();
    let rename;
    let captured = false;
    socket.onMessage(message => {
      const packet = JSON.parse(String(message));
      if (!captured && packet.method === 'session.rename') { captured = true; rename = packet.id; }
      server.send(message);
    });
    server.onMessage(message => {
      const packet = JSON.parse(String(message));
      if (rename !== undefined && packet.id === rename) {
        rename = undefined;
        release = () => socket.send(message);
        held();
      } else socket.send(message);
    });
  });
  await connect(page, world);
  const screen = page.getByTestId('new-session-screen');
  try {
    await nav(page).getByRole('button', { name: 'New session', exact: true }).click();
    await screen.getByLabel('Title (optional)').fill('Held create');
    await screen.getByRole('button', { name: 'Start session' }).click();
    await intercepted;
    // The header title can already be ready, but the in-flight draft owns the tab.
    await expect(heading(page, 'Held create')).toBeVisible();
    await expect(page.getByRole('tab', { name: 'New session' })).toHaveAttribute('aria-selected', 'true');
    await expect(screen.getByLabel('Title (optional)')).toBeDisabled();
  } finally { release?.(); }
  // Only the first rename is held; subsequent creates use the same real connection.
  await expect(screen).toBeHidden();
  await newSession(page, 'After held create');
  await expect(heading(page, 'After held create')).toBeVisible();
});
