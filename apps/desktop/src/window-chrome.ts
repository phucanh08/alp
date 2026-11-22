import type { BrowserWindowConstructorOptions } from 'electron';

/**
 * The window's chrome, as Paseo's (packages/desktop/src/window/window-manager.ts,
 * getMainWindowChromeOptions, native-mac): on macOS no title bar of its own. The traffic lights sit
 * in the dashboard's top row, and titleBarOverlay turns on the Window Controls Overlay API, which is
 * how the page knows they are there (navigator.windowControlsOverlay.visible, env(titlebar-area-x))
 * and leaves room for them; apps/web lib/window-chrome.js. In full screen the lights go away and the
 * overlay reports not visible, so the room goes too.
 *
 * Windows and Linux keep the system frame: Paseo draws its own minimize/maximize/close there
 * (frame: false), which ALP's dashboard has no controls for.
 */
export const TRAFFIC_LIGHT_POSITION = Object.freeze({ x: 16, y: 12 });

export function windowChromeOptions(platform: NodeJS.Platform): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'> {
  if (platform !== 'darwin') return {};
  return { titleBarStyle: 'hidden', titleBarOverlay: true, trafficLightPosition: { ...TRAFFIC_LIGHT_POSITION } };
}
