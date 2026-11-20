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
let connecting = false;

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
  contents.on('did-fail-load', (_event, code, description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) void showError(`The ALP web page did not load (${description}). Start ALP, then choose Connect again.`);
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => { if (win === window) win = undefined; });
  return window;
}

async function showMissing(override?: string) {
  allowedOrigin = undefined;
  await win?.loadFile(page('missing-alp.html'), { query: override ? { override } : {} });
}

async function showError(message: string) {
  allowedOrigin = undefined;
  await win?.loadFile(page('error.html'), { query: { message } });
}

/** Asks alp for the address and opens it, or shows why not. */
async function connect() {
  if (connecting || !win) return;
  connecting = true;
  try {
    await win.loadFile(page('connecting.html'));
    const settings = await readSettings(app.getPath('userData'));
    const result = await connectAlpWeb(settings.alpPath || process.env.ALP_DESKTOP_ALP || undefined);
    if (!win) return;
    if (result.ok) {
      allowedOrigin = result.address.origin;
      await win.loadURL(result.address.url).catch(() => undefined);
    } else if ('missing' in result) await showMissing(result.override);
    else await showError(result.error);
  } finally { connecting = false; }
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
    win = createWindow();
    void connect();
    app.on('activate', () => {
      if (!win) { win = createWindow(); void connect(); }
    });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
