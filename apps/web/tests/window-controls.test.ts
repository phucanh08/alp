import test from 'node:test';
import assert from 'node:assert/strict';
import { windowControlsVisible, windowToggles } from '../dist-lib/window-controls.js';

test('only a visible Window Controls Overlay counts as traffic lights in the page', () => {
  assert.equal(windowControlsVisible(undefined), false);
  assert.equal(windowControlsVisible({}), false);
  assert.equal(windowControlsVisible({ windowControlsOverlay: { visible: false } }), false);
  assert.equal(windowControlsVisible({ windowControlsOverlay: { visible: true } }), true);
});

test('the window owns the top-row toggles only with the lights in the page and the panels docked', () => {
  const docked = { overlay: true, medium: true, wide: true, workspace: true, settings: false };
  assert.deepEqual(windowToggles(docked), { sidebarToggle: true, explorerToggle: true });
  // A browser, an older ALP.app, Windows/Linux, full screen: the headers keep both, as before.
  assert.deepEqual(windowToggles({ ...docked, overlay: false }), { sidebarToggle: false, explorerToggle: false });
  // Settings covers the window and has its own top row.
  assert.deepEqual(windowToggles({ ...docked, settings: true }), { sidebarToggle: false, explorerToggle: false });
  // History, Tasks, Schedules: no explorer there.
  assert.deepEqual(windowToggles({ ...docked, workspace: false }), { sidebarToggle: true, explorerToggle: false });
  // Narrower windows: the explorer, then the sidebar, become drawers the header opens.
  assert.deepEqual(windowToggles({ ...docked, wide: false }), { sidebarToggle: true, explorerToggle: false });
  assert.deepEqual(windowToggles({ ...docked, wide: false, medium: false }), { sidebarToggle: false, explorerToggle: false });
});
