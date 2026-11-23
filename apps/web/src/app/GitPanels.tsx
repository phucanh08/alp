import * as React from 'react';
import { ChevronDown, ChevronRight, Columns2, Copy, FileDiff, FileText, GitBranch, GitCompareArrows, Lock, Maximize, MessageSquarePlus, MoreHorizontal, Pilcrow, RotateCw, Rows2, Send, Space, SquareDot, SquareMinus, SquarePlus, Trash2 } from 'lucide-react';
import type { GitDiffFile, GitStatus, GitStatusFile } from '@anhlp/alp-protocol';
import { LINE_LIMIT, clipLines } from '../lib/tool-calls.js';
import { CHANGE_LABELS, CHANGE_LETTERS, GIT_ERROR_MESSAGES, GIT_MODES, KIND_MESSAGES, REVIEW_LIMITS, appendDiffPage, baseLabel, branchLine, changeKind, changesEmptyAction, changesTree, committedDescription, describeGitError, diffRows, diffTotals, formatDiffCount, formatReviewComments, loadHideWhitespace, restartsDiff, saveHideWhitespace, splitRows, type DiffView } from '../lib/git.js';
import { fileIconUrl } from '../lib/file-icons.js';
import { ContextMenu, Menu, type MenuItem } from '../components/ui/menu';
import { can } from '../lib/gateway.js';
import { cn } from '../lib/utils';
import { useAppState, useController } from './store';
import { useTabs } from './tabs';

/*
 * Paseo's Changes and Diff panels (packages/app/src/panels/diff-panel.tsx and git/diff-pane.tsx at
 * b63a325), read only, through workspace.git.status and workspace.git.diff (§12.5): the branch
 * header, Uncommitted / Committed (against the base branch), the changed files with their +/-
 * counts, each file's hunks (Changes: opened one by one; Diff: all, or the one file Changes sent it
 * to), Hide whitespace, Refresh (and a refresh when the page comes back after a while; no polling).
 * Binary, too large, withheld, symlink and submodule files say so instead of hunks. A token
 * without files.read sees the status (paths, no content). Commit, push, pull, merge and branch
 * switching are not offered: the note says they stay on the host.
 *
 * t-a35b (Paseo parity batch 4): Unified or Split (side by side) layout, remembered in this
 * browser; and review comments: a comment on any diff line (either layout), kept in this page for
 * the workspace, sent together as one message to the open session's agent (Send to agent), through
 * the composer's path (sendPrompt: the token's session.write and mode limits apply). Nothing is
 * written to the workspace.
 *
 * t-81b0.12 (round 3): Changes in the explorer is Paseo v0.17.3's sidebar presentation ("tree",
 * git/diff-pane.tsx ChangesSurface): a branch row; a comparison row with Paseo's mode menu
 * (Uncommitted, Committed "branch -> base", then the host's Staged and Unstaged), the comparison's
 * +/-, Refresh (RotateCw, a spinner while it runs) and the options menu ("…": Open Diff tab, Inline
 * diff); the changed files as Paseo's tree (git/changed-files-tree.tsx, lib/git.js changesTree):
 * folders first, single-child chains as one row, each folder with its subtree's +/-, a file with
 * its material icon, +/- and Paseo's change icon. A click on a file opens it in Diff. Inline diff
 * (off by default, remembered in this browser) lists the files with their hunks in place, the
 * layout and whitespace toggles in the options menu. Paseo's branch switcher, base picker, pull
 * request link, All changes mode, commits section and every Git write are not offered.
 *
 * t-81b0.14: Hide whitespace is remembered in this browser (`alp.changes.hideWhitespace`), as Paseo's
 * global changes preferences (hooks/use-changes-preferences/storage.ts); the mode is not, as Paseo's
 * comparison is kept in memory (git/working-diff-comparison): a reload starts on Uncommitted.
 */

type Mode = 'uncommitted' | 'base' | 'staged' | 'unstaged';
type Layout = 'unified' | 'split';
type ViewState = { mode: Mode; ignoreWhitespace: boolean; focus: string | null; focusScope: string; layout: Layout; inlineDiff: boolean };

/** Where the layout is remembered (this browser only). */
const LAYOUT_KEY = 'alp.diff.layout';
const savedLayout = (): Layout => { try { return globalThis.localStorage?.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'unified'; } catch { return 'unified'; } };
const saveLayout = (layout: Layout) => { try { globalThis.localStorage?.setItem(LAYOUT_KEY, layout); } catch { /* private mode: this page only */ } };
/** Paseo's Inline diff preference (off by default): Changes lists the files' hunks in place of the tree. */
const INLINE_KEY = 'alp.changes.inlineDiff';
const savedInline = () => { try { return globalThis.localStorage?.getItem(INLINE_KEY) === 'true'; } catch { return false; } };
const saveInline = (inline: boolean) => { try { globalThis.localStorage?.setItem(INLINE_KEY, String(inline)); } catch { /* private mode: this page only */ } };

/** This browser's localStorage, or none where reading it throws (storage disabled for the page). */
const browserStorage = () => { try { return globalThis.localStorage; } catch { return undefined; } };

/** The view both panels share (mode, whitespace, the file Changes asked Diff to show, layout), as Paseo's changes preferences. */
const view = (() => {
  let state: ViewState = { mode: 'uncommitted', ignoreWhitespace: loadHideWhitespace(browserStorage()), focus: null, focusScope: '', layout: savedLayout(), inlineDiff: savedInline() };
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(next: Partial<ViewState>) { state = { ...state, ...next }; for (const listener of [...listeners]) listener(); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
})();
const useView = () => React.useSyncExternalStore(view.subscribe, view.get, view.get);

/** Hide whitespace, remembered in this browser as Paseo's changes preference (lib/git.js). */
function setIgnoreWhitespace(hide: boolean) { saveHideWhitespace(browserStorage(), hide); view.set({ ignoreWhitespace: hide }); }

/** The file the Diff panel shows (Changes' "Open in Diff"), for the workspace `scope` names only; null for every file. */
function focusDiff(path: string | null, scope = '') { view.set({ focus: path, focusScope: scope }); }

/** A review comment on one diff line: the side's numbering (old for a removed line), the line quoted. */
type ReviewComment = { id: string; path: string; side: 'old' | 'new'; line: number; excerpt: string; text: string };
type ReviewDraft = { path: string; side: 'old' | 'new'; line: number; excerpt: string };

/**
 * The review comments of each workspace (by panel scope: connection, workspace, registry id), in
 * this page only, shared by Changes and Diff; one comment being written at a time.
 */
const review = (() => {
  let state: { comments: Record<string, ReviewComment[]>; draft: (ReviewDraft & { scope: string }) | null } = { comments: {}, draft: null };
  const listeners = new Set<() => void>();
  const set = (next: Partial<typeof state>) => { state = { ...state, ...next }; for (const listener of [...listeners]) listener(); };
  let counter = 0;
  return {
    get: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    draft(scope: string, draft: ReviewDraft | null) { set({ draft: draft ? { ...draft, scope } : null }); },
    add(scope: string, comment: Omit<ReviewComment, 'id'>) {
      const list = state.comments[scope] ?? [];
      if (list.length >= REVIEW_LIMITS.maxComments) return false;
      set({ comments: { ...state.comments, [scope]: [...list, { ...comment, id: `c${++counter}` }] }, draft: null });
      return true;
    },
    remove(scope: string, id: string) { set({ comments: { ...state.comments, [scope]: (state.comments[scope] ?? []).filter(comment => comment.id !== id) } }); },
    clear(scope: string, ids?: string[]) { set({ comments: { ...state.comments, [scope]: ids ? (state.comments[scope] ?? []).filter(comment => !ids.includes(comment.id)) : [] } }); },
  };
})();
const useReview = () => React.useSyncExternalStore(review.subscribe, review.get, review.get);

/** What a diff file's rows need to take comments: the panel's scope, whether comments may be written. */
const ReviewContext = React.createContext<{ scope: string; enabled: boolean }>({ scope: '', enabled: false });

/** How long after the last load a page coming back (focus, visibility) loads again. */
const REFRESH_AFTER_MS = 15_000;

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';
const tool = cn('flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-50 [&_svg]:size-4', focusRing);

function Note({ testId, reason, children }: { testId: string; reason?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-2 p-6 text-center" role="note" data-testid={testId} data-reason={reason}>
      <FileDiff aria-hidden strokeWidth={1.5} className="size-6 text-extra-muted" />
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

/** The comment button of a diff line, shown on hover or focus (when comments may be written). */
function CommentButton({ path, side, line, excerpt }: { path: string; side: 'old' | 'new'; line: number; excerpt: string }) {
  const { scope, enabled } = React.useContext(ReviewContext);
  if (!enabled) return null;
  return (
    <button type="button" aria-label={`Comment on ${side === 'old' ? 'removed ' : ''}line ${line}`} title="Add a review comment" data-testid="git-line-comment" data-side={side} data-line={line}
      onClick={() => review.draft(scope, { path, side, line, excerpt })}
      className={cn('absolute left-0.5 top-0 flex size-[1.5em] items-center justify-center rounded text-highlight opacity-0 hover:bg-secondary focus-visible:opacity-100 group-hover/line:opacity-100 [&_svg]:size-3.5', focusRing)}>
      <MessageSquarePlus aria-hidden />
    </button>
  );
}

/** The comments on one line, and the editor when that line's comment is being written. */
function LineComments({ path, side, line }: { path: string; side: 'old' | 'new'; line: number }) {
  const { scope } = React.useContext(ReviewContext);
  const state = useReview();
  const comments = (state.comments[scope] ?? []).filter(comment => comment.path === path && comment.side === side && comment.line === line);
  const draft = state.draft && state.draft.scope === scope && state.draft.path === path && state.draft.side === side && state.draft.line === line ? state.draft : null;
  if (!comments.length && !draft) return null;
  return (
    <div className="sticky left-0 w-[min(100%,40rem)] px-3 py-1 font-sans" data-testid="git-line-comments" data-side={side} data-line={line}>
      {comments.map(comment => <CommentCard key={comment.id} comment={comment} />)}
      {draft ? <CommentEditor draft={draft} /> : null}
    </div>
  );
}

function CommentCard({ comment }: { comment: ReviewComment }) {
  const { scope } = React.useContext(ReviewContext);
  return (
    <div className="mb-1 flex items-start gap-2 rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground" data-testid="git-comment" data-path={comment.path} data-side={comment.side} data-line={comment.line}>
      <p className="min-w-0 flex-1 whitespace-pre-wrap break-words" data-testid="git-comment-text">{comment.text}</p>
      <button type="button" className={cn(tool, 'size-6')} aria-label="Delete comment" title="Delete comment" onClick={() => review.remove(scope, comment.id)} data-testid="git-comment-delete"><Trash2 aria-hidden /></button>
    </div>
  );
}

function CommentEditor({ draft }: { draft: ReviewDraft }) {
  const { scope } = React.useContext(ReviewContext);
  const controller = useController();
  const [text, setText] = React.useState('');
  const field = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => { field.current?.focus({ preventScroll: false }); }, []);
  const add = () => {
    const value = text.trim();
    if (!value) return;
    if (!review.add(scope, { ...draft, text: value.slice(0, REVIEW_LIMITS.maxCommentLength) })) controller.notify('error', `At most ${REVIEW_LIMITS.maxComments} review comments; send or delete some first.`);
  };
  return (
    <div className="mb-1 rounded-md border border-ring bg-background p-1.5" data-testid="git-comment-editor">
      <textarea ref={field} value={text} onChange={event => setText(event.target.value)} rows={3} maxLength={REVIEW_LIMITS.maxCommentLength}
        aria-label={`Comment on ${draft.path} line ${draft.line}`} placeholder="Leave a comment for the agent"
        onKeyDown={event => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); add(); }
          else if (event.key === 'Escape') { event.preventDefault(); review.draft(scope, null); }
        }}
        className="block w-full resize-y rounded bg-transparent p-1 text-xs text-foreground outline-none placeholder:text-muted-foreground" data-testid="git-comment-input" />
      <div className="mt-1 flex justify-end gap-1">
        <button type="button" className="rounded-md px-2 py-0.5 text-xs text-muted-foreground hover:bg-secondary hover:text-foreground" onClick={() => review.draft(scope, null)} data-testid="git-comment-cancel">Cancel</button>
        <button type="button" disabled={!text.trim()} className="rounded-md bg-primary px-2 py-0.5 text-xs text-primary-foreground disabled:opacity-50" onClick={add} data-testid="git-comment-add">Add comment</button>
      </div>
    </div>
  );
}

/** Comments of this file whose line is no longer shown (the diff changed since). */
function OutdatedComments({ path, rows }: { path: string; rows: ReturnType<typeof diffRows> }) {
  const { scope } = React.useContext(ReviewContext);
  const state = useReview();
  const shown = new Set<string>();
  for (const row of rows) {
    if (row.type === 'hunk') continue;
    if (row.type !== 'add' && row.oldLine !== undefined) shown.add(`old:${row.oldLine}`);
    if (row.type !== 'remove' && row.newLine !== undefined) shown.add(`new:${row.newLine}`);
  }
  // A context line's comment is anchored on its new side; a removed line's on its old side.
  const outdated = (state.comments[scope] ?? []).filter(comment => comment.path === path && !shown.has(`${comment.side}:${comment.line}`));
  if (!outdated.length) return null;
  return (
    <div className="px-3 py-1 font-sans text-xs text-muted-foreground" data-testid="git-comments-outdated">
      <p className="mb-1">Comments on lines no longer in this diff (still sent):</p>
      {outdated.map(comment => <CommentCard key={comment.id} comment={comment} />)}
    </div>
  );
}

/** One file's hunks, Paseo's unified or split diff with old and new line numbers; at most LINE_LIMIT rows until asked for more. */
function Hunks({ file, layout }: { file: GitDiffFile; layout: Layout }) {
  const rows = React.useMemo(() => diffRows(file), [file]);
  const [limit, setLimit] = React.useState(LINE_LIMIT);
  const { shown, hidden } = clipLines(rows, limit);
  const pairs = React.useMemo(() => layout === 'split' ? splitRows(shown) : [], [layout, shown]);
  if (file.kind !== 'text') return <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="git-file-kind" data-kind={file.kind}>{KIND_MESSAGES[file.kind]}</p>;
  if (!rows.length && file.change === 'renamed' && file.oldPath) return <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="git-file-rename">Renamed {file.oldPath} → {file.path}</p>;
  if (!rows.length) return <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="git-file-empty">No changes to display</p>;
  const width = String(Math.max(0, ...rows.map(row => ('oldLine' in row ? Math.max(row.oldLine ?? 0, row.newLine ?? 0) : 0)))).length;
  const gutter = (value: number | undefined) => <span aria-hidden className="shrink-0 select-none pr-2 text-right text-muted-foreground tabular-nums" style={{ minWidth: `${width + 1}ch` }}>{value ?? ''}</span>;
  const more = hidden ? (
    <button type="button" data-testid="git-hunks-more" onClick={() => setLimit(value => value + LINE_LIMIT)}
      className="sticky left-0 block px-3 py-1.5 font-sans text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
      {`Show ${Math.min(hidden, LINE_LIMIT)} more line${Math.min(hidden, LINE_LIMIT) === 1 ? '' : 's'}`}{hidden > LINE_LIMIT ? ` (${hidden} hidden)` : ''}
    </button>
  ) : null;
  const outdated = <OutdatedComments path={file.path} rows={shown} />;
  if (layout === 'split') {
    type Cell = { type: 'remove' | 'add' | 'context'; text: string; line: number; noNewline?: boolean } | undefined;
    const cell = (value: Cell, side: 'old' | 'new') => (
      <div className={cn('group/line relative flex min-w-0 whitespace-pre pl-6 pr-3', value ? ROW[value.type] : 'bg-muted/30')} data-diff={value?.type ?? 'empty'} data-side={side}>
        {value ? <>
          {/* A context line is commented once, on its new numbering (the right column). */}
          {value.type !== 'context' || side === 'new' ? <CommentButton path={file.path} side={side} line={value.line} excerpt={value.text} /> : null}
          {gutter(value.line)}
          <span aria-hidden className={cn('w-[2ch] shrink-0 select-none', value.type === 'add' ? 'text-dot-success' : value.type === 'remove' ? 'text-destructive' : 'text-muted-foreground')}>{SIGN[value.type]}</span>
          <span className="min-w-0 overflow-hidden text-ellipsis">{value.text || ' '}</span>
          {value.noNewline ? <span className="ml-2 select-none text-muted-foreground" title="No newline at end of file">⏎̸</span> : null}
        </> : ' '}
      </div>
    );
    return (
      <div className="overflow-auto bg-card font-mono text-(length:--code-font-size) leading-[1.5] text-foreground" data-testid="git-hunks" data-layout="split">
        {outdated}
        <div className="py-1">
          {pairs.map((row, index) => row.type === 'hunk' ? (
            <div key={index} className={cn('whitespace-pre px-3', ROW.hunk)} data-diff="hunk">{row.text}</div>
          ) : (
            <React.Fragment key={index}>
              <div className="grid grid-cols-2 divide-x divide-border/60" data-testid="git-split-row">{cell(row.old, 'old')}{cell(row.new, 'new')}</div>
              {row.old && row.old.type === 'remove' ? <LineComments path={file.path} side="old" line={row.old.line} /> : null}
              {row.new ? <LineComments path={file.path} side="new" line={row.new.line} /> : null}
            </React.Fragment>
          ))}
        </div>
        {more}
      </div>
    );
  }
  return (
    <div className="overflow-auto bg-card font-mono text-(length:--code-font-size) leading-[1.5] text-foreground" data-testid="git-hunks" data-layout="unified">
      {outdated}
      <div className="min-w-max py-1">
        {shown.map((row, index) => {
          if (row.type === 'hunk') return <div key={index} className={cn('whitespace-pre px-3', ROW.hunk)} data-diff="hunk">{row.text}</div>;
          // A removed line is commented on its old numbering; an added or context line on its new one.
          const side = row.type === 'remove' ? 'old' : 'new';
          const line = (side === 'old' ? row.oldLine : row.newLine) as number;
          return (
            <React.Fragment key={index}>
              <div className={cn('group/line relative flex whitespace-pre pl-6 pr-3', ROW[row.type])} data-diff={row.type}>
                <CommentButton path={file.path} side={side} line={line} excerpt={row.text} />
                {gutter(row.oldLine)}{gutter(row.newLine)}
                <span aria-hidden className={cn('w-[2ch] shrink-0 select-none', row.type === 'add' ? 'text-dot-success' : row.type === 'remove' ? 'text-destructive' : 'text-muted-foreground')}>{SIGN[row.type]}</span>
                <span>{row.text || ' '}</span>
                {row.noNewline ? <span className="ml-2 select-none text-muted-foreground" title="No newline at end of file">⏎̸</span> : null}
              </div>
              <LineComments path={file.path} side={side} line={line} />
            </React.Fragment>
          );
        })}
      </div>
      {more}
    </div>
  );
}

/**
 * The review bar: how many comments this workspace's diff holds, Send to agent (one message to
 * the open session, as the composer sends it) and Discard. Sending is refused here, with the
 * reason, when there is no session or the token cannot drive it.
 */
function ReviewBar({ scope, label }: { scope: string; label: string }) {
  const controller = useController();
  const app = useAppState();
  const state = useReview();
  const comments = state.comments[scope] ?? [];
  const [sending, setSending] = React.useState(false);
  if (!comments.length) return null;
  const online = app.connection.phase === 'open';
  // Only a session of this workspace (its session or history list, both read for it): a session of
  // another workspace can be open here (a fork's source), and these comments are not about its files.
  const inWorkspace = !!app.selected && [...app.sessions.list, ...app.history.list].some(session => session.id === app.selected);
  const blocked = !app.selected ? 'Open a session to send the review to its agent.'
    : !inWorkspace ? 'Open a session of this workspace to send the review to its agent.'
    : !online ? 'Not connected.' : controller.driveBlock();
  const send = async () => {
    const ids = comments.map(comment => comment.id);
    setSending(true);
    try {
      await controller.sendPrompt(formatReviewComments(comments, label));
      review.clear(scope, ids);
      controller.notify('info', `Sent ${ids.length} review comment${ids.length === 1 ? '' : 's'} to the agent.`);
    } catch (error) {
      controller.notify('error', error instanceof Error ? error.message : 'Could not send the review.');
    } finally { setSending(false); }
  };
  return (
    <div className="sticky bottom-0 z-[2] mt-auto flex flex-wrap items-center gap-2 border-t border-border bg-background px-3 py-1.5 text-xs" data-testid="git-review-bar">
      <span className="min-w-0 flex-1 text-muted-foreground" data-testid="git-review-count">{`${comments.length} review comment${comments.length === 1 ? '' : 's'}`}{blocked ? <span className="ml-2" data-testid="git-review-blocked">{blocked}</span> : null}</span>
      <button type="button" className="rounded-md px-2 py-1 text-muted-foreground hover:bg-secondary hover:text-foreground" disabled={sending} onClick={() => review.clear(scope)} data-testid="git-review-discard">Discard</button>
      <button type="button" className="flex items-center gap-1 rounded-md bg-primary px-2 py-1 text-primary-foreground disabled:opacity-50" disabled={sending || !!blocked} onClick={() => { void send(); }} data-testid="git-review-send">
        <Send aria-hidden className="size-3.5" />{sending ? 'Sending…' : 'Send to agent'}
      </button>
    </div>
  );
}

/** The change letter of a row, coloured as Paseo's file-change icon. */
function ChangeBadge({ change }: { change: GitStatusFile['change'] }) {
  const tone = change === 'deleted' ? 'text-destructive' : change === 'added' || change === 'untracked' ? 'text-dot-success' : change === 'conflicted' ? 'text-destructive' : 'text-highlight';
  return <span aria-label={CHANGE_LABELS[change]} title={CHANGE_LABELS[change]} className={cn('w-3 shrink-0 text-center font-mono text-[length:calc(11px*var(--ui-scale))] font-semibold', tone)}>{CHANGE_LETTERS[change]}</span>;
}

function FileName({ path, oldPath }: { path: string; oldPath?: string }) {
  const slash = path.lastIndexOf('/');
  return (
    <span className="min-w-0 flex-1 truncate text-[length:calc(13px*var(--ui-scale))]" title={oldPath ? `${oldPath} → ${path}` : path}>
      {oldPath ? <span className="text-muted-foreground">{oldPath} → </span> : null}
      <span className="text-foreground">{slash >= 0 ? path.slice(slash + 1) : path}</span>
      {slash >= 0 ? <span className="ml-1.5 text-xs text-muted-foreground">{path.slice(0, slash)}</span> : null}
    </span>
  );
}

/** A file of the diff: its header (badge, name, +/-), its hunks when open. */
function DiffFileRow({ file, open, layout, onToggle, onOpenDiff }: { file: GitDiffFile; open: boolean; layout: Layout; onToggle: () => void; onOpenDiff?: () => void }) {
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
      {open ? <Hunks file={file} layout={layout} /> : null}
    </li>
  );
}

/** A status row (no content): badge, name, staged/unstaged. */
function StatusRow({ file }: { file: GitStatusFile }) {
  return (
    <li className="flex items-center gap-1.5 border-b border-border/60 py-1.5 pl-7 pr-2" data-testid="git-status-file" data-path={file.path} data-change={file.change}>
      <ChangeBadge change={file.change} />
      <FileName path={file.path} oldPath={file.oldPath} />
      <span className="shrink-0 text-[length:calc(11px*var(--ui-scale))] text-muted-foreground">{[file.staged ? 'staged' : '', file.unstaged ? 'unstaged' : ''].filter(Boolean).join(' · ')}</span>
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

function Toolbar({ mode, setMode, content, ignoreWhitespace, layout, totals, refreshing, onRefresh, testId }: { mode: Mode; setMode: (mode: Mode) => void; content: boolean; ignoreWhitespace: boolean; layout: Layout; totals?: { additions: number; deletions: number }; refreshing: boolean; onRefresh: () => void; testId: string }) {
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
        <button type="button" className={tool} onClick={() => { const next: Layout = layout === 'split' ? 'unified' : 'split'; saveLayout(next); view.set({ layout: next }); }}
          aria-pressed={layout === 'split'} aria-label={layout === 'split' ? 'Unified view' : 'Side-by-side view'} title={layout === 'split' ? 'Unified view' : 'Side-by-side view'} data-testid="git-layout" data-layout={layout}>
          {layout === 'split' ? <Rows2 aria-hidden /> : <Columns2 aria-hidden />}
        </button>
      ) : null}
      {content ? (
        <button type="button" className={cn(tool, ignoreWhitespace && 'bg-secondary text-foreground')} onClick={() => setIgnoreWhitespace(!ignoreWhitespace)}
          aria-pressed={ignoreWhitespace} aria-label={ignoreWhitespace ? 'Show whitespace' : 'Hide whitespace'} title={ignoreWhitespace ? 'Show whitespace' : 'Hide whitespace'} data-testid="git-whitespace"><Space aria-hidden /></button>
      ) : null}
      <button type="button" className={tool} onClick={onRefresh} disabled={refreshing} aria-label={refreshing ? 'Refreshing' : 'Refresh'} title={refreshing ? 'Refreshing' : 'Refresh'} data-testid="git-refresh">
        {refreshing ? <Spinner /> : <RotateCw aria-hidden />}
      </button>
    </div>
  );
}

/** Paseo's LoadingSpinner in a 14px glyph's place. */
function Spinner({ large }: { large?: boolean }) {
  return <span aria-hidden className={cn('block animate-spin rounded-full border-current border-t-transparent text-extra-muted', large ? 'size-6 border-2' : 'size-3.5 border-[1.5px]')} data-testid="git-spinner" />;
}

// Paseo's pane toolbar row (PaneContentToolbar on the sidebar surface): 36px, the sidebar's fill.
const toolbarRow = 'flex h-9 shrink-0 items-center gap-2 border-b border-border bg-sidebar pl-2 pr-1';
// Paseo's ToolbarButton: a 14px glyph, extra-muted, in a larger hit box.
const glyph = cn('flex size-7 items-center justify-center rounded-md text-extra-muted hover:bg-sidebar-hover hover:text-foreground disabled:opacity-60 disabled:hover:bg-transparent [&_svg]:size-3.5', focusRing);
// Paseo's toolbar label trigger: 12px muted text, brighter on hover.
const labelTrigger = cn('flex h-6 min-w-0 items-center gap-1 rounded-md px-1 text-[length:calc(12px*var(--ui-scale))] text-muted-foreground hover:bg-sidebar-hover hover:text-foreground', focusRing);
const centerState = 'flex flex-1 flex-col items-center justify-center gap-2 px-6 pb-6 pt-16 text-center';

/** Paseo's DiffStat: +a -d at 12px in the status colours. */
function TreeStat({ additions, deletions, testId }: { additions: number; deletions: number; testId?: string }) {
  return (
    <span className="flex h-5 shrink-0 items-center gap-1 text-[length:calc(12px*var(--ui-scale))] tabular-nums" data-testid={testId}>
      <span className="text-status-success">+{formatDiffCount(additions)}</span>
      <span className="text-status-danger">-{formatDiffCount(deletions)}</span>
    </span>
  );
}

/** Paseo's FileChangeIcon: a plus, minus or dot square in the success, danger or warning colour. */
function ChangeIcon({ change }: { change: string }) {
  const kind = changeKind(change);
  const Icon = kind === 'added' ? SquarePlus : kind === 'deleted' ? SquareMinus : SquareDot;
  const label = kind === 'added' ? 'New' : kind === 'deleted' ? 'Deleted' : 'Modified';
  return <Icon role="img" aria-label={CHANGE_LABELS[change as keyof typeof CHANGE_LABELS] ?? label} className={cn('size-3.5 shrink-0', kind === 'added' ? 'text-status-success' : kind === 'deleted' ? 'text-status-danger' : 'text-status-warning')} data-testid="git-change-icon" data-kind={kind} />;
}

type TreeFile = { path: string; oldPath?: string; change: string; kind?: GitDiffFile['kind']; additions?: number; deletions?: number };

/**
 * Paseo's changed-files tree (git/changed-files-tree.tsx): a folder row is its chevron, its name
 * (a chain of single-child folders as one) and its subtree's +/-; a file row its material icon,
 * name, +/- and change icon. A click on a file opens it in Diff (`onOpen`); without content
 * (`onOpen` absent) the rows only list. A right click offers what changes nothing on the host.
 */
function ChangedFilesTree({ files, onOpen, onOpenFile, workspace, selected, onSelect }: {
  files: TreeFile[]; onOpen?: (path: string) => void; onOpenFile?: (path: string) => void; workspace: string;
  selected: string | null; onSelect: (path: string) => void;
}) {
  const controller = useController();
  const [collapsed, setCollapsed] = React.useState<string[]>([]);
  const [menu, setMenu] = React.useState<{ path: string; folder: boolean; at: { x: number; y: number } } | null>(null);
  const rows = React.useMemo(() => changesTree(files, collapsed), [files, collapsed]);
  const toggle = (dirPath: string) => setCollapsed(current => current.includes(dirPath) ? current.filter(entry => entry !== dirPath) : [...current, dirPath]);
  const copy = (text: string, what: string) => {
    const done = navigator.clipboard?.writeText(text);
    if (!done) { controller.notify('error', `Could not copy the ${what}.`); return; }
    done.then(() => controller.notify('info', `Copied the ${what}.`), () => controller.notify('error', `Could not copy the ${what}.`));
  };
  const menuItems = (target: NonNullable<typeof menu>): MenuItem[] => {
    const items: MenuItem[] = [];
    if (target.folder) items.push({ id: 'toggle', label: collapsed.includes(target.path) ? 'Expand' : 'Collapse', icon: <ChevronRight aria-hidden />, onSelect: () => toggle(target.path), testId: 'git-menu-toggle' });
    else {
      if (onOpen) items.push({ id: 'diff', label: 'Open diff', icon: <FileDiff aria-hidden />, onSelect: () => onOpen(target.path), testId: 'git-menu-open-diff' });
      const file = files.find(entry => entry.path === target.path);
      if (onOpenFile && file && file.change !== 'deleted') items.push({ id: 'open', label: 'Open file', icon: <FileText aria-hidden />, onSelect: () => onOpenFile(target.path), testId: 'git-menu-open-file' });
    }
    items.push(
      { id: 'copy-path', label: 'Copy path', icon: <Copy aria-hidden />, group: items.length > 0, onSelect: () => copy(`${workspace.replace(/\/+$/, '')}/${target.path}`, 'path'), testId: 'git-menu-copy-path' },
      { id: 'copy-relative', label: 'Copy relative path', icon: <Copy aria-hidden />, onSelect: () => copy(target.path, 'relative path'), testId: 'git-menu-copy-relative' },
    );
    return items;
  };
  const menuKeys = (target: Omit<NonNullable<typeof menu>, 'at'>) => (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      setMenu({ ...target, at: { x: box.left + 24, y: box.bottom } });
    }
  };
  const rowClass = (active: boolean) => cn('group flex w-full min-w-0 items-center gap-2 py-1.5 pr-2 text-left text-[length:calc(14px*var(--ui-scale))] text-foreground', active ? 'bg-sidebar-selected' : 'hover:bg-sidebar-hover', focusRing);
  const nameClass = (active: boolean) => cn('min-w-0 truncate', active ? 'opacity-100' : 'opacity-[0.76] group-hover:opacity-100');
  return (
    <>
      <ul className="pb-8" role="tree" aria-label="Changed files" data-testid="changes-file-tree">
        {rows.map(row => {
          // Paseo's treeRowPaddingLeft: 12px, then 12px a level.
          const indent = { paddingLeft: 12 + row.depth * 12 };
          if (row.kind === 'folder') {
            const open = !collapsed.includes(row.dirPath);
            const active = selected === row.dirPath;
            return (
              <li key={`folder:${row.dirPath}`} role="treeitem" aria-level={row.depth + 1} aria-expanded={open} aria-selected={active || undefined} data-testid="git-folder" data-path={row.dirPath}>
                <button type="button" style={indent} title={row.dirPath} className={rowClass(active)} data-testid="git-folder-toggle"
                  onClick={() => { onSelect(row.dirPath); toggle(row.dirPath); }}
                  onContextMenu={event => { event.preventDefault(); onSelect(row.dirPath); setMenu({ path: row.dirPath, folder: true, at: { x: event.clientX, y: event.clientY } }); }}
                  onKeyDown={menuKeys({ path: row.dirPath, folder: true })}>
                  <span aria-hidden className="flex size-4 shrink-0 items-center justify-center"><ChevronRight className={cn('size-4 text-extra-muted transition-transform', open && 'rotate-90')} /></span>
                  <span className={cn(nameClass(active), 'flex-1')}>{row.name}</span>
                  <TreeStat additions={row.additions} deletions={row.deletions} testId="git-folder-stat" />
                </button>
              </li>
            );
          }
          const { file } = row;
          const active = selected === file.path;
          const counted = file.kind === undefined ? null : file.kind === 'text' ? 'stat' : 'kind';
          const content = (
            <>
              <img aria-hidden src={fileIconUrl(row.name)} alt="" width={16} height={16} draggable={false} className="size-4 shrink-0" />
              <span className={nameClass(active)}>{row.name}</span>
              <span className="min-w-0 flex-1" />
              {counted === 'stat' ? <TreeStat additions={file.additions ?? 0} deletions={file.deletions ?? 0} testId="git-file-stat" />
                : counted === 'kind' ? <span className="shrink-0 text-[length:calc(12px*var(--ui-scale))] text-muted-foreground" data-testid="git-file-kind-label">{KIND_MESSAGES[file.kind as keyof typeof KIND_MESSAGES].split(':')[0]}</span> : null}
              <ChangeIcon change={file.change} />
            </>
          );
          const title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
          const contextMenu = (event: React.MouseEvent) => { event.preventDefault(); onSelect(file.path); setMenu({ path: file.path, folder: false, at: { x: event.clientX, y: event.clientY } }); };
          return (
            <li key={`file:${file.oldPath ?? ''}\n${file.path}`} role="treeitem" aria-level={row.depth + 1} aria-selected={active || undefined}
              data-testid={onOpen ? 'git-file' : 'git-status-file'} data-path={file.path} data-change={file.change} data-kind={file.kind} data-old-path={file.oldPath}>
              {onOpen ? (
                <button type="button" style={indent} title={title} className={rowClass(active)} data-testid="git-file-open"
                  onClick={() => { onSelect(file.path); onOpen(file.path); }} onContextMenu={contextMenu} onKeyDown={menuKeys({ path: file.path, folder: false })}>
                  {content}
                </button>
              ) : (
                <div role="button" aria-label={`${title}, ${CHANGE_LABELS[file.change as keyof typeof CHANGE_LABELS] ?? file.change}`} style={indent} title={title} tabIndex={0} className={cn(rowClass(active), 'cursor-default')} onClick={() => onSelect(file.path)} onContextMenu={contextMenu} onKeyDown={menuKeys({ path: file.path, folder: false })}>
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <ContextMenu label="Change actions" at={menu?.at ?? null} items={menu ? menuItems(menu) : []} onClose={() => setMenu(null)} testId="git-context-menu" />
    </>
  );
}

/**
 * Paseo's Changes header (git/diff-pane.tsx ChangesHeader, the sidebar's "tree" presentation):
 * the repository row (the current branch; Paseo's switcher, base picker and pull request link
 * are writes or forge features ALP does not offer, so the branch is a label) and the comparison
 * row (the mode menu, the comparison's +/-, Refresh and the options menu).
 */
function ChangesHeader({ status, mode, content, totals, refreshing, onRefresh, inline, layout, ignoreWhitespace, onOpenDiff }: {
  status: GitStatus | undefined; mode: Mode; content: boolean; totals?: { additions: number; deletions: number }; refreshing: boolean; onRefresh: () => void;
  inline: boolean; layout: Layout; ignoreWhitespace: boolean; onOpenDiff?: () => void;
}) {
  const label = GIT_MODES.find(entry => entry.id === mode)?.label ?? mode;
  const description = committedDescription(status?.branch, status?.baseRef);
  const modeItems: MenuItem[] = [
    { id: 'uncommitted', label: 'Uncommitted', checked: mode === 'uncommitted', onSelect: () => view.set({ mode: 'uncommitted' }), testId: 'changes-diff-mode-uncommitted' },
    { id: 'base', label: 'Committed', checked: mode === 'base', group: true, value: description, title: description, onSelect: () => view.set({ mode: 'base' }), testId: 'changes-diff-mode-committed' },
    // The host's two more comparisons (ALP's; Paseo has none).
    { id: 'staged', label: 'Staged', checked: mode === 'staged', group: true, onSelect: () => view.set({ mode: 'staged' }), testId: 'changes-diff-mode-staged' },
    { id: 'unstaged', label: 'Unstaged', checked: mode === 'unstaged', onSelect: () => view.set({ mode: 'unstaged' }), testId: 'changes-diff-mode-unstaged' },
  ];
  const toggleInline = () => { saveInline(!inline); view.set({ inlineDiff: !inline }); };
  const options: MenuItem[] = inline ? [
    { id: 'layout', label: 'Split', icon: <Columns2 aria-hidden />, checked: layout === 'split', keepOpen: true, testId: 'git-layout',
      onSelect: () => { const next: Layout = layout === 'split' ? 'unified' : 'split'; saveLayout(next); view.set({ layout: next }); } },
    { id: 'whitespace', label: ignoreWhitespace ? 'Show whitespace' : 'Hide whitespace', icon: <Pilcrow aria-hidden />, checked: ignoreWhitespace, keepOpen: true, testId: 'git-whitespace',
      onSelect: () => setIgnoreWhitespace(!ignoreWhitespace) },
    { id: 'inline', label: 'Inline diff', checked: true, keepOpen: true, group: true, onSelect: toggleInline, testId: 'changes-toggle-inline-diff' },
  ] : [
    ...(onOpenDiff ? [{ id: 'open-tab', label: 'Open Diff tab', icon: <Maximize aria-hidden />, onSelect: onOpenDiff, testId: 'changes-open-tab' }] : []),
    { id: 'inline', label: 'Inline diff', checked: false, keepOpen: true, group: !!onOpenDiff, onSelect: toggleInline, testId: 'changes-toggle-inline-diff' },
  ];
  const branch = status?.state === 'repository' ? branchLine(status) : null;
  return (
    <div className="shrink-0">
      {status?.state === 'repository' ? (
        <div className={toolbarRow} data-testid="changes-repository-header">
          <span className="flex min-w-0 flex-1 items-center" data-testid="git-branch">
            <span className="min-w-0 truncate px-1 text-[length:calc(12px*var(--ui-scale))] text-muted-foreground"
              title={`${branch}. Switching branches, commit, push and pull stay on the host.`} data-testid="git-branch-name">{status.branch ?? branch}</span>
          </span>
        </div>
      ) : null}
      <div className={toolbarRow} data-testid="changes-header">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          {content ? (
            <Menu label="Diff mode" title="Diff mode" align="start" width={260} testId="git-mode" items={modeItems}
              trigger={<><span className="min-w-0 truncate" data-testid="git-mode-label">{label}</span><ChevronDown aria-hidden className="size-3 shrink-0 text-extra-muted" /></>}
              triggerClassName={labelTrigger} />
          ) : <span className="px-1 text-[length:calc(12px*var(--ui-scale))] text-muted-foreground">Uncommitted</span>}
          {totals ? <TreeStat additions={totals.additions} deletions={totals.deletions} testId="git-totals" /> : null}
        </div>
        <div className="flex shrink-0 items-center gap-px">
          <button type="button" className={glyph} onClick={onRefresh} disabled={refreshing} aria-busy={refreshing || undefined} aria-label={refreshing ? 'Refreshing' : 'Refresh'} title={refreshing ? 'Refreshing' : 'Refresh'} data-testid="git-refresh">
            {refreshing ? <Spinner /> : <RotateCw aria-hidden />}
          </button>
          {content ? <Menu label="Diff options" align="end" width={240} testId="changes-options-menu" items={options} trigger={<MoreHorizontal aria-hidden />} triggerClassName={glyph} /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Changes (`variant` changes) and Diff (`variant` diff): the same comparison, Changes with files
 * opened one at a time and "Open in Diff", Diff with every file open, or only the file Changes sent.
 */
function GitPanel({ variant, onOpenDiff, onPicked }: { variant: 'changes' | 'diff'; onOpenDiff?: (change?: boolean) => void; onPicked?: () => void }) {
  const controller = useController();
  const app = useAppState();
  const { openFile } = useTabs();
  // The tree's selected row (Paseo's selectedPath), this panel only.
  const [selected, setSelected] = React.useState<string | null>(null);
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
  React.useEffect(() => { setOpen([]); setSelected(null); }, [scope, shared.mode]);
  const refresh = React.useCallback(() => { status.load(); }, [status.load]);
  useComeBack(refresh, status.at, online && access.status);

  const testId = `${variant}-panel`;
  const toggle = (path: string) => setOpen(current => current.includes(path) ? current.filter(entry => entry !== path) : [...current, path]);
  if (!access.status) {
    return (
      <Note testId={`panel-unavailable-${variant}`} reason={access.reason}>
        {access.reason === 'projectRead' ? <p className="flex max-w-[300px] items-start gap-2 text-sm text-foreground"><Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />{access.message}</p> : <p className="max-w-[300px] text-sm text-muted-foreground">{access.message}</p>}
      </Note>
    );
  }
  if (variant === 'changes') {
    const current = status.status;
    const inline = shared.inlineDiff && !!content;
    const files = diff.diff?.files ?? [];
    const otherMode = changesEmptyAction({ mode: shared.mode, ignoreWhitespace: shared.ignoreWhitespace, status: current });
    const modeLabel = GIT_MODES.find(entry => entry.id === shared.mode)?.label ?? shared.mode;
    const reviewLabel = shared.mode === 'base' && current ? `${modeLabel}, against ${baseLabel(current.baseRef)}` : modeLabel;
    const commenting = can(app.principal ?? undefined, 'session.write');
    // A change clicked (Open location's "Clicking a change"); Open Diff tab is not one.
    const openDiff = (path: string) => { focusDiff(path, scope); onOpenDiff?.(true); };
    const retry = (run: () => void) => <button type="button" className="text-xs text-highlight hover:underline" onClick={run}>Retry</button>;
    let body: React.ReactNode;
    if (!current) {
      body = status.error
        ? <div className={centerState} role="alert" data-testid="git-error"><p className="text-sm text-destructive">{status.error}</p>{retry(refresh)}</div>
        : <div className={centerState} role="progressbar" aria-label="Loading" data-testid="git-loading"><Spinner large /><p className="text-sm text-muted-foreground">Checking repository...</p></div>;
    } else if (current.state !== 'repository') {
      body = (
        <div className={centerState} data-testid="changes-not-git" data-reason={current.state}>
          <p className="max-w-[300px] text-sm text-muted-foreground">{current.state === 'unsupported' ? 'This workspace is inside a Git repository but is not its top level, so its changes are not shown.' : 'Not a git repository'}</p>
          <button type="button" className="text-xs text-highlight hover:underline" onClick={refresh}>Refresh</button>
        </div>
      );
    } else if (!content) {
      // Without files.read: the status's files as the tree, no counts, nothing to open.
      body = (
        <>
          <p className="flex items-start gap-1.5 px-3 py-2 text-xs text-muted-foreground" data-testid="git-content-forbidden"><Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />{access.contentMessage}</p>
          {current.files.length ? <ChangedFilesTree key={scope} files={current.files} workspace={app.workspace ?? ''} selected={selected} onSelect={setSelected} />
            : <div className={centerState} data-testid="git-empty"><p className="text-sm text-muted-foreground">No changes to display</p></div>}
          <Hidden count={current.hiddenCount} />
          {current.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="git-truncated">Only the first {current.files.length} changed files are shown.</p> : null}
        </>
      );
    } else if (diff.loading && !diff.diff) {
      body = <div className={centerState} role="progressbar" aria-label="Loading" data-testid="git-loading"><Spinner large /></div>;
    } else if (diff.error && !files.length) {
      body = <div className={centerState} role="alert" data-testid="git-error"><p className="text-sm text-destructive">{diff.error}</p>{retry(() => diff.load())}</div>;
    } else if (diff.diff && !files.length) {
      body = (
        <div className={centerState} data-testid="git-empty">
          <p className="text-sm text-muted-foreground">No changes to display</p>
          {otherMode ? <button type="button" className={cn('rounded-md px-2 py-1 text-xs text-foreground hover:bg-sidebar-hover', focusRing)} onClick={() => view.set({ mode: otherMode })} data-testid="changes-empty-switch-mode">{otherMode === 'base' ? 'See committed changes' : 'See uncommitted changes'}</button> : null}
        </div>
      );
    } else {
      body = (
        <>
          {diff.notice ? <p className="px-3 py-2 text-xs text-muted-foreground" role="status" data-testid="git-notice">{diff.notice}</p> : null}
          {diff.error ? <p className="px-3 py-2 text-sm text-destructive" role="alert" data-testid="git-error">{diff.error} {retry(() => diff.load())}</p> : null}
          {inline ? (
            <ul aria-label="Changed files">
              {files.map(file => <DiffFileRow key={`${file.oldPath ?? ''}\n${file.path}`} file={file} open={open.includes(file.path)} layout={shared.layout} onToggle={() => toggle(file.path)} onOpenDiff={onOpenDiff ? () => openDiff(file.path) : undefined} />)}
            </ul>
          ) : <ChangedFilesTree key={scope} files={files} onOpen={openDiff} onOpenFile={path => { openFile(path); onPicked?.(); }} workspace={app.workspace ?? ''} selected={selected} onSelect={setSelected} />}
          <Hidden count={diff.diff?.hiddenCount ?? 0} />
          {diff.diff?.nextCursor ? (
            <button type="button" onClick={diff.loadMore} disabled={diff.more} className={cn('mx-3 my-2 self-start rounded-md px-2 py-1 text-xs text-highlight hover:bg-secondary disabled:opacity-60', focusRing)} data-testid="git-load-more">
              {diff.more ? 'Loading…' : 'Load more'}
            </button>
          ) : diff.diff?.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="git-truncated">Only some untracked files are shown: the host limits how many it reads.</p> : null}
        </>
      );
    }
    return (
      <ReviewContext.Provider value={{ scope, enabled: commenting }}>
        <div className="flex min-h-full flex-col" data-testid={testId} data-content={content ? 'diff' : 'none'} data-presentation={inline ? 'inline' : 'tree'}>
          {current?.state === 'repository' ? (
            <ChangesHeader status={current} mode={content ? shared.mode : 'uncommitted'} content={!!content}
              // Paseo's selected diff stat: the comparison's totals once it has loaded.
              totals={content && diff.diff && !diff.loading ? diffTotals(files) : undefined}
              refreshing={status.loading || diff.loading} onRefresh={refresh} inline={inline} layout={shared.layout} ignoreWhitespace={shared.ignoreWhitespace}
              onOpenDiff={onOpenDiff ? () => { focusDiff(null); onOpenDiff(); } : undefined} />
          ) : null}
          {body}
          <ReviewBar scope={scope} label={reviewLabel} />
        </div>
      </ReviewContext.Provider>
    );
  }
  const toolbar = (totals?: { additions: number; deletions: number }) => (
    <Toolbar mode={shared.mode} setMode={mode => view.set({ mode })} content={!!content} ignoreWhitespace={shared.ignoreWhitespace} layout={shared.layout} totals={totals}
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
      <Note testId="changes-not-git" reason={status.status.state}>
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
  const otherMode: Mode = shared.mode === 'uncommitted' ? 'base' : 'uncommitted';
  const modeLabel = GIT_MODES.find(entry => entry.id === shared.mode)?.label ?? shared.mode;
  const reviewLabel = shared.mode === 'base' ? `${modeLabel}, against ${baseLabel(status.status.baseRef)}` : modeLabel;
  // Comments may be written with a diff shown and a token that can send messages at all.
  const commenting = can(app.principal ?? undefined, 'session.write');
  return (
    <ReviewContext.Provider value={{ scope, enabled: commenting }}>
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
            <DiffFileRow key={`${file.oldPath ?? ''}\n${file.path}`} file={file} open={opened(file.path)} layout={shared.layout} onToggle={() => toggle(file.path)} />
          ))}
        </ul>
      ) : null}
      <Hidden count={diff.diff?.hiddenCount ?? 0} />
      {diff.diff?.nextCursor ? (
        <button type="button" onClick={diff.loadMore} disabled={diff.more} className={cn('mx-3 my-2 self-start rounded-md px-2 py-1 text-xs text-highlight hover:bg-secondary disabled:opacity-60', focusRing)} data-testid="git-load-more">
          {diff.more ? 'Loading…' : 'Load more'}
        </button>
      ) : diff.diff?.truncated ? <p className="px-3 py-2 text-xs text-muted-foreground" data-testid="git-truncated">Only some untracked files are shown: the host limits how many it reads.</p> : null}
      <ReviewBar scope={scope} label={reviewLabel} />
    </div>
    </ReviewContext.Provider>
  );
}

export function ChangesPanel({ onOpenDiff, onPicked }: { onOpenDiff?: (change?: boolean) => void; onPicked?: () => void }) {
  return <GitPanel variant="changes" onOpenDiff={onOpenDiff} onPicked={onPicked} />;
}

export function DiffPanel() {
  return <GitPanel variant="diff" />;
}
