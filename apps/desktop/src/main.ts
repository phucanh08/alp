/**
 * ALP desktop shell (D32, docs/alp/desktop.md): one window showing the user's own alp dashboard. It runs
 * `alp dashboard --print`, checks the address, and loads it; apps/web takes the token out of the address
 * and connects to its own origin. The window is a same-origin client of alp-dashboard like a browser tab:
 * no preload, no Node, navigation pinned to that origin.
 */
import { app, BrowserWindow, Menu, net, protocol, session, shell, type MenuItemConstructorOptions } from 'electron';
import { randomUUID } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectDashboard, probeDashboard, type Connect } from './dashboard';
import { isAllowedExternal, isAllowedPermission, isTokenRejection, navigationGuard } from './policy';
import { Reconnector } from './reconnect';
import { isPageUrl, PAGE_SCHEME, pageUrl, resolvePage } from './pages';
import { readSettings } from './settings';
import { confirmAction, confirmQuery, installArgs, installEnv, installFailure, installPlan, installSource, latestRelease, type InstallPlan } from './install';
import { run } from './run';
import type { DashboardAddress } from './url';

let win: BrowserWindow | undefined;
/** The origin the window may show; undefined while it shows a bundled page. */
let allowedOrigin: string | undefined;
/** Each connect() takes the next number; only the latest one may change the window. */
let generation = 0;
/** The connect() whose alp dashboard load is in the window; a failure of any other load is stale. */
let remoteLoad = 0;
/** The address of the alp dashboard load in the window (remoteLoad); kept in memory only. */
let shownAddress: DashboardAddress | undefined;
/** Whether the window's document is the one loaded for shownAddress (did-navigate seen for it). */
let committed = false;
/** The install the confirmation page in the window offers; its buttons carry `nonce` (t-81b0.8). */
let pendingInstall: { nonce: string; plan: InstallPlan } | undefined;
/** True while install.sh runs: nothing else may change the window or start a second install. */
let installing = false;
/** The longest error text shown (alp's stderr can be long; it travels in the page's query). */
const MAX_MESSAGE = 4000;

/**
 * The app's own dist/pages (inside app.asar when packaged). Not __dirname: `bun build` writes the build
 * machine's source directory into the bundle in its place, so a packaged app looked for its pages on
 * the CI runner and every one of them was a blank window (t-81b0.7).
 */
const pagesDir = () => path.join(app.getAppPath(), 'dist', 'pages');

/** Answers alp-page://app/<name> (./pages.ts) with a bundled page, read in the main process. */
async function servePage(request: Request): Promise<Response> {
  const found = resolvePage(request.url, pagesDir());
  if (!found) return new Response('Not found', { status: 404 });
  try {
    return new Response(await readFile(found.file), { headers: { 'content-type': found.type } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

/** Shows bundled page `name` in `window`; resolves once it loaded or failed. */
const loadPage = (window: BrowserWindow, name: string, query?: Record<string, string>) => window.loadURL(pageUrl(name, query)).catch(() => undefined);

/** How long reading SHA256SUMS and running install.sh (a download of about 100 MB) may take. */
const LOOKUP_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 20 * 60_000;
/** The installer the app was built with (package.json's build copies the repository's install.sh). */
const installScript = () => path.join(app.getAppPath(), 'dist', 'install.sh');

/** A small text file over https (Chromium's network stack, with the system's proxy settings) or file://. */
async function readText(url: string): Promise<string> {
  if (url.startsWith('file://')) return readFile(fileURLToPath(url), 'utf8');
  const response = await net.fetch(url, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error('the file is too large');
  return text;
}

async function resolveAddress(): Promise<Connect> {
  const settings = await readSettings(app.getPath('userData'));
  return connectDashboard(settings.alpPath || process.env.ALP_DESKTOP_ALP || undefined);
}

/** Loads `address` into `window` as the latest connect; its outcome comes back as did-finish/fail-load. */
function loadRemote(window: BrowserWindow, address: DashboardAddress) {
  const id = ++generation;
  allowedOrigin = address.origin;
  shownAddress = address;
  remoteLoad = id;
  committed = false;
  // Only the fragment differs (alp dashboard rotated its token on the same port): Chromium navigates within
  // the page, and apps/web reads the token only when it loads, so the page is reloaded after it.
  const sameDocument = withoutFragment(window.webContents.getURL()) === withoutFragment(address.url);
  // A failed load shows up as did-fail-load; ERR_ABORTED means a newer load won.
  // The reload follows only a navigation that succeeded; a failed one is the reconnector's to retry.
  return window.loadURL(address.url).then(() => {
    if (sameDocument && id === generation && !window.isDestroyed()) window.webContents.reload();
  }, () => undefined);
}

const withoutFragment = (url: string) => url.split('#', 1)[0];

/** Watches a loaded alp dashboard and loads it again when it moved, restarted or rotated its token. */
const reconnector = new Reconnector({
  resolve: resolveAddress,
  probe: origin => probeDashboard(origin),
  load: address => {
    if (!win || win.isDestroyed()) { reconnector.stop(); return; }
    void loadRemote(win, address).then(() => reveal(win));
  },
  giveUp: (result, message) => {
    ++generation;
    if (result && !result.ok && 'missing' in result) void showMissing(result.override);
    else if (result && !result.ok) void showError(`Reconnecting to ALP dashboard failed: ${result.error} Choose Connect again to retry.`);
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
  // The confirmation page's buttons (t-81b0.8): a main-frame navigation that is stopped here and read.
  // will-frame-navigate, not will-navigate: Electron emits will-navigate only when the guard below has
  // not already prevented the navigation in will-frame-navigate.
  contents.on('will-frame-navigate', event => {
    const answer = event.isMainFrame ? confirmAction(event.url) : undefined;
    if (!answer) return;
    event.preventDefault();
    void answerInstall(window, answer);
  });
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
    if (!isMainFrame || code === -3 || isPageUrl(url) || remoteLoad !== generation) return;
    // A page that was up (or a reload of it) failing is the reconnector's: it retries before it shows anything.
    if (reconnector.active) { reconnector.loadFailed(); return; }
    void showError(`The ALP dashboard page did not load (${description}). Start ALP, then choose Connect again.`, window);
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

async function showMissing(override?: string, window = win, status?: string) {
  reconnector.stop();
  allowedOrigin = undefined;
  shownAddress = undefined;
  pendingInstall = undefined;
  if (window) await loadPage(window, 'missing-alp.html', { ...(override ? { override } : {}), ...(status ? { status } : {}) });
  reveal(window);
}

async function showError(message: string, window = win) {
  reconnector.stop();
  allowedOrigin = undefined;
  shownAddress = undefined;
  pendingInstall = undefined;
  const text = message.length > MAX_MESSAGE ? `${message.slice(0, MAX_MESSAGE)}…` : message;
  if (window) await loadPage(window, 'error.html', { message: text });
  reveal(window);
}

/**
 * Asks alp for the address and opens it, or shows why not. A later call (Connect again, a window
 * reopened from the Dock while an earlier `alp dashboard --print` still runs) supersedes an earlier one,
 * whose result is dropped; each one loads into the window that is current when it finishes.
 */
async function connect() {
  // Connect again with every window closed opens one (macOS keeps the app running).
  if (!win || win.isDestroyed()) win = createWindow();
  // An install under way finishes first; it connects when it is done.
  if (installing) { await loadPage(win, 'installing.html'); reveal(win); return; }
  const id = ++generation;
  const current = () => (id === generation && win && !win.isDestroyed() ? win : undefined);
  // A manual connect replaces any recovery under way.
  reconnector.stop();
  allowedOrigin = undefined;
  shownAddress = undefined;
  pendingInstall = undefined;
  remoteLoad = 0;
  const connecting = current();
  if (connecting) await loadPage(connecting, 'connecting.html');
  reveal(current());
  let result: Awaited<ReturnType<typeof connectDashboard>>;
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
  } else if ('missing' in result) {
    await showMissing(result.override, window);
    // An explicit alpPath that is wrong is the user's to fix: installing elsewhere would not be used.
    if (!result.override) await offerInstall(current);
  } else await showError(result.error, window);
}

/**
 * No alp was found: reads the latest release's SHA256SUMS and shows the confirmation page, which states
 * the version, the source and every path. Nothing is written before the user chooses Install there.
 */
async function offerInstall(current: () => BrowserWindow | undefined) {
  const checking = current();
  if (!checking) return;
  await loadPage(checking, 'missing-alp.html', { status: 'Looking for the latest ALP release…' });
  const source = installSource(app.isPackaged, process.env);
  // An x64 app under Rosetta: install.sh installs the arm64 build there, so that is the one named.
  const release = await latestRelease(source, app.runningUnderARM64Translation ? 'arm64' : process.arch, readText);
  const window = current();
  if (!window) return;
  if ('error' in release) { await showMissing(undefined, window, `${release.error} You can install ALP from a terminal instead.`); return; }
  const plan = installPlan(release, source, os.homedir(), process.env);
  const nonce = randomUUID();
  pendingInstall = { nonce, plan };
  await loadPage(window, 'install.html', confirmQuery(plan, nonce));
  reveal(window);
}

/** The confirmation page's answer; only the nonce of the page now shown counts, once. */
async function answerInstall(window: BrowserWindow, answer: { action: 'install' | 'cancel'; nonce: string }) {
  const pending = pendingInstall;
  if (!pending || pending.nonce !== answer.nonce || installing || window !== win) return;
  pendingInstall = undefined;
  if (answer.action === 'cancel') {
    await showMissing(undefined, window, 'Nothing was installed. Choose File › Connect again to be offered the install again.');
    return;
  }
  await install(window, pending.plan);
}

/** Runs the bundled install.sh for `plan`, then connects; a failure is shown with install.sh's reason. */
async function install(window: BrowserWindow, plan: InstallPlan) {
  installing = true;
  ++generation;
  let failure: string | undefined;
  const exists = (file: string) => lstat(file).then(() => true, () => false);
  const rootExisted = await exists(plan.root);
  try {
    await loadPage(window, 'installing.html', { version: plan.version, appDir: plan.appDir });
    const script = await readFile(installScript(), 'utf8');
    const result = await run('/bin/sh', ['-s', '--', ...installArgs(plan)], { input: script, env: installEnv(process.env), timeout: INSTALL_TIMEOUT_MS, killGroup: true });
    if (result.code !== 0) failure = installFailure(result);
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    installing = false;
  }
  if (failure !== undefined) {
    // install.sh writes nothing before the archive passed its checks; a later failure may leave part of it.
    const after = !rootExisted && !await exists(plan.root)
      ? `Nothing was installed (${plan.root} was not created).`
      : `The installer stopped before it finished; ALP ${plan.version} may be partly in place under ${plan.root}. Choose File › Connect again to use or reinstall it.`;
    await showError(`Installing ALP ${plan.version} failed: ${failure}\n\n${after}`, win && !win.isDestroyed() ? win : undefined);
    return;
  }
  await connect();
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
// The bundled pages' scheme, registered before ready with the one privilege they need: standard, so
// that relative page.css and page.js and CSP 'self' resolve against alp-page://app. Nothing else
// (secure, fetch, CORS, bypassCSP, service workers, stream): the pages are static text and two scripts.
protocol.registerSchemesAsPrivileged([{ scheme: PAGE_SCHEME, privileges: { standard: true } }]);
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
    protocol.handle(PAGE_SCHEME, servePage);
    // Everything is denied (camera, notifications, …) except clipboard writes from alp dashboard's origin.
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) => callback(isAllowedPermission(permission, details.requestingUrl, allowedOrigin)));
    session.defaultSession.setPermissionCheckHandler((_contents, permission, requestingOrigin) => isAllowedPermission(permission, requestingOrigin, allowedOrigin));
    // The page's gateway refused its token (POST /v1/tickets → 401, after `alp dashboard rotate`): ask alp
    // for the new address. Only the status and the path are read; the request is not touched.
    session.defaultSession.webRequest.onCompleted(details => {
      const window = win && !win.isDestroyed() ? win : undefined;
      if (isTokenRejection(details, { committed, windowId: window?.webContents.id, origin: allowedOrigin })) reconnector.trigger('token-rejected');
    });
    buildMenu();
    void connect();
    app.on('activate', () => {
      if (!win) void connect();
    });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
