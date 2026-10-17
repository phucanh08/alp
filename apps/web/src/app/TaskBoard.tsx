import * as React from 'react';
import { ChevronDown, ChevronRight, Circle, CircleCheck, CircleDashed, CircleSlash, Columns3, Eye, Hand, List, LoaderCircle, Lock, Plus, RefreshCw, RotateCcw, Search, Target } from 'lucide-react';
import { can } from '../lib/gateway.js';
import { STATE_LABELS, TASK_FILTERS, TASK_VIEWS, age, boardColumns, epicGroups, filterCounts, filterTasks, listSections, stateOf, type TaskFilter, type TaskRow, type TaskState, type TaskView } from '../lib/task-board.js';
import { Button } from '../components/ui/button';
import { Input, Label, NativeSelect } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { cn } from '../lib/utils';
import { useAppState, useController } from './store';
import { useTabs } from './tabs';

/*
 * ALP's task board, in the Tasks tab and on the full-screen Tasks screen, as the alp-provider
 * plugin shows it in paseo-web (integrations/paseo/client/tasks-panel.tsx): a toolbar with the
 * open count and the List / Board / Epics views, the filters Open / Ready / Closed / All with their
 * counts and a search; under it apps/web's own new-task form. The rows come from task.list
 * through the gateway (the controller polls while a board shows).
 */

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';
const row = cn('flex w-full min-w-0 items-start gap-2 rounded-lg py-2 pl-2 pr-3 text-left', focusRing);
const PRIORITIES = [0, 1, 2, 3, 4];
const VIEW_ICONS: Record<TaskView, typeof List> = { list: List, board: Columns3, epics: Target };
const SECTION_ICONS: Record<string, typeof List> = { approve: Hand, review: Eye, progress: LoaderCircle, ready: CircleCheck, waiting: CircleSlash, epics: Target, closed: CircleDashed };
const STATE_DOT: Record<TaskState, string> = {
  approve: 'bg-dot-warning', review: 'bg-dot-running', progress: 'border-2 border-dot-warning', ready: 'bg-dot-success', blocked: 'bg-dot-danger', closed: 'border-2 border-border',
};
const CARD_EDGE: Partial<Record<TaskState, string>> = { blocked: 'border-l-dot-danger', ready: 'border-l-dot-success', approve: 'border-l-dot-warning' };

/** The task's state as the plugin's dot: filled, or a ring in progress and when closed. */
function StateDot({ state }: { state: TaskState }) {
  return <span role="img" aria-label={STATE_LABELS[state]} title={STATE_LABELS[state]} className={cn('inline-block size-[9px] shrink-0 rounded-full', STATE_DOT[state])} />;
}

/** A priority badge: P0 and P1 stand out. */
function Priority({ value }: { value: number }) {
  return <span className={cn('shrink-0 rounded border px-1 text-[10.5px] font-semibold tabular-nums leading-4', value === 0 ? 'border-destructive text-destructive' : value === 1 ? 'border-warning text-warning' : 'border-border text-muted-foreground')}>P{value}</span>;
}

/**
 * ALP's task board. `onOpen`, when given, takes a picked task in place of opening its tab (the
 * full-screen board shows it beside the list), and `current` is the task it shows.
 */
export function Tasks({ onPicked, onOpen, current: shown }: { onPicked?: () => void; onOpen?: (id: string) => void; current?: string | null }) {
  const controller = useController();
  const { openTask: openTab, active } = useTabs();
  const openTask = (id: string) => { (onOpen ?? openTab)(id); onPicked?.(); };
  const { tasks, principal, workspace } = useAppState();
  const [title, setTitle] = React.useState('');
  const [priority, setPriority] = React.useState(2);
  const [board, setBoard] = React.useState<{ view: TaskView; filter: TaskFilter; query: string }>({ view: 'list', filter: 'open', query: '' });
  const blocked = controller.tasksBlock();
  const canWrite = can(principal ?? undefined, 'project.write');
  React.useEffect(() => {
    controller.setTasksVisible(true);
    return () => controller.setTasksVisible(false);
  }, [controller]);
  const rows = tasks.rows as TaskRow[];
  const counts = React.useMemo(() => filterCounts(rows), [rows]);
  const kept = React.useMemo(() => filterTasks(rows, board.filter, board.query), [rows, board.filter, board.query]);
  if (!workspace) return <p className="px-4 py-6 text-sm text-muted-foreground">Choose a workspace to see its tasks.</p>;
  if (blocked) return <p className="flex items-start gap-2 px-4 py-6 text-sm text-muted-foreground"><Lock aria-hidden className="mt-0.5 size-4 shrink-0" />{blocked}</p>;
  const isCurrent = (id: string) => onOpen ? shown === id : active?.kind === 'task' && active.id === id;
  const setView = (view: TaskView) => setBoard(state => ({ ...state, view }));
  const ready = tasks.status === 'ready' || rows.length > 0;
  return (
    <div className="@container flex min-h-0 flex-col gap-2 p-2" data-testid="task-board" data-view={board.view}>
      <div className="flex items-center gap-1.5 px-1 pt-1">
        <h2 className="text-sm font-semibold">Tasks</h2>
        {ready ? <span className="text-xs text-muted-foreground" data-testid="tasks-open-count">{counts.open} open</span> : null}
        <span className="flex-1" />
        <div role="group" aria-label="Task view" className="flex rounded-lg border border-border bg-card p-0.5">
          {TASK_VIEWS.map(option => {
            const Icon = VIEW_ICONS[option.key];
            const on = board.view === option.key;
            return (
              <button key={option.key} type="button" aria-pressed={on} title={option.label} onClick={() => setView(option.key)}
                className={cn('flex h-6 items-center gap-1 rounded-md px-1.5 text-xs', on ? 'bg-secondary font-semibold text-foreground' : 'text-muted-foreground hover:text-foreground', focusRing)}>
                <Icon aria-hidden className="size-3.5" /><span className="sr-only @[340px]:not-sr-only">{option.label}</span>
              </button>
            );
          })}
        </div>
        <button type="button" aria-label="Refresh tasks" title="Refresh tasks" onClick={() => void controller.refreshTasks()}
          className={cn('flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-hover hover:text-foreground', focusRing)}>
          <RefreshCw aria-hidden className={cn('size-3.5', tasks.status === 'loading' && 'animate-spin')} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-1">
        <div role="group" aria-label="Task filter" className="flex flex-wrap gap-1">
          {TASK_FILTERS.map(key => {
            const on = board.filter === key;
            return (
              <button key={key} type="button" aria-pressed={on} onClick={() => setBoard(state => ({ ...state, filter: key }))} data-testid={`tasks-filter-${key}`}
                className={cn('h-6 rounded-full border px-2.5 text-xs', on ? 'border-foreground bg-foreground font-semibold text-background' : 'border-border text-foreground hover:bg-secondary', focusRing)}>
                {key[0].toUpperCase() + key.slice(1)} <span className="text-[11px] opacity-60">{counts[key]}</span>
              </button>
            );
          })}
        </div>
        <label className="flex h-7 min-w-[160px] flex-1 items-center gap-1.5 rounded-lg border border-border bg-card px-2 focus-within:border-ring">
          <Search aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <input type="text" role="searchbox" value={board.query} onChange={event => setBoard(state => ({ ...state, query: event.target.value }))} aria-label="Filter tasks"
            placeholder="Filter by id, title, label, agent" className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground" />
        </label>
      </div>

      {canWrite ? (
        <form className="flex gap-1.5 px-1" onSubmit={event => { event.preventDefault(); if (!title.trim()) return; void controller.createTask({ title, priority }); setTitle(''); }}>
          <Label htmlFor="task-title" className="sr-only">New task</Label>
          <Input id="task-title" value={title} onChange={event => setTitle(event.target.value)} placeholder="New task…" maxLength={200} className="h-8 min-w-0 flex-1" />
          <Label htmlFor="task-priority" className="sr-only">Priority</Label>
          <NativeSelect id="task-priority" value={priority} onChange={event => setPriority(Number(event.target.value))} className="h-8 w-16 text-xs">
            {PRIORITIES.map(value => <option key={value} value={value}>P{value}</option>)}
          </NativeSelect>
          <Button type="submit" size="icon-sm" className="size-8" aria-label="Add task" title="Add task" disabled={!title.trim()}><Plus aria-hidden /></Button>
        </form>
      ) : <p className="px-2 text-xs text-muted-foreground">Your access token can read tasks but not change them.</p>}

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

      {tasks.status === 'loading' && !rows.length ? <Spinner label="Loading tasks…" className="px-2 text-xs" /> : null}
      {tasks.status === 'error' ? <p role="alert" className="mx-1 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">{tasks.error?.message}</p> : null}
      {tasks.unreadable ? <p className="px-2 text-xs text-warning">{tasks.unreadable} task file(s) on the host could not be read.</p> : null}
      {tasks.status === 'ready' && !rows.length ? <Empty text="No tasks yet. Add one here, with alp task add, or ask main to plan the work." /> : null}
      {rows.length && !kept.length ? <Empty text={board.query.trim() ? 'No tasks match.' : board.filter === 'open' ? 'All tasks are closed.' : board.filter === 'ready' ? 'No task is ready.' : 'No closed tasks.'} /> : null}
      {kept.length && board.view === 'list' ? <ListView tasks={kept} isCurrent={isCurrent} onOpen={openTask} canWrite={canWrite} /> : null}
      {kept.length && board.view === 'board' ? <BoardView tasks={kept} isCurrent={isCurrent} onOpen={openTask} /> : null}
      {kept.length && board.view === 'epics' ? <EpicsView all={rows} shown={kept} isCurrent={isCurrent} onOpen={openTask} /> : null}
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <p role="status" className="mx-1 rounded-lg border border-dashed border-border px-4 py-5 text-center text-xs text-muted-foreground">{text}</p>;
}

type Pick = { isCurrent: (id: string) => boolean; onOpen: (id: string) => void };

/** One task in the List and under an epic: its state, title, then id, priority, status and the rest. */
function TaskLine({ task, isCurrent, onOpen, testId = 'task-row' }: Pick & { task: TaskRow; testId?: string }) {
  const current = isCurrent(task.id);
  const state = stateOf(task);
  const after = task.blockedBy?.length ? `after ${task.blockedBy.join(', ')}` : '';
  // Gates waiting for the user show with their Approve instead.
  const waits = task.waits?.length && !task.approvals?.length ? `waits on ${task.waits.join('; ')}` : '';
  return (
    <div className={cn('rounded-lg', current ? 'bg-sidebar-selected' : 'hover:bg-sidebar-hover')} data-testid={testId}>
      <button type="button" className={row} onClick={() => onOpen(task.id)} aria-current={current ? 'true' : undefined} title={task.title}>
        <span className="flex h-5 w-4 shrink-0 items-center justify-center"><StateDot state={state} /></span>
        <span className="min-w-0 flex-1">
          <span className={cn('line-clamp-2 text-sm leading-5', task.status === 'closed' ? 'text-muted-foreground line-through' : 'text-foreground/90')}>{task.title}</span>
          <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
            <span className="font-mono">{task.id}</span>
            <span>P{task.priority}</span>
            {task.type && task.type !== 'task' ? <span>{task.type}</span> : null}
            <span>{String(task.status).replace('_', ' ')}</span>
            {task.assignee ? <span>· @{task.assignee}</span> : null}
            {task.progress ? <span>· {task.progress.done}/{task.progress.total}</span> : null}
            {task.approvals?.length ? <span className="text-dot-warning">· needs approval</span> : null}
            {after ? <span className="text-dot-danger">· {after}</span> : null}
            {waits ? <span>· {waits}</span> : null}
            {task.parent ? <span>· in {task.parent}</span> : null}
            {(task.labels ?? []).map(label => <span key={label} className="text-info">#{label}</span>)}
            <span className="ml-auto tabular-nums">{age(task.status === 'closed' ? task.closed?.at : task.updatedAt)}</span>
          </span>
        </span>
      </button>
    </div>
  );
}

/** The List view: grouped the way the user acts on tasks, each group collapsible. */
function ListView({ tasks, isCurrent, onOpen, canWrite }: Pick & { tasks: TaskRow[]; canWrite: boolean }) {
  const controller = useController();
  const { tasks: state } = useAppState();
  const sections = React.useMemo(() => listSections(tasks), [tasks]);
  const [hidden, setHidden] = React.useState<Record<string, boolean>>({});
  return (
    <div className="space-y-1" data-testid="tasks-list-view">
      {sections.map(section => {
        const collapsed = hidden[section.key] ?? false;
        const Icon = SECTION_ICONS[section.key] ?? Circle;
        return (
          <section key={section.key} aria-label={section.title} data-testid={`tasks-section-${section.key}`}>
            <button type="button" aria-expanded={!collapsed} onClick={() => setHidden(current => ({ ...current, [section.key]: !collapsed }))}
              className={cn('flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground', focusRing)}>
              {collapsed ? <ChevronRight aria-hidden className="size-3.5" /> : <ChevronDown aria-hidden className="size-3.5" />}
              <Icon aria-hidden className="size-3.5" />
              <span className="font-semibold">{section.title}</span>
              <span className="tabular-nums opacity-70">{section.tasks.length}</span>
            </button>
            {!collapsed ? (
              <ul aria-label={section.title}>
                {section.tasks.map(task => (
                  <li key={task.id} className="mb-0.5">
                    <TaskLine task={task} isCurrent={isCurrent} onOpen={onOpen} />
                    {section.key === 'approve' && canWrite ? task.approvals!.map(approval => (
                      <div key={approval.gate} className="ml-8 mr-2 mb-1 flex items-center gap-2 rounded-md bg-warning/[0.06] px-2 py-1 text-xs">
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">{approval.note || 'Waiting for your approval'}</span>
                        <Button size="sm" className="h-6 px-2 text-xs" disabled={!!state.busy[task.id]} aria-label={`Approve ${task.id}`}
                          onClick={() => void controller.changeTask(task, { gate: approval.gate })}>Approve</Button>
                      </div>
                    )) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

/** The Board view: a column per state, scrolled sideways where it does not fit. */
function BoardView({ tasks, isCurrent, onOpen }: Pick & { tasks: TaskRow[] }) {
  const columns = React.useMemo(() => boardColumns(tasks), [tasks]);
  return (
    <div className="flex items-start gap-2.5 overflow-x-auto px-1 pb-2" data-testid="tasks-board-view">
      {columns.map(column => (
        <section key={column.key} aria-label={column.title} data-testid={`tasks-column-${column.key}`} className="flex max-h-[640px] w-[248px] shrink-0 flex-col rounded-[10px] border border-border bg-card">
          <h3 className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-semibold">
            <StateDot state={column.key} /><span className="flex-1">{column.title}</span><span className="font-normal tabular-nums text-muted-foreground">{column.tasks.length}</span>
          </h3>
          <ul className="min-h-0 space-y-2 overflow-y-auto p-2">
            {column.tasks.map(task => {
              const current = isCurrent(task.id);
              return (
                <li key={task.id}>
                  <button type="button" onClick={() => onOpen(task.id)} aria-current={current ? 'true' : undefined} title={task.title} data-testid="task-card"
                    className={cn('flex w-full flex-col gap-1 rounded-lg border border-l-[3px] border-border bg-background p-2.5 text-left hover:border-muted-foreground', CARD_EDGE[column.key], current && 'bg-sidebar-selected', focusRing)}>
                    <span className="flex w-full items-center gap-1.5 text-xs text-muted-foreground">
                      <Priority value={task.priority} />
                      <span className="font-mono">{task.id}</span>
                      <span className="flex-1" />
                      <span className="tabular-nums">{age(column.key === 'closed' ? task.closed?.at : task.updatedAt)}</span>
                    </span>
                    <span className={cn('line-clamp-3 text-[13px] leading-[18px]', column.key === 'closed' && 'text-muted-foreground')}>{task.title}</span>
                    {task.assignee ? <span className="truncate text-xs text-muted-foreground">@{task.assignee}</span> : null}
                    {task.blockedBy?.length ? <span className="truncate text-xs text-dot-danger">after {task.blockedBy.join(', ')}</span> : null}
                    {task.labels?.length ? <span className="flex flex-wrap gap-1.5 text-xs text-info">{task.labels.map(label => <span key={label}>#{label}</span>)}</span> : null}
                  </button>
                </li>
              );
            })}
            {!column.tasks.length ? <li className="px-1 py-2 text-xs text-muted-foreground">Nothing here</li> : null}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The Epics view: each epic with how far along it is, and its tasks as a tree. */
function EpicsView({ all, shown, isCurrent, onOpen }: Pick & { all: TaskRow[]; shown: TaskRow[] }) {
  const groups = React.useMemo(() => epicGroups(all, shown), [all, shown]);
  const [opened, setOpened] = React.useState<Record<string, boolean>>({});
  if (!groups.length) return <Empty text="No epics here. An epic is a task other tasks name as their parent." />;
  return (
    <ul className="space-y-2 px-1" data-testid="tasks-epics-view">
      {groups.map(({ epic, children, done, total, percent }) => {
        const expanded = opened[epic.id] ?? epic.status !== 'closed';
        const current = isCurrent(epic.id);
        return (
          <li key={epic.id} className="rounded-[10px] border border-border bg-card p-3" data-testid="epic">
            <button type="button" onClick={() => onOpen(epic.id)} aria-current={current ? 'true' : undefined} title={epic.title}
              className={cn('flex w-full min-w-0 items-center gap-2 rounded-md text-left', current && 'text-highlight', focusRing)}>
              <StateDot state={stateOf(epic)} />
              <Target aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <Priority value={epic.priority} />
              <span className="shrink-0 font-mono text-xs text-muted-foreground">{epic.id}</span>
              <span className={cn('min-w-0 flex-1 truncate text-sm', epic.status === 'closed' && 'text-muted-foreground line-through')}>{epic.title}</span>
              <span className="shrink-0 font-mono text-xs text-muted-foreground" data-testid="epic-progress">{done}/{total}</span>
            </button>
            <div role="progressbar" aria-label={`${epic.id} progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="mt-2 h-1.5 overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-dot-success" style={{ width: `${percent}%` }} />
            </div>
            {children.length ? (
              <button type="button" aria-expanded={expanded} onClick={() => setOpened(state => ({ ...state, [epic.id]: !expanded }))}
                className={cn('mt-2 flex items-center gap-1 rounded-md text-xs text-muted-foreground hover:text-foreground', focusRing)}>
                {expanded ? <ChevronDown aria-hidden className="size-3" /> : <ChevronRight aria-hidden className="size-3" />}
                {children.length} {children.length === 1 ? 'task' : 'tasks'}
              </button>
            ) : null}
            {expanded && children.length ? (
              <ul className="mt-1 border-l border-border pl-2" aria-label={`Tasks of ${epic.id}`}>
                {children.map(child => <li key={child.id}><TaskLine task={child} isCurrent={isCurrent} onOpen={onOpen} testId="epic-task" /></li>)}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
