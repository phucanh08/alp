// @ts-check
/**
 * The workspace layout kept across reloads, as Paseo's `workspace-layout-state` store keeps each
 * workspace's tabs and their order, and its panel widths: one versioned localStorage key, read
 * tolerantly (garbage or another version gives an empty layout), written with known fields only.
 *
 * Per workspace (scoped by gateway address and workspace path): the open session, the other
 * agent tabs of that session, the task and panel tabs, the tabs' order (tab keys, see
 * app/tabs.tsx), the active tab and, once the center is split, its panes (lib/panes.js: the split
 * tree, which pane each tab sits in and shows, the focused pane). Widths: the sidebar and the explorer dock. Ids only: no
 * token, no titles, nothing else the host sent.
 */

import { parsePanes } from './panes.js';

export const LAYOUT_KEY = 'alp-web:layout';
export const LAYOUT_VERSION = 1;
export const PANEL_KINDS = /** @type {const} */ (['changes', 'terminal', 'diff', 'files', 'agents', 'tasks']);

/** Paseo's sidebar and explorer widths (px): default, minimum, maximum. */
export const SIDEBAR_WIDTH = Object.freeze({ initial: 320, min: 200, max: 600 });
export const DOCK_WIDTH = Object.freeze({ initial: 320, min: 240, max: 720 });

const MAX_WORKSPACES = 20;
const MAX_TABS = 50;
const ID_CHARS = 300;

/**
 * @typedef {{ session?: string, agents: string[], tasks: string[], panels: string[], order: string[], active?: string, panes?: import('./panes.js').Panes, at: number }} WorkspaceTabs
 * @typedef {{ sidebarWidth?: number, dockWidth?: number, workspaces: Record<string, WorkspaceTabs> }} Layout
 * @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void }} LayoutStorage
 */

/** @param {unknown} value */
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
/** @param {unknown} value */
const id = value => typeof value === 'string' && value.trim() && value.length <= ID_CHARS ? value : undefined;
/** @param {unknown} value @param {(entry: string) => boolean} [keep] */
const ids = (value, keep = () => true) => Array.isArray(value)
  ? [...new Set(value.map(id).filter(/** @returns {entry is string} */ entry => !!entry && keep(entry)))].slice(0, MAX_TABS)
  : [];

/** A width within its bounds, or undefined. @param {unknown} value @param {{ min: number, max: number }} bounds */
export function clampWidth(value, bounds) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.round(Math.min(bounds.max, Math.max(bounds.min, value)));
}

/** The key one workspace's tabs are kept under. @param {string} gateway @param {string} workspace */
export const workspaceScope = (gateway, workspace) => `${gateway}\n${workspace}`;

/** @param {unknown} value @returns {WorkspaceTabs | undefined} */
function parseWorkspace(value) {
  if (!isRecord(value)) return undefined;
  const record = /** @type {Record<string, unknown>} */ (value);
  const session = id(record.session);
  const active = id(record.active);
  const panes = parsePanes(record.panes);
  return {
    ...(session ? { session } : {}),
    agents: session ? ids(record.agents, entry => entry !== session) : [],
    tasks: ids(record.tasks),
    panels: ids(record.panels, entry => /** @type {readonly string[]} */ (PANEL_KINDS).includes(entry)),
    order: ids(record.order),
    ...(active ? { active } : {}),
    ...(panes ? { panes } : {}),
    at: typeof record.at === 'number' && Number.isFinite(record.at) ? record.at : 0,
  };
}

/** The layout from what storage holds. Never throws. @param {unknown} raw @returns {Layout} */
export function parseLayout(raw) {
  /** @type {Layout} */
  const empty = { workspaces: {} };
  if (typeof raw !== 'string' || !raw) return empty;
  let value;
  try { value = JSON.parse(raw); } catch { return empty; }
  if (!isRecord(value) || value.v !== LAYOUT_VERSION) return empty;
  /** @type {Record<string, WorkspaceTabs>} */
  const workspaces = {};
  if (isRecord(value.workspaces)) {
    const entries = Object.entries(/** @type {Record<string, unknown>} */ (value.workspaces))
      .map(([scope, entry]) => /** @type {const} */ ([scope, parseWorkspace(entry)]))
      .filter(([scope, entry]) => scope.length <= 2 * ID_CHARS && entry)
      .sort((a, b) => (b[1]?.at ?? 0) - (a[1]?.at ?? 0))
      .slice(0, MAX_WORKSPACES);
    for (const [scope, entry] of entries) if (entry) workspaces[scope] = entry;
  }
  const sidebarWidth = clampWidth(value.sidebarWidth, SIDEBAR_WIDTH);
  const dockWidth = clampWidth(value.dockWidth, DOCK_WIDTH);
  return { ...(sidebarWidth ? { sidebarWidth } : {}), ...(dockWidth ? { dockWidth } : {}), workspaces };
}

/** The string stored for `layout`: its known fields only, re-validated. @param {Layout} layout */
export function serializeLayout(layout) {
  const clean = parseLayout(JSON.stringify({ ...layout, v: LAYOUT_VERSION }));
  return JSON.stringify({ v: LAYOUT_VERSION, ...clean });
}

/** @param {LayoutStorage | undefined} storage @returns {Layout} */
export function loadLayout(storage) {
  if (!storage) return { workspaces: {} };
  try { return parseLayout(storage.getItem(LAYOUT_KEY)); } catch { return { workspaces: {} }; }
}

/**
 * Reads, changes and writes the layout in one go, so two parts of the page (tabs, widths) never
 * overwrite each other's fields. False when storage refused.
 * @param {LayoutStorage | undefined} storage @param {(layout: Layout) => Layout} change
 */
export function updateLayout(storage, change) {
  if (!storage) return false;
  try { storage.setItem(LAYOUT_KEY, serializeLayout(change(loadLayout(storage)))); return true; } catch { return false; }
}

/** The saved tabs of one workspace, or undefined. @param {Layout} layout @param {string} scope */
export const workspaceTabs = (layout, scope) => layout.workspaces[scope];

/**
 * `tabs` in the user's order: the keys in `order` first, as ordered; the others after them, in
 * their own order (a tab opened since goes at the end, as Paseo appends it).
 * @template T @param {T[]} tabs @param {(tab: T) => string} key @param {string[]} order @returns {T[]}
 */
export function orderTabs(tabs, key, order) {
  const at = new Map(order.map((entry, index) => [entry, index]));
  return tabs
    .map((tab, index) => ({ tab, index, rank: at.get(key(tab)) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map(entry => entry.tab);
}

/**
 * `keys` with `moved` placed at `to` (an index into the result). Unknown key: unchanged.
 * @param {string[]} keys @param {string} moved @param {number} to
 */
export function moveKey(keys, moved, to) {
  const from = keys.indexOf(moved);
  if (from < 0) return keys;
  const rest = keys.filter(entry => entry !== moved);
  const index = Math.max(0, Math.min(rest.length, to));
  return [...rest.slice(0, index), moved, ...rest.slice(index)];
}
