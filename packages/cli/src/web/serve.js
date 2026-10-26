// @ts-check
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * The static side of `alp web` (docs/alp/web.md): the built apps/web files, served through the
 * gateway's `serveStatic` hook on the gateway's own loopback listener. The gateway has refused an
 * unknown Host (421) before a request reaches this, and hands over GET and HEAD only, with the RAW
 * request target. This module normalizes that target itself and never serves a file whose real
 * path lies outside the app directory:
 *   - the target must be origin-form (`/...`); it is parsed with `new URL` against a fixed origin,
 *     so `//host/x` stays a path and dot segments (also `%2e%2e`) are resolved by the URL parser;
 *   - each path segment is percent-decoded exactly once; a decoded segment holding `/`, `\`, `:`,
 *     NUL, a control character, or that is empty, `.`, `..` or starts with `.` is refused (400);
 *   - a backslash anywhere in the raw target or its decoded form is refused (400);
 *   - the file's realpath must lie under the app directory's realpath (no symlink escapes), else 404.
 * Paths without an extension that name no file get index.html (the app's own routes); a missing
 * file with an extension is a 404. index.html is never cached; files under /assets/ are named by
 * content and immutable.
 */

/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon', '.gif': 'image/gif', '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
};

// eslint-disable-next-line no-control-regex
// `:` names a drive or an NTFS stream on Windows; the built app has no such file anywhere.
const FORBIDDEN_IN_SEGMENT = /[\u0000-\u001f\u007f/\\:]/;

/** What a page without the built app says. @param {string} dir */
const missingPage = dir => `<!doctype html><meta charset="utf-8"><title>ALP</title><body style="font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>ALP web is not built</h1><p>The web app's files are missing from <code>${dir.replace(/[&<>"]/g, char => `&#${char.charCodeAt(0)};`)}</code>. Build them from a checkout with <code>node scripts/build-workspace.mjs cli</code> (or <code>node scripts/build-alp-web.mjs</code>), or install ALP from npm, which carries them. The gateway on this address keeps running.</p>`;

/**
 * The path segments a raw request target names, each decoded once, or a refusal.
 * @param {string | undefined} raw
 * @returns {{ segments: string[] } | { status: 400 }}
 */
export function parseTarget(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.includes('\\') || /%5c/i.test(raw) || raw.includes('\0')) return { status: 400 };
  let url;
  // Never `new URL(raw, base)`: a raw `//host/x` would name another host. The fixed origin keeps it a path.
  try { url = new URL(`http://alp-web.invalid${raw}`); } catch { return { status: 400 }; }
  if (url.host !== 'alp-web.invalid') return { status: 400 };
  const parts = url.pathname.split('/').slice(1);
  /** @type {string[]} */
  const segments = [];
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    // A trailing slash (`/` itself, or `/route/`) is the directory's index; any other empty segment is `//`.
    if (part === '' && index === parts.length - 1) break;
    let segment;
    try { segment = decodeURIComponent(part); } catch { return { status: 400 }; }
    if (!segment || segment === '.' || segment === '..' || segment.startsWith('.') || FORBIDDEN_IN_SEGMENT.test(segment)) return { status: 400 };
    segments.push(segment);
  }
  return { segments };
}

/** @param {string} file */
const isFile = file => stat(file).then(info => info.isFile(), () => false);

/**
 * @param {{ dir: string, csp: () => string, log?: (message: string) => void }} options
 *   `dir` holds the built app (index.html and assets/); `csp` is the Content-Security-Policy for the
 *   current listener (it names the bound port).
 */
export function createStaticServer({ dir, csp, log = () => {} }) {
  const configured = path.resolve(dir);
  /** @type {Promise<string | undefined> | undefined} */
  let root;
  /** The app directory's real path while it holds an index.html; checked again after a miss. */
  const appRoot = async () => {
    const found = await (root ??= realpath(configured).then(async real => (await isFile(path.join(real, 'index.html')) ? real : undefined), () => undefined));
    if (!found) root = undefined;
    return found;
  };

  /** @param {string} type @param {string} cache */
  const headers = (type, cache) => ({
    'content-type': type,
    'cache-control': cache,
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'content-security-policy': csp(),
  });

  /** @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response @param {number} status @param {string} text */
  function plain(request, response, status, text) {
    response.writeHead(status, { ...headers('text/plain; charset=utf-8', 'no-store'), 'content-length': String(Buffer.byteLength(text)) });
    response.end(request.method === 'HEAD' ? undefined : text);
  }

  /** @param {string} base @param {string[]} segments @returns {Promise<string | undefined>} a regular file under `base`, by realpath */
  async function contained(base, segments) {
    const candidate = path.join(base, ...segments);
    let real;
    try { real = await realpath(candidate); } catch { return undefined; }
    if (real !== base && !real.startsWith(base + path.sep)) return undefined;
    return (await isFile(real)) ? real : undefined;
  }

  /**
   * The gateway's serveStatic hook.
   * @param {import('node:http').IncomingMessage} request @param {import('node:http').ServerResponse} response
   */
  return async function serveStatic(request, response) {
    const base = await appRoot();
    if (!base) {
      const page = missingPage(configured);
      response.writeHead(503, { ...headers('text/html; charset=utf-8', 'no-store'), 'content-length': String(Buffer.byteLength(page)) });
      response.end(request.method === 'HEAD' ? undefined : page);
      return true;
    }
    const target = parseTarget(request.url);
    if ('status' in target) { plain(request, response, 400, 'Bad request'); return true; }
    const { segments } = target;
    let file = segments.length ? await contained(base, segments) : undefined;
    if (!file) {
      const last = segments.at(-1) ?? '';
      if (path.extname(last)) { plain(request, response, 404, 'Not found'); return true; }
      // The app's own routes (and `/`): its index page.
      file = await contained(base, ['index.html']);
      if (!file) { plain(request, response, 404, 'Not found'); return true; }
    }
    const relative = path.relative(base, file).split(path.sep).join('/');
    const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
    const cache = relative === 'index.html' ? 'no-cache' : relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
    const { size } = await stat(file);
    response.writeHead(200, { ...headers(type, cache), 'content-length': String(size) });
    if (request.method === 'HEAD') { response.end(); return true; }
    createReadStream(file).on('error', error => { log(`could not read ${relative}: ${error.message}`); response.destroy(); }).pipe(response);
    return true;
  };
}
