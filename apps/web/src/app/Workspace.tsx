import * as React from 'react';
import { ArrowLeftToLine, ArrowRightToLine, Bot, CircleAlert, CircleDot, Copy, CopyX, Ellipsis, ListTodo, PanelLeft, PanelRight, Pencil, Plus, ShieldAlert, SquarePen, Archive, X } from 'lucide-react';
import type { SessionSummary } from '../lib/controller.js';
import { can } from '../lib/gateway.js';
import { ContextMenu, Menu, type MenuItem } from '../components/ui/menu';
import { moveKey, orderTabs } from '../lib/layout.js';
import { closeRange } from '../lib/tab-close.js';
import { baseName, sessionName } from '../lib/format';
import { cn } from '../lib/utils';
import { PANELS, PanelView, type PanelKind } from './panels';
import { NewSessionScreen } from './NewSession';
import { ChatPanel, Empty } from './SessionView';
import { StatusRing } from './status';
import { TabChip } from './TabChip';
import { TaskDetail } from './TaskDetail';
import { useAppState } from './store';
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
function useTabMenuItems(onRename: (session: SessionSummary) => void) {
  const { tabs, close, closeOthers } = useTabs();
  const { selected, sessions, tree, principal } = useAppState();
  const canWrite = can(principal ?? undefined, 'session.write');
  return (tab: Tab): MenuItem[] => {
    const base = `workspace-tab-context-${tabKey(tab)}`;
    // Disabled when there is nothing to close, as Paseo at the row's ends.
    const none = (which: 'left' | 'right' | 'others') => closeRange(tabs, tab, which, selected).length === 0;
    const items: MenuItem[] = [];
    const copy = (text: string) => { void navigator.clipboard?.writeText(text).catch(() => undefined); };
    if (tab.kind === 'agent') {
      items.push({ id: 'copy-agent-id', label: 'Copy agent id', icon: <Copy aria-hidden />, hint: tab.id.slice(0, 7), testId: `${base}-copy-agent-id`, onSelect: () => copy(tab.id) });
      // Rename names the session (its main agent's tab); ALP has no rename for a team member.
      if (tab.id === selected) {
        const listed = sessions.list.find(row => row.id === tab.id);
        const summary = listed ?? ({ id: tab.id, title: tree?.projection.sessions[tab.id]?.title } as SessionSummary);
        items.push({ id: 'rename', label: 'Rename', icon: <Pencil aria-hidden />, disabled: !canWrite, testId: `${base}-rename`, onSelect: () => onRename(summary) });
      }
    } else if (tab.kind === 'task') {
      items.push({ id: 'copy-task-id', label: 'Copy task id', icon: <Copy aria-hidden />, hint: tab.id, testId: `${base}-copy-task-id`, onSelect: () => copy(tab.id) });
    }
    const closing: MenuItem[] = [
      { id: 'close-left', label: 'Close to the left', icon: <ArrowLeftToLine aria-hidden />, disabled: none('left'), testId: `${base}-close-left`, onSelect: () => closeOthers(tab, 'left') },
      { id: 'close-right', label: 'Close to the right', icon: <ArrowRightToLine aria-hidden />, disabled: none('right'), testId: `${base}-close-right`, onSelect: () => closeOthers(tab, 'right') },
      { id: 'close-others', label: 'Close other tabs', icon: <CopyX aria-hidden />, disabled: none('others'), testId: `${base}-close-others`, onSelect: () => closeOthers(tab, 'others') },
      { id: 'close', label: 'Close', icon: <X aria-hidden />, testId: `${base}-close`, onSelect: () => close(tab) },
    ];
    // Paseo puts a divider under Rename.
    if (items.some(item => item.id === 'rename')) closing[0] = { ...closing[0], group: true };
    return [...items, ...closing];
  };
}

/** Pixels the pointer moves before a press on a tab becomes a drag (Paseo's activation distance). */
const DRAG_DISTANCE = 5;

/**
 * Paseo's drag reordering of the tab row: press a tab and move; the row shows the new order as
 * the pointer goes, and it is kept on release. A press that does not move is a click.
 */
function useTabDrag() {
  const { tabs, move } = useTabs();
  const row = React.useRef<HTMLDivElement>(null);
  const [preview, setPreview] = React.useState<{ key: string; order: string[] } | null>(null);
  const dragged = React.useRef(false);
  const start = (tab: Tab) => (event: React.PointerEvent) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[aria-label^="Close "]')) return;
    const key = tabKey(tab);
    const startX = event.clientX;
    const keys = tabs.map(tabKey);
    let moving = false;
    let to = keys.indexOf(key);
    dragged.current = false;
    const onMove = (next: PointerEvent) => {
      if (!moving && Math.abs(next.clientX - startX) < DRAG_DISTANCE) return;
      moving = true;
      const others = Array.from(row.current?.querySelectorAll<HTMLElement>('[data-drag-tab]') ?? []).filter(element => element.dataset.dragTab !== key);
      to = others.filter(element => { const rect = element.getBoundingClientRect(); return rect.left + rect.width / 2 < next.clientX; }).length;
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
        if (commit) move(tab, to);
      }
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

/** Paseo's tab row under the header: the open tabs, then + with the New tab menu (Agent starts a session). */
export function TabsRow({ onNewSession, onRename, menuRequest, onMenuRequestHandled }: { onNewSession: () => void; onRename: (session: SessionSummary) => void; menuRequest?: number; onMenuRequestHandled?: () => void }) {
  const { active, activate, close, openPanel } = useTabs();
  const drag = useTabDrag();
  const menuItems = useTabMenuItems(onRename);
  const [menu, setMenu] = React.useState<{ tab: Tab; at: { x: number; y: number } } | null>(null);
  const closeMenu = React.useCallback(() => setMenu(null), []);
  const focusActiveTab = React.useCallback(() => drag.row.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]'), [drag.row]);
  const { workspace, principal, connection } = useAppState();
  const canWrite = can(principal ?? undefined, 'session.write');
  if (!workspace) return null;
  const item = (kind: PanelKind, group = false) => {
    const panel = PANELS[kind];
    return { label: panel.label, icon: <panel.icon aria-hidden />, onSelect: () => openPanel(kind), group };
  };
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border bg-background">
      <div ref={drag.row} role="tablist" aria-label="Open tabs" className="flex min-w-0 flex-1 items-center overflow-x-auto px-1 [scrollbar-width:none]">
        {drag.shown.map(tab => (
          <WorkspaceTabChip key={tabKey(tab)} tab={tab} active={!!active && tabKey(active) === tabKey(tab)} onSelect={() => activate(tab)} onClose={() => close(tab)}
            onMenu={at => setMenu({ tab, at })} dragging={drag.dragging === tabKey(tab)} wrapper={drag.wrapper(tab)} />
        ))}
        <Menu label="New tab" align="start" openRequest={menuRequest} onOpenRequestHandled={onMenuRequestHandled} testId="workspace-new-tab"
          trigger={<Plus aria-hidden className="size-4" />}
          triggerClassName={cn('mx-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card hover:text-foreground', focusRing)}
          items={[
            { label: 'Agent', icon: <SquarePen aria-hidden />, onSelect: onNewSession, disabled: !canWrite || connection.phase !== 'open' },
            ...PRIMARY_PANELS.map(kind => item(kind)),
            ...ALP_PANELS.map((kind, index) => item(kind, index === 0)),
          ]} />
      </div>
      <ContextMenu label="Tab actions" at={menu?.at ?? null} items={menu ? menuItems(menu.tab) : []} onClose={closeMenu} fallbackFocus={focusActiveTab} testId={menu ? `workspace-tab-context-${tabKey(menu.tab)}` : undefined} />
    </div>
  );
}

/** The active tab's content. */
export function TabContent({ onNewSession }: { onNewSession: () => void }) {
  const { active } = useTabs();
  const { tree } = useAppState();
  if (active?.kind === 'draft') return <NewSessionScreen />;
  if (active?.kind === 'task') return <TaskDetail id={active.id} />;
  if (active?.kind === 'panel') return <div className="min-h-0 flex-1 overflow-y-auto"><PanelView kind={active.id} /></div>;
  if (active?.kind === 'agent' && tree) return <ChatPanel key={active.id} sessionId={active.id} />;
  return <Empty onNewSession={onNewSession} />;
}
