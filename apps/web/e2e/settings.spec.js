// Settings that persist (docs/paseo-parity.md §3.3, §3.4): Default send and the theme survive a
// reload through localStorage, the access token never does, garbage in storage gives the defaults,
// and Reset goes back to them. Through the real UI, gateway and alpd.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const openSettings = async page => {
  await page.getByRole('button', { name: 'Settings' }).click();
  return page.getByRole('region', { name: 'Settings' });
};
const theme = page => page.evaluate(() => document.documentElement.dataset.theme);

test('Default send and the theme survive a reload; the token does not; garbage and Reset give the defaults', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await connect(page, world);
  let settings = await openSettings(page);
  await expect(settings.getByLabel('Default send')).toHaveValue('steer');
  await expect(settings).toContainText('Enter steers the active turn. Command/Ctrl+Enter queues.');
  await settings.getByLabel('Default send').selectOption('queue');
  await settings.getByTestId('settings-appearance').click();
  await expect(settings.getByTestId('theme-tile-system')).toHaveAttribute('aria-checked', 'true');
  expect(await theme(page)).toBe('dark');
  await settings.getByTestId('theme-tile-light').click();
  expect(await theme(page)).toBe('light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');

  // What storage holds: the versioned preferences; the token nowhere (the connect form keeps only
  // the gateway address, as before).
  const preferences = JSON.parse(await page.evaluate(() => localStorage.getItem('alp-web:preferences')));
  expect(preferences).toMatchObject({ v: 1, sendBehavior: 'queue', theme: 'light', chatDisplay: 'collapseTurns', newSession: {} });
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(stored).not.toContain(world.tokens.owner);
  expect(stored).not.toContain(world.tokens.owner.split('.').at(-1));

  // A reload: the token is gone (the connect form is empty), the preferences are not.
  await page.reload();
  await expect(page.getByLabel('Access token')).toHaveValue('');
  expect(await theme(page)).toBe('light');
  await connect(page, world);
  settings = await openSettings(page);
  await expect(settings.getByLabel('Default send')).toHaveValue('queue');
  await expect(settings).toContainText('Enter queues. Command/Ctrl+Enter submits.');
  await settings.getByTestId('settings-appearance').click();
  await expect(settings.getByTestId('theme-tile-light')).toHaveAttribute('aria-checked', 'true');

  // System follows the device.
  await settings.getByTestId('theme-tile-system').click();
  expect(await theme(page)).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => theme(page)).toBe('light');

  // Reset: the defaults, in the page and in storage.
  await settings.getByTestId('settings-general').click();
  await settings.getByRole('button', { name: 'Reset' }).click();
  await expect(settings.getByLabel('Default send')).toHaveValue('steer');
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('alp-web:preferences')))).toMatchObject({ v: 1, sendBehavior: 'steer', theme: 'system' });

  // Garbage in storage: the defaults, and the app still connects.
  await page.evaluate(() => localStorage.setItem('alp-web:preferences', '{"v":1,"sendBehavior":"sideways","theme":42'));
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  expect(await theme(page)).toBe('dark');
  await connect(page, world);
  settings = await openSettings(page);
  await expect(settings.getByLabel('Default send')).toHaveValue('steer');
});

const stored = page => page.evaluate(() => JSON.parse(localStorage.getItem('alp-web:preferences') ?? '{}'));

const css = (page, name) => page.evaluate(variable => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(), name);

test('Appearance as Paseo: theme tiles, fonts and sizes, content width Default / Wide / Full, highlight theme with a live preview', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await connect(page, world);
  let settings = await openSettings(page);
  await settings.getByTestId('settings-appearance').click();
  // Paseo's ThemePicker (v0.17.3): a tile per theme, System first, each previewed in its own colours.
  const picker = settings.getByRole('radiogroup', { name: 'Theme' });
  expect(await picker.getByRole('radio').evaluateAll(tiles => tiles.map(tile => tile.getAttribute('aria-label')))).toEqual(['System', 'Light', 'Dark', 'Zinc', 'Midnight', 'Claude', 'Ghostty', 'Pure black']);
  await expect(settings.getByTestId('theme-tile-midnight').locator('span[style]').first()).toHaveCSS('background-color', 'rgb(22, 24, 32)');
  for (const [value, background] of [['zinc', 'rgb(24, 24, 27)'], ['midnight', 'rgb(22, 24, 32)'], ['claude', 'rgb(31, 31, 30)'], ['ghostty', 'rgb(40, 44, 52)'], ['pureBlack', 'rgb(0, 0, 0)']]) {
    await settings.getByTestId(`theme-tile-${value}`).click();
    expect(await theme(page)).toBe(value);
    await expect(settings.getByTestId(`theme-tile-${value}`)).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('body')).toHaveCSS('background-color', background);
  }
  await page.screenshot({ path: test.info().outputPath('settings-appearance-pure-black.png') });

  // Fonts and sizes commit on blur or Enter, clamped to Paseo's limits.
  await settings.getByLabel('Interface font size').fill('16');
  await settings.getByLabel('Interface font size').press('Enter');
  await expect.poll(() => css(page, '--ui-scale')).toBe(String(16 / 14));
  await settings.getByLabel('Content font size').fill('99');
  await settings.getByLabel('Content font size').press('Enter');
  await expect(settings.getByLabel('Content font size')).toHaveValue('21');
  await expect.poll(() => css(page, '--content-font-size')).toBe('21px');
  await settings.getByLabel('Code font family').fill('"Fira Code", monospace');
  await settings.getByLabel('Code font family').blur();
  await expect.poll(() => css(page, '--app-font-mono')).toBe('"Fira Code", monospace');
  await settings.getByLabel('Code font size').fill('14');
  await settings.getByLabel('Code font size').press('Enter');
  await expect.poll(() => css(page, '--code-font-size')).toBe('14px');

  // Content width: Paseo's Default / Wide / Full.
  const maxWidth = () => page.evaluate(() => {
    const probe = Object.assign(document.createElement('div'), { className: 'max-w-(--content-width)' });
    document.body.append(probe);
    try { return getComputedStyle(probe).maxWidth; } finally { probe.remove(); }
  });
  await expect(settings.getByTestId('content-width-default')).toHaveAttribute('aria-checked', 'true');
  await expect(settings).toContainText('Width of chat, composer, and Markdown previews');
  await settings.getByTestId('content-width-wide').click();
  await expect.poll(() => css(page, '--content-width')).toBe('1200px');
  expect(await maxWidth()).toBe('1200px');
  await settings.getByTestId('content-width-full').click();
  await expect(settings.getByTestId('content-width-full')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => css(page, '--content-width')).toBe('none');
  expect(await maxWidth()).toBe('none');

  // The highlight theme colors the preview's code once the highlighter is in.
  await settings.getByLabel('Highlight theme').selectOption('dracula');
  const keyword = settings.getByTestId('appearance-preview').locator('pre span').filter({ hasText: /^export$/ });
  await expect(keyword).toHaveCSS('color', 'rgb(255, 121, 198)');
  expect(await stored(page)).toMatchObject({ theme: 'pureBlack', uiFontSize: 16, contentFontSize: 21, codeFontSize: 14, monoFontFamily: '"Fira Code", monospace', contentMaxWidth: 'full', syntaxTheme: 'dracula' });

  await page.reload();
  expect(await css(page, '--content-width')).toBe('none');
  await connect(page, world);
  settings = await openSettings(page);
  await settings.getByTestId('settings-appearance').click();
  // A custom width kept from before selects no preset and says so.
  await page.evaluate(() => { const value = JSON.parse(localStorage.getItem('alp-web:preferences')); localStorage.setItem('alp-web:preferences', JSON.stringify({ ...value, contentMaxWidth: 1100 })); });
  await page.reload();
  expect(await css(page, '--content-width')).toBe('1100px');
  await connect(page, world);
  settings = await openSettings(page);
  await settings.getByTestId('settings-appearance').click();
  await expect(settings).toContainText('Custom width · 1100 px');
  await expect(settings.getByTestId('content-width-options').getByRole('radio', { checked: true })).toHaveCount(0);
  await settings.getByTestId('content-width-default').click();
  await expect.poll(() => css(page, '--content-width')).toBe('820px');
  await settings.getByTestId('settings-general').click();
  await settings.getByRole('button', { name: 'Reset' }).click();
  expect(await theme(page)).toBe('dark');
  expect(await stored(page)).toMatchObject({ theme: 'system', uiFontSize: 14, contentMaxWidth: null, syntaxTheme: 'one' });
});

test('General, Chat, Terminal, Files and Sidebar pages hold Paseo 0.14\'s settings', async ({ page }) => {
  await connect(page, world);
  const settings = await openSettings(page);
  // General › Sending: Send shortcut and Default send with Interrupt.
  expect(await settings.getByLabel('Default send').locator('option').allTextContents()).toEqual(['Interrupt', 'Steer', 'Queue']);
  await settings.getByLabel('Send shortcut').selectOption('mod-enter');
  await settings.getByLabel('Default send').selectOption('interrupt');
  await expect(settings).toContainText('+Enter interrupts. Enter inserts a new line.');

  await settings.getByTestId('settings-chat').click();
  await expect(settings.getByLabel('Chat display')).toHaveValue('collapseTurns');
  expect(await settings.getByLabel('Chat display').locator('option').allTextContents()).toEqual(['Full', 'Collapse tool calls', 'Collapse turns']);
  await expect(settings.getByRole('switch', { name: 'Chat outline' })).toHaveAttribute('aria-checked', 'true');
  await settings.getByRole('switch', { name: 'Chat outline' }).click();
  await expect(settings.getByRole('switch', { name: 'Chat outline' })).toHaveAttribute('aria-checked', 'false');

  await settings.getByTestId('settings-terminal').click();
  await expect(settings.getByLabel('Terminal scrollback lines')).toHaveValue('10000');
  await settings.getByLabel('Terminal scrollback lines').fill('2000000');
  await settings.getByLabel('Terminal scrollback lines').press('Enter');
  await expect(settings.getByLabel('Terminal scrollback lines')).toHaveValue('1000000');

  await settings.getByTestId('settings-files').click();
  // ALP has no file-panel plugins: Files says what this token may do in the Files panel (t-a95b group C).
  await expect(settings.getByTestId('files-read-access')).toHaveText('No: this access token lacks files.read');
  await expect(settings.getByTestId('files-edit-access')).toHaveText('No');

  // Sidebar: hide History, move Search to the top, show the footer's Tasks row.
  await settings.getByRole('button', { name: 'Sidebar', exact: true }).click();
  // Not the host owner: New session, and no Schedules row (t-ff83).
  await expect(settings.getByTestId('sidebar-nav-item-new-session')).toContainText('New session');
  await expect(settings.getByTestId('sidebar-nav-item-schedules')).toHaveCount(0);
  await settings.getByTestId('sidebar-nav-item-history').getByRole('switch').click();
  await settings.getByRole('button', { name: 'Move Search up' }).click();
  await settings.getByRole('button', { name: 'Move Search up' }).click();
  await settings.getByTestId('sidebar-nav-item-tasks').getByRole('switch').click();
  expect(await stored(page)).toMatchObject({ sendShortcut: 'mod-enter', sendBehavior: 'interrupt', chatOutline: false, terminalScrollback: 1_000_000,
    sidebar: { header: [{ id: 'search', visible: true }, { id: 'new-session', visible: true }, { id: 'history', visible: false }, { id: 'schedules', visible: true }], footer: [{ id: 'tasks', visible: true }] } });
  await settings.getByRole('button', { name: 'Back' }).click();
  const nav = page.getByRole('navigation', { name: 'Workspaces and sessions' });
  await expect(nav.getByTestId('sidebar-history')).toHaveCount(0);
  await expect(nav.getByTestId('sidebar-footer-items').getByTestId('sidebar-tasks')).toBeVisible();
  await nav.getByTestId('sidebar-tasks').click();
  await expect(page.getByTestId('alp-tasks-screen')).toBeVisible();
  await expect(nav.getByTestId('sidebar-tasks')).toHaveAttribute('aria-current', 'page');
  await page.evaluate(() => localStorage.removeItem('alp-web:preferences'));
});

test('Diagnostics runs, shows and copies what this browser sees, without the token; About and Host › Terminals', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await connect(page, world);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-diagnostics').click();
  await settings.getByTestId('settings-diagnostics-run').click();
  await expect(settings.getByTestId('diagnostics-gateway')).toHaveText(world.gatewayUrl);
  await expect(settings.getByTestId('diagnostics-state')).toHaveText('open');
  await settings.getByTestId('settings-diagnostics-copy').click();
  await expect(settings.getByTestId('settings-diagnostics-copy')).toHaveText('Copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('ALP web diagnostics');
  expect(copied).toContain('## Connection');
  expect(copied).not.toContain(world.tokens.owner);
  expect(copied).not.toContain(world.tokens.owner.split('.').at(-1));

  await settings.getByTestId('settings-about').click();
  await expect(settings.getByTestId('settings-whats-new')).toHaveAttribute('href', 'https://github.com/phucanh08/alp/releases');
  await expect(settings.getByTestId('connected-host-version')).toHaveText(/^v/);

  await settings.getByTestId('settings-terminals').click();
  await expect(settings.getByTestId('terminals-host')).toContainText('Not allowed');
  await expect(settings).toContainText('alp terminal allow --yes');
});

test('Settings › Projects registers a granted directory; Workspaces renames and pins it for the sidebar too', async ({ page }) => {
  await connect(page, world, world.tokens.registryWriter);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-projects').click();
  await settings.getByLabel('Directory to register').selectOption(world.projects.main);
  await settings.getByRole('button', { name: 'Register', exact: true }).click();
  await expect(settings.getByTestId('project-registered').first()).toHaveText('Registered');

  await settings.getByTestId('settings-workspaces').click();
  const row = settings.getByTestId('settings-workspace-row').first();
  await expect(row).toContainText(world.projects.main);
  await row.getByRole('button', { name: /^Rename workspace/ }).click();
  await row.getByLabel(/^New name for/).fill('Storefront');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row).toContainText('Storefront');
  await row.getByRole('button', { name: 'Pin workspace Storefront' }).click();
  await expect(row.getByRole('button', { name: 'Unpin workspace Storefront' })).toHaveAttribute('aria-pressed', 'true');

  // The sidebar follows: the project, renamed, sits in Paseo's Pinned section.
  await settings.getByRole('button', { name: 'Back' }).click();
  const pinned = page.getByTestId('sidebar-pinned');
  await expect(pinned).toContainText('Storefront');
  await expect(pinned.getByTestId('sidebar-project')).toHaveAttribute('data-pinned', 'true');
});

test('a token without workspace.write sees Workspaces read only', async ({ page }) => {
  await connect(page, world);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-workspaces').click();
  await expect(settings).toContainText('Read only');
  for (const button of await settings.getByRole('button', { name: /^(Pin|Unpin|Rename) workspace/ }).all()) await expect(button).toBeDisabled();
});

test('Host pages: a builtin library entry reads without an error, the open project says Current', async ({ page }) => {
  await connect(page, world, world.tokens.libraryWriter);
  const settings = await openSettings(page);
  await settings.getByTestId('settings-alp-agents').click();
  await settings.getByTestId('library-row-main').click();
  await expect(settings.getByTestId('library-entry')).toBeVisible();
  await expect(settings.getByRole('alert')).toHaveCount(0);
  // The editor stays on a new project entry: a builtin is read, not edited.
  await expect(settings.getByText('New project instructions')).toBeVisible();

  await settings.getByTestId('settings-projects').click();
  await expect(settings.getByTestId('project-current')).toHaveText('Current');

});

// t-a95b (docs/breaking-changes.md): Voice, Pair device, Plugins and Metadata are not Settings pages any more;
// the host pages moved to settings/HostPages.tsx still render. This gateway is a standalone
// alp-gateway, never a host owner, so Usage keeps its old panel.
test('Settings has no Voice, Pair device, Plugins or Metadata page, and Usage still renders', async ({ page }) => {
  await connect(page, world);
  const settings = await openSettings(page);
  const nav = settings.getByTestId('settings-sidebar');
  await expect(nav.getByTestId('settings-usage')).toBeVisible();
  for (const id of ['voice', 'pair-device', 'plugins', 'metadata']) await expect(settings.getByTestId(`settings-${id}`)).toHaveCount(0);
  for (const label of ['Voice', 'Pair device', 'Plugins', 'Metadata']) await expect(nav.getByRole('button', { name: label, exact: true })).toHaveCount(0);
  await nav.getByTestId('settings-usage').click();
  await expect(settings.getByTestId('settings-detail-header-title')).toHaveText('Usage');
  await expect(settings).toContainText('Usage and limits is not available in this beta');
  await expect(settings).toContainText('Account-wide on the host; check with alp usage there.');
});

test.describe('Host › Terminals on a host that allows terminals', () => {
  /** @type {Awaited<ReturnType<typeof startWorld>>} */
  let terminals;
  test.beforeAll(async () => { terminals = await startWorld({ terminal: true }); });
  test.afterAll(async () => { await terminals?.close(); });

  test('an unregistered workspace says how to get a terminal: register it, or ask the owner', async ({ page }) => {
    // terminal.exec without workspace.write: the owner has to register the workspace.
    await connect(page, terminals, terminals.tokens.terminal);
    const settings = await openSettings(page);
    await settings.getByTestId('settings-terminals').click();
    await expect(settings.getByTestId('terminals-workspace')).toContainText('Not available');
    await expect(settings).toContainText('ask the host owner to register it');
    await expect(settings.getByTestId('terminals-register')).toHaveCount(0);
  });
});
