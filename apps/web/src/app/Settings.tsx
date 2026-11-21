import * as React from 'react';
import {
  ArrowDown, ArrowLeft, ArrowUp, Ban, BookOpen, Bot, Boxes, ChevronRight, CircleCheck, Code, Files as FilesIcon, FolderGit2, Gauge, History, Info,
  ListChecks, MessageSquare, Network, PanelLeft, Palette, Plug, Plus, Search, Server, Settings as SettingsIcon, Sparkles, SquareTerminal,
  Stethoscope, Users, Webhook,
} from 'lucide-react';
import { can } from '../lib/gateway.js';
import { diagnosticsSections, diagnosticsText, type DiagnosticsInput } from '../lib/diagnostics.js';
import { LIMITS, type ChatDisplay, type SendBehavior, type SendShortcut, type SidebarItem, type SidebarItemId, type SyntaxTheme, type ThemePreference } from '../lib/preferences.js';
import { DEFAULT_MONO_FONT_STACK, DEFAULT_UI_FONT_STACK, THEME_OPTIONS, contentWidth } from '../lib/theme';
import { SYNTAX_THEME_OPTIONS } from '../lib/syntax';
import { Switch } from '../components/ui/switch';
import { RichText } from './RichText';
import { Button } from '../components/ui/button';
import { Input, NativeSelect } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { modeLabel } from '../lib/format';
import { cn } from '../lib/utils';
import { useAppState, useController } from './store';
import { useNotificationPermission } from './attention';
import { Row, Section, Select, Unavailable, focusRing, type Page } from './settings/parts';
import { ProjectsPage, ProvidersPage, TerminalsPage, UsagePage, WorkspacesPage } from './settings/HostPages';
import { EditorPage, LibraryPage, MetadataPage } from './settings/LibraryPages';

/*
 * Settings as the old ALP web (the Paseo fork) lays them out: a full screen with its own sidebar
 * ("Back", then the App and Host groups, the host's ALP screens among them) and the
 * chosen page on the right, in cards. What the gateway does not offer is a page that says so; no
 * page falls back to the old app. Voice, Pair device and Plugins are not pages at all (t-a95b,
 * docs/breaking-changes.md): ALP has no speech provider, pairing is `alp dashboard pair` on the
 * host, and ALP has no way to install a plugin from the app. The host and library pages live in
 * settings/HostPages.tsx and settings/LibraryPages.tsx.
 */

type Icon = typeof Server;

const APP_PAGES: Array<{ id: Page; label: string; icon: Icon }> = [
  { id: 'general', label: 'General', icon: SettingsIcon },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'sidebar', label: 'Sidebar', icon: PanelLeft },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'terminal', label: 'Terminal', icon: SquareTerminal },
  { id: 'editor', label: 'Editor', icon: Code },
  { id: 'files', label: 'Files', icon: FilesIcon },
  { id: 'diagnostics', label: 'Diagnostics', icon: Stethoscope },
  { id: 'about', label: 'About', icon: Info },
];

const HOST_PAGES: Array<{ id: Page; label: string; icon: Icon }> = [
  { id: 'host', label: 'Overview', icon: Server },
  { id: 'projects', label: 'Projects', icon: FolderGit2 },
  { id: 'connections', label: 'Connections', icon: Network },
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
];

const LABEL = Object.fromEntries([...APP_PAGES, ...HOST_PAGES].map(page => [page.id, page.label])) as Record<Page, string>;

/** The rows Settings › Sidebar lists, as the sidebar shows them. */
const SIDEBAR_ITEM_LABELS: Record<SidebarItemId, { label: string; icon: Icon }> = {
  'new-session': { label: 'New session', icon: Plus },
  history: { label: 'History', icon: History },
  search: { label: 'Search', icon: Search },
  tasks: { label: 'Tasks', icon: ListChecks },
};

/** Paseo's appearance preview: content text, a code block in the highlight theme and the code font. */
const PREVIEW = 'Readable **content** and `code` preview.\n\n```ts\n// The highlight theme, code font and code size\nexport function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n```';

function AppearancePreview() {
  return (
    <section className="mb-6 rounded-lg border border-border bg-background p-4" aria-label="Live preview of content typography, syntax theme, and code font" data-testid="appearance-preview">
      <RichText text={PREVIEW} />
    </section>
  );
}

// ---- pages ----------------------------------------------------------------------------------

/** Browser notifications when a session waits for an answer: the browser asks on this click. */
function NotificationsRow() {
  const { permission, request } = useNotificationPermission();
  const hint = permission === 'unsupported' ? 'This browser cannot show notifications.'
    : permission === 'denied' ? 'Blocked in this browser. Allow notifications for this site in the browser settings to get them.'
    : permission === 'granted' ? 'On: a notification when a session waits for your answer while you are elsewhere. The tab icon shows it too.'
    : 'Get a notification when a session waits for your answer while you are elsewhere. The browser asks first.';
  return (
    <Row title="Notifications" hint={hint}>
      {permission === 'default' ? <Button size="sm" variant="secondary" onClick={() => { void request(); }}>Enable</Button>
        : <span className="text-sm text-muted-foreground" data-testid="notification-permission">{permission === 'granted' ? 'Allowed' : permission === 'denied' ? 'Blocked' : 'Unavailable'}</span>}
    </Row>
  );
}

/** Paseo's sending copy (en.ts settings.general.defaultSend), per send shortcut. */
function sendHint(behavior: SendBehavior, shortcut: SendShortcut, mod: string) {
  if (shortcut === 'mod-enter') {
    return behavior === 'interrupt' ? `When the agent is running, ${mod}+Enter interrupts. Enter inserts a new line.`
      : behavior === 'queue' ? `When the agent is running, ${mod}+Enter queues. Enter inserts a new line.`
      : `When the agent is running, ${mod}+Enter steers the active turn. Enter inserts a new line.`;
  }
  return behavior === 'interrupt' ? 'When the agent is running, Enter interrupts. Command/Ctrl+Enter queues.'
    : behavior === 'queue' ? 'When the agent is running, Enter queues. Command/Ctrl+Enter submits.'
    : 'When the agent is running, Enter steers the active turn. Command/Ctrl+Enter queues.';
}

const MOD_KEY = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘' : 'Ctrl';

function General({ mobile }: { mobile: boolean }) {
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
        {/* Paseo offers the send shortcut where keyboard shortcuts are (not on a phone). */}
        {!mobile ? (
          <Row first title="Send shortcut">
            <Select<SendShortcut> label="Send shortcut" value={preferences.sendShortcut} onChange={sendShortcut => controller.updatePreferences({ sendShortcut })}
              options={[{ value: 'enter', label: 'Enter' }, { value: 'mod-enter', label: `${MOD_KEY}+Enter` }]} />
          </Row>
        ) : null}
        <Row first={mobile} title="Default send" hint={sendHint(preferences.sendBehavior, mobile ? 'enter' : preferences.sendShortcut, MOD_KEY)}>
          <Select<SendBehavior> label="Default send" value={preferences.sendBehavior} onChange={value => controller.setSendBehavior(value)}
            options={[{ value: 'interrupt', label: 'Interrupt' }, { value: 'steer', label: 'Steer' }, { value: 'queue', label: 'Queue' }]} />
        </Row>
      </Section>
      <Section title="This browser">
        <Row first title="Saved settings" hint="Every App setting and your last New session choices (team, model, thinking, permissions) stay in this browser. The access token never does.">
          <Button size="sm" variant="secondary" onClick={() => controller.resetPreferences()}>Reset</Button>
        </Row>
        <NotificationsRow />
      </Section>
    </>
  );
}

/**
 * A text or number field that commits on blur or Enter (Paseo's settings fields): a number is
 * clamped to its limits, an invalid one goes back to the value in effect.
 */
function CommitField({ label, value, placeholder, numeric, limits, width = 'w-28', onCommit }: {
  label: string; value: string; placeholder?: string; numeric?: boolean; limits?: readonly number[]; width?: string; onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = React.useState(value);
  React.useEffect(() => setDraft(value), [value]);
  const commit = () => {
    if (!numeric || !limits) { if (draft.trim() !== value) onCommit(draft.trim()); else setDraft(value); return; }
    const parsed = Number.parseInt(draft, 10);
    if (!Number.isFinite(parsed)) { setDraft(value); return; }
    const next = String(Math.min(limits[1], Math.max(limits[0], parsed)));
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  return (
    <Input aria-label={label} value={draft} placeholder={placeholder} inputMode={numeric ? 'numeric' : undefined}
      onChange={event => setDraft(numeric ? event.target.value.replace(/[^\d]/g, '') : event.target.value)}
      onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } }}
      onFocus={event => event.target.select()} className={cn('h-8', width, numeric && 'text-right tabular-nums')} />
  );
}

function SizeRow({ title, hint, label, value, limits, onCommit }: { title: string; hint: string; label: string; value: number; limits: readonly number[]; onCommit: (value: number) => void }) {
  return (
    <Row title={title} hint={hint}>
      <span className="flex items-center gap-2">
        <CommitField label={label} value={String(value)} numeric limits={limits} width="w-16" onCommit={next => onCommit(Number(next))} />
        <span className="text-xs">px</span>
      </span>
    </Row>
  );
}

function Appearance() {
  const controller = useController();
  const { preferences } = useAppState();
  const swatch = THEME_OPTIONS.find(option => option.value === preferences.theme)?.swatch;
  return (
    <>
      <Section title="Theme">
        <Row first title="Theme">
          <span className="flex items-center gap-2">
            {swatch ? <span aria-hidden className="size-3 rounded-full border border-border" style={{ backgroundColor: swatch }} data-testid="theme-swatch" /> : null}
            <NativeSelect aria-label="Theme" value={preferences.theme} onChange={event => controller.setTheme(event.target.value as ThemePreference)}
              className="h-8 w-auto rounded-lg border-border bg-transparent pl-3 text-sm text-foreground">
              {THEME_OPTIONS.filter(option => option.group === 'primary').map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              <option disabled>──────</option>
              {THEME_OPTIONS.filter(option => option.group === 'variant').map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </NativeSelect>
          </span>
        </Row>
      </Section>
      <Section title="Fonts">
        <Row first title="Interface font" hint="Used across the app. Leave empty for the system default">
          <CommitField label="Interface font family" value={preferences.uiFontFamily} placeholder={DEFAULT_UI_FONT_STACK} width="w-64 max-w-full"
            onCommit={uiFontFamily => controller.updatePreferences({ uiFontFamily })} />
        </Row>
        <SizeRow title="Interface size" hint="Used for navigation, controls, and labels" label="Interface font size" value={preferences.uiFontSize} limits={LIMITS.uiFontSize}
          onCommit={uiFontSize => controller.updatePreferences({ uiFontSize })} />
        <SizeRow title="Content size" hint="Used for chat text and rendered Markdown" label="Content font size" value={preferences.contentFontSize} limits={LIMITS.contentFontSize}
          onCommit={contentFontSize => controller.updatePreferences({ contentFontSize })} />
        <Row title="Code font" hint="Used in code, diffs, and the terminal output. Leave empty for the system default">
          <CommitField label="Code font family" value={preferences.monoFontFamily} placeholder={DEFAULT_MONO_FONT_STACK} width="w-64 max-w-full"
            onCommit={monoFontFamily => controller.updatePreferences({ monoFontFamily })} />
        </Row>
        <SizeRow title="Code size" hint="Used for code, diffs, and terminal output" label="Code font size" value={preferences.codeFontSize} limits={LIMITS.codeFontSize}
          onCommit={codeFontSize => controller.updatePreferences({ codeFontSize })} />
      </Section>
      <Section title="Layout">
        <Row first title="Content width" hint="Max width of chat and Markdown files on wide screens">
          <span className="flex items-center gap-2">
            {preferences.contentMaxWidth !== null ? <Button size="sm" variant="ghost" aria-label="Reset content width to default" onClick={() => controller.updatePreferences({ contentMaxWidth: null })}>Reset</Button> : null}
            <CommitField label="Content width in pixels" value={String(contentWidth(preferences))} numeric limits={LIMITS.contentMaxWidth} width="w-20"
              onCommit={next => controller.updatePreferences({ contentMaxWidth: Number(next) })} />
            <span className="text-xs">px</span>
          </span>
        </Row>
      </Section>
      <Section title="Syntax">
        <Row first title="Highlight theme" hint="Colors for code, independent of the app theme">
          <Select<SyntaxTheme> label="Highlight theme" value={preferences.syntaxTheme} onChange={syntaxTheme => controller.updatePreferences({ syntaxTheme })} options={SYNTAX_THEME_OPTIONS} />
        </Row>
      </Section>
      <AppearancePreview />
    </>
  );
}

/** Paseo's Settings › Sidebar: per section, each row with Move up, Move down and a show switch. */
function SidebarSettings() {
  const controller = useController();
  const { preferences } = useAppState();
  const change = (section: 'header' | 'footer', rows: SidebarItem[]) => controller.updatePreferences({ sidebar: { ...preferences.sidebar, [section]: rows } });
  const move = (section: 'header' | 'footer', index: number, by: -1 | 1) => {
    const rows = [...preferences.sidebar[section]];
    [rows[index], rows[index + by]] = [rows[index + by], rows[index]];
    change(section, rows);
  };
  const card = (section: 'header' | 'footer', title: string, info: string) => (
    <Section title={title}>
      <p className="px-4 pt-3 text-xs text-muted-foreground">{info}</p>
      {preferences.sidebar[section].map((row, index, rows) => {
        const item = SIDEBAR_ITEM_LABELS[row.id];
        return (
          <div key={row.id} className={cn('flex items-center gap-2 p-4', index > 0 && 'border-t border-border')} data-testid={`sidebar-nav-item-${row.id}`}>
            <item.icon aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{item.label}</span>
            <Button size="icon" variant="ghost" className="size-7" aria-label={`Move ${item.label} up`} disabled={index === 0} onClick={() => move(section, index, -1)}><ArrowUp aria-hidden /></Button>
            <Button size="icon" variant="ghost" className="size-7" aria-label={`Move ${item.label} down`} disabled={index === rows.length - 1} onClick={() => move(section, index, 1)}><ArrowDown aria-hidden /></Button>
            <Switch checked={row.visible} aria-label={item.label} onCheckedChange={visible => change(section, rows.map(other => other.id === row.id ? { ...other, visible } : other))} />
          </div>
        );
      })}
    </Section>
  );
  return (
    <>
      {card('header', 'Header', 'Choose which items appear at the top of the sidebar and in what order')}
      {card('footer', 'Footer', 'Choose which rows appear at the bottom of the sidebar and in what order. The host and Settings row always shows')}
    </>
  );
}

function Chat() {
  const controller = useController();
  const { preferences } = useAppState();
  return (
    <>
      <Section title="Detail level">
        <Row first title="Chat display" hint="How much of an agent's work the chat shows">
          <Select<ChatDisplay> label="Chat display" value={preferences.chatDisplay} onChange={chatDisplay => controller.updatePreferences({ chatDisplay })}
            options={[{ value: 'full', label: 'Full' }, { value: 'collapseToolCalls', label: 'Collapse tool calls' }, { value: 'collapseTurns', label: 'Collapse turns' }]} />
        </Row>
        <Row title="Chat outline" hint="Show an outline for jumping between prompts">
          <Switch checked={preferences.chatOutline} aria-label="Chat outline" onCheckedChange={chatOutline => controller.updatePreferences({ chatOutline })} />
        </Row>
      </Section>
      <Unavailable what="Always expand reasoning" why="ALP's hosts do not send the agents' reasoning, so there is nothing to expand." />
    </>
  );
}

function Terminal() {
  const controller = useController();
  const { preferences } = useAppState();
  return (
    <Section title="Terminal">
      <Row first title="Terminal scrollback" hint="Lines kept in the built-in terminal buffer">
        <CommitField label="Terminal scrollback lines" value={String(preferences.terminalScrollback)} numeric limits={LIMITS.terminalScrollback}
          onCommit={next => controller.updatePreferences({ terminalScrollback: Number(next) })} />
      </Row>
    </Section>
  );
}

/** Paseo 0.14's Settings › Files: which panel opens each file type, for types several panels claim. */
function Files() {
  return (
    <Section title="Files">
      <div className="p-4 text-center text-sm text-muted-foreground" data-testid="file-panel-settings-empty">File panels appear here when a plugin adds one</div>
    </Section>
  );
}

/** What the browser reports about itself, for Diagnostics. */
function browserFacts() {
  const light = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: light)').matches;
  return {
    userAgent: navigator.userAgent,
    language: navigator.language,
    online: navigator.onLine,
    secure: window.isSecureContext,
    viewport: `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`,
    colorScheme: light ? 'light' : 'dark',
  };
}

/** Paseo's App diagnostic: Run collects a report, shown below with Copy and Refresh. */
function Diagnostics() {
  const { connection, principal, preferences } = useAppState();
  const [report, setReport] = React.useState<DiagnosticsInput | null>(null);
  const [copied, setCopied] = React.useState<'idle' | 'copied' | 'failed'>('idle');
  const run = () => { setCopied('idle'); setReport({ version: __ALP_WEB_VERSION__, connection, principal, preferences, browser: browserFacts(), now: new Date() }); };
  const copy = async () => {
    if (!report) return;
    try { await navigator.clipboard.writeText(diagnosticsText(report)); setCopied('copied'); }
    catch { setCopied('failed'); }
  };
  return (
    <>
      <Section title="Diagnostics">
        <Row first title="App diagnostic" hint="Collect connection, host and browser details. Providers, logs and the daemon itself: run alp doctor on the host.">
          <Button size="sm" variant="secondary" data-testid="settings-diagnostics-run" onClick={run}>{report ? 'Refresh' : 'Run'}</Button>
        </Row>
      </Section>
      {report ? (
        <>
          <Section title={`Diagnostic, ${report.now?.toLocaleTimeString() ?? ''}`} action={<Button size="sm" variant="ghost" className="h-7 text-xs" data-testid="settings-diagnostics-copy" onClick={() => { void copy(); }}>{copied === 'copied' ? 'Copied' : 'Copy diagnostic'}</Button>}>
            {copied === 'failed' ? <p role="alert" className="px-4 py-3 text-xs text-destructive">Failed to copy diagnostic. Select the values below instead.</p> : null}
            <p className="px-4 py-3 text-xs text-muted-foreground">It holds no access token, prompts or files.</p>
          </Section>
          {diagnosticsSections(report).map(section => (
            <Section key={section.title} title={section.title}>
              {section.rows.map(([key, value], index) => (
                <Row key={key} first={index === 0} title={key}><span className="break-all font-mono text-xs" data-testid={`diagnostics-${key.toLowerCase().replace(/\W+/g, '-')}`}>{value}</span></Row>
              ))}
            </Section>
          ))}
        </>
      ) : null}
    </>
  );
}

/** The host's label: its machine name from the hello (Paseo patch 0017), else the gateway's address. */
function hostLabel(connection: { gateway: string; hostname?: string }) {
  return connection.hostname ?? connection.gateway.replace(/^https?:\/\//, '');
}

const normalizeVersion = (version: string | undefined) => version?.trim().replace(/^v/i, '') || null;

/** ALP's release notes, as Paseo's What's new opens its changelog. */
const RELEASES_URL = 'https://github.com/phucanh08/alp/releases';

function About() {
  const { connection } = useAppState();
  const host = hostLabel(connection);
  const hostVersion = normalizeVersion(connection.daemonVersion);
  const offline = connection.phase !== 'open';
  const differs = !!hostVersion && hostVersion !== normalizeVersion(__ALP_WEB_VERSION__);
  return (
    <>
      <Section title="About">
        <Row first title="App version" hint="This device">v{__ALP_WEB_VERSION__}</Row>
        <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" data-testid="settings-whats-new" className={cn('block hover:bg-sidebar-hover', focusRing)}>
          <Row title="What's new" hint="Release notes for every version"><ChevronRight aria-hidden className="size-4" /></Row>
        </a>
      </Section>
      <Section title="Connected hosts">
        <Row first title={host} hint={offline ? 'Offline' : differs ? 'Version differs from this device' : 'ALP on the host, through the gateway (ALP JSON-RPC v1)'}>
          <span data-testid="connected-host-version">{hostVersion ? `v${hostVersion}` : 'unknown'}</span>
        </Row>
      </Section>
    </>
  );
}

function Overview() {
  const controller = useController();
  const { principal, connection, settings } = useAppState();
  const [refreshing, setRefreshing] = React.useState(false);
  React.useEffect(() => { void controller.loadSettings(); }, [controller]);
  const permissions = ['session.read', 'session.write', 'project.read', 'project.write', 'workspace.write', 'workspace.manage', 'files.read', 'library.write', 'terminal.exec'];
  return (
    <>
      <Section title="Host">
        <Row first title="Machine" hint="The host's name, as it reports it.">{connection.hostname ?? 'unknown'}</Row>
        <Row title="ALP">{connection.daemonVersion ?? 'unknown'}</Row>
        <Row title="Gateway"><span className="break-all font-mono text-xs">{connection.gateway}</span></Row>
        <Row title="Agents' language" hint="Set on the host with alp; read only here.">
          {settings.status === 'loading' ? <Spinner label="Loading…" className="text-xs" /> : settings.language ? `${settings.language.applies}${settings.language.language ? '' : ' (default)'}` : 'Not available'}
        </Row>
        {settings.status === 'error' ? <p role="alert" className="border-t border-border px-4 py-3 text-xs text-destructive">{settings.error?.message}</p> : null}
      </Section>
      <Section title={`Models new sessions can pick${settings.models.length ? ` (${settings.models.length})` : ''}`}
        action={controller.hasCapability('catalog.live') ? <Button size="sm" variant="ghost" className="h-7 text-xs" data-testid="settings-models-refresh" disabled={refreshing} onClick={() => { setRefreshing(true); void controller.refreshModels().catch(() => {}).finally(() => setRefreshing(false)); }}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button> : undefined}>
        {settings.models.length ? (
          <ul className="max-h-72 divide-y divide-border overflow-y-auto">
            {settings.models.map(model => (
              <li key={model.id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
                <span className="min-w-0 truncate">{model.label}</span>
                <span className="shrink-0 font-mono text-[length:calc(11px*var(--ui-scale))] text-muted-foreground">{model.id}</span>
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

function PageContent({ page, mobile, onNavigate }: { page: Page; mobile: boolean; onNavigate: (page: Page) => void }) {
  switch (page) {
    case 'general': return <General mobile={mobile} />;
    case 'appearance': return <Appearance />;
    case 'sidebar': return <SidebarSettings />;
    case 'chat': return <Chat />;
    case 'terminal': return <Terminal />;
    case 'files': return <Files />;
    case 'editor': return <EditorPage />;
    case 'diagnostics': return <Diagnostics />;
    case 'about': return <About />;
    case 'host': return <Overview />;
    case 'projects': return <ProjectsPage />;
    case 'connections': return <Connections />;
    case 'alp-templates': return <LibraryPage kind="teams" noun="templates" />;
    case 'alp-agents': return <LibraryPage kind="agents" noun="agents" />;
    case 'alp-skills': return <LibraryPage kind="skills" noun="skills" />;
    case 'alp-hooks': return <LibraryPage kind="hooks" noun="hooks" />;
    case 'alp-mcp': return <LibraryPage kind="mcp" noun="MCP servers" />;
    case 'providers': return <ProvidersPage />;
    case 'metadata': return <MetadataPage />;
    case 'workspaces': return <WorkspacesPage />;
    case 'usage': return <UsagePage />;
    case 'terminals': return <TerminalsPage onNavigate={onNavigate} />;
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
  const host = hostLabel(connection);
  return (
    <>
      <div className="flex flex-col gap-0.5 px-2 py-2">
        <p className="px-2 py-1 text-sm text-extra-muted">App</p>
        {APP_PAGES.map(item => <NavItem key={item.id} page={item.id} label={item.label} icon={item.icon} selected={page === item.id} onSelect={onSelect} mobile={mobile} />)}
      </div>
      <div className="flex flex-col gap-0.5 px-2 py-2">
        <p className="px-2 py-1 text-sm text-extra-muted">Host</p>
        <div className="flex min-h-7 items-center gap-2 px-2 py-1 text-sm" title={connection.gateway} data-testid="settings-host-label">
          <span className="flex size-4 items-center justify-center"><span className={cn('size-2 rounded-full', connection.phase === 'open' ? 'bg-dot-success' : 'bg-dot-warning')} /></span>
          <span className="min-w-0 flex-1 truncate text-foreground">{host}</span>
        </div>
        {HOST_PAGES.map(item => <NavItem key={item.id} page={item.id} label={item.label} icon={item.icon} selected={page === item.id} onSelect={onSelect} mobile={mobile} />)}
      </div>
    </>
  );
}

export function SettingsScreen({ onClose, mobile, initialPage }: { onClose: () => void; mobile: boolean; initialPage?: Page }) {
  const [page, setPage] = React.useState<Page | null>(initialPage ?? (mobile ? null : 'general'));
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
        <h2 className="mb-6 ml-1 text-[length:calc(26px*var(--ui-scale))] font-semibold text-foreground" data-testid="settings-detail-header-title">{LABEL[page]}</h2>
        <PageContent page={page} mobile={mobile} onNavigate={setPage} />
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
