import * as React from 'react';
import { ArrowDownUp, ChevronRight, Copy, Eye, EyeOff, File, FileText, Files, Folder, FolderOpen, Lock, RefreshCw } from 'lucide-react';
import { ContextMenu, type MenuItem } from '../components/ui/menu';
import { isDesktopApp } from '../lib/browser-url.js';
import { registryWorkspaceOf } from '../lib/git.js';
import { revealWorkspace } from '../lib/owner-host.js';
import { FILES_READ_FORBIDDEN, FILES_READ_UNAVAILABLE } from '../lib/controller.js';
import { FileAccessError } from '../lib/errors.js';
import { SORT_LABELS, flattenTree, nextSort, toggleExpanded, type Listing, type SortOption } from '../lib/file-tree.js';
import { can } from '../lib/gateway.js';
import { listOwnerFiles } from '../lib/owner-library.js';
import { cn } from '../lib/utils';
import { useAppState, useController, useOwner } from './store';
import { useTabs } from './tabs';

/*
 * Paseo's Files panel (components/file-explorer-pane.tsx at b63a325), read-only: the open
 * workspace's tree, each directory listed when it is opened (workspace.files.list, files.read);
 * a file opens in a file tab. The sort button cycles name, modified, size; Refresh lists the open
 * directories again. One toggle, "Show hidden files", shows dot-names and also lists what
 * .gitignore hides (includeIgnored). Blocked paths (secrets, .git, .alp) and links never show.
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
const tool = cn('flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground [&_svg]:size-4', focusRing);

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
  const [menu, setMenu] = React.useState<{ path: string; name: string; directory: boolean; at: { x: number; y: number } } | null>(null);
  // Each listing pass: answers of an older one (another workspace, before a refresh) are dropped.
  const pass = React.useRef(0);

  const list = React.useCallback((directory: string, includeIgnored: boolean) => {
    const at = pass.current;
    setListings(current => ({ ...current, [directory]: current[directory]?.status === 'ready' ? current[directory] : { status: 'loading' } }));
    const request = { ...(directory ? { path: directory } : {}), includeIgnored };
    (owner && workspace ? listOwnerFiles(controller, workspace, request) : controller.listWorkspaceFiles(request)).then(
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
    pass.current += 1;
    setListings({});
    list('', showHidden);
    for (const directory of expanded) list(directory, showHidden);
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
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
        <span className="min-w-0 flex-1 truncate px-1 text-xs text-muted-foreground">Sorted by {SORT_LABELS[sort].toLowerCase()}</span>
        <button type="button" className={tool} onClick={() => setSort(nextSort)} aria-label={`Sort by ${SORT_LABELS[nextSort(sort)].toLowerCase()}`} title={`Sort: ${SORT_LABELS[sort]}`} data-testid="files-sort" data-sort={sort}><ArrowDownUp aria-hidden /></button>
        <button type="button" className={tool} onClick={() => setShowHidden(value => !value)} aria-pressed={showHidden} aria-label="Show hidden files" title={showHidden ? 'Hide hidden files' : 'Show hidden files'} data-testid="files-show-hidden">{showHidden ? <Eye aria-hidden /> : <EyeOff aria-hidden />}</button>
        <button type="button" className={tool} onClick={refresh} aria-label="Refresh files" title="Refresh" data-testid="files-refresh"><RefreshCw aria-hidden /></button>
      </div>
      <ul className="py-1" role="tree" aria-label="Workspace files">
        {rows.map(row => {
          const indent = { paddingLeft: 8 + row.depth * 14 };
          if (row.kind === 'status') {
            const text = row.status === 'loading' ? 'Loading…' : row.status === 'empty' ? (row.path ? 'Empty folder' : 'No files to show') : row.status === 'truncated' ? 'Only the first 1000 entries are shown.' : row.message ?? 'Could not list this folder.';
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
          const Icon = directory ? (row.open ? FolderOpen : Folder) : File;
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
                className={cn('flex w-full min-w-0 items-center gap-1.5 py-1 pr-3 text-left text-[length:calc(13px*var(--ui-scale))]', current ? 'bg-sidebar-selected text-foreground' : 'text-foreground/85 hover:bg-sidebar-hover', focusRing)}
                data-testid="files-entry" data-path={entry.path} data-kind={entry.kind}>
                <ChevronRight aria-hidden className={cn('size-3.5 shrink-0 text-extra-muted transition-transform', !directory && 'invisible', row.open && 'rotate-90')} />
                <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{entry.name}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <ContextMenu label="File actions" at={menu?.at ?? null} items={menu ? menuItems(menu) : []} onClose={() => setMenu(null)} testId="files-context-menu" />
    </div>
  );
}
