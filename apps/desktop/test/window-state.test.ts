import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { coerceWindowState, fitWindowState, readWindowState, stateOf, writeWindowState } from '../src/window-state';

const SCREEN = { x: 0, y: 25, width: 1440, height: 875 };
const RIGHT = { x: 1440, y: 0, width: 1920, height: 1080 };

describe('coerceWindowState', () => {
  test('keeps a full state, rounds, and raises a size under the minimum', () => {
    expect(coerceWindowState({ x: 10.4, y: 20, width: 1000.6, height: 700, maximized: true })).toEqual({ x: 10, y: 20, width: 1001, height: 700, maximized: true });
    expect(coerceWindowState({ width: 300, height: 200 })).toEqual({ width: 720, height: 480, maximized: false });
  });
  test('drops a half-known place and refuses what is not a state', () => {
    expect(coerceWindowState({ x: 10, width: 1000, height: 700 })).toEqual({ width: 1000, height: 700, maximized: false });
    for (const value of [null, [], 'x', { width: 'a', height: 1 }, { width: Infinity, height: 700 }, { width: -5, height: 700 }]) expect(coerceWindowState(value)).toBeUndefined();
  });
});

describe('fitWindowState', () => {
  test('a place on a connected display is kept', () => {
    expect(fitWindowState({ x: 100, y: 100, width: 1000, height: 700, maximized: false }, [SCREEN, RIGHT])).toEqual({ x: 100, y: 100, width: 1000, height: 700, maximized: false });
    expect(fitWindowState({ x: 1500, y: 50, width: 1000, height: 700, maximized: false }, [SCREEN, RIGHT])).toEqual({ x: 1500, y: 50, width: 1000, height: 700, maximized: false });
  });
  test('a place on a display that is gone is dropped; the size fits the primary display', () => {
    expect(fitWindowState({ x: 1500, y: 50, width: 1800, height: 1000, maximized: false }, [SCREEN])).toEqual({ width: 1440, height: 875, maximized: false });
    expect(fitWindowState({ x: -5000, y: -5000, width: 1000, height: 700, maximized: true }, [SCREEN])).toEqual({ width: 1000, height: 700, maximized: true });
  });
  test('a window mostly off its display is moved back onto it', () => {
    expect(fitWindowState({ x: 1300, y: 600, width: 1000, height: 700, maximized: false }, [SCREEN])).toEqual({ x: 440, y: 200, width: 1000, height: 700, maximized: false });
  });
  test('a sliver under 100×80 on screen does not count', () => {
    expect(fitWindowState({ x: 1400, y: 100, width: 1000, height: 700, maximized: false }, [SCREEN])).toEqual({ width: 1000, height: 700, maximized: false });
  });
  test('no display information keeps the size only', () => {
    expect(fitWindowState({ x: 1, y: 2, width: 1000, height: 700, maximized: false }, [])).toEqual({ width: 1000, height: 700, maximized: false });
  });
});

describe('window-state.json', () => {
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });
  test('written privately, read back; a missing or broken file reads as none', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'alp-window-state-'));
    expect(await readWindowState(dir)).toBeUndefined();
    writeWindowState(dir, stateOf({ x: 1.2, y: 2, width: 900, height: 600 }, false));
    expect(await readWindowState(dir)).toEqual({ x: 1, y: 2, width: 900, height: 600, maximized: false });
    expect((await stat(path.join(dir, 'window-state.json'))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(path.join(dir, 'window-state.json'), 'utf8')).width).toBe(900);
    await writeFile(path.join(dir, 'window-state.json'), '{nope');
    expect(await readWindowState(dir)).toBeUndefined();
  });
});
