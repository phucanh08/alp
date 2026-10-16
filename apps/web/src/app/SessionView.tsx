import type { ReactNode } from 'react';
import { ArrowLeft, Bot, CircleAlert, Cpu, MessageSquarePlus, RotateCcw, ShieldCheck } from 'lucide-react';
import { can } from '../lib/gateway.js';
import { entriesOf } from '../lib/timeline.js';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { modeLabel } from '../lib/format';
import { Composer } from './Composer';
import { QuestionCard } from './QuestionCard';
import { Timeline } from './Timeline';
import { useAppState, useController } from './store';
import { useTabs } from './tabs';

/** What the center shows with no tab open (Paseo's new-tab launcher, for sessions). */
export function Empty({ onNewSession }: { onNewSession: () => void }) {
  const { principal, workspace, sessions } = useAppState();
  const canWrite = can(principal ?? undefined, 'session.write');
  return (
    <div className="flex flex-1 items-center justify-center px-6 py-16">
      <div className="max-w-sm text-center">
        <span className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary/10 text-highlight"><MessageSquarePlus aria-hidden className="size-6" /></span>
        <h2 className="text-base font-medium">{workspace ? 'Pick a session or start a new one' : 'Choose a workspace'}</h2>
        <p className="mt-1.5 text-sm text-muted-foreground">
          {workspace ? (sessions.list.length ? 'Your sessions run on the host and keep their history between visits.' : 'This workspace has no sessions yet.') : 'Your access token decides which workspaces you can open.'}
        </p>
        {workspace && canWrite ? <Button className="mt-5" onClick={onNewSession}><MessageSquarePlus aria-hidden /> New session</Button> : null}
      </div>
    </div>
  );
}

/** An agent control as Paseo's composer toolbar shows one (icon and value), read-only: set when the session started. */
function Control({ icon, label, title }: { icon: ReactNode; label: string; title: string }) {
  return (
    <span title={title} className="inline-flex h-7 min-w-0 shrink items-center gap-1 rounded-2xl px-2 text-sm text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0">
      {icon}<span className="truncate">{label}</span>
    </span>
  );
}

/** One agent's conversation: the timeline, its questions and, for the main agent, the composer. */
export function ChatPanel({ sessionId }: { sessionId: string }) {
  const controller = useController();
  const { openAgent } = useTabs();
  const { tree, prompts, queued, busy, sessions, connection, preferences } = useAppState();
  if (!tree) return null;
  const projection = tree.projection;
  const root = tree.rootId;
  const viewing = sessionId;
  const listed = sessions.list.find(session => session.id === root);
  const rootSession = projection.sessions[root];
  const agentOf = (id: string) => projection.sessions[id]?.agent ?? (id === root ? 'main' : 'agent');
  const running = root in projection.running;
  const viewingRunning = viewing in projection.running;
  const closed = !!projection.closed[root] || (!rootSession && listed?.status === 'closed');
  const questions = Object.values(projection.questions);
  const blocked = controller.driveBlock();
  const pending = prompts.filter(prompt => prompt.rootId === root);

  if (tree.status === 'gone') {
    return (
      <div className="flex flex-1 items-center justify-center px-6">
        <div className="max-w-sm text-center" role="alert">
          <CircleAlert aria-hidden className="mx-auto mb-3 size-8 text-destructive" />
          <h2 className="font-medium">This session is no longer available</h2>
          <p className="mt-1.5 text-sm text-muted-foreground">{tree.error?.message ?? 'The host no longer has it, or your access token cannot see it.'}</p>
          <Button className="mt-4" variant="secondary" onClick={() => { controller.selectSession(null); void controller.refreshSessions(); }}>Back to sessions</Button>
        </div>
      </div>
    );
  }

  const loading = tree.status === 'attaching' || tree.status === 'detached';
  const entries = entriesOf(projection, viewing);
  const team = rootSession?.teamLabel ?? listed?.teamLabel;
  const mode = rootSession?.mode ?? listed?.mode;
  const model = rootSession?.model;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {tree.status === 'error' ? (
        <div role="alert" className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <span className="min-w-0 flex-1">{tree.error?.message ?? 'Could not load this session.'}</span>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => controller.retryAttach()}><RotateCcw aria-hidden /> Try again</Button>
        </div>
      ) : null}
      {loading && !entries.length ? (
        <div className="flex flex-1 items-center justify-center"><Spinner label={connection.phase === 'open' ? 'Loading conversation…' : 'Waiting for the connection…'} /></div>
      ) : (
        <Timeline
          entries={entries}
          prompts={viewing === root ? pending : []}
          agentOf={agentOf}
          running={viewingRunning}
          runningAgent={agentOf(viewing)}
          historyUnavailable={projection.historyUnavailable}
          onRetry={id => void controller.retryPrompt(id)}
          onDiscard={id => controller.discardPrompt(id)}
          emptyText={viewing === root ? (closed ? 'Nothing here yet.' : 'Send a message to start.') : 'This agent has not written anything yet.'}
        />
      )}
      {questions.length ? (
        <div className="px-3 pb-3 md:px-4">
          <div className="mx-auto flex w-full max-w-[820px] flex-col gap-2 px-2">
          {questions.map(question => (
            <QuestionCard key={question.id} question={question} busy={!!busy[`question:${question.id}`]} blocked={blocked}
              onAnswer={text => void controller.answerQuestion(question.id, { text })} onDecline={() => void controller.answerQuestion(question.id, { dismiss: true })} />
          ))}
          </div>
        </div>
      ) : null}
      {viewing === root ? (
        <>
          {closed && !running ? <p className="mx-auto w-full max-w-[820px] px-4 pb-2 text-center text-xs text-muted-foreground">This session is closed on the host. Sending a message reopens it.</p> : null}
          <Composer
            onSend={text => controller.sendPrompt(text)}
            onQueue={text => controller.queuePrompt(text)}
            onStop={() => void controller.interrupt()}
            queued={queued.filter(item => item.rootId === root)}
            onEditQueued={id => controller.editQueued(id)}
            onSendQueued={id => void controller.sendQueuedNow(id)}
            running={running}
            stopping={!!busy.interrupt}
            blocked={blocked}
            disabledReason={connection.phase !== 'open' ? 'Reconnecting…' : loading ? 'Loading…' : undefined}
            placeholder={`Message ${agentOf(root)}…`}
            sendBehavior={preferences.sendBehavior}
            controls={<>
              {team ? <Control icon={<Bot aria-hidden />} label={team} title="Team, set when the session started" /> : null}
              {mode ? <Control icon={<ShieldCheck aria-hidden />} label={modeLabel(mode)} title="Permissions, set when the session started" /> : null}
              {model ? <Control icon={<Cpu aria-hidden />} label={model} title="Main agent's model" /> : null}
            </>}
          />
        </>
      ) : (
        <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4 md:pb-4">
          <div className="mx-auto flex w-full max-w-[820px] items-center gap-3 rounded-2xl border border-dotted border-input bg-card px-3 py-2 text-[15px] leading-[21px] text-muted-foreground md:px-4 md:py-3">
            <span className="min-w-0 flex-1">{agentOf(viewing)} works on an assignment from main. Talk to main to steer it.</span>
            <Button size="sm" variant="secondary" onClick={() => openAgent(root)}><ArrowLeft aria-hidden /> Main</Button>
          </div>
        </div>
      )}
    </div>
  );
}
