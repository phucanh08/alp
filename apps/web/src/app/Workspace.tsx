import * as React from 'react';
import { ArrowLeftToLine, ArrowRightToLine, Bot, CircleAlert, CircleDot, Columns2, Copy, CopyX, Ellipsis, FileText, ListTodo, Maximize, Minimize, PanelLeft, PanelRight, Pencil, Plus, RotateCw, Rows2, ShieldAlert, SquarePen, Archive, X } from 'lucide-react';
import type { SessionSummary } from '../lib/controller.js';
import { can } from '../lib/gateway.js';
import { ContextMenu, Menu, type MenuItem } from '../components/ui/menu';
import { moveKey, orderTabs } from '../lib/layout.js';
import { closeRange } from '../lib/tab-close.js';
import { MAIN_PANE, MIN_SPLIT_SIZE, dropPosition, paneIds, type GroupNode, type SplitNode, type SplitPosition } from '../lib/panes.js';
import { isMacPlatform, shortcutLabel } from '../lib/shortcuts.js';
import { baseName, sessionName } from '../lib/format';
import { cn } from '../lib/utils';
import { RELOAD_NOTE } from '../lib/conversation.js';
import { newConversationRequestId } from '../lib/ids.js';
import { PANELS, PanelView, type PanelKind } from './panels';
import { NewSessionScreen } from './NewSession';
import { ChatPanel, Empty } from './SessionView';
import { StatusRing } from './status';
import { TabChip } from './TabChip';
import { PaneContext } from './pane';
import { TaskDetail } from './TaskDetail';
import { FileView } from './FileView';
import { useAppState, useController } from './store';
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
  const { tree, sessions, workspace, connection, principal } = useAppState();
  const root = tree?.rootId;
  const snapshot = root ? tree.projection.sessions[root] : undefined;
  const listed = root ? sessions.list.find(session => session.id === root) : undefined;
  const title = root ? sessionName({ id: root, title: snapshot?.title ?? listed?.title }) : workspace ? baseName(workspace) : 'ALP';
  const running = !!root && root in tree.projection.running;
  const closed = !!root && !!tree.projection.closed[root];
  const canWrite = can(principal ?? undefined, 'session.write');
  const summary: SessionSummary | undefined = listed ?? (root ? { id: root, title: snapshot?.title } as SessionSummary : undefined);
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
        {root && summary ? (
          <Menu label="Session actions" align="start"
            trigger={<Ellipsis aria-hidden className="size-[18px]" />}
            triggerClassName={headerButton}
            items={[
              { label: 'Rename', icon: <Pencil aria-hidden />, onSelect: () => onRename(summary), disabled: !canWrite },
              { label: 'Copy session ID', icon: <Copy aria-hidden />, onSelect: () => { void navigator.clipboard?.writeText(root); } },
              { label: 'Archive', icon: <Archive aria-hidden />, onSelect: () => onArchive(summary), disabled: !canWrite, destructive: true },
            ]} />
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
export function TabsRow({ paneId = MAIN_PANE, whole = false, onNewSession, onRename, menuRequest, onMenuRequestHandled }: { paneId?: string; whole?: boolean; onNewSession: () => void; onRename: (session: SessionSummary) => void; menuRequest?: number; onMenuRequestHandled?: () => void }) {
  const { activeOf, activate, close, openPanel, focusedPane, panes, splitEmpty, canSplitEmpty, maximized, toggleMaximized } = useTabs();
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
            ...ALP_PANELS.map((kind, index) => item(kind, index === 0)),
          ]} />
      </div>
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
  if (active?.kind === 'panel') return <div className="min-h-0 flex-1 overflow-y-auto"><PanelView kind={active.id} /></div>;
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
  const { launch, openPanel, openDraft } = useTabs();
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

type RowProps = { onNewSession: () => void; onRename: (session: SessionSummary) => void; menuRequest?: number; onMenuRequestHandled?: () => void };

function PaneView({ id, props, whole = false }: { id: string; props: RowProps; whole?: boolean }) {
  const { focusedPane, focusPane, panes } = useTabs();
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
        <div className="relative flex min-h-0 flex-1 flex-col" data-pane-body={id}>
          <TabContent paneId={id} onNewSession={props.onNewSession} />
          {zone ? <DropOverlay position={zone} /> : null}
        </div>
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
      <div className="flex min-h-0 flex-1 flex-col" data-testid="workspace-panes" data-panes={ids.length}>
        {/* Narrow: one row of every pane's tabs; picking one shows it (its pane takes the focus). */}
        {alone ? <PaneView id={alone} props={props} whole={!props.splits && ids.length > 1} /> : <NodeView node={panes.root} props={props} />}
      </div>
    </DropContext.Provider>
  );
}
