import * as React from 'react';
import type { ReactNode } from 'react';
import { ArrowLeft, Brain, ChevronDown, CircleAlert, Cpu, MessageSquarePlus, RotateCcw, Shield, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import { Menu } from '../components/ui/menu';
import { cn } from '../lib/utils';
import { TasksPill } from './chat/tracks';
import { can } from '../lib/gateway.js';
import { entriesOf } from '../lib/timeline.js';
import { Button } from '../components/ui/button';
import { Spinner } from '../components/ui/spinner';
import { modeLabel } from '../lib/format';
import { liveModels } from '../lib/configure.js';
import { effortLabel, effortOptions } from '../lib/new-session.js';
import { Composer } from './Composer';
import { ContextMeter } from './ContextMeter';
import { ArchivedCallout } from './History';
import { QuestionCard } from './QuestionCard';
import { Timeline } from './Timeline';
import { useAppState, useController } from './store';
import { useTabs } from './tabs';
import { ConversationContext, ForkDialog, RewindDialog, type TurnInfo } from './Conversation';
import { turnsByMessage } from '../lib/conversation.js';

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

const menuTrigger = cn(controlClass, 'outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground disabled:pointer-events-none disabled:opacity-60');

/**
 * The open root's team, model and thinking as Paseo's composer toolbar shows them, as menus when the
 * host changes them on a live session (session.configure.live, §12.9). The labels are what the host
 * says the root runs with (its summary, session.updated, the configure answer), never a choice before
 * the host took it; a menu is disabled, with the reason as its tooltip, when a change is not possible
 * now. Models are the session's runtime's only: another runtime needs a new session.
 */
function LiveAgentControls({ team, teamId, model, thinking, runtime }: { team?: string; teamId?: string; model?: string; thinking?: string; runtime?: string }) {
  const controller = useController();
  const { catalog, busy } = useAppState();
  const gate = controller.liveConfigure();
  const { same, current, others } = liveModels(catalog.models, { runtime, model });
  const modelLabel = current?.label ?? model;
  const thinkingLabel = thinking ? effortLabel(thinking) : undefined;
  const efforts = effortOptions(current);
  const working = !!busy.configure;
  const hint = (control: { enabled: boolean; reason?: string }, what: string) => control.enabled ? what : `${what}. ${control.reason ?? gate.reason ?? ''}`.trim();
  // A disabled trigger takes no pointer: its reason is the tooltip of what holds it.
  // Always wrapped, so a menu keeps its state when it is enabled or disabled.
  const held = (control: { enabled: boolean }, what: string, menu: ReactNode) => <span className="inline-flex min-w-0" title={control.enabled && !working ? undefined : working ? `${what}. Applying the last change…` : hint(control, what)}>{menu}</span>;
  if (!gate.shown) {
    // An older host: read-only, as set when the session started.
    return <>
      {team ? <Control icon={<Users aria-hidden />} label={team} title={`Team: ${team}. ${gate.reason}`} /> : null}
      {modelLabel ? <Control icon={<Cpu aria-hidden />} label={modelLabel} title={`Main agent's model: ${modelLabel}. ${gate.reason}`} /> : null}
      {thinkingLabel ? <Control icon={<Brain aria-hidden />} label={thinkingLabel} title={`Thinking: ${thinkingLabel}. ${gate.reason}`} /> : null}
    </>;
  }
  const teams = catalog.teams.length ? catalog.teams : teamId ? [{ id: teamId, label: team ?? teamId }] : [];
  const teamListed = !teamId || teams.some(entry => entry.id === teamId);
  return <>
    {team || teamId ? held(gate.team, `Team: ${team ?? teamId}`, (
      <Menu label="Team" title={hint(gate.team, `Team: ${team ?? teamId}`)} align="start" disabled={!gate.team.enabled || working} testId="session-team" triggerClassName={menuTrigger}
        trigger={<><Users aria-hidden /><span className="truncate" data-testid="team-label">{team ?? teamId}</span><ChevronDown aria-hidden className="!size-3 opacity-70" /></>}
        items={[
          ...(teamListed ? [] : [{ id: teamId!, label: team ?? teamId!, checked: true, onSelect: () => {} }]),
          ...teams.map(entry => ({ id: entry.id, label: entry.label, checked: entry.id === teamId, ...(entry.id === teamId ? {} : { title: 'Restarts main on the same conversation with this team' }), onSelect: () => { if (entry.id !== teamId) void controller.configureLive({ team: entry.id }); } })),
        ]} />
    )) : null}
    {modelLabel ? held(same.length ? gate.model : { enabled: false }, `Main agent's model: ${modelLabel}`, (
      <Menu label="Model" title={hint(gate.model, `Main agent's model: ${modelLabel}`)} align="start" disabled={!gate.model.enabled || working || !same.length} testId="session-model" triggerClassName={menuTrigger}
        trigger={<><Cpu aria-hidden /><span className="truncate" data-testid="model-label">{modelLabel}</span><ChevronDown aria-hidden className="!size-3 opacity-70" /></>}
        items={[
          ...same.map(entry => ({ id: entry.id, label: entry.label, checked: entry.id === current?.id, onSelect: () => { if (entry.id !== current?.id) void controller.configureLive({ model: entry.id }); } })),
          ...(others ? [{ id: 'other-runtimes', label: 'Other runtimes: start a new session', disabled: true, group: true, title: 'A session keeps its runtime. To use another runtime\'s model, start a new session with it.', onSelect: () => {} }] : []),
        ]} />
    )) : null}
    {thinkingLabel ? (
      efforts.length ? held(gate.thinking, `Thinking: ${thinkingLabel}`, (
        <Menu label="Thinking" title={hint(gate.thinking, `Thinking: ${thinkingLabel}`)} align="start" disabled={!gate.thinking.enabled || working} testId="session-thinking" triggerClassName={menuTrigger}
          trigger={<><Brain aria-hidden /><span className="truncate" data-testid="session-thinking-label">{thinkingLabel}</span><ChevronDown aria-hidden className="!size-3 opacity-70" /></>}
          items={efforts.map(entry => ({ id: entry.id, label: entry.label, checked: entry.id === thinking, onSelect: () => { if (entry.id !== thinking) void controller.configureLive({ thinking: entry.id }); } }))} />
      )) : <Control icon={<Brain aria-hidden />} label={thinkingLabel} title={`Thinking: ${thinkingLabel}`} />
    ) : null}
  </>;
}

/** One agent's conversation: the timeline, its questions and, for the main agent, the composer. */
export function ChatPanel({ sessionId }: { sessionId: string }) {
  const controller = useController();
  const { openAgent } = useTabs();
  const { tree, prompts, queued, busy, sessions, connection, preferences, catalog, principal } = useAppState();
  // Fork and rewind (§12.7): the turn a dialog asks about, and the text a rewind puts back in the composer.
  const [rewinding, setRewinding] = React.useState<TurnInfo | null>(null);
  const [forking, setForking] = React.useState<string | null>(null);
  const [refill, setRefill] = React.useState<{ id: number; text: string } | undefined>(undefined);
  const projectionForTurns = tree?.projection;
  const hasOlder = !!tree?.older?.hasOlder;
  const turns = React.useMemo(() => projectionForTurns ? turnsByMessage(projectionForTurns, { hasOlder }) : new Map<string, TurnInfo>(), [projectionForTurns, hasOlder]);
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
  // Files other than images (#121 J): why they cannot go to this root, or null.
  const fileGate = controller.fileGate(root);

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
  const model = rootSession?.model ?? listed?.model;
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
  const gate = controller.conversationGate(root);
  const conversation = viewing === root && (gate.fork.shown || gate.rewind.shown) ? {
    root, fork: gate.fork, rewind: gate.rewind, turns,
    askRewind: (key: string) => { const turn = turns.get(key); if (turn) setRewinding(turn); },
    askFork: (turnId: string) => setForking(turnId),
  } : null;
  const title = rootSession?.title ?? listed?.title ?? 'Session';
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
        <ConversationContext.Provider value={conversation}>
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
        </ConversationContext.Provider>
      )}
      <RewindDialog turn={rewinding} onClose={() => setRewinding(null)} onDone={text => { setRewinding(null); if (text) setRefill({ id: Date.now(), text }); }} />
      <ForkDialog turnId={forking} title={title} onClose={() => setForking(null)} />
      {loading && !entries.length && questionCards ? (
        <div className="px-3 pb-3 md:px-4"><div className="mx-auto flex w-full max-w-(--content-width) flex-col gap-2 px-2">{questionCards}</div></div>
      ) : null}
      {viewing === root && controller.isArchived(root) ? <ArchivedCallout sessionId={root} /> : viewing === root ? (
        <>
          {closed && !running ? <p className="mx-auto w-full max-w-(--content-width) px-4 pb-2 text-center text-xs text-muted-foreground">This session is closed on the host. Sending a message reopens it.</p> : null}
          <Composer
            meter={<ContextMeter usage={rootSession?.usage} />}
            images={rootSession?.promptImages === true && connection.capabilities.includes('prompt.images') && !!connection.promptImageLimits?.maxBytes}
            imageLimits={connection.promptImageLimits}
            imagesUnavailable={`${agentOf(root)} runs on ${rootSession?.runtime ?? 'a runtime'} here, which takes no images.`}
            files={!fileGate}
            fileLimits={connection.attachmentLimits}
            filesUnavailable={fileGate ?? undefined}
            addText={refill}
            commands={() => controller.listCommands(root)}
            onSend={(text, images, files) => controller.sendPrompt(text, undefined, images, files)}
            onQueue={text => controller.queuePrompt(text)}
            onInterruptSend={text => controller.interruptAndSend(text)}
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
            sendShortcut={preferences.sendShortcut}
            onCycleMode={canCycle ? cycleMode : undefined}
            tracks={<TasksPill worked={worked} />}
            controls={<>
              <LiveAgentControls team={team} teamId={rootSession?.workflow?.mode ?? listed?.workflow?.mode} model={model} thinking={rootSession?.thinking ?? listed?.thinking} runtime={rootSession?.runtime ?? listed?.runtime} />
              {mode ? <ModeControl mode={mode} modes={modes} locked={modeLocked} disabled={!!busy.mode || !!busy.configure || !!blocked || !canWrite || connection.phase !== 'open' || modeLocked} onSelect={next => void controller.configureMode(next)} /> : null}
            </>}
          />
        </>
      ) : (
        <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:px-4 md:pb-4">
          <div className="mx-auto flex w-full max-w-(--content-width) items-center gap-3 rounded-2xl border border-dotted border-input bg-card px-3 py-2 text-(length:--content-font-size) leading-[1.4] text-muted-foreground md:px-4 md:py-3">
            <span className="min-w-0 flex-1">{agentOf(viewing)} works on an assignment from main. Talk to main to steer it.</span>
            <ContextMeter usage={projection.sessions[viewing]?.usage} />
            <Button size="sm" variant="secondary" onClick={() => openAgent(root)}><ArrowLeft aria-hidden /> Main</Button>
          </div>
        </div>
      )}
    </div>
  );
}
