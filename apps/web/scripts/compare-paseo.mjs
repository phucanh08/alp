#!/usr/bin/env node
// Screenshots of one conversation in apps/web and in paseo-web (Paseo 0.11.2 + ALP patches, the
// built dist/web-app), side by side, for the parity work in docs/paseo-parity.md. Both apps talk to
// the same disposable host (e2e/support/world.js: alpd with the fake Codex in a temporary home):
// apps/web through alp-gateway, paseo-web through ALP's Paseo bridge on that alpd.
//
//   node apps/web/scripts/compare-paseo.mjs [outDir] [--only chat|workspace|new-session]
//
// Scenes: chat (t-7679.1: the conversation, the composer), workspace (t-7679.2: attention in
// the sidebar, the session title on its tab, the Shortcuts dialog, History, an archived session)
// and new-session (t-7679.3: the New session / new agent tab with its pickers and effort, ALP's
// preview, Settings General and Appearance, the light theme).
//
// Needs: apps/web/dist (npm run build:alp-web), packages/{cli,daemon}/dist, dist/web-app
// (node scripts/build-paseo-web.mjs) and integrations/paseo/server/dist. Nothing touches ~/.alp.
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { REPOSITORY, startWorld } from '../e2e/support/world.js';
import { connect, idle, newSession, send } from '../e2e/support/app.js';

const args = process.argv.slice(2);
const onlyAt = args.indexOf('--only');
const only = onlyAt >= 0 ? args.splice(onlyAt, 2)[1] : undefined;
const out = path.resolve(args[0] ?? path.join(REPOSITORY, 'apps/web/docs/screenshots'));
const bridgeEntry = path.join(REPOSITORY, 'integrations/paseo/server/dist/index.js');
for (const file of [bridgeEntry, path.join(REPOSITORY, 'dist/web-app/index.html')]) {
  if (!existsSync(file)) throw new Error(`${path.relative(REPOSITORY, file)} is missing`);
}
await mkdir(out, { recursive: true });

const world = await startWorld();
// The in-process Paseo bridge probes runtimes from this process's env (ALP_CLAUDE_BIN,
// ALP_CODEX_BIN `--version`): give it the world's fake/missing programs, never the real CLIs.
if (!world.runtimeBins.ALP_CLAUDE_BIN || !world.runtimeBins.ALP_CODEX_BIN) throw new Error('compare-paseo needs a fake world');
Object.assign(process.env, world.runtimeBins);
const { createPaseoBridge, createWebServer, webAppDir } = await import(pathToFileURL(bridgeEntry).href);
/** @type {any} */
let paseo;
const bridge = createPaseoBridge({ version: 'compare', home: world.home, token: () => paseo.token, serverId: () => paseo.serverId });
paseo = createWebServer({ home: world.home, port: 0, app: { dir: webAppDir(path.join(REPOSITORY, 'dist/alpd.js')), gateway: bridge } });
const paseoInfo = await paseo.listen();
const browser = await chromium.launch();
const shot = async (page, name) => { await page.waitForTimeout(600); await page.screenshot({ path: path.join(out, name) }); console.log(path.join(out, name)); };

/** paseo-web on the shared host, opened on the project's workspace. */
async function openPaseo(context) {
  const app = await context.newPage();
  await app.goto(`${paseoInfo.url}#token=${paseoInfo.token}`, { timeout: 180_000 });
  const debug = async error => { await shot(app, 'debug-paseo-web.png'); throw error; };
  await app.getByText('shop', { exact: true }).nth(1).waitFor({ timeout: 180_000 }).catch(debug);
  await app.getByText('shop', { exact: true }).nth(1).click();
  return app;
}

async function chatScenes() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const web = await context.newPage();
  await connect(web, world);
  await newSession(web, 'Parity check');
  await send(web, 'Hello there');
  await web.getByText('Echo: Hello there').waitFor();
  await idle(web);
  await send(web, 'What is in src? [tool]');
  await web.getByText('The src folder has three files').waitFor();
  await idle(web);
  await shot(web, 'chat-apps-web.png');
  await web.getByTestId('tool-call').first().getByRole('button').first().click();
  await shot(web, 'chat-tool-open-apps-web.png');
  await send(web, 'Ship it? [ask]');
  await web.getByTestId('question').waitFor();
  await shot(web, 'chat-question-apps-web.png');

  // paseo-web: the same tree, opened from its sidebar.
  const app = await context.newPage();
  await app.goto(`${paseoInfo.url}#token=${paseoInfo.token}`, { timeout: 180_000 });
  // Paseo lists the project, then its workspace (named after the folder); the workspace opens its agents.
  const debug = async error => { await shot(app, 'debug-paseo-web.png'); throw error; };
  await app.getByText('shop', { exact: true }).nth(1).waitFor({ timeout: 180_000 }).catch(debug);
  await app.getByText('shop', { exact: true }).nth(1).click();
  await app.getByText('Deploy to staging now?').first().waitFor({ timeout: 60_000 }).catch(debug);
  await shot(app, 'chat-question-paseo-web.png');
  await web.getByTestId('question').getByRole('radio', { name: 'yes' }).click();
  await web.getByTestId('question').getByRole('button', { name: 'Submit' }).click();
  await web.getByText('you said "yes"').waitFor();
  await idle(web);
  await app.getByText('you said "yes"').first().waitFor({ timeout: 60_000 });
  await shot(app, 'chat-paseo-web.png');
  await shot(web, 'chat-answered-apps-web.png');
  const tool = app.getByText('ls -1 src').first();
  if (await tool.isVisible().catch(() => false)) { await tool.click(); await shot(app, 'chat-tool-open-paseo-web.png'); }

  // A running turn with a queued message, in both.
  await send(web, 'Long job [hold]');
  await web.getByLabel('Message', { exact: true }).fill('Queued note');
  await web.keyboard.press('ControlOrMeta+Enter');
  await shot(web, 'chat-running-apps-web.png');
  await shot(app, 'chat-running-paseo-web.png');
  const composer = app.getByRole('textbox').last();
  await composer.fill('Typed in paseo-web');
  await shot(app, 'chat-composer-text-paseo-web.png');
  await composer.fill('');
  await web.getByRole('button', { name: 'Interrupt agent' }).click();
  await idle(web);

  // The mode control open, in both.
  await web.getByRole('button', { name: 'Permissions' }).click();
  await shot(web, 'chat-mode-menu-apps-web.png');
  await web.keyboard.press('Escape');
  await app.getByText('Full access').last().click();
  await shot(app, 'chat-mode-menu-paseo-web.png');
  await app.keyboard.press('Escape');

  // Phone width.
  const phone = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const webPhone = await phone.newPage();
  await connect(webPhone, world);
  await webPhone.getByRole('button', { name: 'Open sessions' }).click();
  await webPhone.getByText('Parity check').first().click();
  await webPhone.getByTestId('assistant-message').first().waitFor();
  await shot(webPhone, 'chat-mobile-apps-web.png');
  const appPhone = await phone.newPage();
  await appPhone.goto(`${paseoInfo.url}#token=${paseoInfo.token}`, { timeout: 180_000 });
  await appPhone.waitForTimeout(8000);
  await shot(appPhone, 'chat-mobile-start-paseo-web.png');
  await context.close();
  await phone.close();
}

async function workspaceScenes() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const web = await context.newPage();
  await connect(web, world);
  // One session waits for an answer while another is open: its row shows it; the tab names the session.
  await newSession(web, 'Release check');
  await send(web, 'Ship it? [ask]');
  await web.getByTestId('question').waitFor();
  await newSession(web, 'Notes');
  await web.getByTestId('session-row').filter({ hasText: 'Release check' }).locator('[data-status="needs_input"]').waitFor();
  await shot(web, 'workspace-attention-apps-web.png');
  const app = await openPaseo(context);
  await app.getByText('Notes').first().waitFor({ timeout: 60_000 }).catch(() => {});
  await shot(app, 'workspace-attention-paseo-web.png');

  // The Shortcuts dialog (Shift+?).
  await web.locator('body').click({ position: { x: 700, y: 300 } });
  await web.keyboard.press('Shift+?');
  await web.getByRole('dialog', { name: 'Shortcuts' }).waitFor();
  await shot(web, 'workspace-shortcuts-apps-web.png');
  await web.keyboard.press('Escape');
  await app.locator('body').click({ position: { x: 700, y: 120 } });
  await app.keyboard.press('Shift+?');
  await shot(app, 'workspace-shortcuts-paseo-web.png');
  await app.keyboard.press('Escape');

  // Archive "Notes", then History in both.
  await web.locator('body').click({ position: { x: 700, y: 300 } });
  await web.keyboard.press('ControlOrMeta+Shift+Backspace');
  await web.getByRole('dialog', { name: 'Archive session?' }).getByRole('button', { name: 'Archive' }).click();
  await web.getByTestId('session-row').filter({ hasText: 'Notes' }).waitFor({ state: 'detached' });
  await web.getByTestId('sidebar-history').click();
  await web.getByTestId('history-row').first().waitFor();
  await shot(web, 'workspace-history-apps-web.png');
  await app.getByText('History', { exact: true }).first().click();
  await app.getByText('Release check').first().waitFor({ timeout: 60_000 }).catch(() => {});
  await shot(app, 'workspace-history-paseo-web.png');

  // The archived session opened from History: the Unarchive callout in place of the composer.
  await web.getByTestId('history-row').filter({ hasText: 'Notes' }).click();
  await web.getByTestId('archived-callout').waitFor();
  await shot(web, 'workspace-archived-apps-web.png');
  const archived = app.getByText('Notes').first();
  if (await archived.isVisible().catch(() => false)) { await archived.click(); await shot(app, 'workspace-archived-paseo-web.png'); }
  await context.close();
}

async function newSessionScenes() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const web = await context.newPage();
  await connect(web, world);
  await newSession(web, 'Earlier work');
  // The New session tab: composer, controls and the preview.
  await web.getByRole('navigation').getByRole('button', { name: 'New session' }).click();
  const screen = web.getByTestId('new-session-screen');
  await screen.getByTestId('preview-agent').waitFor();
  await screen.getByLabel('Message', { exact: true }).fill('Plan the release');
  await shot(web, 'new-session-apps-web.png');
  await screen.getByRole('button', { name: 'Model' }).click();
  await shot(web, 'new-session-model-menu-apps-web.png');
  await web.getByRole('menu', { name: 'Model' }).getByRole('menuitemradio', { name: 'codex · GPT-5.6-Sol' }).click();
  await screen.getByRole('button', { name: 'Thinking' }).click();
  await shot(web, 'new-session-thinking-menu-apps-web.png');
  await web.getByRole('menu', { name: 'Thinking' }).getByRole('menuitemradio', { name: 'High', exact: true }).click();
  await screen.getByTestId('preview-thinking').filter({ hasText: 'High' }).waitFor();
  await shot(web, 'new-session-preview-apps-web.png');

  // paseo-web: its new agent tab in the same workspace, the team picker and thinking open.
  const app = await openPaseo(context);
  await app.getByText('Earlier work').first().waitFor({ timeout: 60_000 }).catch(() => {});
  // Its New tab launcher (⌘T), then Agent: the draft agent tab with the composer.
  await app.locator('body').click({ position: { x: 700, y: 120 } });
  await app.keyboard.press('ControlOrMeta+T');
  await app.getByText('Agent', { exact: true }).first().click({ timeout: 30_000 }).catch(() => {});
  await app.waitForTimeout(2000);
  await shot(app, 'new-session-paseo-web.png');
  const picker = app.getByText(/Select team|Phở|Cafe/).last();
  if (await picker.isVisible().catch(() => false)) { await picker.click(); await shot(app, 'new-session-model-menu-paseo-web.png'); await app.keyboard.press('Escape'); }
  const thinking = app.getByText(/^(Low|Medium|High|Extra high|Max)$/).last();
  if (await thinking.isVisible().catch(() => false)) { await thinking.click(); await shot(app, 'new-session-thinking-menu-paseo-web.png'); await app.keyboard.press('Escape'); }

  // Settings: General, then Appearance, in both; then apps-web in the light theme.
  await web.keyboard.press('Escape');
  await web.getByRole('button', { name: 'Settings' }).click();
  const settings = web.getByRole('region', { name: 'Settings' });
  await settings.getByLabel('Default send').waitFor();
  await shot(web, 'settings-general-apps-web.png');
  await settings.getByTestId('settings-appearance').click();
  await shot(web, 'settings-appearance-apps-web.png');
  await app.locator('body').click({ position: { x: 700, y: 120 } });
  await app.keyboard.press('ControlOrMeta+Comma');
  await app.waitForTimeout(1500);
  await shot(app, 'settings-general-paseo-web.png');
  const appearance = app.getByText('Appearance', { exact: true }).first();
  if (await appearance.isVisible().catch(() => false)) { await appearance.click(); await shot(app, 'settings-appearance-paseo-web.png'); }
  await settings.getByLabel('Theme').selectOption('light');
  await shot(web, 'settings-appearance-light-apps-web.png');
  await settings.getByRole('button', { name: 'Back', exact: true }).click();
  await web.getByRole('navigation').getByRole('button', { name: 'New session' }).click();
  await screen.getByTestId('preview-agent').waitFor();
  await shot(web, 'new-session-light-apps-web.png');
  await context.close();
}

try {
  if (!only || only === 'chat') await chatScenes();
  if (!only || only === 'workspace') await workspaceScenes();
  if (!only || only === 'new-session') await newSessionScenes();
} finally {
  await browser.close();
  await paseo.close();
  await world.close();
}
