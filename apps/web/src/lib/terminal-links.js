// @ts-check
/** Open only web URLs printed by the host, with no opener access to this authenticated page.
 * @param {string} uri
 * @param {(url: string, target: string, features: string) => unknown} [open]
 */
export function openTerminalLink(uri, open = (url, target, features) => globalThis.open(url, target, features)) {
  let url;
  try { url = new URL(uri); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return false;
  open(url.href, '_blank', 'noopener,noreferrer');
  return true;
}
