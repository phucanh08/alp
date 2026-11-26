// Settings › the host's library, read only (docs/paseo-parity.md, patch 0015): an entry opens with
// its content, and every value that can hold a secret shows as hidden. The secrets never reach the
// browser: not in the page, not in any WebSocket frame. The host is labelled with its machine name
// (patch 0017). Through the real UI, gateway and alpd.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect } from './support/app.js';

/** @type {Awaited<ReturnType<typeof startWorld>>} */
let world;
test.beforeAll(async () => {
  world = await startWorld();
  // A library MCP server and a project hook, each holding secrets where they can be.
  await mkdir(path.join(world.home, 'mcp'), { recursive: true });
  await writeFile(path.join(world.home, 'mcp', 'vault.json'), JSON.stringify({
    command: 'npx', args: ['-y', 'vault-mcp', '--api-key=SENTINEL-E2E-ARG'], env: { VAULT_TOKEN: 'SENTINEL-E2E-ENV' },
  }));
  await mkdir(path.join(world.projects.main, '.alp', 'hooks'), { recursive: true });
  await writeFile(path.join(world.projects.main, '.alp', 'hooks', 'notify.json'), JSON.stringify({
    description: 'tells CI', event: 'handoff', command: 'curl -H "Authorization: Bearer SENTINEL-E2E-HOOK" https://ci.example', blocking: true, timeoutSec: 30,
  }));
});
test.afterAll(async () => { await world?.close(); });

test('library entries open read only with their secrets hidden, and the host is labelled with its machine name', async ({ page }) => {
  const frames = [];
  page.on('websocket', socket => socket.on('framereceived', frame => frames.push(String(frame.payload))));
  await connect(page, world);
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  await expect(settings.getByTestId('settings-host-label')).toHaveText(hostname());

  await settings.getByTestId('settings-host').click();
  await expect(settings).toContainText(hostname());

  // A built-in agent: its instructions, as AGENT.md says them.
  await settings.getByTestId('settings-alp-agents').click();
  await settings.getByTestId('library-row-main').click();
  const agent = settings.getByTestId('library-entry');
  await expect(agent).toContainText('AGENT.md');
  await expect(agent).toContainText('builtin');
  await expect(settings).toContainText('Editing agents is not available in this beta');

  // The library's MCP server: the program, its env name; the argument and token hidden.
  await settings.getByTestId('settings-alp-mcp').click();
  await settings.getByTestId('library-row-vault').click();
  const server = settings.getByTestId('library-entry');
  await expect(server).toContainText('"command": "npx"');
  await expect(server).toContainText('"VAULT_TOKEN": "‹hidden on the host›"');
  await expect(server).toContainText('4 values that can hold secrets are shown as ‹hidden on the host›');

  // The project's hook: its event and settings; its command hidden.
  await settings.getByTestId('settings-alp-hooks').click();
  await settings.getByTestId('library-row-notify').click();
  const hook = settings.getByTestId('library-entry');
  await expect(hook).toContainText('"event": "handoff"');
  await expect(hook).toContainText('"command": "‹hidden on the host›"');
  await expect(hook).toContainText('project');

  expect(await page.content()).not.toContain('SENTINEL-E2E');
  expect(frames.some(frame => frame.includes('"library.get"') || frame.includes('"content"'))).toBe(true);
  expect(frames.filter(frame => frame.includes('SENTINEL-E2E'))).toEqual([]);
});


test('library.write edits project instructions through UI, gateway and daemon', async ({ page }) => {
  await connect(page, world, world.tokens.libraryWriter);
  await page.getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings' });
  await settings.getByTestId('settings-alp-skills').click();
  await settings.getByRole('textbox', { name: 'Entry name', exact: true }).fill('browser-notes');
  await settings.getByRole('textbox', { name: 'Instruction entry JSON' }).fill(JSON.stringify({ body: 'Browser notes' }));
  await settings.getByRole('button', { name: 'Save project entry' }).click();
  await expect(settings.getByTestId('library-row-browser-notes')).toBeVisible();
  expect(await readFile(path.join(world.projects.main, '.alp/skills/browser-notes/SKILL.md'), 'utf8')).toBe('Browser notes\n');
  await settings.getByTestId('library-row-browser-notes').click();
  await settings.getByRole('textbox', { name: 'Instruction entry JSON' }).fill(JSON.stringify({ body: 'Updated notes' }));
  await settings.getByRole('button', { name: 'Save project entry' }).click();
  await expect.poll(() => readFile(path.join(world.projects.main, '.alp/skills/browser-notes/SKILL.md'), 'utf8')).toBe('Updated notes\n');
  await settings.getByRole('textbox', { name: 'New entry name' }).fill('browser-copy');
  await settings.getByRole('button', { name: 'Duplicate', exact: true }).click();
  await expect(settings.getByTestId('library-row-browser-copy')).toBeVisible();
  await settings.getByTestId('library-row-browser-copy').click();
  await settings.getByRole('textbox', { name: 'New entry name' }).fill('browser-renamed');
  await settings.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(settings.getByTestId('library-row-browser-renamed')).toBeVisible();
  await settings.getByTestId('library-row-browser-renamed').click();
  await settings.getByRole('button', { name: 'Delete project entry' }).click();
  await expect(settings.getByTestId('library-row-browser-renamed')).toHaveCount(0);
});
