import * as React from 'react';
import { CircleAlert, Info, WifiOff, X } from 'lucide-react';
import type { SessionSummary } from '../lib/controller.js';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { ConnectScreen } from './ConnectScreen';
import { ArchiveDialog, NewSessionDialog, RenameDialog } from './Dialogs';
import { SettingsScreen } from './Settings';
import { SidePanel, type PanelTab } from './SidePanel';
import { Sidebar } from './Sidebar';
import { useAppState, useController } from './store';
import { TabsProvider } from './tabs';
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
    <div role={notice.level === 'error' ? 'alert' : 'status'} className={cn('fixed bottom-4 left-1/2 z-50 flex w-[min(92vw,28rem)] -translate-x-1/2 items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-xl shadow-black/40',
      notice.level === 'error' ? 'border-destructive/40 bg-[#2a1515] text-destructive' : 'border-border bg-popover text-foreground')}>
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

function Shell() {
  const wide = useMedia('(min-width: 1024px)');
  const medium = useMedia('(min-width: 768px)');
  const [navOpen, setNavOpen] = React.useState(false);
  const [panelOpen, setPanelOpen] = React.useState(false);
  const [panelTab, setPanelTab] = React.useState<PanelTab>('agents');
  const [creating, setCreating] = React.useState(false);
  const [settings, setSettings] = React.useState(false);
  const [renaming, setRenaming] = React.useState<SessionSummary | null>(null);
  const [archiving, setArchiving] = React.useState<SessionSummary | null>(null);
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
  const newSession = () => setCreating(true);

  return (
    <TabsProvider>
    <div className="flex h-dvh overflow-hidden" {...(settings ? { inert: true, 'aria-hidden': true } : {})}>
      {/* Navigation: a docked column from md up, a drawer below. */}
      {!medium && navOpen ? <div className="fixed inset-0 z-30 bg-black/60" aria-hidden onClick={() => setNavOpen(false)} /> : null}
      {medium && navHidden ? null : (
        <div className={cn('z-40 shrink-0 border-r border-border bg-sidebar', medium ? 'relative w-[320px]' : 'fixed inset-y-0 left-0 w-[min(100vw,22rem)] transition-transform duration-200', !medium && !navOpen && '-translate-x-full')}
          {...(!medium && !navOpen ? { inert: true } : {})}>
          <Sidebar onNewSession={newSession} onRename={setRenaming} onArchive={setArchiving} onSettings={() => setSettings(true)} onNavigate={() => setNavOpen(false)} onClose={medium ? undefined : () => setNavOpen(false)} />
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-background">
        <WorkspaceHeader navOpen={navShown} onToggleNav={() => medium ? setNavHidden(value => !value) : setNavOpen(value => !value)}
          explorerOpen={explorerShown} onToggleExplorer={() => wide ? setExplorerHidden(value => !value) : setPanelOpen(value => !value)}
          onRename={setRenaming} onArchive={setArchiving} />
        <ReconnectBanner />
        <TabsRow onNewSession={newSession} />
        <TabContent onNewSession={newSession} />
      </main>

      {explorerShown ? (
        <>
          {!wide ? <div className="fixed inset-0 z-30 bg-black/60" aria-hidden onClick={() => setPanelOpen(false)} /> : null}
          <div className={cn('shrink-0 border-l border-border bg-sidebar', wide ? 'relative w-[320px]' : 'fixed inset-y-0 right-0 z-40 w-[min(100vw,24rem)] shadow-2xl')}>
            <SidePanel tab={panelTab} onTab={setPanelTab} onClose={wide ? undefined : () => setPanelOpen(false)} />
          </div>
        </>
      ) : null}

      <NewSessionDialog open={creating} onClose={() => setCreating(false)} />
      <RenameDialog session={renaming} onClose={() => setRenaming(null)} />
      <ArchiveDialog session={archiving} onClose={() => setArchiving(null)} />
      <Notice />
    </div>
    {settings ? <div className="fixed inset-0 z-50"><SettingsScreen mobile={!medium} onClose={() => setSettings(false)} /></div> : null}
    </TabsProvider>
  );
}

export function App() {
  const { principal, connection } = useAppState();
  const connected = !!principal && (connection.phase === 'open' || connection.phase === 'reconnecting');
  return connected ? <Shell /> : <ConnectScreen />;
}
