import * as React from 'react';
import { ChevronDown, ChevronRight, Copy, Eye, EyeOff, FileText, Files, Folder, FolderOpen, Lock, RotateCw } from 'lucide-react';
import { ContextMenu, type MenuItem } from '../components/ui/menu';
import { isDesktopApp } from '../lib/browser-url.js';
import { registryWorkspaceOf } from '../lib/git.js';
import { revealWorkspace } from '../lib/owner-host.js';
import { FILES_READ_FORBIDDEN, FILES_READ_UNAVAILABLE } from '../lib/controller.js';
import { FileAccessError } from '../lib/errors.js';
import { fileIconUrl } from '../lib/file-icons.js';
import { SORT_LABELS, flattenTree, nextSort, toggleExpanded, type Listing, type SortOption } from '../lib/file-tree.js';
import { can } from '../lib/gateway.js';
import { listOwnerFiles } from '../lib/owner-library.js';
import { cn } from '../lib/utils';
import { useAppState, useController, useOwner } from './store';
import { useTabs } from './tabs';

/*
 * Paseo's Files panel (components/file-explorer-pane.tsx at b63a325, its look as of v0.17.3,
 * t-81b0.12), read-only: the open workspace's tree, each directory listed when it is opened
 * (workspace.files.list, files.read); a file opens in a file tab. The toolbar is Paseo's: the sort
 * label ("Name ⌄") cycles name, modified, size; Eye/EyeOff shows or hides hidden files; Refresh
 * (a spinner while it runs) lists the open directories again, the tree kept meanwhile. A folder row
 * is its chevron (a spinner while it loads) and name, a file row its material file icon
 * (lib/file-icons.js) and name. Paseo's New file / New folder are left out: nothing here writes.
 * ALP's hidden toggle, off by default, shows dot-names and also lists what .gitignore hides
 * (includeIgnored, docs/alp/remote-gateway.md); Paseo's is on by default and has no .gitignore to
 * respect. Blocked paths (secrets, .git, .alp) and links never show.
 * The host owner's own dashboard (state.owner) lists through host.files.list instead, without
 * files.read on its credential (t-a95b, docs/alp/dashboard.md §4.8); every other token as above.
 *
 * A right click (or Shift+F10 / the Menu key) on an entry opens Paseo's file-tree context menu,
 * reduced to what changes nothing on the host (t-a35b): Open (a file) or Expand/Collapse (a
 * folder), Copy path, Copy relative path, Copy name, and, in the owner's own ALP.app, Open
 * workspace in file manager (host.workspace.reveal, by the workspace's registry id: never a path,
 * so it opens the workspace folder, not the entry). No create, rename or delete.
 */

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';
// Paseo's ToolbarButton: a glyph in a larger hit box, extra-muted, brighter on hover.
const tool = cn('flex size-7 items-center justify-center rounded-md text-extra-muted hover:bg-sidebar-hover hover:text-foreground disabled:opacity-60 disabled:hover:bg-transparent [&_svg]:size-3.5', focusRing);

/** Paseo's LoadingSpinner in a 14px glyph's place. */
function Spinner() {
  return <span aria-hidden className="block size-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent text-extra-muted" data-testid="files-spinner" />;
}

function Note({ testId, children }: { testId: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-2 p-6 text-center" role="note" data-testid={testId}>
      <Files aria-hidden strokeWidth={1.5} className="size-6 text-extra-muted" />
      {children}
    </div>
  );
}

export function FilesPanel({ onPicked }: { onPicked?: () => void }) {
  const controller = useController();
  const app = useAppState();
  const { workspace, connection, principal } = app;
  const { openFile, active } = useTabs();
  const owner = useOwner();
  const readable = owner || connection.capabilities.includes('workspace.files.read');
  const granted = owner || can(principal ?? undefined, 'files.read');
  const [listings, setListings] = React.useState<Record<string, Listing>>({});
  const [expanded, setExpanded] = React.useState<string[]>([]);
  const [sort, setSort] = React.useState<SortOption>('name');
  const [showHidden, setShowHidden] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [menu, setMenu] = React.useState<{ path: string; name: string; directory: boolean; at: { x: number; y: number } } | null>(null);
  // Each listing pass: answers of an older one (another workspace, before a refresh) are dropped.
  const pass = React.useRef(0);

  // A listing shown stays until its new answer replaces it (Paseo keeps the tree while it refreshes).
  const list = React.useCallback((directory: string, includeIgnored: boolean): Promise<unknown> => {
    const at = pass.current;
    setListings(current => ({ ...current, [directory]: current[directory]?.status === 'ready' ? current[directory] : { status: 'loading' } }));
    const request = { ...(directory ? { path: directory } : {}), includeIgnored };
    return (owner && workspace ? listOwnerFiles(controller, workspace, request) : controller.listWorkspaceFiles(request)).then(
      result => { if (pass.current === at) setListings(current => ({ ...current, [directory]: { status: 'ready', entries: result.entries, truncated: result.truncated } })); },
      error => { if (pass.current === at) setListings(current => ({ ...current, [directory]: { status: 'error', error: error instanceof FileAccessError || error instanceof Error ? error.message : 'Could not list this folder.' } })); },
    );
  }, [controller, owner, workspace]);

  // A new workspace, connection or hidden setting: the tree starts again from the root, open
  // folders kept (except on a workspace change).
  const scope = `${connection.gateway}\n${workspace ?? ''}`;
  const lastScope = React.useRef(scope);
  const expandedRef = React.useRef(expanded);
  expandedRef.current = expanded;
  React.useEffect(() => {
    if (!readable || !granted || !workspace || connection.phase !== 'open') return;
    pass.current += 1;
    const keep = lastScope.current === scope;
    lastScope.current = scope;
    setRefreshing(false);
    setListings({});
    if (!keep) setExpanded([]);
    list('', showHidden);
    if (keep) for (const directory of expandedRef.current) list(directory, showHidden);
  }, [readable, granted, workspace, scope, connection.phase, showHidden, list]);

  if (!readable) return <Note testId="files-unavailable"><p className="max-w-[300px] text-sm text-muted-foreground">{FILES_READ_UNAVAILABLE}</p></Note>;
  if (!granted) {
    return (
      <Note testId="files-forbidden">
        <p className="flex max-w-[300px] items-start gap-2 text-sm text-foreground"><Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />{FILES_READ_FORBIDDEN}</p>
        <p className="max-w-[300px] text-xs leading-5 text-muted-foreground">File reading is never granted by default. The host owner can create a token that allows it: <code className="font-mono">alp-gateway credential create --permission files.read</code> (with the other permissions it needs).</p>
      </Note>
    );
  }
  if (!workspace) return <Note testId="files-no-workspace"><p className="text-sm text-muted-foreground">Choose a workspace to browse its files.</p></Note>;

  const rows = flattenTree(listings, expanded, { sort, showHidden });
  const toggle = (directory: string) => {
    const opening = !expanded.includes(directory);
    setExpanded(current => toggleExpanded(current, directory));
    if (opening && listings[directory]?.status !== 'ready') list(directory, showHidden);
  };
  const refresh = () => {
    if (refreshing) return;
    pass.current += 1;
    const at = pass.current;
    setRefreshing(true);
    void Promise.allSettled([list('', showHidden), ...expanded.map(directory => list(directory, showHidden))])
      .then(() => { if (pass.current === at) setRefreshing(false); });
  };
  const shownFile = active?.kind === 'file' ? active.id : undefined;
  const copy = (text: string, what: string) => {
    const done = navigator.clipboard?.writeText(text);
    if (!done) { controller.notify('error', `Could not copy the ${what}.`); return; }
    done.then(() => controller.notify('info', `Copied the ${what}.`), () => controller.notify('error', `Could not copy the ${what}.`));
  };
  const registryRow = owner && isDesktopApp() && connection.phase === 'open' ? registryWorkspaceOf(app) : undefined;
  const menuItems = (target: NonNullable<typeof menu>): MenuItem[] => {
    const absolute = `${workspace.replace(/\/+$/, '')}/${target.path}`;
    const items: MenuItem[] = [
      target.directory
        ? { id: 'toggle', label: expanded.includes(target.path) ? 'Collapse' : 'Expand', icon: <FolderOpen aria-hidden />, onSelect: () => toggle(target.path), testId: 'files-menu-toggle' }
        : { id: 'open', label: 'Open', icon: <FileText aria-hidden />, onSelect: () => { openFile(target.path); onPicked?.(); }, testId: 'files-menu-open' },
      { id: 'copy-path', label: 'Copy path', icon: <Copy aria-hidden />, group: true, onSelect: () => copy(absolute, 'path'), testId: 'files-menu-copy-path' },
      { id: 'copy-relative', label: 'Copy relative path', icon: <Copy aria-hidden />, onSelect: () => copy(target.path, 'relative path'), testId: 'files-menu-copy-relative' },
      { id: 'copy-name', label: 'Copy name', icon: <Copy aria-hidden />, onSelect: () => copy(target.name, 'name'), testId: 'files-menu-copy-name' },
    ];
    if (registryRow) {
      const id = registryRow.id;
      items.push({ id: 'reveal', label: 'Open workspace in file manager', icon: <Folder aria-hidden />, group: true, title: 'Opens the workspace folder on this computer', testId: 'files-menu-reveal',
        onSelect: () => void revealWorkspace(controller, id).catch(error => controller.notify('error', `Couldn't open folder: ${error?.message ?? error}`)) });
    }
    return items;
  };
  const openMenu = (target: Omit<NonNullable<typeof menu>, 'at'>, at: { x: number; y: number }) => setMenu({ ...target, at });

  return (
    <div className="flex min-h-full flex-col" data-testid="files-panel">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-sidebar pr-1" data-testid="files-pane-header">
        <button type="button" onClick={() => setSort(nextSort)} data-testid="files-sort" data-sort={sort}
          aria-label={`Sorted by ${SORT_LABELS[sort].toLowerCase()}; sort by ${SORT_LABELS[nextSort(sort)].toLowerCase()}`} title={`Sort by ${SORT_LABELS[nextSort(sort)].toLowerCase()}`}
          className={cn('ml-2 flex h-6 items-center gap-1 rounded-md px-1 text-[length:calc(13px*var(--ui-scale))] text-muted-foreground hover:bg-sidebar-hover', focusRing)}>
          <span data-testid="files-sort-label">{SORT_LABELS[sort]}</span>
          <ChevronDown aria-hidden className="size-3" />
        </button>
        <div className="flex items-center gap-px">
          <button type="button" className={tool} onClick={() => setShowHidden(value => !value)} aria-pressed={showHidden} aria-label="Show hidden files" title={showHidden ? 'Hide hidden files' : 'Show hidden files'} data-testid="files-show-hidden">{showHidden ? <Eye aria-hidden /> : <EyeOff aria-hidden />}</button>
          <button type="button" className={tool} onClick={refresh} disabled={refreshing} aria-busy={refreshing || undefined} aria-label={refreshing ? 'Refreshing files' : 'Refresh files'} title={refreshing ? 'Refreshing files' : 'Refresh files'} data-testid="files-refresh">
            {refreshing ? <Spinner /> : <RotateCw aria-hidden />}
          </button>
        </div>
      </div>
      <ul className="pb-4 pt-2" role="tree" aria-label="Workspace files">
        {rows.map(row => {
          // Paseo's treeRowPaddingLeft: 12px, then 12px a level.
          const indent = { paddingLeft: 12 + row.depth * 12 };
          if (row.kind === 'status') {
            const text = row.status === 'loading' ? 'Loading files…' : row.status === 'empty' ? (showHidden ? 'No files' : 'No visible files') : row.status === 'truncated' ? 'Only the first 1000 entries are shown.' : row.message ?? 'Could not list this folder.';
            return (
              <li key={`status:${row.path}`} role="none" style={indent} className={cn('py-1 pr-3 text-xs', row.status === 'error' ? 'text-destructive' : 'text-muted-foreground')} data-testid={`files-${row.status}`}>
                {text}
                {row.status === 'error' ? <button type="button" className="ml-2 text-highlight hover:underline" onClick={() => list(row.path, showHidden)}>Retry</button> : null}
              </li>
            );
          }
          const { entry } = row;
          const directory = entry.kind === 'directory';
          const current = !directory && shownFile === entry.path;
          return (
            <li key={entry.path} role="treeitem" aria-expanded={directory ? row.open : undefined} aria-selected={current || undefined}>
              <button type="button" style={indent} title={entry.path}
                onClick={() => { if (directory) toggle(entry.path); else { openFile(entry.path); onPicked?.(); } }}
                onContextMenu={event => { event.preventDefault(); openMenu({ path: entry.path, name: entry.name, directory }, { x: event.clientX, y: event.clientY }); }}
                onKeyDown={event => {
                  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                    event.preventDefault();
                    const box = event.currentTarget.getBoundingClientRect();
                    openMenu({ path: entry.path, name: entry.name, directory }, { x: box.left + 24, y: box.bottom });
                  }
                }}
                className={cn('group flex w-full min-w-0 items-center gap-2 py-1.5 pr-2 text-left text-[length:calc(14px*var(--ui-scale))] text-foreground', current ? 'bg-sidebar-selected' : 'hover:bg-sidebar-hover', focusRing)}
                data-testid="files-entry" data-path={entry.path} data-kind={entry.kind}>
                {/* Paseo's tree row: a folder is its chevron (a spinner while it loads), a file its icon. */}
                <span aria-hidden className="flex size-4 shrink-0 items-center justify-center">
                  {directory
                    ? (row.loading ? <Spinner /> : <ChevronRight className={cn('size-4 text-extra-muted transition-transform', row.open && 'rotate-90')} />)
                    : <img src={fileIconUrl(entry.name)} alt="" width={16} height={16} draggable={false} className="size-4" />}
                </span>
                <span className={cn('truncate', current ? 'opacity-100' : 'opacity-[0.76] group-hover:opacity-100')}>{entry.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <ContextMenu label="File actions" at={menu?.at ?? null} items={menu ? menuItems(menu) : []} onClose={() => setMenu(null)} testId="files-context-menu" />
    </div>
  );
}
