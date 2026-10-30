import * as React from 'react';
import { Ban, Bot, Brain, Eye, FileText, Image as ImageIcon, ChevronDown, ChevronRight, CircleAlert, Info, ListChecks, Pencil, RotateCcw, Scissors, Search, SquareTerminal, Trash2, TriangleAlert, Wrench } from 'lucide-react';
import type { Entry } from '../lib/timeline.js';
import type { PendingPrompt } from '../lib/controller.js';
import { Button } from '../components/ui/button';
import { clockTime } from '../lib/format';
import { can } from '../lib/gateway.js';
import { cn } from '../lib/utils';
import { fileSize, messageFiles, previewUrl } from '../lib/attachments.js';
import { FileLinkContext, RichText, type FileLinks } from './RichText';
import { parseFileLink } from '../lib/file-links.js';
import { useAppState } from './store';
import { useTabs } from './tabs';
import { CopyButton, Elapsed, Loader, formatDuration } from './chat/parts';
import { ToolCallBody } from './chat/ToolCallDetail';
import { diffStats, editDiff, presentToolCall, type ToolIcon } from '../lib/tool-calls.js';
import { conversationMarker } from '../lib/conversation.js';
import { ConversationMarker, ForkAction, RewindAction } from './Conversation';

/**
 * One agent's conversation laid out as Paseo's agent stream: a centered column (820px, or Appearance › Content width), user
 * messages as right-aligned bubbles, assistant text as plain markdown, tool calls as quiet
 * one-line rows that open into their detail, and a footer after each turn (copy, "Worked for").
 */

type Icon = React.ComponentType<{ className?: string }>;

/** Paseo's expandable badge: icon (a chevron on hover), label, secondary label; opens into detail. */
function Badge({ icon: IconComponent, label, secondary, status, trailing, detail, testId, kind, defaultOpen = false }: {
  icon: Icon;
  label: string;
  secondary?: string;
  status?: 'running' | 'completed' | 'failed';
  trailing?: React.ReactNode;
  detail: () => React.ReactNode;
  testId?: string;
  /** The tool call's detail type, for tests. */
  kind?: string;
  /** Starts open (Settings › Chat › Tool calls: Expanded); a click still closes it. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const detailId = React.useId();
  const failed = status === 'failed';
  const running = status === 'running';
  return (
    <div className="-mx-[13px]" data-testid={testId} data-tool-kind={kind}>
      <button type="button" onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls={open ? detailId : undefined}
        className={cn('group/badge flex w-full min-w-0 items-center rounded-lg border border-transparent px-2 py-1 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring active:opacity-90',
          open && 'rounded-b-none border-border bg-card')}>
        <span aria-hidden className="relative mr-1 flex size-[22px] shrink-0 items-center justify-center">
          <span className={cn('-ml-px flex', open ? 'hidden' : 'group-hover/badge:hidden')}>
            {failed ? <TriangleAlert className="size-3 text-destructive opacity-80" /> : <IconComponent className={cn('size-3', open ? 'text-foreground' : 'text-muted-foreground group-hover/badge:text-foreground')} />}
          </span>
          <ChevronRight className={cn('-ml-1 size-3 scale-[1.3] text-foreground', open ? 'block rotate-90' : 'hidden group-hover/badge:block')} />
        </span>
        <span className={cn('shrink-0 text-muted-foreground', (open || running) && 'text-foreground', running && 'animate-pulse opacity-70', 'group-hover/badge:text-foreground')}>{label}</span>
        {secondary ? <span className={cn('ml-2 min-w-0 flex-1 truncate text-muted-foreground group-hover/badge:text-foreground', open && 'text-foreground')}>{secondary}</span> : <span className="flex-1" />}
        {trailing}
      </button>
      {open ? (
        <div id={detailId} className="min-w-0 overflow-hidden rounded-b-lg border border-t-0 border-border">
          {detail()}
        </div>
      ) : null}
    </div>
  );
}

const TOOL_ICONS: Record<ToolIcon, Icon> = { terminal: SquareTerminal, eye: Eye, pencil: Pencil, search: Search, bot: Bot, brain: Brain, wrench: Wrench };

/** Where a tool call's file paths are shown relative to: the open workspace, as granted and as its real path. */
function useWorkspaceRoots() {
  const { workspace, principal } = useAppState();
  return React.useMemo(() => workspace
    ? [workspace, ...(principal?.workspaceRoots ?? []).filter(root => root.path === workspace).map(root => root.canonical)]
    : [], [workspace, principal]);
}

/** An edit's "+12 −3", shown as Paseo's diff stat. */
function EditStat({ detail }: { detail: any }) {
  const { added, removed } = React.useMemo(() => diffStats(editDiff(detail).lines), [detail]);
  if (!added && !removed) return null;
  return (
    <span className="ml-2 shrink-0 text-xs tabular-nums" data-testid="tool-diff-stat">
      <span className="text-dot-success">+{added}</span> <span className="text-destructive">−{removed}</span>
    </span>
  );
}

function ToolCall({ item }: { item: any }) {
  const roots = useWorkspaceRoots();
  const { preferences } = useAppState();
  const status = item.status as 'running' | 'completed' | 'failed';
  const view = presentToolCall(item, roots);
  const exitCode = view.kind === 'shell' && status !== 'running' ? item.detail.exitCode : null;
  return (
    <Badge testId="tool-call" kind={view.kind} icon={TOOL_ICONS[view.icon]} label={view.label} secondary={view.secondary} status={status}
      defaultOpen={preferences.toolCalls === 'expanded'}
      trailing={exitCode != null ? (
        <span className={cn('ml-2 shrink-0 text-xs tabular-nums', exitCode === 0 ? 'text-muted-foreground opacity-0 group-hover/badge:opacity-100 group-aria-expanded/badge:opacity-100' : 'text-destructive')}>exit {exitCode}</span>
      ) : view.kind === 'edit' ? <EditStat detail={item.detail} /> : null}
      detail={() => <ToolCallBody item={item} roots={roots} />} />
  );
}

function Todo({ item }: { item: any }) {
  const tasks: Array<{ id: string; text: string; status: string }> = item.items ?? [];
  const done = tasks.filter(task => task.status === 'completed').length;
  const active = tasks.find(task => task.status === 'in_progress');
  return (
    <Badge icon={ListChecks} label="Tasks" secondary={active ? active.text : `${done} of ${tasks.length} done`}
      detail={() => (
        <ul className="space-y-1 bg-card p-2 text-sm">
          {tasks.length ? tasks.map(task => (
            <li key={task.id} className="flex items-start gap-2 px-1">
              <span aria-hidden className={cn('mt-[5px] size-2 shrink-0 rounded-full', task.status === 'completed' ? 'bg-dot-success' : task.status === 'in_progress' ? 'bg-dot-warning' : 'border border-muted-foreground/60')} />
              <span className={cn('min-w-0', task.status === 'completed' && 'text-muted-foreground line-through')}>{task.text}</span>
            </li>
          )) : <li className="px-1 text-muted-foreground">No tasks.</li>}
        </ul>
      )} />
  );
}

/** Paseo's notification: a tinted strip with an icon. */
function Notice({ level, children }: { level: 'info' | 'warning' | 'error'; children: React.ReactNode }) {
  const Glyph = level === 'error' ? CircleAlert : level === 'warning' ? TriangleAlert : Info;
  return (
    <div className={cn('flex items-start gap-2 rounded-md px-3 py-2.5 text-sm leading-5 text-foreground',
      level === 'error' ? 'bg-[rgba(239,68,68,0.1)]' : level === 'warning' ? 'bg-[rgba(245,158,11,0.1)]' : 'bg-[rgba(147,197,253,0.1)]')}>
      <span aria-hidden className="flex h-5 shrink-0 items-center"><Glyph className={cn('size-4', level === 'error' ? 'text-destructive' : level === 'warning' ? 'text-warning' : 'text-info')} /></span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

/** Paseo's compaction marker: a label between two rules. */
function Marker({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-muted-foreground">
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-2 [&_svg]:size-3">{icon}{children}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}

/** How many images a sent message carried (their data is not replayed). */
function ImagesChip({ count }: { count: number }) {
  return (
    <span className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[13px] text-muted-foreground" data-testid="user-message-images">
      <ImageIcon aria-hidden className="size-3.5" />{count === 1 ? '1 image' : `${count} images`}
    </span>
  );
}

/**
 * The files a message carried (#121 J): a chip each with its name and size, from the timeline's
 * `attachments` (ids and display names only; never a path). While it uploads, its progress.
 */
function FileChips({ files, testId }: { files: Array<{ key: string; name: string; size: number; progress?: string; failed?: boolean }>; testId: string }) {
  return (
    <ul aria-label="Attached files" className="mb-2 flex max-w-full flex-wrap justify-end gap-2">
      {files.map(file => (
        <li key={file.key} data-testid={testId} className={cn('flex h-8 max-w-[18rem] items-center gap-1.5 rounded-full bg-muted px-2.5 text-[13px] text-muted-foreground', file.failed && 'text-destructive')}>
          <FileText aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate text-foreground" title={file.name}>{file.name}</span>
          <span className="shrink-0">{fileSize(file.size)}</span>
          {file.progress ? <span className="shrink-0" data-testid="file-progress">{file.progress}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function UserBubble({ text, ts, images, files = [], entryKey }: { text: string; ts?: string; images?: number; files?: Array<{ attachmentId: string; name: string; size: number }>; entryKey: string }) {
  const bare = !images && !files.length;
  return (
    <div className="group/user flex flex-col items-end">
      {images ? <ImagesChip count={images} /> : null}
      {files.length ? <FileChips testId="user-message-file" files={files.map(file => ({ key: file.attachmentId, name: file.name, size: file.size }))} /> : null}
      {text || bare ? <div className="min-w-0 max-w-full rounded-2xl rounded-tr-sm bg-bubble p-4 text-[15px] leading-[21px] text-foreground whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="user-message">{text}</div> : null}
      <div className="mt-2 flex h-6 items-center gap-2 opacity-0 transition-opacity group-hover/user:opacity-100 focus-within:opacity-100">
        <span className="text-[13px] text-muted-foreground">{clockTime(ts)}</span>
        <RewindAction entryKey={entryKey} />
        <CopyButton text={() => text} label="Copy message" className="-mr-1" />
      </div>
    </div>
  );
}

/**
 * Paseo's file links in an agent's reply: where the host reads files and the token may
 * (files.read), paths of the open workspace open in a file tab; otherwise they stay text.
 */
function useFileLinks(): FileLinks | null {
  const { workspace, principal, connection } = useAppState();
  const { openFile } = useTabs();
  const readable = connection.capabilities.includes('workspace.files.read') && can(principal ?? undefined, 'files.read');
  return React.useMemo(() => {
    if (!readable || !workspace) return null;
    // An absolute path may start with the workspace as granted or as its real path on the host.
    const roots = [workspace, ...(principal?.workspaceRoots ?? []).filter(root => root.path === workspace).map(root => root.canonical)];
    return {
      resolve: (raw, kind) => parseFileLink(raw, { roots, kind }),
      open: target => openFile(target.path, target.line),
    };
  }, [readable, workspace, principal, openFile]);
}

function AssistantText({ text }: { text: string }) {
  const links = useFileLinks();
  return <FileLinkContext.Provider value={links}><RichText text={text} /></FileLinkContext.Provider>;
}

function EntryView({ entry, compactBottom }: { entry: Entry; compactBottom: boolean }) {
  const item = entry.item as any;
  switch (item.kind) {
    case 'user_message':
      return <UserBubble entryKey={entry.key} text={item.text} ts={entry.ts} images={typeof item.images === 'number' && item.images > 0 ? item.images : undefined} files={messageFiles(item.attachments)} />;
    case 'assistant_message':
      return (
        <div className={cn('pt-3', compactBottom ? 'pb-0' : 'pb-3')} data-testid="assistant-message">
          <AssistantText text={item.text} />
        </div>
      );
    case 'tool_call':
      return <ToolCall item={item} />;
    case 'todo':
      return <Todo item={item} />;
    case 'notice':
      if (conversationMarker(item)) return <ConversationMarker item={item} />;
      return <Notice level={item.level === 'error' || item.level === 'warning' ? item.level : 'info'}>{item.text}</Notice>;
    case 'compaction':
      return (
        <Marker icon={item.status === 'running' ? <Loader size={12} /> : item.status === 'failed' ? <CircleAlert className="text-destructive" /> : <Scissors />}>
          {item.status === 'running' ? 'Compacting context…' : item.status === 'failed' ? 'Compacting the context failed' : 'Context compacted'}
        </Marker>
      );
    case 'turn_end':
      return item.state === 'canceled'
        ? <p className="flex items-center gap-2 py-1 text-[13px] text-muted-foreground"><Ban aria-hidden className="size-3.5" />Stopped.</p>
        : <Notice level="error">{`The turn failed${item.error ? `: ${item.error}` : '.'}`}</Notice>;
    case 'session_event':
      return <Notice level={item.level === 'error' ? 'error' : item.level === 'warning' ? 'warning' : 'info'}>{item.text}</Notice>;
    default:
      return null;
  }
}

function PendingView({ prompt, gap, onRetry, onDiscard }: { prompt: PendingPrompt; gap: number; onRetry: () => void; onDiscard: () => void }) {
  return (
    <div className="flex flex-col items-end gap-2" style={gap ? { marginTop: gap } : undefined} data-testid="pending-message" aria-busy={prompt.status === 'sending'}>
      {prompt.images?.length ? (
        <div className="flex flex-wrap justify-end gap-2">
          {prompt.images.map(image => <img key={image.id} src={previewUrl(image)} alt={image.name} title={image.name} className="size-16 rounded-lg border border-border object-cover" />)}
        </div>
      ) : null}
      {prompt.files?.length ? (
        <FileChips testId="pending-file" files={prompt.files.map((file, index) => ({
          key: `${index}`, name: file.name, size: file.size, failed: !!file.error,
          progress: file.attachmentId ? 'Uploaded' : file.error ? 'Not uploaded' : prompt.status === 'sending' ? `${file.size ? Math.floor(((file.received ?? 0) / file.size) * 100) : 0}%` : undefined,
        }))} />
      ) : null}
      {prompt.text || (!prompt.images?.length && !prompt.files?.length) ? (
        <div className={cn('min-w-0 max-w-full rounded-2xl rounded-tr-sm p-4 text-[15px] leading-[21px] whitespace-pre-wrap [overflow-wrap:anywhere]',
          prompt.status === 'sending' ? 'bg-bubble opacity-70' : prompt.status === 'failed' ? 'border border-destructive/40 bg-destructive/5' : 'border border-warning/40 bg-warning/5')}>
          {prompt.text}
        </div>
      ) : null}
      {prompt.status === 'sending' ? (
        <span role="status" className="flex h-6 items-center gap-2 text-[13px] text-muted-foreground"><Loader size={12} />{prompt.accepted ? 'Delivered' : 'Sending…'}</span>
      ) : (
        <div className="flex max-w-full flex-wrap items-center justify-end gap-2 text-[13px]" role="alert">
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

/** Paseo's turn footer: copy the turn, "Worked for 12s" (the end time on hover). */
function TurnFooter({ entries, startTs, userKeys }: { entries: Entry[]; startTs?: string; userKeys: string[] }) {
  const end = entries.at(-1)?.ts;
  const started = Date.parse(startTs ?? '');
  const ended = Date.parse(end ?? '');
  const duration = Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? `Worked for ${formatDuration(ended - started)}` : '';
  const time = clockTime(end);
  const primary = duration || time;
  const text = () => entries.map(entry => (entry.item as any).kind === 'assistant_message' ? (entry.item as any).text : '').filter(Boolean).join('\n\n');
  return (
    <div className="mt-[13px] flex min-h-6 items-center self-start pb-8">
      <div className="flex h-6 items-center gap-2">
        <CopyButton text={text} label="Copy turn" className="-ml-1" />
        <ForkAction userKeys={userKeys} />
        {primary ? (
          <span className="group/time relative text-[13px] text-muted-foreground" title={duration && time ? `Ended ${time}` : undefined}>
            <span className={cn(duration && time && 'group-hover/time:invisible')}>{primary}</span>
            {duration && time ? <span className="invisible absolute left-0 top-0 whitespace-nowrap group-hover/time:visible">{time}</span> : null}
          </span>
        ) : null}
      </div>
    </div>
  );
}

type Kind = 'user' | 'assistant' | 'tool' | 'other';
const kindOf = (entry: Entry | undefined): Kind | null => {
  const kind = (entry?.item as any)?.kind;
  if (!kind) return null;
  return kind === 'user_message' ? 'user' : kind === 'assistant_message' ? 'assistant' : kind === 'tool_call' || kind === 'todo' ? 'tool' : 'other';
};

/** Paseo's spacing between stream items (agent-stream/spacing.ts), in px. */
function gapBetween(above: Kind | null, below: Kind | null) {
  if (!above || !below) return 0;
  if (above === 'user' && below === 'user') return 4;
  if (above === 'user' && below === 'assistant') return 0;
  if (above === 'tool' && below === 'tool') return 0;
  if (above === 'user' && below === 'tool') return 16;
  if (above === 'assistant' && below === 'tool') return 4;
  if (above === 'tool' && below === 'assistant') return 4;
  return 16;
}

type Row =
  | { type: 'entry'; entry: Entry; gap: number; compactBottom: boolean }
  | { type: 'footer'; key: string; entries: Entry[]; startTs?: string; userKeys: string[] };

/** Entries with a footer after each finished turn (a turn: what follows a user message). */
function layout(entries: Entry[], running: boolean): Row[] {
  const rows: Row[] = [];
  let turn: Entry[] = [];
  let startTs: string | undefined;
  let previous: Entry | undefined;
  const close = (key: string) => {
    if (turn.some(entry => kindOf(entry) !== 'user')) rows.push({ type: 'footer', key, entries: turn.filter(entry => kindOf(entry) !== 'user'), startTs, userKeys: turn.filter(entry => kindOf(entry) === 'user').map(entry => entry.key) });
    turn = [];
  };
  const marker = (entry: Entry | undefined) => !!entry && !!conversationMarker(entry.item);
  entries.forEach((entry, index) => {
    const kind = kindOf(entry);
    // A fork or rewind marker stands between turns: the turn above ends (its footer first).
    if (marker(entry)) {
      close(`footer:${entry.key}`);
      rows.push({ type: 'entry', entry, gap: 0, compactBottom: false });
      previous = undefined;
      return;
    }
    if (kind === 'user' && turn.some(item => kindOf(item) !== 'user')) {
      close(`footer:${entry.key}`);
      previous = undefined;
    }
    if (kind === 'user' && kindOf(previous) !== 'user') startTs = entry.ts;
    const next = entries[index + 1];
    const endsTurn = !next ? !running : kindOf(next) === 'user' || marker(next);
    rows.push({
      type: 'entry',
      entry,
      gap: gapBetween(kindOf(previous), kind),
      compactBottom: kind === 'assistant' && endsTurn,
    });
    turn.push(entry);
    previous = entry;
  });
  if (!running) close('footer:end');
  return rows;
}

export function Timeline({ entries, prompts, agentOf, running, runningAgent, historyUnavailable, older, onLoadOlder, onRetry, onDiscard, emptyText, tail }: {
  entries: Entry[];
  prompts: PendingPrompt[];
  agentOf: (sessionId: string) => string;
  running: boolean;
  runningAgent: string;
  historyUnavailable: boolean;
  older?: { hasOlder: boolean; loading?: boolean; error?: string };
  onLoadOlder?: () => Promise<void>;
  onRetry: (id: string) => void;
  onDiscard: (id: string) => void;
  emptyText: string;
  /** What follows the turn at the end of the stream, as Paseo's pending permissions: the questions. */
  tail?: React.ReactNode;
}) {
  void agentOf;
  const scroller = React.useRef<HTMLDivElement>(null);
  const anchor = React.useRef<{ key: string; top: number } | null>(null);
  const loadOlder = async () => {
    const element = scroller.current;
    if (!element || !onLoadOlder) return;
    const row = [...element.querySelectorAll<HTMLElement>('[data-entry-key]')].find(row => row.getBoundingClientRect().bottom > element.getBoundingClientRect().top);
    anchor.current = row ? { key: row.dataset.entryKey!, top: row.getBoundingClientRect().top } : null;
    pinned.current = false;
    await onLoadOlder();
  };
  const pinned = React.useRef(true);
  // Paseo's jump-to-bottom button shows while the reader is away from the end.
  const [away, setAway] = React.useState(false);
  // While the jump scrolls smoothly, its own scroll events must not unpin the stream.
  const jumping = React.useRef(0);
  const toBottom = () => {
    const element = scroller.current;
    if (!element) return;
    pinned.current = true;
    jumping.current = Date.now() + 700;
    setAway(false);
    element.scrollTo({ top: element.scrollHeight, behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const last = entries.at(-1);
  const signature = `${entries.length}:${last?.key}:${(last?.item as any)?.text?.length ?? 0}:${(last?.item as any)?.status ?? ''}:${prompts.length}:${running}:${React.Children.count(tail)}`;
  React.useLayoutEffect(() => {
    const element = scroller.current;
    if (element && anchor.current && !older?.loading) {
      const saved = anchor.current;
      const row = [...element.querySelectorAll<HTMLElement>('[data-entry-key]')].find(row => row.dataset.entryKey === saved.key);
      if (row) element.scrollTop += row.getBoundingClientRect().top - saved.top;
      anchor.current = null;
    }
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
    // Content that shrank or changed may bring the end back into view.
    if (element && element.scrollHeight - element.scrollTop - element.clientHeight < 80) { pinned.current = true; setAway(false); }
  }, [signature, older?.loading]);
  // Stay at the bottom when the box below grows (a queued message, a question) or the window resizes.
  React.useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => { if (pinned.current) element.scrollTop = element.scrollHeight; });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // When the running turn started: the user message that opened it, else when we saw it start.
  const startedAt = React.useRef<number | null>(null);
  if (!running) startedAt.current = null;
  else if (startedAt.current == null) {
    const opener = [...entries].reverse().find(entry => kindOf(entry) === 'user');
    const at = Date.parse(opener?.ts ?? '');
    startedAt.current = Number.isFinite(at) && Date.now() - at < 6 * 3600_000 ? Math.min(at, Date.now()) : Date.now();
  }

  const rows = React.useMemo(() => layout(entries, running), [entries, running]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
    <div ref={scroller} onScroll={event => {
      const element = event.currentTarget;
      const near = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      if (!near && Date.now() < jumping.current) return;
      pinned.current = near;
      setAway(!near);
    }}
      // The reader taking over ends the jump at once.
      onWheel={() => { jumping.current = 0; }} onTouchStart={() => { jumping.current = 0; }} onKeyDown={() => { jumping.current = 0; }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none] px-3 md:px-4" role="log" aria-label="Conversation" aria-live="off">
      <div className="mx-auto flex w-full max-w-(--content-width) flex-col px-2 py-4">
        {older?.hasOlder ? <div className="mb-4 flex flex-col items-center gap-2"><Button variant="ghost" disabled={older.loading} onClick={() => void loadOlder()}>{older.loading ? 'Loading…' : 'Load older messages'}</Button>{older.error ? <p role="alert" className="text-xs text-destructive">{older.error}</p> : null}</div> : null}
        {historyUnavailable ? <div className="mb-4"><Notice level="warning">Earlier history of this conversation is no longer available on the host.</Notice></div> : null}
        {!entries.length && !prompts.length ? <p className="py-12 text-center text-sm text-muted-foreground">{emptyText}</p> : null}
        {rows.map(row => row.type === 'footer' ? <TurnFooter key={row.key} entries={row.entries} startTs={row.startTs} userKeys={row.userKeys} /> : (
          <div key={row.entry.key} data-entry-key={row.entry.key} className="flex flex-col" style={row.gap ? { marginTop: row.gap } : undefined}>
            <EntryView entry={row.entry} compactBottom={row.compactBottom} />
          </div>
        ))}
        {prompts.map((prompt, index) => <PendingView key={prompt.id} prompt={prompt} gap={index > 0 ? 4 : gapBetween(rows.at(-1)?.type === 'entry' ? kindOf((rows.at(-1) as { entry: Entry }).entry) : null, 'user')} onRetry={() => onRetry(prompt.id)} onDiscard={() => onDiscard(prompt.id)} />)}
        {running ? (
          <div className="mt-[13px] flex min-h-6 items-center self-start pb-8" data-testid="working" role="status" aria-label={`${runningAgent} is working`}>
            <div className="flex h-6 items-center gap-3 text-foreground">
              <Loader size={14} className="-ml-0.5" />
              <Elapsed since={startedAt.current ?? Date.now()} className="text-[13px] text-muted-foreground" />
            </div>
          </div>
        ) : null}
        {tail ? <div className="flex flex-col gap-2 pb-4">{tail}</div> : null}
      </div>
    </div>
    {away ? (
      <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
        <button type="button" onClick={toBottom} aria-label="Scroll to bottom" title="Scroll to bottom" data-testid="scroll-to-bottom"
          className="pointer-events-auto flex size-12 items-center justify-center rounded-full bg-secondary text-foreground shadow-md shadow-black/30 outline-none hover:bg-bubble focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronDown aria-hidden className="size-6" />
        </button>
      </div>
    ) : null}
    </div>
  );
}
