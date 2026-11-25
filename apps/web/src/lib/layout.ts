/**
 * The workspace layout kept across reloads, as Paseo's `workspace-layout-state` store keeps each
 * workspace's tabs and their order, and its panel widths: one versioned localStorage key, read
 * tolerantly (garbage or another version gives an empty layout), written with known fields only.
 *
 * Per workspace (scoped by gateway address and workspace path): the open session, the other
 * agent tabs of that session, the task, file and panel tabs, the tabs' order (tab keys, see
 * app/tabs.tsx), the active tab and, once the center is split, its panes (lib/panes.ts: the split
 * tree, which pane each tab sits in and shows, the focused pane), and ALP.app's Browser tabs with the
 * address each shows (lib/browser-url.ts: http, https or about:blank only; never the dashboard's
 * own address). Widths: the sidebar and the explorer dock. Ids only: no token, no titles, nothing
 * else the host sent.
 */

import { blockedFilePath } from '@anhlp/alp-protocol';
import { parsePanes } from './panes.js';
import { relativeFilePath } from './file-tree.js';
import { parseBrowsers } from './browser-url.js';

export const LAYOUT_KEY = 'alp-web:layout';
export const LAYOUT_VERSION = 1;
export const PANEL_KINDS = ['changes', 'terminal', 'diff', 'files', 'agents', 'tasks'] as const;

/** Paseo's sidebar and explorer widths (px): default, minimum, maximum. */
export const SIDEBAR_WIDTH = Object.freeze({ initial: 320, min: 200, max: 600 });
export const DOCK_WIDTH = Object.freeze({ initial: 320, min: 240, max: 720 });

const MAX_WORKSPACES = 20;
const MAX_TABS = 50;
const ID_CHARS = 300;
// A file tab's id is its relative path: longer than other ids, kept within reason.
const PATH_CHARS = 1024;
// A tab key (order, active): `file:` and such a path.
const KEY_CHARS = PATH_CHARS + 5;

export type WorkspaceTabs = { session?: string; agents: string[]; tasks: string[]; files?: string[]; browsers?: Array<{ id: string; url: string; }>; panels: string[]; order: string[]; active?: string; panes?: import('./panes.js').Panes; at: number; };

export type Layout = { sidebarWidth?: number; dockWidth?: number; workspaces: Record<string, WorkspaceTabs>; };

export type LayoutStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; };

const isRecord = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= ID_CHARS ? value : undefined;
const pathId = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= PATH_CHARS ? value : undefined;
const keyId = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= KEY_CHARS ? value : undefined;
const ids = (value: unknown, keep: (entry: string) => boolean = () => true, read: (value: unknown) => string | undefined = id) => Array.isArray(value)
  ? [...new Set(value.map(read).filter((entry): entry is string => !!entry && keep(entry)))].slice(0, MAX_TABS)
  : [];

/** A width within its bounds, or undefined. */
export function clampWidth(value: unknown, bounds: { min: number; max: number; }) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)));
}

/** The key one workspace's tabs are kept under. */
export const workspaceScope = (gateway: string, workspace: string) => `${gateway}\n${workspace}`;

function parseWorkspace(value: unknown): WorkspaceTabs | undefined {
  if (!isRecord(value)) return undefined;
  const record = value as Record<string, unknown>;
  const session = id(record.session);
  const active = keyId(record.active);
  const panes = parsePanes(record.panes);
  // File tabs: workspace-relative paths only, never one the host would refuse as blocked.
  const files = ids(record.files, entry => relativeFilePath(entry) === entry && !blockedFilePath(entry), pathId);
  const browsers = parseBrowsers(record.browsers);
  return {
    ...(session ? { session } : {}),
    agents: session ? ids(record.agents, entry => entry !== session) : [],
    tasks: ids(record.tasks),
    panels: ids(record.panels, entry => (PANEL_KINDS as readonly string[]).includes(entry)),
    order: ids(record.order, undefined, keyId),
    ...(files.length ? { files } : {}),
    ...(browsers.length ? { browsers } : {}),
    ...(active ? { active } : {}),
    ...(panes ? { panes } : {}),
    at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
  };
}

/** The layout from what storage holds. Never throws. */
export function parseLayout(raw: unknown): Layout {
  const empty: Layout = { workspaces: {} };
  if (typeof raw !== 'string' || !raw) return empty;
  let value;
  try { value = JSON.parse(raw); } catch { return empty; }
  if (!isRecord(value) || value.v !== LAYOUT_VERSION) return empty;
  const workspaces: Record<string, WorkspaceTabs> = {};
  if (isRecord(value.workspaces)) {
    const entries = Object.entries(value.workspaces as Record<string, unknown>)
      .map(([scope, entry]) => ([scope, parseWorkspace(entry)] as const))
      .filter(([scope, entry]) => scope.length <= 2 * ID_CHARS && entry)
      .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
      .slice(0, MAX_WORKSPACES);
    for (const [scope, entry] of entries) if (entry) workspaces[scope] = entry;
  }
  const sidebarWidth = clampWidth(value.sidebarWidth, SIDEBAR_WIDTH);
  const dockWidth = clampWidth(value.dockWidth, DOCK_WIDTH);
  return { ...(sidebarWidth ? { sidebarWidth } : {}), ...(dockWidth ? { dockWidth } : {}), workspaces };
}

/** The string stored for `layout`: its known fields only, re-validated. */
export function serializeLayout(layout: Layout) {
  const clean = parseLayout(JSON.stringify({ ...layout, v: LAYOUT_VERSION }));
  return JSON.stringify({ v: LAYOUT_VERSION, ...clean });
}

export function loadLayout(storage: LayoutStorage | undefined): Layout {
  if (!storage) return { workspaces: {} };
  try { return parseLayout(storage.getItem(LAYOUT_KEY)); } catch { return { workspaces: {} }; }
}

/**
 * Reads, changes and writes the layout in one go, so two parts of the page (tabs, widths) never
 * overwrite each other's fields. False when storage refused.
 */
export function updateLayout(storage: LayoutStorage | undefined, change: (layout: Layout) => Layout) {
  if (!storage) return false;
  try { storage.setItem(LAYOUT_KEY, serializeLayout(change(loadLayout(storage)))); return true; } catch { return false; }
}

/** The saved tabs of one workspace, or undefined. */
export const workspaceTabs = (layout: Layout, scope: string) => layout.workspaces[scope];

/**
 * `tabs` in the user's order: the keys in `order` first, as ordered; the others after them, in
 * their own order (a tab opened since goes at the end, as Paseo appends it).
 */
export function orderTabs<T>(tabs: T[], key: (tab: T) => string, order: string[]): T[] {
  const at = new Map(order.map((entry, index) => [entry, index]));
  return tabs
    .map((tab, index) => ({ tab, index, rank: at.get(key(tab)) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(entry => entry.tab);
}

/** `keys` with `moved` placed at `to` (an index into the result). Unknown key: unchanged. */
export function moveKey(keys: string[], moved: string, to: number) {
  const from = keys.indexOf(moved);
  if (from < 0) return keys;
  const rest = keys.filter(entry => entry !== moved);
  const index = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, index), moved, ...rest.slice(index)];
}
