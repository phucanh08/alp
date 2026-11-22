import { describe, expect, test } from 'bun:test';
import { TRAFFIC_LIGHT_POSITION, windowChromeOptions } from '../src/window-chrome';

describe('windowChromeOptions (t-81b0.12, Paseo native-mac chrome)', () => {
  test('macOS: no title bar of its own, the traffic lights inline, the Window Controls Overlay on', () => {
    expect(windowChromeOptions('darwin')).toEqual({ titleBarStyle: 'hidden', titleBarOverlay: true, trafficLightPosition: { x: 16, y: 12 } });
  });
  test('each call gets its own position object', () => {
    const options = windowChromeOptions('darwin');
    (options.trafficLightPosition as { x: number }).x = 99;
    expect(TRAFFIC_LIGHT_POSITION.x).toBe(16);
  });
  test('Windows and Linux keep the system frame', () => {
    expect(windowChromeOptions('win32')).toEqual({});
    expect(windowChromeOptions('linux')).toEqual({});
  });
});
