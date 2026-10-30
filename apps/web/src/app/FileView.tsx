import * as React from 'react';
import { Copy, Eye, FileCode, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { FileAccessError, type Failure } from '../lib/errors.js';
import { formatSize, isMarkdown, lineCount } from '../lib/file-tree.js';
import { cn } from '../lib/utils';
import { RichText } from './RichText';
import { useController } from './store';
import { useTabs } from './tabs';

/*
 * Paseo's file pane (file-pane/pane.tsx at b63a325), read-only: one workspace file in a tab, read
 * through workspace.files.read (files.read). A header with the path, Copy path, size and line count;
 * the text in monospace with a line-number gutter, scrolled to the line a link asked for; Markdown
 * shows a Preview (RichText) or its Source. Binary and too-large files say so, as Paseo's. An
 * ignored file is hidden by default: "Show anyway" reads it with includeIgnored.
 *
 * Markdown over PREVIEW_MAX_BYTES shows its source only.
 *
 * Deviations: no syntax highlighting (no highlighter in this app), no edit, no image or HTML
 * preview, no live watch; it reads again when the tab comes back to the front, or with Refresh.
 */

const LINE_HEIGHT = 20;
/** Markdown larger than this shows its source only: the preview parses every line on the main thread. */
const PREVIEW_MAX_BYTES = 200 * 1024;

type Read = { status: 'loading' } | { status: 'ready'; content: string; size: number; modifiedAt?: string } | { status: 'error'; failure: Failure };

const failureOf = (error: unknown): Failure => error instanceof FileAccessError ? error.failure : { message: error instanceof Error ? error.message : 'Something went wrong.', sent: 'unknown', terminal: false };

export function FileView({ path }: { path: string }) {
  const controller = useController();
  const { fileTarget } = useTabs();
  const target = fileTarget(path);
  const [read, setRead] = React.useState<Read>({ status: 'loading' });
  const [includeIgnored, setIncludeIgnored] = React.useState(false);
  const [mode, setMode] = React.useState<'preview' | 'source'>(() => target?.line ? 'source' : 'preview');
  const [copied, setCopied] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const scroller = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let live = true;
    setRead(current => current.status === 'ready' ? current : { status: 'loading' });
    controller.readWorkspaceFile({ path, includeIgnored }).then(
      result => { if (live) setRead({ status: 'ready', content: result.content, size: result.size, ...(result.modifiedAt ? { modifiedAt: result.modifiedAt } : {}) }); },
      error => { if (live) setRead({ status: 'error', failure: failureOf(error) }); },
    );
    return () => { live = false; };
  }, [controller, path, includeIgnored, attempt]);

  // A link to a line shows the source there (also when the tab was already open).
  React.useEffect(() => { if (target?.line) setMode('source'); }, [target?.nonce, target?.line]);
  const markdown = isMarkdown(path) && (read.status !== 'ready' || read.size <= PREVIEW_MAX_BYTES);
  const showSource = !markdown || mode === 'source';
  const ready = read.status === 'ready';
  React.useEffect(() => {
    if (!ready || !showSource || !target?.line || !scroller.current) return;
    scroller.current.scrollTop = Math.max(0, (target.line - 1) * LINE_HEIGHT - 3 * LINE_HEIGHT);
  }, [ready, showSource, target?.line, target?.nonce]);

  const copy = () => {
    void navigator.clipboard?.writeText(path).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }, () => controller.notify('error', `Could not copy ${path}.`));
  };
  const refresh = () => setAttempt(value => value + 1);

  const lines = read.status === 'ready' ? lineCount(read.content) : 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="file-view" data-path={path}>
      <div className="flex min-h-11 shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground" title={path} data-testid="file-view-path">{path}</span>
        {read.status === 'ready' ? (
          <span data-testid="file-view-meta">{formatSize(read.size)} · {lines} {lines === 1 ? 'line' : 'lines'}</span>
        ) : null}
        {markdown && read.status === 'ready' ? (
          <span className="flex rounded-md border border-border p-0.5" role="group" aria-label="View">
            <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')} className={cn('flex items-center gap-1 rounded px-2 py-0.5', mode === 'preview' ? 'bg-secondary text-foreground' : 'hover:text-foreground')}><Eye aria-hidden className="size-3.5" />Preview</button>
            <button type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')} className={cn('flex items-center gap-1 rounded px-2 py-0.5', mode === 'source' ? 'bg-secondary text-foreground' : 'hover:text-foreground')}><FileCode aria-hidden className="size-3.5" />Source</button>
          </span>
        ) : null}
        <Button size="icon-sm" variant="ghost" onClick={copy} aria-label="Copy path" title={copied ? 'Copied' : 'Copy path'} data-testid="file-view-copy-path"><Copy aria-hidden /></Button>
        <Button size="icon-sm" variant="ghost" onClick={refresh} aria-label="Refresh" title="Refresh" data-testid="file-view-refresh"><RefreshCw aria-hidden /></Button>
      </div>
      {read.status === 'loading' ? (
        <div className="flex flex-1 items-center justify-center" data-testid="file-view-loading"><Spinner label="Reading the file…" /></div>
      ) : read.status === 'error' ? (
        <FileError failure={read.failure} onRetry={refresh} onShowIgnored={() => setIncludeIgnored(true)} />
      ) : !showSource ? (
        <div className="min-h-0 flex-1 overflow-y-auto" data-testid="file-view-preview">
          <article className="mx-auto w-full max-w-(--content-width) px-4 py-6 sm:px-6"><RichText text={read.content} /></article>
        </div>
      ) : (
        <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto" data-testid="file-view-source">
          <div className="relative flex min-w-max font-mono text-[12px]" style={{ lineHeight: `${LINE_HEIGHT}px` }}>
            {target?.line && target.line <= lines ? (
              <div aria-hidden className="pointer-events-none absolute inset-x-0 bg-highlight/10" style={{ top: 8 + (target.line - 1) * LINE_HEIGHT, height: LINE_HEIGHT }} data-testid="file-view-target-line" />
            ) : null}
            <pre aria-hidden className="sticky left-0 z-[1] select-none border-r border-border bg-background py-2 pl-3 pr-3 text-right text-extra-muted" data-testid="file-view-gutter">
              {Array.from({ length: Math.max(lines, 1) }, (_, index) => index + 1).join('\n')}
            </pre>
            <pre className="relative py-2 pl-4 pr-6 text-foreground" data-testid="file-view-content">{read.content}</pre>
          </div>
        </div>
      )}
    </div>
  );
}

/** Why the file cannot be shown: Paseo's binary and too-large states; otherwise the reason and Retry. */
function FileError({ failure, onRetry, onShowIgnored }: { failure: Failure; onRetry: () => void; onShowIgnored: () => void }) {
  const finalState = failure.reason === 'binary' || failure.reason === 'too_large' || failure.reason === 'blocked_path' || failure.reason === 'grant' || failure.reason === 'capability';
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center" data-testid="file-view-error" data-reason={failure.reason ?? ''}>
      <p className="max-w-sm text-sm text-muted-foreground" role={finalState ? 'note' : 'alert'}>{failure.message}</p>
      {failure.reason === 'too_large' ? <p className="text-xs text-extra-muted">Files over 1 MB are not read remotely.</p> : null}
      {failure.reason === 'ignored' ? (
        <Button size="sm" variant="secondary" onClick={onShowIgnored} data-testid="file-view-show-ignored">Show anyway</Button>
      ) : !finalState ? (
        <Button size="sm" variant="outline" onClick={onRetry} data-testid="file-view-retry">Retry</Button>
      ) : null}
    </div>
  );
}
