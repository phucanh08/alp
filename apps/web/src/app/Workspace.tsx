import { Bot, CircleDot, Copy, Ellipsis, ListTodo, PanelLeft, PanelRight, Pencil, Plus, ShieldAlert, Archive, X } from 'lucide-react';
import type { SessionSummary } from '../lib/controller.js';
import { can } from '../lib/gateway.js';
import { Menu } from '../components/ui/menu';
import { baseName, sessionName } from '../lib/format';
import { cn } from '../lib/utils';
import { ChatPanel, Empty } from './SessionView';
import { StatusRing } from './status';
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
        {root ? <span className={cn('hidden text-xs sm:inline', running ? 'text-dot-running' : 'text-muted-foreground')}>{running ? 'working' : closed ? 'closed' : 'idle'}</span> : null}
        <button type="button" aria-label="Agents and tasks" aria-expanded={explorerOpen} title="Toggle explorer" onClick={onToggleExplorer} className={cn(headerButton, 'md:-mr-1.5')} data-testid="workspace-explorer-toggle">
          <PanelRight aria-hidden strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}

function useTabPresentation(tab: Tab) {
  const { tree, tasks } = useAppState();
  if (tab.kind === 'agent') {
    const projection = tree?.projection;
    const session = projection?.sessions[tab.id];
    const root = tab.id === tree?.rootId;
    const waiting = !!projection && Object.values(projection.questions).some(question => (question as any).sessionId === tab.id);
    const running = !!projection && tab.id in projection.running;
    return {
      label: root ? (session?.agent ?? 'main') : (session?.agent ?? 'agent'),
      icon: running ? <StatusRing /> : waiting ? <ShieldAlert aria-hidden className="size-3.5 text-dot-warning" /> : <Bot aria-hidden className="size-3.5" />,
      title: root ? 'Main agent' : `${session?.agent ?? 'Agent'} · assignment`,
    };
  }
  const row = tasks.rows.find(entry => entry.id === tab.id);
  return {
    label: row?.title ?? tab.id,
    icon: row?.approvals?.length ? <ShieldAlert aria-hidden className="size-3.5 text-dot-warning" /> : row?.status === 'closed' ? <CircleDot aria-hidden className="size-3.5 text-highlight" /> : <ListTodo aria-hidden className="size-3.5" />,
    title: `Task ${tab.id}`,
  };
}

function TabChip({ tab, active, onSelect, onClose }: { tab: Tab; active: boolean; onSelect: () => void; onClose: () => void }) {
  const view = useTabPresentation(tab);
  return (
    <div role="presentation" className={cn('group relative mx-0.5 flex h-7 max-w-[220px] shrink-0 items-center rounded-md', active ? 'bg-secondary' : 'hover:bg-card')}>
      <button type="button" role="tab" aria-selected={active} onClick={onSelect} title={view.title} data-testid="workspace-tab" data-tab={tabKey(tab)}
        onKeyDown={event => { if ((event.key === 'Delete' || event.key === 'Backspace') && !event.repeat) { event.preventDefault(); onClose(); } }}
        className={cn('flex h-7 min-w-0 items-center gap-1 rounded-md pl-2 pr-7 text-sm', focusRing, active ? 'text-foreground' : 'text-muted-foreground')}>
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">{view.icon}</span>
        <span className="truncate">{view.label}</span>
      </button>
      <button type="button" aria-label={`Close ${view.label}`} title="Close tab" onClick={onClose}
        className={cn('absolute right-1 flex size-[18px] items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:opacity-100', focusRing, active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
        <X aria-hidden className="size-3" />
      </button>
    </div>
  );
}

/** Paseo's tab row under the header: the open tabs, then + for a new session. */
export function TabsRow({ onNewSession }: { onNewSession: () => void }) {
  const { tabs, active, activate, close } = useTabs();
  const { workspace, principal, connection } = useAppState();
  const canWrite = can(principal ?? undefined, 'session.write');
  if (!tabs.length) return null;
  return (
    <div className="flex h-9 shrink-0 items-center border-b border-border bg-background">
      <div role="tablist" aria-label="Open tabs" className="flex min-w-0 flex-1 items-center overflow-x-auto px-1 [scrollbar-width:none]">
        {tabs.map(tab => (
          <TabChip key={tabKey(tab)} tab={tab} active={!!active && tabKey(active) === tabKey(tab)} onSelect={() => activate(tab)} onClose={() => close(tab)} />
        ))}
        {workspace && canWrite ? (
          <button type="button" aria-label="New session tab" title="New session" onClick={onNewSession} disabled={connection.phase !== 'open'}
            className={cn('mx-1 flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-card hover:text-foreground disabled:opacity-45', focusRing)}>
            <Plus aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** The active tab's content. */
export function TabContent({ onNewSession }: { onNewSession: () => void }) {
  const { active } = useTabs();
  const { tree } = useAppState();
  if (active?.kind === 'task') return <TaskDetail id={active.id} />;
  if (active?.kind === 'agent' && tree) return <ChatPanel key={active.id} sessionId={active.id} />;
  return <Empty onNewSession={onNewSession} />;
}
