import * as React from 'react';
import { Archive, Bot, ChevronLeft, ChevronRight, PanelLeft, RefreshCw, Search, X } from 'lucide-react';
import type { SessionSummary } from '../lib/controller.js';
import { attentionReason, needsInput } from '../lib/controller.js';
import { groupHistory } from '../lib/history.js';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { baseName, relativeTime, sessionName } from '../lib/format';
import { cn } from '../lib/utils';
import { useAppState, useController } from './store';

/*
 * Paseo's History screen (packages/app/src/screens/sessions-screen.tsx with components/agent-list.tsx):
 * a header, a search field, then every session of the workspace by the day of its last activity,
 * the archived ones too with an "Archived" badge. Choosing one opens it; an archived one opens
 * with Paseo's "This agent is archived" callout and its Unarchive button in place of the composer.
 * ALP lists one workspace at a time. A host that pages session.list (session.list.page) searches
 * on its side and gives Paseo's pages of 200 with Load more under them, as Paseo's History asks its
 * hosts (hooks/use-agent-history.ts); an older host lists everything and the search filters here.
 */

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring';
const headerButton = cn('flex size-8 shrink-0 items-center justify-center rounded-lg text-extra-muted hover:bg-secondary hover:text-foreground [&_svg]:size-[18px]', focusRing);

const STATUS: Record<string, string> = { initializing: 'Starting', idle: 'Idle', running: 'Running', error: 'Error', closed: 'Closed' };

/** The questions a root waits on: the open tree's own, else the workspace's question.list count. */
function pendingCount(state: ReturnType<typeof useAppState>, root: string) {
  if (state.tree?.rootId === root && state.tree.status === 'attached') return Object.keys(state.tree.projection.questions).length;
  return Math.max(state.attention[root] ?? 0, state.tree?.rootId === root ? Object.keys(state.tree.projection.questions).length : 0, 1);
}

/** Paseo's StatusBadge, muted or in the attention tone. */
function Badge({ children, tone = 'muted', icon, testId }: { children: React.ReactNode; tone?: 'muted' | 'warning' | 'success' | 'danger'; icon?: React.ReactNode; testId?: string }) {
  return (
    <span data-testid={testId} className={cn('inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-px text-xs leading-5',
      tone === 'warning' ? 'bg-dot-warning/15 text-dot-warning' : tone === 'success' ? 'bg-dot-success/15 text-dot-success' : tone === 'danger' ? 'bg-dot-danger/15 text-dot-danger' : 'bg-secondary text-muted-foreground')}>
      {icon}{children}
    </span>
  );
}

function HistoryRow({ session, project, selected, waiting, reason, onOpen }: { session: SessionSummary; project: string; selected: boolean; waiting: number; reason?: 'finished' | 'error'; onOpen: () => void }) {
  const name = sessionName(session);
  const when = relativeTime(session.updatedAt ?? session.createdAt);
  return (
    <button type="button" onClick={onOpen} data-testid="history-row" data-session={session.id} aria-current={selected ? 'true' : undefined}
      className={cn('flex w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2 text-left text-sm md:rounded-none', selected ? 'bg-secondary' : 'hover:bg-card active:bg-secondary', focusRing)}>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 md:flex-row md:items-center md:gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 truncate text-foreground max-md:hidden md:max-w-[320px]">{project}</span>
          <ChevronRight aria-hidden className="size-3 shrink-0 text-muted-foreground max-md:hidden" />
          <Bot aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate text-muted-foreground max-md:text-foreground" data-testid="history-row-title">{name}</span>
          {session.archived ? <Badge icon={<Archive aria-hidden className="size-3" />}>Archived</Badge> : null}
          {waiting ? <Badge tone="warning">{waiting} pending</Badge> : null}
          {!waiting && reason ? <Badge tone={reason === 'error' ? 'danger' : 'success'} testId="history-row-attention">{reason === 'error' ? 'Needs attention' : 'Finished'}</Badge> : null}
        </span>
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground md:hidden">
          <span className="truncate">{project}</span><span className="opacity-70">·</span><span className="truncate">{STATUS[session.status] ?? session.status}</span><span className="opacity-70">·</span><span className="shrink-0">{when}</span>
        </span>
      </span>
      <span className="hidden shrink-0 items-center gap-3 text-muted-foreground md:flex">
        <span className="w-[132px] truncate">{session.teamLabel ?? ''}</span>
        <span className="w-[72px] truncate">{STATUS[session.status] ?? session.status}</span>
        <span className="w-[72px] truncate text-right">{when}</span>
      </span>
    </button>
  );
}

export function HistoryScreen({ navOpen, onToggleNav, onOpen, onBack }: { navOpen: boolean; onToggleNav: () => void; onOpen: () => void; onBack: () => void }) {
  const controller = useController();
  const state = useAppState();
  const { history, workspace, selected, connection } = state;
  const [query, setQuery] = React.useState('');
  const [debounced, setDebounced] = React.useState('');
  const online = connection.phase === 'open';
  const paged = connection.capabilities.includes('session.list.page');
  React.useEffect(() => { const timer = setTimeout(() => setDebounced(query), 200); return () => clearTimeout(timer); }, [query]);
  // The query the host searches: none where the screen filters itself.
  const asked = paged ? debounced.trim() : '';
  // Read afresh each time it opens, while it stays open on a new connection or workspace, and for each query.
  React.useEffect(() => { if (workspace && online) void controller.loadHistory({ quiet: history.status === 'ready' && history.query === asked, query: asked }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [workspace, online, controller, asked]);
  const sections = React.useMemo(() => groupHistory(history.list, paged ? '' : debounced), [history.list, debounced, paged]);
  const project = workspace ? baseName(workspace) : '';
  const searching = !!debounced.trim();

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="history-screen">
      <header className="flex h-14 shrink-0 items-center gap-1 border-b border-border bg-background px-2 md:h-9 md:gap-2 md:px-3">
        <button type="button" aria-label={navOpen ? 'Close sessions' : 'Open sessions'} aria-expanded={navOpen} title="Toggle sidebar" onClick={onToggleNav} className={cn(headerButton, 'md:-ml-1.5')}>
          <PanelLeft aria-hidden strokeWidth={1.5} />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-sm font-normal text-foreground md:font-light">History</h1>
        <button type="button" aria-label="Refresh history" title="Refresh" onClick={() => void controller.loadHistory()} disabled={!online} className={cn(headerButton, 'md:-mr-1.5 disabled:opacity-45')}>
          <RefreshCw aria-hidden strokeWidth={1.5} className={cn(history.status === 'loading' && 'animate-spin')} />
        </button>
      </header>
      <div className="px-3 pt-4 md:px-6">
        <div className="flex h-9 w-full max-w-md items-center gap-2 rounded-lg border border-border bg-card px-2.5 focus-within:ring-1 focus-within:ring-ring">
          <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search history" aria-label="Search history" data-testid="history-search"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden" />
          {query ? (
            <button type="button" aria-label="Clear search" onClick={() => setQuery('')} className={cn('flex size-5 items-center justify-center rounded text-muted-foreground hover:text-foreground', focusRing)}><X aria-hidden className="size-3.5" /></button>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-4 md:px-6">
        {history.status === 'loading' && !history.list.length ? <div className="flex justify-center py-16"><Spinner label="Loading history…" /></div> : null}
        {history.status === 'error' && !history.list.length ? (
          <div role="alert" className="flex flex-col items-center gap-4 py-16 text-sm text-muted-foreground">
            <span>Unable to load sessions{history.error?.message ? `: ${history.error.message}` : ''}</span>
            <Button variant="ghost" onClick={() => void controller.loadHistory()}>Try again</Button>
          </div>
        ) : null}
        {history.status !== 'loading' && history.status !== 'error' && !sections.length ? (
          <div className="flex flex-col items-center gap-6 py-16 text-sm text-muted-foreground" data-testid="history-empty">
            <span>{searching ? 'No sessions match' : 'No sessions yet'}</span>
            {searching ? <Button variant="ghost" onClick={() => setQuery('')}>Clear search</Button>
              : <Button variant="ghost" onClick={onBack}><ChevronLeft aria-hidden /> Back</Button>}
          </div>
        ) : null}
        {sections.map(section => (
          <section key={section.id} aria-label={section.label} className="mb-2">
            <h2 className="mb-2 mt-2 px-3 text-sm font-medium text-muted-foreground">{section.label}</h2>
            <div className="flex flex-col gap-1 md:gap-0">
              {section.sessions.map(session => (
                <HistoryRow key={session.id} session={session} project={project} selected={session.id === selected} waiting={session.archived || !needsInput(state, session.id) ? 0 : pendingCount(state, session.id)}
                  reason={session.archived ? undefined : attentionReason(state, session.id)}
                  onOpen={() => { controller.selectSession(session.id); onOpen(); }} />
              ))}
            </div>
          </section>
        ))}
        {paged && history.nextCursor && history.status === 'ready' ? (
          <div className="flex items-center justify-center gap-3 py-4" data-testid="history-more">
            <Button variant="ghost" onClick={() => void controller.loadMoreHistory()} disabled={history.more === 'loading' || !online}>
              {history.more === 'loading' ? 'Loading...' : 'Load more'}
            </Button>
            {history.more === 'error' ? <span role="alert" className="text-sm text-destructive">Unable to load more sessions</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Paseo's ArchivedAgentCallout: in place of the composer while the open session is archived. */
export function ArchivedCallout({ sessionId }: { sessionId: string }) {
  const controller = useController();
  const { connection } = useAppState();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const unarchive = async () => {
    setPending(true);
    setError(null);
    try { await controller.restoreSession(sessionId); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setPending(false); }
  };
  return (
    <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4 md:pb-4">
      <div className="mx-auto flex w-full max-w-(--content-width) flex-col gap-2">
        <div className="flex items-center justify-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 md:px-6 md:py-4" data-testid="archived-callout">
          <span className="text-[15px] text-muted-foreground">This session is archived</span>
          <Button size="sm" variant="secondary" disabled={pending || connection.phase !== 'open'} onClick={() => void unarchive()}>Unarchive</Button>
        </div>
        {error ? <p role="alert" className="text-center text-sm text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}
