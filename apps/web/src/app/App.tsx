import * as React from 'react';
import { CircleAlert, Info, WifiOff, X } from 'lucide-react';
import type { SessionSummary } from '../lib/controller.js';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { ConnectScreen } from './ConnectScreen';
import { ArchiveDialog, RenameDialog } from './Dialogs';
import { SettingsScreen } from './Settings';
import { SidePanel, useDock } from './SidePanel';
import { Sidebar } from './Sidebar';
import { useAppState, useController } from './store';
import { HistoryScreen } from './History';
import { ShortcutsDialog, useShortcuts } from './Shortcuts';
import { TabsProvider, tabKey, useTabs } from './tabs';
import { can } from '../lib/gateway.js';
import { applyTheme } from '../lib/theme';
import type { Binding } from '../lib/shortcuts.js';
import type { PanelKind } from './panels';
import { TabContent, TabsRow, WorkspaceHeader } from './Workspace';

function useMedia(query: string) {
  const subscribe = React.useCallback((listener: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [query]);
  return React.useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

function Notice() {
  const controller = useController();
  const { notice } = useAppState();
  React.useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => controller.dismissNotice(), 8000);
    return () => clearTimeout(timer);
  }, [notice, controller]);
  if (!notice) return null;
  return (
    <div role={notice.level === 'error' ? 'alert' : 'status'} className={cn('fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,28rem)] -translate-x-1/2 items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-xl shadow-[var(--shadow)]',
      notice.level === 'error' ? 'border-destructive/40 bg-[var(--notice-error)] text-destructive' : 'border-border bg-popover text-foreground')}>
      {notice.level === 'error' ? <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /> : <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />}
      <span className="min-w-0 flex-1">{notice.text}</span>
      <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => controller.dismissNotice()}><X aria-hidden /></Button>
    </div>
  );
}

function ReconnectBanner() {
  const controller = useController();
  const { connection } = useAppState();
  if (connection.phase !== 'reconnecting') return null;
  return (
    <div role="status" className="flex items-center gap-2 border-b border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning">
      <WifiOff aria-hidden className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">Connection to the host lost. Reconnecting{connection.attempt > 1 ? ` (attempt ${connection.attempt})` : ''}… Work on the host keeps running.</span>
      <Button size="sm" variant="ghost" className="h-7 text-xs text-warning" onClick={() => controller.disconnect()}>Disconnect</Button>
    </div>
  );
}

/**
 * Paseo's workspace shortcuts (lib/shortcuts.js), run against the shell's state. Inside the tabs'
 * provider, so the tab actions reach the open tabs.
 */
function ShellShortcuts({ settings, history, onAction }: { settings: boolean; history: boolean; onAction: (action: string, binding: Binding, index?: number) => boolean | void }) {
  const controller = useController();
  const { tabs, active, activate, close, openPanel } = useTabs();
  const { sessions, selected } = useAppState();
  useShortcuts((binding, index) => {
    if (settings && binding.action !== 'settings.toggle') return false;
    const step = (list: unknown[], at: number, delta: number) => list.length ? (at < 0 ? (delta > 0 ? 0 : list.length - 1) : (at + delta + list.length) % list.length) : -1;
    switch (binding.action) {
      case 'session.index': {
        const session = sessions.list[(index ?? 1) - 1];
        if (!session) return false;
        controller.selectSession(session.id);
        return onAction('session.opened', binding);
      }
      case 'session.relative': {
        const next = step(sessions.list, sessions.list.findIndex(session => session.id === selected), binding.delta ?? 1);
        if (next < 0) return false;
        controller.selectSession(sessions.list[next].id);
        return onAction('session.opened', binding);
      }
      case 'tab.index': {
        const tab = tabs[(index ?? 1) - 1];
        if (!tab) return false;
        activate(tab);
        return onAction('tab.shown', binding);
      }
      case 'tab.relative': {
        const next = step(tabs, active ? tabs.findIndex(tab => tabKey(tab) === tabKey(active)) : -1, binding.delta ?? 1);
        if (next < 0) return false;
        activate(tabs[next]);
        return onAction('tab.shown', binding);
      }
      case 'tab.close':
        // History hides the tabs: nothing visible to close.
        if (!active || history) return false;
        close(active);
        return true;
      case 'tab.changes': case 'tab.files': case 'tab.terminal': {
        const kind = binding.action.slice(4) as PanelKind;
        openPanel(kind);
        return onAction('tab.shown', binding);
      }
      default:
        return onAction(binding.action, binding, index);
    }
  }, { allowInModal: ['settings.toggle'] });
  return null;
}

/** Opens the New session draft tab when the shell asks (the shell sits outside the tabs' provider). */
function DraftOpener({ request }: { request: number }) {
  const { openDraft } = useTabs();
  React.useEffect(() => { if (request) openDraft(); }, [request, openDraft]);
  return null;
}

function Shell() {
  const wide = useMedia('(min-width: 1024px)');
  const medium = useMedia('(min-width: 768px)');
  const [navOpen, setNavOpen] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const dock = useDock();
  const [draftRequest, setDraftRequest] = React.useState(0);
  const [settings, setSettings] = React.useState(false);
  const [renaming, setRenaming] = React.useState<SessionSummary | null>(null);
  const [archiving, setArchiving] = React.useState<SessionSummary | null>(null);
  const [history, setHistory] = React.useState(false);
  const [shortcuts, setShortcuts] = React.useState(false);
  const [searchRequest, setSearchRequest] = React.useState(0);
  const [tabMenuRequest, setTabMenuRequest] = React.useState(0);
  const controller = useController();
  const { selected, workspace, principal, connection, sessions, tree } = useAppState();
  const canWrite = can(principal ?? undefined, 'session.write');
  // A session opened or started from anywhere brings the workspace back in place of History.
  React.useEffect(() => { if (selected) setHistory(false); }, [selected]);
  // Desktop keeps both panels docked and lets the header toggles hide them; narrower screens
  // show each as an overlay the toggles open.
  const [navHidden, setNavHidden] = React.useState(false);
  const [explorerHidden, setExplorerHidden] = React.useState(false);
  const navShown = medium ? !navHidden : navOpen;
  const explorerShown = wide ? !explorerHidden : panelOpen;
  React.useEffect(() => {
    if (!navOpen && !panelOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setNavOpen(false); setPanelOpen(false); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navOpen, panelOpen]);
  // Paseo's new agent: a draft tab with the composer and the agent controls (NewSession.tsx).
  const newSession = () => setDraftRequest(value => value + 1);
  const toggleNav = () => medium ? setNavHidden(value => !value) : setNavOpen(value => !value);
  const toggleExplorer = () => wide ? setExplorerHidden(value => !value) : setPanelOpen(value => !value);
  const showNav = () => { if (medium) setNavHidden(false); else setNavOpen(true); };
  const currentSummary = (): SessionSummary | null => {
    const root = tree?.rootId;
    if (!root) return null;
    return sessions.list.find(session => session.id === root) ?? ({ id: root, title: tree.projection.sessions[root]?.title } as SessionSummary);
  };
  const onShortcut = (action: string): boolean | void => {
    switch (action) {
      case 'session.new': case 'tab.agent':
        if (!workspace || !canWrite || connection.phase !== 'open') return false;
        setHistory(false);
        newSession();
        return;
      case 'session.archive': {
        const summary = currentSummary();
        if (!summary || !canWrite || controller.isArchived(summary.id)) return false;
        setArchiving(summary);
        return;
      }
      case 'session.opened': case 'tab.shown':
        setHistory(false);
        return;
      case 'search':
        showNav();
        setSearchRequest(value => value + 1);
        return;
      case 'shortcuts.toggle': setShortcuts(value => !value); return;
      case 'settings.toggle': setSettings(value => !value); return;
      case 'tab.menu':
        if (!workspace || history) return false;
        setTabMenuRequest(value => value + 1);
        return;
      case 'sidebar.left': toggleNav(); return;
      case 'sidebar.right': toggleExplorer(); return;
      case 'sidebar.both': {
        // Paseo's toggleDesktopSidebars: both open only when both are closed; otherwise both close.
        const show = !navShown && !explorerShown;
        if (medium) setNavHidden(!show); else setNavOpen(show);
        if (wide) setExplorerHidden(!show); else setPanelOpen(show);
        return;
      }
      default: return false;
    }
  };

  return (
    <TabsProvider>
    <div className="flex h-dvh overflow-hidden" {...(settings ? { inert: true, 'aria-hidden': true } : {})}>
      {/* Navigation: a docked column from md up, a drawer below. */}
      {!medium && navOpen ? <div className="fixed inset-0 z-30 bg-black/60" aria-hidden onClick={() => setNavOpen(false)} /> : null}
      {medium && navHidden ? null : (
        <div className={cn('z-40 shrink-0 border-r border-border bg-sidebar', medium ? 'relative w-[320px]' : 'fixed inset-y-0 left-0 w-[min(100vw,22rem)] transition-transform duration-200', !medium && !navOpen && '-translate-x-full')}
          {...(!medium && !navOpen ? { inert: true } : {})}>
          <Sidebar onNewSession={() => { setHistory(false); newSession(); }} onRename={setRenaming} onArchive={setArchiving} onSettings={() => setSettings(true)} onNavigate={() => setNavOpen(false)} onClose={medium ? undefined : () => setNavOpen(false)}
            onHistory={() => setHistory(true)} historyOpen={history} onOpenSession={() => setHistory(false)} searchRequest={searchRequest} onSearchRequestHandled={() => setSearchRequest(0)} />
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-background">
        {history ? (
          <>
            <ReconnectBanner />
            <HistoryScreen navOpen={navShown} onToggleNav={toggleNav} onOpen={() => setHistory(false)} onBack={() => setHistory(false)} />
          </>
        ) : (
          <>
            <WorkspaceHeader navOpen={navShown} onToggleNav={toggleNav}
              explorerOpen={explorerShown} onToggleExplorer={toggleExplorer}
              onRename={setRenaming} onArchive={setArchiving} />
            <ReconnectBanner />
            <TabsRow onNewSession={newSession} menuRequest={tabMenuRequest} onMenuRequestHandled={() => setTabMenuRequest(0)} />
            <TabContent onNewSession={newSession} />
          </>
        )}
      </main>

      {explorerShown && !history ? (
        <>
          {!wide ? <div className="fixed inset-0 z-30 bg-black/60" aria-hidden onClick={() => setPanelOpen(false)} /> : null}
          <div className={cn('shrink-0 border-l border-border bg-sidebar', wide ? 'relative w-[320px]' : 'fixed inset-y-0 right-0 z-40 w-[min(100vw,24rem)] shadow-2xl')}>
            <SidePanel dock={dock} onClose={wide ? undefined : () => setPanelOpen(false)} />
          </div>
        </>
      ) : null}

      <DraftOpener request={draftRequest} />
      <RenameDialog session={renaming} onClose={() => setRenaming(null)} />
      <ArchiveDialog session={archiving} onClose={() => setArchiving(null)} />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
      <ShellShortcuts settings={settings} history={history} onAction={onShortcut} />
      <Notice />
    </div>
    {settings ? <div className="fixed inset-0 z-50" data-modal-overlay><SettingsScreen mobile={!medium} onClose={() => setSettings(false)} /></div> : null}
    </TabsProvider>
  );
}

export function App() {
  const { principal, connection, preferences } = useAppState();
  // Before paint, so a reload in light mode does not flash the dark palette.
  React.useLayoutEffect(() => applyTheme(preferences.theme), [preferences.theme]);
  const connected = !!principal && (connection.phase === 'open' || connection.phase === 'reconnecting');
  return connected ? <Shell /> : <ConnectScreen />;
}
