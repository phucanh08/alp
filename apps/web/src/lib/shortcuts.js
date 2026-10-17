// Paseo's keyboard shortcuts (packages/app/src/keyboard/keyboard-shortcuts.ts) for the parts of the
// workspace ALP web has: the web build's bindings, with Paseo's labels and sections. "Mod" is Cmd
// on a Mac and Ctrl elsewhere. Keys are matched by their physical code where a modifier changes
// the character (Alt+1 types "¡" on a Mac), so the same keys work on any layout and platform.
//
// Left out, as ALP has no such thing: open project (Cmd+O), search files (Cmd+P), pin, browser
// tabs, split panes, focus mode, themes, voice and dictation.

/** @typedef {'general' | 'workspaces' | 'tabs-panes' | 'layout' | 'agent-input'} SectionId */
/**
 * @typedef {{
 *   action: string,
 *   combo: string,
 *   section?: SectionId,
 *   label?: string,
 *   delta?: 1 | -1,
 *   display?: string[],
 *   scope?: 'other',
 *   handledElsewhere?: boolean,
 *   note?: string,
 * }} Binding
 *   section and label: the row of the shortcuts dialog (a binding without them is an alias).
 *   display: the keys the dialog shows when the combo cannot say it (the 1-9 wildcard).
 *   scope 'other': only when no text field has focus.
 *   handledElsewhere: listed in the dialog; its own component handles it (the composer's keys).
 */

/** @type {Array<{ id: SectionId, title: string }>} */
export const SECTIONS = [
  { id: 'general', title: 'General' },
  { id: 'workspaces', title: 'Projects & Workspaces' },
  { id: 'tabs-panes', title: 'Tabs & Panes' },
  { id: 'layout', title: 'Layout' },
  { id: 'agent-input', title: 'Agent Input' },
];

/** @type {Binding[]} */
export const BINDINGS = [
  { action: 'search', combo: 'Mod+K', section: 'general', label: 'Search sessions' },
  { action: 'shortcuts.toggle', combo: 'Shift+?', section: 'general', label: 'Show keyboard shortcuts', scope: 'other', note: 'Available when focus is not in a text field.' },
  { action: 'settings.toggle', combo: 'Mod+,', section: 'general', label: 'Toggle settings' },

  { action: 'session.new', combo: 'Mod+N', section: 'workspaces', label: 'New session' },
  { action: 'session.archive', combo: 'Mod+Shift+Backspace', section: 'workspaces', label: 'Archive session' },
  { action: 'session.index', combo: 'Alt+Digit', section: 'workspaces', label: 'Jump to session', display: ['alt', '1-9'] },
  { action: 'session.relative', combo: 'Alt+[', delta: -1, section: 'workspaces', label: 'Previous session' },
  { action: 'session.relative', combo: 'Alt+]', delta: 1, section: 'workspaces', label: 'Next session' },

  { action: 'tab.menu', combo: 'Mod+T', section: 'tabs-panes', label: 'New tab' },
  { action: 'tab.agent', combo: 'Mod+Shift+A', section: 'tabs-panes', label: 'New agent' },
  { action: 'tab.changes', combo: 'Mod+Shift+G', section: 'tabs-panes', label: 'Changes' },
  { action: 'tab.files', combo: 'Mod+Shift+E', section: 'tabs-panes', label: 'Files' },
  { action: 'tab.terminal', combo: 'Mod+Shift+T', section: 'tabs-panes', label: 'New terminal' },
  { action: 'tab.close', combo: 'Alt+Shift+W', section: 'tabs-panes', label: 'Close current tab' },
  { action: 'tab.index', combo: 'Alt+Shift+Digit', section: 'tabs-panes', label: 'Jump to tab', display: ['alt', 'shift', '1-9'] },
  { action: 'tab.relative', combo: 'Alt+Shift+[', delta: -1, section: 'tabs-panes', label: 'Previous tab' },
  { action: 'tab.relative', combo: 'Alt+Shift+]', delta: 1, section: 'tabs-panes', label: 'Next tab' },

  { action: 'sidebar.left', combo: 'Mod+B', section: 'layout', label: 'Toggle left sidebar' },
  { action: 'sidebar.right', combo: 'Mod+E', section: 'layout', label: 'Toggle Explorer sidebar' },
  { action: 'sidebar.right', combo: 'Ctrl+`' },
  { action: 'sidebar.both', combo: 'Mod+.', section: 'layout', label: 'Toggle both sidebars' },

  { action: 'composer.focus', combo: 'Mod+L', section: 'agent-input', label: 'Focus message input', handledElsewhere: true },
  { action: 'composer.mode', combo: 'Shift+Tab', section: 'agent-input', label: 'Cycle agent mode', handledElsewhere: true },
  { action: 'agent.interrupt', combo: 'Escape', section: 'agent-input', label: 'Interrupt agent', handledElsewhere: true },
];

/** The physical key code of a combo's key; Digit stands for 1-9. */
const CODES = /** @type {Record<string, string>} */ ({ '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', '.': 'Period', '`': 'Backquote', '?': 'Slash', '\\': 'Backslash' });

/** @param {string} combo @param {boolean} mac */
function parse(combo, mac) {
  const parts = combo.split('+');
  // "Shift+?" and the like: a lone "+" key would split into empty parts; none here uses it.
  const key = parts.pop() ?? '';
  const mods = { meta: false, ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    if (part === 'Mod') mods[mac ? 'meta' : 'ctrl'] = true;
    else if (part === 'Cmd') mods.meta = true;
    else if (part === 'Ctrl') mods.ctrl = true;
    else if (part === 'Alt') mods.alt = true;
    else if (part === 'Shift') mods.shift = true;
  }
  return { key, mods };
}

/**
 * The binding a key press fires, and its digit for the 1-9 bindings.
 * @param {{ key: string, code: string, metaKey: boolean, ctrlKey: boolean, altKey: boolean, shiftKey: boolean }} event
 * @param {{ mac: boolean, editable?: boolean, bindings?: Binding[] }} context
 * @returns {{ binding: Binding, index?: number } | null}
 */
export function matchShortcut(event, { mac, editable = false, bindings = BINDINGS }) {
  for (const binding of bindings) {
    if (binding.handledElsewhere) continue;
    if (binding.scope === 'other' && editable) continue;
    const { key, mods } = parse(binding.combo, mac);
    if (event.metaKey !== mods.meta || event.ctrlKey !== mods.ctrl || event.altKey !== mods.alt || event.shiftKey !== mods.shift) continue;
    if (key === 'Digit') {
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit) return { binding, index: Number(digit[1]) };
      continue;
    }
    if (key.length === 1 && /[A-Za-z]/.test(key) ? event.code === `Key${key.toUpperCase()}` : CODES[key] ? event.code === CODES[key] || event.key === key : event.key === key) return { binding };
  }
  return null;
}

/** The keys of a binding as the dialog lists them: modifiers, then the key. @param {Binding} binding @param {boolean} mac */
export function shortcutKeys(binding, mac) {
  if (binding.display) return binding.display;
  const { key, mods } = parse(binding.combo, mac);
  const keys = [];
  if (mods.ctrl) keys.push('ctrl');
  if (mods.meta) keys.push('mod');
  if (mods.alt) keys.push('alt');
  if (mods.shift && key !== '?') keys.push('shift');
  keys.push(key);
  return keys;
}

const KEY_DISPLAY = /** @type {Record<string, string>} */ ({ Backspace: '⌫', Enter: '⏎', Escape: 'Esc', Space: '␣' });

/** Paseo's formatShortcut: ⌃⌥⇧⌘ then the key on a Mac, Ctrl+Shift+N elsewhere. @param {string[]} keys @param {boolean} mac */
export function formatShortcut(keys, mac) {
  const normal = (/** @type {string} */ key) => KEY_DISPLAY[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (mac) {
    const order = ['ctrl', 'alt', 'shift', 'mod'];
    const symbols = /** @type {Record<string, string>} */ ({ ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' });
    return order.filter(key => keys.includes(key)).map(key => symbols[key]).join('') + keys.filter(key => !order.includes(key)).map(normal).join('');
  }
  const labels = /** @type {Record<string, string>} */ ({ mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' });
  return keys.map(key => labels[key] ?? normal(key)).join('+');
}

/** The first binding of an action, formatted, for hints beside the controls it drives. @param {string} action @param {boolean} mac */
export function shortcutLabel(action, mac) {
  const binding = BINDINGS.find(entry => entry.action === action && entry.label);
  return binding ? formatShortcut(shortcutKeys(binding, mac), mac) : '';
}

/**
 * The dialog's sections, filtered by a query on the label or the keys.
 * @param {boolean} mac @param {string} [query]
 */
export function helpSections(mac, query = '') {
  const needle = query.trim().toLowerCase();
  return SECTIONS.map(section => ({
    ...section,
    rows: BINDINGS.filter(binding => binding.section === section.id && binding.label)
      .map(binding => ({ id: `${binding.action}:${binding.combo}`, label: /** @type {string} */ (binding.label), keys: formatShortcut(shortcutKeys(binding, mac), mac), ...(binding.note ? { note: binding.note } : {}) }))
      .filter(row => !needle || row.label.toLowerCase().includes(needle) || row.keys.toLowerCase().includes(needle)),
  })).filter(section => section.rows.length);
}

/** Whether keys typed into this element are text. @param {EventTarget | null} target */
export function isEditable(target) {
  const element = /** @type {any} */ (target);
  if (!element || typeof element.closest !== 'function') return false;
  if (element.isContentEditable) return true;
  const tag = String(element.tagName ?? '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(String(element.type ?? '').toLowerCase());
}

/** Whether this browser runs on a Mac (Cmd is the modifier). */
export function isMacPlatform() {
  const nav = /** @type {any} */ (globalThis.navigator);
  // As the composer decides it (Composer.tsx): navigator.platform, else the user agent.
  return /Mac|iPhone|iPad/.test(String(nav?.platform || nav?.userAgent || ''));
}
