/**
 * What the window may do. It shows one origin, the alp web service's, and nothing else: navigation
 * elsewhere is refused, new windows are refused, and only https links may go to the user's browser.
 */

/** Whether the window may navigate to `target` while it shows `origin` (exact origin match). */
export function isAllowedNavigation(target: string, origin: string | undefined): boolean {
  if (!origin) return false;
  try { return new URL(target).origin === origin; } catch { return false; }
}

/**
 * The handler for will-navigate, will-frame-navigate and will-redirect: whichever frame navigates,
 * main or sub, a target outside the shown origin is prevented. `origin` is read at each event.
 */
export function navigationGuard(origin: () => string | undefined) {
  return (event: { url: string; isMainFrame?: boolean; preventDefault(): void }) => {
    if (!isAllowedNavigation(event.url, origin())) event.preventDefault();
  };
}

/** Whether a link the page tried to open may go to the user's browser: https only. */
export function isAllowedExternal(target: string): boolean {
  try {
    const url = new URL(target);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

/** Permissions the alp web page may have: only writing plain text to the clipboard (Copy buttons). */
const PERMITTED = new Set(['clipboard-sanitized-write']);

/** Whether a permission request or check from `requestingUrl` is granted while showing `origin`. */
export function isAllowedPermission(permission: string, requestingUrl: string | undefined, origin: string | undefined): boolean {
  return PERMITTED.has(permission) && requestingUrl !== undefined && isAllowedNavigation(requestingUrl, origin);
}
