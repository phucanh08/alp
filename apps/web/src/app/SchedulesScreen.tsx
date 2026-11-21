import * as React from 'react';
import { CalendarClock, PanelLeft, RefreshCw, X } from 'lucide-react';
import type { ScheduleJob } from '@anhlp/alp-protocol';
import { baseName } from '../lib/format';
import { cn } from '../lib/utils';
import { FACTS_REFRESH_MS, excerpt, scheduleRows } from '../lib/sidebar-facts.js';
import { dateLabel } from '../lib/owner-host.js';
import { Spinner } from '../components/ui/spinner';
import { useAppState, useController } from './store';

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';
const headerButton = cn('flex size-8 shrink-0 items-center justify-center rounded-lg text-extra-muted hover:bg-secondary hover:text-foreground [&_svg]:size-[18px]', focusRing);

const STATUS_TONES: Record<ScheduleJob['status'], string> = {
  pending: 'bg-primary/15 text-highlight',
  delivered: 'bg-secondary text-muted-foreground',
  failed: 'bg-destructive/15 text-destructive',
  cancelled: 'bg-secondary text-muted-foreground',
};

/**
 * Paseo's Schedules screen, on ALP's scheduled wakes (t-ff83): the one-shot jobs alpd holds for
 * each workspace the sidebar lists (schedule.list per project root, host owner only), read only:
 * status, due time, the prompt's first line and the session it continues. ALP's schedules are
 * one-shot continuations of a root session, not Paseo's recurring agents, so there is no create,
 * pause or edit here.
 */
export function SchedulesScreen({ navOpen, onToggleNav, onClose, onOpenSession }: {
  navOpen: boolean; onToggleNav: () => void; onClose: () => void; onOpenSession: (projectRoot: string, sessionId: string) => void;
}) {
  const controller = useController();
  const { principal, registry, connection, owner } = useAppState();
  const roots = [...new Set([...(principal?.workspaces ?? []), ...registry.workspaces.filter(row => row.managedWorktree && !row.archivedAt).map(row => row.directory)])];
  const rootKey = roots.join('\n');
  const [jobs, setJobs] = React.useState<ScheduleJob[] | null>(null);
  const [errors, setErrors] = React.useState<string[]>([]);
  const [pending, setPending] = React.useState(false);
  const online = connection.phase === 'open' && owner;
  const load = React.useCallback(async () => {
    if (!online) return;
    setPending(true);
    const failures: string[] = [];
    const answers = await Promise.all((rootKey ? rootKey.split('\n') : []).map(async projectRoot => {
      try {
        const result = await controller.ownerRequest('schedule.list', { projectRoot });
        return [projectRoot, Array.isArray(result?.jobs) ? result.jobs : []] as const;
      } catch (cause) {
        failures.push(`${baseName(projectRoot)}: ${cause instanceof Error ? cause.message : String(cause)}`);
        return [projectRoot, []] as const;
      }
    }));
    setJobs(scheduleRows(Object.fromEntries(answers)) as ScheduleJob[]);
    setErrors(failures);
    setPending(false);
  }, [controller, online, rootKey]);
  React.useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), FACTS_REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if (document.querySelector('dialog[open], [role="menu"], [data-modal-overlay]')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <section aria-label="Schedules" data-testid="schedules-screen" className="flex min-h-0 flex-1 flex-col bg-background text-foreground">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2 md:h-9 md:px-3">
        <button type="button" aria-label={navOpen ? 'Close sessions' : 'Open sessions'} aria-expanded={navOpen} title="Toggle sidebar" onClick={onToggleNav} className={cn(headerButton, 'md:-ml-1.5')}>
          <PanelLeft aria-hidden strokeWidth={1.5} />
        </button>
        <CalendarClock aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 truncate text-sm">Schedules</h1>
        <span className="flex-1" />
        <button type="button" className={headerButton} aria-label="Refresh schedules" title="Refresh" disabled={pending} onClick={() => void load()}>
          <RefreshCw aria-hidden strokeWidth={1.5} className={cn(pending && 'animate-spin')} />
        </button>
        <button type="button" className={headerButton} aria-label="Close schedules" title="Close" onClick={onClose} data-testid="schedules-screen-close">
          <X aria-hidden strokeWidth={1.5} />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
          <p className="text-xs text-muted-foreground">Scheduled wakes alpd holds for this host's workspaces: each opens one new turn on its session at the due time. Agents create them; this list is read only.</p>
          {errors.map(error => <p key={error} role="alert" className="text-xs text-destructive">Could not read schedules of {error}</p>)}
          {jobs === null ? <Spinner label="Loading schedules…" className="text-xs" />
            : !jobs.length ? <p className="rounded-lg border border-border px-4 py-6 text-center text-sm text-muted-foreground" data-testid="schedules-empty">No scheduled wakes</p>
            : (
              <ul className="overflow-hidden rounded-lg border border-border">
                {jobs.map((job, index) => (
                  <li key={job.id} className={cn('flex flex-col gap-1 px-4 py-3', index > 0 && 'border-t border-border')} data-testid="schedule-row" data-schedule-id={job.id} data-status={job.status}>
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs', STATUS_TONES[job.status] ?? STATUS_TONES.cancelled)} data-testid="schedule-status">{job.status}</span>
                      <span className="text-foreground" title={job.dueAt} data-testid="schedule-due">Due {dateLabel(job.dueAt)}</span>
                      <span className="text-xs text-muted-foreground" title={job.projectRoot}>{baseName(job.projectRoot)}</span>
                      <span className="flex-1" />
                      <button type="button" className={cn('text-xs text-highlight underline-offset-4 hover:underline', focusRing)} onClick={() => onOpenSession(job.projectRoot, job.sessionId)} data-testid="schedule-session">
                        Open session
                      </button>
                    </div>
                    <p className="truncate text-sm text-muted-foreground" title={job.prompt} data-testid="schedule-prompt">{excerpt(job.prompt)}</p>
                    {job.lastError ? <p className="text-xs text-destructive">{job.lastError.message}</p> : null}
                  </li>
                ))}
              </ul>
            )}
        </div>
      </div>
    </section>
  );
}
