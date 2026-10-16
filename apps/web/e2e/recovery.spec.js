// Recovery through the real UI: the gateway restarts during a turn and while idle (alpd closes the
// root nobody watches), alpd restarts, the page reloads. The view continues from its cursor, keeps
// its sessions, shows each message once, and never sends a message again by itself.
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { assistant, connect, idle, newSession, send, users } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

const count = async (world, text) => (await world.turnStarts()).filter(entry => entry.text?.includes(text)).length;

test('gateway restart mid-turn, twice while idle, then alpd restart and a reload', async ({ page }) => {
  await connect(page, world);
  await newSession(page, 'Recovery');

  // Mid-turn: the reply streams for about three seconds; the gateway goes away meanwhile.
  await send(page, 'Slow answer please [slow]');
  await expect(page.getByTestId('working')).toBeVisible();
  await world.stopGateway();
  await expect(page.getByText(/Connection to the host lost/)).toBeVisible();
  await world.startGateway();
  await expect(page.getByText(/Connection to the host lost/)).toBeHidden({ timeout: 30_000 });
  await expect(assistant(page).last()).toHaveText(/Echo: Slow answer please/, { timeout: 20_000 });
  await expect(page.getByTestId('working')).toBeHidden();
  await expect(assistant(page)).toHaveCount(1);
  await expect(users(page)).toHaveCount(1);

  // Idle, twice: alpd closes the root while nobody watches; it stays listed and reopens on send.
  for (let round = 0; round < 2; round++) {
    await world.restartGateway();
    await expect(page.getByText(/Connection to the host lost/)).toBeHidden({ timeout: 30_000 });
  }
  await expect(page.getByTestId('session-row')).toContainText('Recovery');
  await expect(page.getByText('This session is closed on the host. Sending a message reopens it.')).toBeVisible();
  await send(page, 'Still there?');
  await expect(assistant(page).last()).toContainText('Echo: Still there?');
  await expect(users(page)).toHaveCount(2);
  // The turn must be over on the host first: alpd stopped mid-turn reopens the session and asks
  // the agent to continue, which adds a message of its own (a host behaviour, not this app's).
  await idle(page);

  // alpd restarts (the gateway follows it): the session resumes from its record.
  await world.restartDaemon();
  await expect(page.getByText(/Connection to the host lost/)).toBeHidden({ timeout: 30_000 });
  await send(page, 'After the host restart');
  await expect(assistant(page).last()).toContainText('Echo: After the host restart', { timeout: 30_000 });

  // Every message reached the provider once, none was sent again by the app.
  for (const text of ['Slow answer please', 'Still there?', 'After the host restart']) expect(await count(world, text), text).toBe(1);

  // A reload forgets the token; after entering it again the session and its history come back.
  await page.reload();
  await expect(page.getByLabel('Access token')).toHaveValue('');
  await connect(page, world);
  await page.getByTestId('session-row').filter({ hasText: 'Recovery' }).click();
  await expect(assistant(page)).toHaveCount(3);
  await expect(users(page)).toHaveCount(3);
});
