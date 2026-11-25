/**
 * The app's own preferences, as Paseo keeps its app settings (`@paseo:app-settings`) and its
 * new-agent form choices (`create-agent-preferences`): kept in the browser's storage under one
 * versioned key, read tolerantly (a field that does not parse falls back to its default on its
 * own; another version or garbage gives the defaults and is overwritten on the next save).
 *
 * Only these fields are ever written: no access token, gateway address or anything the host
 * sent. `serializePreferences` builds the stored object field by field from the parsed value, so
 * an extra property on the input cannot reach storage.
 */

import { parseShortcutOverrides } from './shortcuts.js';

export const PREFERENCES_KEY = 'alp-web:preferences';
export const PREFERENCES_VERSION = 1;

/** Paseo's Default send: what sending does while the agent works.
 */
export type SendBehavior = 'interrupt' | 'steer' | 'queue';
/** Paseo's Send shortcut: Enter, or Cmd/Ctrl+Enter (Enter is then a new line).
 */
export type SendShortcut = 'enter' | 'mod-enter';
/** Paseo's themes ("system" is Paseo's "auto").
 */
export type ThemePreference = 'system' | 'light' | 'dark' | 'zinc' | 'midnight' | 'claude' | 'ghostty' | 'pureBlack';
/** Paseo's Chat display: how much of an agent's work the chat shows.
 */
export type ChatDisplay = 'full' | 'collapseToolCalls' | 'collapseTurns';
/** Paseo's syntax highlight themes (@getpaseo/highlight SYNTAX_THEME_OPTIONS).
 */
export type SyntaxTheme = 'github' | 'catppuccin' | 'dracula' | 'tokyo-night' | 'one' | 'nord' | 'gruvbox' | 'solarized';
/** The sidebar rows Settings › Sidebar orders and shows.
 */
export type SidebarItemId = 'new-session' | 'history' | 'search' | 'schedules' | 'tasks';
export type SidebarItem = { id: SidebarItemId; visible: boolean; };
export type SidebarItems = { header: SidebarItem[]; footer: SidebarItem[]; };
/**
 * Paseo's sidebar Display preferences (components/sidebar/display-preferences): how the
 * Workspaces section groups and sorts its rows, what a row's title is, which facts a row shows
 * under it (Show), what its trailing slot holds and which projects it lists.
 */
export type SidebarDisplay = {
  grouping: 'project' | 'status'; sort: 'created' | 'lastPrompt'; titleSource: 'title' | 'branch';
  rowItems: { branch: boolean; project: boolean; host: boolean; labels: boolean; };
  trailing: 'timestamp' | 'none'; projectFilters: string[];
  revision?: 2;
};
/**
 * The last choices of the New session screen, as Paseo remembers provider, model, mode and the
 * thinking option per model. Empty strings never stored: absent means the host's default.
 */
export type NewSessionChoices = { team?: string; mode?: string; model?: string; thinkingByModel?: Record<string, string>; };
/**
 * Paseo 0.14's app settings that apply in a browser (hooks/use-settings/storage.ts), with its
 * defaults and limits. `contentMaxWidth` null follows the default width, 'full' has none (Paseo's
 * contentWidth: Default, Wide 1200 px, Full; any other number a custom width kept from before).
 * `openInSidePane` (Paseo's Open location): whether a file from the Files panel, a change from
 * Changes, or a file from a chat opens in a pane on the side instead of the main one.
 */
export type Preferences = {
  sendBehavior: SendBehavior; sendShortcut: SendShortcut; theme: ThemePreference;
  uiFontFamily: string; monoFontFamily: string; uiFontSize: number; contentFontSize: number; codeFontSize: number;
  contentMaxWidth: number | null | 'full'; syntaxTheme: SyntaxTheme;
  chatDisplay: ChatDisplay; chatOutline: boolean; terminalScrollback: number; notificationSound: boolean;
  openInSidePane: OpenInSidePane;
  sidebar: SidebarItems; sidebarDisplay: SidebarDisplay; newSession: NewSessionChoices;
  shortcutOverrides: import('./shortcuts.js').ShortcutOverrides;
};

export const SEND_BEHAVIORS = ['interrupt', 'steer', 'queue'] as const;
export const SEND_SHORTCUTS = ['enter', 'mod-enter'] as const;
export const THEMES = ['system', 'light', 'dark', 'zinc', 'midnight', 'claude', 'ghostty', 'pureBlack'] as const;
export const CHAT_DISPLAYS = ['full', 'collapseToolCalls', 'collapseTurns'] as const;
/** Paseo's Open location sources ALP has (hooks/use-settings/storage.ts OpenInSidePanePreferences). */
export const OPEN_IN_SIDE_PANE_SOURCES = ['explorerFiles', 'diffs', 'chatFiles'] as const;
export type OpenInSidePane = Record<typeof OPEN_IN_SIDE_PANE_SOURCES[number], boolean>;
/** Paseo's content width presets: Default is LIMITS.contentMaxWidth's default, Wide 1200 px, Full none. */
export const CONTENT_WIDTH_WIDE = 1200;
export const SYNTAX_THEMES = ['github', 'catppuccin', 'dracula', 'tokyo-night', 'one', 'nord', 'gruvbox', 'solarized'] as const;

/** Paseo's limits (storage.ts): [min, max, default]. */
export const LIMITS = Object.freeze({
  uiFontSize: [10, 21, 14],
  contentFontSize: [10, 21, 15],
  codeFontSize: [9, 22, 12],
  contentMaxWidth: [600, 4000, 820],
  terminalScrollback: [0, 1_000_000, 10_000],
});
export const MAX_FONT_FAMILY_LENGTH = 200;

/**
 * Paseo's sidebar sections: the header rows on, the footer's off until chosen. `schedules` shows for
 * the host owner only (the sidebar and Settings › Sidebar leave it out for anyone else); a stored
 * list without it gets it appended, visible.
 */
export const SIDEBAR_ITEMS = Object.freeze({ header: ['new-session', 'history', 'search', 'schedules'] as SidebarItemId[], footer: ['tasks'] as SidebarItemId[] });
const SIDEBAR_HIDDEN_BY_DEFAULT = new Set(['tasks']);
const defaultSidebarSection = (section: 'header' | 'footer') => SIDEBAR_ITEMS[section].map(id => ({ id, visible: !SIDEBAR_HIDDEN_BY_DEFAULT.has(id) }));

/**
 * Paseo's defaults (sidebar-view-store, row-items.ts, storage.ts), with the row items Paseo's sidebar
 * shows: branch on, host off, no trailing time (t-ff83; until then ALP showed host and the time).
 * A stored choice is kept as stored: only a value never saved takes these.
 */
export const DEFAULT_SIDEBAR_DISPLAY = Object.freeze({
  grouping: 'project', sort: 'created', titleSource: 'title',
  rowItems: Object.freeze({ branch: true, project: false, host: false, labels: true }),
  trailing: 'none', projectFilters: [] as string[],
  revision: 2 as 2,
} as SidebarDisplay);
/**
 * ALP's Show defaults before t-ff83. A stored display from before `revision: 2` that still equals
 * them exactly (its user never changed it) moves to Paseo's defaults once; any other stored display
 * stays as stored, and from `revision: 2` on an exact match is a choice and is kept.
 */
const PREVIOUS_SIDEBAR_DISPLAY = Object.freeze({
  grouping: 'project', sort: 'created', titleSource: 'title',
  rowItems: Object.freeze({ branch: false, project: false, host: true, labels: true }),
  trailing: 'timestamp', projectFilters: Object.freeze([]),
});
const MAX_PROJECT_FILTERS = 64;

function parseSidebarDisplay(value: unknown): SidebarDisplay {
  // any: stored or host JSON of any shape; every field is checked where it is read.
  const row = isRecord(value) ? (value as Record<string, any>) : {};
  const items = isRecord(row.rowItems) ? row.rowItems : {};
  const defaults = DEFAULT_SIDEBAR_DISPLAY;
  const display: SidebarDisplay = {
    grouping: row.grouping === 'status' ? 'status' : 'project',
    sort: row.sort === 'lastPrompt' ? 'lastPrompt' : 'created',
    titleSource: row.titleSource === 'branch' ? 'branch' : 'title',
    rowItems: Object.fromEntries(Object.entries(defaults.rowItems).map(([key, fallback]) => [key, typeof items[key] === 'boolean' ? items[key] : fallback])) as SidebarDisplay['rowItems'],
    trailing: row.trailing === 'none' || row.trailing === 'timestamp' ? row.trailing : defaults.trailing,
    projectFilters: [...new Set(Array.isArray(row.projectFilters) ? row.projectFilters.filter(path => typeof path === 'string' && path && path.length <= 4096) : [])].slice(0, MAX_PROJECT_FILTERS),
    revision: 2,
  };
  const previous = PREVIOUS_SIDEBAR_DISPLAY;
  const untouched = row.revision !== 2 && isRecord(value)
    && display.grouping === previous.grouping && display.sort === previous.sort && display.titleSource === previous.titleSource
    && display.trailing === previous.trailing && !display.projectFilters.length
    && Object.entries(previous.rowItems).every(([key, on]) => display.rowItems[(key as keyof SidebarDisplay['rowItems'])] === on);
  return untouched ? { ...defaults, rowItems: { ...defaults.rowItems }, projectFilters: [] } : display;
}

export const DEFAULT_PREFERENCES: Preferences = Object.freeze({
  sendBehavior: 'steer', sendShortcut: 'enter', theme: 'system',
  uiFontFamily: '', monoFontFamily: '', uiFontSize: 14, contentFontSize: 15, codeFontSize: 12,
  contentMaxWidth: null, syntaxTheme: 'one',
  chatDisplay: 'collapseTurns', chatOutline: true, terminalScrollback: 10_000,
  // Paseo's Settings › Notifications › Play sound (on by default): a notification plays the system's sound.
  notificationSound: true,
  openInSidePane: Object.freeze({ explorerFiles: false, diffs: false, chatFiles: false }),
  sidebar: Object.freeze({ header: defaultSidebarSection('header'), footer: defaultSidebarSection('footer') }),
  sidebarDisplay: DEFAULT_SIDEBAR_DISPLAY,
  newSession: Object.freeze({}),
  // Paseo's Settings › Shortcuts: the user's keys by binding id, null for a cleared one (lib/shortcuts.ts).
  shortcutOverrides: Object.freeze({}),
});

/** A whole number within [min, max] (clamped, as Paseo's clampedNumber), else the default. */
function clamped(value: unknown, [min, max, fallback]: readonly number[]) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/**
 * A font family as typed (trimmed, at most 200 characters), else "": no CSS-breaking characters,
 * and no parentheses, so no CSS function (url(), var(), env(), attr()...) reaches the stylesheet;
 * a font stack is names and generic families only.
 */
function fontFamily(value: unknown) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= MAX_FONT_FAMILY_LENGTH && !/[;{}<>\\()]/.test(trimmed) ? trimmed : '';
}

/** One sidebar section: the known rows in the stored order, any missing one at its default. */
function parseSidebarSection(value: unknown, section: 'header' | 'footer') {
  const known = SIDEBAR_ITEMS[section];
  const rows: SidebarItem[] = [];
  for (const row of Array.isArray(value) ? value : []) {
    if (isRecord(row) && known.includes(row.id) && !rows.some(kept => kept.id === row.id)) rows.push({ id: row.id, visible: typeof row.visible === 'boolean' ? row.visible : !SIDEBAR_HIDDEN_BY_DEFAULT.has(row.id) });
  }
  for (const missing of defaultSidebarSection(section)) if (!rows.some(row => row.id === missing.id)) rows.push(missing);
  return rows;
}

const ID_CHARS = 200;
const MAX_THINKING_ENTRIES = 64;

const isRecord = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
/** A short, non-blank id-like string, or undefined. */
const id = (value: unknown) => typeof value === 'string' && value.trim() && value.length <= ID_CHARS ? value : undefined;

function parseNewSession(value: unknown): NewSessionChoices {
  if (!isRecord(value)) return {};
  const record = value as Record<string, unknown>;
  const choices: NewSessionChoices = {};
  for (const key of (['team', 'mode', 'model'] as const)) {
    const parsed = id(record[key]);
    if (parsed) choices[key] = parsed;
  }
  if (isRecord(record.thinkingByModel)) {
    const thinking: Record<string, string> = {};
    for (const [model, effort] of Object.entries(record.thinkingByModel as Record<string, unknown>).slice(0, MAX_THINKING_ENTRIES)) {
      const parsed = id(effort);
      // A model named after an Object.prototype member (`__proto__`, `constructor`) is dropped:
      // as a key it would set the prototype or shadow Object's own, and no model is named so.
      if (id(model) && parsed && !Object.hasOwn(Object.prototype, model)) thinking[model] = parsed;
    }
    if (Object.keys(thinking).length) choices.thinkingByModel = thinking;
  }
  return choices;
}

/** Preferences from what storage holds (a string, or null when nothing is stored). Never throws. */
export function parsePreferences(raw: unknown): Preferences {
  const defaults = () => ({ ...DEFAULT_PREFERENCES, sidebar: { header: defaultSidebarSection('header'), footer: defaultSidebarSection('footer') }, sidebarDisplay: parseSidebarDisplay(null), newSession: {} });
  if (typeof raw !== 'string' || !raw) return defaults();
  let value;
  try { value = JSON.parse(raw); } catch { return defaults(); }
  if (!isRecord(value) || value.v !== PREFERENCES_VERSION) return defaults();
  // any: a key checked against `allowed` just before; the defaults are read by that same key.
  const pick = (allowed: readonly string[], key: string) => allowed.includes(value[key]) ? value[key] : (DEFAULT_PREFERENCES as any)[key];
  const sidebar = isRecord(value.sidebar) ? value.sidebar : {};
  return {
    sendBehavior: pick(SEND_BEHAVIORS, 'sendBehavior'),
    sendShortcut: pick(SEND_SHORTCUTS, 'sendShortcut'),
    theme: pick(THEMES, 'theme'),
    uiFontFamily: fontFamily(value.uiFontFamily),
    monoFontFamily: fontFamily(value.monoFontFamily),
    uiFontSize: clamped(value.uiFontSize, LIMITS.uiFontSize),
    contentFontSize: clamped(value.contentFontSize, LIMITS.contentFontSize),
    codeFontSize: clamped(value.codeFontSize, LIMITS.codeFontSize),
    contentMaxWidth: value.contentMaxWidth === 'full' ? 'full' : typeof value.contentMaxWidth === 'number' && Number.isFinite(value.contentMaxWidth) ? clamped(value.contentMaxWidth, LIMITS.contentMaxWidth) : null,
    syntaxTheme: pick(SYNTAX_THEMES, 'syntaxTheme'),
    chatDisplay: pick(CHAT_DISPLAYS, 'chatDisplay'),
    chatOutline: typeof value.chatOutline === 'boolean' ? value.chatOutline : DEFAULT_PREFERENCES.chatOutline,
    terminalScrollback: clamped(value.terminalScrollback, LIMITS.terminalScrollback),
    notificationSound: typeof value.notificationSound === 'boolean' ? value.notificationSound : DEFAULT_PREFERENCES.notificationSound,
    openInSidePane: Object.fromEntries(OPEN_IN_SIDE_PANE_SOURCES.map(source => [source, isRecord(value.openInSidePane) && value.openInSidePane[source] === true])) as OpenInSidePane,
    sidebar: { header: parseSidebarSection(sidebar.header, 'header'), footer: parseSidebarSection(sidebar.footer, 'footer') },
    sidebarDisplay: parseSidebarDisplay(value.sidebarDisplay),
    newSession: parseNewSession(value.newSession),
    shortcutOverrides: parseShortcutOverrides(value.shortcutOverrides),
  };
}

/** The fields stored, in order: the known ones only, never anything else on the object. */
const STORED_FIELDS = ['sendBehavior', 'sendShortcut', 'theme', 'uiFontFamily', 'monoFontFamily', 'uiFontSize', 'contentFontSize', 'codeFontSize', 'contentMaxWidth', 'syntaxTheme', 'chatDisplay', 'chatOutline', 'terminalScrollback', 'notificationSound', 'openInSidePane', 'sidebar', 'sidebarDisplay', 'newSession', 'shortcutOverrides'] as const;

/** The string stored for `preferences`: its known fields only, re-validated. */
export function serializePreferences(preferences: Preferences): string {
  const clean = parsePreferences(JSON.stringify({ ...preferences, v: PREFERENCES_VERSION }));
  return JSON.stringify({ v: PREFERENCES_VERSION, ...Object.fromEntries(STORED_FIELDS.map(key => [key, clean[key]])) });
}

export type PreferenceStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; };

/** Reads the preferences from `storage`; storage that throws (disabled, private mode) gives the defaults. */
export function loadPreferences(storage: PreferenceStorage | undefined) {
  if (!storage) return parsePreferences(null);
  try { return parsePreferences(storage.getItem(PREFERENCES_KEY)); } catch { return parsePreferences(null); }
}

/** Writes the preferences; false when storage refused (full, disabled). */
export function savePreferences(storage: PreferenceStorage | undefined, preferences: Preferences) {
  if (!storage) return false;
  try { storage.setItem(PREFERENCES_KEY, serializePreferences(preferences)); return true; } catch { return false; }
}

/**
 * The choices to remember after a session started with them: empty fields forget the choice,
 * a thinking option is kept per model (the team default model counts as model "").
 */
export function rememberChoices(current: NewSessionChoices, used: { team?: string; mode?: string; model?: string; thinking?: string; }): NewSessionChoices {
  const thinkingByModel = { ...(current.thinkingByModel ?? {}) };
  const modelKey = used.model || 'default';
  if (used.thinking) thinkingByModel[modelKey] = used.thinking;
  else delete thinkingByModel[modelKey];
  return parseNewSession({ team: used.team, mode: used.mode, model: used.model, thinkingByModel });
}
