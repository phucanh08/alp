import type { ThemePreference } from './preferences.js';

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
