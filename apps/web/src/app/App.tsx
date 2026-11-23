import * as React from 'react';
import { Brain, Cpu, Shield, Archive, ArrowLeftRight, ArrowLeftToLine, ArrowRightToLine, ChevronLeft, ChevronRight, CircleAlert, Columns2, Copy, CopyX, Crosshair, Info, Keyboard, ListTodo, PanelLeft, PanelRight, Pencil, Rows2, Search, Settings, SquarePen, History as HistoryIcon, WifiOff, X } from 'lucide-react';
import { attentionReason, needsInput, type SessionSummary } from '../lib/controller.js';
import { Button } from '../components/ui/button';
import { cn } from '../lib/utils';
import { ConnectScreen } from './ConnectScreen';
import { ArchiveDialog, RenameDialog } from './Dialogs';
import { SettingsScreen } from './Settings';
import { SidePanel, useDock } from './SidePanel';
import { Sidebar, type SettingsTarget } from './Sidebar';
import { useAppState, useController } from './store';
import { HistoryScreen } from './History';
import { ShortcutsDialog, useDesktopCloseFallback, useShortcutOverrides, useShortcuts } from './Shortcuts';
import { TabsProvider, tabKey, useTabs, type Tab } from './tabs';
import { can } from '../lib/gateway.js';
import { applyAppearance, applyTheme } from '../lib/theme';
import { isMacPlatform, shortcutLabel, type Binding } from '../lib/shortcuts.js';
import { isDesktopApp } from '../lib/browser-url.js';
import { baseName, modeLabel, relativeTime, sessionName } from '../lib/format';
import { liveModels } from '../lib/configure.js';
import { effortOptions } from '../lib/new-session.js';
import { CommandCenter, useWorkspaceFileSource, type CommandScope, type RunnableAction } from './CommandCenter';
import { workspaceRows } from '../lib/command-center.js';
import { usePageAttention } from './attention';
import { bucketOf } from './Sidebar';
import { PANELS } from './panels';
import { closeRange } from '../lib/tab-close.js';
import type { PanelKind } from './panels';
import { SplitView, WorkspaceHeader } from './Workspace';
import { TasksScreen } from './TasksScreen';
import { SchedulesScreen } from './SchedulesScreen';
import { paneIds, type Direction } from '../lib/panes.js';
import { ResizeHandle, usePanelWidth } from './ResizeHandle';
import { WindowExplorerToggle, WindowSidebarToggle, WindowTogglesContext, useWindowControlsVisible } from './WindowChrome';
import { windowToggles } from '../lib/window-controls.js';

function useMedia(query: string) {
  const subscribe = React.useCallback((listener: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener('change', listener);
    return () => media.removeEventListener('change', listener);
  }, [query]);
  return React.useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false);
}

type NoticeEntry = ReturnType<typeof useAppState>['notices'][number];

/** One toast of the stack: its own 8 s, paused while the pointer or focus is on it. */
function Toast({ notice }: { notice: NoticeEntry }) {
  const controller = useController();
  const { openDraft } = useTabs();
  const [held, setHeld] = React.useState(false);
  const left = React.useRef(8000);
  React.useEffect(() => {
    if (held) return;
    const started = Date.now();
    const timer = setTimeout(() => controller.dismissNotice(notice.id), left.current);
    return () => { clearTimeout(timer); left.current = Math.max(0, left.current - (Date.now() - started)); };
  }, [held, notice.id, controller]);
  const error = notice.level === 'error';
  return (
    <div role={error ? 'alert' : 'status'} data-testid="notice" data-notice-id={notice.id}
      onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false); }}
      className={cn('flex w-full items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-xl shadow-[var(--shadow)]',
        error ? 'border-destructive/40 bg-[var(--notice-error)] text-destructive' : 'border-border bg-popover text-foreground')}>
      {error ? <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" /> : <Info aria-hidden className="mt-0.5 size-4 shrink-0 text-info" />}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{notice.text}</span>
      {notice.action === 'new-session' ? <Button size="sm" variant="secondary" className="h-7 shrink-0 text-xs" onClick={() => { controller.dismissNotice(notice.id); openDraft(); }}>New session</Button> : null}
      {/* Paseo's archive toast: Undo unarchives the session it names. */}
      {notice.action === 'undo-archive' && notice.target ? <Button size="sm" variant="secondary" className="h-7 shrink-0 text-xs" data-testid="notice-undo-archive" onClick={() => void controller.undoArchive(notice.target!)}>Undo</Button> : null}
      <Button size="icon-sm" variant="ghost" aria-label="Dismiss" onClick={() => controller.dismissNotice(notice.id)}><X aria-hidden /></Button>
    </div>
  );
}

/**
 * The notices as a stack of toasts (Paseo's toasts), newest at the bottom, at most three: each goes
 * after 8 s on its own, or with its x. In the page's flow, not over it, so a toast never hides
 * composer controls or a terminal.
 */
function Notices() {
  const { notices } = useAppState();
  if (!notices.length) return null;
  return (
    <div className="mx-auto my-2 flex w-[min(92%,28rem)] shrink-0 flex-col gap-2" data-testid="notice-stack" aria-label="Notifications">
      {notices.map(notice => <Toast key={notice.id} notice={notice} />)}
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
function ShellShortcuts({ settings, history, splits, onAction }: { settings: boolean; history: boolean; splits: boolean; onAction: (action: string, binding: Binding, index?: number) => boolean | void }) {
  const controller = useController();
  const { tabs: all, row, active, activate, close, openPanel, panes, focusedPane, splitEmpty, canSplitEmpty, closePane, focusAdjacent, moveTabAdjacent } = useTabs();
  // The tab keys go through the row on screen: the focused pane's, or every tab on a narrow window.
  const tabs = splits ? row : all;
  const { workspace } = useAppState();
  const many = paneIds(panes.root).length > 1;
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
      // Paseo's pane keys: on a wide enough window, with the workspace's tabs on screen.
      case 'pane.split.right': case 'pane.split.down':
        if (!splits || history || !workspace || !canSplitEmpty) return false;
        splitEmpty(binding.action === 'pane.split.right' ? 'right' : 'bottom');
        return;
      case 'pane.focus.left': case 'pane.focus.right': case 'pane.focus.up': case 'pane.focus.down':
        if (!splits || history || !many) return false;
        focusAdjacent(binding.action.slice(11) as Direction);
        return;
      case 'pane.move.left': case 'pane.move.right': case 'pane.move.up': case 'pane.move.down':
        if (!splits || history || !many) return false;
        moveTabAdjacent(binding.action.slice(10) as Direction);
        return;
      case 'pane.close':
        if (!splits || history || !many) return false;
        closePane(focusedPane);
        return;
      default:
        return onAction(binding.action, binding, index);
    }
  }, { allowInModal: ['settings.toggle'] });
  return null;
}

/** A binding's keys for a hint beside a command (the binding with `delta` when given). */
function hint(action: string, mac: boolean, delta?: 1 | -1) {
  return shortcutLabel(action, mac, isDesktopApp(), delta) || undefined;
}

/**
 * The command center's actions, as Paseo's root and workspace contributions, with what ALP has:
 * the workspace's (new session, panels, tabs, the open session) and the app's (History,
 * Settings, shortcuts, sidebars, the sidebar's session search). Inside the tabs' provider.
 */
function CommandCenterHost({ open, scope, onClose, history, splits, onAction, onOpenSession }: {
  open: boolean;
  scope: CommandScope;
  onClose: () => void;
  history: boolean;
  /** Whether the center can split (a wide enough window). */
  splits: boolean;
  onAction: (action: string) => boolean | void;
  onOpenSession: (id: string) => void;
}) {
  const state = useAppState();
  const controller = useController();
  const { workspace, principal, connection, sessions, tree, selected } = state;
  const { tabs: all, row, active, activate, close, closeOthers: closeRow, openPanel, openFile, panes, focusedPane, splitEmpty, canSplitEmpty, closePane, focusAdjacent, moveTabAdjacent } = useTabs();
  // The row on screen: the focused pane's, or every tab on a narrow window (as the tab menu).
  const tabs = splits ? row : all;
  const closeOthers = (tab: Tab, which: 'left' | 'right' | 'others') => closeRow(tab, which, splits ? undefined : all);
  const many = paneIds(panes.root).length > 1;
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
    // Paseo's pane commands, where the center can split.
    ...(splits ? paneActions() : []),
    { id: 'tab-switcher', label: 'Switch tab…', group: 'workspace', icon: ArrowLeftRight, keywords: ['tabs', 'search', 'find', 'go to'], disabled: !shownTabs || all.length < 1, run: () => onAction('tab.switcher') },
    ...agentActions(),
    { id: 'toggle-explorer', label: 'Toggle explorer', group: 'workspace', icon: PanelRight, shortcut: hint('sidebar.right', mac), disabled: history, run: () => onAction('sidebar.right') },
    { id: 'history', label: 'History', group: 'actions', always: true, icon: HistoryIcon, keywords: ['archived', 'sessions'], disabled: !workspace, run: () => onAction('history') },
    { id: 'settings', label: 'Settings', group: 'actions', always: true, icon: Settings, shortcut: hint('settings.toggle', mac), keywords: ['preferences', 'theme'], run: () => onAction('settings.toggle') },
    { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'actions', always: true, icon: Keyboard, shortcut: hint('shortcuts.toggle', mac), keywords: ['keys', 'help'], run: () => onAction('shortcuts.toggle') },
    { id: 'toggle-sidebar', label: 'Toggle left sidebar', group: 'actions', icon: PanelLeft, shortcut: hint('sidebar.left', mac), run: () => onAction('sidebar.left') },
    { id: 'search-sessions', label: 'Search sessions in the sidebar', group: 'actions', icon: Search, keywords: ['filter', 'find'], disabled: !workspace, run: () => onAction('search') },
    // What ALP's plugin adds to Paseo's command center (integrations/paseo/index.client.tsx).
    { id: 'alp-open-tasks', label: 'Open ALP tasks', group: 'alp', always: true, icon: ListTodo, keywords: ['tasks', 'todo', 'alp', 'panel'], disabled: !workspace, run: () => { openPanel('tasks'); onAction('tab.shown'); } },
    { id: 'alp-open-tasks-screen', label: 'Open ALP tasks full screen', group: 'alp', always: true, icon: ListTodo, keywords: ['tasks', 'todo', 'alp', 'phone'], disabled: !workspace, run: () => onAction('tasks.screen') },
  ];
  /**
   * The open session's agent, as the composer's controls change it: its model and thinking
   * (session.configure.live) and its permissions mode. Each choice is a row ("Model: …"), shown
   * when searched for; the current one is marked. A change the host cannot take now says why.
   */
  function agentActions(): RunnableAction[] {
    if (!root || !tree || history) return [];
    const rootSession = tree.projection.sessions[root];
    const listed = sessions.list.find(session => session.id === root);
    const runtime = rootSession?.runtime ?? listed?.runtime;
    const model = rootSession?.model ?? listed?.model;
    const thinking = rootSession?.thinking ?? listed?.thinking;
    const mode = rootSession?.mode ?? listed?.mode;
    const gate = controller.liveConfigure();
    const { same, current } = liveModels(state.catalog.models, { runtime, model });
    const configuring = !!state.busy.configure;
    const out: RunnableAction[] = [];
    if (gate.shown && model) {
      for (const entry of same) {
        out.push({ id: `agent-model:${entry.id}`, label: `Model: ${entry.label}`, group: 'agent', icon: Cpu, checked: entry.id === current?.id, keywords: ['model', 'change', 'switch', runtime ?? ''],
          disabled: configuring, run: () => { if (entry.id !== current?.id) void controller.configureLive({ model: entry.id }); } });
      }
    }
    if (gate.shown && thinking) {
      for (const entry of effortOptions(current)) {
        out.push({ id: `agent-thinking:${entry.id}`, label: `Thinking: ${entry.label}`, group: 'agent', icon: Brain, checked: entry.id === thinking, keywords: ['thinking', 'effort', 'reasoning', 'change'],
          disabled: configuring, run: () => { if (entry.id !== thinking) void controller.configureLive({ thinking: entry.id }); } });
      }
    }
    const modes = state.catalog.modes.length ? state.catalog.modes : mode ? [{ id: mode }] : [];
    if (mode && modes.length > 1) {
      // The host changes permissions only between turns, with no child session running.
      const locked = root in tree.projection.running || controller.rootBusy(root) || Object.keys(tree.projection.running).length > 0;
      for (const entry of modes) {
        const label = 'label' in entry && entry.label ? entry.label : modeLabel(entry.id);
        out.push({ id: `agent-mode:${entry.id}`, label: `Mode: ${label}`, group: 'agent', icon: Shield, checked: entry.id === mode, keywords: ['mode', 'permissions', 'change', entry.id],
          disabled: !!state.busy.mode || configuring || !canWrite || !online || !!controller.driveBlock(),
          run: () => {
            if (entry.id === mode) return;
            if (locked) { controller.notify('error', 'Permissions change once the agent and its team are idle.'); return; }
            void controller.configureMode(entry.id);
          } });
      }
    }
    return out;
  }
  function paneActions(): RunnableAction[] {
    const shown = shownTabs;
    const focus = (direction: Direction, label: string): RunnableAction => ({ id: `pane-focus-${direction}`, label, group: 'workspace', icon: Crosshair, keywords: ['pane', 'focus', direction], disabled: !shown || !many, run: () => { focusAdjacent(direction); } });
    const moveTab = (direction: Direction, label: string): RunnableAction => ({ id: `pane-move-tab-${direction}`, label, group: 'workspace', icon: ArrowLeftRight, keywords: ['pane', 'tab', 'move', direction], disabled: !shown || !many || !active, run: () => { moveTabAdjacent(direction); } });
    return [
      { id: 'pane-split-right', label: 'Split pane right', group: 'workspace', icon: Columns2, shortcut: hint('pane.split.right', mac), keywords: ['split', 'pane', 'vertical'], disabled: !shown || !canSplitEmpty, run: () => splitEmpty('right') },
      { id: 'pane-split-down', label: 'Split pane down', group: 'workspace', icon: Rows2, shortcut: hint('pane.split.down', mac), keywords: ['split', 'pane', 'horizontal'], disabled: !shown || !canSplitEmpty, run: () => splitEmpty('bottom') },
      focus('left', 'Focus pane left'), focus('right', 'Focus pane right'), focus('up', 'Focus pane up'), focus('down', 'Focus pane down'),
      moveTab('left', 'Move tab left'), moveTab('right', 'Move tab right'), moveTab('up', 'Move tab up'), moveTab('down', 'Move tab down'),
      { id: 'pane-close', label: 'Close pane', group: 'workspace', icon: X, shortcut: hint('pane.close', mac), keywords: ['pane', 'close'], disabled: !shown || !many, run: () => closePane(focusedPane) },
    ];
  }
  const rows = sessions.list.map(session => ({
    id: session.id,
    title: sessionName(session),
    subtitle: [workspace ? baseName(workspace) : '', session.status === 'closed' ? 'Closed' : relativeTime(session.updatedAt ?? session.createdAt)].filter(Boolean).join(' · '),
    bucket: bucketOf(session, needsInput(state, session.id), attentionReason(state, session.id)),
    attention: !!attentionReason(state, session.id),
    updatedAt: session.updatedAt ?? session.createdAt,
  }));
  // The open session chosen again brings its tab to the front.
  const openSession = (id: string) => { if (id === state.selected) { activate({ kind: 'agent', id }); onAction('session.opened'); } else onOpenSession(id); };
  // Paseo's Workspaces: every workspace the token grants, the open one marked.
  const workspaceList = React.useMemo(() => workspaceRows(principal?.workspaces ?? [], workspace), [principal, workspace]);
  // Paseo's file search (workspace.files.search) where the host offers it.
  const files = useWorkspaceFileSource();
  // Paseo opens the file in a tab: so does ALP where the host reads files (workspace.files.read)
  // and the token may (files.read). Otherwise the path goes to the clipboard, and the notice says why.
  const pickFile = (path: string) => {
    if (controller.filesReadable && controller.canReadFiles) { openFile(path); onAction('tab.shown'); return; }
    const why = controller.filesReadable ? 'this access token cannot read files' : 'this host does not offer file reading';
    const copy = navigator.clipboard?.writeText(path);
    if (!copy) { controller.notify('error', `Could not copy ${path}.`); return; }
    copy.then(() => controller.notify('info', `Copied ${path} (${why})`), () => controller.notify('error', `Could not copy ${path}.`));
  };
  const selectWorkspace = (path: string) => { controller.selectWorkspace(path); onAction('tab.shown'); };
  return <CommandCenter open={open} scope={scope} onClose={onClose} actions={actions} sessions={rows} workspaces={workspaceList} files={files}
    onOpenSession={openSession} onSelectWorkspace={selectWorkspace} onPickFile={pickFile} mac={mac} />;
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
  // Settings is open when set: true for its first page, or the page the sidebar asked for.
  const [settings, setSettings] = React.useState<boolean | SettingsTarget>(false);
  const [renaming, setRenaming] = React.useState<SessionSummary | null>(null);
  const [archiving, setArchiving] = React.useState<SessionSummary | null>(null);
  /**
   * Archive, as Paseo's: an idle or closed session goes at once and the toast offers Undo; one whose
   * agent is working asks first, since archiving stops that work (Undo brings the session back, not the turn).
   */
  const archive = (summary: SessionSummary) => {
    const working = summary.status === 'running' || !!summary.busy || (tree?.rootId === summary.id && summary.id in tree.projection.running);
    if (working) { setArchiving(summary); return; }
    void controller.archiveSession(summary.id).catch(error => controller.notify('error', `Could not archive the session: ${error?.message ?? error}`));
  };
  const [history, setHistory] = React.useState(false);
  const [shortcuts, setShortcuts] = React.useState(false);
  const [searchRequest, setSearchRequest] = React.useState(0);
  // Closed, or open in a scope (Mod+P: Files).
  const [commandCenter, setCommandCenter] = React.useState<false | { scope: CommandScope }>(false);
  const [tabMenuRequest, setTabMenuRequest] = React.useState(0);
  const [tabSwitcherRequest, setTabSwitcherRequest] = React.useState(0);
  // ALP's tasks board in place of the workspace (Open ALP tasks full screen), as History.
  const [tasksScreen, setTasksScreen] = React.useState(false);
  // The host owner's Schedules list in place of the workspace (the sidebar's Schedules row), as History.
  const [schedulesScreen, setSchedulesScreen] = React.useState(false);
  const toWorkspace = () => { setHistory(false); setTasksScreen(false); setSchedulesScreen(false); };
  const openHistory = () => { setTasksScreen(false); setSchedulesScreen(false); setHistory(true); };
  // The workspace's tabs are not on screen.
  const away = history || tasksScreen || schedulesScreen;
  const controller = useController();
  const { selected, workspace, principal, connection, sessions, tree } = useAppState();
  const canWrite = can(principal ?? undefined, 'session.write');
  // A session opened or started from anywhere brings the workspace back in place of History.
  React.useEffect(() => { if (selected) { setHistory(false); setTasksScreen(false); setSchedulesScreen(false); } }, [selected]);
  // Desktop keeps both panels docked and lets the header toggles hide them; narrower screens
  // show each as an overlay the toggles open.
  const [navHidden, setNavHidden] = React.useState(false);
  const [explorerHidden, setExplorerHidden] = React.useState(false);
  const navShown = medium ? !navHidden : navOpen;
  // The explorer's room is the window less the docked sidebar (Paseo's container width).
  const dockWidth = usePanelWidth('dock', medium && navShown ? sidebarWidth.width : 0);
  const explorerShown = wide ? !explorerHidden : panelOpen;
  // ALP.app on macOS: the top row's toggles belong to the window, as Paseo's titlebar (WindowChrome.tsx).
  const windowControls = useWindowControlsVisible();
  const toggles = React.useMemo(() => windowToggles({ overlay: windowControls, medium, wide, workspace: !away, settings: !!settings }), [windowControls, medium, wide, away, settings]);
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
        toWorkspace();
        newSession();
        return;
      case 'session.archive': {
        const summary = currentSummary();
        if (!summary || !canWrite || controller.isArchived(summary.id)) return false;
        archive(summary);
        return;
      }
      case 'session.opened': case 'tab.shown':
        toWorkspace();
        return;
      case 'search':
        showNav();
        setSearchRequest(value => value + 1);
        return;
      case 'command-center.toggle': setCommandCenter(value => value ? false : { scope: null }); return;
      case 'command-center.files': setCommandCenter({ scope: 'files' }); return;
      case 'history':
        if (!workspace) return false;
        openHistory();
        return;
      case 'session.rename': {
        const summary = currentSummary();
        if (!summary || !canWrite) return false;
        setRenaming(summary);
        return;
      }
      case 'shortcuts.toggle': setShortcuts(value => !value); return;
      case 'tasks.screen':
        if (!workspace) return false;
        setHistory(false);
        setSchedulesScreen(false);
        setTasksScreen(true);
        return;
      case 'settings.toggle': setCommandCenter(false); setSettings(value => !value); return;
      case 'tab.menu':
        if (!workspace || away) return false;
        setTabMenuRequest(value => value + 1);
        return;
      case 'tab.switcher':
        if (!workspace || away) return false;
        setTabSwitcherRequest(value => value + 1);
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
    <WindowTogglesContext.Provider value={toggles}>
    <div className="flex h-dvh overflow-hidden" {...(settings ? { inert: true, 'aria-hidden': true } : {})}>
      {toggles.sidebarToggle ? <WindowSidebarToggle navOpen={navShown} onToggleNav={toggleNav} /> : null}
      {/* Navigation: a docked column from md up, a drawer below. */}
      {!medium && navOpen ? <div className="fixed inset-0 z-30 bg-black/60" aria-hidden onClick={() => setNavOpen(false)} /> : null}
      {medium && navHidden ? null : (
        <div className={cn('z-40 shrink-0 border-r border-border bg-sidebar', medium ? 'relative' : 'fixed inset-y-0 left-0 w-[min(100vw,22rem)] transition-transform duration-200', !medium && !navOpen && '-translate-x-full')}
          style={medium ? { width: sidebarWidth.width } : undefined} data-testid="sidebar-column"
          {...(!medium && !navOpen ? { inert: true } : {})}>
          {medium ? <ResizeHandle which="sidebar" side="right" width={sidebarWidth.width} onWidth={sidebarWidth.setWidth} onCommit={sidebarWidth.save} testId="left-sidebar-resize-handle" /> : null}
          <Sidebar onNewSession={() => { toWorkspace(); newSession(); }} onRename={setRenaming} onArchive={archive} onSettings={page => setSettings(page ?? true)} onShortcuts={() => setShortcuts(true)} onNavigate={() => setNavOpen(false)} onClose={medium ? undefined : () => setNavOpen(false)}
            onHistory={() => openHistory()} historyOpen={history} onTasks={() => { if (workspace) { setHistory(false); setSchedulesScreen(false); setTasksScreen(true); } }} tasksOpen={tasksScreen}
            onSchedules={() => { setHistory(false); setTasksScreen(false); setSchedulesScreen(true); }} schedulesOpen={schedulesScreen} onOpenSession={() => toWorkspace()} searchRequest={searchRequest} onSearchRequestHandled={() => setSearchRequest(0)} />
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col bg-background">
        {schedulesScreen ? (
          <>
            <ReconnectBanner />
            <SchedulesScreen navOpen={navShown} onToggleNav={toggleNav} onClose={toWorkspace}
              onOpenSession={(root, id) => { if (root !== workspace && principal?.workspaces.includes(root)) controller.selectWorkspace(root); controller.selectSession(id); toWorkspace(); }} />
          </>
        ) : tasksScreen ? (
          <>
            <ReconnectBanner />
            <TasksScreen navOpen={navShown} onToggleNav={toggleNav} onClose={toWorkspace} />
          </>
        ) : history ? (
          <>
            <ReconnectBanner />
            <HistoryScreen navOpen={navShown} onToggleNav={toggleNav} onOpen={() => toWorkspace()} onBack={() => toWorkspace()} />
          </>
        ) : (
          <>
            <WorkspaceHeader navOpen={navShown} onToggleNav={toggleNav}
              explorerOpen={explorerShown} onToggleExplorer={toggleExplorer}
              onRename={setRenaming} onArchive={archive} />
            <ReconnectBanner />
            <SplitView splits={medium} onNewSession={newSession} onRename={setRenaming} menuRequest={tabMenuRequest} onMenuRequestHandled={() => setTabMenuRequest(0)}
              switcherRequest={tabSwitcherRequest} onSwitcherRequestHandled={() => setTabSwitcherRequest(0)} />
          </>
        )}
        {/* Reserve the notice's real height: overlays can hide composer controls or terminals. */}
        <Notices />
      </main>

      {toggles.explorerToggle ? <WindowExplorerToggle explorerOpen={explorerShown} onToggleExplorer={toggleExplorer} /> : null}
      {explorerShown && !away ? (
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
      <PageAttention onOpenSession={id => { controller.selectSession(id); toWorkspace(); setSettings(false); }} />
      <RenameDialog session={renaming} onClose={() => setRenaming(null)} />
      <ArchiveDialog session={archiving} onClose={() => setArchiving(null)} />
      <ShortcutsDialog open={shortcuts} onClose={() => setShortcuts(false)} />
      <CommandCenterHost open={!!commandCenter} scope={commandCenter ? commandCenter.scope : null} onClose={() => setCommandCenter(false)} history={away} splits={medium} onAction={onShortcut}
        onOpenSession={id => { controller.selectSession(id); toWorkspace(); setNavOpen(false); }} />
      <ShellShortcuts settings={!!settings} history={away} splits={medium} onAction={onShortcut} />
    </div>
    {settings ? <div className="fixed inset-0 z-50" data-modal-overlay><SettingsScreen mobile={!medium} initialPage={typeof settings === 'string' ? settings : undefined} onClose={() => setSettings(false)} /></div> : null}
    </WindowTogglesContext.Provider>
    </TabsProvider>
  );
}

export function App() {
  const { principal, connection, preferences } = useAppState();
  // Before paint, so a reload in light mode does not flash the dark palette.
  React.useLayoutEffect(() => applyTheme(preferences.theme, preferences.syntaxTheme), [preferences.theme, preferences.syntaxTheme]);
  const { uiFontFamily, monoFontFamily, uiFontSize, contentFontSize, codeFontSize, contentMaxWidth } = preferences;
  React.useLayoutEffect(() => applyAppearance({ uiFontFamily, monoFontFamily, uiFontSize, contentFontSize, codeFontSize, contentMaxWidth }),
    [uiFontFamily, monoFontFamily, uiFontSize, contentFontSize, codeFontSize, contentMaxWidth]);
  useDesktopCloseFallback();
  useShortcutOverrides();
  const connected = !!principal && (connection.phase === 'open' || connection.phase === 'reconnecting');
  return connected ? <Shell /> : <ConnectScreen />;
}
