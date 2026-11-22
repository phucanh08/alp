import * as React from 'react';
import { ArrowLeft, ArrowRight, Globe, RotateCw } from 'lucide-react';
import { BLANK_URL, OPEN_EVENT, isBrowsableUrl, isDesktopApp, readAddress } from '../lib/browser-url.js';
import { cn } from '../lib/utils';
import { useTabs } from './tabs';

/*
 * Paseo's Browser pane (packages/app/src/desktop/browser/pane), reduced to a web page and its
 * address bar: Back, Forward, Reload and the address. ALP.app only (t-9116, docs/alp/desktop.md):
 * the page is an Electron <webview> in its own partition, persist:alp-browser, and ALP.app's main
 * process decides what it may load and do (apps/desktop/src/browser.ts). Nothing here is a
 * security boundary: whatever this component asks for, the main process forces the partition,
 * drops any preload and refuses addresses outside http, https and about:blank.
 *
 * A page that opens a new window (window.open, target=_blank) gets a new Browser tab: the main
 * process refuses the window and dispatches OPEN_EVENT with the page's webContents id and the
 * address; the tab whose page that is opens it. Outside ALP.app the tab says where it works.
 */

export const BROWSER_PARTITION = 'persist:alp-browser';

/** The <webview> element's methods used here (Electron's WebviewTag). */
type Webview = HTMLElement & {
  loadURL(url: string): Promise<void>;
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  getWebContentsId(): number;
};

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';
const tool = cn('flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4', focusRing);

export function BrowserPanel({ id }: { id: string }) {
  if (!isDesktopApp()) {
    return (
      <div className="flex min-h-full flex-1 flex-col items-center justify-center gap-2 p-6 text-center" role="note" data-testid="browser-unavailable">
        <Globe aria-hidden strokeWidth={1.5} className="size-6 text-extra-muted" />
        <p className="text-sm text-foreground">Only available in ALP.app</p>
        <p className="max-w-[300px] text-xs leading-5 text-muted-foreground">Browser tabs open web pages inside the ALP desktop app. Open this workspace there to use this tab.</p>
      </div>
    );
  }
  return <DesktopBrowser id={id} />;
}

function DesktopBrowser({ id }: { id: string }) {
  const { browserUrl, setBrowserUrl, openBrowser } = useTabs();
  const host = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<Webview | null>(null);
  const input = React.useRef<HTMLInputElement>(null);
  // The address the tab opens with; later navigation is the page's own and is only recorded.
  const initial = React.useRef(browserUrl(id) ?? BLANK_URL);
  const [address, setAddress] = React.useState(initial.current === BLANK_URL ? '' : initial.current);
  const [history, setHistory] = React.useState({ back: false, forward: false });
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const keep = React.useRef({ setBrowserUrl, openBrowser });
  keep.current = { setBrowserUrl, openBrowser };
  /**
   * Whether the guest has emitted dom-ready, before which <webview>.loadURL throws (synchronously,
   * not as a rejected promise); an address submitted before then waits in `pending` and loads at
   * dom-ready. On a slow start (a cold machine) a user can type an address first (t-a876).
   */
  const attached = React.useRef(false);
  const pending = React.useRef<string | null>(null);
  const load = React.useCallback((webview: Webview, url: string) => {
    const refused = () => setError(`${url} is blocked in Browser or did not load.`);
    try { webview.loadURL(url).catch(refused); } catch { refused(); }
  }, []);

  React.useEffect(() => {
    const container = host.current;
    if (!container) return;
    const webview = document.createElement('webview') as Webview;
    // The partition before src: Electron reads it when the guest is created.
    webview.setAttribute('partition', BROWSER_PARTITION);
    // Needed for window.open to reach the main process's handler, which always refuses the
    // window and asks for a tab instead (apps/desktop/src/browser.ts).
    webview.setAttribute('allowpopups', 'true');
    webview.setAttribute('src', initial.current);
    webview.setAttribute('data-testid', 'browser-webview');
    webview.className = 'flex size-full';
    let guest: number | undefined;
    attached.current = false;
    pending.current = null;
    const sync = () => {
      try { setHistory({ back: webview.canGoBack(), forward: webview.canGoForward() }); } catch { /* not attached yet */ }
    };
    const navigated = (event: Event) => {
      const url = (event as Event & { url?: string }).url ?? '';
      const main = (event as Event & { isMainFrame?: boolean }).isMainFrame;
      if (main === false) return;
      setAddress(url === BLANK_URL ? '' : url);
      setError(null);
      if (isBrowsableUrl(url)) keep.current.setBrowserUrl(id, url);
      sync();
    };
    const failed = (event: Event) => {
      const { errorCode, errorDescription, validatedURL, isMainFrame } = event as Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean };
      // -3 is ERR_ABORTED: a load replaced by another, or one the main process stopped.
      if (!isMainFrame || errorCode === -3) return;
      setError(`${validatedURL} did not load (${errorDescription || errorCode}).`);
    };
    const ready = () => {
      try { guest = webview.getWebContentsId(); } catch { guest = undefined; }
      attached.current = true;
      const url = pending.current;
      pending.current = null;
      if (url !== null) load(webview, url);
      sync();
    };
    const start = () => setLoading(true);
    const stop = () => { setLoading(false); sync(); };
    const opened = (event: Event) => {
      const detail = (event as CustomEvent<{ guest?: unknown; url?: unknown }>).detail;
      if (!detail || guest === undefined || detail.guest !== guest || !isBrowsableUrl(detail.url)) return;
      keep.current.openBrowser(detail.url as string);
    };
    webview.addEventListener('did-navigate', navigated);
    webview.addEventListener('did-navigate-in-page', navigated);
    webview.addEventListener('did-fail-load', failed);
    webview.addEventListener('dom-ready', ready);
    webview.addEventListener('did-start-loading', start);
    webview.addEventListener('did-stop-loading', stop);
    window.addEventListener(OPEN_EVENT, opened);
    container.appendChild(webview);
    view.current = webview;
    if (initial.current === BLANK_URL) input.current?.focus({ preventScroll: true });
    return () => {
      window.removeEventListener(OPEN_EVENT, opened);
      view.current = null;
      attached.current = false;
      pending.current = null;
      webview.remove();
    };
  }, [id, load]);

  const go = (event: React.FormEvent) => {
    event.preventDefault();
    const result = readAddress(address);
    if ('error' in result) { setError(result.error); return; }
    setError(null);
    setAddress(result.url === BLANK_URL ? '' : result.url);
    // The main process refuses what a Browser tab may not show (file:, the dashboard itself…).
    const webview = view.current;
    if (!webview) return;
    if (attached.current) load(webview, result.url);
    else pending.current = result.url;
  };

  const act = (run: (webview: Webview) => void) => () => { const webview = view.current; if (webview) try { run(webview); } catch { /* not attached */ } };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="browser-panel">
      <form onSubmit={go} className="flex h-10 shrink-0 items-center gap-1 border-b border-border bg-background px-2">
        <button type="button" className={tool} aria-label="Back" title="Back" disabled={!history.back} onClick={act(webview => webview.goBack())} data-testid="browser-back"><ArrowLeft aria-hidden /></button>
        <button type="button" className={tool} aria-label="Forward" title="Forward" disabled={!history.forward} onClick={act(webview => webview.goForward())} data-testid="browser-forward"><ArrowRight aria-hidden /></button>
        <button type="button" className={tool} aria-label={loading ? 'Stop' : 'Reload'} title={loading ? 'Stop' : 'Reload'} onClick={act(webview => (loading ? webview.stop() : webview.reload()))} data-testid="browser-reload"><RotateCw aria-hidden className={cn(loading && 'animate-spin')} /></button>
        <input ref={input} value={address} onChange={event => setAddress(event.target.value)} aria-label="Address" placeholder="Type an address, such as localhost:3000"
          spellCheck={false} autoCapitalize="off" autoCorrect="off" data-testid="browser-address"
          className={cn('h-7 min-w-0 flex-1 rounded-md border border-border bg-card px-2 text-sm text-foreground placeholder:text-muted-foreground', 'outline-none focus-visible:border-ring')} />
      </form>
      {error ? <p role="alert" className="shrink-0 border-b border-border bg-card px-3 py-1.5 text-xs text-muted-foreground" data-testid="browser-error">{error}</p> : null}
      <div ref={host} className="relative flex min-h-0 flex-1 bg-background" />
    </div>
  );
}
