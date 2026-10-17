import * as React from 'react';
import { Archive, ArrowLeftToLine, ArrowRightToLine, ChevronLeft, ChevronRight, CircleAlert, Copy, CopyX, Info, Keyboard, PanelLeft, PanelRight, Pencil, Search, Settings, SquarePen, History as HistoryIcon, WifiOff, X } from 'lucide-react';
import { needsInput, type SessionSummary } from '../lib/controller.js';
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
import { BINDINGS, formatShortcut, isMacPlatform, shortcutKeys, type Binding } from '../lib/shortcuts.js';
import { baseName, relativeTime, sessionName } from '../lib/format';
import { CommandCenter, type RunnableAction } from './CommandCenter';
import { usePageAttention } from './attention';
import { bucketOf } from './Sidebar';
import { PANELS } from './panels';
import { closeRange } from '../lib/tab-close.js';
import type { PanelKind } from './panels';
import { TabContent, TabsRow, WorkspaceHeader } from './Workspace';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';

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

/** A binding's keys for a hint beside a command (the binding with `delta` when given). */
function hint(action: string, mac: boolean, delta?: number) {
  const binding = BINDINGS.find(entry => entry.action === action && entry.label && (delta === undefined || entry.delta === delta));
  return binding ? formatShortcut(shortcutKeys(binding, mac), mac) : undefined;
}

/**
 * The command center's actions, as Paseo's root and workspace contributions, with what ALP has:
 * the workspace's (new session, panels, tabs, the open session) and the app's (History,
 * Settings, shortcuts, sidebars, the sidebar's session search). Inside the tabs' provider.
 */
function CommandCenterHost({ open, onClose, history, onAction, onOpenSession }: {
  open: boolean;
  onClose: () => void;
  history: boolean;
  onAction: (action: string) => boolean | void;
  onOpenSession: (id: string) => void;
}) {
  const state = useAppState();
  const { workspace, principal, connection, sessions, tree, selected } = state;
  const { tabs, active, activate, close, closeOthers, openPanel } = useTabs();
  // Nothing to close, as the tab menu says (lib/tab-close.js).
  const none = (which: 'left' | 'right' | 'others') => !active || closeRange(tabs, active, which, selected).length === 0;
  const mac = React.useMemo(() => isMacPlatform(), []);
  const canWrite = can(principal ?? undefined, 'session.write');
  const online = connection.phase === 'open';
  const root = tree?.rootId;
  const shownTabs = !history && !!workspace;
  const at = active ? tabs.findIndex(tab => tabKey(tab) === tabKey(active)) : -1;
  const step = (delta: number) => { if (!tabs.length) return; const next = at < 0 ? (delta > 0 ? 0 : tabs.length - 1) : (at + delta + tabs.length) % tabs.length; activate(tabs[next]); onAction('tab.shown'); };
  const panel = (id: string, kind: keyof typeof PANELS, label: string, shortcut?: string): RunnableAction => ({
    id, label, group: 'workspace', icon: PANELS[kind].icon, shortcut, disabled: !workspace, keywords: ['tab', 'panel'],
    run: () => { openPanel(kind); onAction('tab.shown'); },
  });
  const actions: RunnableAction[] = [
    { id: 'new-session', label: 'New session', group: 'workspace', always: true, icon: SquarePen, shortcut: hint('session.new', mac), keywords: ['new agent', 'start'], disabled: !workspace || !canWrite || !online, run: () => onAction('session.new') },
    panel('new-terminal', 'terminal', 'New terminal', hint('tab.terminal', mac)),
    panel('open-changes', 'changes', 'Open Changes', hint('tab.changes', mac)),
    panel('open-files', 'files', 'Open Files', hint('tab.files', mac)),
    panel('open-diff', 'diff', 'Open Diff'),
    panel('open-tasks', 'tasks', 'Open Tasks'),
    panel('open-agents', 'agents', 'Open Agents'),
    { id: 'tab-previous', label: 'Previous tab', group: 'workspace', icon: ChevronLeft, shortcut: hint('tab.relative', mac, -1), disabled: !shownTabs || tabs.length < 2, run: () => step(-1) },
    { id: 'tab-next', label: 'Next tab', group: 'workspace', icon: ChevronRight, shortcut: hint('tab.relative', mac, 1), disabled: !shownTabs || tabs.length < 2, run: () => step(1) },
    { id: 'tab-close', label: 'Close current tab', group: 'workspace', icon: X, shortcut: hint('tab.close', mac), disabled: !shownTabs || !active, run: () => { if (active) close(active); } },
    { id: 'tab-close-left', label: 'Close to the left', group: 'workspace', icon: ArrowLeftToLine, keywords: ['tabs'], disabled: !shownTabs || none('left'), run: () => { if (active) closeOthers(active, 'left'); } },
    { id: 'tab-close-right', label: 'Close to the right', group: 'workspace', icon: ArrowRightToLine, keywords: ['tabs'], disabled: !shownTabs || none('right'), run: () => { if (active) closeOthers(active, 'right'); } },
    { id: 'tab-close-others', label: 'Close other tabs', group: 'workspace', icon: CopyX, disabled: !shownTabs || none('others'), run: () => { if (active) closeOthers(active, 'others'); } },
    { id: 'session-rename', label: 'Rename session', group: 'workspace', icon: Pencil, disabled: !root || !canWrite, run: () => onAction('session.rename') },
    { id: 'session-copy-id', label: 'Copy session ID', group: 'workspace', icon: Copy, keywords: ['agent id'], disabled: !root, run: () => { if (root) void navigator.clipboard?.writeText(root).catch(() => undefined); } },
    { id: 'session-archive', label: 'Archive session', group: 'workspace', icon: Archive, shortcut: hint('session.archive', mac), disabled: !root || !canWrite, run: () => onAction('session.archive') },
    { id: 'toggle-explorer', label: 'Toggle explorer', group: 'workspace', icon: PanelRight, shortcut: hint('sidebar.right', mac), disabled: history, run: () => onAction('sidebar.right') },
    { id: 'history', label: 'History', group: 'actions', always: true, icon: HistoryIcon, keywords: ['archived', 'sessions'], disabled: !workspace, run: () => onAction('history') },
    { id: 'settings', label: 'Settings', group: 'actions', always: true, icon: Settings, shortcut: hint('settings.toggle', mac), keywords: ['preferences', 'theme'], run: () => onAction('settings.toggle') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'actions', always: true, icon: Keyboard, shortcut: hint('shortcuts.toggle', mac), keywords: ['keys', 'help'], run: () => onAction('shortcuts.toggle') },
    { id: 'toggle-sidebar', label: 'Toggle left sidebar', group: 'actions', icon: PanelLeft, shortcut: hint('sidebar.left', mac), run: () => onAction('sidebar.left') },
    { id: 'search-sessions', label: 'Search sessions in the sidebar', group: 'actions', icon: Search, keywords: ['filter', 'find'], disabled: !workspace, run: () => onAction('search') },
  ];
  const rows = sessions.list.map(session => ({
    id: session.id,
    title: sessionName(session),
    subtitle: [workspace ? baseName(workspace) : '', session.status === 'closed' ? 'Closed' : relativeTime(session.updatedAt ?? session.createdAt)].filter(Boolean).join(' · '),
    bucket: bucketOf(session, needsInput(state, session.id)),
    updatedAt: session.updatedAt ?? session.createdAt,
  }));
  // The open session chosen again brings its tab to the front.
  const openSession = (id: string) => { if (id === state.selected) { activate({ kind: 'agent', id }); onAction('session.opened'); } else onOpenSession(id); };
  return <CommandCenter open={open} onClose={onClose} actions={actions} sessions={rows} onOpenSession={openSession} mac={mac} />;
}

/** The favicon, window title and browser notifications of the workspace's sessions. */
function PageAttention({ onOpenSession }: { onOpenSession: (id: string) => void }) {
  usePageAttention({ onOpenSession });
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
  const sidebarWidth = usePanelWidth('sidebar');
  const [draftRequest, setDraftRequest] = React.useState(0);
  const [settings, setSettings] = React.useState(false);
  const [renaming, setRenaming] = React.useState<SessionSummary | null>(null);
  const [archiving, setArchiving] = React.useState<SessionSummary | null>(null);
  const [history, setHistory] = React.useState(false);
  const [shortcuts, setShortcuts] = React.useState(false);
  const [searchRequest, setSearchRequest] = React.useState(0);
  const [commandCenter, setCommandCenter] = React.useState(false);
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
  // The explorer's room is the window less the docked sidebar (Paseo's container width).
  const dockWidth = usePanelWidth('dock', medium && navShown ? sidebarWidth.width : 0);
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
      case 'command-center.toggle': setCommandCenter(value => !value); return;
      case 'history':
        if (!workspace) return false;
        setHistory(true);
        return;
      case 'session.rename': {
        const summary = currentSummary();
        if (!summary || !canWrite) return false;
        setRenaming(summary);
        return;
      }
      case 'shortcuts.toggle': setShortcuts(value => !value); return;
      case 'settings.toggle': setCommandCenter(false); setSettings(value => !value); return;
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
        <div className={cn('z-40 shrink-0 border-r border-border bg-sidebar', medium ? 'relative' : 'fixed inset-y-0 left-0 w-[min(100vw,22rem)] transition-transform duration-200', !medium && !navOpen && '-translate-x-full')}
          style={medium ? { width: sidebarWidth.width } : undefined} data-testid="sidebar-column"
          {...(!medium && !navOpen ? { inert: true } : {})}>
          {medium ? <ResizeHandle which="sidebar" side="right" width={sidebarWidth.width} onWidth={sidebarWidth.setWidth} onCommit={sidebarWidth.save} testId="left-sidebar-resize-handle" /> : null}
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
            <TabsRow onNewSession={newSession} onRename={setRenaming} menuRequest={tabMenuRequest} onMenuRequestHandled={() => setTabMenuRequest(0)} />
            <TabContent onNewSession={newSession} />
          </>
        )}
      </main>

      {explorerShown && !history ? (
        <>
          {!wide ? <div className="fixed inset-0 z-30 bg-black/60" aria-hidden onClick={() => setPanelOpen(false)} /> : null}
          <div className={cn('shrink-0 border-l border-border bg-sidebar', wide ? 'relative' : 'fixed inset-y-0 right-0 z-40 w-[min(100vw,24rem)] shadow-2xl')}
            style={wide ? { width: dockWidth.width } : undefined} data-testid="explorer-column">
            {wide ? <ResizeHandle which="dock" side="left" width={dockWidth.width} reserved={dockWidth.reserved} onWidth={dockWidth.setWidth} onCommit={dockWidth.save} testId="workspace-explorer-sidebar-resize-handle" /> : null}
            <SidePanel dock={dock} onClose={wide ? undefined : () => setPanelOpen(false)} />
          </div>
        </>
      ) : null}

      <DraftOpener request={draftRequest} />
      <PageAttention onOpenSession={id => { controller.selectSession(id); setHistory(false); setSettings(false); }} />
      <RenameDialog session={renaming} onClose={() => setRenaming(null)} />
      <ArchiveDialog session={archiving} onClose={() => setArchiving(null)} />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
      <CommandCenterHost open={commandCenter} onClose={() => setCommandCenter(false)} history={history} onAction={onShortcut}
        onOpenSession={id => { controller.selectSession(id); setHistory(false); setNavOpen(false); }} />
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
