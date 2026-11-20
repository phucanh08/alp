/**
 * ALP desktop shell (D32, docs/alp/desktop.md): one window showing the user's own alp web. It runs
 * `alp web --print`, checks the address, and loads it; apps/web takes the token out of the address
 * and connects to its own origin. The window is a same-origin client of alp-web like a browser tab:
 * no preload, no Node, navigation pinned to that origin.
 */
import { app, BrowserWindow, Menu, session, shell, type MenuItemConstructorOptions } from 'electron';
import path from 'node:path';
import { connectAlpWeb } from './alp-web';
import { isAllowedExternal, isAllowedNavigation, isAllowedPermission } from './policy';
import { readSettings } from './settings';

let win: BrowserWindow | undefined;
/** The origin the window may show; undefined while it shows a bundled page. */
let allowedOrigin: string | undefined;
/** Each connect() takes the next number; only the latest one may change the window. */
let generation = 0;
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
  const guard = (event: Electron.Event, url: string) => { if (!isAllowedNavigation(url, allowedOrigin)) event.preventDefault(); };
  contents.on('will-navigate', guard);
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
    if (isMainFrame && code !== -3 && !url.startsWith('file:')) void showError(`The ALP web page did not load (${description}). Start ALP, then choose Connect again.`);
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (win === window) win = undefined; });
  return window;
}

async function showMissing(override?: string, window = win) {
  allowedOrigin = undefined;
  await window?.loadFile(page('missing-alp.html'), { query: override ? { override } : {} }).catch(() => undefined);
}

async function showError(message: string, window = win) {
  allowedOrigin = undefined;
  const text = message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message;
  await window?.loadFile(page('error.html'), { query: { message: text } }).catch(() => undefined);
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
  await current()?.loadFile(page('connecting.html')).catch(() => undefined);
  const settings = await readSettings(app.getPath('userData'));
  const result = await connectAlpWeb(settings.alpPath || process.env.ALP_DESKTOP_ALP || undefined);
  const window = current();
  if (!window) return;
  if (result.ok) {
    allowedOrigin = result.address.origin;
    // A failed load shows its error through did-fail-load; ERR_ABORTED means a newer load won.
    await window.loadURL(result.address.url).catch(() => undefined);
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
    if (!win) return;
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
