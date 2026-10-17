import * as React from 'react';
import {
  ArrowLeft, Ban, Blocks, BookOpen, Bot, Boxes, ChevronRight, CircleCheck, Code, FolderGit2, Gauge, Info, MessageSquare, Network,
  PanelLeft, Palette, Plug, Server, Settings as SettingsIcon, Smartphone, Sparkles, SquareTerminal, Stethoscope, Users, Webhook,
} from 'lucide-react';
import { can } from '../lib/gateway.js';
import { describe } from '../lib/errors.js';
import { Button } from '../components/ui/button';
import { NativeSelect } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { baseName, modeLabel } from '../lib/format';
import { cn } from '../lib/utils';
import { useAppState, useController } from './store';

/*
 * Settings as the old ALP web (the Paseo fork) lays them out: a full screen with its own sidebar
 * ("Back", then the App and Host groups, the host's ALP screens among them) and the
 * chosen page on the right, in cards. What the gateway does not offer is a page that says so; no
 * page falls back to the old app.
 */

type Icon = typeof Server;
type Page =
  | 'general' | 'appearance' | 'sidebar' | 'chat' | 'terminal' | 'editor' | 'diagnostics' | 'about'
  | 'host' | 'projects' | 'connections' | 'pair-device' | 'alp-templates' | 'alp-agents' | 'alp-skills' | 'alp-hooks' | 'alp-mcp'
  | 'metadata' | 'workspaces' | 'providers' | 'usage' | 'terminals' | 'plugins';

const APP_PAGES: Array<{ id: Page; label: string; icon: Icon }> = [
  { id: 'general', label: 'General', icon: SettingsIcon },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'sidebar', label: 'Sidebar', icon: PanelLeft },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'editor', label: 'Editor', icon: Code },
  { id: 'diagnostics', label: 'Diagnostics', icon: Stethoscope },
  { id: 'about', label: 'About', icon: Info },
];

const HOST_PAGES: Array<{ id: Page; label: string; icon: Icon }> = [
  { id: 'host', label: 'Overview', icon: Server },
  { id: 'projects', label: 'Projects', icon: FolderGit2 },
  { id: 'connections', label: 'Connections', icon: Network },
  { id: 'pair-device', label: 'Pair device', icon: Smartphone },
  { id: 'alp-templates', label: 'Templates', icon: Users },
  { id: 'alp-agents', label: 'Agents', icon: Bot },
  { id: 'alp-skills', label: 'Skills', icon: BookOpen },
  { id: 'alp-hooks', label: 'Hooks', icon: Webhook },
  { id: 'alp-mcp', label: 'MCP servers', icon: Plug },
  { id: 'metadata', label: 'Metadata', icon: Sparkles },
  { id: 'workspaces', label: 'Workspaces', icon: FolderGit2 },
  { id: 'providers', label: 'Providers', icon: Boxes },
  { id: 'usage', label: 'Usage', icon: Gauge },
  { id: 'terminals', label: 'Terminals', icon: SquareTerminal },
  { id: 'plugins', label: 'Plugins', icon: Blocks },
];

const LABEL = Object.fromEntries([...APP_PAGES, ...HOST_PAGES].map(page => [page.id, page.label])) as Record<Page, string>;

const focusRing = 'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset';

// ---- building blocks: Paseo's settings section, card and row ------------------------------------

function Section({ title, action, children }: { title?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      {title || action ? (
        <div className="mb-3 ml-1 flex items-center justify-between gap-2">
          {title ? <h3 className="text-xs font-normal text-muted-foreground">{title}</h3> : <span />}
          {action}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-lg border border-border bg-card">{children}</div>
    </section>
  );
}

function Row({ title, hint, children, first }: { title: React.ReactNode; hint?: React.ReactNode; children?: React.ReactNode; first?: boolean }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 p-4', !first && 'border-t border-border')}>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{title}</div>
        {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      {children !== undefined ? <div className="min-w-0 max-w-full text-sm text-muted-foreground">{children}</div> : null}
    </div>
  );
}

function Unavailable({ what, why }: { what: string; why: string }) {
  return (
    <Section>
      <div className="flex items-start gap-3 p-4" role="note">
        <Ban aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div>
          <p className="text-sm">{what} is not available in this beta</p>
          <p className="mt-1 text-xs text-muted-foreground">{why}</p>
        </div>
      </div>
    </Section>
  );
}

/** Paseo's settings dropdown: a small pill with the value and a chevron, right of the row. */
function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ value: T; label: string }>; onChange?: (value: T) => void }) {
  return (
    <NativeSelect aria-label={label} value={value} onChange={event => onChange?.(event.target.value as T)} disabled={!onChange}
      className="h-8 w-auto rounded-lg border-border bg-transparent pl-3 text-sm text-foreground disabled:cursor-default disabled:opacity-100">
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </NativeSelect>
  );
}

// ---- pages ----------------------------------------------------------------------------------

function General() {
  const controller = useController();
  const { preferences } = useAppState();
  return (
    <>
      <Section title="General">
        <Row first title="Language" hint="App language. This beta speaks English; the agents' language is a host setting (Host › Overview).">
          <Select label="Language" value="system" options={[{ value: 'system', label: 'System' }]} />
        </Row>
      </Section>
      <Section title="Sending">
        <Row first title="Default send" hint={`${preferences.sendBehavior === 'steer'
          ? 'When the agent is running, Enter steers the active turn. Command/Ctrl+Enter queues.'
          : 'When the agent is running, Enter queues. Command/Ctrl+Enter steers the active turn.'} Saved in this browser.`}>
          <Select label="Default send" value={preferences.sendBehavior} onChange={value => controller.setSendBehavior(value)}
            options={[{ value: 'steer', label: 'Steer' }, { value: 'queue', label: 'Queue' }]} />
        </Row>
      </Section>
      <Section title="This browser">
        <Row first title="Saved preferences" hint="Default send, the theme and your last New session choices (team, model, thinking, permissions) stay in this browser. The access token never does.">
          <Button size="sm" variant="secondary" onClick={() => controller.resetPreferences()}>Reset</Button>
        </Row>
      </Section>
    </>
  );
}

function Appearance() {
  const controller = useController();
  const { preferences } = useAppState();
  return (
    <>
      <Section title="Theme">
        <Row first title="Theme" hint="Paseo's light and dark themes; System follows this device. Saved in this browser.">
          <Select label="Theme" value={preferences.theme} onChange={value => controller.setTheme(value)}
            options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </Row>
      </Section>
      <Unavailable what="Paseo's other themes, fonts, sizes, content width and code highlighting" why="This beta keeps Paseo's defaults for them." />
    </>
  );
}

function About() {
  const { connection } = useAppState();
  const host = connection.gateway.replace(/^https?:\/\//, '');
  return (
    <>
      <Section title="About">
        <Row first title="App version" hint="This device, ALP web beta">v{__ALP_WEB_VERSION__}</Row>
      </Section>
      <Section title="Connected hosts">
        <Row first title={host} hint="ALP on the host, through the gateway (ALP JSON-RPC v1)">{connection.daemonVersion ? `v${connection.daemonVersion.replace(/^v/, '')}` : 'unknown'}</Row>
      </Section>
    </>
  );
}

function Overview() {
  const controller = useController();
  const { principal, connection, settings } = useAppState();
  React.useEffect(() => { void controller.loadSettings(); }, [controller]);
  const permissions = ['session.read', 'session.write', 'project.read', 'project.write'];
  return (
    <>
      <Section title="Host">
        <Row first title="ALP">{connection.daemonVersion ?? 'unknown'}</Row>
        <Row title="Gateway"><span className="break-all font-mono text-xs">{connection.gateway}</span></Row>
        <Row title="Agents' language" hint="Set on the host with alp; read only here.">
          {settings.status === 'loading' ? <Spinner label="Loading…" className="text-xs" /> : settings.language ? `${settings.language.applies}${settings.language.language ? '' : ' (default)'}` : 'Not available'}
        </Row>
        {settings.status === 'error' ? <p role="alert" className="border-t border-border px-4 py-3 text-xs text-destructive">{settings.error?.message}</p> : null}
      </Section>
      <Section title={`Models new sessions can pick${settings.models.length ? ` (${settings.models.length})` : ''}`}>
        {settings.models.length ? (
          <ul className="max-h-72 divide-y divide-border overflow-y-auto">
            {settings.models.map(model => (
              <li key={model.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="min-w-0 truncate">{model.label}</span>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{model.id}</span>
              </li>
            ))}
          </ul>
        ) : <Row first title={settings.status === 'ready' ? 'None listed' : 'Loading…'} />}
      </Section>
      <Section title="Access token">
        <Row first title="Name">{principal?.label ?? '—'} <span className="font-mono text-xs">({principal?.id})</span></Row>
        <Row title="Allows">
          <span className="flex flex-wrap justify-end gap-1">
            {permissions.map(permission => {
              const allowed = can(principal ?? undefined, permission);
              return (
                <span key={permission} className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs [&_svg]:size-3', allowed ? 'bg-primary/15 text-highlight' : 'bg-secondary text-muted-foreground')}>
                  {allowed ? <CircleCheck aria-hidden /> : <Ban aria-hidden />}{permission}
                </span>
              );
            })}
          </span>
        </Row>
        <Row title="Modes" hint="Permissions a session may run with.">{principal?.modes ? principal.modes.map(modeLabel).join(', ') : 'Any'}</Row>
      </Section>
    </>
  );
}

function Projects() {
  const controller = useController();
  const { principal, workspace } = useAppState();
  const workspaces = principal?.workspaces ?? [];
  return (
    <>
      <Section title="Projects this token opens">
        {workspaces.length ? workspaces.map((path, index) => (
          <Row key={path} first={index === 0} title={baseName(path)} hint={<span className="break-all font-mono">{path}</span>}>
            {path === workspace ? <span className="text-highlight">Open</span> : <Button size="sm" variant="secondary" onClick={() => controller.selectWorkspace(path)}>Open</Button>}
          </Row>
        )) : <Row first title="No projects" hint="This access token grants no workspace." />}
      </Section>
      <Unavailable what="Adding or removing projects" why="The access token decides which projects you can open. The host owner grants them with alp-gateway credential create --workspace." />
    </>
  );
}

function Connections() {
  const controller = useController();
  const { connection } = useAppState();
  const secure = connection.gateway.startsWith('https:');
  return (
    <Section title="This connection">
      <Row first title="Gateway"><span className="break-all font-mono text-xs">{connection.gateway}</span></Row>
      <Row title="State">{connection.phase === 'open' ? 'Connected' : connection.phase === 'reconnecting' ? `Reconnecting (attempt ${connection.attempt})` : connection.phase}</Row>
      <Row title="Transport" hint={secure ? 'TLS to the gateway.' : 'Plain HTTP, allowed only on this machine (loopback or an SSH tunnel).'}>{secure ? 'HTTPS / WSS' : 'Loopback HTTP / WS'}</Row>
      <Row title="Access token" hint="Kept in this tab's memory only. Disconnecting forgets it.">
        <Button size="sm" variant="destructive" onClick={() => controller.disconnect()}>Disconnect</Button>
      </Row>
    </Section>
  );
}

type LibraryKind = 'teams' | 'agents' | 'skills' | 'hooks' | 'mcp' | 'providers';

function Library({ kind, noun }: { kind: LibraryKind; noun: string }) {
  const controller = useController();
  const { workspace } = useAppState();
  const [state, setState] = React.useState<{ status: 'loading' | 'ready' | 'error'; entries: any[]; error?: string }>({ status: 'loading', entries: [] });
  const blocked = controller.libraryBlock();
  const load = React.useCallback(() => {
    let live = true;
    setState(current => ({ ...current, status: 'loading', error: undefined }));
    controller.listLibrary(kind).then(
      entries => { if (live) setState({ status: 'ready', entries }); },
      error => { if (live) setState({ status: 'error', entries: [], error: describe(error).message }); },
    );
    return () => { live = false; };
  }, [controller, kind]);
  React.useEffect(() => blocked ? undefined : load(), [load, blocked, workspace]);
  if (blocked) return <Unavailable what={`Listing ${noun}`} why={blocked} />;
  return (
    <>
      <Section title={workspace ? `As ${baseName(workspace)} sees them` : undefined}
        action={<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => load()}>Refresh</Button>}>
        {state.status === 'loading' && !state.entries.length ? <div className="p-4"><Spinner label="Loading…" className="text-xs" /></div> : null}
        {state.status === 'error' ? <p role="alert" className="p-4 text-xs text-destructive">{state.error}</p> : null}
        {state.status === 'ready' && !state.entries.length ? <Row first title={`No ${noun}`} /> : null}
        {state.entries.map((entry, index) => (
          <Row key={`${entry.source}:${entry.name}`} first={index === 0} title={<span className="font-mono text-[13px]">{entry.name}</span>}
            hint={[entry.description, entry.usedBy?.length ? `Used by ${entry.usedBy.join(', ')}` : ''].filter(Boolean).join(' · ') || undefined}>
            <span className="text-xs">{entry.source}{entry.overrides ? ` · overrides ${entry.overrides}` : ''}</span>
          </Row>
        ))}
      </Section>
      <Unavailable what={`Viewing or editing ${noun}' content`} why="Entries can hold secrets (MCP URLs and commands, provider arguments) and commands the host runs, so the gateway sends names only. Edit them on the host with alp." />
    </>
  );
}

function PageContent({ page }: { page: Page }) {
  switch (page) {
    case 'general': return <General />;
    case 'appearance': return <Appearance />;
    case 'sidebar': return <Unavailable what="Arranging the sidebar" why="This beta's sidebar has a fixed layout: New session, then the workspaces and their sessions." />;
    case 'chat': return <Unavailable what="Chat display settings" why="Reasoning, tool calls and the chat outline show as Paseo's defaults; tool calls expand on click." />;
    case 'terminal': return <Unavailable what="Terminal" why="The gateway does not run terminals." />;
    case 'editor': return <Unavailable what="Editor" why="The gateway has no file access, so this app has no editor." />;
    case 'diagnostics': return <Unavailable what="App diagnostics" why="Collecting host, provider and log details runs on the host: use alp doctor there. Connection details are under Host › Connections." />;
    case 'about': return <About />;
    case 'host': return <Overview />;
    case 'projects': return <Projects />;
    case 'connections': return <Connections />;
    case 'alp-templates': return <Library kind="teams" noun="templates" />;
    case 'alp-agents': return <Library kind="agents" noun="agents" />;
    case 'alp-skills': return <Library kind="skills" noun="skills" />;
    case 'alp-hooks': return <Library kind="hooks" noun="hooks" />;
    case 'alp-mcp': return <Library kind="mcp" noun="MCP servers" />;
    case 'providers': return (
      <>
        <Library kind="providers" noun="providers" />
        <Unavailable what="Adding, testing or diagnosing providers" why="Tests run commands on the host; they are not offered remotely." />
      </>
    );
    case 'pair-device': return <Unavailable what="Pairing a device" why="This app is the remote client: open it on the other device and connect with an access token." />;
    case 'metadata': return <Unavailable what="Metadata generation" why="A host setting the gateway does not expose." />;
    case 'workspaces': return <Unavailable what="Workspace settings" why="The gateway has no file or git access, so workspaces and worktrees are managed on the host." />;
    case 'usage': return <Unavailable what="Usage and limits" why="Account-wide on the host; check with alp usage there." />;
    case 'terminals': return <Unavailable what="Terminals" why="The gateway does not run terminals." />;
    case 'plugins': return <Unavailable what="Plugins" why="Installing plugins changes the host; not offered remotely." />;
  }
}

function NavItem({ page, label, icon: IconComponent, selected, onSelect, mobile }: { page: Page; label: string; icon: Icon; selected: boolean; onSelect: (page: Page) => void; mobile: boolean }) {
  return (
    <button type="button" onClick={() => onSelect(page)} aria-current={selected ? 'page' : undefined} data-testid={`settings-${page}`}
      className={cn('flex min-h-7 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-sm text-muted-foreground hover:bg-sidebar-hover hover:text-foreground', focusRing, selected && 'bg-sidebar-hover text-foreground', mobile && 'min-h-10')}>
      <IconComponent aria-hidden strokeWidth={1.75} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {mobile ? <ChevronRight aria-hidden className="size-4 text-extra-muted" /> : null}
    </button>
  );
}

function SettingsNav({ page, onSelect, mobile }: { page: Page | null; onSelect: (page: Page) => void; mobile: boolean }) {
  const { connection } = useAppState();
  const host = connection.gateway.replace(/^https?:\/\//, '');
  return (
    <>
      <div className="flex flex-col gap-0.5 px-2 py-2">
        <p className="px-2 py-1 text-sm text-extra-muted">App</p>
        {APP_PAGES.map(item => <NavItem key={item.id} page={item.id} label={item.label} icon={item.icon} selected={page === item.id} onSelect={onSelect} mobile={mobile} />)}
      </div>
      <div className="flex flex-col gap-0.5 px-2 py-2">
        <p className="px-2 py-1 text-sm text-extra-muted">Host</p>
        <div className="flex min-h-7 items-center gap-2 px-2 py-1 text-sm" title={connection.gateway}>
          <span className="flex size-4 items-center justify-center"><span className={cn('size-2 rounded-full', connection.phase === 'open' ? 'bg-dot-success' : 'bg-dot-warning')} /></span>
          <span className="min-w-0 flex-1 truncate text-foreground">{host}</span>
        </div>
        {HOST_PAGES.map(item => <NavItem key={item.id} page={item.id} label={item.label} icon={item.icon} selected={page === item.id} onSelect={onSelect} mobile={mobile} />)}
      </div>
    </>
  );
}

export function SettingsScreen({ onClose, mobile }: { onClose: () => void; mobile: boolean }) {
  const [page, setPage] = React.useState<Page | null>(mobile ? null : 'general');
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(event.target instanceof HTMLElement && event.target.closest('[role="menu"],dialog'))) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const back = (label: string, onBack: () => void) => (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-2 md:h-9">
      <button type="button" onClick={onBack} className={cn('flex min-h-7 items-center gap-2 rounded-lg px-2 py-1 text-sm text-muted-foreground hover:bg-sidebar-hover hover:text-foreground', focusRing)}>
        <ArrowLeft aria-hidden className="size-4" />{label}
      </button>
    </div>
  );
  const detail = page ? (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[720px] p-4 pt-14">
        <h2 className="mb-6 ml-1 text-[26px] font-semibold text-foreground" data-testid="settings-detail-header-title">{LABEL[page]}</h2>
        <PageContent page={page} />
      </div>
    </div>
  ) : null;

  if (mobile) {
    return (
      <div role="region" aria-label="Settings" className="flex h-dvh flex-col bg-background">
        {page ? back('Settings', () => setPage(null)) : back('Back', onClose)}
        {page ? detail : (
          <nav aria-label="Settings" className="min-h-0 flex-1 overflow-y-auto"><SettingsNav page={null} onSelect={setPage} mobile /></nav>
        )}
      </div>
    );
  }
  return (
    <div role="region" aria-label="Settings" className="flex h-dvh overflow-hidden bg-background">
      <nav aria-label="Settings" className="flex w-[320px] shrink-0 flex-col border-r border-border bg-sidebar" data-testid="settings-sidebar">
        {back('Back', onClose)}
        <div className="min-h-0 flex-1 overflow-y-auto"><SettingsNav page={page} onSelect={setPage} mobile={false} /></div>
      </nav>
      <main className="flex min-w-0 flex-1 flex-col" data-testid="settings-detail-pane">{detail}</main>
    </div>
  );
}
