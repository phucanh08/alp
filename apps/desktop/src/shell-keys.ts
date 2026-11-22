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

/**
 * Whether a key pressed in a Browser tab's page belongs to the dashboard instead (macOS): ⌘W (close
 * the tab), ⌘1-9 (a session) and ⌥⌘1-9 (a tab) of Paseo's desktop set. Paseo forwards its shortcuts
 * from the guest through a preload; ALP.app replays these few on the dashboard window instead (D32).
 */
export function isDashboardKey(input: { type: string; key: string; code: string; meta: boolean; control: boolean; alt: boolean; shift: boolean }): boolean {
  if (input.type !== 'keyDown' || !input.meta || input.control || input.shift) return false;
  if (/^Digit[1-9]$/.test(input.code)) return true;
  return !input.alt && input.code === 'KeyW';
}

/**
 * The script that presses a dashboard key (isDashboardKey) in the dashboard window: a keydown on its
 * window, which apps/web's shortcuts listen to. Built only from the key's fixed name, never from what
 * the Browser tab's page sent; throws for any other code.
 */
export function dashboardKeyScript(code: string, alt: boolean): string {
  const digit = /^Digit([1-9])$/.exec(code);
  if (!digit && code !== 'KeyW') throw new Error(`not a dashboard key: ${code}`);
  const init = { code, key: digit ? digit[1] : 'w', metaKey: true, altKey: alt === true, bubbles: true, cancelable: true };
  return `window.dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify(init)})); 1`;
}
