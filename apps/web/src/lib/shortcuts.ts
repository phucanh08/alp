// Paseo's keyboard shortcuts (packages/app/src/keyboard/keyboard-shortcuts.ts) for the parts of the
// workspace ALP web has, with Paseo's labels and sections: in a browser the web build's bindings, in
// ALP.app (lib/browser-url.ts isDesktopApp) Paseo's desktop ones (Mod+W closes the tab, Mod+1-9 and
// Mod+[ ] go through the sessions, Cmd+Alt+1-9 through the tabs; t-0166). "Mod" is Cmd
// on a Mac and Ctrl elsewhere. Keys are matched by their physical code where a modifier changes
// the character (Alt+1 types "¡" on a Mac), so the same keys work on any layout and platform.
//
// Search files (Mod+P) opens the command center in its Files scope, as Paseo's command-center.files.
// Left out, as ALP has no such thing: open project (Cmd+O), pin, browser
// tabs, focus mode, themes, voice and dictation. The split pane keys are Paseo's, on a Mac only
// (as Paseo binds them).

export type SectionId = 'general' | 'workspaces' | 'tabs-panes' | 'layout' | 'agent-input';
export type Binding = {
  action: string;
  combo: string;
  section?: SectionId;
  label?: string;
  delta?: 1 | -1;
  display?: string[];
  scope?: 'other';
  handledElsewhere?: boolean;
  note?: string;
  mac?: boolean;
  desktop?: boolean;
};

export const SECTIONS: Array<{ id: SectionId; title: string; }> = [
  { id: 'general', title: 'General' },
  { id: 'workspaces', title: 'Projects & Workspaces' },
  { id: 'tabs-panes', title: 'Tabs & Panes' },
  { id: 'layout', title: 'Layout' },
  { id: 'agent-input', title: 'Agent Input' },
];

export const BINDINGS: Binding[] = [
  { action: 'command-center.toggle', combo: 'Mod+K', section: 'general', label: 'Toggle command center' },
  { action: 'command-center.files', combo: 'Mod+P', section: 'general', label: 'Search files' },
  { action: 'shortcuts.toggle', combo: 'Shift+?', section: 'general', label: 'Show keyboard shortcuts', scope: 'other', note: 'Available when focus is not in a text field.' },
  { action: 'settings.toggle', combo: 'Mod+,', section: 'general', label: 'Toggle settings' },

  { action: 'session.new', combo: 'Mod+N', section: 'workspaces', label: 'New session' },
  { action: 'session.archive', combo: 'Mod+Shift+Backspace', section: 'workspaces', label: 'Archive session' },
  { action: 'session.index', combo: 'Mod+Digit', section: 'workspaces', label: 'Jump to session', display: ['mod', '1-9'], desktop: true },
  { action: 'session.index', combo: 'Alt+Digit', section: 'workspaces', label: 'Jump to session', display: ['alt', '1-9'], desktop: false },
  { action: 'session.relative', combo: 'Mod+[', delta: -1, section: 'workspaces', label: 'Previous session', desktop: true },
  { action: 'session.relative', combo: 'Mod+]', delta: 1, section: 'workspaces', label: 'Next session', desktop: true },
  { action: 'session.relative', combo: 'Alt+[', delta: -1, section: 'workspaces', label: 'Previous session', desktop: false },
  { action: 'session.relative', combo: 'Alt+]', delta: 1, section: 'workspaces', label: 'Next session', desktop: false },

  { action: 'tab.menu', combo: 'Mod+T', section: 'tabs-panes', label: 'New tab' },
  { action: 'tab.agent', combo: 'Mod+Shift+A', section: 'tabs-panes', label: 'New agent' },
  { action: 'tab.changes', combo: 'Mod+Shift+G', section: 'tabs-panes', label: 'Changes' },
  { action: 'tab.files', combo: 'Mod+Shift+E', section: 'tabs-panes', label: 'Files' },
  { action: 'tab.terminal', combo: 'Mod+Shift+T', section: 'tabs-panes', label: 'New terminal' },
  { action: 'tab.close', combo: 'Mod+W', section: 'tabs-panes', label: 'Close current tab', desktop: true },
  { action: 'tab.close', combo: 'Alt+Shift+W', section: 'tabs-panes', label: 'Close current tab', desktop: false },
  { action: 'tab.index', combo: 'Cmd+Alt+Digit', section: 'tabs-panes', label: 'Jump to tab', display: ['mod', 'alt', '1-9'], desktop: true, mac: true },
  { action: 'tab.index', combo: 'Alt+Digit', section: 'tabs-panes', label: 'Jump to tab', display: ['alt', '1-9'], desktop: true, mac: false },
  { action: 'tab.index', combo: 'Alt+Shift+Digit', section: 'tabs-panes', label: 'Jump to tab', display: ['alt', 'shift', '1-9'], desktop: false },
  { action: 'tab.relative', combo: 'Alt+Shift+[', delta: -1, section: 'tabs-panes', label: 'Previous tab' },
  { action: 'tab.relative', combo: 'Alt+Shift+]', delta: 1, section: 'tabs-panes', label: 'Next tab' },
  { action: 'pane.split.right', combo: 'Cmd+\\', section: 'tabs-panes', label: 'Split pane right', mac: true },
  { action: 'pane.split.down', combo: 'Cmd+Shift+\\', section: 'tabs-panes', label: 'Split pane down', mac: true },
  { action: 'pane.focus.left', combo: 'Cmd+Shift+ArrowLeft', section: 'tabs-panes', label: 'Focus pane left', mac: true, scope: 'other' },
  { action: 'pane.focus.right', combo: 'Cmd+Shift+ArrowRight', section: 'tabs-panes', label: 'Focus pane right', mac: true, scope: 'other' },
  { action: 'pane.focus.up', combo: 'Cmd+Shift+ArrowUp', section: 'tabs-panes', label: 'Focus pane up', mac: true, scope: 'other' },
  { action: 'pane.focus.down', combo: 'Cmd+Shift+ArrowDown', section: 'tabs-panes', label: 'Focus pane down', mac: true, scope: 'other' },
  { action: 'pane.move.left', combo: 'Cmd+Alt+Shift+ArrowLeft', section: 'tabs-panes', label: 'Move tab left', mac: true },
  { action: 'pane.move.right', combo: 'Cmd+Alt+Shift+ArrowRight', section: 'tabs-panes', label: 'Move tab right', mac: true },
  { action: 'pane.move.up', combo: 'Cmd+Alt+Shift+ArrowUp', section: 'tabs-panes', label: 'Move tab up', mac: true },
  { action: 'pane.move.down', combo: 'Cmd+Alt+Shift+ArrowDown', section: 'tabs-panes', label: 'Move tab down', mac: true },
  { action: 'pane.close', combo: 'Cmd+Shift+W', section: 'tabs-panes', label: 'Close pane', mac: true, desktop: true },
  { action: 'pane.close', combo: 'Cmd+Shift+W', section: 'tabs-panes', label: 'Close pane', mac: true, desktop: false, note: 'Some browsers keep this key to close the window.' },

  { action: 'sidebar.left', combo: 'Mod+B', section: 'layout', label: 'Toggle left sidebar' },
  { action: 'sidebar.right', combo: 'Mod+E', section: 'layout', label: 'Toggle Explorer sidebar' },
  { action: 'sidebar.right', combo: 'Ctrl+`' },
  { action: 'sidebar.both', combo: 'Mod+.', section: 'layout', label: 'Toggle both sidebars' },

  { action: 'pane.find', combo: 'Mod+F', section: 'tabs-panes', label: 'Find in chat', handledElsewhere: true },

  { action: 'composer.focus', combo: 'Mod+L', section: 'agent-input', label: 'Focus message input', handledElsewhere: true },
  { action: 'composer.mode', combo: 'Shift+Tab', section: 'agent-input', label: 'Cycle agent mode', handledElsewhere: true },
  { action: 'agent.interrupt', combo: 'Escape', section: 'agent-input', label: 'Interrupt agent', handledElsewhere: true },
];

/** Whether a binding is on here: on a Mac or not, in ALP.app or a browser. */
export function bindingApplies(binding: Binding, { mac, desktop }: { mac: boolean; desktop: boolean; }) {
  return (binding.mac === undefined || binding.mac === mac) && (binding.desktop === undefined || binding.desktop === desktop);
}

/** The physical key code of a combo's key; Digit stands for 1-9. */
const CODES = { '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', '.': 'Period', '`': 'Backquote', '?': 'Slash', '/': 'Slash', '\\': 'Backslash', '-': 'Minus', '=': 'Equal', ';': 'Semicolon', "'": 'Quote', Space: 'Space' } as Record<string, string>;

function parse(combo: string, mac: boolean) {
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

/** The binding a key press fires, and its digit for the 1-9 bindings. */
export function matchShortcut(event: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; }, { mac, desktop = false, editable = false, bindings = effectiveBindings() }: { mac: boolean; desktop?: boolean; editable?: boolean; bindings?: Binding[]; }): { binding: Binding; index?: number; } | null {
  for (const binding of bindings) {
    if (binding.handledElsewhere || !binding.combo || !bindingApplies(binding, { mac, desktop })) continue;
    if (binding.scope === 'other' && editable) continue;
    const { key, mods } = parse(binding.combo, mac);
    if (event.metaKey !== mods.meta || event.ctrlKey !== mods.ctrl || event.altKey !== mods.alt || event.shiftKey !== mods.shift) continue;
    if (key === 'Digit') {
      const digit = /^Digit([1-9])$/.exec(event.code);
      if (digit) return { binding, index: Number(digit[1]) };
      continue;
    }
    if (/^[A-Za-z]$/.test(key) ? event.code === `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? event.code === `Digit${key}` : CODES[key] ? event.code === CODES[key] || event.key === key : event.key === key) return { binding };
  }
  return null;
}

/** The keys of a binding as the dialog lists them: modifiers, then the key. */
export function shortcutKeys(binding: Binding, mac: boolean) {
  if (binding.display) return binding.display;
  if (!binding.combo) return [];
  const { key, mods } = parse(binding.combo, mac);
  const keys = [];
  if (mods.ctrl) keys.push('ctrl');
  // ⌘ on a Mac; elsewhere Cmd is the Windows or Super key (Mod is Ctrl there).
  if (mods.meta) keys.push(mac ? 'mod' : 'meta');
  if (mods.alt) keys.push('alt');
  if (mods.shift && key !== '?') keys.push('shift');
  keys.push(key === 'Digit' ? '1-9' : key);
  return keys;
}

const KEY_DISPLAY = { Backspace: '⌫', Enter: '⏎', Escape: 'Esc', Space: '␣', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' } as Record<string, string>;

/** Paseo's formatShortcut: ⌃⌥⇧⌘ then the key on a Mac, Ctrl+Shift+N elsewhere. */
export function formatShortcut(keys: string[], mac: boolean) {
  const normal = (key: string) => KEY_DISPLAY[key] ?? (key.length === 1 ? key.toUpperCase() : key);
  if (mac) {
    const order = ['ctrl', 'alt', 'shift', 'mod'];
    const symbols = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘' } as Record<string, string>;
    return order.filter(key => keys.includes(key)).map(key => symbols[key]).join('') + keys.filter(key => !order.includes(key)).map(normal).join('');
  }
  const labels = { mod: 'Ctrl', ctrl: 'Ctrl', meta: 'Meta', alt: 'Alt', shift: 'Shift' } as Record<string, string>;
  return keys.map(key => labels[key] ?? normal(key)).join('+');
}

/**
 * The first binding of an action, formatted, for hints beside the controls it drives: the user's
 * keys when they rebound it, "" when they cleared it.
 */
export function shortcutLabel(action: string, mac: boolean, desktop: boolean = false, delta?: 1 | -1) {
  const binding = effectiveBindings().find(entry => entry.action === action && entry.label && bindingApplies(entry, { mac, desktop }) && (delta === undefined || entry.delta === delta));
  return binding ? formatShortcut(shortcutKeys(binding, mac), mac) : '';
}

/**
 * The dialog's sections, filtered by a query on the label or the keys, with the user's keys.
 * A cleared shortcut lists "Not set".
 */
export function helpSections(mac: boolean, query: string = '', desktop: boolean = false) {
  const needle = query.trim().toLowerCase();
  return shortcutSections(mac, desktop).map(section => ({
    ...section,
    rows: section.rows
      .map(row => ({ id: row.id, label: row.label, keys: row.keys || NOT_SET, ...(row.note ? { note: row.note } : {}) }))
      .filter(row => !needle || row.label.toLowerCase().includes(needle) || row.keys.toLowerCase().includes(needle)),
  })).filter(section => section.rows.length);
}

// ---- the user's keys (Paseo's ShortcutOverrides, Settings › Shortcuts) --------------------------
//
// Paseo keeps a map from a binding's id to the combo the user chose, or null when they cleared it
// (UNASSIGNED_COMBO: the row stays, it matches nothing); a binding without an entry keeps its
// default. ALP keeps that map in the app preferences (preferences.js shortcutOverrides). Rebindable
// here: every row of the dialog but the ones another component handles (the composer's keys and
// Find in chat, which read their own keys). An alias (Ctrl+` for the Explorer sidebar) follows its
// row: once the row is rebound or cleared, the alias no longer fires.

/** What the dialog and Settings show for a cleared shortcut (Paseo's "Not set"). */
export const NOT_SET = 'Not set';

export type ShortcutOverrides = Record<string, string | null>;

/**
 * A binding's id, the key of its override: the action, Previous/Next for the relative ones, and
 * which build it is for when ALP.app and a browser have different defaults. Stable: renaming one
 * drops the user's keys for it.
 */
export function bindingId(binding: Binding) {
  const delta = binding.delta === -1 ? ':previous' : binding.delta === 1 ? ':next' : '';
  const build = binding.desktop === true ? '@desktop' : binding.desktop === false ? '@browser' : '';
  return `${binding.action}${delta}${build}`;
}

/** Whether Settings › Shortcuts can change a binding's keys. */
export function isRebindable(binding: Binding) {
  return !!binding.label && !binding.handledElsewhere;
}

/** Whether a binding takes a number 1-9 (its key is the Digit wildcard). */
const isIndexBinding = (binding: Binding) => binding.combo.endsWith('+Digit') || binding.combo === 'Digit';

/** The rebindable ids, with whether each takes a number. */
const REBINDABLE = new Map(BINDINGS.filter(isRebindable).map(binding => [bindingId(binding), isIndexBinding(binding)]));

const MODIFIERS = ['Mod', 'Cmd', 'Ctrl', 'Alt', 'Shift'];
const NAMED_KEYS = ['Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'Insert', 'Home', 'End', 'PageUp', 'PageDown', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`)];
const KEYS = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789[],.`?/\\-=;\'', ...NAMED_KEYS, 'Digit']);
const MAX_COMBO_LENGTH = 64;
const MAX_OVERRIDES = 64;

/**
 * A combo in its stored form (modifiers as Mod, Cmd, Ctrl, Alt, Shift, then one known key; a
 * letter upper case), or null when it is not one.
 */
export function normalizeCombo(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > MAX_COMBO_LENGTH) return null;
  const parts = value.split('+');
  const raw = parts.pop() ?? '';
  const key = raw.length === 1 ? raw.toUpperCase() : raw;
  if (!KEYS.has(key) || parts.some(part => !MODIFIERS.includes(part)) || new Set(parts).size !== parts.length) return null;
  return [...MODIFIERS.filter(modifier => parts.includes(modifier)), key].join('+');
}

/**
 * The user's keys from storage, tolerantly: known rebindable ids only, each a valid combo (one
 * ending in a number for the 1-9 shortcuts, never for the others) or null; anything else dropped.
 */
export function parseShortcutOverrides(value: unknown): ShortcutOverrides {
  const overrides: ShortcutOverrides = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return overrides;
  for (const [id, combo] of Object.entries(value).slice(0, MAX_OVERRIDES * 4)) {
    if (!REBINDABLE.has(id) || Object.keys(overrides).length >= MAX_OVERRIDES) continue;
    if (combo === null) { overrides[id] = null; continue; }
    const normalized = normalizeCombo(combo);
    if (normalized && normalized.endsWith('Digit') === REBINDABLE.get(id)) overrides[id] = normalized;
  }
  return overrides;
}

let currentOverrides: ShortcutOverrides = {};
let effectiveCache: { overrides: ShortcutOverrides; bindings: Binding[]; } | null = null;
let lastApplied: unknown;

/**
 * Makes the user's keys the ones every shortcut uses (the window listener, the dialog, the hints).
 * The app calls it with the preferences' map whenever they change.
 */
export function setShortcutOverrides(overrides: unknown) {
  if (overrides === lastApplied) return;
  lastApplied = overrides;
  const next = parseShortcutOverrides(overrides);
  if (JSON.stringify(next) !== JSON.stringify(currentOverrides)) currentOverrides = next;
}

/**
 * The bindings with the user's keys: a rebound one with its new combo, a cleared one with an empty
 * combo (it keeps its row, nothing matches it), an alias of a changed row left out.
 */
export function effectiveBindings(overrides: ShortcutOverrides = currentOverrides): Binding[] {
  if (effectiveCache?.overrides === overrides) return effectiveCache.bindings;
  const bindings = BINDINGS.flatMap(binding => {
    const id = bindingId(binding);
    if (!Object.hasOwn(overrides, id)) return [binding];
    if (!isRebindable(binding)) return [];
    const { display: _display, ...rest } = binding;
    return [{ ...rest, combo: overrides[id] ?? '' }];
  });
  effectiveCache = { overrides, bindings };
  return bindings;
}

/**
 * The rows of the dialog and of Settings › Shortcuts: each section's labelled bindings for this
 * platform, with the keys now and by default.
 */
export function shortcutSections(mac: boolean, desktop: boolean = false, overrides: ShortcutOverrides = currentOverrides) {
  const effective = effectiveBindings(overrides);
  return SECTIONS.map(section => ({
    ...section,
    rows: BINDINGS.flatMap((binding, index) => {
      if (binding.section !== section.id || !binding.label || !bindingApplies(binding, { mac, desktop })) return [];
      const id = bindingId(binding);
      const now = (effective.find(entry => entry.action === binding.action && entry.label && bindingId(entry) === id && bindingApplies(entry, { mac, desktop })) ?? BINDINGS[index]) as Binding;
      return [{
        id, label: binding.label, binding: now,
        keys: formatShortcut(shortcutKeys(now, mac), mac),
        defaultKeys: formatShortcut(shortcutKeys(binding, mac), mac),
        defaultCombo: binding.combo,
        rebindable: isRebindable(binding),
        overridden: Object.hasOwn(overrides, id),
        ...(binding.note ? { note: binding.note } : {}),
      }];
    }),
  })).filter(section => section.rows.length);
}

const MODIFIER_CODES = new Set(['MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'OSLeft', 'OSRight', 'CapsLock', 'Fn']);
const CODE_KEYS = Object.fromEntries(Object.entries(CODES).filter(([key]) => key !== '?').map(([key, code]) => [code, key]));

/**
 * The combo a key press spells, by physical key as the matcher reads it (Paseo's
 * keyboardEventToComboString): "" while only modifiers are held, null for a key ALP cannot bind.
 * The platform's main modifier (⌘ on a Mac, Ctrl elsewhere) is recorded as Mod.
 */
export function comboFromEvent(event: { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; }, mac: boolean): string | null {
  if (MODIFIER_CODES.has(event.code) || ['Meta', 'Control', 'Alt', 'Shift', 'OS'].includes(event.key)) return '';
  const letter = /^Key([A-Z])$/.exec(event.code);
  const digit = /^Digit([0-9])$/.exec(event.code);
  const key = letter ? letter[1] : digit ? digit[1] : CODE_KEYS[event.code] ?? (NAMED_KEYS.includes(event.code) ? event.code : null);
  if (!key) return null;
  const parts = [];
  if (mac ? event.metaKey : event.ctrlKey) parts.push('Mod');
  if (!mac && event.metaKey) parts.push('Cmd');
  if (mac && event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  return normalizeCombo([...parts, key].join('+'));
}

/** The modifiers held while a capture waits for its key, formatted (Paseo's heldModifiers). */
export function heldModifiers(event: { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; }, mac: boolean) {
  const keys = [];
  if (event.ctrlKey) keys.push(mac ? 'ctrl' : 'mod');
  if (event.metaKey) keys.push(mac ? 'mod' : 'meta');
  if (event.altKey) keys.push('alt');
  if (event.shiftKey) keys.push('shift');
  return formatShortcut(keys, mac);
}

/** The physical key a combo's key stands for, "Digit*" for the 1-9 wildcard. */
const keyIdentity = (key: string) => key === 'Digit' ? 'Digit*' : /^[A-Za-z]$/.test(key) ? `Key${key.toUpperCase()}` : /^[0-9]$/.test(key) ? `Digit${key}` : CODES[key] ?? key;

/** Whether two combos fire on the same key press here. */
export function combosCollide(a: string, b: string, mac: boolean) {
  if (!a || !b) return false;
  const left = parse(a, mac);
  const right = parse(b, mac);
  if (Object.keys(left.mods).some(mod => left.mods[(mod as keyof typeof left.mods)] !== right.mods[(mod as keyof typeof left.mods)])) return false;
  const [l, r] = [keyIdentity(left.key), keyIdentity(right.key)];
  return l === r || (l === 'Digit*' && /^Digit[1-9]$/.test(r)) || (r === 'Digit*' && /^Digit[1-9]$/.test(l));
}

/**
 * Checks the keys captured for a row (Paseo's capture rules, and two of ALP's): the 1-9 shortcuts
 * end in a number (stored as the Digit wildcard); a key without ⌘, Ctrl or Alt is refused unless
 * it is F1-F12, or the shortcut only fires outside text fields; and keys another shortcut here
 * already uses are refused with its name (Paseo has no such check; ALP does not let two
 * shortcuts share one key press). Returns the combo to store, or the reason it is refused.
 */
export function checkCapture(id: string, combo: string, { mac, desktop = false, overrides = currentOverrides }: { mac: boolean; desktop?: boolean; overrides?: ShortcutOverrides; }): { combo: string; } | { error: string; } {
  const where = { mac, desktop };
  const binding = BINDINGS.find(entry => bindingId(entry) === id && isRebindable(entry) && bindingApplies(entry, where));
  if (!binding) return { error: 'This shortcut cannot be changed.' };
  let next = normalizeCombo(combo);
  if (!next) return { error: 'That key cannot be used for a shortcut.' };
  const { key, mods } = parse(next, mac);
  if (isIndexBinding(binding)) {
    if (!/^[1-9]$/.test(key)) return { error: 'End with a number from 1 to 9.' };
    next = next.replace(/[1-9]$/, 'Digit');
  }
  const strong = mods.meta || mods.ctrl || mods.alt;
  const typing = key.length === 1 || key === 'Digit';
  if (!strong && !/^F([1-9]|1[0-2])$/.test(key) && !(binding.scope === 'other' && typing)) {
    return { error: mac ? 'Add ⌘, ⌃ or ⌥: without one the key would type or move focus.' : 'Add Ctrl or Alt: without one the key would type or move focus.' };
  }
  const taken = effectiveBindings(overrides).find(entry => bindingId(entry) !== id && bindingApplies(entry, where) && combosCollide(entry.combo, next, mac));
  if (taken) {
    const owner = taken.label ?? BINDINGS.find(entry => entry.label && entry.action === taken.action && entry.delta === taken.delta)?.label ?? taken.action;
    return { error: `${formatShortcut(shortcutKeys({ ...taken, display: undefined, combo: next }, mac), mac)} is already used by ${owner}.` };
  }
  return { combo: next };
}

/** Whether keys typed into this element are text. */
export function isEditable(target: EventTarget | null) {
  // any: any event target; the fields read (tagName, isContentEditable) are checked before use.
  const element = target as any;
  if (!element || typeof element.closest !== 'function') return false;
  if (element.isContentEditable) return true;
  const tag = String(element.tagName ?? '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'color', 'file'].includes(String(element.type ?? '').toLowerCase());
}

/**
 * Checks Reset to default for a row: its default keys (and its alias's) come back, so they must
 * not be keys another shortcut has taken since (the user cleared this row, then gave its keys to
 * another). Reset all needs no check: the defaults never share a key press.
 */
export function checkReset(id: string, { mac, desktop = false, overrides = currentOverrides }: { mac: boolean; desktop?: boolean; overrides?: ShortcutOverrides; }): { ok: true; } | { error: string; } {
  const where = { mac, desktop };
  const { [id]: _dropped, ...rest } = overrides;
  const effective = effectiveBindings(rest).filter(entry => bindingApplies(entry, where));
  for (const restored of effective.filter(entry => bindingId(entry) === id)) {
    const taken = effective.find(entry => bindingId(entry) !== id && combosCollide(entry.combo, restored.combo, mac));
    if (taken) {
      const owner = taken.label ?? BINDINGS.find(entry => entry.label && entry.action === taken.action && entry.delta === taken.delta)?.label ?? taken.action;
      return { error: `Its default ${formatShortcut(shortcutKeys(restored, mac), mac)} is now used by ${owner}. Change that shortcut first.` };
    }
  }
  return { ok: true };
}

/** Whether this browser runs on a Mac (Cmd is the modifier). */
export function isMacPlatform() {
  // any: browser fields outside the DOM typings (userAgentData, windowControlsOverlay), each checked before use.
  const nav = globalThis.navigator as any;
  // As the composer decides it (Composer.tsx): navigator.platform, else the user agent.
  return /Mac|iPhone|iPad/.test(String(nav?.platform || nav?.userAgent || ''));
}
