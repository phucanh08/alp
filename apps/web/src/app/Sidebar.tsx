import * as React from 'react';
import { Archive, ChevronDown, ChevronRight, History, LogOut, MoreVertical, Pencil, Plus, RefreshCw, Search, Server, Settings, Settings2, X } from 'lucide-react';
import { needsInput, type SessionSummary } from '../lib/controller.js';
import { can } from '../lib/gateway.js';
import { Menu } from '../components/ui/menu';
import { Spinner } from '../components/ui/spinner';
import { baseName, relativeTime, sessionName } from '../lib/format';
import { cn } from '../lib/utils';
import { isMacPlatform, shortcutLabel } from '../lib/shortcuts.js';
import { useAppState, useController } from './store';
import { StatusIndicator, type Bucket } from './status';

/*
 * The left sidebar, laid out as Paseo's (packages/app/src/components/left-sidebar.tsx): a header
 * group of compact nav rows over a full-width divider, the "Workspaces" section where each project
 * row holds its rows underneath, and a footer line of icon buttons. A project here is a workspace
 * the access token grants; its rows are that workspace's sessions.
 */

/** Paseo's identity colours for a project tile, picked by a stable hash of the project's key. */
const IDENTITY_COLORS = ['#7a6aa8', '#3d7ea6', '#388068', '#a4673a', '#b05c80', '#6a70b8', '#368080', '#b06260', '#8f7838', '#5179b0'];
function identityColor(key: string) {
  let hash = 0;
  for (const character of key) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  return IDENTITY_COLORS[hash % IDENTITY_COLORS.length];
}

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';
/** Paseo's row fills: sidebar-hover under the pointer, surface-2 while pressed. */
const rowFill = 'hover:bg-sidebar-hover active:bg-secondary';

/** Paseo's SidebarHeaderRow, "compact": a 28px row, 14px muted icon and label that light on hover. */
function NavRow({ icon: Icon, label, onClick, disabled, title, active, shortcut, testId }: {
  icon: typeof Plus; label: string; onClick: () => void; disabled?: boolean; title?: string; active?: boolean; shortcut?: string; testId?: string;
}) {
  return (
    <div className="px-2">
      <button type="button" onClick={onClick} disabled={disabled} title={title} aria-current={active ? 'page' : undefined} data-testid={testId}
        className={cn('group flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-1 md:min-h-7 text-left text-sm text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-45', rowFill, active && 'bg-sidebar-hover text-foreground', focusRing)}>
        <Icon aria-hidden className="size-[18px] shrink-0 md:size-3.5" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {/* Paseo's shortcut badge: shown while the row is hovered, on screens with a keyboard. */}
        {shortcut ? <kbd aria-hidden className="hidden rounded-md bg-secondary/50 px-1 py-px font-sans text-[11px] leading-4 text-muted-foreground md:group-hover:inline">{shortcut}</kbd> : null}
      </button>
    </div>
  );
}

/** The Search nav row: pressed, it becomes a filter field in the same 28px box. */
function SearchRow({ query, onQuery, open, onOpen, onClose, focusRequest, shortcut }: {
  query: string; onQuery: (value: string) => void; open: boolean; onOpen: () => void; onClose: () => void; focusRequest?: number; shortcut?: string;
}) {
  const field = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => { if (open) field.current?.focus(); }, [open, focusRequest]);
  if (!open) return <NavRow icon={Search} label="Search" onClick={onOpen} shortcut={shortcut} />;
  return (
    <div className="px-2">
      <div className="flex min-h-9 w-full items-center gap-2 rounded-lg bg-sidebar-hover px-2 py-1 md:min-h-7 focus-within:ring-1 focus-within:ring-border">
        <Search aria-hidden className="size-[18px] shrink-0 text-foreground md:size-3.5" />
        <input ref={field} type="search" value={query} onChange={event => onQuery(event.target.value)} aria-label="Search sessions" placeholder="Search sessions…"
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}
          onBlur={() => { if (!query.trim()) onClose(); }}
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden" />
        <button type="button" aria-label="Clear search" title="Clear search" onMouseDown={event => event.preventDefault()} onClick={onClose}
          className={cn('-mr-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground', focusRing)}>
          <X aria-hidden className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function bucketOf(session: SessionSummary, waiting: boolean): Bucket {
  if (waiting) return 'needs_input';
  if (session.status === 'running' || session.status === 'initializing') return 'running';
  if (session.status === 'error') return 'failed';
  return 'done';
}

/** Paseo's workspace row, indented under its project: status slot, title at 76% that lifts on hover, kebab on hover. */
function SessionRow({ session, bucket, selected, canWrite, onSelect, onRename, onArchive }: {
  session: SessionSummary; bucket: Bucket; selected: boolean; canWrite: boolean;
  onSelect: () => void; onRename: () => void; onArchive: () => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const name = sessionName(session);
  const when = session.status === 'closed' ? 'Closed' : `Updated ${relativeTime(session.updatedAt ?? session.createdAt)}`;
  return (
    <li className={cn('group relative mb-0.5 rounded-lg', selected ? 'bg-sidebar-selected' : 'hover:bg-sidebar-hover active:bg-secondary', menuOpen && !selected && 'bg-sidebar-hover')}>
      <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined} data-testid="session-row" title={`${name} · ${when}`}
        className={cn('flex min-h-11 w-full min-w-0 items-center gap-2 rounded-lg py-2 pl-4 pr-3 text-left md:min-h-9', canWrite && 'max-md:pr-8', focusRing)}>
        <StatusIndicator bucket={bucket} />
        <span className={cn('min-w-0 flex-1 truncate text-sm leading-5 text-foreground', selected || menuOpen ? 'opacity-100' : 'opacity-[0.76] group-hover:opacity-100')}>{name}</span>
      </button>
      {canWrite ? (
        <div className={cn('absolute right-[5px] top-[13px] flex opacity-100 md:top-[9px] md:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100', menuOpen && 'opacity-100')}>
          {/* The scrim: the row's own fill fades the title's tail under the kebab, as Paseo's does. */}
          <span aria-hidden className={cn('pointer-events-none absolute inset-y-0 right-full hidden w-6 bg-linear-to-r md:block from-transparent', selected ? 'to-sidebar-selected' : 'to-sidebar-hover')} />
          <Menu label={`Actions for ${name}`} onOpenChange={setMenuOpen}
            trigger={<MoreVertical aria-hidden className="size-3.5" />}
            triggerClassName={cn('flex size-[18px] items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground', selected ? 'bg-sidebar-selected' : 'bg-sidebar-hover', focusRing)}
            items={[
              { label: 'Rename', icon: <Pencil aria-hidden />, onSelect: onRename },
              { label: 'Archive', icon: <Archive aria-hidden />, onSelect: onArchive, destructive: true },
            ]} />
        </div>
      ) : null}
    </li>
  );
}

/** Paseo's project row: letter tile that turns into the chevron on hover, muted name, + on hover. */
function ProjectRow({ path, expanded, canWrite, onToggle, onNewSession }: {
  path: string; expanded: boolean; canWrite: boolean; onToggle: () => void; onNewSession: () => void;
}) {
  const name = baseName(path);
  return (
    <div className={cn('group relative mb-1 flex min-h-11 items-center rounded-lg md:min-h-9', rowFill)}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} title={path} data-testid="project-row" data-workspace={path}
        className={cn('flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg p-2 text-left md:min-h-9', canWrite && 'pr-9', focusRing)}>
        <span aria-hidden className="flex h-5 w-4 shrink-0 items-center justify-center">
          <span className="flex size-4 items-center justify-center rounded-[4px] text-[9px] font-medium leading-none text-white group-hover:hidden group-focus-within:hidden"
            style={{ backgroundColor: identityColor(path) }}>{name.slice(0, 1).toUpperCase()}</span>
          {expanded ? <ChevronDown className="hidden size-3.5 text-muted-foreground group-hover:block group-focus-within:block" />
            : <ChevronRight className="hidden size-3.5 text-muted-foreground group-hover:block group-focus-within:block" />}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{name}</span>
      </button>
      {canWrite ? (
        <button type="button" onClick={onNewSession} aria-label={`Start a session in ${name}`} title={`New session in ${name}`}
          className={cn('absolute right-1.5 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground group-hover:opacity-100 focus-visible:opacity-100 md:opacity-0', focusRing)}>
          <Plus aria-hidden className="size-[15px]" />
        </button>
      ) : null}
    </div>
  );
}

/** Paseo's footer icon button: a 28px square, a 16px muted glyph that lights on hover. */
function FooterButton({ label, title, onClick, children }: { label: string; title?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-label={label} title={title ?? label} onClick={onClick}
      className={cn('relative flex size-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground md:size-7 [&_svg]:size-5 md:[&_svg]:size-4', focusRing)}>
      {children}
    </button>
  );
}

export function Sidebar({ onNewSession, onRename, onArchive, onSettings, onNavigate, onClose, onHistory, historyOpen, onOpenSession, searchRequest, onSearchRequestHandled }: {
  onNewSession: () => void;
  onHistory: () => void;
  historyOpen: boolean;
  /** A session row was chosen: the workspace shows it (History closes). */
  onOpenSession: () => void;
  /** Opens and focuses the search field each time it changes (Cmd/Ctrl+K). */
  searchRequest?: number;
  /** The search request was taken: the owner clears it, so a remount does not open search again. */
  onSearchRequestHandled?: () => void;
  onRename: (session: SessionSummary) => void;
  onArchive: (session: SessionSummary) => void;
  onSettings: () => void;
  onNavigate: () => void;
  onClose?: () => void;
}) {
  const controller = useController();
  const state = useAppState();
  const { principal, workspace, sessions, selected, connection } = state;
  const mac = React.useMemo(() => isMacPlatform(), []);
  const [collapsed, setCollapsed] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const canWrite = can(principal ?? undefined, 'session.write');
  const online = connection.phase === 'open';
  const workspaces = principal?.workspaces ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle ? sessions.list.filter(session => sessionName(session).toLowerCase().includes(needle)) : sessions.list;

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
  const closeSearch = () => { setQuery(''); setSearching(false); };
  const [searchFocus, setSearchFocus] = React.useState(0);
  React.useEffect(() => {
    if (!searchRequest) return;
    setSearching(true);
    setCollapsed(false);
    setSearchFocus(value => value + 1);
    onSearchRequestHandled?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchRequest]);
  const host = `${principal?.label ?? 'Access token'} · ${connection.gateway.replace(/^https?:\/\//, '')}${online ? '' : ' · reconnecting'}`;

  return (
    <nav aria-label="Workspaces and sessions" className="relative flex h-full min-h-0 flex-col bg-sidebar">
      <div className="flex shrink-0 flex-col gap-0.5 border-b border-border pb-1.5 pt-2">
        <NavRow icon={Plus} label="New session" onClick={() => { onNewSession(); onNavigate(); }} disabled={!workspace || !canWrite || !online}
          title={!canWrite ? 'Your access token cannot start sessions.' : undefined} shortcut={shortcutLabel('session.new', mac)} />
        <NavRow icon={History} label="History" onClick={() => { onHistory(); onNavigate(); }} active={historyOpen} disabled={!workspace} testId="sidebar-history" />
        <SearchRow query={query} onQuery={setQuery} open={searching} onOpen={() => { setSearching(true); setCollapsed(false); }} onClose={closeSearch}
          focusRequest={searchFocus} shortcut={shortcutLabel('search', mac)} />
      </div>
      {onClose ? (
        <button type="button" aria-label="Close sessions" onClick={onClose}
          className={cn('absolute right-[9.5px] top-3 z-10 flex size-8 items-center justify-center rounded-lg bg-sidebar text-muted-foreground hover:text-foreground', focusRing)}>
          <X aria-hidden className="size-4" />
        </button>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-0.5">
        <div className="flex min-h-11 items-center justify-between gap-2 pl-2 pr-1 md:min-h-9">
          <h2 className="select-none text-xs text-muted-foreground">Workspaces</h2>
          <Menu label="Display preferences" align="end"
            trigger={<Settings2 aria-hidden className={cn('size-3.5', sessions.status === 'loading' && 'animate-pulse')} />}
            triggerClassName={cn('flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-hover hover:text-foreground', focusRing)}
            items={[
              { label: 'Refresh sessions', icon: <RefreshCw aria-hidden />, onSelect: () => void controller.refreshSessions(), disabled: !workspace || !online },
              { label: collapsed ? 'Expand workspace' : 'Collapse workspace', icon: collapsed ? <ChevronRight aria-hidden /> : <ChevronDown aria-hidden />, onSelect: () => setCollapsed(value => !value), disabled: !workspace },
            ]} />
        </div>

        {!workspaces.length ? (
          <div className="mt-1 px-2 py-3 text-sm">
            <p className="text-foreground">No workspaces</p>
            <p className="mt-1 text-xs text-muted-foreground">This access token grants no workspace. The host owner adds one with alp-gateway credential create --workspace.</p>
          </div>
        ) : null}

        {workspaces.map(path => {
          const expanded = path === workspace && (!collapsed || !!needle);
          return (
            <div key={path} className={cn(expanded && 'pb-3')}>
              <ProjectRow path={path} expanded={expanded} canWrite={canWrite && online}
                onToggle={() => toggle(path)} onNewSession={() => startIn(path)} />
              {expanded ? (
                <div>
                  {sessions.status === 'loading' && !sessions.list.length ? <div className="py-2 pl-4"><Spinner label="Loading sessions…" className="text-xs" /></div> : null}
                  {sessions.status === 'error' ? (
                    <div className="mx-1 mb-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
                      {sessions.error?.message}{' '}
                      <button type="button" className="text-highlight underline-offset-4 hover:underline" onClick={() => void controller.refreshSessions()}>Try again</button>
                    </div>
                  ) : null}
                  {sessions.status === 'ready' && !sessions.list.length ? (
                    canWrite && online ? (
                      // Paseo's ghost row: the visible "New session" with the per-project name for assistive tech.
                      <button type="button" onClick={() => startIn(path)} aria-label={`Start a session in ${baseName(path)}`}
                        className={cn('group mb-0.5 flex min-h-11 w-full items-center md:min-h-9 gap-2 rounded-lg py-2 pl-4 pr-3 text-left text-sm text-muted-foreground hover:text-foreground', rowFill, focusRing)}>
                        <span className="flex h-5 w-4 shrink-0 items-center justify-center"><Plus aria-hidden className="size-3.5" /></span>
                        <span className="truncate">New session</span>
                      </button>
                    ) : <p className="flex min-h-9 items-center py-2 pl-10 pr-3 text-sm text-muted-foreground">No sessions yet</p>
                  ) : null}
                  {needle && sessions.list.length && !shown.length ? (
                    <p className="flex min-h-9 items-center py-2 pl-10 pr-3 text-sm text-muted-foreground">No sessions match “{query.trim()}”</p>
                  ) : null}
                  <ul>
                    {shown.map(session => (
                      <SessionRow key={session.id} session={session} selected={session.id === selected && !historyOpen} canWrite={canWrite}
                        bucket={bucketOf(session, needsInput(state, session.id))}
                        onSelect={() => { controller.selectSession(session.id); onOpenSession(); onNavigate(); }}
                        onRename={() => onRename(session)} onArchive={() => onArchive(session)} />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center border-t border-border px-2 py-1.5">
        <FooterButton label="Host connection" title={host} onClick={onSettings}>
          <Server aria-hidden className="!size-[19px] md:!size-[15px]" />
          <span aria-hidden className={cn('absolute bottom-[11px] right-[11px] size-1.5 md:bottom-[5px] md:right-[5px] rounded-full ring-2 ring-sidebar', online ? 'bg-dot-success' : 'bg-dot-warning')} />
        </FooterButton>
        <FooterButton label="Disconnect" title="Disconnect and forget the token" onClick={() => controller.disconnect()}><LogOut aria-hidden /></FooterButton>
        <span className="flex-1" />
        <FooterButton label="Settings" onClick={onSettings}><Settings aria-hidden /></FooterButton>
      </div>
    </nav>
  );
}
