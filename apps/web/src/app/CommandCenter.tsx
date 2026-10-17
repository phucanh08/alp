import * as React from 'react';
import { File, Folder, LoaderCircle, X } from 'lucide-react';
import { commandResults, type CommandAction, type CommandSession, type CommandWorkspace } from '../lib/command-center.js';
import { EMPTY_FILE_SEARCH, FileSearch, type FileSearchRequest, type FileSearchState } from '../lib/file-search.js';
import { cn } from '../lib/utils';
import { StatusIndicator } from './status';

export type CommandScope = 'files' | null;

/** What the command center needs to search the workspace's files (workspace.files.search). */
export type FileSearchSource = {
  /** The host offers workspace.files. */
  available: boolean;
  /** Where to search (the workspace path); another one starts afresh. */
  source: string | null;
  search: FileSearchRequest;
};

/** Paseo's useWorkspaceFileSearch over lib/file-search.js: debounced, stale answers dropped. */
function useFileSearch({ enabled, source, query, search }: { enabled: boolean; source: string | null; query: string; search: FileSearchRequest }): FileSearchState {
  const [state, setState] = React.useState<FileSearchState>(EMPTY_FILE_SEARCH);
  const latest = React.useRef(search);
  latest.current = search;
  const engine = React.useRef<FileSearch | null>(null);
  if (!engine.current) engine.current = new FileSearch({ search: q => latest.current(q), onChange: setState });
  React.useEffect(() => { engine.current?.update({ enabled, source, query }); }, [enabled, source, query]);
  React.useEffect(() => () => { engine.current?.dispose(); }, []);
  return enabled && source ? state : EMPTY_FILE_SEARCH;
}

export type RunnableAction = CommandAction & { icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>; run: () => void };

/**
 * Paseo's command center (command-center/command-center.tsx), opened with Mod+K: a search over
 * the app's and the workspace's actions, the granted workspaces, the workspace's sessions and,
 * where the host offers it, the workspace's files. Mod+P opens it in the Files scope (a chip with
 * an x; Backspace in an empty field drops it). Arrow keys move (and wrap), Enter runs the row and
 * closes, Escape, Mod+K or a click outside closes; focus goes back to where it was.
 */
export function CommandCenter({ open, scope: openScope = null, onClose, actions, sessions, workspaces = [], files, onOpenSession, onSelectWorkspace, onPickFile, mac }: {
  open: boolean;
  /** The scope it opens in (Mod+P: 'files'). */
  scope?: CommandScope;
  onClose: () => void;
  actions: RunnableAction[];
  sessions: CommandSession[];
  workspaces?: CommandWorkspace[];
  files?: FileSearchSource;
  onOpenSession: (id: string) => void;
  onSelectWorkspace?: (path: string) => void;
  onPickFile?: (path: string) => void;
  mac: boolean;
}) {
  const dialog = React.useRef<HTMLDialogElement>(null);
  const input = React.useRef<HTMLInputElement>(null);
  const results = React.useRef<HTMLDivElement>(null);
  const returnTo = React.useRef<HTMLElement | null>(null);
  const [query, setQuery] = React.useState('');
  const [scope, setScope] = React.useState<CommandScope>(openScope);
  const [activeIndex, setActiveIndex] = React.useState(0);
  const listId = React.useId();
  const filesAvailable = !!files?.available;
  const search = useFileSearch({
    enabled: open && filesAvailable && (scope === 'files' || !!query.trim()),
    source: files?.source ?? null,
    query,
    search: files?.search ?? (() => Promise.resolve({ files: [] })),
  });

  React.useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      returnTo.current = document.activeElement as HTMLElement | null;
      setQuery('');
      setScope(openScope);
      setActiveIndex(0);
      element.showModal();
      input.current?.focus();
    }
    if (!open && element.open) {
      element.close();
      // Cleared now, not on the next open: a reopened field never shows the last query for a frame.
      setQuery('');
      const target = returnTo.current;
      returnTo.current = null;
      if (target?.isConnected) target.focus();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Mod+P while open (or a new open request) moves into the Files scope.
  React.useEffect(() => { if (open && openScope) setScope(openScope); }, [open, openScope]);

  const sections = React.useMemo(() => open ? commandResults({
    actions: actions.filter(action => !action.disabled), sessions, query, workspaces, scope,
    ...(filesAvailable ? { files: search.entries } : {}),
  }) : [], [open, actions, sessions, query, workspaces, scope, filesAvailable, search.entries]);
  const rows = sections.flatMap(section => section.rows);
  const active = Math.min(activeIndex, Math.max(0, rows.length - 1));
  const byId = new Map(actions.map(action => [action.id, action]));

  React.useEffect(() => {
    results.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const choose = (index: number) => {
    const row = rows[index];
    if (!row) return;
    onClose();
    if (row.kind === 'session') onOpenSession(row.item.id);
    else if (row.kind === 'workspace') onSelectWorkspace?.(row.item.path);
    else if (row.kind === 'file') onPickFile?.(row.item.path);
    // After the dialog closed and focus went back: an action may move focus on its own.
    else setTimeout(() => byId.get(row.item.id)?.run(), 0);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!rows.length) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((active + delta + rows.length) % rows.length);
    } else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      choose(active);
    } else if (event.key === 'Backspace' && !query.trim() && scope) {
      event.preventDefault();
      setScope(null);
      setActiveIndex(0);
    } else if (event.key.toLowerCase() === 'k' && (mac ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      onClose();
    } else if (event.code === 'KeyP' && (mac ? event.metaKey : event.ctrlKey) && !event.shiftKey && !event.altKey) {
      // Search files from inside the center: the Files scope (and not the browser's print).
      event.preventDefault();
      setScope('files');
      setActiveIndex(0);
    }
  };
  const filesScope = scope === 'files';
  const placeholder = filesScope ? 'Search files...' : filesAvailable ? 'Search commands, files, workspaces, and agents...' : 'Search commands, workspaces, sessions and agents...';
  const searching = filesAvailable && search.loading;
  // What the Files scope says instead of rows: the host cannot search, or its error.
  const filesNote = filesScope && !filesAvailable ? 'This host does not offer file search. Update ALP on the host to search the workspace\'s files.' : (filesScope || query.trim()) && search.error ? search.error : null;
  const empty = filesScope ? (searching ? '' : filesAvailable && !search.error ? 'No files' : '') : 'No matches';

  let index = -1;
  return (
    <dialog ref={dialog} aria-label="Command center" data-testid="command-center-panel"
      onCancel={event => { event.preventDefault(); onClose(); }}
      onClick={event => { if (event.target === dialog.current) onClose(); }}
      className="mx-auto mt-12 mb-auto w-[min(92vw,640px)] max-h-[min(80dvh,560px)] overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-2xl shadow-[var(--shadow)] backdrop:bg-black/50">
      {open ? (
        <div className="flex max-h-[min(80dvh,560px)] flex-col" onKeyDown={onKeyDown}>
          <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3" data-testid="command-center-header">
            {filesScope ? (
              // Paseo's ScopeChip: the scope of the field, at its height; pressing it drops the scope.
              <button type="button" aria-label="Files" title="Remove the Files scope" data-testid="command-center-files-scope"
                onClick={() => { setScope(null); setActiveIndex(0); input.current?.focus(); }}
                className="flex h-7 shrink-0 items-center gap-1 rounded-md bg-secondary px-2 text-sm text-foreground hover:bg-secondary/80 outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Folder aria-hidden className="size-3.5" />
                <span>Files</span>
                <X aria-hidden className="size-3" />
              </button>
            ) : null}
            <input ref={input} type="text" role="combobox" aria-expanded aria-controls={listId} aria-activedescendant={rows.length ? `${listId}-${active}` : undefined}
              aria-label={filesScope ? 'Search files' : 'Search commands and sessions'} placeholder={placeholder} value={query} autoComplete="off" spellCheck={false}
              onChange={event => { setQuery(event.target.value); setActiveIndex(0); }} data-testid="command-center-input"
              className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground" />
            <span className="flex size-4 shrink-0 items-center justify-center" data-testid="command-center-file-search-status">
              {searching ? <span role="progressbar" aria-label="Searching files..." title="Searching files..." data-testid="command-center-file-search-loading"><LoaderCircle aria-hidden className="size-3.5 animate-spin text-muted-foreground" /></span> : null}
            </span>
          </div>
          {filesNote ? <p role={search.error ? 'alert' : 'note'} className="shrink-0 border-b border-border px-4 py-2 text-xs text-muted-foreground" data-testid="command-center-file-search-error">{filesNote}</p> : null}
          <div ref={results} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto py-1" data-testid="command-center-results">
            {rows.length === 0 ? (empty ? <p className="px-4 py-6 text-center text-sm text-muted-foreground">{empty}</p> : null) : sections.map((section, sectionIndex) => (
              <div key={section.id} role="group" aria-label={section.title} className={cn(sectionIndex > 0 && 'mt-1 border-t border-border pt-1')}>
                <div className="px-4 pb-1 pt-2 text-xs text-muted-foreground" aria-hidden>{section.title}</div>
                {section.rows.map(row => {
                  index += 1;
                  const at = index;
                  const selected = at === active;
                  if (row.kind === 'session') {
                    return (
                      <div key={`session:${row.item.id}`} id={`${listId}-${at}`} role="option" aria-selected={selected} data-index={at} data-testid={`command-center-session-${row.item.id}`}
                        onMouseMove={() => { if (!selected) setActiveIndex(at); }} onClick={() => choose(at)}
                        className={cn('flex min-h-14 cursor-pointer items-center gap-3 px-4 py-2', selected && 'bg-secondary')}>
                        <StatusIndicator bucket={row.item.bucket} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm leading-[18px] text-foreground">{row.item.title}</div>
                          {row.item.subtitle ? <div className="truncate text-xs leading-4 text-muted-foreground" data-testid="command-center-session-subtitle">{row.item.subtitle}</div> : null}
                        </div>
                      </div>
                    );
                  }
                  if (row.kind === 'workspace' || row.kind === 'file') {
                    const item = row.item;
                    const Icon = row.kind === 'workspace' ? Folder : File;
                    const current = row.kind === 'workspace' && row.item.current;
                    return (
                      <div key={`${row.kind}:${item.path}`} id={`${listId}-${at}`} role="option" aria-selected={selected} data-index={at} data-testid={`command-center-${row.kind}`} data-path={item.path}
                        aria-current={current ? 'true' : undefined}
                        onMouseMove={() => { if (!selected) setActiveIndex(at); }} onClick={() => choose(at)}
                        className={cn('flex min-h-11 cursor-pointer items-center gap-3 px-4 py-2', selected && 'bg-secondary')}>
                        <span className="flex w-4 shrink-0 justify-center text-muted-foreground"><Icon aria-hidden className="size-4" /></span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm leading-[18px] text-foreground">{item.title}</div>
                          {item.subtitle ? <div className="truncate text-xs leading-4 text-muted-foreground">{item.subtitle}</div> : null}
                        </div>
                        {current ? <span className="shrink-0 text-xs text-muted-foreground">Current</span> : null}
                      </div>
                    );
                  }
                  const action = byId.get(row.item.id);
                  const Icon = action?.icon;
                  return (
                    <div key={`action:${row.item.id}`} id={`${listId}-${at}`} role="option" aria-selected={selected} data-index={at} data-testid={`command-center-action-${row.item.id}`}
                      onMouseMove={() => { if (!selected) setActiveIndex(at); }} onClick={() => choose(at)}
                      className={cn('flex min-h-9 cursor-pointer items-center gap-3 px-4 py-2', selected && 'bg-secondary')}>
                      <span className="flex w-4 shrink-0 justify-center text-muted-foreground">{Icon ? <Icon aria-hidden className="size-4" /> : null}</span>
                      <span className="min-w-0 flex-1 truncate text-sm leading-[18px] text-foreground">{row.item.label}</span>
                      {row.item.shortcut ? <kbd className="shrink-0 rounded bg-secondary px-1.5 py-px font-sans text-xs text-muted-foreground">{row.item.shortcut}</kbd> : null}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </dialog>
  );
}
