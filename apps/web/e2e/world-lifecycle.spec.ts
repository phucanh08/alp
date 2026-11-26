import { expect, test } from '@playwright/test';
import type { BrowserContext } from '@playwright/test';
import { access, readFile } from 'node:fs/promises';
import { closeWorldAfter } from './support/cleanup.ts';
import path from 'node:path';
import { freePort, startWorld } from './support/world.ts';

const reachable = (url: string) => fetch(url, { signal: AbortSignal.timeout(1000) }).then(() => true, () => false);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('cleanup releases the real host even when the preceding stop assertion fails', async ({ browser }) => {
  const world = await startWorld({ settings: { dashboard: { port: await freePort() }, web: { relay: { enabled: false } } } });
  const pid = world.daemonPid;
  let context: BrowserContext | undefined, webPid: number | undefined;
  try {
    world.env.ALP_SUPERVISE = '0';
    delete world.env.ALP_DASHBOARD_APP;
    const webUrl = new URL((await world.alp('dashboard', '--print')).trim()).origin;
    ({ pid: webPid } = JSON.parse(await readFile(path.join(world.home, 'dashboard.json'), 'utf8')));
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(world.webUrl);
    await expect(page.getByLabel('Access token')).toBeVisible();
    await expect(async () => closeWorldAfter(world, async () => {
      // Deliberate assertion failure at the same seam as local.spec's service-stop check.
      expect(true, 'injected service-stop assertion').toBe(false);
    })).rejects.toThrow('injected service-stop assertion');
    expect(alive(pid!)).toBe(false);
    expect(alive(webPid!)).toBe(false);
    expect(await reachable(webUrl)).toBe(false);
    expect(await reachable(world.gatewayUrl)).toBe(false);
    expect(await reachable(world.webUrl)).toBe(false);
    await expect(access(world.directory)).rejects.toThrow();
  } finally {
    // Independent safety net also works when fault-injecting a broken closeWorldAfter.
    try { await context?.close(); } finally {
      try {
        if (webPid) {
          try { process.kill(webPid, 'SIGKILL'); } catch {}
          await expect.poll(() => alive(webPid!)).toBe(false);
        }
      } finally { await world.close(); }
    }
  }
  expect(context!.pages()).toHaveLength(0);
});

test('restartDaemon with gateway:false never starts a standalone gateway', async () => {
  const world = await startWorld({ gateway: false, serveWeb: false });
  try {
    const pid = world.daemonPid;
    await world.restartDaemon();
    expect(world.daemonPid).not.toBe(pid);
    expect(alive(pid!)).toBe(false);
    expect(await reachable(world.gatewayUrl)).toBe(false);
    await expect(access(world.env.ALP_GATEWAY_HOME!)).rejects.toThrow();
  } finally { await world.close(); }
});
