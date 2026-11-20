/**
 * ALP desktop shell (D32, docs/alp/desktop.md): one window showing the user's own alp web. It runs
 * `alp web --print`, checks the address, and loads it; apps/web takes the token out of the address
 * and connects to its own origin. The window is a same-origin client of alp-web like a browser tab:
 * no preload, no Node, navigation pinned to that origin.
 */
import { app, BrowserWindow, Menu, session, shell, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { connectAlpWeb, probeAlpWeb, type Connect } from './alp-web';
import { isAllowedExternal, isAllowedPermission, isTicketRequest, navigationGuard } from './policy';
import { Reconnector } from './reconnect';
import { readSettings } from './settings';
import type { AlpWebAddress } from './url';

let win: BrowserWindow | undefined;
/** The origin the window may show; undefined while it shows a bundled page. */
let allowedOrigin: string | undefined;
/** Each connect() takes the next number; only the latest one may change the window. */
let generation = 0;
/** The connect() whose alp web load is in the window; a failure of any other load is stale. */
let remoteLoad = 0;
/** The address of the alp web load in the window (remoteLoad); kept in memory only. */
let shownAddress: AlpWebAddress | undefined;
/** Whether the window's document is the one loaded for shownAddress (did-navigate seen for it). */
let committed = false;
/** The longest error text shown (alp's stderr can be long; it travels in the page's query). */
const MAX_MESSAGE = 4000;

const page = (name: string) => path.join(__dirname, 'pages', name);

async function resolveAddress(): Promise<Connect> {
  const settings = await readSettings(app.getPath('userData'));
  return connectAlpWeb(settings.alpPath || process.env.ALP_DESKTOP_ALP || undefined);
}

/** Loads `address` into `window` as the latest connect; its outcome comes back as did-finish/fail-load. */
function loadRemote(window: BrowserWindow, address: AlpWebAddress) {
  const id = ++generation;
  allowedOrigin = address.origin;
  shownAddress = address;
  remoteLoad = id;
  committed = false;
  // A failed load shows up as did-fail-load; ERR_ABORTED means a newer load won.
  return window.loadURL(address.url).catch(() => undefined);
}

/** Watches a loaded alp web and loads it again when it moved, restarted or rotated its token. */
const reconnector = new Reconnector({
  resolve: resolveAddress,
  probe: origin => probeAlpWeb(origin),
  load: address => {
    if (!win || win.isDestroyed()) { reconnector.stop(); return; }
    void loadRemote(win, address).then(() => reveal(win));
  },
  giveUp: (result, message) => {
    ++generation;
    if (result && !result.ok && 'missing' in result) void showMissing(result.override);
    else if (result && !result.ok) void showError(`Reconnecting to ALP web failed: ${result.error} Choose Connect again to retry.`);
    else void showError(message);
  },
});

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 720,
    minHeight: 480,
    title: 'ALP',
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  const contents = window.webContents;
  // Every frame, the main one and any subframe, stays on the shown origin: will-frame-navigate is
  // will-navigate for all frames, and will-redirect fires for redirects in any frame.
  const guard = navigationGuard(() => allowedOrigin);
  contents.on('will-navigate', guard);
  contents.on('will-frame-navigate', guard);
  contents.on('will-redirect', guard);
  contents.on('will-attach-webview', event => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  // Never log the URL: before apps/web runs, it still carries the token.
  // -3 (ERR_ABORTED) is a load replaced by another one. A bundled page that fails is not retried
  // with another bundled page, which could loop.
  contents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    // Only the load of the latest connect() may show an error; an older one was superseded.
    if (!isMainFrame || code === -3 || url.startsWith('file:') || remoteLoad !== generation) return;
    // A page that was up (or a reload of it) failing is the reconnector's: it retries before it shows anything.
    if (reconnector.active) { reconnector.loadFailed(); return; }
    void showError(`The ALP web page did not load (${description}). Start ALP, then choose Connect again.`, window);
  });
  // The new document has replaced the old one: from now on a 401 is the new page's, not a late one
  // from the page being replaced (whose requests Chromium cancels at this point).
  contents.on('did-navigate', (_event, url) => {
    if (remoteLoad !== generation || !shownAddress) return;
    try { if (new URL(url).origin === shownAddress.origin) committed = true; } catch { /* not a URL */ }
  });
  contents.on('did-finish-load', () => {
    if (remoteLoad !== generation || !shownAddress) return;
    let origin: string;
    try { origin = new URL(contents.getURL()).origin; } catch { return; }
    if (origin === shownAddress.origin) reconnector.loaded(shownAddress);
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (win !== window) return;
    win = undefined;
    reconnector.stop();
  });
  return window;
}

/** A window created hidden is shown on its first paint; a page that fails to load never paints. */
function reveal(window: BrowserWindow | undefined) {
  if (window && !window.isDestroyed() && !window.isVisible()) window.show();
}

async function showMissing(override?: string, window = win) {
  reconnector.stop();
  allowedOrigin = undefined;
  shownAddress = undefined;
  await window?.loadFile(page('missing-alp.html'), { query: override ? { override } : {} }).catch(() => undefined);
  reveal(window);
}

async function showError(message: string, window = win) {
  reconnector.stop();
  allowedOrigin = undefined;
  shownAddress = undefined;
  const text = message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message;
  await window?.loadFile(page('error.html'), { query: { message: text } }).catch(() => undefined);
  reveal(window);
}

/**
 * Asks alp for the address and opens it, or shows why not. A later call (Connect again, a window
 * reopened from the Dock while an earlier `alp web --print` still runs) supersedes an earlier one,
 * whose result is dropped; each one loads into the window that is current when it finishes.
 */
async function connect() {
  // Connect again with every window closed opens one (macOS keeps the app running).
  if (!win || win.isDestroyed()) win = createWindow();
  const id = ++generation;
  const current = () => (id === generation && win && !win.isDestroyed() ? win : undefined);
  // A manual connect replaces any recovery under way.
  reconnector.stop();
  allowedOrigin = undefined;
  shownAddress = undefined;
  remoteLoad = 0;
  await current()?.loadFile(page('connecting.html')).catch(() => undefined);
  reveal(current());
  let result: Awaited<ReturnType<typeof connectAlpWeb>>;
  try {
    result = await resolveAddress();
  } catch (error) {
    // An unexpected rejection must not leave the window on Connecting with nothing to say.
    const window = current();
    if (window) await showError(error instanceof Error ? error.message : String(error), window);
    return;
  }
  const window = current();
  if (!window) return;
  if (result.ok) {
    await loadRemote(window, result.address);
    reveal(window);
  } else if ('missing' in result) await showMissing(result.override, window);
  else await showError(result.error, window);
}

function buildMenu() {
  const template: MenuItemConstructorOptions[] = [
    { role: 'appMenu' },
    { label: 'File', submenu: [{ label: 'Connect again', accelerator: 'CmdOrCtrl+Shift+R', click: () => void connect() }, { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'reload' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' } as MenuItemConstructorOptions]), { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Tests and a second profile use their own data directory; it must be set before ready.
if (process.env.ALP_DESKTOP_USER_DATA) app.setPath('userData', path.resolve(process.env.ALP_DESKTOP_USER_DATA));
app.enableSandbox();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // macOS keeps the app running with no window; opening it again must show one.
    if (!win || win.isDestroyed()) { void connect(); return; }
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  // No webview, no remote content in other frames, no new windows anywhere.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.setWindowOpenHandler(({ url }) => {
      if (isAllowedExternal(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
  });
  app.whenReady().then(() => {
    // Everything is denied (camera, notifications, …) except clipboard writes from alp web's origin.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(isAllowedPermission(permission, details.requestingUrl, allowedOrigin)));
    session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => isAllowedPermission(permission, requestingOrigin, allowedOrigin));
    // The page's gateway refused its token (POST /v1/tickets → 401, after `alp web rotate`): ask alp
    // for the new address. Only the status and the path are read; the request is not touched.
    session.defaultSession.webRequest.onCompleted(details => {
      if (details.statusCode !== 401 || details.method !== 'POST' || !committed) return;
      if (!win || win.isDestroyed() || details.webContentsId !== win.webContents.id) return;
      if (isTicketRequest(details.url, allowedOrigin)) reconnector.trigger('token-rejected');
    });
    buildMenu();
    void connect();
    app.on('activate', () => {
      if (!win) void connect();
    });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
