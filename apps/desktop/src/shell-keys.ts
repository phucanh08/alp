/**
 * What the shell reads from the dashboard window without a bridge to the page (D32: no preload):
 * the key that closes a window showing a bundled page, and the Dock badge from the dashboard's favicon.
 */

/** Whether a key press is ⌘W (Ctrl+W off macOS) and nothing else: File › Close Window's old key. */
export function isCloseWindowKey(input: { type: string; key: string; meta: boolean; control: boolean; alt: boolean; shift: boolean }, mac: boolean): boolean {
  return input.type === 'keyDown' && input.key.toLowerCase() === 'w' && !input.alt && !input.shift
    && (mac ? input.meta && !input.control : input.control && !input.meta);
}

/**
 * The Dock badge for the dashboard's favicons: a dot while it shows its attention icon (a session waits
 * for an answer or ended its turn unseen, apps/web lib/attention.js FAVICONS), else none. Only an icon
 * on the dashboard's own origin counts.
 */
export function attentionBadge(favicons: string[], origin: string | undefined): string {
  if (!origin) return '';
  return favicons.some(icon => {
    try {
      const url = new URL(icon);
      return url.origin === origin && url.pathname === '/favicon-attention.svg';
    } catch { return false; }
  }) ? '•' : '';
}
