import * as React from 'react';
import { GitBranch, GitFork, History, RotateCcw, Undo2 } from 'lucide-react';
import { Button } from '../components/ui/button';
import { Dialog } from '../components/ui/dialog';
import { cn } from '../lib/utils';
import { newConversationRequestId } from '../lib/ids.js';
import { FORK_FILES_NOTE, REWIND_FILES_NOTE, branchTurns, conversationMarker, describeConversationError, laterTurns, turnCount } from '../lib/conversation.js';
import { useAppState, useController } from './store';

/*
 * Conversation fork and rewind in the timeline (docs/protocol/alp-json-rpc-v1.md §12.7): "Rewind to
 * here…" on a user message that started a turn (not the first), "Fork from here…" after a finished
 * turn, the rewind marker with "Restore as new session", and a fork's provenance. Both change only
 * the conversation; every place that offers them says files are not changed, copied or restored.
 *
 * Request ids: one per user action. The same id goes again only when the answer was lost
 * (describeConversationError().retrySame); every other outcome takes a new one next time.
 */

type Gate = { shown: boolean; reason?: string };
export type TurnInfo = { turnId: string; index: number; later: number; rewindable: boolean; ended: boolean; text: string };

type ConversationValue = {
  root: string;
  fork: Gate;
  rewind: Gate;
  /** User message entry key → its turn. */
  turns: Map<string, TurnInfo>;
  /** Asks to rewind before the turn of this user message. */
  askRewind: (entryKey: string) => void;
  /** Asks to fork through this turn. */
  askFork: (turnId: string) => void;
};

export const ConversationContext = React.createContext<ConversationValue | null>(null);
export const useConversation = () => React.useContext(ConversationContext);

/** A request id for one user action, kept for a retry only when the answer was lost. */
function useRequestId() {
  const id = React.useRef<string | null>(null);
  return {
    take: () => (id.current ??= newConversationRequestId()),
    settle: (retrySame: boolean) => { if (!retrySame) id.current = null; },
    reset: () => { id.current = null; },
  };
}

/** The user message's action: rewind the conversation to before it. */
export function RewindAction({ entryKey }: { entryKey: string }) {
  const value = useConversation();
  const turn = value?.turns.get(entryKey);
  if (!value || !value.rewind.shown || !turn?.rewindable) return null;
  return (
    <button type="button" data-testid="rewind-action" aria-label="Rewind to here…" title={value.rewind.reason ?? 'Rewind to here… (the conversation only; files are not changed)'}
      disabled={!!value.rewind.reason} onClick={() => value.askRewind(entryKey)}
      className="flex shrink-0 items-center gap-1 rounded p-1 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45 [&_svg]:size-3.5">
      <Undo2 aria-hidden /><span>Rewind to here…</span>
    </button>
  );
}

/** A finished turn's action (in its footer): fork the conversation through it. */
export function ForkAction({ userKeys }: { userKeys: string[] }) {
  const value = useConversation();
  if (!value || !value.fork.shown) return null;
  // The turn this footer closes: the last user message of the group that started one.
  const turn = [...userKeys].reverse().map(key => value.turns.get(key)).find(Boolean);
  if (!turn?.ended) return null;
  return (
    <button type="button" data-testid="fork-action" aria-label="Fork from here…" title={value.fork.reason ?? 'Fork from here… (a new session with this conversation; files are not copied)'}
      disabled={!!value.fork.reason} onClick={() => value.askFork(turn.turnId)}
      className="flex shrink-0 items-center gap-1 rounded p-1 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-45 [&_svg]:size-3.5">
      <GitFork aria-hidden /><span>Fork from here…</span>
    </button>
  );
}

/** The confirmation of a rewind: what goes back, what is kept, and that files do not change. */
export function RewindDialog({ turn, onClose, onDone }: { turn: TurnInfo | null; onClose: () => void; onDone: (text: string) => void }) {
  const controller = useController();
  const request = useRequestId();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { setError(null); request.reset(); }, [turn?.turnId]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { if (!busy) onClose(); };
  const confirm = async () => {
    if (!turn) return;
    setBusy(true); setError(null);
    try {
      await controller.rewindConversation({ beforeTurnId: turn.turnId, requestId: request.take() });
      request.reset();
      onDone(turn.text);
    } catch (failure) {
      const described = describeConversationError(failure);
      request.settle(described.retrySame);
      setError(described.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={!!turn} onClose={close} title="Rewind conversation" className="w-[min(92vw,34rem)]"
      footer={<>
        <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
        <Button variant="destructive" onClick={() => void confirm()} disabled={busy} data-testid="rewind-confirm"><Undo2 aria-hidden />{busy ? 'Rewinding…' : error ? 'Try again' : 'Rewind'}</Button>
      </>}>
      {turn ? (
        <div className="space-y-3 text-sm" data-testid="rewind-dialog">
          <p>The conversation goes back to <strong>before this message</strong>, under the same session. The agent continues from there and no longer sees what came after.</p>
          <blockquote className="max-h-28 overflow-y-auto whitespace-pre-wrap rounded-md border-l-2 border-border bg-muted/50 px-3 py-2 text-muted-foreground [overflow-wrap:anywhere]">{turn.text || '(no text)'}</blockquote>
          <p>This message and what came after it ({turnCount(turn.later)}) move to a branch. The branch is kept: you can restore it as a new session from the timeline.</p>
          <p className="rounded-md bg-[rgba(245,158,11,0.1)] px-3 py-2 font-medium" data-testid="rewind-files-note">{REWIND_FILES_NOTE} Undo file changes yourself if you need to.</p>
          <p className="text-muted-foreground">The message is put back in the composer so you can edit and send it again.</p>
          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/** The fork dialog: where the fork runs (this workspace, or a new worktree), and that files are not copied. */
export function ForkDialog({ turnId, title, onClose }: { turnId: string | null; title: string; onClose: () => void }) {
  const controller = useController();
  const { registry, connection } = useAppState();
  const request = useRequestId();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState<'tab' | 'worktree'>('tab');
  const [mappings, setMappings] = React.useState<string[] | null>(null);
  const [mapping, setMapping] = React.useState('');
  const source = controller.worktreeForkSource();
  // One worktree per opening of the dialog: a fork refused after its worktree was made reuses it.
  const worktreeKey = React.useRef<string | null>(null);
  void registry;
  const worktrees = !!source && connection.phase === 'open';
  React.useEffect(() => {
    setError(null); setTarget('tab'); request.reset(); worktreeKey.current = null;
    if (!turnId || !worktrees) return;
    let live = true;
    controller.worktreeForkDestinations().then(ids => { if (live) { setMappings(ids); setMapping(ids[0] ?? ''); } }, () => { if (live) setMappings([]); });
    return () => { live = false; };
  }, [turnId, worktrees]); // eslint-disable-line react-hooks/exhaustive-deps
  const close = () => { if (!busy) onClose(); };
  const confirm = async () => {
    if (!turnId) return;
    setBusy(true); setError(null);
    // No title: the host names the fork, "<source> (fork)" here, a neutral name in another workspace.
    try {
      if (target === 'worktree') {
        const requestId = request.take();
        worktreeKey.current ??= requestId;
        // One worktree per destination chosen in this dialog: another mapping makes its own.
        await controller.forkIntoWorktree({ requestId, worktreeKey: `${worktreeKey.current}:${mapping}`, mappingId: mapping, boundary: { throughTurnId: turnId } });
      }
      else await controller.forkConversation({ requestId: request.take(), boundary: { throughTurnId: turnId } });
      request.reset();
      onClose();
    } catch (failure) {
      const described = describeConversationError(failure);
      request.settle(described.retrySame);
      setError(described.message);
    } finally {
      setBusy(false);
    }
  };
  const option = (value: 'tab' | 'worktree', label: string, detail: string, disabled = false) => (
    <label className={cn('flex cursor-pointer items-start gap-2 rounded-md border border-border p-2', target === value && 'border-ring bg-accent/40', disabled && 'cursor-not-allowed opacity-50')}>
      <input type="radio" name="fork-target" className="mt-1" checked={target === value} disabled={disabled || busy} onChange={() => setTarget(value)} aria-label={label} />
      <span><span className="block font-medium">{label}</span><span className="block text-muted-foreground">{detail}</span></span>
    </label>
  );
  return (
    <Dialog open={!!turnId} onClose={close} title="Fork conversation" className="w-[min(92vw,34rem)]"
      footer={<>
        <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
        <Button onClick={() => void confirm()} disabled={busy || (target === 'worktree' && !mapping)} data-testid="fork-confirm"><GitFork aria-hidden />{busy ? 'Forking…' : error ? 'Try again' : 'Fork'}</Button>
      </>}>
      {turnId ? (
        <div className="space-y-3 text-sm" data-testid="fork-dialog">
          <p>A new session continues this conversation from the end of this turn. This session stays as it is.</p>
          <div className="space-y-2" role="radiogroup" aria-label="Where the fork runs">
            {option('tab', 'In a new tab', 'Same workspace: the new session opens in its own tab.')}
            {worktrees ? option('worktree', 'In a new worktree', 'A clean checkout of the last commit, made first; uncommitted changes here are not in it.') : null}
          </div>
          {target === 'worktree' ? (
            mappings === null ? <p className="text-muted-foreground">Loading destinations…</p>
              : mappings.length ? (
                <label className="block">Destination
                  <select aria-label="Worktree destination" className="mt-1 w-full rounded border border-border bg-background p-1" value={mapping} onChange={event => setMapping(event.target.value)} disabled={busy}>
                    {mappings.map(id => <option key={id}>{id}</option>)}
                  </select>
                </label>
              ) : <p className="text-muted-foreground">Ask the host owner to configure a worktree destination and grant it to this credential.</p>
          ) : null}
          <p className="rounded-md bg-[rgba(147,197,253,0.1)] px-3 py-2 font-medium" data-testid="fork-files-note">{FORK_FILES_NOTE} Only the conversation is forked.</p>
          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/** A divider between two rules, as the compaction marker. */
function Divider({ children, testId }: { children: React.ReactNode; testId: string }) {
  return (
    <div className="flex items-center gap-2 px-1 py-3 text-[13px] text-muted-foreground" data-testid={testId} role="note">
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
      <span className="flex min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center [&_svg]:size-3.5">{children}</span>
      <span aria-hidden className="h-px min-w-6 flex-1 bg-border" />
    </div>
  );
}

/** The rewind marker: where the conversation went back, the kept branch, and Restore as new session. */
function RewindMarker({ item, branchId }: { item: any; branchId: string }) {
  const controller = useController();
  const value = useConversation();
  const summary = controller.rootSummary(value?.root);
  const turns = branchTurns(item, summary.branches, branchId);
  const request = useRequestId();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const restore = async () => {
    setBusy(true); setError(null);
    try {
      await controller.forkConversation({ requestId: request.take(), branchId, title: `${summary.title || 'Session'} (restored)` });
      request.reset();
    } catch (failure) {
      const described = describeConversationError(failure);
      request.settle(described.retrySame);
      setError(described.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col items-stretch pb-4" data-branch-id={branchId}>
      <Divider testId="rewind-marker">
        <History aria-hidden />
        <span>Conversation rewound here{typeof turns === 'number' ? ` — ${laterTurns(turns)} kept in a branch` : ' — the later turns are kept in a branch'}. Files were not changed.</span>
        {value?.fork.shown ? (
          <Button size="sm" variant="secondary" className="h-7" disabled={busy || !!value.fork.reason} title={value.fork.reason} onClick={() => void restore()} data-testid="restore-branch">
            <RotateCcw aria-hidden />{busy ? 'Restoring…' : 'Restore as new session'}
          </Button>
        ) : null}
      </Divider>
      {error ? <p role="alert" className="self-center pb-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** A fork's marker: where it came from, with a link to the source when it is listed here. */
function ForkMarker({ item }: { item: any }) {
  const controller = useController();
  const { sessions } = useAppState();
  const value = useConversation();
  const from = controller.rootSummary(value?.root).forkedFrom;
  const source = from ? sessions.list.find(row => row.id === from.sessionId) : undefined;
  const how = from?.branchId ? 'a restored branch of' : from?.boundary === 'before' ? 'before a message of' : from?.boundary === 'through' ? 'a turn of' : 'the conversation of';
  return (
    <Divider testId="fork-marker">
      <GitBranch aria-hidden />
      {from ? (
        <span>Forked from {how}{' '}
          {source ? <button type="button" className="text-highlight underline-offset-4 hover:underline" onClick={() => controller.selectSession(source.id)} data-testid="fork-source">{source.title || source.id}</button> : <span>another session</span>}
          . Files were not copied.</span>
      ) : <span>{item.text || 'Forked from another session. Files were not copied.'}</span>}
    </Divider>
  );
}

/** A notice that is a conversation marker, rendered as one; null for any other notice. */
export function ConversationMarker({ item }: { item: any }) {
  const marker = conversationMarker(item);
  if (!marker) return null;
  return marker.kind === 'rewind' ? <RewindMarker item={item} branchId={marker.branchId} /> : <ForkMarker item={item} />;
}
