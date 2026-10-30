import type { ContentWidth, ThemePreference } from './preferences.js';

/**
 * Applies Paseo's theme preference to the page: `light` and `dark` as named, `system` follows
 * prefers-color-scheme and changes with it. The palette is in styles.css (`:root` dark,
 * `:root[data-theme="light"]`). Returns a cleanup for the system listener.
 */
export function applyTheme(preference: ThemePreference): () => void {
  const root = document.documentElement;
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: light)') : null;
  const set = () => {
    const resolved = preference === 'system' ? (media?.matches ? 'light' : 'dark') : preference;
    root.dataset.theme = resolved;
    root.classList.toggle('dark', resolved === 'dark');
    root.style.colorScheme = resolved;
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', resolved);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'light' ? '#ffffff' : '#181b1a');
  };
  set();
  if (preference !== 'system' || !media) return () => {};
  media.addEventListener('change', set);
  return () => media.removeEventListener('change', set);
}

/** Paseo's content widths: the chat column's maximum width, as `--content-width` (styles.css). */
export const CONTENT_WIDTH_VALUES: Record<ContentWidth, string> = { default: '820px', wide: '1100px', full: '100%' };

/** Applies Appearance › Content width to every centered column that reads `--content-width`. */
export function applyContentWidth(width: ContentWidth): void {
  document.documentElement.style.setProperty('--content-width', CONTENT_WIDTH_VALUES[width] ?? CONTENT_WIDTH_VALUES.default);
}
