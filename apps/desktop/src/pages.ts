/**
 * The bundled pages (Connecting, the error page, the install page) are served from the app's own
 * dist/pages through a scheme of their own, alp-page://app/<name>, not file://. The packaged app turns
 * the GrantFileProtocolExtraPrivileges fuse off, which takes file:// reads from inside app.asar away
 * (ERR_FILE_NOT_FOUND, a blank window: t-81b0.7); the handler reads them in the main process, where
 * app.asar is a directory. Only the files below are served, nothing else under or outside dist/pages.
 */
import path from 'node:path';

export const PAGE_SCHEME = 'alp-page';
const PAGE_HOST = 'app';

const TYPES: Record<string, string> = {
  'connecting.html': 'text/html; charset=utf-8',
  'error.html': 'text/html; charset=utf-8',
  'missing-alp.html': 'text/html; charset=utf-8',
  'missing-alp.js': 'text/javascript; charset=utf-8',
  'install.html': 'text/html; charset=utf-8',
  'install.js': 'text/javascript; charset=utf-8',
  'installing.html': 'text/html; charset=utf-8',
  'page.js': 'text/javascript; charset=utf-8',
  'page.css': 'text/css; charset=utf-8',
};

/** The address of bundled page `name`, with `query` as its search parameters. */
export function pageUrl(name: string, query: Record<string, string> = {}): string {
  const search = new URLSearchParams(query).toString();
  return `${PAGE_SCHEME}://${PAGE_HOST}/${name}${search ? `?${search}` : ''}`;
}

/** Whether `url` is one of the bundled pages' addresses (any file, served or not). */
export const isPageUrl = (url: string) => url.startsWith(`${PAGE_SCHEME}:`);

/** The file and content type to answer `url` with, or undefined (404) for anything not served. */
export function resolvePage(url: string, pagesDir: string): { file: string; type: string } | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.protocol !== `${PAGE_SCHEME}:` || parsed.host !== PAGE_HOST || parsed.username || parsed.password) return undefined;
  const name = parsed.pathname.slice(1);
  if (!Object.hasOwn(TYPES, name)) return undefined;
  return { file: path.join(pagesDir, name), type: TYPES[name]! };
}
