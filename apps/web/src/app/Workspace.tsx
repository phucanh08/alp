import * as React from 'react';
import { Check, GitBranch, SquareTerminal, ArrowLeftToLine, ArrowRightToLine, Bot, CircleAlert, CircleDot, Columns2, Copy, CopyX, Ellipsis, FileText, ListTodo, Maximize, Minimize, PanelBottom, PanelLeft, PanelRight, PanelTop, Pencil, Plus, RotateCw, Rows2, Shrink, ShieldAlert, SquarePen, Archive, X } from 'lucide-react';
import type { SessionSummary } from '../lib/controller.js';
import { can } from '../lib/gateway.js';
import { ContextMenu, Menu, type MenuItem } from '../components/ui/menu';
import { moveKey, orderTabs } from '../lib/layout.js';
import { matchScore } from '../lib/command-center.js';
import { closeRange } from '../lib/tab-close.js';
import { MAIN_PANE, MIN_SPLIT_SIZE, dropPosition, paneIds, splitPane, type GroupNode, type SplitNode, type SplitPosition } from '../lib/panes.js';
import { isMacPlatform, shortcutLabel } from '../lib/shortcuts.js';
import { baseName, sessionName } from '../lib/format';
import { cn } from '../lib/utils';
import { COMPACT_NOTE, RELOAD_NOTE } from '../lib/conversation.js';
import { newConversationRequestId } from '../lib/ids.js';
import { BROWSER, PANELS, PanelView, type PanelKind } from './panels';
import { BrowserHost, BrowserSlot } from './BrowserPanel';
import { browserLabel, isDesktopApp } from '../lib/browser-url.js';
import { NewSessionScreen } from './NewSession';
import { ChatPanel, Empty } from './SessionView';
import { StatusRing } from './status';
import { TabChip } from './TabChip';
import { PaneContext } from './pane';
import { TaskDetail } from './TaskDetail';
import { FileView } from './FileView';
import { ErrorBoundary, PaneErrorFallback } from './ErrorBoundary';
import { useAppState, useController } from './store';
import { readFacts } from '../lib/sidebar-facts.js';
import { tabKey, useTabs, type Tab } from './tabs';

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';
const headerButton = cn('flex size-8 shrink-0 items-center justify-center rounded-lg text-extra-muted hover:bg-secondary hover:text-foreground [&_svg]:size-[18px]', focusRing);

/**
 * Paseo's workspace header: the sidebar toggle, the title (the open session) with its project
 * beside it, the session's menu, and on the right the toggle for the explorer panel.
 */
export function WorkspaceHeader({ navOpen, onToggleNav, explorerOpen, onToggleExplorer, onRename, onArchive }: {
  navOpen: boolean;
  onToggleNav: () => void;
  explorerOpen: boolean;
  onToggleExplorer: () => void;
  onRename: (session: SessionSummary) => void;
  onArchive: (session: SessionSummary) => void;
}) {
  const controller = useController();
  const { tree, sessions, workspace, connection, principal, registry, owner } = useAppState();
  const { openPanel, openBrowser } = useTabs();
  const root = tree?.rootId;
  const snapshot = root ? tree.projection.sessions[root] : undefined;
  const listed = root ? sessions.list.find(session => session.id === root) : undefined;
  const title = root ? sessionName({ id: root, title: snapshot?.title ?? listed?.title }) : workspace ? baseName(workspace) : 'ALP';
  const running = !!root && root in tree.projection.running;
  const closed = !!root && !!tree.projection.closed[root];
  const canWrite = can(principal ?? undefined, 'session.write');
  const online = connection.phase === 'open';
  const summary: SessionSummary | undefined = listed ?? (root ? { id: root, title: snapshot?.title } as SessionSummary : undefined);
  // The workspace's branch: the registry's (a managed worktree's), else the checkout's own (host.workspace.facts, owner only).
  const row = workspace ? registry.workspaces.find(entry => !entry.archivedAt && (entry.directory === workspace || principal?.workspaceRoots?.some(grant => grant.path === workspace && grant.canonical === entry.directory))) : undefined;
  const [factsBranch, setFactsBranch] = React.useState<{ id: string; branch?: string } | null>(null);
  React.useEffect(() => {
    if (!owner || !online || !row?.id || row.branch) return;
    let live = true;
    void readFacts(controller, [row.id]).then(facts => { if (live) setFactsBranch({ id: row.id, branch: facts[row.id]?.branch }); }, () => {});
    return () => { live = false; };
  }, [controller, owner, online, row?.id, row?.branch]);
  const branch = row?.branch || (factsBranch && factsBranch.id === row?.id ? factsBranch.branch : undefined) || undefined;
  const directory = listed?.projectRoot || workspace || '';
  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(() => controller.notify('info', `${what} copied`), () => controller.notify('error', `Could not copy the ${what.toLowerCase()}.`));
  };
  /**
   * Paseo's workspace header menu: Copy path and Copy branch name, New terminal and New browser tab
   * (ALP.app only), then the session's own Rename, Copy session ID and Archive.
   */
  const items: MenuItem[] = [
    ...(directory ? [{ id: 'copy-path', label: 'Copy path', icon: <Copy aria-hidden />, onSelect: () => copy(directory, 'Path'), testId: 'workspace-header-copy-path' }] : []),
    ...(branch ? [{ id: 'copy-branch-name', label: 'Copy branch name', icon: <GitBranch aria-hidden />, onSelect: () => copy(branch, 'Branch name'), testId: 'workspace-header-copy-branch-name' }] : []),
    // A shell on the host: only for a token that may run one (terminal.exec); the tab says why when the host refuses.
    ...(can(principal ?? undefined, 'terminal.exec') ? [{ id: 'new-terminal', label: 'New terminal', icon: <SquareTerminal aria-hidden />, group: true, onSelect: () => openPanel('terminal'), testId: 'workspace-header-new-terminal' }] : []),
    ...(isDesktopApp() ? [{ id: 'new-browser-tab', label: 'New browser tab', icon: <BROWSER.icon aria-hidden />, onSelect: () => { if (!openBrowser()) controller.notify('info', 'Close a browser tab before opening another.'); }, testId: 'workspace-header-new-browser-tab' }] : []),
    // The session's own items; a reader gets Copy session ID only.
    ...(root && summary ? [
      ...(canWrite ? [{ id: 'rename', label: 'Rename', icon: <Pencil aria-hidden />, group: true, onSelect: () => onRename(summary), testId: 'workspace-header-rename' }] : []),
      { id: 'copy-session-id', label: 'Copy session ID', icon: <Copy aria-hidden />, group: !canWrite, onSelect: () => copy(root, 'Session ID'), testId: 'workspace-header-copy-session-id' },
      ...(canWrite ? [{ id: 'archive', label: 'Archive', icon: <Archive aria-hidden />, onSelect: () => onArchive(summary), destructive: true, testId: 'workspace-header-archive' }] : []),
    ] : []),
  ];
  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background px-2 md:h-9 md:px-3">
      <div className="flex min-w-0 flex-1 items-center gap-1 md:gap-2">
        <button type="button" aria-label={navOpen ? 'Close sessions' : 'Open sessions'} aria-expanded={navOpen} title="Toggle sidebar" onClick={onToggleNav} className={cn(headerButton, 'md:-ml-1.5')}>
          <PanelLeft aria-hidden strokeWidth={1.5} />
        </button>
        <div className="flex min-w-0 flex-1 flex-col md:flex-none md:flex-row md:items-center md:gap-2">
          <h1 className="min-w-0 truncate text-sm font-normal text-foreground md:font-light" title={title} data-testid="workspace-header-title">{title}</h1>
          {root && workspace ? <span className="min-w-0 truncate text-xs text-muted-foreground md:text-sm" title={workspace}>{baseName(workspace)}</span> : null}
        </div>
        {workspace ? (
          <Menu label="Session actions" align="start" testId="workspace-header-menu"
            trigger={<Ellipsis aria-hidden className="size-[18px]" />}
            triggerClassName={headerButton}
            items={items} />
        ) : null}
        <span className="sr-only" aria-live="polite">{connection.phase !== 'open' ? 'Reconnecting' : !root ? '' : running ? 'Agent is working' : closed ? 'Session closed' : 'Agent is idle'}</span>
      </div>
      <div className="flex shrink-0 items-center gap-1 md:gap-2">
        <button type="button" aria-label="Agents and tasks" aria-expanded={explorerOpen} title="Toggle explorer" onClick={onToggleExplorer} className={cn(headerButton, 'md:-mr-1.5')} data-testid="workspace-explorer-toggle">
          <PanelRight aria-hidden strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}

function useTabPresentation(tab: Tab) {
  const { tree, tasks, sessions } = useAppState();
  const { browserUrl } = useTabs();
  return tabPresentation(tab, { tree, tasks, sessions, browserUrl });
}

type PresentationState = Pick<ReturnType<typeof useAppState>, 'tree' | 'tasks' | 'sessions'> & { browserUrl: (id: string) => string | undefined };

/** A tab's label, icon and tooltip, as its chip shows them. */
function tabPresentation(tab: Tab, { tree, tasks, sessions, browserUrl }: PresentationState) {
  if (tab.kind === 'agent') {
    const projection = tree?.projection;
    const session = projection?.sessions[tab.id];
    const root = tab.id === tree?.rootId;
    const waiting = !!projection && Object.values(projection.questions).some(question => (question as any).sessionId === tab.id);
    const running = !!projection && tab.id in projection.running;
    // Paseo labels an agent's tab with the agent's title: here the session's title for the main
    // agent (as the sidebar and the header name it), the assignment's agent for the others.
    const listed = root ? sessions.list.find(row => row.id === tab.id) : undefined;
    const agent = session?.agent ?? (root ? 'main' : 'agent');
    const label = root ? sessionName({ id: tab.id, title: session?.title ?? listed?.title }) : (session?.title ?? agent);
    return {
      label,
      // Paseo's tab icon: the agent glyph, the turning ring while it runs, the alert while it waits.
      // needs_input outranks running, as Paseo's status buckets order them.
      icon: waiting ? (
        // Paseo's needs_input alert over the agent glyph's corner.
        <span className="relative flex size-3.5" data-status="needs_input">
          <Bot aria-hidden className="size-3.5" />
          <CircleAlert aria-hidden className="absolute -bottom-0.5 -right-0.5 size-2 fill-dot-warning text-background" />
        </span>
      ) : running ? <StatusRing /> : <Bot aria-hidden className="size-3.5" />,
      title: root ? `${label} · ${agent}` : `${agent} · assignment from main`,
    };
  }
  if (tab.kind === 'draft') return { label: 'New session', icon: <SquarePen aria-hidden className="size-3.5" />, title: 'New session' };
  if (tab.kind === 'launcher') return { label: 'New tab', icon: <Plus aria-hidden className="size-3.5" />, title: 'New tab' };
  if (tab.kind === 'file') return { label: baseName(tab.id), icon: <FileText aria-hidden className="size-3.5" />, title: tab.id };
  if (tab.kind === 'browser') {
    const url = browserUrl(tab.id);
    return { label: browserLabel(url), icon: <BROWSER.icon aria-hidden className="size-3.5" />, title: url && url !== 'about:blank' ? url : BROWSER.label };
  }
  if (tab.kind === 'panel') {
    const panel = PANELS[tab.id];
    return { label: panel.label, icon: <panel.icon aria-hidden className="size-3.5" />, title: panel.label };
  }
  const row = tasks.rows.find(entry => entry.id === tab.id);
  return {
    label: row?.title ?? tab.id,
    icon: row?.approvals?.length ? <ShieldAlert aria-hidden className="size-3.5 text-dot-warning" /> : row?.status === 'closed' ? <CircleDot aria-hidden className="size-3.5 text-highlight" /> : <ListTodo aria-hidden className="size-3.5" />,
    title: `Task ${tab.id}`,
  };
}

function WorkspaceTabChip({ tab, active, onSelect, onClose, onMenu, dragging, wrapper }: {
  tab: Tab; active: boolean; onSelect: () => void; onClose: () => void;
  onMenu: (at: { x: number; y: number }) => void; dragging: boolean;
  wrapper: React.ComponentProps<typeof TabChip>['wrapper'];
}) {
  const view = useTabPresentation(tab);
  return <TabChip label={view.label} icon={view.icon} title={view.title} active={active} onSelect={onSelect} onClose={onClose} onMenu={onMenu} dragging={dragging} wrapper={wrapper} testId="workspace-tab" data-tab={tabKey(tab)} />;
}

/** Paseo's tab context menu (workspace-tab-menu.ts), with the entries ALP has a backend for. */
function useTabMenuItems(paneId: string, onRename: (session: SessionSummary) => void, whole = false) {
  const { tabs: all, byPane, close, closeOthers } = useTabs();
  const { selected, sessions, tree, principal } = useAppState();
  const controller = useController();
  const canWrite = can(principal ?? undefined, 'session.write');
  const tabs = whole ? all : byPane[paneId] ?? [];
  const row = whole ? all : undefined;
  return (tab: Tab): MenuItem[] => {
    const base = `workspace-tab-context-${tabKey(tab)}`;
    // Disabled when there is nothing to close in this pane, as Paseo at the row's ends.
    const none = (which: 'left' | 'right' | 'others') => closeRange(tabs, tab, which, selected).length === 0;
    const items: MenuItem[] = [];
    const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => undefined); };
    // Copy resume command and Reload agent (§12.8): the host builds the command (ALP's CLI, never a
    // native runtime's) and it only goes to the clipboard; reload restarts the main agent's process.
    const controls = tab.kind === 'agent' ? controller.agentControls(tab.id) : undefined;
    if (tab.kind === 'agent' && controls?.resume.shown) {
      items.push({ id: 'copy-resume-command', label: 'Copy resume command', icon: <Copy aria-hidden />, disabled: !controls.resume.enabled, title: controls.resume.reason, testId: `${base}-copy-resume-command`,
        onSelect: () => { void controller.copyResumeCommand(tab.id, text => navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject(new Error('The browser gives no clipboard here.'))); } });
    }
    if (tab.kind === 'agent') {
      items.push({ id: 'copy-agent-id', label: 'Copy agent id', icon: <Copy aria-hidden />, hint: tab.id.slice(0, 7), testId: `${base}-copy-agent-id`, onSelect: () => copy(tab.id) });
      // Rename names the session (its main agent's tab); ALP has no rename for a team member.
      if (tab.id === selected) {
        const listed = sessions.list.find(row => row.id === tab.id);
        const summary = listed ?? ({ id: tab.id, title: tree?.projection.sessions[tab.id]?.title } as SessionSummary);
        items.push({ id: 'rename', label: 'Rename', icon: <Pencil aria-hidden />, disabled: !canWrite, testId: `${base}-rename`, onSelect: () => onRename(summary) });
      }
    } else if (tab.kind === 'file') {
      items.push({ id: 'copy-path', label: 'Copy path', icon: <Copy aria-hidden />, testId: `${base}-copy-path`, onSelect: () => copy(tab.id) });
    } else if (tab.kind === 'task') {
      items.push({ id: 'copy-task-id', label: 'Copy task id', icon: <Copy aria-hidden />, hint: tab.id, testId: `${base}-copy-task-id`, onSelect: () => copy(tab.id) });
    }
    const closing: MenuItem[] = [
      { id: 'close-left', label: 'Close to the left', icon: <ArrowLeftToLine aria-hidden />, disabled: none('left'), testId: `${base}-close-left`, onSelect: () => closeOthers(tab, 'left', row) },
      { id: 'close-right', label: 'Close to the right', icon: <ArrowRightToLine aria-hidden />, disabled: none('right'), testId: `${base}-close-right`, onSelect: () => closeOthers(tab, 'right', row) },
      { id: 'close-others', label: 'Close other tabs', icon: <CopyX aria-hidden />, disabled: none('others'), testId: `${base}-close-others`, onSelect: () => closeOthers(tab, 'others', row) },
      ...(controls?.reload.shown ? [{ id: 'reload-agent', label: 'Reload agent', icon: <RotateCw aria-hidden />, disabled: !controls.reload.enabled, title: controls.reload.reason ?? RELOAD_NOTE, testId: `${base}-reload-agent`,
        onSelect: () => { void controller.reloadAgent({ sessionId: tab.id, requestId: newConversationRequestId() }).catch(() => undefined); } } satisfies MenuItem] : []),
      ...(controls?.compact.shown ? [{ id: 'compact-agent', label: 'Compact context', icon: <Shrink aria-hidden />, disabled: !controls.compact.enabled, title: controls.compact.reason ?? COMPACT_NOTE, testId: `${base}-compact-agent`,
        onSelect: () => { void controller.compactAgent({ sessionId: tab.id }).catch(() => undefined); } } satisfies MenuItem] : []),
      { id: 'close', label: 'Close', icon: <X aria-hidden />, testId: `${base}-close`, onSelect: () => close(tab) },
    ];
    // Paseo puts a divider under Rename.
    if (items.some(item => item.id === 'rename')) closing[0] = { ...closing[0], group: true };
    return [...items, ...closing];
  };
}

/** Pixels the pointer moves before a press on a tab becomes a drag (Paseo's activation distance). */
const DRAG_DISTANCE = 5;

/** Where a dragged tab would land in another pane: its tab row (at an index) or its body (a drop zone). */
type DropTarget = { pane: string; kind: 'row'; index: number } | { pane: string; kind: 'zone'; position: 'center' | SplitPosition };

const DropContext = React.createContext<{ target: DropTarget | null; setTarget: (target: DropTarget | null) => void; splits: boolean }>({ target: null, setTarget: () => undefined, splits: false });


/** How many of a row's tabs (not `key`) sit left of x. */
const indexAt = (row: Element | null, key: string, x: number) => Array.from(row?.querySelectorAll<HTMLElement>('[data-drag-tab]') ?? [])
  .filter(element => element.dataset.dragTab !== key)
  .filter(element => { const rect = element.getBoundingClientRect(); return rect.left + rect.width / 2 < x; }).length;

/**
 * Paseo's drag reordering of a pane's tab row: press a tab and move; the row shows the new order
 * as the pointer goes, and it is kept on release. A press that does not move is a click. With
 * panes, as Paseo's: released over another pane's tab row the tab moves there; over a pane's
 * body, its edge splits that pane with the tab and its center moves the tab in.
 */
function useTabDrag(paneId: string, whole = false) {
  const { tabs: all, byPane, move, moveTabToPane, splitWith } = useTabs();
  const drop = React.useContext(DropContext);
  const tabs = whole ? all : byPane[paneId] ?? [];
  const row = React.useRef<HTMLDivElement>(null);
  const [preview, setPreview] = React.useState<{ key: string; order: string[] } | null>(null);
  const dragged = React.useRef(false);
  const start = (tab: Tab) => (event: React.PointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[aria-label^="Close "]')) return;
    const key = tabKey(tab);
    const startX = event.clientX;
    const startY = event.clientY;
    const keys = tabs.map(tabKey);
    let moving = false;
    let to = keys.indexOf(key);
    let target: DropTarget | null = null;
    dragged.current = false;
    // The drop target is shared with the panes (their highlights): set only when it changes.
    const same = (a: DropTarget | null, b: DropTarget | null) => a === b || (!!a && !!b && a.pane === b.pane && a.kind === b.kind
      && (a.kind === 'row' ? a.index === (b as typeof a).index : a.position === (b as typeof a).position));
    const onMove = (next: PointerEvent) => {
      if (!moving && Math.hypot(next.clientX - startX, next.clientY - startY) < DRAG_DISTANCE) return;
      moving = true;
      const before = target;
      target = null;
      const under = drop.splits ? document.elementFromPoint(next.clientX, next.clientY) : null;
      const otherRow = under?.closest<HTMLElement>('[data-pane-row]');
      const body = under?.closest<HTMLElement>('[data-pane-body]');
      if (otherRow && otherRow.dataset.paneRow !== paneId) {
        target = { pane: otherRow.dataset.paneRow as string, kind: 'row', index: indexAt(otherRow, key, next.clientX) };
      } else if (body && !otherRow) {
        const rect = body.getBoundingClientRect();
        const position = dropPosition({ width: rect.width, height: rect.height, x: next.clientX - rect.left, y: next.clientY - rect.top });
        const pane = body.dataset.paneBody as string;
        // Its own pane: an edge splits it if the tab leaves something behind; the center is no move.
        if (pane !== paneId || (position !== 'center' && keys.length > 1)) target = { pane, kind: 'zone', position };
      }
      if (!same(before, target)) drop.setTarget(target);
      if (target) { setPreview(null); return; }
      if (body && !otherRow) {
        // Over its own pane with nowhere to go: no reorder either (Paseo's no-op).
        to = -1;
        setPreview(current => current ? null : current);
        return;
      }
      to = indexAt(row.current, key, next.clientX);
      setPreview({ key, order: moveKey(keys, key, to) });
    };
    const finish = (commit: boolean) => () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (moving) {
        // The click that follows this release (if any) is not a selection; later ones are.
        dragged.current = true;
        setTimeout(() => { dragged.current = false; }, 0);
        const landing = target as DropTarget | null;
        if (commit && landing?.kind === 'row') moveTabToPane(tab, landing.pane, landing.index);
        else if (commit && landing?.kind === 'zone') {
          if (landing.position === 'center') moveTabToPane(tab, landing.pane);
          else splitWith(tab, landing.pane, landing.position);
        } else if (commit && to >= 0) move(tab, to, whole);
      }
      drop.setTarget(null);
      setPreview(null);
    };
    const up = finish(true);
    const cancel = finish(false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
  };
  // The click that ends a drag does not select the tab.
  const swallow = (event: React.MouseEvent) => { if (dragged.current) { dragged.current = false; event.stopPropagation(); event.preventDefault(); } };
  const shown = preview ? orderTabs(tabs, tabKey, preview.order) : tabs;
  return { row, shown, dragging: preview?.key ?? null, wrapper: (tab: Tab) => ({ onPointerDown: start(tab), onClickCapture: swallow, 'data-drag-tab': tabKey(tab) }) };
}

/** What the center + menu opens after Agent, as Paseo's: its own panels, then ALP's. */
const PRIMARY_PANELS: PanelKind[] = ['terminal', 'diff'];
const ALP_PANELS: PanelKind[] = ['tasks', 'agents'];

const toolbarButton = cn('flex size-7 shrink-0 items-center justify-center rounded-md text-extra-muted hover:bg-card hover:text-foreground [&_svg]:size-3.5', focusRing);

/**
 * Paseo's tab row over a pane: its tabs, then + with the New tab menu (Agent starts a session); on
 * the right, with split panes, the pane's Maximize / Restore button and its menu with Split pane
 * right / down.
 */
export function TabsRow({ paneId = MAIN_PANE, whole = false, onNewSession, onRename, menuRequest, onMenuRequestHandled, switcherRequest, onSwitcherRequestHandled }: RowProps & { paneId?: string; whole?: boolean }) {
  const { activeOf, activate, close, openPanel, openBrowser, focusedPane, panes, splitEmpty, canSplitEmpty, maximized, toggleMaximized } = useTabs();
  const drag = useTabDrag(paneId, whole);
  const drop = React.useContext(DropContext);
  const menuItems = useTabMenuItems(paneId, onRename, whole);
  const [menu, setMenu] = React.useState<{ tab: Tab; at: { x: number; y: number } } | null>(null);
  const closeMenu = React.useCallback(() => setMenu(null), []);
  const focusActiveTab = React.useCallback(() => drag.row.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'), [drag.row]);
  const { workspace, principal, connection } = useAppState();
  const canWrite = can(principal ?? undefined, 'session.write');
  if (!workspace) return null;
  const active = activeOf(paneId);
  const focused = paneId === focusedPane;
  const many = paneIds(panes.root).length > 1;
  const mac = isMacPlatform();
  const item = (kind: PanelKind, group = false) => {
    const panel = PANELS[kind];
    return { label: panel.label, icon: <panel.icon aria-hidden />, onSelect: () => openPanel(kind), group };
  };
  const dropping = drop.target?.kind === 'row' && drop.target.pane === paneId;
  return (
    <div className={cn('flex h-9 shrink-0 items-center border-b border-border bg-background', dropping && 'bg-secondary/60')} data-pane-row={paneId}>
      <div ref={drag.row} role="tablist" aria-label="Open tabs" className="flex min-w-0 flex-1 items-center overflow-x-auto px-1 [scrollbar-width:none]">
        {drag.shown.map(tab => (
          <WorkspaceTabChip key={tabKey(tab)} tab={tab} active={!!active && tabKey(active) === tabKey(tab)} onSelect={() => activate(tab)} onClose={() => close(tab)}
            onMenu={at => setMenu({ tab, at })} dragging={drag.dragging === tabKey(tab)} wrapper={drag.wrapper(tab)} />
        ))}
        <Menu label="New tab" align="start" openRequest={focused ? menuRequest : undefined} onOpenRequestHandled={onMenuRequestHandled} testId="workspace-new-tab"
          trigger={<Plus aria-hidden className="size-4" />}
          triggerClassName={cn('mx-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card hover:text-foreground', focusRing)}
          items={[
            { label: 'Agent', icon: <SquarePen aria-hidden />, onSelect: onNewSession, disabled: !canWrite || connection.phase !== 'open' },
            ...PRIMARY_PANELS.map(kind => item(kind)),
            // Paseo's Browser after Diff; ALP.app only (docs/alp/desktop.md).
            ...(isDesktopApp() ? [{ label: BROWSER.label, icon: <BROWSER.icon aria-hidden />, onSelect: () => { openBrowser(); }, group: false }] : []),
            ...ALP_PANELS.map((kind, index) => item(kind, index === 0)),
          ]} />
      </div>
      <TabSwitcher paneId={paneId} whole={whole} openRequest={focused ? switcherRequest : undefined} onOpenRequestHandled={onSwitcherRequestHandled} />
      {drop.splits ? (
        <div className="flex shrink-0 items-center gap-0.5 pr-1">
          {many ? (
            <button type="button" className={toolbarButton} aria-pressed={maximized === paneId} onClick={() => toggleMaximized(paneId)}
              aria-label={maximized === paneId ? 'Restore pane' : 'Maximize pane'} title={maximized === paneId ? 'Restore pane' : 'Maximize pane'}
              data-testid={maximized === paneId ? 'workspace-restore-pane' : 'workspace-maximize-pane'}>
              {maximized === paneId ? <Minimize aria-hidden /> : <Maximize aria-hidden />}
            </button>
          ) : null}
          <Menu label="More actions" testId="workspace-split-pane-menu" trigger={<Ellipsis aria-hidden className="size-3.5" />} triggerClassName={toolbarButton}
            items={[
              { id: 'split-right', label: 'Split pane right', icon: <Columns2 aria-hidden />, hint: shortcutLabel('pane.split.right', mac) || undefined, disabled: !canSplitEmpty, testId: 'workspace-split-pane-right', onSelect: () => splitEmpty('right') },
              { id: 'split-down', label: 'Split pane down', icon: <Rows2 aria-hidden />, hint: shortcutLabel('pane.split.down', mac) || undefined, disabled: !canSplitEmpty, testId: 'workspace-split-pane-down', onSelect: () => splitEmpty('bottom') },
            ]} />
        </div>
      ) : null}
      <ContextMenu label="Tab actions" at={menu?.at ?? null} items={menu ? menuItems(menu.tab) : []} onClose={closeMenu} fallbackFocus={focusActiveTab} testId={menu ? `workspace-tab-context-${tabKey(menu.tab)}` : undefined} />
    </div>
  );
}

/** A render error in a pane's tab shows in that pane only; another tab in front starts afresh. */
function PaneBoundary({ paneId, children }: { paneId: string; children: React.ReactNode }) {
  const { activeOf, close } = useTabs();
  const active = activeOf(paneId);
  return (
    <ErrorBoundary where={`pane:${paneId}`} resetKey={active ? tabKey(active) : ''}
      fallback={(error, reset) => <PaneErrorFallback error={error} onRetry={reset} onClose={active ? () => close(active) : undefined} />}>
      {children}
    </ErrorBoundary>
  );
}

/**
 * Paseo's tab switcher (workspace.tabs.switcher): a button with the pane's tab count that opens a
 * list of its tabs with a search field. Type to filter (by label and tooltip, as the command center
 * matches), Up/Down move, Enter or a click shows the tab, Escape or a click outside closes. The
 * command center's Switch tab… opens it on the focused pane.
 */
function TabSwitcher({ paneId, whole, openRequest, onOpenRequestHandled }: { paneId: string; whole: boolean; openRequest?: number; onOpenRequestHandled?: () => void }) {
  const { tabs: all, byPane, activeOf, activate, browserUrl } = useTabs();
  const { tree, tasks, sessions } = useAppState();
  const tabs = whole ? all : byPane[paneId] ?? [];
  const active = activeOf(paneId);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [index, setIndex] = React.useState(0);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const listId = React.useId();
  const rows = React.useMemo(() => {
    const views = tabs.map(tab => ({ tab, ...tabPresentation(tab, { tree, tasks, sessions, browserUrl }) }));
    const needle = query.trim();
    if (!needle) return views;
    return views.map((view, at) => ({ view, at, score: matchScore(needle, [view.label], [view.title ?? '', view.tab.kind]) }))
      .filter(entry => entry.score !== undefined)
      .sort((a, b) => (a.score as number) - (b.score as number) || a.at - b.at)
      .map(entry => entry.view);
  }, [tabs, tree, tasks, sessions, browserUrl, query]);
  const show = () => {
    setQuery('');
    const at = active ? tabs.findIndex(tab => tabKey(tab) === tabKey(active)) : -1;
    setIndex(Math.max(0, at));
    setOpen(true);
  };
  const close = (refocus = true) => { setOpen(false); if (refocus) trigger.current?.focus(); };
  React.useEffect(() => {
    if (!openRequest) return;
    onOpenRequestHandled?.();
    show();
  }, [openRequest]); // eslint-disable-line react-hooks/exhaustive-deps
  React.useEffect(() => { if (open) input.current?.focus(); }, [open]);
  React.useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const at = rows.length ? Math.min(index, rows.length - 1) : 0;
  React.useEffect(() => { panel.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' }); }, [at, open]);
  const choose = (tab: Tab) => { activate(tab); close(false); };
  const onKey = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (rows.length) setIndex((at + (event.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length);
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (rows[at]) choose(rows[at].tab);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      close();
    }
  };
  if (!tabs.length) return null;
  const label = `Switch tabs (${tabs.length} open)`;
  return (
    <div className="relative flex shrink-0 items-center pr-0.5">
      <button ref={trigger} type="button" className={cn(toolbarButton, 'w-auto min-w-7 px-1.5')} aria-label={label} title={label} aria-haspopup="listbox" aria-expanded={open}
        data-testid="workspace-tab-switcher-trigger" onClick={() => open ? close() : show()}>
        <span className="min-w-4 rounded bg-secondary px-1 text-[11px] font-medium leading-4 tabular-nums text-muted-foreground">{tabs.length}</span>
      </button>
      {open ? (
        <div ref={panel} role="dialog" aria-label="Workspace tabs" data-testid="workspace-tab-switcher" onKeyDown={onKey}
          className="absolute right-0 top-full z-50 mt-1 flex w-[min(20rem,90vw)] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-xl shadow-[var(--shadow)]">
          <input ref={input} type="text" role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={rows.length ? `${listId}-${at}` : undefined}
            aria-label="Search tabs" placeholder="Search tabs" value={query} autoComplete="off" spellCheck={false} data-testid="workspace-tab-switcher-input"
            onChange={event => { setQuery(event.target.value); setIndex(0); }}
            className="border-b border-border bg-transparent px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground" />
          <div id={listId} role="listbox" aria-label="Workspace tabs" className="max-h-72 overflow-y-auto p-1">
            {rows.length ? rows.map((row, position) => {
              const current = !!active && tabKey(active) === tabKey(row.tab);
              return (
                <div key={tabKey(row.tab)} id={`${listId}-${position}`} role="option" aria-selected={position === at} aria-current={current ? 'true' : undefined}
                  data-index={position} data-tab={tabKey(row.tab)} data-testid="workspace-tab-switcher-option"
                  onMouseMove={() => { if (position !== at) setIndex(position); }} onClick={() => choose(row.tab)}
                  className={cn('flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-sm', position === at && 'bg-secondary')}>
                  <span className="flex w-4 shrink-0 justify-center text-muted-foreground">{row.icon}</span>
                  <span className="min-w-0 flex-1 truncate" title={row.title}>{row.label}</span>
                  {current ? <Check aria-hidden className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                </div>
              );
            }) : <p className="px-2 py-3 text-center text-sm text-muted-foreground">No tabs match</p>}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** A pane's tab in front. */
export function TabContent({ paneId = MAIN_PANE, onNewSession }: { paneId?: string; onNewSession: () => void }) {
  const { activeOf } = useTabs();
  const { tree, workspace } = useAppState();
  const active = activeOf(paneId);
  if (active?.kind === 'draft') return <NewSessionScreen />;
  if (active?.kind === 'launcher') return <PaneLauncher key={active.id} launcher={active.id} />;
  if (active?.kind === 'task') return <TaskDetail id={active.id} />;
  // Keyed by the workspace too: the same path in another workspace is another file.
  if (active?.kind === 'file') return <FileView key={`${workspace ?? ''}\n${active.id}`} path={active.id} />;
  // The page itself lives in BrowserHost's layer, laid over this slot, so it survives other tabs in front.
  if (active?.kind === 'browser') return <BrowserSlot key={`${workspace ?? ''}\n${active.id}`} id={active.id} paneId={paneId} />;
  if (active?.kind === 'panel') return <div className={cn('min-h-0 flex-1', active.id === 'terminal' ? 'overflow-hidden' : 'overflow-y-auto')}><PanelView kind={active.id} /></div>;
  if (active?.kind === 'agent' && tree) return <ChatPanel key={active.id} sessionId={active.id} />;
  return <Empty onNewSession={onNewSession} />;
}

/**
 * Paseo's New tab panel in a pane (panels/new-tab-panel.tsx), what a split opens: Agent (a new
 * session), then the panels as the + menu lists them; the row picked takes the New tab's place.
 * Arrows move between rows.
 */
function PaneLauncher({ launcher }: { launcher: string }) {
  // The draft opens in the same update as the New tab closes, so the pane is never left empty.
  const { launch, openPanel, openBrowser, openDraft } = useTabs();
  const { principal, connection } = useAppState();
  const canWrite = can(principal ?? undefined, 'session.write');
  const first = React.useRef<HTMLButtonElement>(null);
  const focused = React.useContext(PaneContext).focused;
  React.useEffect(() => { if (focused) first.current?.focus({ preventScroll: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const onKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[(at + step + rows.length) % rows.length]?.focus();
  };
  const row = 'flex min-h-11 items-center gap-2 rounded-lg border border-transparent bg-card px-3 text-left text-sm text-foreground outline-none hover:bg-secondary focus-visible:border-ring disabled:pointer-events-none disabled:opacity-50';
  const groups: Array<Array<{ id: string; label: string; icon: React.ReactNode; disabled?: boolean; run: () => void }>> = [
    [
      { id: 'agent', label: 'Agent', icon: <SquarePen aria-hidden className="size-4 shrink-0 text-muted-foreground" />, disabled: !canWrite || connection.phase !== 'open', run: openDraft },
      ...PRIMARY_PANELS.map(kind => { const panel = PANELS[kind]; return { id: kind, label: panel.label, icon: <panel.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />, run: () => openPanel(kind) }; }),
      ...(isDesktopApp() ? [{ id: 'browser', label: BROWSER.label, icon: <BROWSER.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />, run: () => { openBrowser(); } }] : []),
    ],
    ALP_PANELS.map(kind => { const panel = PANELS[kind]; return { id: kind, label: panel.label, icon: <panel.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />, run: () => openPanel(kind) }; }),
  ];
  let index = -1;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-6" data-testid="workspace-pane-new-tab-panel">
      <div className="flex w-full max-w-[380px] flex-col gap-12" onKeyDown={onKey}>
        {groups.map((items, group) => (
          <div key={group} className="flex flex-col gap-1">
            {items.map(item => {
              index += 1;
              return (
                <button key={item.id} ref={index === 0 ? first : undefined} type="button" disabled={item.disabled} className={row} data-testid={`workspace-pane-new-tab-${item.id}`}
                  onClick={() => launch(launcher, item.run)}>
                  {item.icon}<span className="min-w-0 flex-1 truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Paseo's drop zone preview over a pane: the half a split would take, or the whole for a move. */
function DropOverlay({ position }: { position: 'center' | SplitPosition }) {
  const place = { center: 'inset-2', left: 'inset-y-0 left-0 w-1/2', right: 'inset-y-0 right-0 w-1/2', top: 'inset-x-0 top-0 h-1/2', bottom: 'inset-x-0 bottom-0 h-1/2' }[position];
  return <div aria-hidden data-testid="workspace-drop-zone" data-position={position} className={cn('pointer-events-none absolute z-40 rounded-md border-2 border-highlight bg-highlight/20', place)} />;
}

type RowProps = { onNewSession: () => void; onRename: (session: SessionSummary) => void; menuRequest?: number; onMenuRequestHandled?: () => void; switcherRequest?: number; onSwitcherRequestHandled?: () => void };

/** The pane menu's sides, in the order the menu lists them. */
const PANE_SPLITS: Array<{ position: SplitPosition; label: string; icon: React.ReactNode }> = [
  { position: 'left', label: 'Split pane left', icon: <PanelLeft aria-hidden /> },
  { position: 'top', label: 'Split pane up', icon: <PanelTop aria-hidden /> },
  { position: 'right', label: 'Split pane right', icon: <PanelRight aria-hidden /> },
  { position: 'bottom', label: 'Split pane down', icon: <PanelBottom aria-hidden /> },
];

/**
 * Whether a right click at `target` keeps the browser's own menu: with text selected, in a field,
 * on a link or in a terminal (which has its own), and with Shift held.
 */
function nativeMenuWanted(event: React.MouseEvent) {
  const target = event.target as HTMLElement;
  if (event.shiftKey || !!window.getSelection()?.toString()) return true;
  return !!target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], a[href], .xterm');
}

function PaneView({ id, props, whole = false }: { id: string; props: RowProps; whole?: boolean }) {
  const { focusedPane, focusPane, panes, splitEmpty, canSplitEmpty } = useTabs();
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
  const drop = React.useContext(DropContext);
  const focused = id === focusedPane;
  const many = paneIds(panes.root).length > 1;
  const value = React.useMemo(() => ({ id, focused }), [id, focused]);
  const zone = drop.target?.kind === 'zone' && drop.target.pane === id ? drop.target.position : null;
  // Paseo's pane focus: a press or keyboard focus anywhere in the pane (not in a menu it opened).
  const claim = (event: React.SyntheticEvent) => { if (!focused && !(event.target as HTMLElement).closest?.('[role="menu"]')) focusPane(id); };
  return (
    <PaneContext.Provider value={value}>
      <section aria-label={many ? `Pane${focused ? ' (focused)' : ''}` : undefined} data-testid={`workspace-pane-${id}`} data-focused={focused ? 'true' : 'false'}
        onPointerDownCapture={claim} onFocusCapture={claim}
        className={cn('relative flex min-h-0 min-w-0 flex-1 flex-col bg-background', many && !focused && '[&_[role=tab][aria-selected=true]]:text-muted-foreground')}>
        <TabsRow paneId={id} whole={whole} {...props} />
        <div className="relative flex min-h-0 flex-1 flex-col" data-pane-body={id}
          onContextMenu={drop.splits && canSplitEmpty ? event => {
            if (nativeMenuWanted(event)) return;
            event.preventDefault();
            setMenu({ x: event.clientX, y: event.clientY });
          } : undefined}>
          <PaneBoundary paneId={id}><TabContent paneId={id} onNewSession={props.onNewSession} /></PaneBoundary>
          {zone ? <DropOverlay position={zone} /> : null}
        </div>
        <ContextMenu label="Pane actions" at={menu} onClose={() => setMenu(null)} testId={menu ? `workspace-pane-context-${id}` : undefined}
          items={menu ? PANE_SPLITS.map(({ position, label, icon }) => ({
            id: `split-${position}`, label, icon, testId: `workspace-pane-split-${position}`,
            // A split past the deepest nesting is refused (lib/panes.js): its row is off.
            disabled: !splitPane(panes, { target: id, position }),
            onSelect: () => splitEmpty(position, id),
          })) : []} />
      </section>
    </PaneContext.Provider>
  );
}

/** Paseo's split resize handle between two children of a group: drag, or the arrow keys. */
function SplitHandle({ group, index, container, onPreview }: { group: GroupNode; index: number; container: React.RefObject<HTMLDivElement | null>; onPreview: (sizes: number[] | null) => void }) {
  const { resize } = useTabs();
  const [dragging, setDragging] = React.useState(false);
  const horizontal = group.direction === 'horizontal';
  const share = (group.sizes[index] ?? 0) + (group.sizes[index + 1] ?? 0);
  const before = group.sizes.slice(0, index).reduce((sum, size) => sum + size, 0);
  const sized = (first: number) => {
    const low = MIN_SPLIT_SIZE;
    const value = Math.min(share - low, Math.max(low, first));
    const sizes = group.sizes.slice();
    sizes[index] = value;
    sizes[index + 1] = share - value;
    return sizes;
  };
  const set = (first: number) => resize(group.id, sized(first));
  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !container.current) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const rect = container.current.getBoundingClientRect();
    handle.setPointerCapture(event.pointerId);
    setDragging(true);
    // The sizes show as the pointer moves and are kept (and saved) once, on release.
    let last: number[] | null = null;
    const move = (next: PointerEvent) => {
      const at = horizontal ? (next.clientX - rect.left) / rect.width : (next.clientY - rect.top) / rect.height;
      last = sized(at - before);
      onPreview(last);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('lostpointercapture', end);
      setDragging(false);
      if (last) resize(group.id, last);
      onPreview(null);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('lostpointercapture', end);
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 0.1 : 0.02;
    const less = horizontal ? 'ArrowLeft' : 'ArrowUp';
    const more = horizontal ? 'ArrowRight' : 'ArrowDown';
    const first = group.sizes[index] ?? 0;
    if (event.key === less) set(first - step);
    else if (event.key === more) set(first + step);
    else if (event.key === 'Home') set(0);
    else if (event.key === 'End') set(share);
    else return;
    event.preventDefault();
  };
  return (
    <div role="separator" aria-orientation={horizontal ? 'vertical' : 'horizontal'} aria-label="Resize panes" tabIndex={0}
      aria-valuenow={Math.round((group.sizes[index] ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100} data-testid="workspace-split-resize-handle"
      onPointerDown={onPointerDown} onKeyDown={onKeyDown}
      className={cn('group relative z-10 shrink-0 touch-none bg-border outline-none', horizontal ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize')}>
      <span aria-hidden className={cn('absolute bg-ring opacity-0 transition-opacity delay-100 group-hover:opacity-100 group-focus-visible:opacity-100', horizontal ? 'inset-y-0 -left-[4px] w-[9px]' : 'inset-x-0 -top-[4px] h-[9px]', dragging && 'opacity-100')} />
    </div>
  );
}

function NodeView({ node, props }: { node: SplitNode; props: RowProps }) {
  const container = React.useRef<HTMLDivElement>(null);
  const [preview, setPreview] = React.useState<number[] | null>(null);
  if (node.kind === 'pane') return <PaneView id={node.id} props={props} />;
  const shown = { ...node, sizes: preview && preview.length === node.sizes.length ? preview : node.sizes };
  return (
    <div ref={container} className={cn('flex min-h-0 min-w-0 flex-1', node.direction === 'horizontal' ? 'flex-row' : 'flex-col')} data-testid="workspace-split-group" data-direction={node.direction}>
      {node.children.map((child, index) => (
        <React.Fragment key={child.id}>
          <div className="flex min-h-0 min-w-0" style={{ flexGrow: shown.sizes[index] ?? 0, flexShrink: 1, flexBasis: 0 }} data-testid="split-group-child">
            <NodeView node={child} props={props} />
          </div>
          {index < node.children.length - 1 ? <SplitHandle group={shown} index={index} container={container} onPreview={setPreview} /> : null}
        </React.Fragment>
      ))}
    </div>
  );
}

/**
 * Paseo's split container for the center column: the split tree's panes, each with its tab row and
 * its tab in front, a resize handle between neighbours. Narrow windows show the focused pane
 * alone (Paseo has no splits on compact screens); a maximized pane shows alone.
 */
export function SplitView(props: RowProps & { splits: boolean }) {
  const { panes, focusedPane, maximized } = useTabs();
  const [target, setTarget] = React.useState<DropTarget | null>(null);
  const drop = React.useMemo(() => ({ target, setTarget, splits: props.splits }), [target, props.splits]);
  const ids = paneIds(panes.root);
  const alone = !props.splits || ids.length < 2 ? focusedPane : maximized && ids.includes(maximized) ? maximized : null;
  return (
    <DropContext.Provider value={drop}>
      <div className="relative flex min-h-0 flex-1 flex-col" data-testid="workspace-panes" data-panes={ids.length}>
        <BrowserHost>
          {/* Narrow: one row of every pane's tabs; picking one shows it (its pane takes the focus). */}
          {alone ? <PaneView id={alone} props={props} whole={!props.splits && ids.length > 1} /> : <NodeView node={panes.root} props={props} />}
        </BrowserHost>
      </div>
    </DropContext.Provider>
  );
}
