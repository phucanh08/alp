/**
 * ALP desktop shell (D32, docs/alp/desktop.md): one window showing the user's own alp web. It runs
 * `alp web --print`, checks the address, and loads it; apps/web takes the token out of the address
 * and connects to its own origin. The window is a same-origin client of alp-web like a browser tab:
 * no preload, no Node, navigation pinned to that origin.
 */
import { app, BrowserWindow, Menu, session, shell, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { connectAlpWeb } from './alp-web';
import { isAllowedExternal, isAllowedPermission, navigationGuard } from './policy';
import { readSettings } from './settings';

let win: BrowserWindow | undefined;
/** The origin the window may show; undefined while it shows a bundled page. */
let allowedOrigin: string | undefined;
/** Each connect() takes the next number; only the latest one may change the window. */
let generation = 0;
/** The connect() whose alp web load is in the window; a failure of any other load is stale. */
let remoteLoad = 0;
/** The longest error text shown (alp's stderr can be long; it travels in the page's query). */
const MAX_MESSAGE = 4000;

const page = (name: string) => path.join(__dirname, 'pages', name);

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
    void showError(`The ALP web page did not load (${description}). Start ALP, then choose Connect again.`, window);
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (win === window) win = undefined; });
  return window;
}

/** A window created hidden is shown on its first paint; a page that fails to load never paints. */
function reveal(window: BrowserWindow | undefined) {
  if (window && !window.isDestroyed() && !window.isVisible()) window.show();
}

async function showMissing(override?: string, window = win) {
  allowedOrigin = undefined;
  await window?.loadFile(page('missing-alp.html'), { query: override ? { override } : {} }).catch(() => undefined);
  reveal(window);
}

async function showError(message: string, window = win) {
  allowedOrigin = undefined;
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
  allowedOrigin = undefined;
  remoteLoad = 0;
  await current()?.loadFile(page('connecting.html')).catch(() => undefined);
  reveal(current());
  let result: Awaited<ReturnType<typeof connectAlpWeb>>;
  try {
    const settings = await readSettings(app.getPath('userData'));
    result = await connectAlpWeb(settings.alpPath || process.env.ALP_DESKTOP_ALP || undefined);
  } catch (error) {
    // An unexpected rejection must not leave the window on Connecting with nothing to say.
    const window = current();
    if (window) await showError(error instanceof Error ? error.message : String(error), window);
    return;
  }
  const window = current();
  if (!window) return;
  if (result.ok) {
    allowedOrigin = result.address.origin;
    remoteLoad = id;
    // A failed load shows its error through did-fail-load; ERR_ABORTED means a newer load won.
    await window.loadURL(result.address.url).catch(() => undefined);
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
    buildMenu();
    void connect();
    app.on('activate', () => {
      if (!win) void connect();
    });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
