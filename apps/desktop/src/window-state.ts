/**
 * The window's size and place across launches (t-0166), as Paseo keeps them (settings/window-state.js):
 * <userData>/window-state.json holds the last bounds and whether the window was maximized. A saved
 * place is used only while enough of the window lands on a display that is connected now; otherwise
 * the size is kept, shrunk to the display, and the system places the window.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_WIDTH = 1280;
export const DEFAULT_HEIGHT = 820;
export const MIN_WIDTH = 720;
export const MIN_HEIGHT = 480;
/** The least of the window that must stay on a display for its saved place to count. */
const MIN_VISIBLE_WIDTH = 100;
const MIN_VISIBLE_HEIGHT = 80;
const FILE = 'window-state.json';

export type Rect = { x: number; y: number; width: number; height: number };
export type WindowState = { width: number; height: number; x?: number; y?: number; maximized: boolean };

const finite = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined);

/** A saved state read back, or undefined for anything that is not one. A half-known place is dropped. */
export function coerceWindowState(input: unknown): WindowState | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  const width = finite(value.width);
  const height = finite(value.height);
  if (width === undefined || height === undefined || width <= 0 || height <= 0) return undefined;
  const state: WindowState = { width: Math.max(MIN_WIDTH, width), height: Math.max(MIN_HEIGHT, height), maximized: value.maximized === true };
  const x = finite(value.x);
  const y = finite(value.y);
  if (x !== undefined && y !== undefined) { state.x = x; state.y = y; }
  return state;
}

/**
 * `state` fitted to the displays' work areas (the primary one first): the saved place is kept only on the
 * display that shows the most of the window, and only if at least 100×80 of it is there; the size never
 * exceeds the chosen display, and a place that would push the window off it is moved back in.
 */
export function fitWindowState(state: WindowState, workAreas: Rect[]): WindowState {
  const primary = workAreas[0];
  if (!primary) return { width: state.width, height: state.height, maximized: state.maximized };
  let target = primary;
  let placed = false;
  if (state.x !== undefined && state.y !== undefined) {
    const { x, y } = state;
    let best = 0;
    for (const area of workAreas) {
      const overlapWidth = Math.max(0, Math.min(x + state.width, area.x + area.width) - Math.max(x, area.x));
      const overlapHeight = Math.max(0, Math.min(y + state.height, area.y + area.height) - Math.max(y, area.y));
      const visible = overlapWidth >= Math.min(MIN_VISIBLE_WIDTH, state.width) && overlapHeight >= Math.min(MIN_VISIBLE_HEIGHT, state.height);
      if (visible && overlapWidth * overlapHeight > best) { best = overlapWidth * overlapHeight; target = area; placed = true; }
    }
  }
  const width = Math.min(Math.max(state.width, Math.min(MIN_WIDTH, target.width)), target.width);
  const height = Math.min(Math.max(state.height, Math.min(MIN_HEIGHT, target.height)), target.height);
  const fitted: WindowState = { width, height, maximized: state.maximized };
  if (placed) {
    fitted.x = Math.min(Math.max(state.x!, target.x), target.x + target.width - width);
    fitted.y = Math.min(Math.max(state.y!, target.y), target.y + target.height - height);
  }
  return fitted;
}

/** The saved state, or undefined when there is none or it cannot be read. */
export async function readWindowState(userData: string): Promise<WindowState | undefined> {
  try { return coerceWindowState(JSON.parse(await readFile(path.join(userData, FILE), 'utf8'))); } catch { return undefined; }
}

/**
 * Saves `state` through a temporary file and a rename, so a crash never leaves half a file. Synchronous:
 * it runs as the window closes, also when the app quits, which would not wait for a pending write.
 */
export function writeWindowState(userData: string, state: WindowState): void {
  mkdirSync(userData, { recursive: true });
  const file = path.join(userData, FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    renameSync(temporary, file);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

/** The state to save for a window: its normal (unmaximized) bounds and whether it is maximized. */
export function stateOf(bounds: Rect, maximized: boolean): WindowState {
  return { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height), maximized };
}
