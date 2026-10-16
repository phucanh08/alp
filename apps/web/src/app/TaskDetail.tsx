import * as React from 'react';
import { Check, CircleDot, Lock, RotateCcw, ShieldCheck } from 'lucide-react';
import { can } from '../lib/gateway.js';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { relativeTime } from '../lib/format';
import { cn } from '../lib/utils';
import { RichText } from './RichText';
import { useAppState, useController } from './store';
import { useTabs } from './tabs';

const STATUS_LABEL: Record<string, string> = { open: 'Open', in_progress: 'In progress', review: 'In review', closed: 'Closed' };
const STATUS_TONE: Record<string, string> = { open: 'text-muted-foreground', in_progress: 'text-dot-running', review: 'text-dot-warning', closed: 'text-highlight' };

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** One task in full, in a tab of its own: what task.list says about it, and what can be done to it. */
export function TaskDetail({ id }: { id: string }) {
  const controller = useController();
  const { openTask } = useTabs();
  const { tasks, principal } = useAppState();
  const row = tasks.rows.find(entry => entry.id === id);
  const canWrite = can(principal ?? undefined, 'project.write');
  const blocked = controller.tasksBlock();
  React.useEffect(() => {
    controller.setTasksVisible(true);
    return () => controller.setTasksVisible(false);
  }, [controller]);

  if (blocked) return <p className="m-auto flex max-w-sm items-start gap-2 px-6 text-sm text-muted-foreground"><Lock aria-hidden className="mt-0.5 size-4 shrink-0" />{blocked}</p>;
  if (!row) {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        {tasks.status === 'loading' || tasks.status === 'idle' ? <Spinner label="Loading the task…" /> : (
          <p className="max-w-sm text-center text-sm text-muted-foreground" role="status">Task {id} is no longer in this workspace's list.</p>
        )}
      </div>
    );
  }

  const busy = !!tasks.busy[row.id];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" data-testid="task-detail">
      <article className="mx-auto w-full max-w-[820px] px-4 py-6 sm:px-6">
        <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="font-mono">{row.id}</span>
          {row.type ? <span>· {row.type}</span> : null}
          <span>· P{row.priority}</span>
          <span className={cn('inline-flex items-center gap-1', STATUS_TONE[row.status])}><CircleDot aria-hidden className="size-3" />{STATUS_LABEL[row.status] ?? row.status}</span>
          {row.status !== 'closed' && row.ready ? <span className="text-info">· ready</span> : null}
        </p>
        <h2 className={cn('text-xl font-normal leading-snug', row.status === 'closed' && 'text-muted-foreground')}>{row.title}</h2>

        {tasks.message?.level === 'error' ? (
          <p role={tasks.message.level === 'error' ? 'alert' : 'status'} className={cn('mt-4 rounded-md px-3 py-2 text-xs', tasks.message.level === 'error' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-highlight')}>{tasks.message.text}</p>
        ) : null}

        {row.approvals?.map((approval: { gate: string; note: string }) => (
          <div key={approval.gate} className="mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-warning/40 bg-warning/[0.06] px-4 py-3 text-sm">
            <ShieldCheck aria-hidden className="size-4 shrink-0 text-warning" />
            <span className="min-w-0 flex-1"><span className="text-warning">Needs your approval</span>{approval.note ? <span className="text-muted-foreground">: {approval.note}</span> : null}</span>
            {canWrite ? <Button size="sm" disabled={busy} onClick={() => void controller.changeTask(row, { gate: approval.gate })}>Approve</Button> : null}
          </div>
        ))}

        <div className="mt-4 flex flex-wrap gap-2">
          {canWrite ? (
            row.status === 'closed'
              ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void controller.changeTask(row, { action: 'reopen' })}><RotateCcw aria-hidden /> Reopen</Button>
              : <Button size="sm" variant="secondary" disabled={busy} onClick={() => void controller.changeTask(row, { action: 'close' })}><Check aria-hidden /> Close task</Button>
          ) : <p className="text-xs text-muted-foreground">Your access token can read tasks but not change them.</p>}
          {busy ? <Spinner label="Saving…" className="text-xs" /> : null}
        </div>

        {row.description ? (
          <section aria-label="Description" className="mt-6 text-[15px] leading-[1.5]"><RichText text={row.description} /></section>
        ) : <p className="mt-6 text-sm text-muted-foreground">No description.</p>}

        {row.handoff ? (
          <section aria-label="Handoff" className="mt-6 rounded-xl border border-border bg-card px-4 py-3">
            <p className="mb-1 text-xs text-muted-foreground">Handoff · {row.handoff.outcome}{row.handoff.agent ? ` · ${row.handoff.agent}` : ''}</p>
            <p className="whitespace-pre-wrap text-sm">{row.handoff.summary}</p>
          </section>
        ) : null}
        {row.closed ? (
          <section aria-label="Closed" className="mt-4 rounded-xl border border-border bg-card px-4 py-3">
            <p className="mb-1 text-xs text-muted-foreground">Closed {relativeTime(row.closed.at)} · {row.closed.reason}</p>
            {row.closed.summary ? <p className="whitespace-pre-wrap text-sm">{row.closed.summary}</p> : null}
          </section>
        ) : null}

        <dl className="mt-6 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 border-t border-border pt-4 text-sm">
          {row.assignee ? <Field label="Assignee">{row.assignee}</Field> : null}
          {row.progress ? <Field label="Progress">{row.progress.done} of {row.progress.total} done</Field> : null}
          {row.parent ? <Field label="Parent"><button type="button" className="font-mono text-highlight hover:underline" onClick={() => openTask(row.parent)}>{row.parent}</button></Field> : null}
          {row.blockedBy?.length ? <Field label="Blocked by">{row.blockedBy.map((other: string, index: number) => <React.Fragment key={other}>{index ? ', ' : ''}<button type="button" className="font-mono text-highlight hover:underline" onClick={() => openTask(other)}>{other}</button></React.Fragment>)}</Field> : null}
          {row.waits?.length ? <Field label="Waits on">{row.waits.join('; ')}</Field> : null}
          {row.labels?.length ? <Field label="Labels"><span className="flex flex-wrap gap-1">{row.labels.map((label: string) => <span key={label} className="rounded-full bg-secondary px-2 py-0.5 text-xs">{label}</span>)}</span></Field> : null}
          {row.paths?.length ? <Field label="Paths"><span className="space-y-0.5">{row.paths.map((path: string) => <span key={path} className="block font-mono text-xs">{path}</span>)}</span></Field> : null}
          {row.createdAt ? <Field label="Created">{relativeTime(row.createdAt)}</Field> : null}
          <Field label="Updated">{relativeTime(row.updatedAt)}</Field>
        </dl>
      </article>
    </div>
  );
}
