// @ts-check
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

export const PREFERENCES_KEY = 'alp-web:preferences';
export const PREFERENCES_VERSION = 1;

/** Paseo's Default send: what sending does while the agent works. @typedef {'interrupt' | 'steer' | 'queue'} SendBehavior */
/** Paseo's Send shortcut: Enter, or Cmd/Ctrl+Enter (Enter is then a new line). @typedef {'enter' | 'mod-enter'} SendShortcut */
/** Paseo's themes ("system" is Paseo's "auto"). @typedef {'system' | 'light' | 'dark' | 'zinc' | 'midnight' | 'claude' | 'ghostty' | 'pureBlack'} ThemePreference */
/** Paseo's Chat display: how much of an agent's work the chat shows. @typedef {'full' | 'collapseToolCalls' | 'collapseTurns'} ChatDisplay */
/** Paseo's syntax highlight themes (@getpaseo/highlight SYNTAX_THEME_OPTIONS). @typedef {'github' | 'catppuccin' | 'dracula' | 'tokyo-night' | 'one' | 'nord' | 'gruvbox' | 'solarized'} SyntaxTheme */
/** The sidebar rows Settings › Sidebar orders and shows. @typedef {'new-session' | 'history' | 'search' | 'tasks'} SidebarItemId */
/** @typedef {{ id: SidebarItemId, visible: boolean }} SidebarItem */
/** @typedef {{ header: SidebarItem[], footer: SidebarItem[] }} SidebarItems */
/**
 * Paseo's sidebar Display preferences (components/sidebar/display-preferences): how the
 * Workspaces section groups and sorts its rows, what a row's title is, which facts a row shows
 * under it (Show), what its trailing slot holds and which projects it lists.
 * @typedef {{
 *   grouping: 'project' | 'status', sort: 'created' | 'lastPrompt', titleSource: 'title' | 'branch',
 *   rowItems: { branch: boolean, project: boolean, host: boolean, labels: boolean },
 *   trailing: 'timestamp' | 'none', projectFilters: string[],
 * }} SidebarDisplay
 */
/**
 * The last choices of the New session screen, as Paseo remembers provider, model, mode and the
 * thinking option per model. Empty strings never stored: absent means the host's default.
 * @typedef {{ team?: string, mode?: string, model?: string, thinkingByModel?: Record<string, string> }} NewSessionChoices
 */
/**
 * Paseo 0.14's app settings that apply in a browser (hooks/use-settings/storage.ts), with its
 * defaults and limits. `contentMaxWidth` null follows the default width.
 * @typedef {{
 *   sendBehavior: SendBehavior, sendShortcut: SendShortcut, theme: ThemePreference,
 *   uiFontFamily: string, monoFontFamily: string, uiFontSize: number, contentFontSize: number, codeFontSize: number,
 *   contentMaxWidth: number | null, syntaxTheme: SyntaxTheme,
 *   chatDisplay: ChatDisplay, chatOutline: boolean, terminalScrollback: number,
 *   sidebar: SidebarItems, sidebarDisplay: SidebarDisplay, newSession: NewSessionChoices,
 * }} Preferences
 */

export const SEND_BEHAVIORS = /** @type {const} */ (['interrupt', 'steer', 'queue']);
export const SEND_SHORTCUTS = /** @type {const} */ (['enter', 'mod-enter']);
export const THEMES = /** @type {const} */ (['system', 'light', 'dark', 'zinc', 'midnight', 'claude', 'ghostty', 'pureBlack']);
export const CHAT_DISPLAYS = /** @type {const} */ (['full', 'collapseToolCalls', 'collapseTurns']);
export const SYNTAX_THEMES = /** @type {const} */ (['github', 'catppuccin', 'dracula', 'tokyo-night', 'one', 'nord', 'gruvbox', 'solarized']);

/** Paseo's limits (storage.ts): [min, max, default]. */
export const LIMITS = Object.freeze({
  uiFontSize: [10, 21, 14],
  contentFontSize: [10, 21, 15],
  codeFontSize: [9, 22, 12],
  contentMaxWidth: [600, 4000, 820],
  terminalScrollback: [0, 1_000_000, 10_000],
});
export const MAX_FONT_FAMILY_LENGTH = 200;

/** Paseo's sidebar sections: the header rows on, the footer's off until chosen. */
export const SIDEBAR_ITEMS = Object.freeze({ header: /** @type {SidebarItemId[]} */ (['new-session', 'history', 'search']), footer: /** @type {SidebarItemId[]} */ (['tasks']) });
const SIDEBAR_HIDDEN_BY_DEFAULT = new Set(['tasks']);
/** @param {'header' | 'footer'} section */
const defaultSidebarSection = section => SIDEBAR_ITEMS[section].map(id => ({ id, visible: !SIDEBAR_HIDDEN_BY_DEFAULT.has(id) }));

/** Paseo's defaults (sidebar-view-store, row-items.ts, storage.ts). */
export const DEFAULT_SIDEBAR_DISPLAY = Object.freeze(/** @type {SidebarDisplay} */ ({
  grouping: 'project', sort: 'created', titleSource: 'title',
  rowItems: Object.freeze({ branch: false, project: false, host: true, labels: true }),
  trailing: 'timestamp', projectFilters: /** @type {string[]} */ ([]),
}));
const MAX_PROJECT_FILTERS = 64;

/** @param {unknown} value @returns {SidebarDisplay} */
function parseSidebarDisplay(value) {
  const row = isRecord(value) ? /** @type {Record<string, any>} */ (value) : {};
  const items = isRecord(row.rowItems) ? row.rowItems : {};
  const defaults = DEFAULT_SIDEBAR_DISPLAY;
  return {
    grouping: row.grouping === 'status' ? 'status' : 'project',
    sort: row.sort === 'lastPrompt' ? 'lastPrompt' : 'created',
    titleSource: row.titleSource === 'branch' ? 'branch' : 'title',
    rowItems: /** @type {SidebarDisplay['rowItems']} */ (Object.fromEntries(Object.entries(defaults.rowItems).map(([key, fallback]) => [key, typeof items[key] === 'boolean' ? items[key] : fallback]))),
    trailing: row.trailing === 'none' ? 'none' : 'timestamp',
    projectFilters: [...new Set(Array.isArray(row.projectFilters) ? row.projectFilters.filter(path => typeof path === 'string' && path && path.length <= 4096) : [])].slice(0, MAX_PROJECT_FILTERS),
  };
}

/** @type {Preferences} */
export const DEFAULT_PREFERENCES = Object.freeze({
  sendBehavior: 'steer', sendShortcut: 'enter', theme: 'system',
  uiFontFamily: '', monoFontFamily: '', uiFontSize: 14, contentFontSize: 15, codeFontSize: 12,
  contentMaxWidth: null, syntaxTheme: 'one',
  chatDisplay: 'collapseTurns', chatOutline: true, terminalScrollback: 10_000,
  sidebar: Object.freeze({ header: defaultSidebarSection('header'), footer: defaultSidebarSection('footer') }),
  sidebarDisplay: DEFAULT_SIDEBAR_DISPLAY,
  newSession: Object.freeze({}),
});

/** A whole number within [min, max] (clamped, as Paseo's clampedNumber), else the default. @param {unknown} value @param {readonly number[]} limits */
function clamped(value, [min, max, fallback]) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

/**
 * A font family as typed (trimmed, at most 200 characters), else "": no CSS-breaking characters,
 * and no parentheses, so no CSS function (url(), var(), env(), attr()...) reaches the stylesheet;
 * a font stack is names and generic families only.
 * @param {unknown} value
 */
function fontFamily(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= MAX_FONT_FAMILY_LENGTH && !/[;{}<>\\()]/.test(trimmed) ? trimmed : '';
}

/** One sidebar section: the known rows in the stored order, any missing one at its default. @param {unknown} value @param {'header' | 'footer'} section */
function parseSidebarSection(value, section) {
  const known = SIDEBAR_ITEMS[section];
  /** @type {SidebarItem[]} */
  const rows = [];
  for (const row of Array.isArray(value) ? value : []) {
    if (isRecord(row) && known.includes(row.id) && !rows.some(kept => kept.id === row.id)) rows.push({ id: row.id, visible: typeof row.visible === 'boolean' ? row.visible : !SIDEBAR_HIDDEN_BY_DEFAULT.has(row.id) });
  }
  for (const missing of defaultSidebarSection(section)) if (!rows.some(row => row.id === missing.id)) rows.push(missing);
  return rows;
}

const ID_CHARS = 200;
const MAX_THINKING_ENTRIES = 64;

/** @param {unknown} value */
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);
/** A short, non-blank id-like string, or undefined. @param {unknown} value */
const id = value => typeof value === 'string' && value.trim() && value.length <= ID_CHARS ? value : undefined;

/** @param {unknown} value @returns {NewSessionChoices} */
function parseNewSession(value) {
  if (!isRecord(value)) return {};
  const record = /** @type {Record<string, unknown>} */ (value);
  /** @type {NewSessionChoices} */
  const choices = {};
  for (const key of /** @type {const} */ (['team', 'mode', 'model'])) {
    const parsed = id(record[key]);
    if (parsed) choices[key] = parsed;
  }
  if (isRecord(record.thinkingByModel)) {
    /** @type {Record<string, string>} */
    const thinking = {};
    for (const [model, effort] of Object.entries(/** @type {Record<string, unknown>} */ (record.thinkingByModel)).slice(0, MAX_THINKING_ENTRIES)) {
      const parsed = id(effort);
      // A model named after an Object.prototype member (`__proto__`, `constructor`) is dropped:
      // as a key it would set the prototype or shadow Object's own, and no model is named so.
      if (id(model) && parsed && !Object.hasOwn(Object.prototype, model)) thinking[model] = parsed;
    }
    if (Object.keys(thinking).length) choices.thinkingByModel = thinking;
  }
  return choices;
}

/**
 * Preferences from what storage holds (a string, or null when nothing is stored). Never throws.
 * @param {unknown} raw @returns {Preferences}
 */
export function parsePreferences(raw) {
  const defaults = () => ({ ...DEFAULT_PREFERENCES, sidebar: { header: defaultSidebarSection('header'), footer: defaultSidebarSection('footer') }, sidebarDisplay: parseSidebarDisplay(null), newSession: {} });
  if (typeof raw !== 'string' || !raw) return defaults();
  let value;
  try { value = JSON.parse(raw); } catch { return defaults(); }
  if (!isRecord(value) || value.v !== PREFERENCES_VERSION) return defaults();
  const pick = (/** @type {readonly string[]} */ allowed, /** @type {string} */ key) => allowed.includes(value[key]) ? value[key] : /** @type {any} */ (DEFAULT_PREFERENCES)[key];
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
    contentMaxWidth: typeof value.contentMaxWidth === 'number' && Number.isFinite(value.contentMaxWidth) ? clamped(value.contentMaxWidth, LIMITS.contentMaxWidth) : null,
    syntaxTheme: pick(SYNTAX_THEMES, 'syntaxTheme'),
    chatDisplay: pick(CHAT_DISPLAYS, 'chatDisplay'),
    chatOutline: typeof value.chatOutline === 'boolean' ? value.chatOutline : DEFAULT_PREFERENCES.chatOutline,
    terminalScrollback: clamped(value.terminalScrollback, LIMITS.terminalScrollback),
    sidebar: { header: parseSidebarSection(sidebar.header, 'header'), footer: parseSidebarSection(sidebar.footer, 'footer') },
    sidebarDisplay: parseSidebarDisplay(value.sidebarDisplay),
    newSession: parseNewSession(value.newSession),
  };
}

/** The fields stored, in order: the known ones only, never anything else on the object. */
const STORED_FIELDS = /** @type {const} */ (['sendBehavior', 'sendShortcut', 'theme', 'uiFontFamily', 'monoFontFamily', 'uiFontSize', 'contentFontSize', 'codeFontSize', 'contentMaxWidth', 'syntaxTheme', 'chatDisplay', 'chatOutline', 'terminalScrollback', 'sidebar', 'sidebarDisplay', 'newSession']);

/**
 * The string stored for `preferences`: its known fields only, re-validated.
 * @param {Preferences} preferences @returns {string}
 */
export function serializePreferences(preferences) {
  const clean = parsePreferences(JSON.stringify({ ...preferences, v: PREFERENCES_VERSION }));
  return JSON.stringify({ v: PREFERENCES_VERSION, ...Object.fromEntries(STORED_FIELDS.map(key => [key, clean[key]])) });
}

/**
 * @typedef {{ getItem(key: string): string | null, setItem(key: string, value: string): void }} PreferenceStorage
 */

/** Reads the preferences from `storage`; storage that throws (disabled, private mode) gives the defaults. @param {PreferenceStorage | undefined} storage */
export function loadPreferences(storage) {
  if (!storage) return parsePreferences(null);
  try { return parsePreferences(storage.getItem(PREFERENCES_KEY)); } catch { return parsePreferences(null); }
}

/** Writes the preferences; false when storage refused (full, disabled). @param {PreferenceStorage | undefined} storage @param {Preferences} preferences */
export function savePreferences(storage, preferences) {
  if (!storage) return false;
  try { storage.setItem(PREFERENCES_KEY, serializePreferences(preferences)); return true; } catch { return false; }
}

/**
 * The choices to remember after a session started with them: empty fields forget the choice,
 * a thinking option is kept per model (the team default model counts as model "").
 * @param {NewSessionChoices} current @param {{ team?: string, mode?: string, model?: string, thinking?: string }} used
 * @returns {NewSessionChoices}
 */
export function rememberChoices(current, used) {
  const thinkingByModel = { ...(current.thinkingByModel ?? {}) };
  const modelKey = used.model || 'default';
  if (used.thinking) thinkingByModel[modelKey] = used.thinking;
  else delete thinkingByModel[modelKey];
  return parseNewSession({ team: used.team, mode: used.mode, model: used.model, thinkingByModel });
}
