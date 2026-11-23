/**
 * ALP.app on macOS has no title bar of its own: the traffic lights sit in the page's top row
 * (apps/desktop/src/window-chrome.ts) and the Window Controls Overlay says so. A browser, an older
 * ALP.app with its own title bar, Windows/Linux (system frame) and full screen (the lights hidden)
 * all report no visible overlay.
 *
 * @param {{ windowControlsOverlay?: { visible?: boolean } } | undefined} [nav]
 * @returns {boolean}
 */
export function windowControlsVisible(nav = typeof navigator === 'undefined' ? undefined : /** @type {any} */ (navigator)) {
  return nav?.windowControlsOverlay?.visible === true;
}

/**
 * Who owns the top row's two toggles, as Paseo's desktop titlebar (app/_layout.tsx
 * WindowSidebarMenuToggle, screens/workspace/workspace-explorer-toggle.tsx titlebarAction): with the
 * traffic lights in the page, the sidebar toggle sits right after them and the explorer toggle at the
 * window's right edge, both owned by the window so they stay put while the panels open and close.
 * Otherwise (a browser, a narrow window where the panels are drawers) the headers keep them.
 *
 * @param {{ overlay: boolean, medium: boolean, wide: boolean, workspace: boolean, settings: boolean }} input
 *   overlay: windowControlsVisible(); medium/wide: the sidebar/explorer dock rather than overlay;
 *   workspace: the workspace screen is showing (the explorer's screen); settings: Settings covers the window.
 * @returns {{ sidebarToggle: boolean, explorerToggle: boolean }}
 */
export function windowToggles({ overlay, medium, wide, workspace, settings }) {
  const window = overlay && !settings;
  return { sidebarToggle: window && medium, explorerToggle: window && wide && workspace };
}
