// Real temporary daemon/gateway/PTY coverage. No user home or fixed service ports.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { connect as hostConnect } from '@anhlp/alp-client';
import { AlpRpcClient, hello } from '@anhlp/alp-client/portable';
import { openGateway } from '../src/lib/gateway.js';
import { startWorld, REPOSITORY } from './support/world.js';
import { connect, newSession } from './support/app.js';

let world;
let token;
const run = promisify(execFile);
test.beforeAll(async () => {
  world = await startWorld({ terminal: true });
  const owner = await hostConnect(world.socket);
  try {
    for (const directory of [world.projects.main, world.projects.custom]) {
      const { revision } = await owner.request('project.list', {});
      await owner.request('project.register', { directory, ifRevision: revision, requestId: `tabs-${path.basename(directory)}` });
    }
  } finally { owner.close(); }
  const { stdout } = await run(process.execPath, [path.join(REPOSITORY, 'apps/gateway/src/cli.js'), 'credential', 'create', '--label', 'terminal-tabs', '--workspace', world.projects.main, '--workspace', world.projects.custom,
    ...['session.read', 'session.write', 'project.read', 'project.write', 'session.team.write', 'terminal.exec'].flatMap(p => ['--permission', p]), '--json'],
  { env: { ...process.env, ALP_HOME: world.home, ALP_GATEWAY_HOME: path.join(world.directory, 'gateway') } });
  token = JSON.parse(stdout).token;
  // The fixture started its gateway before this extra credential was created.
  await world.restartGateway();
});
test.afterAll(async () => { await world?.close(); });
const panel = page => page.locator('[data-testid="terminal-panel"]:visible');
const screen = page => panel(page).getByTestId('terminal-screen');
const rows = page => screen(page).locator('.xterm-rows');
async function line(page, text) { await screen(page).click(); await page.keyboard.type(text); await page.keyboard.press('Enter'); }
async function open(page) {
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-status', 'running');
}
async function list() {
  const { transport } = await openGateway({ url: world.gatewayUrl, token });
  const remote = new AlpRpcClient(transport);
  try { await hello(remote); return (await remote.request('terminal.list', {})).terminals; } finally { remote.close(); }
}
async function dismiss(page) {
  const notice = panel(page).getByTestId('terminal-notice');
  if (await notice.isVisible()) await notice.getByRole('button', { name: 'Got it' }).click();
}

test('independent terminal tabs survive settings, search, links, workspace switch, reload and reconnect', async ({ page, context }) => {
  test.setTimeout(180_000);
  await connect(page, world, token);
  await open(page);
  await dismiss(page);
  await line(page, 'echo FIRST-$((11*11))');
  await expect(rows(page)).toContainText('FIRST-121');
  const firstKey = await panel(page).getAttribute('data-terminal-key');
  const firstIds = (await list()).map(t => t.terminalId);
  expect(firstIds).toHaveLength(1);
  await page.getByRole('button', { name: 'Add terminal', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-status', 'running');
  await dismiss(page);
  const secondKey = await panel(page).getAttribute('data-terminal-key');
  expect(secondKey).not.toBe(firstKey);
  await line(page, 'echo SECOND-$((12*12))');
  await expect(rows(page)).toContainText('SECOND-144');
  await expect(rows(page)).not.toContainText('FIRST-121');
  const originalIds = (await list()).map(t => t.terminalId).sort();
  expect(originalIds).toHaveLength(2);

  // Change real xterm metrics and theme without replacing either shell.
  await page.getByLabel('Terminal font', { exact: true }).selectOption('consolas');
  await page.getByLabel('Terminal font size', { exact: true }).selectOption('16');
  await page.getByLabel('Terminal theme', { exact: true }).selectOption('light');
  await expect(screen(page).locator('.xterm-rows')).toHaveCSS('font-size', '16px');
  await expect(screen(page).locator('.xterm-scrollable-element')).toHaveCSS('background-color', 'rgb(246, 248, 247)');
  expect((await list()).map(t => t.terminalId).sort()).toEqual(originalIds);

  // SearchAddon selects actual buffer matches; next/previous moves the rendered selection.
  await line(page, "clear; printf 'HIT-%s\\nHIT-%s\\n' $((123)) $((123))");
  await expect(rows(page)).toContainText('HIT-123');
  await panel(page).getByRole('textbox', { name: 'Search terminal', exact: true }).fill('HIT-123');
  await panel(page).getByRole('button', { name: 'Next terminal match' }).click();
  await expect(panel(page).getByRole('status', { name: 'Terminal search result' })).toHaveText('Match selected');
  const selection = screen(page).locator('.xterm-selection div').first();
  // xterm6 emits a first-row rectangle plus an empty middle-row rectangle.
  await expect(selection).toBeVisible();
  const firstMatch = await selection.boundingBox();
  await panel(page).getByRole('button', { name: 'Next terminal match' }).click();
  await expect.poll(async () => (await selection.boundingBox()).y).not.toBe(firstMatch.y);
  await panel(page).getByRole('button', { name: 'Previous terminal match' }).click();
  await expect.poll(async () => (await selection.boundingBox()).y).toBe(firstMatch.y);
  await panel(page).getByRole('textbox', { name: 'Search terminal', exact: true }).fill('missing-value');
  await panel(page).getByRole('button', { name: 'Next terminal match' }).click();
  await expect(panel(page).getByRole('status', { name: 'Terminal search result' })).toHaveText('No matches');

  // Click a link recognized by WebLinksAddon; a controlled local route avoids external traffic.
  await context.route('https://example.test/alp-terminal', route => route.fulfill({ body: '<title>Terminal link</title>linked' }));
  await line(page, "clear; printf 'https://example.test/%s\\n' alp-terminal");
  const linkRow = rows(page).locator('div').filter({ hasText: /^https:\/\/example\.test\/alp-terminal\s*$/ }).last();
  await expect(linkRow).toBeVisible();
  const box = await linkRow.boundingBox();
  await page.mouse.move(box.x + 24, box.y + box.height / 2);
  const popupPromise = page.waitForEvent('popup');
  await page.mouse.click(box.x + 24, box.y + box.height / 2);
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toBe('https://example.test/alp-terminal');
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  await popup.close();

  // Stable shell identity and content on selecting a sibling.
  await page.getByRole('tab', { name: 'Shell 1', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-terminal-key', firstKey);
  await expect(rows(page)).toContainText('FIRST-121');
  await line(page, 'echo WORKSPACE-$((13*13))');
  await expect(rows(page)).toContainText('WORKSPACE-169');
  await page.getByTestId('project-row').filter({ hasText: 'plain' }).click();
  await open(page);
  await dismiss(page);
  await line(page, 'echo OTHER-$((14*14))');
  await expect(rows(page)).toContainText('OTHER-196');
  await page.getByRole('tab', { name: 'Terminal', exact: true }).press('Delete');
  await page.getByTestId('project-row').filter({ hasText: 'shop' }).click();
  await expect(panel(page)).toHaveAttribute('data-terminal-key', firstKey);
  await expect(rows(page)).toContainText('WORKSPACE-169');
  await expect.poll(async () => (await list()).filter(t => t.state === 'running').map(t => t.terminalId).sort()).toEqual(originalIds);

  // Reload reattaches both tabs; the selected key and app preferences persist.
  await page.getByRole('tab', { name: 'Shell 2', exact: true }).click();
  await page.reload();
  await connect(page, world, token);
  await expect(panel(page)).toHaveAttribute('data-terminal-key', secondKey);
  await expect(panel(page)).toHaveAttribute('data-status', 'running');
  await expect(page.getByLabel('Terminal font', { exact: true })).toHaveValue('consolas');
  await expect(page.getByLabel('Terminal font size', { exact: true })).toHaveValue('16');
  await expect(page.getByLabel('Terminal theme', { exact: true })).toHaveValue('light');
  await expect.poll(async () => (await list()).filter(t => t.state === 'running').map(t => t.terminalId).sort()).toEqual(originalIds);
  await world.restartGateway();
  await expect(panel(page)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
  await line(page, 'echo RECONNECTED-$((15*15))');
  await expect(rows(page)).toContainText('RECONNECTED-225');
  await page.getByRole('tab', { name: 'Shell 1', exact: true }).click();
  await expect(rows(page)).toContainText('WORKSPACE-169');
  await line(page, 'echo SIBLING-$((16*16))');
  await expect(rows(page)).toContainText('SIBLING-256');

  // Resize each independently; close one and prove the survivor still accepts input.
  const originalSize = (await list()).find(t => t.terminalId === firstIds[0]);
  await page.setViewportSize({ width: 1000, height: 600 });
  await expect.poll(async () => {
    const now = (await list()).find(t => t.terminalId === firstIds[0]);
    return now.cols < originalSize.cols && now.rows < originalSize.rows;
  }).toBe(true);
  const resized = (await list()).find(t => t.terminalId === firstIds[0]);
  await page.getByRole('tab', { name: 'Shell 2', exact: true }).click();
  await expect.poll(async () => {
    const sibling = (await list()).find(t => t.terminalId !== firstIds[0] && t.state === 'running');
    return { cols: sibling.cols, rows: sibling.rows };
  }).toEqual({ cols: resized.cols, rows: resized.rows });
  await page.getByRole('tab', { name: 'Shell 1', exact: true }).click();
  await line(page, 'echo SIZE=$(stty size)');
  await expect(rows(page)).toContainText(/SIZE=\d+ \d+/);
  await page.getByRole('button', { name: 'Close shell 2', exact: true }).click();
  await expect(page.getByRole('tab', { name: /^Shell / })).toHaveCount(1);
  await line(page, 'echo SURVIVED-$((17*17))');
  await expect(rows(page)).toContainText('SURVIVED-289');
  await expect.poll(async () => (await list()).filter(t => t.state === 'running').map(t => t.terminalId)).toEqual(firstIds);
  await page.getByRole('button', { name: 'Add terminal', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-status', 'running');
  expect(await panel(page).getAttribute('data-terminal-key')).not.toBe(secondKey);
  await expect.poll(async () => (await list()).filter(t => t.state === 'running').length).toBe(2);
  // Closing the parent must end both live shells, including the inactive sibling.
  await page.getByRole('tab', { name: 'Terminal', exact: true }).press('Delete');
  await expect.poll(async () => (await list()).filter(t => t.state === 'running').length).toBe(0);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 700 }, { width: 320, height: 568 }]) {
  test.describe(`terminal and global notice ${viewport.width}`, () => {
    test.use({ viewport, isMobile: viewport.width < 768, hasTouch: viewport.width < 768 });
    test('terminal controls and screen remain above the timed notice', async ({ page }) => {
      await page.clock.install();
      await connect(page, world, token);
      await newSession(page, `Terminal notice ${viewport.width}`, { from: page.getByRole('main').getByRole('button', { name: 'New session', exact: true }) });
      await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 1000));
      await page.getByTestId('session-model').click();
      await page.getByRole('menuitemradio', { name: 'codex · GPT-5.6-Terra', exact: true }).click();
      const notice = page.getByRole('status').filter({ hasText: /^Changed:/ });
      await expect(notice).toBeVisible();
      // Terminal create and attach need timers while the global notice is held visible.
      await page.clock.resume();
      await open(page);
      await page.clock.pauseAt(new Date(await page.evaluate(() => Date.now()) + 100));
      await expect(notice).toBeVisible();
      await expect(panel(page).getByTestId('terminal-notice')).toBeVisible();
      const [shell, toast, host] = await Promise.all([panel(page).boundingBox(), notice.boundingBox(), screen(page).boundingBox()]);
      expect(shell.y + shell.height).toBeLessThanOrEqual(toast.y);
      expect(host.height).toBeGreaterThan(24);
      expect(toast.y + toast.height).toBeLessThanOrEqual(viewport.height);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
      await page.screenshot({ path: test.info().outputPath(`terminal-full-notice-${viewport.width}.png`) });
      await dismiss(page);
      await page.getByLabel('Terminal theme', { exact: true }).selectOption('light');
      await panel(page).getByRole('textbox', { name: 'Search terminal', exact: true }).fill('still usable');
      await expect(notice).toBeVisible();
      await expect(panel(page).getByRole('textbox', { name: 'Search terminal', exact: true })).toBeFocused();
      // Every toolbar target must have its own hit area, including the shell close and +.
      const targets = [page.getByRole('tab', { name: 'Shell 1', exact: true }), page.getByRole('button', { name: 'Close shell 1', exact: true }), page.getByRole('button', { name: 'Add terminal', exact: true }),
        page.getByLabel('Terminal font', { exact: true }), page.getByLabel('Terminal font size', { exact: true }), page.getByLabel('Terminal theme', { exact: true })];
      const boxes = await Promise.all(targets.map(target => target.boundingBox()));
      for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
        const one = boxes[a], two = boxes[b];
        expect(one.x + one.width <= two.x || two.x + two.width <= one.x || one.y + one.height <= two.y || two.y + two.height <= one.y, `toolbar targets ${a}/${b} overlap`).toBe(true);
      }
      const add = page.getByRole('button', { name: 'Add terminal', exact: true });
      if (viewport.width < 768) await add.tap({ timeout: 1500 }); else await add.click({ timeout: 1500 });
      await expect(page.getByRole('tab', { name: /^Shell / })).toHaveCount(2);
      await expect(panel(page)).toHaveAttribute('data-status', 'running');
      const close = page.getByRole('button', { name: 'Close shell 2', exact: true });
      if (viewport.width < 768) await close.tap({ timeout: 1500 }); else await close.click({ timeout: 1500 });
      await expect(page.getByRole('tab', { name: /^Shell / })).toHaveCount(1);
      await expect(page.getByRole('tab', { name: 'Shell 1', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(notice).toBeVisible();
      await page.screenshot({ path: test.info().outputPath(`terminal-notice-${viewport.width}.png`) });
      await page.clock.runFor(8000);
      await expect(notice).toBeHidden();
      await page.clock.resume();
      await page.getByRole('tab', { name: 'Terminal', exact: true }).press('Delete');
      await expect.poll(async () => (await list()).filter(item => item.state === 'running').length).toBe(0);
    });
  });
}

test('terminal directory events show external shells without stealing their stream, and reset after reconnect', async ({ page }) => {
  await connect(page, world, token);
  await open(page);
  await dismiss(page);
  const { transport } = await openGateway({ url: world.gatewayUrl, token });
  const remote = new AlpRpcClient(transport);
  try {
    const greeting = await hello(remote);
    expect(greeting.capabilities).toContain('terminal.watch');
    const { workspaces } = await remote.request('workspace.list', {});
    const workspaceId = workspaces.find(workspace => workspace.directory === world.projects.main || workspace.canonical === world.projects.main).id;
    const { terminal } = await remote.request('terminal.create', { workspaceId, cols: 80, rows: 24, requestId: 'external-list' });
    const output = [];
    remote.onNotification((method, event) => { if (method === 'terminal.event' && event.terminalId === terminal.terminalId && event.type === 'output') output.push(event.data); });
    await remote.request('terminal.attach', { terminalId: terminal.terminalId });
    const available = page.getByRole('button', { name: `Open ${terminal.title}`, exact: true });
    await expect(available).toBeVisible();
    // A list invalidation cannot replace another viewer's attachment.
    await remote.request('terminal.input', { terminalId: terminal.terminalId, data: 'echo EXTERNAL-$((19*19))\r' });
    await expect.poll(() => output.join('')).toContain('EXTERNAL-361');
    await available.click();
    await expect(panel(page)).toHaveAttribute('data-status', 'running');
    await dismiss(page);
    await expect(rows(page)).toContainText('EXTERNAL-361');
    await assertRemoteDetached(remote, terminal.terminalId);
    const captured = await remote.request('terminal.capture', { terminalId: terminal.terminalId });
    expect(captured.lines.some(line => line.includes('EXTERNAL-361'))).toBe(true);
    // Closing elsewhere is reflected without a list timer; this page keeps its own stable tabs.
    await remote.request('terminal.close', { terminalId: terminal.terminalId });
    await expect(panel(page)).toHaveAttribute('data-status', 'exited');
    await page.getByRole('tab', { name: 'Terminal', exact: true }).press('Delete');
    await expect.poll(async () => (await list()).filter(item => item.state === 'running').length).toBe(0);
  } finally { remote.close(); }
  // New gateway connection => new scoped cursor/reset snapshot, no stale subscription IDs.
  await world.restartGateway();
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
  await page.getByRole('button', { name: 'Add terminal', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-status', 'running');
  await dismiss(page);
  await line(page, 'echo RESET-$((20*20))');
  await expect(rows(page)).toContainText('RESET-400');
  await page.getByRole('tab', { name: 'Terminal', exact: true }).press('Delete');
  await expect.poll(async () => (await list()).filter(item => item.state === 'running').length).toBe(0);
});

async function assertRemoteDetached(remote, terminalId) {
  await expect(async () => {
    try { await remote.request('terminal.input', { terminalId, data: 'x' }); throw new Error('still attached'); }
    catch (error) { expect(error.data?.reason).toBe('not_attached'); }
  }).toPass();
}

// Synthetic wire challenge exercises the real UI before a real native-supported launch.
// This is browser warning/consent evidence on macOS, never Linux fallback runtime proof.
test('reduced-protection warning precedes shell launch and Continue or Cancel is deliberate', async ({ page }) => {
  let warned = 0;
  await page.routeWebSocket(url => url.href.startsWith(world.gatewayUrl), ws => {
    const server = ws.connectToServer();
    ws.onMessage(message => {
      let request; try { request = JSON.parse(String(message)); } catch {}
      if (request?.method === 'terminal.create' && !request.params?.protectionAcknowledgment) {
        warned++;
        ws.send(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: 1005, message: 'Reduced protection', data: { reason: 'terminal_protection_ack_required' } } }));
      } else server.send(message);
    });
    server.onMessage(message => ws.send(message));
  });
  await connect(page, world, token);
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Terminal', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-status', 'protection-warning');
  await expect(panel(page)).toContainText('may continue running');
  expect((await list()).filter(item => item.state === 'running')).toHaveLength(0);
  await page.waitForTimeout(1100);
  expect(warned).toBe(1);
  await panel(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await list()).filter(item => item.state === 'running')).toHaveLength(0);
  await page.getByRole('button', { name: 'Add terminal', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-status', 'protection-warning');
  await panel(page).getByRole('button', { name: 'Continue with limited protection', exact: true }).click();
  await expect(panel(page)).toHaveAttribute('data-status', 'running');
  await line(page, 'echo ACK-$((21*21))');
  await expect(rows(page)).toContainText('ACK-441');
  await page.getByRole('tab', { name: 'Terminal', exact: true }).press('Delete');
  await expect.poll(async () => (await list()).filter(item => item.state === 'running').length).toBe(0);
});
