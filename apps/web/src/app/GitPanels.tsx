import * as React from 'react';
import { ChevronRight, FileDiff, GitBranch, GitCompareArrows, Lock, RefreshCw, Space } from 'lucide-react';
import type { GitDiffFile, GitStatus, GitStatusFile } from '@anhlp/alp-protocol';
import { LINE_LIMIT, clipLines } from '../lib/tool-calls.js';
import { CHANGE_LABELS, CHANGE_LETTERS, GIT_ERROR_MESSAGES, GIT_MODES, KIND_MESSAGES, appendDiffPage, baseLabel, branchLine, describeGitError, diffRows, diffTotals, formatDiffCount, restartsDiff, type DiffView } from '../lib/git.js';
import { cn } from '../lib/utils';
import { useAppState, useController } from './store';

/*
 * Paseo's Changes and Diff panels (packages/app/src/panels/diff-panel.tsx and git/diff-pane.tsx at
 * b63a325), read only, through workspace.git.status and workspace.git.diff (§12.5): the branch
 * header, Uncommitted / Committed (against the base branch), the changed files with their +/-
 * counts, each file's hunks (Changes: opened one by one; Diff: all, or the one file Changes sent it
 * to), Hide whitespace, Refresh (and a refresh when the page comes back after a while; no polling).
 * Binary, too large, withheld, symlink and submodule files say so instead of hunks. A token
 * without files.read sees the status (paths, no content). Commit, push, pull, merge and branch
 * switching are not offered: the note says they stay on the host.
 */

type Mode = 'uncommitted' | 'base' | 'staged' | 'unstaged';
type ViewState = { mode: Mode; ignoreWhitespace: boolean; focus: string | null; focusScope: string };

/** The view both panels share (mode, whitespace, the file Changes asked Diff to show), as Paseo's changes preferences. */
const view = (() => {
  let state: ViewState = { mode: 'uncommitted', ignoreWhitespace: false, focus: null, focusScope: '' };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: Partial<ViewState>) { state = { ...state, ...next }; for (const listener of [...listeners]) listener(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
})();
const useView = () => React.useSyncExternalStore(view.subscribe, view.get, view.get);

/** The file the Diff panel shows (Changes' "Open in Diff"), for the workspace `scope` names only; null for every file. */
function focusDiff(path: string | null, scope = '') { view.set({ focus: path, focusScope: scope }); }

/** How long after the last load a page coming back (focus, visibility) loads again. */
const REFRESH_AFTER_MS = 15_000;

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';
const tool = cn('flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50 [&_svg]:size-4', focusRing);

function Note({ testId, reason, kind, children }: { testId: string; reason?: string; kind: 'changes' | 'diff'; children: React.ReactNode }) {
  const Icon = kind === 'diff' ? GitCompareArrows : FileDiff;
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-2 p-6 text-center" role="note" data-testid={testId} data-reason={reason}>
      <Icon aria-hidden strokeWidth={1.5} className="size-6 text-extra-muted" />
      {children}
    </div>
  );
}

/** The status of the open workspace, loaded when shown and on Refresh; again when the page comes back after a while. */
function useGitStatus(enabled: boolean, scope: string) {
  const controller = useController();
  const [state, setState] = React.useState<{ status?: GitStatus; error?: string; reason?: string; loading: boolean; at: number }>({ loading: false, at: 0 });
  const pass = React.useRef(0);
  const load = React.useCallback(() => {
    const at = ++pass.current;
    setState(current => ({ ...current, loading: true }));
    controller.gitStatus().then(
      status => { if (pass.current === at) setState({ status, loading: false, at: Date.now() }); },
      error => { if (pass.current === at) { const failure = describeGitError(error); setState({ error: failure.message, reason: failure.reason, loading: false, at: Date.now() }); } },
    );
  }, [controller]);
  React.useEffect(() => { if (enabled) load(); else { pass.current++; setState({ loading: false, at: 0 }); } }, [enabled, scope, load]);
  return { ...state, load };
}

/** The diff pages of a comparison: the first on demand, Load more with nextCursor, a changed checkout starting again with a notice. */
function useGitDiff(enabled: boolean, key: string, request: { mode: Mode; baseRef?: string | null; ignoreWhitespace: boolean; path?: string }) {
  const controller = useController();
  const [state, setState] = React.useState<{ diff?: DiffView; error?: string; notice?: string; loading: boolean; more: boolean }>({ loading: false, more: false });
  const pass = React.useRef(0);
  const requestRef = React.useRef(request);
  requestRef.current = request;
  const load = React.useCallback((notice?: string) => {
    const at = ++pass.current;
    const { path, ...compare } = requestRef.current;
    setState(current => ({ ...current, loading: true, error: undefined, notice }));
    controller.gitDiff({ compare, ...(path ? { path } : {}) }).then(
      page => { if (pass.current === at) setState({ diff: appendDiffPage(undefined, page), loading: false, more: false, notice }); },
      error => { if (pass.current === at) setState({ error: describeGitError(error).message, loading: false, more: false, notice }); },
    );
  }, [controller]);
  const more = React.useCallback(() => {
    const cursor = state.diff?.nextCursor;
    if (!cursor || state.more) return;
    const at = pass.current;
    const { path, ...compare } = requestRef.current;
    setState(current => ({ ...current, more: true }));
    controller.gitDiff({ compare, ...(path ? { path } : {}), cursor }).then(
      page => { if (pass.current === at) setState(current => ({ ...current, diff: appendDiffPage(current.diff, page), more: false })); },
      error => {
        if (pass.current !== at) return;
        // The checkout changed (or the cursor is gone): start again from the first page.
        if (restartsDiff(error)) { load(describeGitError(error).reason === 'stale_snapshot' ? GIT_ERROR_MESSAGES.stale_snapshot : GIT_ERROR_MESSAGES.invalid_cursor); return; }
        setState(current => ({ ...current, more: false, error: describeGitError(error).message }));
      },
    );
  }, [controller, state.diff?.nextCursor, state.more, load]);
  React.useEffect(() => { if (enabled) load(); else { pass.current++; setState({ loading: false, more: false }); } }, [enabled, key, load]);
  return { ...state, load, loadMore: more };
}

/** A refresh when the page comes back (focus, visible again) after REFRESH_AFTER_MS; never on a timer. */
function useComeBack(refresh: () => void, lastAt: number, enabled: boolean) {
  const latest = React.useRef({ refresh, lastAt, enabled });
  latest.current = { refresh, lastAt, enabled };
  React.useEffect(() => {
    const back = () => {
      const { refresh: run, lastAt: at, enabled: on } = latest.current;
      if (on && document.visibilityState !== 'hidden' && Date.now() - at > REFRESH_AFTER_MS) run();
    };
    window.addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => { window.removeEventListener('focus', back); document.removeEventListener('visibilitychange', back); };
  }, []);
}

function DiffStat({ additions, deletions, testId }: { additions: number; deletions: number; testId?: string }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs tabular-nums" data-testid={testId}>
      <span className="text-dot-success">+{formatDiffCount(additions)}</span>
      <span className="text-destructive">-{formatDiffCount(deletions)}</span>
    </span>
  );
}

const ROW: Record<string, string> = { add: 'bg-[rgba(46,160,67,0.15)]', remove: 'bg-[rgba(248,81,73,0.15)]', context: '', hunk: 'bg-muted/60 text-muted-foreground' };
const SIGN: Record<string, string> = { add: '+', remove: '-', context: ' ' };

/** One file's hunks, Paseo's unified diff with old and new line numbers; at most LINE_LIMIT rows until asked for more. */
function Hunks({ file }: { file: GitDiffFile }) {
  const rows = React.useMemo(() => diffRows(file), [file]);
  const [limit, setLimit] = React.useState(LINE_LIMIT);
  const { shown, hidden } = clipLines(rows, limit);
  if (file.kind !== 'text') return <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="git-file-kind" data-kind={file.kind}>{KIND_MESSAGES[file.kind]}</p>;
  if (!rows.length && file.change === 'renamed' && file.oldPath) return <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="git-file-rename">Renamed {file.oldPath} → {file.path}</p>;
  if (!rows.length) return <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="git-file-empty">No changes to display</p>;
  const width = String(Math.max(0, ...rows.map(row => ('oldLine' in row ? Math.max(row.oldLine ?? 0, row.newLine ?? 0) : 0)))).length;
  const gutter = (value: number | undefined) => <span aria-hidden className="shrink-0 select-none pr-2 text-right text-muted-foreground tabular-nums" style={{ minWidth: `${width + 1}ch` }}>{value ?? ''}</span>;
  return (
    <div className="overflow-auto bg-card font-mono text-[12px] leading-[18px] text-foreground" data-testid="git-hunks">
      <div className="min-w-max py-1">
        {shown.map((row, index) => row.type === 'hunk' ? (
          <div key={index} className={cn('whitespace-pre px-3', ROW.hunk)} data-diff="hunk">{row.text}</div>
        ) : (
          <div key={index} className={cn('flex whitespace-pre px-3', ROW[row.type])} data-diff={row.type}>
            {gutter(row.oldLine)}{gutter(row.newLine)}
            <span aria-hidden className={cn('w-[2ch] shrink-0 select-none', row.type === 'add' ? 'text-dot-success' : row.type === 'remove' ? 'text-destructive' : 'text-muted-foreground')}>{SIGN[row.type]}</span>
            <span>{row.text || ' '}</span>
            {row.noNewline ? <span className="ml-2 select-none text-muted-foreground" title="No newline at end of file">⏎̸</span> : null}
          </div>
        ))}
      </div>
      {hidden ? (
        <button type="button" data-testid="git-hunks-more" onClick={() => setLimit(value => value + LINE_LIMIT)}
          className="sticky left-0 block px-3 py-1.5 font-sans text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {`Show ${Math.min(hidden, LINE_LIMIT)} more line${Math.min(hidden, LINE_LIMIT) === 1 ? '' : 's'}`}{hidden > LINE_LIMIT ? ` (${hidden} hidden)` : ''}
        </button>
      ) : null}
    </div>
  );
}

/** The change letter of a row, coloured as Paseo's file-change icon. */
function ChangeBadge({ change }: { change: GitStatusFile['change'] }) {
  const tone = change === 'deleted' ? 'text-destructive' : change === 'added' || change === 'untracked' ? 'text-dot-success' : change === 'conflicted' ? 'text-destructive' : 'text-highlight';
  return <span aria-label={CHANGE_LABELS[change]} title={CHANGE_LABELS[change]} className={cn('w-3 shrink-0 text-center font-mono text-[11px] font-semibold', tone)}>{CHANGE_LETTERS[change]}</span>;
}

function FileName({ path, oldPath }: { path: string; oldPath?: string }) {
  const slash = path.lastIndexOf('/');
  return (
    <span className="min-w-0 flex-1 truncate text-[13px]" title={oldPath ? `${oldPath} → ${path}` : path}>
      {oldPath ? <span className="text-muted-foreground">{oldPath} → </span> : null}
      <span className="text-foreground">{slash >= 0 ? path.slice(slash + 1) : path}</span>
      {slash >= 0 ? <span className="ml-1.5 text-xs text-muted-foreground">{path.slice(0, slash)}</span> : null}
    </span>
  );
}

/** A file of the diff: its header (badge, name, +/-), its hunks when open. */
function DiffFileRow({ file, open, onToggle, onOpenDiff }: { file: GitDiffFile; open: boolean; onToggle: () => void; onOpenDiff?: () => void }) {
  return (
    <li className="border-b border-border/60" data-testid="git-file" data-path={file.path} data-kind={file.kind} data-change={file.change}>
      <div className="flex items-center">
        <button type="button" onClick={onToggle} aria-expanded={open}
          className={cn('flex min-w-0 flex-1 items-center gap-1.5 py-1.5 pl-2 pr-1 text-left hover:bg-sidebar-hover', focusRing)} data-testid="git-file-toggle">
          <ChevronRight aria-hidden className={cn('size-3.5 shrink-0 text-extra-muted transition-transform', open && 'rotate-90')} />
          <ChangeBadge change={file.change} />
          <FileName path={file.path} oldPath={file.oldPath} />
          {file.kind === 'text' ? <DiffStat additions={file.additions} deletions={file.deletions} /> : <span className="shrink-0 text-xs text-muted-foreground">{KIND_MESSAGES[file.kind].split(':')[0]}</span>}
        </button>
        {onOpenDiff ? <button type="button" className={cn(tool, 'mr-1')} onClick={onOpenDiff} aria-label={`Open ${file.path} in Diff`} title="Open in Diff" data-testid="git-file-open-diff"><GitCompareArrows aria-hidden /></button> : null}
      </div>
      {open ? <Hunks file={file} /> : null}
    </li>
  );
}

/** A status row (no content): badge, name, staged/unstaged. */
function StatusRow({ file }: { file: GitStatusFile }) {
  return (
    <li className="flex items-center gap-1.5 border-b border-border/60 py-1.5 pl-7 pr-2" data-testid="git-status-file" data-path={file.path} data-change={file.change}>
      <ChangeBadge change={file.change} />
      <FileName path={file.path} oldPath={file.oldPath} />
      <span className="shrink-0 text-[11px] text-muted-foreground">{[file.staged ? 'staged' : '', file.unstaged ? 'unstaged' : ''].filter(Boolean).join(' · ')}</span>
    </li>
  );
}

function Hidden({ count }: { count: number }) {
  if (!count) return null;
  return <p className="flex items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground" data-testid="git-hidden"><Lock aria-hidden className="size-3.5" />{`${count} changed file${count === 1 ? ' is' : 's are'} not shown remotely (secrets, keys, .git or ALP configuration).`}</p>;
}

/** The branch header: branch, upstream, the base a Committed diff compares to, and that Git actions stay on the host. */
function BranchHeader({ status, mode }: { status: GitStatus; mode: Mode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs text-muted-foreground" data-testid="git-branch">
      <GitBranch aria-hidden className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={branchLine(status)}>
        <span className="text-foreground" data-testid="git-branch-name">{branchLine(status)}</span>
        {mode === 'base' ? <span>{` → ${baseLabel(status.baseRef)}`}{status.aheadBehind ? ` (${status.aheadBehind.ahead} ahead, ${status.aheadBehind.behind} behind)` : ''}</span> : null}
      </span>
      <span className="shrink-0" title="Commit, push, pull, merge and branch switching are not available remotely; use Git on the host." data-testid="git-read-only">Read only</span>
    </div>
  );
}

function Toolbar({ mode, setMode, content, ignoreWhitespace, totals, refreshing, onRefresh, testId }: { mode: Mode; setMode: (mode: Mode) => void; content: boolean; ignoreWhitespace: boolean; totals?: { additions: number; deletions: number }; refreshing: boolean; onRefresh: () => void; testId: string }) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1" data-testid={testId}>
      {content ? (
        <select aria-label="Diff mode" value={mode} onChange={event => setMode(event.target.value as Mode)} data-testid="git-mode"
          className={cn('h-7 rounded-md bg-transparent px-1 text-xs text-foreground hover:bg-secondary', focusRing)}>
          {GIT_MODES.map(entry => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      ) : <span className="px-1 text-xs text-muted-foreground">Uncommitted</span>}
      <span className="min-w-0 flex-1" />
      {totals ? <DiffStat additions={totals.additions} deletions={totals.deletions} testId="git-totals" /> : null}
      {content ? (
        <button type="button" className={cn(tool, ignoreWhitespace && 'bg-secondary text-foreground')} onClick={() => view.set({ ignoreWhitespace: !ignoreWhitespace })}
          aria-pressed={ignoreWhitespace} aria-label={ignoreWhitespace ? 'Show whitespace' : 'Hide whitespace'} title={ignoreWhitespace ? 'Show whitespace' : 'Hide whitespace'} data-testid="git-whitespace"><Space aria-hidden /></button>
      ) : null}
      <button type="button" className={tool} onClick={onRefresh} disabled={refreshing} aria-label={refreshing ? 'Refreshing' : 'Refresh'} title={refreshing ? 'Refreshing' : 'Refresh'} data-testid="git-refresh">
        <RefreshCw aria-hidden className={cn(refreshing && 'animate-spin')} />
      </button>
    </div>
  );
}

/**
 * Changes (`variant` changes) and Diff (`variant` diff): the same comparison, Changes with files
 * opened one at a time and "Open in Diff", Diff with every file open, or only the file Changes sent.
 */
function GitPanel({ variant, onOpenDiff }: { variant: 'changes' | 'diff'; onOpenDiff?: () => void }) {
  const controller = useController();
  const app = useAppState();
  const access = controller.gitAccess;
  const shared = useView();
  const online = app.connection.phase === 'open';
  const scope = `${app.connection.gateway}\n${app.workspace ?? ''}\n${access.status ? access.workspaceId : ''}`;
  // A file Changes sent for another workspace (or connection) is not this one's.
  const focus = variant === 'diff' && shared.focusScope === scope ? shared.focus : null;
  const status = useGitStatus(online && access.status, scope);
  const repository = status.status?.state === 'repository';
  const content = access.status && access.content;
  const request = { mode: shared.mode, baseRef: shared.mode === 'base' ? status.status?.baseRef ?? null : null, ignoreWhitespace: shared.ignoreWhitespace, ...(focus ? { path: focus } : {}) };
  // Each status load (Refresh, a page coming back) loads the diff again too.
  const key = `${scope}\n${request.mode}\n${request.baseRef ?? ''}\n${request.ignoreWhitespace}\n${focus ?? ''}\n${status.at}`;
  const diff = useGitDiff(online && !!content && repository, key, request);
  const [open, setOpen] = React.useState<string[]>([]);
  React.useEffect(() => setOpen([]), [scope, shared.mode]);
  const refresh = React.useCallback(() => { status.load(); }, [status.load]);
  useComeBack(refresh, status.at, online && access.status);

  const testId = `${variant}-panel`;
  if (!access.status) {
    return (
      <Note testId={`panel-unavailable-${variant}`} reason={access.reason} kind={variant}>
        {access.reason === 'projectRead' ? <p className="flex max-w-[300px] items-start gap-2 text-sm text-foreground"><Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />{access.message}</p> : <p className="max-w-[300px] text-sm text-muted-foreground">{access.message}</p>}
      </Note>
    );
  }
  const toolbar = (totals?: { additions: number; deletions: number }) => (
    <Toolbar mode={shared.mode} setMode={mode => view.set({ mode })} content={!!content} ignoreWhitespace={shared.ignoreWhitespace} totals={totals}
      refreshing={status.loading || diff.loading} onRefresh={refresh} testId={`${variant}-toolbar`} />
  );
  if (!status.status) {
    return (
      <div className="flex min-h-full flex-col" data-testid={testId}>
        {toolbar()}
        {status.error ? <p className="px-3 py-4 text-sm text-destructive" role="alert" data-testid="git-error">{status.error} <button type="button" className="ml-1 text-highlight hover:underline" onClick={refresh}>Retry</button></p>
          : <p className="px-3 py-4 text-sm text-muted-foreground" data-testid="git-loading">Checking repository...</p>}
      </div>
    );
  }
  if (status.status.state !== 'repository') {
    return (
      <Note testId="changes-not-git" reason={status.status.state} kind={variant}>
        <p className="max-w-[300px] text-sm text-muted-foreground">{status.status.state === 'unsupported' ? 'This workspace is inside a Git repository but is not its top level, so its changes are not shown.' : 'Not a git repository'}</p>
        <button type="button" className="text-xs text-highlight hover:underline" onClick={refresh}>Refresh</button>
      </Note>
    );
  }

  // Without files.read: the status's file list, no content.
  if (!content) {
    const files = status.status.files;
    return (
      <div className="flex min-h-full flex-col" data-testid={testId} data-content="none">
        {toolbar()}
        <BranchHeader status={status.status} mode="uncommitted" />
        <p className="flex items-start gap-1.5 px-3 py-2 text-xs text-muted-foreground" data-testid="git-content-forbidden"><Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />{access.contentMessage}</p>
        {files.length ? <ul aria-label="Changed files">{files.map(file => <StatusRow key={`${file.oldPath ?? ''}\n${file.path}`} file={file} />)}</ul>
          : <p className="px-3 py-4 text-sm text-muted-foreground" data-testid="git-empty">No changes to display</p>}
        <Hidden count={status.status.hiddenCount} />
        {status.status.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="git-truncated">Only the first {files.length} changed files are shown.</p> : null}
      </div>
    );
  }

  const files = diff.diff?.files ?? [];
  const opened = (path: string) => variant === 'diff' || open.includes(path);
  const toggle = (path: string) => setOpen(current => current.includes(path) ? current.filter(entry => entry !== path) : [...current, path]);
  const otherMode: Mode = shared.mode === 'uncommitted' ? 'base' : 'uncommitted';
  return (
    <div className="flex min-h-full flex-col" data-testid={testId} data-content="diff">
      {toolbar(diff.diff ? diffTotals(files) : undefined)}
      <BranchHeader status={status.status} mode={shared.mode} />
      {focus ? (
        <div className="flex items-center gap-2 border-b border-border px-3 py-1 text-xs text-muted-foreground" data-testid="git-focus">
          <span className="min-w-0 flex-1 truncate">{focus}</span>
          <button type="button" className="text-highlight hover:underline" onClick={() => focusDiff(null)} data-testid="git-focus-clear">All files</button>
        </div>
      ) : null}
      {diff.notice ? <p className="px-3 py-2 text-xs text-muted-foreground" role="status" data-testid="git-notice">{diff.notice}</p> : null}
      {diff.error ? <p className="px-3 py-2 text-sm text-destructive" role="alert" data-testid="git-error">{diff.error} <button type="button" className="ml-1 text-highlight hover:underline" onClick={() => diff.load()}>Retry</button></p> : null}
      {diff.loading && !diff.diff ? <p className="px-3 py-4 text-sm text-muted-foreground" data-testid="git-loading">Loading changes…</p> : null}
      {diff.diff && !files.length && !diff.error ? (
        <div className="flex flex-col items-center gap-2 px-3 py-6 text-center" data-testid="git-empty">
          <p className="text-sm text-muted-foreground">No changes to display</p>
          {!focus && !shared.ignoreWhitespace ? <button type="button" className="text-xs text-highlight hover:underline" onClick={() => view.set({ mode: otherMode })} data-testid="changes-empty-switch-mode">{otherMode === 'base' ? 'See committed changes' : 'See uncommitted changes'}</button> : null}
        </div>
      ) : null}
      {files.length ? (
        <ul aria-label={variant === 'diff' ? 'Diff' : 'Changed files'}>
          {files.map(file => (
            <DiffFileRow key={`${file.oldPath ?? ''}\n${file.path}`} file={file} open={opened(file.path)} onToggle={() => toggle(file.path)}
              onOpenDiff={variant === 'changes' && onOpenDiff ? () => { focusDiff(file.path, scope); onOpenDiff(); } : undefined} />
          ))}
        </ul>
      ) : null}
      <Hidden count={diff.diff?.hiddenCount ?? 0} />
      {diff.diff?.nextCursor ? (
        <button type="button" onClick={diff.loadMore} disabled={diff.more} className={cn('mx-3 my-2 self-start rounded-md px-2 py-1 text-xs text-highlight hover:bg-secondary disabled:opacity-60', focusRing)} data-testid="git-load-more">
          {diff.more ? 'Loading…' : 'Load more'}
        </button>
      ) : diff.diff?.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="git-truncated">Only some untracked files are shown: the host limits how many it reads.</p> : null}
    </div>
  );
}

export function ChangesPanel({ onOpenDiff }: { onOpenDiff?: () => void }) {
  return <GitPanel variant="changes" onOpenDiff={onOpenDiff} />;
}

export function DiffPanel() {
  return <GitPanel variant="diff" />;
}
