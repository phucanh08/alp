import * as React from 'react';
import { Brain, ChevronDown, CircleAlert, Cpu, Users } from 'lucide-react';
import { describe } from '../lib/errors.js';
import { can } from '../lib/gateway.js';
import { buildSpec, effectiveModel, effortLabel, effortOptions, initialChoices, previewBase, previewRows, resolveThinking, startNewSession, startTeam, teamMenu, unlistedTeam, type Choices, type Preview } from '../lib/new-session.js';
import { Menu } from '../components/ui/menu';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { baseName } from '../lib/format';
import { cn } from '../lib/utils';
import type { FileAttachment } from '../lib/attachments.js';
import { Composer } from './Composer';
import { ModeControl, controlClass } from './SessionView';
import { useAppState, useController } from './store';
import { useTabs } from './tabs';

/*
 * Paseo's new agent tab (composer/draft/workspace-tab.tsx) for ALP sessions: an open area above
 * and the composer docked below, its toolbar holding the agent controls — here the team, the main
 * agent's model, its thinking (the model's efforts, Paseo's thinking control) and the permissions
 * mode. Sending the first message starts the session with it (Paseo's initial prompt); the start
 * button also works with an empty box. ALP adds what Paseo cannot show: session.preview's answer
 * on which team, agent, runtime, model, thinking and mode the choices would run.
 */

type PreviewState = { status: 'idle' | 'loading' | 'ready' | 'error' | 'blocked'; preview?: Preview; error?: string;
  /** previewBase of the request `preview` answered. */ base?: string };

const PREVIEW_DEBOUNCE_MS = 250;
const triggerClass = cn(controlClass, 'outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground disabled:pointer-events-none disabled:opacity-60');

/** session.preview for the current choices, debounced; an older answer never replaces a newer one. */
function usePreview(spec: Record<string, unknown> | null): PreviewState & { retry: () => void } {
  const controller = useController();
  const { connection } = useAppState();
  const [state, setState] = React.useState<PreviewState>({ status: 'idle' });
  const [attempt, setAttempt] = React.useState(0);
  const key = spec ? JSON.stringify(spec) : '';
  const open = connection.phase === 'open';
  React.useEffect(() => {
    if (!spec) return;
    const blocked = controller.previewBlock();
    if (blocked) { setState(current => ({ ...current, status: 'blocked', error: blocked })); return; }
    if (!open) return;
    const abort = new AbortController();
    const base = previewBase(spec);
    setState(current => ({ status: 'loading', preview: current.preview, base: current.base }));
    const timer = setTimeout(() => {
      controller.previewSession(spec, { signal: abort.signal }).then(
        preview => { if (!abort.signal.aborted) setState({ status: 'ready', preview, base }); },
        error => { if (!abort.signal.aborted) setState(current => ({ ...current, status: 'error', error: describe(error).message })); },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => { clearTimeout(timer); abort.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, open, controller, attempt]);
  const retry = React.useCallback(() => setAttempt(value => value + 1), []);
  return { ...state, retry };
}

export function NewSessionScreen() {
  const controller = useController();
  const { finishDraft } = useTabs();
  const { catalog, workspace, preferences, busy, connection, principal } = useAppState();
  // Files of the first message (#121 J) wait here until the session exists; its runtime is checked then.
  const fileGate = controller.fileGate(null);
  const remembered = preferences.newSession;
  const [choices, setChoices] = React.useState<Choices>(() => initialChoices(catalog, remembered));
  const [title, setTitle] = React.useState('');
  // The catalog arrives (or a workspace's comes again): start from the remembered choices it offers.
  React.useEffect(() => {
    if (catalog.status === 'ready') setChoices(initialChoices(catalog, controller.getState().preferences.newSession));
  }, [catalog, controller]);

  // The last preview answered, and for which team/model: only one answered for the current pair
  // says which model (so which efforts) the session would run.
  const [answered, setAnswered] = React.useState<{ preview: Preview; base: string } | undefined>();
  const base = previewBase({ workflow: choices.team, model: choices.model });
  const trusted = answered?.base === base ? answered.preview : undefined;
  const model = effectiveModel(catalog.models, choices.model, trusted);
  // A thinking choice the model does not take is not sent: the host applies its usual effort.
  const thinking = model ? resolveThinking(model, choices.thinking) : undefined;
  const effective: Choices = { ...choices, ...(thinking ? { thinking } : { thinking: undefined }) };
  const spec = workspace && catalog.status !== 'loading' ? buildSpec(workspace, effective) : null;
  const preview = usePreview(spec);
  React.useEffect(() => {
    if (preview.status === 'ready' && preview.preview && preview.base) setAnswered({ preview: preview.preview, base: preview.base });
  }, [preview.status, preview.preview, preview.base]);
  // The preview is still working out the current choices (a thinking checked, a team named).
  const current = preview.status === 'ready' && preview.base === base;
  const settled = preview.status === 'blocked' || preview.status === 'error';

  const creating = !!busy.create;
  const canWrite = can(principal ?? undefined, 'session.write');
  const blocked = !canWrite ? 'Your access token can view sessions but not start them.' : undefined;
  const listed = catalog.teams.length ? catalog.teams : trusted?.teams ?? [];
  // A team a preview named that the list lacks (`custom`) stays in the menu once seen in this
  // workspace, so choosing another team does not lose it. With a team already chosen (a remembered
  // one), the previews never show the workspace's default, so it is asked for once (no workflow).
  const seen = unlistedTeam(listed, trusted);
  const [kept, setKept] = React.useState<{ workspace: string | null; team?: { id: string; label: string } }>();
  const keptHere = kept?.workspace === workspace ? kept : undefined;
  React.useEffect(() => {
    if (seen) setKept(current => current?.workspace === workspace && current.team?.id === seen.id && current.team.label === seen.label ? current : { team: seen, workspace });
  }, [seen?.id, seen?.label, workspace]); // eslint-disable-line react-hooks/exhaustive-deps
  const askDefault = !!workspace && connection.phase === 'open' && !!choices.team && !keptHere && catalog.status === 'ready';
  React.useEffect(() => {
    if (!askDefault || !workspace || controller.previewBlock()) return;
    const abort = new AbortController();
    controller.previewSession(buildSpec(workspace, {}), { signal: abort.signal }).then(
      answer => {
        if (abort.signal.aborted) return;
        const team = unlistedTeam(catalog.teams.length ? catalog.teams : answer.teams, answer);
        setKept(current => current?.workspace === workspace ? current : { workspace, ...(team ? { team } : {}) });
      },
      () => {},
    );
    return () => abort.abort();
  }, [askDefault, workspace, controller]); // eslint-disable-line react-hooks/exhaustive-deps
  const teams = teamMenu(listed, seen ?? keptHere?.team);
  // The team is always sent: the session gets the team a preview of these choices named (else the
  // first listed), which is what the person saw. alpd's preview and create resolve the same default
  // (t-5586), so sending it back, `custom` included, runs what the preview showed.
  const resolved = startTeam({ chosen: choices.team, previewTeam: trusted?.team, previewSettled: settled, previewError: preview.error,
    previewBlocked: preview.status === 'blocked', previewNeedsRead: !can(principal ?? undefined, 'session.read'),
    teams: listed, teamsKnown: catalog.teamsKnown, teamsUnavailable: catalog.teamsUnavailable });
  const stuck = 'stuck' in resolved && resolved.stuck ? resolved.wait : undefined;
  // Retry asks the preview again and, when team.list failed, the team list too.
  const retry = () => { preview.retry(); void controller.retryTeams(); };
  const teamsRetryable = catalog.teamsUnavailable?.reason === 'failed';
  const team = resolved.team;
  const teamLabel = team ? (team === trusted?.team && trusted.teamLabel) || teams.find(entry => entry.id === team)?.label || team : 'Team';
  const waiting = resolved.wait ?? (!settled && !current ? 'Checking what would run…' : undefined);
  const modelLabel = choices.model ? catalog.models.find(entry => entry.id === choices.model)?.label ?? choices.model
    : model ? model.label : trusted?.model || 'Default model';
  const efforts = effortOptions(model);
  const thinkingLabel = thinking ? effortLabel(thinking) : trusted?.thinking ? effortLabel(trusted.thinking) : model?.effort ? effortLabel(model.effort) : 'Default';
  // As Paseo's agent controls (onDropdownClose): a choice made, the message box has focus again.
  const boxId = `composer-${React.useId()}`;
  const refocus = () => setTimeout(() => document.getElementById(boxId)?.focus(), 0);
  const choose = (change: Partial<Choices>) => { setChoices(current => ({ ...current, ...change })); refocus(); };
  const chooseModel = (id: string) => { setChoices(current => ({ ...current, model: id || undefined, thinking: remembered.thinkingByModel?.[id || 'default'] })); refocus(); };

  // One start at a time (a second Enter before the busy state renders does nothing), and a
  // failure after this screen closed still reaches the person, with their message.
  // A first message a failed start left behind (its screen had closed) comes back here, once.
  const [unsent] = React.useState(() => controller.unsentDraft());
  // One kept while this screen is open (a start from an earlier screen of this workspace failed)
  // lands in this box at once, after anything typed, so the notice's "back in the box" is true;
  // so does one kept between this screen's first render and this effect.
  const [taken, setTaken] = React.useState<{ id: number; text: string }>();
  React.useEffect(() => {
    if (unsent) controller.clearUnsentDraft(unsent);
    const add = (text: string) => setTaken(current => ({ id: (current?.id ?? 0) + 1, text }));
    const release = controller.takeUnsentDrafts(kept => {
      if (kept.workspace !== controller.getState().workspace) return false;
      add(kept.text);
      return true;
    });
    const late = controller.unsentDraft();
    if (late) { controller.clearUnsentDraft(late); add(late); }
    return release;
  }, [unsent, controller]);
  const starting = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const start = async (text: string, _images: unknown[] = [], files: FileAttachment[] = []) => {
    if (starting.current || controller.getState().busy.create || waiting) return;
    starting.current = true;
    try {
      const id = await startNewSession(controller, {
        ...(team ? { team } : {}),
        ...(effective.mode ? { mode: effective.mode } : {}),
        ...(effective.model ? { model: effective.model } : {}),
        ...(effective.thinking ? { thinking: effective.thinking } : {}),
        ...(title.trim() ? { title: title.trim() } : {}),
        ...(text.trim() ? { prompt: text } : {}),
        ...(files.length ? { files } : {}),
      }, text, { mounted: () => mounted.current, describe, nameOf: baseName });
      finishDraft(id);
    } finally {
      starting.current = false;
    }
  };

  const controls = (
    <>
      <Menu label="Team" title={`Team: ${teamLabel}`} align="start" disabled={creating} testId="new-session-team" triggerClassName={triggerClass}
        trigger={<><Users aria-hidden /><span className="truncate">{teamLabel}</span><ChevronDown aria-hidden className="!size-3 opacity-70" /></>}
        items={[
          ...teams.map(entry => ({ id: entry.id, label: entry.label, checked: team === entry.id, onSelect: () => choose({ team: entry.id }) })),
        ]} />
      {catalog.models.length ? (
        <Menu label="Model" title={`Main agent's model: ${modelLabel}`} align="start" disabled={creating} testId="new-session-model" triggerClassName={triggerClass}
          trigger={<><Cpu aria-hidden /><span className="truncate">{modelLabel}</span><ChevronDown aria-hidden className="!size-3 opacity-70" /></>}
          items={[
            { id: '', label: 'Team default', checked: !choices.model, onSelect: () => chooseModel('') },
            ...catalog.models.map((entry, index) => ({ id: entry.id, label: entry.label, checked: choices.model === entry.id, group: index === 0, onSelect: () => chooseModel(entry.id) })),
          ]} />
      ) : null}
      {efforts.length ? (
        <Menu label="Thinking" title={`Thinking: ${thinkingLabel}`} align="start" disabled={creating} testId="new-session-thinking" triggerClassName={triggerClass}
          trigger={<><Brain aria-hidden /><span className="truncate" data-testid="thinking-label">{thinkingLabel}</span><ChevronDown aria-hidden className="!size-3 opacity-70" /></>}
          items={[
            { id: '', label: model?.effort ? `Default (${effortLabel(model.effort)})` : 'Default', checked: !thinking, onSelect: () => choose({ thinking: undefined }) },
            ...efforts.map((entry, index) => ({ id: entry.id, label: entry.label, checked: thinking === entry.id, group: index === 0, onSelect: () => choose({ thinking: entry.id }) })),
          ]} />
      ) : null}
      {choices.mode ? <ModeControl mode={choices.mode} modes={catalog.modes} locked={false} disabled={creating} onSelect={mode => choose({ mode })} /> : null}
    </>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="new-session-screen">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[820px] flex-col gap-5 px-4 pb-6 pt-10 md:pt-16">
          <div>
            <h2 className="text-lg font-medium text-foreground">New session</h2>
            {workspace ? <p className="mt-1 text-sm text-muted-foreground">Runs on the host in <span className="font-mono text-foreground/90">{baseName(workspace)}</span>. Your first message starts it.</p> : null}
          </div>
          {catalog.status === 'loading' ? <Spinner label="Loading teams and models…" className="text-xs" /> : null}
          {catalog.status === 'error' ? <p role="alert" className="text-xs text-destructive">{catalog.error?.message}</p> : null}
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-title" className="text-xs font-medium text-muted-foreground">Title (optional)</label>
            <Input id="new-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} disabled={creating}
              placeholder="Named after your first message when empty" className="bg-transparent" />
          </div>
          <PreviewCard state={preview} models={catalog.models} onRetry={retry} retryWhenBlocked={teamsRetryable} />
          {stuck ? <p role="alert" data-testid="new-session-stuck" className="flex items-start gap-2 text-xs text-destructive"><CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{stuck}</p> : null}
        </div>
      </div>
      <Composer
        onSend={start}
        onQueue={() => {}}
        onStop={() => {}}
        queued={[]}
        onEditQueued={() => null}
        onSendQueued={() => {}}
        running={false}
        stopping={false}
        blocked={blocked}
        disabledReason={connection.phase !== 'open' ? 'Reconnecting…' : creating ? 'Starting…' : !workspace ? 'Choose a workspace first.' : catalog.status === 'loading' ? 'Loading…' : undefined}
        startHold={waiting}
        placeholder="What should main work on?"
        startLabel="Start session"
        initialText={unsent}
        addText={taken}
        autoFocus
        inputId={boxId}
        controls={controls}
        files={!fileGate}
        fileLimits={connection.attachmentLimits}
        filesUnavailable={fileGate ?? undefined}
      />
    </div>
  );
}

/** What the host says the session would run (session.preview), or why it cannot say. */
function PreviewCard({ state, models, onRetry, retryWhenBlocked }: { state: PreviewState; models: Parameters<typeof previewRows>[1]; onRetry: () => void; retryWhenBlocked?: boolean }) {
  const rows = state.preview ? previewRows(state.preview, models) : [];
  return (
    <section aria-label="Session preview" data-testid="session-preview" aria-busy={state.status === 'loading'}
      className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <h3 className="text-xs font-normal text-muted-foreground">This session will run</h3>
        {state.status === 'loading' ? <Spinner label="Checking…" className="text-xs" /> : null}
      </div>
      {state.status === 'blocked' ? (
        <div className="flex items-start justify-between gap-3 px-4 py-3">
          <p role="note" className="text-xs text-muted-foreground">Preview not available: {state.error}</p>
          {retryWhenBlocked ? <button type="button" onClick={onRetry} className="shrink-0 rounded-md px-2 py-0.5 text-xs text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">Retry</button> : null}
        </div>
      ) : null}
      {state.status === 'error' ? (
        <div className="flex items-start justify-between gap-3 px-4 py-3">
          <p role="alert" className="flex items-start gap-2 text-xs text-destructive"><CircleAlert aria-hidden className="mt-0.5 size-3.5 shrink-0" />{state.error}</p>
          <button type="button" onClick={onRetry} className="shrink-0 rounded-md px-2 py-0.5 text-xs text-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring">Retry</button>
        </div>
      ) : null}
      {rows.length ? (
        <dl className={cn('grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 px-4 py-3 text-sm', state.status !== 'ready' && 'opacity-60')}>
          {rows.map(row => (
            <React.Fragment key={row.key}>
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 truncate text-foreground" data-testid={`preview-${row.key}`}>{row.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : state.status === 'idle' || (state.status === 'loading' && !state.preview) ? (
        <p className="px-4 py-3 text-xs text-muted-foreground">Asking the host…</p>
      ) : null}
    </section>
  );
}
