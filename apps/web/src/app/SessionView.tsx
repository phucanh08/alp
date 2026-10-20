import type { ReactNode } from 'react';
import { ArrowLeft, Bot, ChevronDown, CircleAlert, MessageSquarePlus, RotateCcw, Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Menu } from '../components/ui/menu';
import { cn } from '../lib/utils';
import { TasksPill } from './chat/tracks';
import { can } from '../lib/gateway.js';
import { entriesOf } from '../lib/timeline.js';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { modeLabel } from '../lib/format';
import { Composer } from './Composer';
import { ContextMeter } from './ContextMeter';
import { ArchivedCallout } from './History';
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

export const controlClass = 'inline-flex h-7 min-w-0 shrink items-center gap-1 rounded-2xl px-2 text-sm text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0';

/** An agent control as Paseo's composer toolbar shows one (icon and value), read-only: set when the session started. */
function Control({ icon, label, title }: { icon: ReactNode; label: string; title: string }) {
  return (
    <span title={title} className={controlClass}>
      {icon}<span className="truncate">{label}</span>
    </span>
  );
}

const MODE_ICONS: Record<string, typeof Shield> = { 'read-only': Shield, 'workspace-write': ShieldCheck, 'full-access': ShieldAlert };
const modeIcon = (mode: string | undefined) => (mode && MODE_ICONS[mode]) || ShieldCheck;

/** Paseo's mode control: the session's permissions mode, a menu of the modes the token allows. */
export function ModeControl({ mode, modes, disabled, locked, onSelect }: { mode: string; modes: Array<{ id: string; label?: string }>; disabled: boolean; locked: boolean; onSelect: (mode: string) => void }) {
  const Icon = modeIcon(mode);
  const label = modes.find(entry => entry.id === mode)?.label ?? modeLabel(mode);
  if (modes.length < 2 && modes[0]?.id === mode) return <Control icon={<Icon aria-hidden />} label={label} title="Permissions" />;
  return (
    <Menu label="Permissions" title={locked ? `Permissions: ${label}. They change once the agent and its team are idle.` : `Permissions: ${label}`} align="start" disabled={disabled}
      triggerClassName={cn(controlClass, 'outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground disabled:pointer-events-none disabled:opacity-60')}
      trigger={<><Icon aria-hidden /><span className="truncate" data-testid="mode-control-label">{label}</span><ChevronDown aria-hidden className="!size-3 opacity-70" /></>}
      items={modes.map(entry => {
        const EntryIcon = modeIcon(entry.id);
        return { id: entry.id, label: entry.label ?? modeLabel(entry.id), icon: <EntryIcon aria-hidden />, checked: entry.id === mode, onSelect: () => { if (entry.id !== mode) onSelect(entry.id); } };
      })} />
  );
}

/** One agent's conversation: the timeline, its questions and, for the main agent, the composer. */
export function ChatPanel({ sessionId }: { sessionId: string }) {
  const controller = useController();
  const { openAgent } = useTabs();
  const { tree, prompts, queued, busy, sessions, connection, preferences, catalog, principal } = useAppState();
  if (!tree) return null;
  const projection = tree.projection;
  const root = tree.rootId;
  const viewing = sessionId;
  const listed = sessions.list.find(session => session.id === root);
  const rootSession = projection.sessions[root];
  const agentOf = (id: string) => projection.sessions[id]?.agent ?? (id === root ? 'main' : 'agent');
  const running = root in projection.running;
  // Working as the composer sees it: also while a message of ours is on its way to a turn.
  const working = running || controller.rootBusy(root);
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
  const canWrite = can(principal ?? undefined, 'session.write');
  const modes = catalog.modes.length ? catalog.modes : mode ? [{ id: mode }] : [];
  // The host changes permissions only between turns, with no child session running.
  const modeLocked = working || Object.keys(projection.running).length > 0;
  const canCycle = !!mode && modes.length > 1 && !busy.mode && !blocked && canWrite && !modeLocked && connection.phase === 'open';
  const cycleMode = () => {
    if (!canCycle) return;
    const at = modes.findIndex(entry => entry.id === mode);
    void controller.configureMode(modes[(at + 1) % modes.length].id);
  };
  // The tasks this session's tree worked on: the latest todo of the main agent's timeline.
  const todo = viewing === root ? [...entries].reverse().find(entry => (entry.item as any).kind === 'todo') : undefined;
  const worked = ((todo?.item as any)?.items ?? []) as Array<{ id: string; text: string; status: string }>;
  const questionCards = questions.length ? questions.map(question => (
    <QuestionCard key={question.id} question={question} busy={!!busy[`question:${question.id}`]} blocked={blocked}
      onAnswer={text => void controller.answerQuestion(question.id, { text })} onDecline={() => void controller.answerQuestion(question.id, { dismiss: true })} />
  )) : null;
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
          older={tree.older}
          onLoadOlder={() => controller.loadOlder()}
          onRetry={id => void controller.retryPrompt(id)}
          onDiscard={id => controller.discardPrompt(id)}
          emptyText={viewing === root ? (closed ? 'Nothing here yet.' : 'Send a message to start.') : 'This agent has not written anything yet.'}
          tail={questionCards}
        />
      )}
      {loading && !entries.length && questionCards ? (
        <div className="px-3 pb-3 md:px-4"><div className="mx-auto flex w-full max-w-[820px] flex-col gap-2 px-2">{questionCards}</div></div>
      ) : null}
      {viewing === root && controller.isArchived(root) ? <ArchivedCallout sessionId={root} /> : viewing === root ? (
        <>
          {closed && !running ? <p className="mx-auto w-full max-w-[820px] px-4 pb-2 text-center text-xs text-muted-foreground">This session is closed on the host. Sending a message reopens it.</p> : null}
          <Composer
            meter={<ContextMeter usage={rootSession?.usage} />}
            images={rootSession?.promptImages === true && connection.capabilities.includes('prompt.images') && !!connection.promptImageLimits?.maxBytes}
            imageLimits={connection.promptImageLimits}
            imagesUnavailable={`${agentOf(root)} runs on ${rootSession?.runtime ?? 'a runtime'} here, which takes no images.`}
            onSend={(text, images) => controller.sendPrompt(text, undefined, images)}
            onQueue={text => controller.queuePrompt(text)}
            onStop={() => void controller.interrupt()}
            queued={queued.filter(item => item.rootId === root)}
            onEditQueued={id => controller.editQueued(id)}
            onSendQueued={id => void controller.sendQueuedNow(id)}
            running={working}
            stopping={!!busy.interrupt}
            blocked={blocked}
            disabledReason={connection.phase !== 'open' ? 'Reconnecting…' : loading ? 'Loading…' : undefined}
            placeholder={`Message ${agentOf(root)}…`}
            sendBehavior={preferences.sendBehavior}
            onCycleMode={canCycle ? cycleMode : undefined}
            tracks={<TasksPill worked={worked} />}
            controls={<>
              {team ? <Control icon={<Bot aria-hidden />} label={team} title={`Team, set when the session started${model ? ` · main runs ${model}` : ''}`} /> : null}
              {mode ? <ModeControl mode={mode} modes={modes} locked={modeLocked} disabled={!!busy.mode || !!blocked || !canWrite || connection.phase !== 'open' || modeLocked} onSelect={next => void controller.configureMode(next)} /> : null}
            </>}
          />
        </>
      ) : (
        <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4 md:pb-4">
          <div className="mx-auto flex w-full max-w-[820px] items-center gap-3 rounded-2xl border border-dotted border-input bg-card px-3 py-2 text-[15px] leading-[21px] text-muted-foreground md:px-4 md:py-3">
            <span className="min-w-0 flex-1">{agentOf(viewing)} works on an assignment from main. Talk to main to steer it.</span>
            <ContextMeter usage={projection.sessions[viewing]?.usage} />
            <Button size="sm" variant="secondary" onClick={() => openAgent(root)}><ArrowLeft aria-hidden /> Main</Button>
          </div>
        </div>
      )}
    </div>
  );
}
