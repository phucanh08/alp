import * as React from 'react';
import { AlertTriangle, Ban, ChevronRight, CircleAlert, Info, ListTodo, LoaderCircle, RotateCcw, Terminal, Trash2, Wrench, X } from 'lucide-react';
import type { Entry } from '../lib/timeline.js';
import type { PendingPrompt } from '../lib/controller.js';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { clockTime } from '../lib/format';
import { cn } from '../lib/utils';
import { RichText } from './RichText';

/** A tool call as Paseo shows one: a quiet row (icon, kind, what it ran) that opens into its detail. */
function ToolCall({ item }: { item: any }) {
  const [open, setOpen] = React.useState(false);
  const shell = item.detail?.type === 'shell';
  const kind = shell ? 'Shell' : item.name === 'alp_delegate' ? 'Delegate' : String(item.name ?? 'Tool').replace(/^alp_/, '');
  const what = shell ? item.detail.command : item.name === 'alp_delegate' ? `to ${item.detail?.input?.agent ?? 'an agent'}` : '';
  const output = shell ? String(item.detail.output ?? '') : item.detail?.output == null ? '' : typeof item.detail.output === 'string' ? item.detail.output : JSON.stringify(item.detail.output, null, 2);
  const input = !shell && item.detail?.input !== undefined ? JSON.stringify(item.detail.input, null, 2) : '';
  const status = item.status as 'running' | 'completed' | 'failed';
  const detailId = React.useId();
  return (
    <div className="-mx-2" data-testid="tool-call">
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls={detailId}
        className={cn('flex w-full min-w-0 items-center gap-1 rounded-lg border border-transparent px-2 py-1 text-left text-sm hover:bg-accent/60', open && 'rounded-b-none border-border bg-card')}>
        <span aria-hidden className="flex size-[22px] shrink-0 items-center justify-center">
          {status === 'running' ? <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" /> : status === 'failed' ? <X className="size-3.5 text-destructive" /> : shell ? <Terminal className="size-3.5 text-muted-foreground" /> : <Wrench className="size-3.5 text-muted-foreground" />}
        </span>
        <span className={cn('shrink-0', status === 'running' ? 'text-foreground/75' : 'text-muted-foreground')}>{kind}</span>
        {what ? <span className={cn('ml-2 min-w-0 flex-1 truncate text-muted-foreground', shell && 'font-mono text-[12.5px]')}>{what}</span> : <span className="flex-1" />}
        {status === 'completed' && shell && item.detail.exitCode != null ? <span className="ml-2 shrink-0 text-xs text-muted-foreground">exit {item.detail.exitCode}</span> : null}
        {status === 'failed' ? <span className="ml-2 shrink-0 text-xs text-destructive">{item.error ?? 'failed'}</span> : null}
        <ChevronRight aria-hidden className={cn('ml-1 size-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>
      {open ? (
        <div id={detailId} className="space-y-2 rounded-b-lg border border-t-0 border-border bg-background/60 p-2.5">
          {input ? <pre className="max-h-48 overflow-auto font-mono text-xs text-muted-foreground">{input}</pre> : null}
          {output ? <pre className="max-h-72 overflow-auto whitespace-pre-wrap font-mono text-xs text-foreground/90">{output}</pre> : <p className="text-xs text-muted-foreground">{status === 'running' ? 'Running…' : 'No output.'}</p>}
        </div>
      ) : null}
    </div>
  );
}

function Todo({ item }: { item: any }) {
  return (
    <div className="rounded-lg border border-border bg-card/60 px-3 py-2.5">
      <p className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground"><ListTodo aria-hidden className="size-3.5" /> Tasks in this conversation</p>
      <ul className="space-y-1 text-[13px]">
        {(item.items ?? []).map((task: any) => (
          <li key={task.id} className="flex items-start gap-2">
            <span aria-hidden className={cn('mt-1.5 size-2 shrink-0 rounded-full', task.status === 'completed' ? 'bg-highlight' : task.status === 'in_progress' ? 'bg-warning' : 'bg-muted-foreground/50')} />
            <span className={cn(task.status === 'completed' && 'text-muted-foreground line-through')}>{task.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Line({ icon, tone, children }: { icon: React.ReactNode; tone: 'info' | 'warning' | 'error' | 'muted'; children: React.ReactNode }) {
  return (
    <div className={cn('flex items-start gap-2 rounded-md px-3 py-1.5 text-[13px]',
      tone === 'error' ? 'bg-destructive/10 text-destructive' : tone === 'warning' ? 'bg-warning/10 text-warning' : tone === 'info' ? 'bg-info/10 text-info' : 'text-muted-foreground')}>
      <span aria-hidden className="mt-0.5 shrink-0 [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0 break-words">{children}</span>
    </div>
  );
}

function EntryView({ entry, agent }: { entry: Entry; agent: string }) {
  const item = entry.item as any;
  switch (item.kind) {
    case 'user_message':
      return (
        <div className="flex justify-end">
          <div className="min-w-0 max-w-[85%] rounded-2xl rounded-tr-sm bg-bubble px-4 py-3 text-[15px] leading-[1.4] whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="user-message">{item.text}</div>
        </div>
      );
    case 'assistant_message':
      return (
        <div className="py-1" data-testid="assistant-message">
          <RichText text={item.text} />
          <p className="mt-1.5 text-[11px] text-muted-foreground/80">{agent}<span className="ml-2">{clockTime(entry.ts)}</span></p>
        </div>
      );
    case 'tool_call':
      return <ToolCall item={item} />;
    case 'todo':
      return <Todo item={item} />;
    case 'notice':
      return <Line icon={item.level === 'error' ? <CircleAlert /> : item.level === 'warning' ? <AlertTriangle /> : <Info />} tone={item.level === 'error' ? 'error' : item.level === 'warning' ? 'warning' : 'info'}>{item.text}</Line>;
    case 'compaction':
      return <Line icon={<Info />} tone="muted">{item.status === 'running' ? 'Compacting the conversation context…' : item.status === 'failed' ? 'Compacting the context failed.' : 'Conversation context compacted.'}</Line>;
    case 'turn_end':
      return <Line icon={item.state === 'canceled' ? <Ban /> : <CircleAlert />} tone={item.state === 'canceled' ? 'muted' : 'error'}>{item.state === 'canceled' ? 'Stopped.' : `The turn failed${item.error ? `: ${item.error}` : '.'}`}</Line>;
    case 'session_event':
      return <Line icon={<CircleAlert />} tone={item.level === 'error' ? 'error' : 'info'}>{item.text}</Line>;
    default:
      return null;
  }
}

function PendingView({ prompt, onRetry, onDiscard }: { prompt: PendingPrompt; onRetry: () => void; onDiscard: () => void }) {
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="pending-message">
      <div className={cn('max-w-[85%] rounded-2xl rounded-tr-sm px-4 py-3 text-[15px] leading-[1.4] whitespace-pre-wrap [overflow-wrap:anywhere]',
        prompt.status === 'sending' ? 'bg-bubble/70 text-foreground/80' : prompt.status === 'failed' ? 'border border-destructive/40 bg-destructive/5' : 'border border-warning/40 bg-warning/5')}>
        {prompt.text}
      </div>
      {prompt.status === 'sending' ? (
        <Spinner className="text-xs" label={prompt.accepted ? 'Delivered' : 'Sending…'} />
      ) : (
        <div className="flex max-w-[85%] flex-wrap items-center justify-end gap-2 text-xs" role="alert">
          <span className={prompt.status === 'failed' ? 'text-destructive' : 'text-warning'}>
            {prompt.status === 'failed' ? (prompt.error ?? 'Not sent.') : `${prompt.error ?? 'Not confirmed.'}${prompt.retrySameId ? ' Sending it again is safe: the host ignores a repeat.' : ''}`}
          </span>
          <Button size="sm" variant="secondary" onClick={onRetry}><RotateCcw aria-hidden /> {prompt.status === 'failed' ? 'Retry' : 'Send again'}</Button>
          <Button size="sm" variant="ghost" onClick={onDiscard}><Trash2 aria-hidden /> Discard</Button>
        </div>
      )}
    </div>
  );
}

export function Timeline({ entries, prompts, agentOf, running, runningAgent, historyUnavailable, onRetry, onDiscard, emptyText }: {
  entries: Entry[];
  prompts: PendingPrompt[];
  agentOf: (sessionId: string) => string;
  running: boolean;
  runningAgent: string;
  historyUnavailable: boolean;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
  emptyText: string;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const pinned = React.useRef(true);
  const last = entries.at(-1);
  const signature = `${entries.length}:${last?.key}:${(last?.item as any)?.text?.length ?? 0}:${(last?.item as any)?.status ?? ''}:${prompts.length}:${running}`;
  React.useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [signature]);
  return (
    <div ref={scroller} onScroll={event => { const element = event.currentTarget; pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain" role="log" aria-label="Conversation" aria-live="off">
      <div className="mx-auto flex w-full max-w-[820px] flex-col gap-3 px-4 py-6">
        {historyUnavailable ? <Line icon={<Info />} tone="warning">Earlier history of this conversation is no longer available on the host.</Line> : null}
        {!entries.length && !prompts.length ? <p className="py-10 text-center text-sm text-muted-foreground">{emptyText}</p> : null}
        {entries.map(entry => <EntryView key={entry.key} entry={entry} agent={agentOf(entry.sessionId)} />)}
        {prompts.map(prompt => <PendingView key={prompt.id} prompt={prompt} onRetry={() => onRetry(prompt.id)} onDiscard={() => onDiscard(prompt.id)} />)}
        {running ? (
          <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground" data-testid="working">
            <span className="flex gap-1" aria-hidden>
              {[0, 1, 2].map(dot => <span key={dot} className="size-1.5 animate-pulse rounded-full bg-highlight" style={{ animationDelay: `${dot * 180}ms` }} />)}
            </span>
            {runningAgent} is working
          </div>
        ) : null}
      </div>
    </div>
  );
}
