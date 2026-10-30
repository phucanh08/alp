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

/** @typedef {'steer' | 'queue'} SendBehavior */
/** @typedef {'system' | 'light' | 'dark'} ThemePreference */
/**
 * The last choices of the New session screen, as Paseo remembers provider, model, mode and the
 * thinking option per model. Empty strings never stored: absent means the host's default.
 * @typedef {{ team?: string, mode?: string, model?: string, thinkingByModel?: Record<string, string> }} NewSessionChoices
 */
/** @typedef {{ fontSize: number, fontFamily: 'mono' | 'menlo' | 'consolas', theme: 'dark' | 'light' }} TerminalPreferences */
/** Paseo's Appearance › Content width: the chat column's maximum width. @typedef {'default' | 'wide' | 'full'} ContentWidth */
/** Paseo's Chat › tool detail: tool call rows start closed or open. @typedef {'collapsed' | 'expanded'} ToolCallDisplay */
/** @typedef {{ sendBehavior: SendBehavior, theme: ThemePreference, contentWidth: ContentWidth, toolCalls: ToolCallDisplay, newSession: NewSessionChoices, terminal: TerminalPreferences }} Preferences */
export const DEFAULT_TERMINAL_PREFERENCES = Object.freeze(/** @type {TerminalPreferences} */ ({ fontSize: 13, fontFamily: 'mono', theme: 'dark' }));
/** @param {unknown} value @returns {TerminalPreferences} */
function parseTerminal(value) {
  const row = /** @type {any} */ (value && typeof value === 'object' ? value : {});
  return {
    fontSize: Number.isInteger(row.fontSize) && row.fontSize >= 10 && row.fontSize <= 24 ? row.fontSize : 13,
    fontFamily: ['mono', 'menlo', 'consolas'].includes(row.fontFamily) ? row.fontFamily : 'mono',
    theme: row.theme === 'light' ? 'light' : 'dark',
  };
}

export const SEND_BEHAVIORS = /** @type {const} */ (['steer', 'queue']);
export const THEMES = /** @type {const} */ (['system', 'light', 'dark']);
export const CONTENT_WIDTHS = /** @type {const} */ (['default', 'wide', 'full']);
export const TOOL_CALL_DISPLAYS = /** @type {const} */ (['collapsed', 'expanded']);

/** @type {Preferences} */
export const DEFAULT_PREFERENCES = Object.freeze({ sendBehavior: 'steer', theme: 'system', contentWidth: 'default', toolCalls: 'collapsed', newSession: Object.freeze({}), terminal: DEFAULT_TERMINAL_PREFERENCES });

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
      if (id(model) && parsed) thinking[model] = parsed;
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
  if (typeof raw !== 'string' || !raw) return { ...DEFAULT_PREFERENCES, newSession: {} };
  let value;
  try { value = JSON.parse(raw); } catch { return { ...DEFAULT_PREFERENCES, newSession: {} }; }
  if (!isRecord(value) || value.v !== PREFERENCES_VERSION) return { ...DEFAULT_PREFERENCES, newSession: {} };
  return {
    sendBehavior: SEND_BEHAVIORS.includes(value.sendBehavior) ? value.sendBehavior : DEFAULT_PREFERENCES.sendBehavior,
    theme: THEMES.includes(value.theme) ? value.theme : DEFAULT_PREFERENCES.theme,
    contentWidth: CONTENT_WIDTHS.includes(value.contentWidth) ? value.contentWidth : DEFAULT_PREFERENCES.contentWidth,
    toolCalls: TOOL_CALL_DISPLAYS.includes(value.toolCalls) ? value.toolCalls : DEFAULT_PREFERENCES.toolCalls,
    newSession: parseNewSession(value.newSession),
    terminal: parseTerminal(value.terminal),
  };
}

/**
 * The string stored for `preferences`: its known fields only, re-validated.
 * @param {Preferences} preferences @returns {string}
 */
export function serializePreferences(preferences) {
  const clean = parsePreferences(JSON.stringify({ ...preferences, v: PREFERENCES_VERSION }));
  return JSON.stringify({ v: PREFERENCES_VERSION, sendBehavior: clean.sendBehavior, theme: clean.theme, contentWidth: clean.contentWidth, toolCalls: clean.toolCalls, newSession: clean.newSession, terminal: clean.terminal });
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
