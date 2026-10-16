import * as React from 'react';
import { Ban, CircleDot, FileDiff, FolderTree, Lock, Plus, RefreshCw, RotateCcw, ShieldAlert, X } from 'lucide-react';
import { can } from '../lib/gateway.js';
import { members } from '../lib/timeline.js';
import { Button } from '../components/ui/button';
import { Input, Label, NativeSelect } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { modeLabel } from '../lib/format';
import { cn } from '../lib/utils';
import { StatusIndicator } from './status';
import { useAppState, useController } from './store';
import { useTabs } from './tabs';

/*
 * The right panel, as Paseo's explorer dock: a rail of tabs over one view. Paseo's Changes and
 * Files are here too, marked unavailable (the gateway has no file or git access); Agents and Tasks
 * are ALP's. Picking an agent or a task opens it in a tab of the center column.
 */

export type PanelTab = 'agents' | 'tasks' | 'changes' | 'files';

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';
const row = cn('flex w-full min-w-0 items-start gap-2 rounded-lg py-2 pl-2 pr-3 text-left', focusRing);

function Agents({ onPicked }: { onPicked?: () => void }) {
  const { openAgent, active } = useTabs();
  const { tree } = useAppState();
  if (!tree) return <p className="px-4 py-6 text-sm text-muted-foreground">Open a session to see its agents.</p>;
  const list = members(tree.projection);
  const waiting = new Set(Object.values(tree.projection.questions).map(question => (question as any).sessionId));
  return (
    <ul className="p-2" aria-label="Agents in this session">
      {list.map(member => {
        const session = member.session;
        const root = member.id === tree.rootId;
        const current = active?.kind === 'agent' && active.id === member.id;
        const bucket = waiting.has(member.id) ? 'needs_input' : member.running ? 'running' : 'done';
        return (
          <li key={member.id} className={cn('mb-0.5 rounded-lg', current ? 'bg-sidebar-selected' : 'hover:bg-sidebar-hover', !root && 'ml-4')}>
            <button type="button" onClick={() => { openAgent(member.id); onPicked?.(); }} aria-current={current ? 'true' : undefined} className={row} data-testid="agent-row">
              <StatusIndicator bucket={bucket} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className={cn('truncate text-sm leading-5', current ? 'text-foreground' : 'text-foreground/80')}>{session?.agent ?? (root ? 'main' : 'agent')}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{member.closed ? 'closed' : member.running ? 'working' : 'idle'}</span>
                </span>
                <span className="block truncate text-xs text-muted-foreground">{[root ? 'main conversation' : 'assignment', modeLabel(session?.mode), session?.model].filter(Boolean).join(' · ')}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const PRIORITIES = [0, 1, 2, 3, 4];
const STATUS_TONE: Record<string, string> = { open: 'text-muted-foreground', in_progress: 'text-dot-running', review: 'text-dot-warning', closed: 'text-highlight' };

function Tasks({ onPicked }: { onPicked?: () => void }) {
  const controller = useController();
  const { openTask, active } = useTabs();
  const { tasks, principal, workspace } = useAppState();
  const [title, setTitle] = React.useState('');
  const [priority, setPriority] = React.useState(2);
  const [showClosed, setShowClosed] = React.useState(false);
  const blocked = controller.tasksBlock();
  const canWrite = can(principal ?? undefined, 'project.write');
  React.useEffect(() => {
    controller.setTasksVisible(true);
    return () => controller.setTasksVisible(false);
  }, [controller]);
  if (!workspace) return <p className="px-4 py-6 text-sm text-muted-foreground">Choose a workspace to see its tasks.</p>;
  if (blocked) return <p className="flex items-start gap-2 px-4 py-6 text-sm text-muted-foreground"><Lock aria-hidden className="mt-0.5 size-4 shrink-0" />{blocked}</p>;
  const rows = tasks.rows.filter(entry => showClosed || entry.status !== 'closed');
  const closedCount = tasks.rows.filter(entry => entry.status === 'closed').length;
  return (
    <div className="space-y-2 p-2">
      {canWrite ? (
        <form className="flex gap-1.5 px-1 pt-1" onSubmit={event => { event.preventDefault(); if (!title.trim()) return; void controller.createTask({ title, priority }); setTitle(''); }}>
          <Label htmlFor="task-title" className="sr-only">New task</Label>
          <Input id="task-title" value={title} onChange={event => setTitle(event.target.value)} placeholder="New task…" maxLength={200} className="h-8 min-w-0 flex-1" />
          <Label htmlFor="task-priority" className="sr-only">Priority</Label>
          <NativeSelect id="task-priority" value={priority} onChange={event => setPriority(Number(event.target.value))} className="h-8 w-16 text-xs">
            {PRIORITIES.map(value => <option key={value} value={value}>P{value}</option>)}
          </NativeSelect>
          <Button type="submit" size="icon-sm" className="size-8" aria-label="Add task" title="Add task" disabled={!title.trim()}><Plus aria-hidden /></Button>
        </form>
      ) : <p className="px-2 pt-1 text-xs text-muted-foreground">Your access token can read tasks but not change them.</p>}

      {tasks.creates.map(create => (
        <div key={create.requestId} role={create.status === 'creating' ? 'status' : 'alert'}
          className={cn('mx-1 rounded-lg border px-3 py-2 text-xs', create.status === 'creating' ? 'border-border text-muted-foreground' : create.status === 'unknown' ? 'border-warning/40 bg-warning/5 text-warning' : 'border-destructive/40 bg-destructive/5 text-destructive')}>
          {create.status === 'creating' ? <Spinner label={`Creating “${create.title}”…`} /> : (
            <>
              <p className="mb-1.5 font-medium text-foreground">“{create.title}”</p>
              <p>{create.error}</p>
              {create.match ? <p className="mt-1 text-foreground/90">A task with this title is in the list ({create.match}); it was probably created.</p> : null}
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => void controller.retryTaskCreate(create.requestId)}><RotateCcw aria-hidden /> Create again</Button>
                <Button size="sm" variant="ghost" onClick={() => controller.dismissTaskCreate(create.requestId)}>Dismiss</Button>
              </div>
            </>
          )}
        </div>
      ))}
      {tasks.message ? (
        <p role={tasks.message.level === 'error' ? 'alert' : 'status'} className={cn('mx-1 rounded-md px-3 py-1.5 text-xs', tasks.message.level === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-highlight')}>{tasks.message.text}</p>
      ) : null}

      <div className="flex items-center justify-between py-0.5 pl-2 pr-1">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <input type="checkbox" checked={showClosed} onChange={event => setShowClosed(event.target.checked)} className="accent-[var(--highlight)]" />
          Show closed ({closedCount})
        </label>
        <button type="button" aria-label="Refresh tasks" title="Refresh tasks" onClick={() => void controller.refreshTasks()}
          className={cn('flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-hover hover:text-foreground', focusRing)}>
          <RefreshCw aria-hidden className={cn('size-3.5', tasks.status === 'loading' && 'animate-spin')} />
        </button>
      </div>
      {tasks.status === 'loading' && !tasks.rows.length ? <Spinner label="Loading tasks…" className="px-2 text-xs" /> : null}
      {tasks.status === 'error' ? <p role="alert" className="mx-1 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{tasks.error?.message}</p> : null}
      {tasks.status === 'ready' && !rows.length ? <p className="px-2 py-3 text-xs text-muted-foreground">{tasks.rows.length ? 'All tasks are closed.' : 'No tasks in this workspace.'}</p> : null}
      {tasks.unreadable ? <p className="px-2 text-xs text-warning">{tasks.unreadable} task file(s) on the host could not be read.</p> : null}
      <ul aria-label="Tasks">
        {rows.map(entry => {
          const current = active?.kind === 'task' && active.id === entry.id;
          return (
            <li key={entry.id} className={cn('mb-0.5 rounded-lg', current ? 'bg-sidebar-selected' : 'hover:bg-sidebar-hover')} data-testid="task-row">
              <button type="button" className={row} onClick={() => { openTask(entry.id); onPicked?.(); }} aria-current={current ? 'true' : undefined} title={entry.title}>
                <span className="flex h-5 w-4 shrink-0 items-center justify-center">
                  {entry.approvals?.length ? <ShieldAlert aria-hidden className="size-3.5 text-dot-warning" /> : <CircleDot aria-hidden className={cn('size-3.5', STATUS_TONE[entry.status])} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('line-clamp-2 text-sm leading-5', entry.status === 'closed' ? 'text-muted-foreground line-through' : 'text-foreground/90')}>{entry.title}</span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                    <span className="font-mono">{entry.id}</span>
                    <span>P{entry.priority}</span>
                    <span>{String(entry.status).replace('_', ' ')}</span>
                    {entry.assignee ? <span>· {entry.assignee}</span> : null}
                    {entry.progress ? <span>· {entry.progress.done}/{entry.progress.total}</span> : null}
                    {entry.approvals?.length ? <span className="text-dot-warning">· needs approval</span> : null}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Unavailable({ what, why }: { what: string; why: string }) {
  return (
    <div className="m-3 rounded-lg border border-border p-4 text-xs" role="note">
      <p className="flex items-center gap-2 text-foreground"><Ban aria-hidden className="size-3.5 text-muted-foreground" />{what}: not available in this beta</p>
      <p className="mt-1.5 text-muted-foreground">{why}</p>
    </div>
  );
}

const TABS: Array<{ value: PanelTab; label: string; icon?: React.ReactNode }> = [
  { value: 'agents', label: 'Agents' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'changes', label: 'Changes', icon: <FileDiff aria-hidden className="size-3.5" /> },
  { value: 'files', label: 'Files', icon: <FolderTree aria-hidden className="size-3.5" /> },
];

export function SidePanel({ tab, onTab, onClose }: { tab: PanelTab; onTab: (tab: PanelTab) => void; onClose?: () => void }) {
  const { tree, tasks } = useAppState();
  const working = tree ? Object.keys(tree.projection.running).length : 0;
  const open = tasks.rows.filter(entry => entry.status !== 'closed').length;
  const count: Partial<Record<PanelTab, number>> = { agents: working, tasks: open };
  const refs = React.useRef<Record<string, HTMLButtonElement | null>>({});
  const onKey = (event: React.KeyboardEvent) => {
    const at = TABS.findIndex(entry => entry.value === tab);
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = TABS[(at + step + TABS.length) % TABS.length].value;
    onTab(next);
    refs.current[next]?.focus();
  };
  return (
    <aside aria-label="Agents and tasks" className="flex h-full min-h-0 flex-col bg-sidebar" data-testid="workspace-explorer-sidebar">
      <div className="relative flex h-14 shrink-0 items-center border-b border-border md:h-9">
        <div role="tablist" aria-label="Panel" onKeyDown={onKey} className="flex min-w-0 flex-1 items-center overflow-x-auto px-1 [scrollbar-width:none]">
          {TABS.map(entry => {
            const selected = entry.value === tab;
            return (
              <button key={entry.value} ref={element => { refs.current[entry.value] = element; }} type="button" role="tab" id={`tab-${entry.value}`} aria-selected={selected} aria-controls={`panel-${entry.value}`} tabIndex={selected ? 0 : -1}
                onClick={() => onTab(entry.value)}
                className={cn('mx-0.5 flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-sm', focusRing, selected ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:bg-card')}>
                {entry.icon}{entry.label}
                {count[entry.value] ? <span className="ml-0.5 rounded-full bg-background/60 px-1.5 text-[11px] leading-4 text-muted-foreground">{count[entry.value]}</span> : null}
              </button>
            );
          })}
        </div>
        {onClose ? (
          <button type="button" aria-label="Close panel" onClick={onClose} className={cn('mr-1.5 flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground', focusRing)}>
            <X aria-hidden className="size-4" />
          </button>
        ) : null}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'agents' ? <Agents onPicked={onClose} /> : tab === 'tasks' ? <Tasks onPicked={onClose} /> : tab === 'changes'
          ? <Unavailable what="Changes" why="The gateway has no git access yet, so this panel cannot show the workspace's diff. Use git on the host." />
          : <Unavailable what="Files" why="The gateway has no file access yet, so this panel cannot browse the workspace. Use the host's editor." />}
      </div>
    </aside>
  );
}

