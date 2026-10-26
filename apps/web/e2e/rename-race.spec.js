import { expect, test } from '@playwright/test';
import { startWorld } from './support/world.js';
import { connect, newSession } from './support/app.js';

let world;
test.beforeAll(async () => { world = await startWorld(); });
test.afterAll(async () => { await world?.close(); });

/**
 * Yield React's scheduler after the native modal opens, then hold its next host task.
 * This exposes the input before a passive-effect state update can commit, without
 * changing React, input values, focus, selection, or DOM events. Advancing the
 * scheduler's clock forces a yield; no wall-clock sleep or probabilistic load.
 */
async function gateRenameRender(page) {
  await page.addInitScript(() => {
    const gate = window.renameRenderGate = { armed: false, blocked: false, held: [], offset: 0 };
    const now = performance.now.bind(performance);
    performance.now = () => now() + gate.offset;
    const Channel = window.MessageChannel;
    window.MessageChannel = class extends Channel {
      constructor() {
        super();
        const port = this.port1;
        Object.defineProperty(port, 'onmessage', { set(callback) {
          port.addEventListener('message', event => {
            if (gate.blocked) gate.held.push(() => callback(event));
            else callback(event);
          });
          port.start();
        }});
      }
    };
    const showModal = HTMLDialogElement.prototype.showModal;
    HTMLDialogElement.prototype.showModal = function() {
      showModal.call(this);
      if (gate.armed && this.querySelector('#rename-title')) {
        gate.armed = false;
        gate.blocked = true;
        gate.offset = 1000;
      }
    };
  });
}

async function releaseRender(page) {
  await page.evaluate(() => {
    const gate = window.renameRenderGate;
    gate.blocked = false;
    gate.offset = 0;
    for (const callback of gate.held.splice(0)) callback();
  });
}

for (const selectionFirst of [true, false]) {
  test(`rename replaces the title with ${selectionFirst ? 'selection before' : 'render before'} the queued render`, async ({ page }) => {
    await gateRenameRender(page);
    await connect(page, world);
    await newSession(page, 'Tab work');
    await page.evaluate(() => { window.renameRenderGate.armed = true; });
    await page.getByRole('tab', { name: 'Tab work' }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename session' });
    const input = dialog.getByLabel('Title');
    await expect(dialog).toBeVisible();
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    await expect.poll(() => page.evaluate(() => window.renameRenderGate.held.length)).toBeGreaterThan(0);

    // Playwright 1.64 fill selects first, then inserts text through a separate browser
    // command. Schedule the queued React render at that exact boundary. The browser
    // must retain the selected old title; assigning it here collapses the selection.
    if (!selectionFirst) await releaseRender(page);
    await input.selectText();
    if (selectionFirst) await releaseRender(page);
    await page.keyboard.insertText('Tab plan');
    await expect(input).toHaveValue('Tab plan');
    await input.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { level: 1, name: 'Tab plan' })).toBeVisible();
    await expect(page.getByTestId('workspace-tab').first()).toHaveText('Tab plan');

    // Reopen initializes from the saved title, and ordinary controlled re-renders
    // retain the draft. Blurring does not save; Escape discards the edit.
    const open = async () => {
      await page.getByRole('tab', { name: 'Tab plan' }).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Rename', exact: true }).click();
      await expect(input).toHaveValue('Tab plan');
      await expect(dialog).toBeVisible();
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    };
    await open();
    await input.press('ControlOrMeta+A');
    await input.pressSequentially('Discard this');
    await expect(input).toHaveValue('Discard this');
    await dialog.getByRole('button', { name: 'Save', exact: true }).focus();
    await expect(input).toHaveValue('Discard this');
    await expect(page.getByTestId('workspace-tab').first()).toHaveText('Tab plan');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await open();
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('workspace-tab').first()).toHaveText('Tab plan');
  });
}
