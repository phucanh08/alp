import * as React from 'react';
import {
  Archive, CircleDashed, CircleGauge, CircleHelp, Clock, Copy, Folder, FolderCog, FolderPlus, GitBranch, History, ListChecks, LogOut, MoreHorizontal, MoreVertical,
  Network, Pencil, Pin, PinOff, Plus, Search, Server, Settings, Settings2, Tag, Type, X,
} from 'lucide-react';
import { attentionReason, needsInput, type SessionSummary } from '../lib/controller.js';
import { sessionBucket } from '../lib/attention.js';
import { can } from '../lib/gateway.js';
import { Menu, type MenuItem, type MenuPage } from '../components/ui/menu';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { baseName, compactTime, relativeTime, sessionName } from '../lib/format';
import { cn } from '../lib/utils';
import { isMacPlatform, shortcutLabel } from '../lib/shortcuts.js';
import type { SidebarDisplay, SidebarItemId } from '../lib/preferences.js';
import { filterProjects, groupByStatus, limitRows, resolveProjectFilters, sortSessions } from '../lib/sidebar-model.js';
import { useAppState, useController } from './store';
import { StatusIndicator, type Bucket } from './status';
import { WorktreeDialog } from './WorktreeActions';

/*
 * The left sidebar, laid out as Paseo 0.14's (packages/app/src/components/left-sidebar.tsx): the
 * header's nav rows over a full-width divider; a Pinned section, then the Workspaces section with
 * its Display preferences menu, where each project row holds its rows underneath (or, grouped by
 * status, the rows sit under their status); the footer rows (Settings › Sidebar) and the footer
 * line of icons: Add project, Usage, Hosts, then Help and Settings. A project here is a workspace the
 * access token grants (or a managed worktree of one); its rows are that workspace's sessions.
 */

type RegistryRow = ReturnType<typeof useAppState>['registry']['workspaces'][number];
/** The Settings pages the sidebar opens directly. */
export type SettingsTarget = 'host' | 'projects' | 'connections' | 'diagnostics' | 'usage';

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
const ISSUES_URL = 'https://github.com/phucanh08/alp/issues/new';
const RELEASES_URL = 'https://github.com/phucanh08/alp/releases';

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
        {shortcut ? <kbd aria-hidden className="hidden rounded-md bg-secondary/50 px-1 py-px font-sans text-[length:calc(11px*var(--ui-scale))] leading-4 text-muted-foreground md:group-hover:inline">{shortcut}</kbd> : null}
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

/** A row's status (lib/attention.js sessionBucket): its question, its status, a turn that ended unseen. */
export function bucketOf(session: SessionSummary, waiting: boolean, reason?: 'finished' | 'error'): Bucket {
  return sessionBucket({ status: session.status, waiting, reason });
}

/** Paseo's section label ("Pinned", "Workspaces", a status), with its actions at the trailing edge. */
function SectionHeader({ title, children, testId }: { title: string; children?: React.ReactNode; testId?: string }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-2 pl-2 pr-1 md:min-h-9" data-testid={testId}>
      <h2 className="select-none text-xs text-muted-foreground">{title}</h2>
      {children}
    </div>
  );
}

type MetaItem = { key: string; icon: typeof Plus; text: string };

/** Paseo's workspace row: status slot, title at 76% that lifts on hover, trailing time, the Show facts under it, kebab on hover. */
function SessionRow({ session, title, meta, trailing, bucket, selected, canWrite, onSelect, onRename, onArchive }: {
  session: SessionSummary; title: string; meta: MetaItem[]; trailing: string; bucket: Bucket; selected: boolean; canWrite: boolean;
  onSelect: () => void; onRename: () => void; onArchive: () => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const when = session.status === 'closed' ? 'Closed' : `Updated ${relativeTime(session.updatedAt ?? session.createdAt)}`;
  return (
    <li className={cn('group relative mb-0.5 rounded-lg', selected ? 'bg-sidebar-selected' : 'hover:bg-sidebar-hover active:bg-secondary', menuOpen && !selected && 'bg-sidebar-hover')}>
      <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined} data-testid="session-row" title={`${title} · ${when}`}
        className={cn('flex min-h-11 w-full min-w-0 items-start gap-2 rounded-lg py-2 pl-4 pr-3 text-left md:min-h-9', canWrite && 'max-md:pr-8', focusRing)}>
        <StatusIndicator bucket={bucket} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-sm leading-5 text-foreground', selected || menuOpen ? 'opacity-100' : 'opacity-[0.76] group-hover:opacity-100')}>{title}</span>
            {trailing ? <span className={cn('shrink-0 text-xs text-muted-foreground tabular-nums', canWrite && 'md:group-hover:invisible', menuOpen && 'invisible')} data-testid="sidebar-workspace-timestamp">{trailing}</span> : null}
          </span>
          {meta.length ? (
            <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground" data-testid="sidebar-row-meta">
              {meta.map(item => (
                <span key={item.key} className="flex min-w-0 max-w-full items-center gap-1" data-meta={item.key}>
                  <item.icon aria-hidden className="size-3 shrink-0" /><span className="truncate">{item.text}</span>
                </span>
              ))}
            </span>
          ) : null}
        </span>
      </button>
      {canWrite ? (
        <div className={cn('absolute right-[5px] top-[13px] flex opacity-100 md:top-[9px] md:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100', menuOpen && 'opacity-100')}>
          {/* The scrim: the row's own fill fades the title's tail under the kebab, as Paseo's does. */}
          <span aria-hidden className={cn('pointer-events-none absolute inset-y-0 right-full hidden w-6 bg-linear-to-r md:block from-transparent', selected ? 'to-sidebar-selected' : 'to-sidebar-hover')} />
          <Menu label={`Actions for ${title}`} onOpenChange={setMenuOpen}
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

/** Paseo's project row: letter tile (a branch glyph for a worktree) that turns into the chevron on hover, muted name, + and the project's actions on hover. */
function ProjectRow({ path, name, worktree, expanded, canWrite, actions, onToggle, onNewSession }: {
  path: string; name: string; worktree: boolean; expanded: boolean; canWrite: boolean; actions: MenuItem[]; onToggle: () => void; onNewSession: () => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  return (
    <div className={cn('group relative mb-1 flex min-h-11 items-center rounded-lg md:min-h-9', rowFill, menuOpen && 'bg-sidebar-hover')}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} title={path} data-testid="project-row" data-workspace={path}
        className={cn('flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg p-2 pr-16 text-left md:min-h-9', focusRing)}>
        <span aria-hidden className="flex h-5 w-4 shrink-0 items-center justify-center">
          {worktree ? <GitBranch className="size-3.5 text-muted-foreground group-hover:hidden group-focus-within:hidden" />
            : <span className="flex size-4 items-center justify-center rounded-[4px] text-[length:calc(9px*var(--ui-scale))] font-medium leading-none text-white group-hover:hidden group-focus-within:hidden"
              style={{ backgroundColor: identityColor(path) }}>{name.slice(0, 1).toUpperCase()}</span>}
          <span className={cn('hidden size-3.5 text-muted-foreground group-hover:block group-focus-within:block transition-transform', expanded ? 'rotate-90' : '')}>›</span>
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{name}</span>
      </button>
      <div className={cn('absolute right-1.5 flex items-center gap-0.5 md:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100', menuOpen && 'opacity-100')}>
        {actions.length ? (
          <Menu label={`Project actions for ${name}`} title="Project actions" onOpenChange={setMenuOpen} testId="project-actions"
            trigger={<MoreHorizontal aria-hidden className="size-[15px]" />} items={actions}
            triggerClassName={cn('flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground', focusRing)} />
        ) : null}
        {canWrite ? (
          <button type="button" onClick={onNewSession} aria-label={`Start a session in ${name}`} title={`New session in ${name}`}
            className={cn('flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground', focusRing)}>
            <Plus aria-hidden className="size-[15px]" />
          </button>
        ) : null}
      </div>
    </div>
  );
}

/** Paseo's footer icon button: a 28px square, a 16px muted glyph that lights on hover. */
const footerButton = cn('relative flex size-11 items-center justify-center rounded-md text-muted-foreground hover:text-foreground md:size-7 [&_svg]:size-5 md:[&_svg]:size-4', focusRing);
function FooterButton({ label, title, onClick, children, testId }: { label: string; title?: string; onClick: () => void; children: React.ReactNode; testId?: string }) {
  return <button type="button" aria-label={label} title={title ?? label} onClick={onClick} data-testid={testId} className={footerButton}>{children}</button>;
}

/** Paseo's sidebar Display preferences menu: Grouping, Sort, Title, Show, then the Project filter. */
function DisplayPreferences({ display, projects, onChange }: { display: SidebarDisplay; projects: string[]; onChange: (change: Partial<SidebarDisplay>) => void }) {
  const filters = resolveProjectFilters(display.projectFilters, projects);
  const toggleFilter = (path: string) => onChange({ projectFilters: filters.includes(path) ? filters.filter(other => other !== path) : [...filters, path] });
  const pages: Record<string, MenuPage> = {
    grouping: { title: 'Grouping', items: [
      { label: 'Project', icon: <Folder aria-hidden />, checked: display.grouping === 'project', onSelect: () => onChange({ grouping: 'project' }), testId: 'sidebar-grouping-project' },
      { label: 'Status', icon: <CircleDashed aria-hidden />, checked: display.grouping === 'status', onSelect: () => onChange({ grouping: 'status' }), testId: 'sidebar-grouping-status' },
    ] },
    sort: { title: 'Sort', items: [
      { label: 'Created', checked: display.sort === 'created', onSelect: () => onChange({ sort: 'created' }), testId: 'sidebar-sort-created' },
      { label: 'Last prompt', checked: display.sort === 'lastPrompt', onSelect: () => onChange({ sort: 'lastPrompt' }), testId: 'sidebar-sort-lastPrompt' },
    ] },
    titleSource: { title: 'Title', items: [
      { label: 'Title', icon: <Type aria-hidden />, checked: display.titleSource === 'title', onSelect: () => onChange({ titleSource: 'title' }), testId: 'sidebar-workspace-title-source-title' },
      { label: 'Branch name', icon: <GitBranch aria-hidden />, checked: display.titleSource === 'branch', onSelect: () => onChange({ titleSource: 'branch' }), testId: 'sidebar-workspace-title-source-branch' },
    ] },
    show: { title: 'Show', items: [
      ...(([['branch', 'Branch', GitBranch], ['project', 'Project', Folder], ['host', 'Host', Server], ['labels', 'Labels', Tag]]) as const).map(([key, label, Icon]) => ({
        label, icon: <Icon aria-hidden />, checked: display.rowItems[key], keepOpen: true, testId: `sidebar-row-item-${key}`,
        onSelect: () => onChange({ rowItems: { ...display.rowItems, [key]: !display.rowItems[key] } }),
      })),
      { label: 'Last activity', icon: <Clock aria-hidden />, checked: display.trailing === 'timestamp', keepOpen: true, group: true, testId: 'sidebar-workspace-trailing-timestamp',
        onSelect: () => onChange({ trailing: display.trailing === 'timestamp' ? 'none' : 'timestamp' }) },
    ] },
    projectFilter: { title: 'Project', items: [
      { label: 'All projects', checked: filters.length === 0, keepOpen: true, onSelect: () => onChange({ projectFilters: [] }), testId: 'sidebar-project-filter-all' },
      ...projects.map((path, index) => ({ id: path, label: baseName(path), title: path, checked: filters.includes(path), keepOpen: true, group: index === 0, onSelect: () => toggleFilter(path), testId: 'sidebar-project-filter-item' })),
    ] },
  };
  const items: MenuItem[] = [
    { label: 'Grouping', page: 'grouping', value: display.grouping === 'project' ? 'Project' : 'Status', onSelect: () => {}, testId: 'sidebar-display-grouping' },
    ...(display.grouping === 'project' ? [{ label: 'Sort', page: 'sort', value: display.sort === 'created' ? 'Created' : 'Last prompt', onSelect: () => {}, testId: 'sidebar-display-sort' }] : []),
    { label: 'Title', page: 'titleSource', value: display.titleSource === 'title' ? 'Title' : 'Branch name', onSelect: () => {}, testId: 'sidebar-display-title-source' },
    { label: 'Show', page: 'show', onSelect: () => {}, testId: 'sidebar-display-show' },
    // One project is the whole sidebar, so filtering to it is a no-op (Paseo shows no row then).
    ...(projects.length > 1 ? [{ label: 'Project', page: 'projectFilter', indicator: filters.length > 0, group: true, onSelect: () => {}, testId: 'sidebar-display-project-filter' }] : []),
  ];
  return (
    <Menu label="Display preferences" align="end" width={232} items={items} pages={pages} testId="sidebar-display-preferences-menu"
      trigger={<Settings2 aria-hidden className="size-3.5" />}
      triggerClassName={cn('flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-hover hover:text-foreground', focusRing)} />
  );
}

/** Paseo's Add project, for ALP: register a directory the token already grants (project.register). */
function AddProjectDialog({ open, onClose, unregistered }: { open: boolean; onClose: () => void; unregistered: string[] }) {
  const controller = useController();
  const { principal, connection, registry } = useAppState();
  const [path, setPath] = React.useState('');
  React.useEffect(() => { if (open) setPath(unregistered[0] ?? ''); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const writable = can(principal ?? undefined, 'workspace.write');
  const supported = connection.capabilities.includes('workspace.registry');
  const register = async () => {
    if (!path) return;
    await controller.registerProject(path);
    onClose();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Add project"
      description="A project is a directory the host owner granted to this access token. Adding it puts it in the host's shared workspace list. For another directory, the owner grants it first (alp-gateway credential create --workspace)."
      footer={supported && writable && unregistered.length ? (
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!path || connection.phase !== 'open' || !!registry.loading} onClick={() => void register()}>Register project</Button>
        </>
      ) : <Button variant="secondary" onClick={onClose}>Close</Button>}>
      {!supported ? <p className="text-sm text-muted-foreground">This host does not list its workspaces. Update ALP on the host.</p>
        : !writable ? <p role="status" className="text-sm text-muted-foreground">Ask the host owner to add workspace.write to your credential.</p>
        : unregistered.length ? (
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-xs text-muted-foreground">Existing granted directory</span>
            <select aria-label="Existing granted directory" value={path} onChange={event => setPath(event.target.value)} className="w-full rounded-md border border-input bg-background p-2 text-sm">
              {unregistered.map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
        ) : <p className="text-sm text-muted-foreground">Every directory this token grants is already a project.</p>}
    </Dialog>
  );
}

/** Rename workspace (workspace.update title): a blank name goes back to the directory's. */
function RenameWorkspaceDialog({ row, onClose }: { row: RegistryRow | null; onClose: () => void }) {
  const controller = useController();
  const [title, setTitle] = React.useState('');
  React.useEffect(() => { setTitle(row?.title ?? ''); }, [row]);
  const save = async () => { if (row && await controller.renameWorkspace(row.id, title)) onClose(); };
  return (
    <Dialog open={!!row} onClose={onClose} title="Rename workspace"
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button onClick={() => void save()}>Rename</Button></>}>
      <form onSubmit={event => { event.preventDefault(); void save(); }}>
        <Input aria-label="Workspace name" value={title} maxLength={200} placeholder={row ? baseName(row.directory) : ''} onChange={event => setTitle(event.target.value)} autoFocus />
      </form>
    </Dialog>
  );
}

export function Sidebar({ onNewSession, onRename, onArchive, onSettings, onShortcuts, onNavigate, onClose, onHistory, historyOpen, onTasks, tasksOpen, onOpenSession, searchRequest, onSearchRequestHandled }: {
  onNewSession: () => void;
  /** The footer's Tasks row (Settings › Sidebar): ALP's tasks full screen. */
  onTasks?: () => void;
  tasksOpen?: boolean;
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
  /** Opens Settings, at a page when given. */
  onSettings: (page?: SettingsTarget) => void;
  /** Help › Keyboard shortcuts. */
  onShortcuts?: () => void;
  onNavigate: () => void;
  onClose?: () => void;
}) {
  const controller = useController();
  const state = useAppState();
  const { principal, workspace, sessions, selected, connection, preferences } = state;
  const display = preferences.sidebarDisplay;
  const mac = React.useMemo(() => isMacPlatform(), []);
  const [collapsed, setCollapsed] = React.useState(false);
  const [searching, setSearching] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [showAll, setShowAll] = React.useState<Record<string, boolean>>({});
  const [addingProject, setAddingProject] = React.useState(false);
  const [renaming, setRenaming] = React.useState<RegistryRow | null>(null);
  const [worktree, setWorktree] = React.useState<{ row: RegistryRow } | null>(null);
  const canWrite = can(principal ?? undefined, 'session.write');
  const canWriteWorkspaces = can(principal ?? undefined, 'workspace.write');
  const canManage = connection.capabilities.includes('workspace.worktree') && can(principal ?? undefined, 'workspace.manage');
  const online = connection.phase === 'open';
  const registry = state.registry;
  const registryOf = (path: string) => registry.workspaces.filter(row => !row.archivedAt && (row.directory === path || principal?.workspaceRoots?.some(root => root.path === path && root.canonical === row.directory)))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const allProjects = [...new Set([...(principal?.workspaces ?? []), ...registry.workspaces.filter(w => w.managedWorktree && !w.archivedAt).map(w => w.directory)])];
  const projects = filterProjects(allProjects, display.projectFilters);
  // A project is pinned by its own record (the first made for its directory); other records of the
  // same directory are listed and pinned under Settings › Workspaces.
  const pinned = projects.filter(path => !!registryOf(path)[0]?.pinnedAt);
  const unpinned = projects.filter(path => !pinned.includes(path));
  const unregistered = (principal?.workspaces ?? []).filter(path => !registryOf(path).length);
  const needle = query.trim().toLowerCase();
  const matches = (session: SessionSummary) => !needle || sessionName(session).toLowerCase().includes(needle);

  // Grouped by status, the section shows every project's sessions (Paseo's status list): the open
  // workspace's come live from the controller, the others are read every 15 s while it shows.
  const [others, setOthers] = React.useState<Record<string, SessionSummary[]>>({});
  const otherPaths = allProjects.filter(path => path !== workspace).join('\n');
  React.useEffect(() => {
    if (display.grouping !== 'status' || !online) return;
    let live = true;
    const read = () => { void controller.listWorkspaceSessions(otherPaths ? otherPaths.split('\n') : []).then(lists => { if (live) setOthers(lists); }); };
    read();
    const timer = setInterval(read, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [controller, display.grouping, online, otherPaths]);

  const updateDisplay = (change: Partial<SidebarDisplay>) => controller.updatePreferences({ sidebarDisplay: { ...display, ...change } });
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
  const openSession = (path: string, id: string) => {
    if (path !== workspace) controller.selectWorkspace(path);
    controller.selectSession(id);
    onOpenSession();
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
  const hostName = connection.hostname ?? connection.gateway.replace(/^https?:\/\//, '');
  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(() => controller.notify('info', `${what} copied`), () => controller.notify('error', `Could not copy the ${what.toLowerCase()}.`));
  };

  /** The project's own registry record: the first made for its directory. */
  const mainRow = (path: string) => registryOf(path)[0];
  const projectName = (path: string) => mainRow(path)?.title || baseName(path);

  /** Paseo's workspace row title and its Show facts, for a session of `path`. */
  const rowFor = (path: string, session: SessionSummary) => {
    const row = mainRow(path);
    const branch = row?.branch || undefined;
    const meta: MetaItem[] = [];
    if (display.rowItems.branch && branch) meta.push({ key: 'branch', icon: GitBranch, text: branch });
    if (display.rowItems.project) meta.push({ key: 'project', icon: Folder, text: projectName(path) });
    if (display.rowItems.host) meta.push({ key: 'host', icon: Server, text: hostName });
    if (display.rowItems.labels && row?.labels.length) meta.push({ key: 'labels', icon: Tag, text: row.labels.join(', ') });
    return {
      title: display.titleSource === 'branch' && branch ? branch : sessionName(session),
      meta,
      trailing: display.trailing === 'timestamp' ? compactTime(session.updatedAt ?? session.createdAt) : '',
    };
  };
  const bucketFor = (session: SessionSummary) => bucketOf(session, needsInput(state, session.id), attentionReason(state, session.id));
  const sessionRow = (path: string, session: SessionSummary) => {
    const row = rowFor(path, session);
    return (
      <SessionRow key={session.id} session={session} title={row.title} meta={row.meta} trailing={row.trailing} selected={session.id === selected && !historyOpen} canWrite={canWrite}
        bucket={bucketFor(session)} onSelect={() => openSession(path, session.id)} onRename={() => onRename(session)} onArchive={() => onArchive(session)} />
    );
  };

  /** Paseo's project actions, on ALP's shared workspace record: pin, rename, copy, worktrees, settings. */
  const projectActions = (path: string): MenuItem[] => {
    const row = mainRow(path);
    const items: MenuItem[] = [];
    if (row) {
      const denied = canWriteWorkspaces ? undefined : 'Ask the host owner for workspace.write to change shared pins and names.';
      items.push(
        { label: row.pinnedAt ? 'Unpin' : 'Pin to top', icon: row.pinnedAt ? <PinOff aria-hidden /> : <Pin aria-hidden />, disabled: !canWriteWorkspaces || !online, title: denied,
          onSelect: () => void controller.pinWorkspace(row.id, !row.pinnedAt), testId: row.pinnedAt ? 'project-unpin' : 'project-pin' },
        { label: 'Rename workspace', icon: <Pencil aria-hidden />, disabled: !canWriteWorkspaces || !online, title: denied, onSelect: () => setRenaming(row), testId: 'project-rename' },
      );
    } else if (connection.capabilities.includes('workspace.registry') && canWriteWorkspaces && (principal?.workspaces ?? []).includes(path)) {
      items.push({ label: 'Add to projects', icon: <FolderPlus aria-hidden />, disabled: !online, onSelect: () => void controller.registerProject(path), testId: 'project-register' });
    }
    items.push({ label: 'Copy path', icon: <Copy aria-hidden />, group: items.length > 0, onSelect: () => copy(path, 'Path'), testId: 'project-copy-path' });
    if (row?.branch) items.push({ label: 'Copy branch name', icon: <GitBranch aria-hidden />, onSelect: () => copy(row.branch!, 'Branch name'), testId: 'project-copy-branch' });
    if (row && canManage) items.push({ label: row.managedWorktree ? 'Remove worktree' : 'Create worktree', icon: <GitBranch aria-hidden />, group: true, disabled: !online,
      onSelect: () => setWorktree({ row }), testId: row.managedWorktree ? 'project-remove-worktree' : 'project-create-worktree' });
    items.push({ label: 'Open project settings', icon: <FolderCog aria-hidden />, group: true, onSelect: () => onSettings('projects'), testId: 'project-settings' });
    return items;
  };

  const projectBlock = (path: string) => {
    const expanded = path === workspace && (!collapsed || !!needle);
    const row = mainRow(path);
    const list = sortSessions(sessions.list.filter(matches), display.sort);
    const limited = limitRows(list, !!showAll[path] || !!needle, bucketFor);
    return (
      <div key={path} className={cn(expanded && 'pb-3')} data-testid="sidebar-project" data-path={path} data-workspace-id={row?.id} data-pinned={row?.pinnedAt ? 'true' : undefined}
        data-branch={row?.branch ?? undefined} data-worktree={row?.managedWorktree ? 'true' : undefined}>
        <ProjectRow path={path} name={projectName(path)} worktree={!!row?.managedWorktree} expanded={expanded} canWrite={canWrite && online} actions={projectActions(path)}
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
                <button type="button" onClick={() => startIn(path)} aria-label={`Start a session in ${projectName(path)}`}
                  className={cn('group mb-0.5 flex min-h-11 w-full items-center md:min-h-9 gap-2 rounded-lg py-2 pl-4 pr-3 text-left text-sm text-muted-foreground hover:text-foreground', rowFill, focusRing)}>
                  <span className="flex h-5 w-4 shrink-0 items-center justify-center"><Plus aria-hidden className="size-3.5" /></span>
                  <span className="truncate">New session</span>
                </button>
              ) : <p className="flex min-h-9 items-center py-2 pl-10 pr-3 text-sm text-muted-foreground">No sessions yet</p>
            ) : null}
            {needle && sessions.list.length && !list.length ? (
              <p className="flex min-h-9 items-center py-2 pl-10 pr-3 text-sm text-muted-foreground">No sessions match “{query.trim()}”</p>
            ) : null}
            <ul>{limited.visible.map(session => sessionRow(path, session))}</ul>
            {limited.canToggle || showAll[path] ? (
              <button type="button" onClick={() => setShowAll(current => ({ ...current, [path]: !current[path] }))} data-testid="sidebar-show-more"
                className={cn('flex min-h-9 w-full items-center rounded-lg py-1 pl-10 pr-3 text-left text-xs text-muted-foreground hover:text-foreground', rowFill, focusRing)}>
                {showAll[path] ? 'Show less' : 'Show more'}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const statusSections = () => {
    const all = [
      ...(workspace ? sessions.list.map(session => ({ path: workspace, session })) : []),
      ...Object.entries(others).filter(([path]) => projects.includes(path) && path !== workspace).flatMap(([path, list]) => list.map(session => ({ path, session }))),
    ].filter(entry => projects.includes(entry.path) && matches(entry.session));
    const sorted = sortSessions(all.map(entry => entry.session), 'lastPrompt').map(session => all.find(entry => entry.session === session)!);
    const groups = groupByStatus(sorted.map(entry => entry.session), bucketFor);
    if (!groups.length) return <p className="px-2 py-3 text-sm text-muted-foreground">{needle ? `No sessions match “${query.trim()}”` : 'No sessions yet'}</p>;
    return groups.map(group => (
      <div key={group.bucket} data-testid={`sidebar-status-${group.bucket}`}>
        <SectionHeader title={group.label} />
        <ul>{group.sessions.map(session => { const entry = sorted.find(item => item.session === session)!; return sessionRow(entry.path, session); })}</ul>
      </div>
    ));
  };

  const navItem = (id: SidebarItemId) => {
    switch (id) {
      case 'new-session': return <NavRow icon={Plus} label="New session" onClick={() => { onNewSession(); onNavigate(); }} disabled={!workspace || !canWrite || !online}
        title={!canWrite ? 'Your access token cannot start sessions.' : undefined} shortcut={shortcutLabel('session.new', mac)} />;
      case 'history': return <NavRow icon={History} label="History" onClick={() => { onHistory(); onNavigate(); }} active={historyOpen} disabled={!workspace} testId="sidebar-history" />;
      case 'search': return <SearchRow query={query} onQuery={setQuery} open={searching} onOpen={() => { setSearching(true); setCollapsed(false); }} onClose={closeSearch}
        focusRequest={searchFocus} />;
      case 'tasks': return <NavRow icon={ListChecks} label="Tasks" onClick={() => { onTasks?.(); onNavigate(); }} active={tasksOpen} disabled={!workspace || !onTasks} testId="sidebar-tasks" />;
    }
  };
  const footerItems = preferences.sidebar.footer.filter(item => item.visible);

  return (
    <nav aria-label="Workspaces and sessions" className="relative flex h-full min-h-0 flex-col bg-sidebar">
      <div className="flex shrink-0 flex-col gap-0.5 border-b border-border pb-1.5 pt-2">
        {/* Settings › Sidebar › Header orders these and hides any of them (Paseo's sidebar nav items). */}
        {preferences.sidebar.header.filter(item => item.visible).map(item => <React.Fragment key={item.id}>{navItem(item.id)}</React.Fragment>)}
      </div>
      {onClose ? (
        <button type="button" aria-label="Close sessions" onClick={onClose}
          className={cn('absolute right-[9.5px] top-3 z-10 flex size-8 items-center justify-center rounded-lg bg-sidebar text-muted-foreground hover:text-foreground', focusRing)}>
          <X aria-hidden className="size-4" />
        </button>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4 pt-0.5">
        {display.grouping === 'project' && pinned.length ? (
          <div data-testid="sidebar-pinned">
            <SectionHeader title="Pinned" testId="sidebar-pinned-header" />
            {pinned.map(projectBlock)}
          </div>
        ) : null}
        <SectionHeader title="Workspaces">
          <DisplayPreferences display={display} projects={allProjects} onChange={updateDisplay} />
        </SectionHeader>
        {registry.error ? <p role="alert" className="px-2 pb-2 text-xs text-destructive">{registry.error} <button type="button" className="underline" onClick={() => void controller.refreshRegistry()}>Retry</button></p> : null}
        {!allProjects.length ? (
          <div className="mt-1 px-2 py-3 text-sm" data-testid="sidebar-no-projects">
            <p className="text-foreground">No projects yet</p>
            <p className="mt-1 text-xs text-muted-foreground">This access token grants no workspace. The host owner adds one with alp-gateway credential create --workspace.</p>
          </div>
        ) : display.grouping === 'status' ? statusSections() : unpinned.map(projectBlock)}
      </div>

      {footerItems.length ? (
        <div className="flex shrink-0 flex-col gap-0.5 border-t border-border py-1.5" data-testid="sidebar-footer-items">
          {footerItems.map(item => <React.Fragment key={item.id}>{navItem(item.id)}</React.Fragment>)}
        </div>
      ) : null}
      {/* Paseo's footer line: Add project, Usage, Hosts, then Help and Settings at the end. */}
      <div className="flex shrink-0 items-center border-t border-border px-2 py-1.5" data-testid="sidebar-footer-bottom-line">
        <FooterButton label="Add project" onClick={() => setAddingProject(true)} testId="sidebar-add-project"><FolderPlus aria-hidden /></FooterButton>
        {/* Paseo's usage icon opens the account's usage; the gateway does not pass the host's
            (daemon.usage), so it opens Settings › Usage, which says where to read it. */}
        <FooterButton label="Usage" onClick={() => onSettings('usage')} testId="sidebar-usage-icon"><CircleGauge aria-hidden /></FooterButton>
        <Menu label="Hosts" title={`${principal?.label ?? 'Access token'} · ${hostName}${online ? '' : ' · reconnecting'}`} align="start" testId="sidebar-hosts-trigger"
          trigger={<><Server aria-hidden className="!size-[19px] md:!size-[15px]" /><span aria-hidden className={cn('absolute bottom-[11px] right-[11px] size-1.5 md:bottom-[5px] md:right-[5px] rounded-full ring-2 ring-sidebar', online ? 'bg-dot-success' : 'bg-dot-warning')} /></>}
          triggerClassName={footerButton}
          items={[
            { label: hostName, icon: <Server aria-hidden />, hint: online ? 'Online' : 'Reconnecting', onSelect: () => onSettings('host'), testId: 'sidebar-host-option' },
            { label: 'Connections', icon: <Network aria-hidden />, onSelect: () => onSettings('connections') },
            { label: 'Disconnect', icon: <LogOut aria-hidden />, destructive: true, group: true, onSelect: () => controller.disconnect(), testId: 'sidebar-disconnect' },
          ]} />
        <span className="flex-1" />
        <Menu label="Help and support" align="start" testId="sidebar-help-trigger" trigger={<CircleHelp aria-hidden />} triggerClassName={footerButton}
          items={[
            { label: 'Run diagnostics', onSelect: () => onSettings('diagnostics') },
            ...(onShortcuts ? [{ label: 'Keyboard shortcuts', hint: shortcutLabel('shortcuts.toggle', mac) || undefined, onSelect: onShortcuts }] : []),
            { label: 'Report an issue', group: true, onSelect: () => { window.open(ISSUES_URL, '_blank', 'noopener,noreferrer'); } },
            { label: "What's new", onSelect: () => { window.open(RELEASES_URL, '_blank', 'noopener,noreferrer'); } },
          ]} />
        <FooterButton label="Settings" onClick={() => onSettings()} testId="sidebar-settings"><Settings aria-hidden /></FooterButton>
      </div>
      <AddProjectDialog open={addingProject} onClose={() => setAddingProject(false)} unregistered={unregistered} />
      <RenameWorkspaceDialog row={renaming} onClose={() => setRenaming(null)} />
      {worktree ? <WorktreeDialog workspaceId={worktree.row.id} managed={!!worktree.row.managedWorktree} online={online} open onClose={() => setWorktree(null)} /> : null}
    </nav>
  );
}
