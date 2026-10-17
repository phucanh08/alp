// What a credential may do is decided by the gateway; the UI reflects it and reports refusals:
// a wrong token, a read-only token, a token limited to read-only mode, another workspace's token,
// a revoked token, and a page origin the gateway does not allow.
import { expect, test } from '@playwright/test';
import { freePort, serveStatic, startWorld, WEB } from './support/world.js';
import { connect, newSession, openTasks, send } from './support/app.js';
import path from 'node:path';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

test('a wrong token is refused and nothing is kept', async ({ page }) => {
  await page.goto(world.webUrl);
  await page.getByLabel('Gateway address').fill(world.gatewayUrl);
  await page.getByLabel('Access token').fill('alpgw1.0000000000000000.not-a-real-secret');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('alert')).toContainText('refused this access token');
});

test('grants: read-only token, mode-limited token and another workspace', async ({ browser }) => {
  // The owner starts a full-access session.
  const owner = await browser.newPage();
  await connect(owner, world);
  await newSession(owner, 'Owner work');
  await send(owner, 'hello from the owner');
  await expect(owner.getByTestId('assistant-message').last()).toContainText('Echo: hello from the owner');

  // session.read + project.read: sees it, cannot write.
  const viewer = await browser.newPage();
  await connect(viewer, world, world.tokens.viewer);
  await expect(viewer.getByRole('navigation').getByRole('button', { name: 'New session' })).toBeDisabled();
  await viewer.getByTestId('session-row').filter({ hasText: 'Owner work' }).click();
  await expect(viewer.getByTestId('assistant-message').last()).toContainText('Echo: hello from the owner');
  await expect(viewer.getByText('Your access token can view sessions but not send messages.')).toBeVisible();
  await expect(viewer.getByLabel('Message', { exact: true })).toBeDisabled();
  await openTasks(viewer);
  await expect(viewer.getByText('Your access token can read tasks but not change them.')).toBeVisible();

  // Modes [read-only]: cannot drive the owner's full-access session; may start a read-only one.
  const limited = await browser.newPage();
  await connect(limited, world, world.tokens.readOnlyMode);
  await limited.getByTestId('session-row').filter({ hasText: 'Owner work' }).click();
  await expect(limited.getByText(/can only drive sessions in read-only mode/).first()).toBeVisible();
  await expect(limited.getByLabel('Message', { exact: true })).toBeDisabled();
  await limited.getByRole('navigation').getByRole('button', { name: 'New session' }).click();
  const draft = limited.getByTestId('new-session-screen');
  // The only mode the token allows, shown as a fixed control; the preview says it too.
  await expect(draft.getByTitle('Permissions')).toHaveText('Read only');
  await expect(draft.getByTestId('preview-mode')).toHaveText('Read only');
  await draft.getByLabel('Title (optional)').fill('Read-only work');
  await draft.getByRole('button', { name: 'Start session' }).click();
  // As newSession waits: a message typed before main's composer is ready is lost (seen on Ubuntu CI).
  await expect(draft).toBeHidden();
  await expect(limited.getByRole('heading', { level: 1, name: 'Read-only work' })).toBeVisible();
  await expect(limited.getByPlaceholder(/^Message main/)).toBeEnabled();
  await send(limited, 'read only hello');
  await expect(limited.getByTestId('assistant-message').last()).toContainText('Echo: read only hello');

  // Another workspace's token sees neither session.
  const other = await browser.newPage();
  await connect(other, world, world.tokens.other);
  await expect(other.getByText('This workspace has no sessions yet.')).toBeVisible();
  await expect(other.getByTestId('session-row')).toHaveCount(0);
  for (const page of [owner, viewer, limited, other]) await page.close();
});

test('a revoked token ends the session view with a clear refusal', async ({ page }) => {
  await connect(page, world, world.tokens.revocable);
  await expect(page.getByRole('navigation', { name: 'Workspaces and sessions' })).toBeVisible();
  await world.gatewayCli('credential', 'revoke', world.credentialIds.revocable);
  await expect(page.getByRole('alert')).toContainText('refused this access token', { timeout: 20_000 });
  await expect(page.getByLabel('Access token')).toBeVisible();
});

test('a page origin the gateway does not allow cannot get a ticket', async ({ page }) => {
  const port = await freePort();
  const stranger = await serveStatic(path.join(WEB, 'dist'), port);
  try {
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByLabel('Gateway address').fill(world.gatewayUrl);
    await page.getByLabel('Access token').fill(world.tokens.owner);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByRole('alert')).toContainText("allows this page's origin");
  } finally {
    await stranger.close();
  }
});
