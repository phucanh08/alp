import * as React from 'react';
import { Ban, CircleCheck, Pin } from 'lucide-react';
import { can } from '../../lib/gateway.js';
import { TERMINAL_MESSAGES, terminalGate } from '../../lib/terminal.js';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { baseName } from '../../lib/format';
import { cn } from '../../lib/utils';
import { useAppState, useController } from '../store';
import { Row, Section, Select, Unavailable, type Page } from './parts';
import { LibraryPage } from './LibraryPages';

/*
 * Settings' host pages (t-a95b): Usage, Providers, Terminals, Workspaces and Projects. Moved out of
 * Settings.tsx unchanged; the host owner's actions (controller.ownerRequest, useOwner) are added
 * here by later changes (group B).
 */

export function UsagePage() {
  return <Unavailable what="Usage and limits" why="Account-wide on the host; check with alp usage there." />;
}

export function ProvidersPage() {
  return (
    <>
      <LibraryPage kind="providers" noun="providers" />
      <Unavailable what="Adding, testing or diagnosing providers" why="Tests run commands on the host; they are not offered remotely." />
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
      <Unavailable what="Granting or removing projects" why="The access token decides which projects you can open. The host owner grants them with alp-gateway credential create --workspace." />
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
  const { principal, registry, connection } = useAppState();
  const blocked = registryBlock(controller.hasCapability('workspace.registry'), principal);
  React.useEffect(() => { if (!blocked) void controller.refreshRegistry(); }, [controller, blocked]);
  if (blocked) return <Unavailable what="Workspace settings" why={blocked} />;
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
      <Unavailable what="Archiving workspaces, labels and placement" why="The host's owner manages them with alp on the host." />
    </>
  );
}

export function TerminalsPage({ onNavigate }: { onNavigate: (page: Page) => void }) {
  const state = useAppState();
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
      <Unavailable what="Changing the host's terminal switch" why="Only the host's owner turns remote terminals on or off, on the host: alp terminal allow --yes, alp terminal deny, alp terminal status. Font and colors are under App › Terminal." />
    </>
  );
}
