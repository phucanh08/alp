/**
 * The colours of each theme's tile in Settings › Appearance (Paseo's ThemePicker ThemePreview:
 * surface0, surfaceSidebar, foregroundMuted, foreground, accent), as styles.css sets them for that
 * theme (--background, --sidebar, --muted-foreground, --foreground, --primary). A test keeps the
 * two in step.
 */
export const THEME_PREVIEWS: Record<Exclude<import('./preferences.js').ThemePreference, 'system'>, { background: string; sidebar: string; muted: string; foreground: string; accent: string; }> = Object.freeze({
  light: { background: '#ffffff', sidebar: '#f4f4f5', muted: '#63636d', foreground: '#1a1a1e', accent: '#20744a' },
  dark: { background: '#181b1a', sidebar: '#141716', muted: '#a1a5a4', foreground: '#e8ebea', accent: '#20744a' },
  zinc: { background: '#18181b', sidebar: '#131316', muted: '#a1a1aa', foreground: '#fafafa', accent: '#e4e4e7' },
  midnight: { background: '#161820', sidebar: '#121420', muted: '#9a9db0', foreground: '#fafafa', accent: '#3b6fcf' },
  claude: { background: '#1f1f1e', sidebar: '#1a1918', muted: '#ada9a5', foreground: '#fafafa', accent: '#d97757' },
  ghostty: { background: '#282c34', sidebar: '#21252d', muted: '#c8ccd8', foreground: '#fafafa', accent: '#89b4fa' },
  pureBlack: { background: '#000000', sidebar: '#000000', muted: '#a1a1aa', foreground: '#fafafa', accent: '#20744a' },
});
