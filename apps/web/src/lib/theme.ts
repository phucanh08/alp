import { LIMITS, type Preferences, type SyntaxTheme, type ThemePreference } from './preferences.js';
import { applySyntaxTheme } from './syntax';

/** The theme a preference shows: System follows the device between Light and Dark. */
export type ResolvedTheme = Exclude<ThemePreference, 'system'>;

/**
 * Paseo's theme menu (styles/theme.ts THEME_OPTIONS): Light, Dark, System, then the dark variants
 * after a separator; each with the swatch Paseo shows beside it.
 */
export const THEME_OPTIONS: Array<{ value: ThemePreference; label: string; group: 'primary' | 'variant'; swatch?: string }> = [
  { value: 'light', label: 'Light', group: 'primary', swatch: '#ffffff' },
  { value: 'dark', label: 'Dark', group: 'primary', swatch: '#2D8B62' },
  { value: 'system', label: 'System', group: 'primary' },
  { value: 'zinc', label: 'Zinc', group: 'variant', swatch: '#808080' },
  { value: 'midnight', label: 'Midnight', group: 'variant', swatch: '#4A6BA8' },
  { value: 'claude', label: 'Claude', group: 'variant', swatch: '#D97757' },
  { value: 'ghostty', label: 'Ghostty', group: 'variant', swatch: '#8caaee' },
  { value: 'pureBlack', label: 'Pure black', group: 'variant', swatch: '#000000' },
];

/** The page background of each theme, for the browser's theme-color. */
const BACKGROUNDS: Record<ResolvedTheme, string> = {
  light: '#ffffff', dark: '#181b1a', zinc: '#18181b', midnight: '#161820', claude: '#1f1f1e', ghostty: '#282c34', pureBlack: '#000000',
};

/**
 * Applies Paseo's theme preference to the page as `<html data-theme>`: `system` follows
 * prefers-color-scheme and changes with it. The palettes are in styles.css; the highlight theme
 * follows the light or dark scheme. Returns a cleanup for the system listener.
 */
export function applyTheme(preference: ThemePreference, syntaxTheme: SyntaxTheme = 'one'): () => void {
  const root = document.documentElement;
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const set = () => {
    const resolved: ResolvedTheme = preference === 'system' ? (media?.matches ? 'light' : 'dark') : preference;
    const scheme = resolved === 'light' ? 'light' : 'dark';
    root.dataset.theme = resolved;
    root.classList.toggle('dark', scheme === 'dark');
    root.style.colorScheme = scheme;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', scheme);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BACKGROUNDS[resolved] ?? BACKGROUNDS.dark);
    applySyntaxTheme(syntaxTheme, scheme);
  };
  set();
  if (preference !== 'system' || !media) return () => {};
  media.addEventListener('change', set);
  return () => media.removeEventListener('change', set);
}

/** ALP web's default font stacks: what an empty Interface font or Code font falls back to. */
export const DEFAULT_UI_FONT_STACK = '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
export const DEFAULT_MONO_FONT_STACK = '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** The content width in effect: the chosen one, else Paseo's default 820 px. */
export function contentWidth(preferences: Pick<Preferences, 'contentMaxWidth'>): number {
  return preferences.contentMaxWidth ?? LIMITS.contentMaxWidth[2];
}

/**
 * Applies Paseo's Appearance settings as CSS variables on `<html>` (styles.css reads them): the
 * font stacks, the interface scale (Interface size over Paseo's base 14), the chat and code
 * sizes and the content width. As Paseo's applyAppearance, content and code sizes are absolute.
 */
export function applyAppearance(preferences: Pick<Preferences, 'uiFontFamily' | 'monoFontFamily' | 'uiFontSize' | 'contentFontSize' | 'codeFontSize' | 'contentMaxWidth'>): void {
  const style = document.documentElement.style;
  style.setProperty('--app-font-sans', preferences.uiFontFamily || DEFAULT_UI_FONT_STACK);
  style.setProperty('--app-font-mono', preferences.monoFontFamily || DEFAULT_MONO_FONT_STACK);
  style.setProperty('--ui-scale', String(preferences.uiFontSize / LIMITS.uiFontSize[2]));
  style.setProperty('--content-font-size', `${preferences.contentFontSize}px`);
  style.setProperty('--code-font-size', `${preferences.codeFontSize}px`);
  style.setProperty('--content-width', `${contentWidth(preferences)}px`);
}

/** Paseo's terminal ANSI colors (styles/theme.ts lightTerminalAnsi, darkTerminalAnsi). */
const LIGHT_ANSI = {
  red: '#dc2626', green: '#16a34a', yellow: '#ca8a04', blue: '#2563eb', magenta: '#9333ea', cyan: '#0891b2', white: '#ffffff',
  brightRed: '#ef4444', brightGreen: '#22c55e', brightYellow: '#f59e0b', brightBlue: '#3b82f6', brightMagenta: '#a855f7', brightCyan: '#06b6d4', brightWhite: '#fafafa',
};
const DARK_ANSI = {
  red: '#e07070', green: '#5dba80', yellow: '#d4a44a', blue: '#6a9de0', magenta: '#b07ad0', cyan: '#4aabb8', white: '#d4d4d8',
  brightRed: '#e89090', brightGreen: '#7ecf9a', brightYellow: '#e0be6e', brightBlue: '#8ab4e8', brightMagenta: '#c49ae0', brightCyan: '#6ec2cc', brightWhite: '#f0f0f2',
};

/**
 * The terminal palette of the theme on the page now, as Paseo builds it: the theme's surface and
 * text, its black and bright black, and the light or dark ANSI colors.
 */
export function terminalTheme() {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const read = (name: string) => css.getPropertyValue(name).trim();
  const light = root.dataset.theme === 'light';
  const background = read('--background');
  const foreground = read('--foreground');
  return {
    background, foreground, cursor: foreground, cursorAccent: background,
    selectionBackground: light ? 'rgba(0, 0, 0, 0.15)' : 'rgba(255, 255, 255, 0.2)', selectionForeground: foreground,
    black: read('--terminal-black'), brightBlack: read('--terminal-bright-black'),
    ...(light ? LIGHT_ANSI : DARK_ANSI),
  };
}
