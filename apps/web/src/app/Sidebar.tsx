import * as React from 'react';
import {
  Archive, CalendarClock, CircleCheck, CircleDashed, CircleGauge, CircleHelp, CircleX, Clock, Copy, Folder, FolderCog, FolderPlus, GitBranch, GitMerge, GitPullRequest,
  GitPullRequestClosed, GitPullRequestDraft, History, ListChecks, LogOut, MoreHorizontal, MoreVertical, Network, Pencil, Pin, PinOff, Plus, Search, Server, Settings,
  Settings2, Tag, Type, X,
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
import { FACTS_REFRESH_MS, formatDiffCount, mostRecentSession, prLabel, readFacts, usageLine, type WorkspaceFacts } from '../lib/sidebar-facts.js';
import { ownerRegistry, readUsage, registerDirectory, USAGE_EVENT, runtimeName, type UsageProvider } from '../lib/owner-host.js';
import { useUsagePrefs } from './settings/usage/prefs';
import { ProviderIcon } from './ProviderIcon';
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

type MetaItem = { key: string; icon: typeof Plus; text: string; className?: string; title?: string };

const PR_ICONS = { open: GitPullRequest, draft: GitPullRequestDraft, merged: GitMerge, closed: GitPullRequestClosed } as const;
const CI_ITEMS = {
  passed: { icon: CircleCheck, className: 'text-green-600 dark:text-green-400' },
  failed: { icon: CircleX, className: 'text-destructive' },
  pending: { icon: Clock, className: 'text-amber-600 dark:text-amber-400' },
} as const;

/** The workspace's pull request and CI, as Paseo's row shows them after the branch (owner only). */
export function factMeta(facts: WorkspaceFacts | undefined): MetaItem[] {
  const items: MetaItem[] = [];
  if (facts?.pr) items.push({ key: 'pr', icon: PR_ICONS[facts.pr.state], text: prLabel(facts.pr), title: `Pull request #${facts.pr.number} (${facts.pr.state})` });
  if (facts?.ci) items.push({ key: 'ci', icon: CI_ITEMS[facts.ci].icon, text: facts.ci, className: CI_ITEMS[facts.ci].className, title: `CI ${facts.ci}` });
  return items;
}

/** Paseo's diff counts at the row's trailing edge: +added in green, -removed in red. */
function DiffCounts({ facts, className }: { facts: WorkspaceFacts; className?: string }) {
  if (facts.additions === undefined && facts.deletions === undefined) return null;
  return (
    <span className={cn('shrink-0 text-xs tabular-nums', className)} data-testid="sidebar-row-diff" title={`${facts.additions ?? 0} added, ${facts.deletions ?? 0} removed (uncommitted and branch changes of the workspace)`}>
      <span className="text-green-600 dark:text-green-400">+{formatDiffCount(facts.additions ?? 0)}</span>{' '}
      <span className="text-red-600 dark:text-red-400">-{formatDiffCount(facts.deletions ?? 0)}</span>
    </span>
  );
}

/** Paseo's workspace row: status slot, title at 76% that lifts on hover, trailing time, the Show facts under it, kebab on hover. */
function SessionRow({ session, title, meta, trailing, facts, bucket, selected, canWrite, onSelect, onRename, onArchive }: {
  session: SessionSummary; title: string; meta: MetaItem[]; trailing: string; facts?: WorkspaceFacts; bucket: Bucket; selected: boolean; canWrite: boolean;
  onSelect: () => void; onRename: () => void; onArchive: () => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const when = session.status === 'closed' ? 'Closed' : `Updated ${relativeTime(session.updatedAt ?? session.createdAt)}`;
  return (
    <li className={cn('group relative mb-0.5 rounded-lg', selected ? 'bg-sidebar-selected' : 'hover:bg-sidebar-hover active:bg-secondary', menuOpen && !selected && 'bg-sidebar-hover')}>
      <button type="button" onClick={onSelect} aria-current={selected ? 'true' : undefined} data-testid="session-row" data-session-id={session.id} data-facts={facts ? 'true' : undefined} title={`${title} · ${when}`}
        className={cn('flex min-h-11 w-full min-w-0 items-start gap-2 rounded-lg py-2 pl-4 pr-3 text-left md:min-h-9', canWrite && 'max-md:pr-8', focusRing)}>
        <StatusIndicator bucket={bucket} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('min-w-0 flex-1 truncate text-sm leading-5 text-foreground', selected || menuOpen ? 'opacity-100' : 'opacity-[0.76] group-hover:opacity-100')}>{title}</span>
            {facts ? <DiffCounts facts={facts} className={cn(canWrite && !trailing && 'md:group-hover:invisible', menuOpen && 'invisible')} /> : null}
            {trailing ? <span className={cn('shrink-0 text-xs text-muted-foreground tabular-nums', canWrite && 'md:group-hover:invisible', menuOpen && 'invisible')} data-testid="sidebar-workspace-timestamp">{trailing}</span> : null}
          </span>
          {meta.length ? (
            <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground" data-testid="sidebar-row-meta">
              {meta.map(item => (
                <span key={item.key} className={cn('flex min-w-0 max-w-full items-center gap-1', item.className)} data-meta={item.key} title={item.title}>
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
function ProjectRow({ path, name, worktree, icon, expanded, canWrite, actions, onToggle, onNewSession }: {
  path: string; name: string; worktree: boolean; icon?: string; expanded: boolean; canWrite: boolean; actions: MenuItem[]; onToggle: () => void; onNewSession: () => void;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  return (
    <div className={cn('group relative mb-1 flex min-h-11 items-center rounded-lg md:min-h-9', rowFill, menuOpen && 'bg-sidebar-hover')}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} title={path} data-testid="project-row" data-workspace={path}
        className={cn('flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg p-2 pr-16 text-left md:min-h-9', focusRing)}>
        <span aria-hidden className="flex h-5 w-4 shrink-0 items-center justify-center">
          {worktree ? <GitBranch className="size-3.5 text-muted-foreground group-hover:hidden group-focus-within:hidden" />
            // The project's own icon (host.workspace.facts, owner only) as an image, never as markup.
            : icon ? <img src={icon} alt="" data-testid="project-icon" className="size-4 rounded-[4px] object-contain group-hover:hidden group-focus-within:hidden" />
            : <span data-testid="project-letter-tile" className="flex size-4 items-center justify-center rounded-[4px] text-[length:calc(9px*var(--ui-scale))] font-medium leading-none text-white group-hover:hidden group-focus-within:hidden"
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

/**
 * Paseo's New workspace, for the host owner: registers any directory of the host by its absolute
 * path (host.project.register, as Settings › Projects does); it then joins the host's workspace
 * list and this app's access.
 */
function NewWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const controller = useController();
  const { connection } = useAppState();
  const [directory, setDirectory] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { if (open) { setDirectory(''); setError(null); } }, [open]);
  const register = async () => {
    if (!directory.trim() || pending) return;
    setPending(true); setError(null);
    try {
      const { revision } = await ownerRegistry(controller);
      await registerDirectory(controller, directory, revision);
      void controller.refreshRegistry();
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setPending(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title="New workspace"
      description="Any existing directory on this host, by its absolute path. It joins the host's workspace list and this app's access; nothing in it changes."
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button disabled={!directory.trim() || pending || connection.phase !== 'open'} onClick={() => void register()} data-testid="new-workspace-register">{pending ? 'Adding…' : 'Add workspace'}</Button></>}>
      <form onSubmit={event => { event.preventDefault(); void register(); }} className="flex flex-col gap-2">
        <Input aria-label="Workspace directory" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="/absolute/path/to/project" className="font-mono" autoFocus />
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      </form>
    </Dialog>
  );
}

/**
 * Paseo's usage summary over the footer icons: per provider "<icon> 98% 5h  61% wk", its pinned
 * windows (Settings › Usage pins them; Paseo's default: 5-hour and weekly) in this browser's
 * Percentages choice, leaving out cards turned off; nothing while Summary in sidebar is off. Opens
 * Settings › Usage.
 */
function UsageLine({ providers, onOpen }: { providers: UsageProvider[]; onOpen: () => void }) {
  const prefs = useUsagePrefs();
  const entries = usageLine(providers, prefs);
  if (!entries.length) return null;
  const meaning = prefs.displayAs === 'used' ? 'used' : 'left';
  return (
    <div className="shrink-0 border-t border-border px-2 py-1.5">
      <button type="button" onClick={onOpen} data-testid="sidebar-usage-line" data-display={prefs.displayAs}
        aria-label={`Usage: ${entries.map(entry => `${runtimeName(entry.runtime)} ${entry.windows.map(window => `${window.label} ${window.text} ${meaning}`).join(', ')}`).join('; ')}`}
        title="Open usage" className={cn('flex w-full flex-wrap items-center gap-x-4 gap-y-1 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground', rowFill, focusRing)}>
        {entries.map(entry => (
          <span key={entry.runtime} className="flex items-center gap-1.5 tabular-nums" data-testid="sidebar-usage-provider" data-runtime={entry.runtime}>
            <ProviderIcon runtime={entry.runtime} />
            {entry.windows.map(window => <span key={window.id} data-window={window.id} className="whitespace-nowrap"><span className="text-foreground">{window.text}</span> {window.shortLabel}</span>)}
          </span>
        ))}
      </button>
    </div>
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

export function Sidebar({ onNewSession, onRename, onArchive, onSettings, onShortcuts, onNavigate, onClose, onHistory, historyOpen, onTasks, tasksOpen, onSchedules, schedulesOpen, onOpenSession, searchRequest, onSearchRequestHandled }: {
  onNewSession: () => void;
  /** The Schedules row (host owner only): the scheduled wakes of every workspace, read only. */
  onSchedules?: () => void;
  schedulesOpen?: boolean;
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
  const { principal, workspace, sessions, selected, connection, preferences, owner } = state;
  const display = preferences.sidebarDisplay;
  const mac = React.useMemo(() => isMacPlatform(), []);
  // Projects the person folded; every other project shows its sessions (Paseo's sidebar).
  const [folded, setFolded] = React.useState<Record<string, boolean>>({});
  const [addingWorkspace, setAddingWorkspace] = React.useState(false);
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

  // Every project shows its sessions, in either grouping (Paseo's sidebar): the open workspace's come
  // live from the controller, the others are read every 15 s (session.list, any client).
  const [others, setOthers] = React.useState<Record<string, SessionSummary[]>>({});
  const otherPaths = allProjects.filter(path => path !== workspace).join('\n');
  React.useEffect(() => {
    if (!online) return;
    let live = true;
    const read = () => { void controller.listWorkspaceSessions(otherPaths ? otherPaths.split('\n') : []).then(lists => { if (live) setOthers(lists); }); };
    read();
    const timer = setInterval(read, 15_000);
    return () => { live = false; clearInterval(timer); };
  }, [controller, online, otherPaths]);
  const sessionsOf = (path: string): SessionSummary[] => path === workspace ? sessions.list : others[path] ?? [];

  // The host owner's extras (state.owner; never requested on any other connection): each
  // workspace's facts and the account usage, read in the background, again every 60 s, and the
  // facts again when a session starts or a turn ends (a session's update time moves).
  const ownerLive = owner && online;
  const [facts, setFacts] = React.useState<Record<string, WorkspaceFacts>>({});
  const [usage, setUsage] = React.useState<UsageProvider[]>([]);
  const factIds = allProjects.map(path => registryOf(path)[0]?.id).filter((id): id is string => !!id).sort().join('\n');
  const activity = allProjects.map(path => sessionsOf(path).map(session => `${session.id}:${session.updatedAt ?? session.createdAt ?? ''}`).sort().join(',')).join('|');
  // Facts belong to the owner connection that read them: dropped when it stops being the owner.
  React.useEffect(() => { if (!owner) setFacts({}); }, [owner]);
  React.useEffect(() => {
    if (!ownerLive || !factIds) return;
    let live = true;
    const read = () => { void readFacts(controller, factIds.split('\n')).then(next => { if (live) setFacts(current => ({ ...current, ...next })); }); };
    // Session events come in bursts (a turn's updates): one read after they settle.
    const soon = setTimeout(read, 400);
    const timer = setInterval(read, FACTS_REFRESH_MS);
    return () => { live = false; clearTimeout(soon); clearInterval(timer); };
  }, [controller, ownerLive, factIds, activity]);
  React.useEffect(() => {
    if (!ownerLive) { setUsage([]); return; }
    let live = true;
    const read = () => { void readUsage(controller).then(result => { if (live) setUsage(result.providers); }, () => {}); };
    read();
    const timer = setInterval(read, FACTS_REFRESH_MS);
    // The Usage page's reads and its Check usage switch reach the summary at once (t-9116).
    const announced = (event: Event) => { const detail = (event as CustomEvent<{ providers?: UsageProvider[] }>).detail; if (live && Array.isArray(detail?.providers)) setUsage(detail.providers); };
    globalThis.addEventListener(USAGE_EVENT, announced);
    return () => { live = false; clearInterval(timer); globalThis.removeEventListener(USAGE_EVENT, announced); };
  }, [controller, ownerLive]);

  const updateDisplay = (change: Partial<SidebarDisplay>) => controller.updatePreferences({ sidebarDisplay: { ...display, ...change } });
  const setFold = (path: string, value: boolean) => setFolded(current => ({ ...current, [path]: value }));
  const toggle = (path: string) => {
    if (path === workspace) { setFold(path, !folded[path]); return; }
    setFold(path, false);
    controller.selectWorkspace(path);
  };
  const startIn = (path: string) => {
    if (path !== workspace) { setFold(path, false); controller.selectWorkspace(path); }
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
  /**
   * The session that carries its workspace's facts: the most recent of the workspace's rows on
   * show (owner only), so a row folded away by "Show more" or filtered out by Search never takes
   * them with it.
   */
  const factsFor = (path: string, session: SessionSummary, shown: readonly SessionSummary[]): WorkspaceFacts | undefined => {
    if (!owner) return undefined;
    const id = mainRow(path)?.id;
    const found = id ? facts[id] : undefined;
    return found && mostRecentSession(shown)?.id === session.id ? found : undefined;
  };
  const sessionRow = (path: string, session: SessionSummary, shown: readonly SessionSummary[]) => {
    const row = rowFor(path, session);
    const own = factsFor(path, session, shown);
    if (own) {
      // The registry's branch shows first (Show › Branch); the facts' fills in when it has none.
      if (display.rowItems.branch && own.branch && !row.meta.some(item => item.key === 'branch')) row.meta.unshift({ key: 'branch', icon: GitBranch, text: own.branch });
      const branchAt = row.meta.findIndex(item => item.key === 'branch');
      row.meta.splice(branchAt + 1, 0, ...factMeta(own));
    }
    return (
      <SessionRow key={session.id} session={session} title={row.title} meta={row.meta} trailing={row.trailing} facts={own} selected={session.id === selected && !historyOpen && !schedulesOpen} canWrite={canWrite}
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
    const current = path === workspace;
    const expanded = !folded[path] || !!needle;
    const row = mainRow(path);
    const all = sessionsOf(path);
    const list = sortSessions(all.filter(matches), display.sort);
    const limited = limitRows(list, !!showAll[path] || !!needle, bucketFor);
    // Searching hides a project none of whose sessions match (the open one keeps its message).
    if (needle && !current && !list.length) return null;
    const icon = owner && row ? facts[row.id]?.icon : undefined;
    return (
      <div key={path} className={cn(expanded && (current || list.length > 0) && 'pb-3')} data-testid="sidebar-project" data-path={path} data-workspace-id={row?.id} data-pinned={row?.pinnedAt ? 'true' : undefined}
        data-branch={row?.branch ?? undefined} data-worktree={row?.managedWorktree ? 'true' : undefined} data-current={current ? 'true' : undefined}>
        <ProjectRow path={path} name={projectName(path)} worktree={!!row?.managedWorktree} icon={icon} expanded={expanded} canWrite={canWrite && online} actions={projectActions(path)}
          onToggle={() => toggle(path)} onNewSession={() => startIn(path)} />
        {expanded ? (
          <div>
            {current && sessions.status === 'loading' && !sessions.list.length ? <div className="py-2 pl-4"><Spinner label="Loading sessions…" className="text-xs" /></div> : null}
            {current && sessions.status === 'error' ? (
              <div className="mx-1 mb-1 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive" role="alert">
                {sessions.error?.message}{' '}
                <button type="button" className="text-highlight underline-offset-4 hover:underline" onClick={() => void controller.refreshSessions()}>Try again</button>
              </div>
            ) : null}
            {current && sessions.status === 'ready' && !sessions.list.length ? (
              canWrite && online ? (
                // Paseo's ghost row: the visible "New session" with the per-project name for assistive tech.
                <button type="button" onClick={() => startIn(path)} aria-label={`Start a session in ${projectName(path)}`}
                  className={cn('group mb-0.5 flex min-h-11 w-full items-center md:min-h-9 gap-2 rounded-lg py-2 pl-4 pr-3 text-left text-sm text-muted-foreground hover:text-foreground', rowFill, focusRing)}>
                  <span className="flex h-5 w-4 shrink-0 items-center justify-center"><Plus aria-hidden className="size-3.5" /></span>
                  <span className="truncate">New session</span>
                </button>
              ) : <p className="flex min-h-9 items-center py-2 pl-10 pr-3 text-sm text-muted-foreground">No sessions yet</p>
            ) : null}
            {current && needle && all.length && !list.length ? (
              <p className="flex min-h-9 items-center py-2 pl-10 pr-3 text-sm text-muted-foreground">No sessions match “{query.trim()}”</p>
            ) : null}
            <ul>{limited.visible.map(session => sessionRow(path, session, limited.visible))}</ul>
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
        <ul>{group.sessions.map(session => { const entry = sorted.find(item => item.session === session)!; return sessionRow(entry.path, session, sorted.filter(item => item.path === entry.path).map(item => item.session)); })}</ul>
      </div>
    ));
  };

  const navItem = (id: SidebarItemId) => {
    switch (id) {
      // The host owner adds a workspace here, as Paseo's New workspace; anyone else starts a session.
      case 'new-session': return owner
        ? <NavRow icon={Plus} label="New workspace" onClick={() => setAddingWorkspace(true)} disabled={!online} testId="sidebar-new-workspace" />
        : <NavRow icon={Plus} label="New session" onClick={() => { onNewSession(); onNavigate(); }} disabled={!workspace || !canWrite || !online}
          title={!canWrite ? 'Your access token cannot start sessions.' : undefined} shortcut={shortcutLabel('session.new', mac)} />;
      case 'history': return <NavRow icon={History} label="History" onClick={() => { onHistory(); onNavigate(); }} active={historyOpen} disabled={!workspace} testId="sidebar-history" />;
      case 'search': return <SearchRow query={query} onQuery={setQuery} open={searching} onOpen={() => setSearching(true)} onClose={closeSearch}
        focusRequest={searchFocus} />;
      // Paseo's Schedules row, for the host owner only: ALP's scheduled wakes, read only.
      case 'schedules': return owner && onSchedules
        ? <NavRow icon={CalendarClock} label="Schedules" onClick={() => { onSchedules(); onNavigate(); }} active={schedulesOpen} disabled={!online} testId="sidebar-schedules" />
        : null;
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
      {owner ? <UsageLine providers={usage} onOpen={() => onSettings('usage')} /> : null}
      {/* Paseo's footer line: Add project, Usage, Hosts, then Help and Settings at the end. */}
      <div className="flex shrink-0 items-center border-t border-border px-2 py-1.5" data-testid="sidebar-footer-bottom-line">
        <FooterButton label="Add project" onClick={() => setAddingProject(true)} testId="sidebar-add-project"><FolderPlus aria-hidden /></FooterButton>
        {/* Paseo's usage icon opens the account's usage: Settings › Usage, which shows daemon.usage to
            the host owner (docs/alp/dashboard.md §4.7) and says where to read it to anyone else. */}
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
      {owner ? <NewWorkspaceDialog open={addingWorkspace} onClose={() => setAddingWorkspace(false)} /> : null}
      <RenameWorkspaceDialog row={renaming} onClose={() => setRenaming(null)} />
      {worktree ? <WorktreeDialog workspaceId={worktree.row.id} managed={!!worktree.row.managedWorktree} online={online} open onClose={() => setWorktree(null)} /> : null}
    </nav>
  );
}
