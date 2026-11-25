/**
 * The Files panel's choices kept across reloads, as Paseo's panel-store persists them
 * (stores/panel-store at v0.17.3: explorerSortOption, explorerShowHiddenFiles and
 * expandedPathsByWorkspace): the sort and the hidden-files toggle for every workspace, and the open
 * folders of each workspace on its own. One versioned localStorage key, read tolerantly (a bad
 * field falls back to its default on its own; garbage or another version gives the defaults and is
 * overwritten on the next save), written with these fields only.
 *
 * A workspace is keyed as the workspace layout keys it (lib/layout.ts workspaceScope: gateway
 * address and workspace path), so two hosts with the same workspace path keep their folders apart.
 * Paseo keys by workspace id within one server's store; ALP's dashboard holds no id across
 * gateways, and the path is what the panel already scopes by.
 *
 * Folders are workspace-relative paths (never blocked ones), bounded in length and number; at most
 * MAX_WORKSPACES workspaces are kept, the least recently changed dropped first. A folder kept here
 * that is gone from the host is listed once more on reload and, its parent no longer holding it,
 * not shown (lib/file-tree.ts flattenTree walks only entries a listing returned).
 */

import { blockedFilePath } from '@anhlp/alp-protocol';
import { SORT_OPTIONS, relativeFilePath } from './file-tree.js';

export const FILES_PANEL_KEY = 'alp-web:files-panel';
export const FILES_PANEL_VERSION = 1;

export const MAX_WORKSPACES = 50;
export const MAX_EXPANDED = 200;
export const MAX_PATH_CHARS = 1024;
// A workspace key: gateway address, a newline, the workspace path.
const MAX_SCOPE_CHARS = 2048;

export type SortOption = import('./file-tree.js').SortOption;
export type WorkspaceFolders = { expanded: string[], at: number };
export type FilesPanelState = { sort: SortOption, showHidden: boolean, workspaces: Record<string, WorkspaceFolders> };
export type FilesPanelStorage = { getItem(key: string): string | null, setItem(key: string, value: string): void };

/** ALP's defaults: sorted by name, hidden files off (ALP's toggle also lists .gitignored files; Paseo's is on). */
export const DEFAULT_SORT = 'name' as SortOption;
export const DEFAULT_SHOW_HIDDEN = false;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A folder path safe to keep: workspace-relative, clean, not blocked, within MAX_PATH_CHARS. */
const keptPath = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_PATH_CHARS && relativeFilePath(value) === value && !blockedFilePath(value);

export function parseExpanded(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  // The last ones: a folder opened since is appended (lib/file-tree.ts toggleExpanded).
  return [...new Set(value.filter(keptPath))].slice(-MAX_EXPANDED);
}

const defaults = (): FilesPanelState => ({ sort: DEFAULT_SORT, showHidden: DEFAULT_SHOW_HIDDEN, workspaces: {} });

/** The state from what storage holds (a string, or null). Never throws. */
export function parseFilesPanelState(raw: unknown): FilesPanelState {
  if (typeof raw !== 'string' || !raw) return defaults();
  let value;
  try { value = JSON.parse(raw); } catch { return defaults(); }
  if (!isRecord(value) || value.v !== FILES_PANEL_VERSION) return defaults();
  const workspaces: Array<[string, WorkspaceFolders]> = [];
  for (const [scope, entry] of Object.entries(isRecord(value.workspaces) ? value.workspaces : {})) {
    if (!scope || scope.length > MAX_SCOPE_CHARS || !isRecord(entry)) continue;
    const expanded = parseExpanded(entry.expanded);
    if (!expanded.length) continue;
    workspaces.push([scope, { expanded, at: typeof entry.at === 'number' && Number.isFinite(entry.at) ? entry.at : 0 }]);
  }
  return {
    sort: (SORT_OPTIONS as readonly unknown[]).includes(value.sort) ? (value.sort as SortOption) : DEFAULT_SORT,
    showHidden: typeof value.showHidden === 'boolean' ? value.showHidden : DEFAULT_SHOW_HIDDEN,
    workspaces: Object.fromEntries(workspaces.sort((a, b) => b[1].at - a[1].at).slice(0, MAX_WORKSPACES)),
  };
}

/** The stored string: the known fields only, re-validated. */
export function serializeFilesPanelState(state: FilesPanelState) {
  const clean = parseFilesPanelState(JSON.stringify({ ...state, v: FILES_PANEL_VERSION }));
  return JSON.stringify({ v: FILES_PANEL_VERSION, sort: clean.sort, showHidden: clean.showHidden, workspaces: clean.workspaces });
}

/** Reads the state; storage that is missing or throws gives the defaults. */
export function loadFilesPanelState(storage: FilesPanelStorage | undefined) {
  if (!storage) return defaults();
  try { return parseFilesPanelState(storage.getItem(FILES_PANEL_KEY)); } catch { return defaults(); }
}

/**
 * Reads, changes and writes in one go (another tab's or panel's change since is kept); the new
 * state, or null when storage refused.
 */
export function updateFilesPanelState(storage: FilesPanelStorage | undefined, change: (state: FilesPanelState) => FilesPanelState) {
  if (!storage) return null;
  try {
    const text = serializeFilesPanelState(change(loadFilesPanelState(storage)));
    storage.setItem(FILES_PANEL_KEY, text);
    return parseFilesPanelState(text);
  } catch { return null; }
}

/** The open folders kept for a workspace. */
export const expandedFor = (state: FilesPanelState, scope: string): string[] => [...(state.workspaces[scope]?.expanded ?? [])];

/**
 * `state` with a workspace's open folders replaced (none: the workspace is forgotten) and marked
 * as changed at `now`.
 */
export function withExpanded(state: FilesPanelState, scope: string, expanded: readonly string[], now: number = Date.now()): FilesPanelState {
  const { [scope]: _previous, ...others } = state.workspaces;
  const kept = parseExpanded(expanded);
  return { ...state, workspaces: kept.length ? { ...others, [scope]: { expanded: kept, at: now } } : others };
}
