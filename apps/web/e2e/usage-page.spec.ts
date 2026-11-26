// Settings › Usage as Paseo's Usage page (t-9116), for the host owner (alp dashboard's own link):
// "Plan usage" with Refresh all and the settings cog (Check usage, Summary in sidebar,
// Percentages), one card per provider with its plan, refresh and on/off switch, window rows that pin
// to the sidebar summary, details, balances and account; Check usage off shows Turn on. The sidebar
// footer summary follows the pins, Percentages and the cards' switches.
//
// Real alpd, dashboard and fake Codex. daemon.usage and host.usage.setting.get/set are answered by
// this spec in the page's WebSocket (fixture data: real usage needs real provider accounts; the
// setting is the host's, implemented beside this page).
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { startWorld } from './support/world.ts';
import type { World } from './support/world.ts';
import { closeWorldAfter } from './support/cleanup.ts';
import { dashboardSettings, startDashboard } from './support/dashboard.ts';
import type { Dashboard } from './support/dashboard.ts';

const SHOT_DIR = process.env.ALP_WEB_USAGE_SHOT_DIR;
const HOST = 'test-host.local';

// Wall-clock independent (t-80ad): the page's clock is frozen at a known instant in a pinned zone and
// locale, and every resetsAt is built from that instant, so each reset label is exact. A reset on the
// same calendar day shows only the time ("3:46 PM"); one past midnight names the day ("Thu 12:46 AM").
test.use({ timezoneId: 'UTC', locale: 'en-US' });
/** Wednesday 2026-11-18, noon UTC: every reset under a day away stays on the same calendar day. */
const NOON = Date.parse('2026-11-18T12:00:00.000Z');
/** The same Wednesday, 21:00 UTC: the 3h 46m session reset falls on Thursday. */
const EVENING = Date.parse('2026-11-18T21:00:00.000Z');

let world: World;
let dashboard: Dashboard;

test.beforeAll(async () => {
  test.setTimeout(240_000);
  world = await startWorld({ settings: await dashboardSettings() });
  dashboard = await startDashboard(world);
});
test.afterAll(async () => {
  if (world) await closeWorldAfter(world, async () => { await dashboard?.stop(); });
});

const minutes = (now: number, count: number) => new Date(now + count * 60_000 + 30_000).toISOString();

/** The providers as the screenshot's: Claude Max 5x (Session, Weekly, Weekly · Fable; Extra usage), Codex plus (5-hour, Weekly; Credits).
 * now: the page's frozen clock */
function providers(now: number) {
  const checkedAt = new Date(now).toISOString();
  return [
    {
      runtime: 'claude', available: true, checkedAt, plan: 'max', planLabel: 'Max 5x', limited: false, pause: null, parked: 0,
      windows: [
        { name: 'five_hour', id: 'five_hour', label: 'Session', usedPercent: 4, resetsAt: minutes(now, 226) },
        { name: 'seven_day', id: 'weekly', label: 'Weekly', usedPercent: 20, resetsAt: minutes(now, 4 * 1440 + 6 * 60) },
        { name: 'seven_day_fable', id: 'weekly:fable', label: 'Weekly · Fable', usedPercent: 2, resetsAt: minutes(now, 4 * 1440 + 6 * 60) },
      ],
      details: [{ id: 'extra_usage', label: 'Extra usage', value: 'Enabled' }],
      account: { email: 'claude-user@example.com' },
    },
    {
      runtime: 'codex', available: true, checkedAt, plan: 'plus', planLabel: 'plus', limited: false, pause: null, parked: 0,
      windows: [
        { name: 'five_hour', id: 'five_hour', label: '5-hour', usedPercent: 4, resetsAt: minutes(now, 230) },
        { name: 'weekly', id: 'weekly', label: 'Weekly', usedPercent: 66, resetsAt: minutes(now, 3 * 1440 + 8 * 60) },
      ],
      balances: [{ id: 'credits', label: 'Credits', remaining: 0, unlimited: false }],
      account: { email: 'codex-user@example.com' },
    },
  ];
}

/** Answers daemon.usage and the Check usage setting in the page's socket; the rest goes to the real gateway.
 * now: the page's frozen clock */
async function intercept(page: Page, now: number) {
  // any: JSON-RPC requests the page sent, parsed from the socket.
  const state = { enabled: true, sent: [] as any[] };
  await page.routeWebSocket(() => true, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      // any: a JSON-RPC request the page sent, parsed from the socket.
      let request: any;
      try { request = JSON.parse(String(message)); } catch {}
      const answer = (result: object) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
      if (request?.method) state.sent.push(request);
      if (request?.method === 'daemon.usage') return answer(state.enabled ? { providers: providers(now) } : { disabled: true, providers: [] });
      if (request?.method === 'host.usage.setting.get') return answer({ enabled: state.enabled, host: HOST });
      if (request?.method === 'host.usage.setting.set') { state.enabled = request.params.enabled === true; return answer({ enabled: state.enabled, host: HOST }); }
      server.send(message);
    });
    server.onMessage(message => socket.send(message));
  });
  return state;
}

async function openUsage(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  await settings.getByTestId('settings-usage').click();
  return settings;
}

const card = (settings: Locator, runtime: string) => settings.locator(`[data-testid="usage-provider"][data-runtime="${runtime}"]`);
const row = (settings: Locator, runtime: string, id: string) => card(settings, runtime).locator(`[data-testid="usage-window"][data-window-id="${id}"]`);
const summary = (page: Page, runtime: string) => page.getByTestId('sidebar-usage-line').locator(`[data-runtime="${runtime}"]`);

test('owner › Usage: Paseo\'s cards, options, pins and card switches, and the sidebar summary they drive', async ({ page }) => {
  test.setTimeout(150_000);
  await page.clock.setFixedTime(NOON);
  const state = await intercept(page, NOON);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(dashboard.url);
  await expect(page.locator('main header')).toBeVisible();

  // The sidebar summary before Settings opens: Paseo's default pins (5-hour and weekly), used.
  await expect(summary(page, 'claude')).toHaveText('4% 5h20% wk');
  await expect(summary(page, 'codex')).toHaveText('4% 5h66% wk');
  if (SHOT_DIR) {
    await mkdir(SHOT_DIR, { recursive: true });
    await page.getByTestId('sidebar-column').screenshot({ path: `${SHOT_DIR}/sidebar-summary-default.png` });
  }

  const settings = await openUsage(page);
  await expect(settings.getByRole('heading', { name: 'Plan usage' })).toBeVisible();
  await expect(settings.getByTestId('usage-provider')).toHaveCount(2);
  await expect(card(settings, 'claude').getByTestId('usage-plan')).toHaveText('Max 5x');
  await expect(card(settings, 'codex').getByTestId('usage-plan')).toHaveText('plus');
  await expect(row(settings, 'claude', 'five_hour')).toContainText('Session');
  await expect(row(settings, 'claude', 'five_hour').getByTestId('usage-window-value')).toHaveText('4% used');
  await expect(row(settings, 'claude', 'five_hour')).toContainText(/resets in 3h 46m · 3:46\sPM$/);
  await expect(row(settings, 'claude', 'weekly')).toContainText(/resets in 4d 6h · Sun 6:00\sPM$/);
  await expect(row(settings, 'claude', 'weekly:fable')).toContainText('Weekly · Fable');
  await expect(card(settings, 'claude').getByTestId('usage-detail')).toHaveText('Extra usageEnabled');
  await expect(card(settings, 'codex').getByTestId('usage-balance')).toHaveText('Credits0 left');
  await expect(card(settings, 'claude').getByTestId('usage-account')).toHaveText('claude-user@example.com');
  await expect(card(settings, 'codex').getByTestId('usage-account')).toHaveText('codex-user@example.com');
  // The bar: its share and Paseo's tone colour (66% used is under 70%: success).
  await expect(row(settings, 'codex', 'weekly').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '66');
  await expect(row(settings, 'codex', 'weekly').getByTestId('usage-window-fill')).toHaveCSS('background-color', 'rgb(108, 177, 123)');
  // Pinned rows show a filled pin: the defaults.
  await expect(row(settings, 'claude', 'five_hour')).toHaveAttribute('aria-checked', 'true');
  await expect(row(settings, 'claude', 'weekly:fable')).toHaveAttribute('aria-checked', 'false');

  // The cog: Check usage (the host's), Summary in sidebar, Percentages.
  await settings.getByTestId('usage-options-menu').click();
  const options = page.getByTestId('usage-options-surface');
  await expect(options).toContainText('Check usage');
  await expect(options).toContainText(`Applies to ${HOST} on every device`);
  await expect(options).toContainText('Pinned windows show in the sidebar footer');
  await expect(options.getByTestId('usage-check-usage')).toHaveAttribute('aria-checked', 'true');
  await options.getByTestId('usage-display-remaining').click();
  await expect(options.getByTestId('usage-display-remaining')).toHaveAttribute('aria-checked', 'true');
  await expect(row(settings, 'codex', 'five_hour').getByTestId('usage-window-value')).toHaveText('96% left');
  await expect(row(settings, 'codex', 'weekly').getByTestId('usage-window-value')).toHaveText('34% left');
  await expect(summary(page, 'codex')).toHaveText('96% 5h34% wk');
  if (SHOT_DIR) {
    await mkdir(SHOT_DIR, { recursive: true });
    await page.mouse.move(0, 0);
    await settings.screenshot({ path: `${SHOT_DIR}/usage-popover-open.png` });
  }
  // Escape closes the popover, not Settings.
  await page.keyboard.press('Escape');
  await expect(options).toHaveCount(0);
  await expect(settings).toBeVisible();
  if (SHOT_DIR) {
    await page.mouse.move(0, 0);
    await settings.screenshot({ path: `${SHOT_DIR}/usage-popover-closed.png` });
    await page.screenshot({ path: `${SHOT_DIR}/usage-page-full.png` });
  }

  // The whole row pins: Fable's weekly joins the summary, Claude's session leaves it.
  await row(settings, 'claude', 'weekly:fable').click();
  await expect(row(settings, 'claude', 'weekly:fable')).toHaveAttribute('aria-checked', 'true');
  await row(settings, 'claude', 'five_hour').click();
  await expect(row(settings, 'claude', 'five_hour')).toHaveAttribute('aria-checked', 'false');
  await expect(summary(page, 'claude')).toHaveText('80% wk98% Fable wk');

  // A card turned off collapses to its header and leaves the summary.
  await card(settings, 'codex').getByTestId('usage-card-switch-codex').click();
  await expect(card(settings, 'codex').getByTestId('usage-window')).toHaveCount(0);
  await expect(card(settings, 'codex').getByTestId('usage-plan')).toHaveCount(0);
  await expect(summary(page, 'codex')).toHaveCount(0);

  // Per-card refresh: daemon.usage refreshes every provider; the spinner is that card's.
  const before = state.sent.filter(request => request.method === 'daemon.usage' && request.params?.refresh === true).length;
  await card(settings, 'claude').getByTestId('usage-refresh').click();
  await expect.poll(() => state.sent.filter(request => request.method === 'daemon.usage' && request.params?.refresh === true).length).toBe(before + 1);

  // Summary in sidebar off: no footer summary, and rows no longer pin.
  await settings.getByTestId('usage-options-menu').click();
  await options.getByTestId('usage-show-in-sidebar').click();
  await expect(page.getByTestId('sidebar-usage-line')).toHaveCount(0);
  await expect(settings.getByTestId('usage-pin-glyph-pinned')).toHaveCount(0);
  await expect(row(settings, 'claude', 'weekly')).not.toHaveAttribute('role', 'checkbox');
  await options.getByTestId('usage-show-in-sidebar').click();
  await expect(summary(page, 'claude')).toHaveText('80% wk98% Fable wk');
  await page.keyboard.press('Escape');

  // Kept in this browser: a reload keeps Remaining, the pins and the card switch.
  await page.reload();
  await expect(page.locator('main header')).toBeVisible();
  await expect(summary(page, 'claude')).toHaveText('80% wk98% Fable wk');
  await expect(summary(page, 'codex')).toHaveCount(0);
  if (SHOT_DIR) await page.getByTestId('sidebar-column').screenshot({ path: `${SHOT_DIR}/sidebar-summary-pinned-remaining.png` });
  const again = await openUsage(page);
  await expect(row(again, 'claude', 'weekly').getByTestId('usage-window-value')).toHaveText('80% left');
  await again.getByTestId('usage-card-switch-codex').click();
  await expect(summary(page, 'codex')).toHaveText('96% 5h34% wk');

  // Check usage off (the host's setting): Paseo's off view; Turn on brings the cards back.
  await again.getByTestId('usage-options-menu').click();
  await page.getByTestId('usage-options-surface').getByTestId('usage-check-usage').click();
  await expect.poll(() => state.sent.some(request => request.method === 'host.usage.setting.set' && request.params?.enabled === false)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(again.getByTestId('usage-off')).toContainText(`Usage is off on ${HOST}.`);
  // The sidebar summary follows at once, not at its next 60 s read (t-9116).
  await expect(page.getByTestId('sidebar-usage-line')).toHaveCount(0, { timeout: 2_000 });
  await expect(again.getByTestId('usage-refresh-all')).toHaveCount(0);
  await expect(again.getByTestId('usage-provider')).toHaveCount(0);
  if (SHOT_DIR) await again.screenshot({ path: `${SHOT_DIR}/usage-off.png` });
  await again.getByTestId('usage-turn-on').click();
  await expect(again.getByTestId('usage-provider')).toHaveCount(2);
  await expect(summary(page, 'codex')).toHaveText('96% 5h34% wk', { timeout: 2_000 });
  expect(state.enabled).toBe(true);
});

test('owner › Usage on a host without the Check usage setting: no switch, the cards still show', async ({ page }) => {
  await page.clock.setFixedTime(EVENING);
  await page.routeWebSocket(() => true, socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => {
      let request;
      try { request = JSON.parse(String(message)); } catch {}
      if (request?.method === 'daemon.usage') { socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { providers: providers(EVENING).map(({ planLabel, details, balances, account, ...rest }) => ({ ...rest, windows: rest.windows.map(({ name, usedPercent, resetsAt }) => ({ name, usedPercent, resetsAt })) })) } })); return; }
      if (request?.method === 'host.usage.setting.get') { socket.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } })); return; }
      server.send(message);
    });
    server.onMessage(message => socket.send(message));
  });
  await page.goto(dashboard.url);
  await expect(page.locator('main header')).toBeVisible();
  const settings = await openUsage(page);
  // An older host: plan from `plan`, windows named from `name`, no details, balances or account.
  await expect(card(settings, 'claude').getByTestId('usage-plan')).toHaveText('max');
  await expect(row(settings, 'claude', 'five_hour')).toContainText('5-hour');
  // A reset past midnight names its day (the 21:00 clock puts the 3h 46m reset on Thursday).
  await expect(row(settings, 'claude', 'five_hour')).toContainText(/resets in 3h 46m · Thu 12:46\sAM$/);
  await expect(row(settings, 'claude', 'seven_day')).toContainText('Weekly');
  await expect(card(settings, 'claude').getByTestId('usage-account')).toHaveCount(0);
  await settings.getByTestId('usage-options-menu').click();
  const options = page.getByTestId('usage-options-surface');
  await expect(options).toContainText('Summary in sidebar');
  await expect(options.getByTestId('usage-check-usage')).toHaveCount(0);
});
