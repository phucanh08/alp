import * as React from 'react';
import { Archive, ChevronDown, ChevronRight, LogOut, MoreVertical, Pencil, Plus, RefreshCw, Server, Settings, X } from 'lucide-react';
import type { SessionSummary } from '../lib/controller.js';
import { can } from '../lib/gateway.js';
import { Menu } from '../components/ui/menu';
import { Spinner } from '../components/ui/spinner';
import { baseName, relativeTime, sessionName } from '../lib/format';
import { cn } from '../lib/utils';
import { useAppState, useController } from './store';
import { Logo } from './Logo';
import { StatusIndicator, type Bucket } from './status';

/*
 * The left sidebar, laid out as Paseo's: a header group of nav rows, the "Workspaces" list where
 * each project row holds its rows underneath, and a footer line of icon buttons. A project here is
 * a workspace the access token grants; its rows are that workspace's sessions.
 */

/** Paseo's identity colours for a project tile, picked by a stable hash of the project's key. */
const IDENTITY_COLORS = ['#7a6aa8', '#3d7ea6', '#388068', '#a4673a', '#b05c80', '#6a70b8', '#368080', '#b06260', '#8f7838', '#5179b0'];
function identityColor(key: string) {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return IDENTITY_COLORS[hash % IDENTITY_COLORS.length];
}

const hoverFill = 'hover:bg-sidebar-hover active:bg-secondary';
const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

/** A top-of-sidebar row (Paseo's compact SidebarHeaderRow): 14px icon, muted label, lit on hover. */
function NavRow({ icon: Icon, label, onClick, disabled, title }: { icon: typeof Plus; label: string; onClick: () => void; disabled?: boolean; title?: string }) {
  return (
    <div className="px-2">
      <button type="button" onClick={onClick} disabled={disabled} title={title}
        className={cn('group flex min-h-7 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-45', hoverFill, focusRing)}>
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}

function bucketOf(session: SessionSummary, waiting: boolean): Bucket {
  if (waiting) return 'needs_input';
  if (session.status === 'running' || session.status === 'initializing') return 'running';
  if (session.status === 'error') return 'failed';
  return 'done';
}

function SessionRow({ session, bucket, selected, canWrite, onSelect, onRename, onArchive }: {
  session: SessionSummary; bucket: Bucket; selected: boolean; canWrite: boolean;
  onSelect: () => void; onRename: () => void; onArchive: () => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const name = sessionName(session);
  const when = session.status === 'closed' ? 'closed' : relativeTime(session.updatedAt ?? session.createdAt);
  return (
    <li className={cn('group relative mb-0.5 rounded-lg', selected ? 'bg-sidebar-selected' : 'hover:bg-sidebar-hover', menuOpen && !selected && 'bg-sidebar-hover')}>
      <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined} data-testid="session-row"
        className={cn('flex min-h-9 w-full min-w-0 items-start gap-2 rounded-lg py-2 pl-4 pr-3 text-left', focusRing)}>
        <StatusIndicator bucket={bucket} />
        <span className={cn('min-w-0 flex-1 truncate text-sm leading-5 text-foreground', selected ? 'opacity-100' : 'opacity-[0.76] group-hover:opacity-100')}>{name}</span>
        <span className={cn('shrink-0 text-xs leading-5 text-muted-foreground', canWrite && 'group-hover:opacity-0 group-focus-within:opacity-0', menuOpen && 'opacity-0')}>{when}</span>
      </button>
      {canWrite ? (
        <div className={cn('absolute right-2 top-2 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100', menuOpen && 'opacity-100')}>
          <Menu label={`Actions for ${name}`} onOpenChange={setMenuOpen}
            trigger={<MoreVertical aria-hidden className="size-3.5" />}
            triggerClassName={cn('flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground', focusRing)}
            items={[
              { label: 'Rename', icon: <Pencil aria-hidden />, onSelect: onRename },
              { label: 'Archive', icon: <Archive aria-hidden />, onSelect: onArchive, destructive: true },
            ]} />
        </div>
      ) : null}
    </li>
  );
}

function ProjectRow({ path, expanded, open, canWrite, onToggle, onNewSession }: {
  path: string; expanded: boolean; open: boolean; canWrite: boolean; onToggle: () => void; onNewSession: () => void;
}) {
  const name = baseName(path);
  return (
    <div className="group relative mb-1 flex min-h-9 items-center rounded-lg hover:bg-sidebar-hover active:bg-secondary">
      <button type="button" onClick={onToggle} aria-expanded={expanded} title={path} data-testid="project-row" data-workspace={path}
        className={cn('flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded-lg py-2 pl-2 pr-9 text-left', focusRing)}>
        <span aria-hidden className="relative flex h-5 w-4 shrink-0 items-center justify-center">
          <span className="flex size-4 items-center justify-center rounded text-[9px] font-medium leading-none text-white group-hover:hidden group-focus-within:hidden"
            style={{ backgroundColor: identityColor(path) }}>{name.slice(0, 1).toUpperCase()}</span>
          {expanded ? <ChevronDown className="hidden size-3.5 text-muted-foreground group-hover:block group-focus-within:block" />
            : <ChevronRight className="hidden size-3.5 text-muted-foreground group-hover:block group-focus-within:block" />}
        </span>
        <span className={cn('min-w-0 flex-1 truncate text-sm', open ? 'text-foreground' : 'text-muted-foreground')}>{name}</span>
      </button>
      {canWrite ? (
        <button type="button" onClick={onNewSession} aria-label={`Start a session in ${name}`} title={`New session in ${name}`}
          className={cn('absolute right-1.5 flex size-6 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-secondary hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100', focusRing)}>
          <Plus aria-hidden className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** A footer icon button: 28px square, muted glyph that lights on hover. */
function FooterButton({ label, title, onClick, children }: { label: string; title?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={title ?? label} onClick={onClick}
      className={cn('relative flex size-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground [&_svg]:size-4', focusRing)}>
      {children}
    </button>
  );
}

export function Sidebar({ onNewSession, onRename, onArchive, onSettings, onNavigate, onClose }: {
  onNewSession: () => void;
  onRename: (session: SessionSummary) => void;
  onArchive: (session: SessionSummary) => void;
  onSettings: () => void;
  onNavigate: () => void;
  onClose?: () => void;
}) {
  const controller = useController();
  const { principal, workspace, sessions, selected, connection, tree } = useAppState();
  const [collapsed, setCollapsed] = React.useState(false);
  const canWrite = can(principal ?? undefined, 'session.write');
  const online = connection.phase === 'open';
  const workspaces = principal?.workspaces ?? [];
  const waiting = tree && Object.keys(tree.projection.questions).length ? tree.rootId : null;

  const toggle = (path: string) => {
    if (path === workspace) { setCollapsed(value => !value); return; }
    setCollapsed(false);
    controller.selectWorkspace(path);
  };
  const startIn = (path: string) => {
    if (path !== workspace) { setCollapsed(false); controller.selectWorkspace(path); }
    onNewSession();
    onNavigate();
  };

  return (
    <nav aria-label="Workspaces and sessions" className="flex h-full min-h-0 flex-col bg-sidebar">
      <div className="flex h-9 shrink-0 items-center gap-2 px-4 md:h-9">
        <Logo className="size-[18px] rounded-[4px]" />
        <span className="text-sm font-medium tracking-tight">ALP</span>
        {!online ? <span className="ml-1 text-xs text-warning">Reconnecting…</span> : null}
        {onClose ? (
          <button type="button" aria-label="Close sessions" onClick={onClose}
            className={cn('-mr-1.5 ml-auto flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground', focusRing)}>
            <X aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>

      <div className="flex flex-col gap-0.5 border-b border-border pb-1.5">
        <NavRow icon={Plus} label="New session" onClick={() => { onNewSession(); onNavigate(); }} disabled={!workspace || !canWrite || !online}
          title={!canWrite ? 'Your access token cannot start sessions.' : undefined} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-0.5">
        <div className="flex items-center justify-between gap-2 py-1 pl-2 pr-1">
          <h2 className="text-xs text-muted-foreground">Workspaces</h2>
          <button type="button" aria-label="Refresh sessions" title="Refresh sessions" onClick={() => void controller.refreshSessions()} disabled={!workspace || !online}
            className={cn('flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-hover hover:text-foreground disabled:opacity-45', focusRing)}>
            <RefreshCw aria-hidden className={cn('size-3.5', sessions.status === 'loading' && 'animate-spin')} />
          </button>
        </div>

        {!workspaces.length ? (
          <div className="mt-3 rounded-lg border border-border p-4 text-xs">
            <p className="text-foreground">No workspaces</p>
            <p className="mt-1 text-muted-foreground">This access token grants no workspace. The host owner adds one with alp-gateway credential create --workspace.</p>
          </div>
        ) : null}

        {workspaces.map(path => {
          const open = path === workspace;
          const expanded = open && !collapsed;
          return (
            <div key={path} className={cn(expanded && 'pb-3')}>
              <ProjectRow path={path} open={open} expanded={expanded} canWrite={canWrite && online}
                onToggle={() => toggle(path)} onNewSession={() => startIn(path)} />
              {expanded ? (
                <div>
                  {sessions.status === 'loading' && !sessions.list.length ? <div className="py-2 pl-4"><Spinner label="Loading sessions…" className="text-xs" /></div> : null}
                  {sessions.status === 'error' ? (
                    <div className="mx-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
                      {sessions.error?.message}{' '}
                      <button type="button" className="text-highlight underline-offset-4 hover:underline" onClick={() => void controller.refreshSessions()}>Try again</button>
                    </div>
                  ) : null}
                  {sessions.status === 'ready' && !sessions.list.length ? (
                    canWrite && online ? (
                      <button type="button" onClick={() => startIn(path)}
                        className={cn('group mb-0.5 flex min-h-9 w-full items-center gap-2 rounded-lg py-2 pl-4 pr-3 text-left text-sm text-muted-foreground hover:text-foreground', hoverFill, focusRing)}>
                        <span className="flex size-4 items-center justify-center"><Plus aria-hidden className="size-3.5" /></span>
                        No sessions yet. Start one
                      </button>
                    ) : <p className="py-2 pl-10 text-xs text-muted-foreground">No sessions yet.</p>
                  ) : null}
                  <ul>
                    {sessions.list.map(session => (
                      <SessionRow key={session.id} session={session} selected={session.id === selected} canWrite={canWrite}
                        bucket={bucketOf(session, session.id === waiting)}
                        onSelect={() => { controller.selectSession(session.id); onNavigate(); }}
                        onRename={() => onRename(session)} onArchive={() => onArchive(session)} />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex items-center border-t border-border px-2 py-1.5">
        <FooterButton label="Host connection" title={`${principal?.label ?? 'Access token'} · ${connection.gateway.replace(/^https?:\/\//, '')}${online ? '' : ' · reconnecting'}`} onClick={onSettings}>
          <Server aria-hidden className="!size-[15px]" />
          <span aria-hidden className={cn('absolute bottom-1 right-1 size-1.5 rounded-full ring-2 ring-sidebar', online ? 'bg-dot-success' : 'bg-dot-warning')} />
        </FooterButton>
        <span className="min-w-0 flex-1 truncate px-1.5 text-xs text-muted-foreground" title={principal?.id}>{principal?.label ?? 'Access token'}</span>
        <FooterButton label="Disconnect" title="Disconnect and forget the token" onClick={() => controller.disconnect()}><LogOut aria-hidden /></FooterButton>
        <FooterButton label="Settings" onClick={onSettings}><Settings aria-hidden /></FooterButton>
      </div>
    </nav>
  );
}
