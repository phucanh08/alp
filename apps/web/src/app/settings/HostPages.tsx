import * as React from 'react';
import { Ban, CircleCheck, Pin } from 'lucide-react';
import { can } from '../../lib/gateway.js';
import { TERMINAL_MESSAGES, terminalGate } from '../../lib/terminal.js';
import { Button } from '../../components/ui/button';
import { Input, Label, Textarea } from '../../components/ui/input';
import { Spinner } from '../../components/ui/spinner';
import { describe } from '../../lib/errors.js';
import {
  LABEL_COLORS, addProvider, archiveWorkspace, changeLabel, dateLabel, diagnoseProviders, ownerRegistry, providerParams, providerPreview, readUsage,
  registerDirectory, removeProject, resetLabel, runtimeName, setTerminal, terminalStatus, testProvider, testSummary, usageStatus, windowLevel,
  type OwnerRegistry as OwnerRegistryData, type OwnerWorkspace as OwnerWorkspaceData, type UsageProvider,
} from '../../lib/owner-host.js';
import { baseName } from '../../lib/format';
import { cn } from '../../lib/utils';
import { useAppState, useController, useOwner } from '../store';
import { Row, Section, Select, Unavailable, focusRing, type Page } from './parts';
import { LibraryPage } from './LibraryPages';

/*
 * Settings' host pages (t-a95b; docs/alp/dashboard.md §4.7): Usage, Providers, Terminals, Workspaces
 * and Projects. The host owner (useOwner: alp dashboard's own credential on a direct loopback
 * socket) gets the actions below, through controller.ownerRequest; any other connection sees the
 * pages as before, with their Unavailable panels unchanged.
 */

/**
 * An owner request's error for the page: the host's own words for an error it answered (the owner's
 * handlers and alpd say which value was wrong; the owner is on this machine, so nothing is hidden
 * from it), else describe()'s text for a connection failure.
 */
function errorText(cause: unknown) {
  const answered = cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'number' ? (cause as { message?: unknown }).message : undefined;
  return typeof answered === 'string' && answered ? answered : describe(cause).message;
}

export function UsagePage() {
  const owner = useOwner();
  if (owner) return <OwnerUsage />;
  return <Unavailable what="Usage and limits" why="Account-wide on the host; check with alp usage there." />;
}

export function ProvidersPage() {
  const owner = useOwner();
  // The list is group C's LibraryPage; a provider the owner adds shows once it lists again.
  const [listed, setListed] = React.useState(0);
  return (
    <>
      <LibraryPage key={listed} kind="providers" noun="providers" />
      {owner ? <OwnerProviders onAdded={() => setListed(value => value + 1)} />
        : <Unavailable what="Adding, testing or diagnosing providers" why="Tests run commands on the host; they are not offered remotely." />}
    </>
  );
}

type RegistryRow = ReturnType<typeof useAppState>['registry']['workspaces'][number];

/** The host's shared workspace rows of a granted directory (by path, or by its real path). */
function useRegistered() {
  const { principal, registry } = useAppState();
  return React.useCallback((path: string) => registry.workspaces.filter(row => !row.archivedAt
    && (row.directory === path || principal?.workspaceRoots?.some(root => root.path === path && root.canonical === row.directory))), [principal, registry]);
}

/** Why the host's workspace list cannot be read here, if it cannot. */
function registryBlock(hasRegistry: boolean, principal: Parameters<typeof can>[0] | null) {
  if (!hasRegistry) return 'This host does not list its workspaces. Update ALP on the host.';
  if (!can(principal ?? undefined, 'project.read')) return 'Your access token cannot read the host\'s workspace list (it needs project.read).';
  return undefined;
}

export function ProjectsPage() {
  const controller = useController();
  const owner = useOwner();
  const { principal, workspace, registry, connection } = useAppState();
  const registered = useRegistered();
  const [chosen, setChosen] = React.useState('');
  const workspaces = principal?.workspaces ?? [];
  const blocked = registryBlock(controller.hasCapability('workspace.registry'), principal);
  React.useEffect(() => { if (!blocked) void controller.refreshRegistry(); }, [controller, blocked]);
  const unregistered = blocked ? [] : workspaces.filter(path => !registered(path).length);
  const writable = can(principal ?? undefined, 'workspace.write');
  const online = connection.phase === 'open';
  return (
    <>
      <Section title="Projects this token opens">
        {workspaces.length ? workspaces.map((path, index) => (
          <Row key={path} first={index === 0} title={baseName(path)} hint={<span className="break-all font-mono">{path}</span>}>
            <span className="flex items-center gap-2">
              {!blocked ? <span className="text-xs" data-testid="project-registered">{registered(path).length ? 'Registered' : 'Not registered'}</span> : null}
              {path === workspace ? <span className="text-highlight" data-testid="project-current">Current</span> : <Button size="sm" variant="secondary" onClick={() => controller.selectWorkspace(path)}>Open</Button>}
            </span>
          </Row>
        )) : <Row first title="No projects" hint="This access token grants no workspace." />}
      </Section>
      {blocked ? null : (
        <Section title="Register a project">
          <Row first title="Granted directory" hint={writable
            ? 'Registering adds a granted directory to the host\'s shared workspace list, so terminals, Git and worktrees can use it. It changes no files.'
            : 'Ask the host owner to add workspace.write to your credential to register projects.'}>
            {writable && unregistered.length ? (
              <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); if (chosen) void controller.registerProject(chosen).then(() => setChosen('')); }}>
                <Select label="Directory to register" value={chosen} onChange={setChosen}
                  options={[{ value: '', label: 'Choose a directory' }, ...unregistered.map(path => ({ value: path, label: baseName(path) }))]} />
                <Button size="sm" type="submit" disabled={!chosen || !online || registry.loading}>Register</Button>
              </form>
            ) : writable ? <span className="text-xs">Every granted directory is registered</span> : null}
          </Row>
          {registry.error ? <p role="alert" className="border-t border-border px-4 py-3 text-xs text-destructive">{registry.error}</p> : null}
        </Section>
      )}
      {owner ? <OwnerProjects /> : <Unavailable what="Granting or removing projects" why="The access token decides which projects you can open. The host owner grants them with alp-gateway credential create --workspace." />}
    </>
  );
}

function WorkspaceRow({ row, first, writable, online, busy }: { row: RegistryRow; first: boolean; writable: boolean; online: boolean; busy: boolean }) {
  const controller = useController();
  const { workspace, principal } = useAppState();
  const [editing, setEditing] = React.useState(false);
  const [title, setTitle] = React.useState(row.title ?? '');
  const name = row.title || baseName(row.directory);
  const openable = principal?.workspaces?.some(path => path === row.directory || principal.workspaceRoots?.some(root => root.path === path && root.canonical === row.directory)) || row.managedWorktree;
  const local = principal?.workspaceRoots?.find(root => root.canonical === row.directory)?.path ?? row.directory;
  const save = async () => { if (await controller.renameWorkspace(row.id, title)) setEditing(false); };
  return (
    <div className={cn('flex flex-col gap-2 p-4', !first && 'border-t border-border')} data-testid="settings-workspace-row" data-workspace-id={row.id}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <span className="truncate">{name}</span>
            {row.pinnedAt ? <Pin aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground" /> : null}
            {row.managedWorktree ? <span className="rounded-full bg-secondary px-2 py-0.5 text-[length:calc(11px*var(--ui-scale))] text-muted-foreground">Worktree</span> : null}
          </div>
          <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{row.directory}</div>
          {row.branch !== undefined ? <div className="mt-1 text-xs text-muted-foreground">{row.branch || 'Detached HEAD'}</div> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" aria-pressed={!!row.pinnedAt} disabled={!writable || !online || busy} onClick={() => void controller.pinWorkspace(row.id, !row.pinnedAt)}
            aria-label={`${row.pinnedAt ? 'Unpin' : 'Pin'} workspace ${name}`}>{row.pinnedAt ? 'Unpin' : 'Pin'}</Button>
          <Button size="sm" variant="ghost" disabled={!writable || !online || busy} onClick={() => { setTitle(row.title ?? ''); setEditing(value => !value); }}
            aria-label={`Rename workspace ${name}`}>Rename</Button>
          {openable ? (local === workspace ? <span className="text-xs text-highlight">Open</span>
            : <Button size="sm" variant="secondary" onClick={() => controller.selectWorkspace(local)}>Open</Button>) : null}
        </div>
      </div>
      {editing ? (
        <form className="flex flex-wrap items-center gap-2" onSubmit={event => { event.preventDefault(); void save(); }}>
          <Input aria-label={`New name for ${name}`} value={title} maxLength={200} onChange={event => setTitle(event.target.value)} placeholder={baseName(row.directory)} className="h-8 min-w-0 flex-1" autoFocus />
          <Button size="sm" type="submit" disabled={!online || busy}>Save</Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(false)}>Cancel</Button>
        </form>
      ) : null}
    </div>
  );
}

export function WorkspacesPage() {
  const controller = useController();
  const owner = useOwner();
  const { principal, registry, connection } = useAppState();
  const blocked = registryBlock(controller.hasCapability('workspace.registry'), principal);
  React.useEffect(() => { if (!blocked) void controller.refreshRegistry(); }, [controller, blocked]);
  if (blocked) return <><Unavailable what="Workspace settings" why={blocked} />{owner ? <OwnerWorkspaces /> : null}</>;
  const writable = can(principal ?? undefined, 'workspace.write');
  const online = connection.phase === 'open';
  const rows = registry.workspaces.filter(row => !row.archivedAt)
    .sort((a, b) => Number(!!b.pinnedAt) - Number(!!a.pinnedAt) || (a.title || baseName(a.directory)).localeCompare(b.title || baseName(b.directory)) || a.id.localeCompare(b.id));
  return (
    <>
      <Section title={`Shared with every client of this host${rows.length ? ` (${rows.length})` : ''}`}
        action={<Button size="sm" variant="ghost" className="h-7 text-xs" disabled={registry.loading || !online} onClick={() => void controller.refreshRegistry()}>{registry.loading ? 'Refreshing…' : 'Refresh'}</Button>}>
        {registry.error ? <p role="alert" className="px-4 py-3 text-xs text-destructive">{registry.error}</p> : null}
        {!rows.length ? <Row first={!registry.error} title={registry.loading ? 'Loading…' : 'No workspaces'} hint={registry.loading ? undefined : 'Register a granted directory under Host › Projects.'} />
          : rows.map((row, index) => <WorkspaceRow key={row.id} row={row} first={index === 0 && !registry.error} writable={writable} online={online} busy={!!registry.loading} />)}
      </Section>
      {!writable ? <Section><Row first title="Read only" hint="Pins and names are shared with every client of this host. Ask the host owner to add workspace.write to your credential to change them." /></Section> : null}
      {owner ? <OwnerWorkspaces /> : <Unavailable what="Archiving workspaces, labels and placement" why="The host's owner manages them with alp on the host." />}
    </>
  );
}

export function TerminalsPage({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const state = useAppState();
  const owner = useOwner();
  const hostAllows = state.connection.capabilities.includes('terminal');
  const tokenAllows = can(state.principal ?? undefined, 'terminal.exec');
  const gate = terminalGate(state as Parameters<typeof terminalGate>[0]);
  const unregistered = !gate.ok && gate.reasons.includes('unregistered');
  const canRegister = can(state.principal ?? undefined, 'workspace.write');
  const yes = (ok: boolean, label: string) => (
    <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs [&_svg]:size-3', ok ? 'bg-primary/15 text-highlight' : 'bg-secondary text-muted-foreground')}>
      {ok ? <CircleCheck aria-hidden /> : <Ban aria-hidden />}{label}
    </span>
  );
  return (
    <>
      <Section title="Remote terminals">
        <Row first title="Host" hint={hostAllows ? 'The host\'s owner allowed remote terminals.' : TERMINAL_MESSAGES.capability}>
          <span data-testid="terminals-host">{yes(hostAllows, hostAllows ? 'Allowed' : 'Not allowed')}</span>
        </Row>
        <Row title="Access token" hint={tokenAllows ? 'Your access token may open terminals (terminal.exec).' : TERMINAL_MESSAGES.permission}>
          <span data-testid="terminals-token">{yes(tokenAllows, tokenAllows ? 'terminal.exec' : 'No terminal.exec')}</span>
        </Row>
        <Row title="This workspace" hint={gate.ok ? 'A terminal can open here from the + menu (Terminal).' : [...gate.messages, unregistered ? (canRegister
          ? 'Register it under Host › Projects; the terminal opens once it is in the list.'
          : 'Registering it needs workspace.write: ask the host owner to register it, or to add workspace.write to your credential.') : ''].filter(Boolean).join(' ')}>
          <span className="flex items-center gap-2">
            {unregistered && canRegister ? <Button size="sm" variant="secondary" data-testid="terminals-register" onClick={() => onNavigate('projects')}>Register in Projects</Button> : null}
            <span data-testid="terminals-workspace">{yes(gate.ok, gate.ok ? 'Ready' : 'Not available')}</span>
          </span>
        </Row>
      </Section>
      {owner ? <OwnerTerminals /> : <Unavailable what="Changing the host's terminal switch" why="Only the host's owner turns remote terminals on or off, on the host: alp terminal allow --yes, alp terminal deny, alp terminal status. Font and colors are under App › Terminal." />}
    </>
  );
}

// ---- The host owner's parts (t-a95b.1 group B; docs/alp/dashboard.md §4.7) ----------------------
// Shown only when useOwner() (the dashboard's own credential on a direct loopback socket); every
// request goes through controller.ownerRequest (lib/owner-host.js). Any other connection keeps the
// Unavailable panels above, unchanged.

/** A request's pending flag and error, for an owner action. */
function useAction() {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const run = React.useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setPending(true); setError(null);
    try { return await work(); }
    catch (cause) { setError(errorText(cause)); return undefined; }
    finally { setPending(false); }
  }, []);
  return { pending, error, run, setError };
}

function Failure({ error }: { error: string | null }) {
  return error ? <p role="alert" className="border-t border-border px-4 py-3 text-xs text-destructive">{error}</p> : null;
}

const tones = { success: 'bg-primary/15 text-highlight', warning: 'bg-amber-500/15 text-amber-600 dark:text-amber-400', muted: 'bg-secondary text-muted-foreground' } as const;
function Pill({ label, tone, testId }: { label: string; tone: keyof typeof tones; testId?: string }) {
  return <span data-testid={testId} className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs', tones[tone])}>{label}</span>;
}

// ---- Usage

function OwnerUsage() {
  const controller = useController();
  const [data, setData] = React.useState<{ providers: UsageProvider[] } | null>(null);
  const { pending, error, run } = useAction();
  const load = React.useCallback((refresh: boolean) => run(async () => setData(await readUsage(controller, refresh))), [controller, run]);
  React.useEffect(() => { void load(false); }, [load]);
  const providers = data?.providers ?? [];
  const parked = providers.reduce((sum, provider) => sum + (provider.parked ?? 0), 0);
  const now = Date.now();
  return (
    <>
      <Section title="Account usage on this host"
        action={<Button size="sm" variant="ghost" className="h-7 text-xs" disabled={pending} onClick={() => void load(true)} aria-label="Refresh usage">{pending ? 'Refreshing…' : 'Refresh'}</Button>}>
        {!data && pending ? <div className="p-4"><Spinner label="Checking Codex and Claude usage…" className="text-xs" /></div> : null}
        {error ? <p role="alert" className="px-4 py-3 text-xs text-destructive">Could not refresh usage: {error}{data ? ' Showing the last received data.' : ''}</p> : null}
        {parked > 0 ? <Row first={!error} title={`${parked} ${parked === 1 ? 'assignment waiting' : 'assignments waiting'}`} hint="Parked work stays saved while its runtime is paused." /> : null}
        {data && !providers.length ? <Row first title="No providers reported usage" /> : null}
        {providers.map((provider, index) => {
          const status = usageStatus(provider);
          return (
            <div key={provider.runtime} className={cn('flex flex-col gap-3 p-4', (index > 0 || error || parked > 0) && 'border-t border-border')} data-testid="usage-provider" data-runtime={provider.runtime}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm text-foreground">{runtimeName(provider.runtime)}</div>
                  <div className="text-xs text-muted-foreground">{provider.plan ? `${provider.plan} plan` : 'Plan not reported'}</div>
                </div>
                <Pill label={status.label} tone={status.tone} testId="usage-status" />
              </div>
              {provider.pause ? <div className="text-xs text-muted-foreground">{provider.pause.reason}{provider.pause.resetsAt ? ` · ${resetLabel(provider.pause.resetsAt, now)}` : ''} · {provider.parked} parked</div> : null}
              {!provider.available ? <p className="text-xs text-muted-foreground">The provider did not return usage data. Check that its CLI is installed and signed in on the host, then refresh.</p>
                : !provider.windows.length ? <p className="text-xs text-muted-foreground">The provider has not reported any usage windows.</p>
                : provider.windows.map((window, at) => {
                  const used = window.usedPercent;
                  const level = windowLevel(used);
                  return (
                    <div key={`${window.name}-${at}`} className="flex flex-col gap-1" data-testid="usage-window">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="capitalize text-foreground">{window.name.replace(/_/g, ' ')}</span>
                        <span className={cn('tabular-nums', level === 'danger' ? 'text-destructive' : level === 'warning' ? 'text-amber-600 dark:text-amber-400' : 'text-foreground')}>{used === null ? '—' : `${Math.round(used)}%`}</span>
                      </div>
                      <div role="progressbar" aria-label={`${runtimeName(provider.runtime)} ${window.name} used`} aria-valuemin={0} aria-valuemax={100} {...(used === null ? { 'aria-valuetext': 'Usage unknown' } : { 'aria-valuenow': used })}
                        className="h-1.5 overflow-hidden rounded-full bg-secondary">
                        <div className={cn('h-1.5 rounded-full', level === 'danger' ? 'bg-destructive' : level === 'warning' ? 'bg-amber-500' : 'bg-primary')} style={{ width: `${Math.max(0, Math.min(100, used ?? 0))}%` }} />
                      </div>
                      <div className="text-xs text-muted-foreground">{used === null ? 'Usage percentage unavailable' : `${Math.round(100 - used)}% remaining`} · {resetLabel(window.resetsAt, now)}</div>
                    </div>
                  );
                })}
              <div className="text-xs text-muted-foreground">Checked {dateLabel(provider.checkedAt)}</div>
            </div>
          );
        })}
      </Section>
      <p className="mb-6 ml-1 text-xs text-muted-foreground">Account limits each provider reports (alp usage), shared with use outside ALP; not a billing report. Refresh asks the providers again on the host.</p>
    </>
  );
}

// ---- Providers

const EMPTY_PROVIDER = { id: '', command: '', args: '', env: '', label: '', description: '', models: '' };

function OwnerProviders({ onAdded }: { onAdded: () => void }) {
  const controller = useController();
  const [form, setForm] = React.useState(EMPTY_PROVIDER);
  const [review, setReview] = React.useState<Record<string, any> | null>(null);
  const [added, setAdded] = React.useState<string | null>(null);
  const [testName, setTestName] = React.useState('');
  const [tested, setTested] = React.useState<{ ok: boolean; text: string } | null>(null);
  const [checks, setChecks] = React.useState<Awaited<ReturnType<typeof diagnoseProviders>>['checks'] | null>(null);
  const adding = useAction();
  const testing = useAction();
  const diagnosing = useAction();
  const field = (key: keyof typeof EMPTY_PROVIDER) => ({ value: form[key], onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => { setForm(current => ({ ...current, [key]: event.target.value })); setReview(null); } });
  const preview = review ? providerPreview(review) : null;
  const toReview = () => {
    adding.setError(null);
    try { setReview(providerParams(form)); } catch (cause) { adding.setError(errorText(cause)); }
  };
  const confirm = async () => {
    if (!review) return;
    const saved = await adding.run(() => addProvider(controller, review));
    if (saved) { setAdded(String(review.id)); setTestName(String(review.id)); setForm(EMPTY_PROVIDER); setReview(null); onAdded(); }
  };
  const test = async () => {
    setTested(null);
    const result = await testing.run(() => testProvider(controller, testName.trim()));
    if (result) setTested({ ok: result.ok !== false, text: testSummary(result) });
  };
  return (
    <>
      <Section title="Add a provider (alp provider add)">
        <form className="flex flex-col gap-3 p-4" aria-label="Add a provider" onSubmit={event => { event.preventDefault(); toReview(); }}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Label className="flex flex-col gap-1">Id<Input {...field('id')} placeholder="my-agent" required maxLength={64} /></Label>
            <Label className="flex flex-col gap-1">Command<Input {...field('command')} placeholder="/usr/local/bin/my-agent" required /></Label>
            <Label className="flex flex-col gap-1">Label<Input {...field('label')} placeholder="Optional" /></Label>
            <Label className="flex flex-col gap-1">Models<Input {...field('models')} placeholder="model-a, model-b" /></Label>
          </div>
          <Label className="flex flex-col gap-1">Description<Input {...field('description')} placeholder="Optional" /></Label>
          <Label className="flex flex-col gap-1">Arguments (one per line)<Textarea {...field('args')} placeholder="--acp" /></Label>
          <Label className="flex flex-col gap-1">Environment (NAME=value, one per line)<Textarea {...field('env')} placeholder="API_KEY=…" autoComplete="off" spellCheck={false} /></Label>
          {!review ? <div><Button size="sm" type="submit" disabled={!form.id.trim() || !form.command.trim()}>Review</Button></div> : null}
        </form>
        {preview ? (
          <div className="border-t border-border p-4" data-testid="provider-confirm" role="group" aria-label="Confirm the provider">
            <p className="text-sm">This host will run, for every session on provider <span className="font-mono">{String(review?.id)}</span>:</p>
            <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-md bg-secondary p-3 font-mono text-xs" data-testid="provider-confirm-command">{preview.line}</pre>
            <ul className="mt-2 text-xs text-muted-foreground" data-testid="provider-confirm-env">
              {preview.env.length ? preview.env.map(entry => <li key={entry.name} className="font-mono">{entry.name}={entry.value}</li>) : <li>No environment variables</li>}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">It runs as your user, with your account's access. Add only a command you trust.</p>
            <div className="mt-3 flex gap-2">
              <Button size="sm" onClick={() => void confirm()} disabled={adding.pending}>{adding.pending ? 'Adding…' : 'Add provider'}</Button>
              <Button size="sm" variant="ghost" onClick={() => setReview(null)}>Back</Button>
            </div>
          </div>
        ) : null}
        {added && !review ? <p role="status" className="border-t border-border px-4 py-3 text-xs">Added {added} to your library.</p> : null}
        <Failure error={adding.error} />
      </Section>
      <Section title="Test a provider (alp provider test)">
        <form className="flex flex-wrap items-center gap-2 p-4" onSubmit={event => { event.preventDefault(); void test(); }}>
          <Input aria-label="Provider to test" value={testName} onChange={event => setTestName(event.target.value)} placeholder="Provider id" className="h-8 min-w-0 flex-1" />
          <Button size="sm" type="submit" disabled={!testName.trim() || testing.pending}>{testing.pending ? 'Testing…' : 'Test'}</Button>
        </form>
        {tested ? <p role="status" data-testid="provider-test-result" className="border-t border-border px-4 py-3 text-xs">{tested.text}</p> : null}
        <Failure error={testing.error} />
      </Section>
      <Section title="Diagnose (alp doctor's provider checks)"
        action={<Button size="sm" variant="ghost" className="h-7 text-xs" disabled={diagnosing.pending} onClick={() => void diagnosing.run(async () => setChecks((await diagnoseProviders(controller)).checks))}>{diagnosing.pending ? 'Checking…' : 'Diagnose'}</Button>}>
        {!checks ? <Row first title="Runtimes and providers" hint="Checks that Codex, Claude and Antigravity are installed and signed in on the host, and that each library provider's command exists. Read only; takes a few seconds." /> : null}
        {checks?.map((check, index) => (
          <Row key={check.id} first={index === 0} title={<span className="font-mono">{check.id}</span>} hint={<>{check.summary}{check.details?.map(line => <span key={line} className="block">{line}</span>)}{check.hint ? <span className="block">{check.hint}</span> : null}</>}>
            <span data-testid={`diagnose-${check.id.replace(/\s+/g, '-')}`}><Pill label={check.status} tone={check.status === 'ok' ? 'success' : check.status === 'warn' ? 'warning' : 'muted'} /></span>
          </Row>
        ))}
        {checks && !checks.length ? <Row first title="No runtime or provider checks" /> : null}
        <Failure error={diagnosing.error} />
      </Section>
    </>
  );
}

// ---- Terminals

function OwnerTerminals() {
  const controller = useController();
  const [status, setStatus] = React.useState<Awaited<ReturnType<typeof terminalStatus>> | null>(null);
  const [confirming, setConfirming] = React.useState(false);
  const { pending, error, run } = useAction();
  React.useEffect(() => { void run(async () => setStatus(await terminalStatus(controller))); }, [controller, run]);
  const set = async (allow: boolean) => {
    const next = await run(() => setTerminal(controller, allow, allow));
    if (next) { setStatus(next); setConfirming(false); }
  };
  const allowed = !!status?.allowRemoteTerminal;
  return (
    <Section title="This host's switch (alp terminal)">
      <Row first title="Remote terminals on this host" hint={status ? (allowed ? `Allowed${status.allowPaseoTerminal ? ', also for paired Paseo app devices' : ''}. Turning them off ends every open terminal within 5 seconds.` : 'Off. Gateway credentials with terminal.exec cannot open a terminal here.') : 'Reading $ALP_HOME/terminal.json…'}>
        <span className="flex items-center gap-2">
          {status ? <span data-testid="terminals-switch"><Pill label={allowed ? 'Allowed' : 'Off'} tone={allowed ? 'success' : 'muted'} /></span> : <Spinner />}
          {status && allowed ? <Button size="sm" variant="secondary" disabled={pending} onClick={() => void set(false)}>Turn off</Button> : null}
          {status && !allowed && !confirming ? <Button size="sm" variant="secondary" disabled={pending} onClick={() => setConfirming(true)}>Allow…</Button> : null}
        </span>
      </Row>
      {status?.problem ? <p role="alert" className="border-t border-border px-4 py-3 text-xs text-destructive">{status.problem}</p> : null}
      {confirming && status ? (
        <div className="border-t border-border p-4" role="group" aria-label="Allow remote terminals" data-testid="terminals-confirm">
          <pre className="whitespace-pre-wrap rounded-md bg-secondary p-3 font-mono text-xs">{status.warning}</pre>
          <div className="mt-3 flex gap-2">
            <Button size="sm" variant="destructive" disabled={pending} onClick={() => void set(true)}>Allow remote terminals</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Cancel</Button>
          </div>
        </div>
      ) : null}
      <Failure error={error} />
    </Section>
  );
}

// ---- Workspaces and projects

/**
 * alpd's whole registry as the owner sees it (host.registry), reloaded after each change and
 * whenever the owner's connection opens again. Registering or removing a project changes the
 * dashboard credential's grant, and the gateway then closes the connection (4403 grant changed),
 * often before the answer to the change arrives: the change is reported as "may still have run",
 * and the view is read again once the app has reconnected, so it shows what the host now holds.
 */
function useOwnerRegistry() {
  const controller = useController();
  const { connection, owner } = useAppState();
  const online = connection.phase === 'open' && owner;
  const [registry, setRegistry] = React.useState<OwnerRegistryData | null>(null);
  const loading = useAction();
  const changing = useAction();
  const load = loading.run;
  const reload = React.useCallback(() => load(async () => setRegistry(await ownerRegistry(controller))), [controller, load]);
  React.useEffect(() => { if (online) void reload(); }, [online, reload]);
  /** Runs a change with the registry revision, then reloads this view and the shared list. */
  const run = changing.run;
  const change = React.useCallback(async (work: (revision: number) => Promise<unknown>) => {
    const done = await run(async () => { await work(registry?.revision ?? 0); return true; });
    // While the connection is down this read fails quietly; the effect above reads again on reconnect.
    await reload();
    void controller.refreshRegistry();
    return !!done;
  }, [run, controller, registry, reload]);
  return { registry, change, pending: loading.pending || changing.pending, error: changing.error ?? loading.error };
}

function LabelChip({ name, color, onRemove }: { name: string; color?: string; onRemove?: () => void }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-xs text-foreground" data-testid="workspace-label" data-color={color}>
      <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: LABEL_DOT[color ?? 'violet'] }} />
      {name}
      {onRemove ? <button type="button" className={cn('ml-0.5 text-muted-foreground hover:text-foreground', focusRing)} aria-label={`Remove label ${name}`} onClick={onRemove}>×</button> : null}
    </span>
  );
}

const LABEL_DOT: Record<string, string> = { violet: '#8b5cf6', sky: '#0ea5e9', emerald: '#10b981', orange: '#f97316', pink: '#ec4899', indigo: '#6366f1', teal: '#14b8a6', red: '#ef4444', amber: '#f59e0b', blue: '#3b82f6' };

function OwnerWorkspaceRow({ row, first, registry, change, pending }: { row: OwnerWorkspaceData; first: boolean; registry: OwnerRegistryData; change: (work: (revision: number) => Promise<unknown>) => Promise<boolean>; pending: boolean }) {
  const controller = useController();
  const [label, setLabel] = React.useState('');
  const [color, setColor] = React.useState<string>(LABEL_COLORS[0]);
  const name = row.title || baseName(row.directory);
  const colorOf = (labelName: string) => registry.labels.find(entry => entry.name.toLowerCase() === labelName.toLowerCase())?.color;
  const existing = colorOf(label.trim());
  return (
    <div className={cn('flex flex-col gap-2 p-4', !first && 'border-t border-border')} data-testid="owner-workspace-row" data-workspace-id={row.id}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm text-foreground">
            <span className="truncate">{name}</span>
            {row.archivedAt ? <Pill label="Archived" tone="muted" testId="owner-workspace-archived" /> : null}
            {row.managedWorktree ? <Pill label="Worktree" tone="muted" /> : null}
          </div>
          <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{row.directory}</div>
          <div className="mt-1 text-xs text-muted-foreground">{row.sessions} {row.sessions === 1 ? 'session' : 'sessions'}</div>
        </div>
        <Button size="sm" variant="secondary" disabled={pending} aria-label={`${row.archivedAt ? 'Unarchive' : 'Archive'} workspace ${name}`}
          onClick={() => void change(revision => archiveWorkspace(controller, row.id, !row.archivedAt, revision))}>{row.archivedAt ? 'Unarchive' : 'Archive'}</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {row.labels.map(entry => <LabelChip key={entry} name={entry} color={colorOf(entry)} onRemove={pending ? undefined : () => void change(revision => changeLabel(controller, { action: 'unassign', workspaceId: row.id, name: entry }, revision))} />)}
        <form className="flex items-center gap-1" onSubmit={event => { event.preventDefault(); const value = label.trim(); if (value) void change(revision => changeLabel(controller, { action: 'assign', workspaceId: row.id, name: value, color: existing ?? color }, revision)).then(ok => { if (ok) setLabel(''); }); }}>
          <Input aria-label={`New label for ${name}`} value={label} maxLength={64} onChange={event => setLabel(event.target.value)} placeholder="Add a label" className="h-7 w-32 text-xs" list={`labels-${row.id}`} />
          <datalist id={`labels-${row.id}`}>{registry.labels.map(entry => <option key={entry.name} value={entry.name} />)}</datalist>
          {existing ? null : <Select label={`Color of the new label for ${name}`} value={color} onChange={setColor} options={LABEL_COLORS.map(value => ({ value, label: value }))} />}
          <Button size="sm" type="submit" variant="ghost" disabled={!label.trim() || pending}>Add</Button>
        </form>
      </div>
    </div>
  );
}

function OwnerWorkspaces() {
  const controller = useController();
  const { registry, change, pending, error } = useOwnerRegistry();
  const [showArchived, setShowArchived] = React.useState(false);
  const rows = (registry?.workspaces ?? []).filter(row => showArchived || !row.archivedAt)
    .sort((a, b) => Number(!!a.archivedAt) - Number(!!b.archivedAt) || (a.title || baseName(a.directory)).localeCompare(b.title || baseName(b.directory)) || a.id.localeCompare(b.id));
  const archived = (registry?.workspaces ?? []).filter(row => row.archivedAt).length;
  return (
    <>
      <Section title="Archive and labels (host owner)"
        action={<label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Show archived ({archived})</label>}>
        {!registry && pending ? <div className="p-4"><Spinner label="Loading…" className="text-xs" /></div> : null}
        {registry && !rows.length ? <Row first title="No workspaces" hint="Register a directory under Host › Projects." /> : null}
        {registry ? rows.map((row, index) => <OwnerWorkspaceRow key={row.id} row={row} first={index === 0} registry={registry} change={change} pending={pending} />) : null}
        <Failure error={error} />
      </Section>
      {registry?.labels.length ? (
        <Section title="Labels">
          {registry.labels.map((entry, index) => (
            <Row key={entry.name} first={index === 0} title={<LabelChip name={entry.name} color={entry.color} />}>
              <span className="flex items-center gap-2">
                <Select label={`Color of label ${entry.name}`} value={entry.color} onChange={value => void change(revision => changeLabel(controller, { action: 'update', name: entry.name, color: value }, revision))} options={LABEL_COLORS.map(value => ({ value, label: value }))} />
                <Button size="sm" variant="ghost" disabled={pending} aria-label={`Delete label ${entry.name}`} onClick={() => void change(revision => changeLabel(controller, { action: 'delete', name: entry.name }, revision))}>Delete</Button>
              </span>
            </Row>
          ))}
        </Section>
      ) : null}
      <p className="mb-6 ml-1 text-xs text-muted-foreground">Archiving hides a workspace from every client of this host; no files change. Which workspace a session belongs to is not changed here: alpd places a session once and does not move it.</p>
    </>
  );
}

function OwnerProjects() {
  const controller = useController();
  const { registry, change, pending, error } = useOwnerRegistry();
  const [directory, setDirectory] = React.useState('');
  const [removing, setRemoving] = React.useState<string | null>(null);
  return (
    <>
      <Section title="Projects on this host (host owner)">
        {!registry && pending ? <div className="p-4"><Spinner label="Loading…" className="text-xs" /></div> : null}
        {registry && !registry.projects.length ? <Row first title="No projects" hint="Register a directory below." /> : null}
        {registry?.projects.map((project, index) => (
          <div key={project.id} className={cn('p-4', index > 0 && 'border-t border-border')} data-testid="owner-project-row" data-project-root={project.root}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="text-sm text-foreground">{project.customName || baseName(project.root)}</div>
                <div className="mt-1 break-all font-mono text-xs text-muted-foreground">{project.root}</div>
              </div>
              {removing === project.id ? (
                <span className="flex items-center gap-2">
                  <Button size="sm" variant="destructive" disabled={pending} onClick={() => void change(revision => removeProject(controller, project.id, revision)).then(() => setRemoving(null))}>Remove</Button>
                  <Button size="sm" variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
                </span>
              ) : <Button size="sm" variant="ghost" disabled={pending} aria-label={`Remove project ${baseName(project.root)}`} onClick={() => setRemoving(project.id)}>Remove…</Button>}
            </div>
            {removing === project.id ? <p className="mt-2 text-xs text-muted-foreground">Removing archives its workspaces and takes it out of the host's list; no files change. Sessions keep their history.</p> : null}
          </div>
        ))}
        <Failure error={error} />
      </Section>
      <Section title="Register a directory">
        <form className="flex flex-wrap items-center gap-2 p-4" onSubmit={event => { event.preventDefault(); if (directory.trim()) void change(revision => registerDirectory(controller, directory, revision)).then(ok => { if (ok) setDirectory(''); }); }}>
          <Input aria-label="Directory to register" value={directory} onChange={event => setDirectory(event.target.value)} placeholder="/absolute/path/to/project" className="h-8 min-w-0 flex-1 font-mono" />
          <Button size="sm" type="submit" disabled={!directory.trim() || pending}>Register</Button>
        </form>
        <Row title="On this host" hint="Any existing directory, by its absolute path. It joins the host's shared workspace list and this app's access; nothing in it changes." />
      </Section>
    </>
  );
}
