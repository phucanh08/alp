import type { LayoutStorage } from '../lib/layout.js';

/** The browser's localStorage for the workspace layout (lib/layout.js), when the page may use it. */
export function layoutStorage(): LayoutStorage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}
