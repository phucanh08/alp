import * as React from 'react';
import {
  ArrowDown, ArrowLeft, ArrowUp, Ban, Blocks, BookOpen, Bot, Boxes, ChevronRight, CircleCheck, Code, Files as FilesIcon, FolderGit2, Gauge, History, Info,
  ListChecks, MessageSquare, Mic, Network, PanelLeft, Palette, Pin, Plug, Plus, Search, Server, Settings as SettingsIcon, Smartphone, Sparkles, SquareTerminal,
  Stethoscope, Users, Webhook,
} from 'lucide-react';
import { can } from '../lib/gateway.js';
import { diagnosticsSections, diagnosticsText, type DiagnosticsInput } from '../lib/diagnostics.js';
import { LIMITS, type ChatDisplay, type SendBehavior, type SendShortcut, type SidebarItem, type SidebarItemId, type SyntaxTheme, type ThemePreference } from '../lib/preferences.js';
import { DEFAULT_MONO_FONT_STACK, DEFAULT_UI_FONT_STACK, THEME_OPTIONS, contentWidth } from '../lib/theme';
import { SYNTAX_THEME_OPTIONS } from '../lib/syntax';
import { TERMINAL_MESSAGES, terminalGate } from '../lib/terminal.js';
import { Switch } from '../components/ui/switch';
import { RichText } from './RichText';
import { describe } from '../lib/errors.js';
import { Button } from '../components/ui/button';
import { Input, NativeSelect } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { baseName, modeLabel } from '../lib/format';
import { HIDDEN, libraryContentParts } from '../lib/library.js';
import { cn } from '../lib/utils';
import { useAppState, useController } from './store';
import { useNotificationPermission } from './attention';

/*
 * Settings as the old ALP web (the Paseo fork) lays them out: a full screen with its own sidebar
 * ("Back", then the App and Host groups, the host's ALP screens among them) and the
 * chosen page on the right, in cards. What the gateway does not offer is a page that says so; no
 * page falls back to the old app.
 */

type Icon = typeof Server;
type Page =
  | 'general' | 'appearance' | 'sidebar' | 'chat' | 'terminal' | 'editor' | 'files' | 'diagnostics' | 'about'
  | 'host' | 'projects' | 'connections' | 'pair-device' | 'alp-templates' | 'alp-agents' | 'alp-skills' | 'alp-hooks' | 'alp-mcp'
  | 'metadata' | 'voice' | 'workspaces' | 'providers' | 'usage' | 'terminals' | 'plugins';

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
  { id: 'pair-device', label: 'Pair device', icon: Smartphone },
  { id: 'alp-templates', label: 'Templates', icon: Users },
  { id: 'alp-agents', label: 'Agents', icon: Bot },
  { id: 'alp-skills', label: 'Skills', icon: BookOpen },
  { id: 'alp-hooks', label: 'Hooks', icon: Webhook },
  { id: 'alp-mcp', label: 'MCP servers', icon: Plug },
  { id: 'metadata', label: 'Metadata', icon: Sparkles },
  { id: 'voice', label: 'Voice', icon: Mic },
  { id: 'workspaces', label: 'Workspaces', icon: FolderGit2 },
  { id: 'providers', label: 'Providers', icon: Boxes },
  { id: 'usage', label: 'Usage', icon: Gauge },
  { id: 'terminals', label: 'Terminals', icon: SquareTerminal },
  { id: 'plugins', label: 'Plugins', icon: Blocks },
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

function Projects() {
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

function Workspaces() {
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

function Terminals({ onNavigate }: { onNavigate: (page: Page) => void }) {
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

type LibraryEntry = Awaited<ReturnType<ReturnType<typeof useController>['getLibraryEntry']>>;

/** One entry's content, read only: Markdown files as text, configuration as JSON with secrets hidden. */
function LibraryEntryView({ kind, name, onClose }: { kind: LibraryKind; name: string; onClose: () => void }) {
  const controller = useController();
  const [state, setState] = React.useState<{ status: 'loading' | 'ready' | 'error'; entry?: LibraryEntry; error?: string }>({ status: 'loading' });
  React.useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    controller.getLibraryEntry(kind, name).then(
      entry => { if (live) setState({ status: 'ready', entry }); },
      error => { if (live) setState({ status: 'error', error: describe(error).message }); },
    );
    return () => { live = false; };
  }, [controller, kind, name]);
  const entry = state.entry;
  return (
    <Section title={name} action={<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={onClose}>Close</Button>}>
      <div data-testid="library-entry" aria-label={`${name} content`} role="group">
        {state.status === 'loading' ? <div className="p-4"><Spinner label="Loading…" className="text-xs" /></div> : null}
        {state.status === 'error' ? <p role="alert" className="p-4 text-xs text-destructive">{state.error}</p> : null}
        {entry ? (
          <>
            <Row first title="Source" hint={entry.usedBy.length ? `Used by ${entry.usedBy.join(', ')}` : undefined}>
              <span className="text-xs">{entry.source}{entry.overrides ? ` · overrides ${entry.overrides}` : ''}</span>
            </Row>
            {entry.librarySkills?.length ? <Row title="Skills the library gives it">{entry.librarySkills.join(', ')}</Row> : null}
            {libraryContentParts(entry.content).map(part => (
              <div key={part.key} className="border-t border-border p-4">
                <div className="mb-2 font-mono text-xs text-muted-foreground">{part.label}</div>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary p-3 font-mono text-xs text-foreground">{part.text}</pre>
              </div>
            ))}
            {entry.secrets.length ? <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{entry.secrets.length === 1 ? 'One value that can hold a secret is' : `${entry.secrets.length} values that can hold secrets are`} shown as {HIDDEN}: the gateway keeps them on the host.</p> : null}
          </>
        ) : null}
      </div>
    </Section>
  );
}

/** Writes pure project instructions; executable and inherited entries stay on the host. */
function LibraryEditor({ kind, selected, onChanged }: { kind: LibraryKind; selected: string | null; onChanged: () => void }) {
  const controller = useController();
  const [name, setName] = React.useState('');
  const [target, setTarget] = React.useState('');
  const [content, setContent] = React.useState('');
  const [revision, setRevision] = React.useState<string | null>(null);
  const [ready, setReady] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  React.useEffect(() => {
    let live = true;
    setReady(false); setError(null); setNote(null); setTarget('');
    if (!selected) {
      setName(''); setRevision(null);
      setContent(JSON.stringify(kind === 'skills' ? { body: '' } : { instructions: '', config: { description: '' } }, null, 2));
      setReady(true);
    } else controller.getLibraryEntry(kind, selected).then(entry => {
      if (!live) return;
      if (entry.source !== 'project' || entry.overrides || entry.secrets.length || entry.revision === undefined) {
        setNote('This entry holds configuration the host runs or values kept on the host, so it is read only here.'); return;
      }
      setName(selected); setRevision(entry.revision); setContent(JSON.stringify(entry.content, null, 2)); setReady(true);
    }, failure => { if (live) setError(describe(failure).message); });
    return () => { live = false; };
  }, [controller, kind, selected]);
  const mutate = async (action: 'save' | 'delete' | 'duplicate' | 'rename') => {
    setBusy(true); setError(null);
    try {
      const params = action === 'save' ? { name, content: JSON.parse(content), revision } : action === 'delete' ? { name, revision } : { from: name, to: target };
      const result = await controller.writeLibrary(action, kind, params);
      if (action === 'save') setRevision(result.revision);
      if (action === 'delete' || action === 'rename') setReady(false);
      onChanged();
    } catch (failure) { setError(describe(failure).message); }
    finally { setBusy(false); }
  };
  return <Section title={selected ? 'Edit project instructions' : 'New project instructions'}>
    <div className="flex flex-col gap-3 p-4">
      <p className="text-xs text-muted-foreground">Agents and skills only. Host entries, executable configuration, references and extra files cannot be changed here.</p>
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      {note ? <p role="note" className="text-xs text-muted-foreground">{note}</p> : null}
      {ready ? <>
        <Input aria-label="Entry name" value={name} onChange={e => setName(e.target.value)} disabled={busy || !!selected} placeholder="Entry name" />
        <textarea aria-label="Instruction entry JSON" className="min-h-48 rounded border border-border bg-background p-2 font-mono text-xs" value={content} onChange={e => setContent(e.target.value)} disabled={busy} />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={busy || !name.trim()} onClick={() => void mutate('save')}>Save project entry</Button>
          {selected ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void mutate('delete')}>Delete project entry</Button> : null}
        </div>
        {selected ? <div className="flex flex-wrap gap-2">
          <Input aria-label="New entry name" value={target} onChange={e => setTarget(e.target.value)} placeholder="New name" disabled={busy} />
          <Button size="sm" variant="secondary" disabled={busy || !target.trim()} onClick={() => void mutate('duplicate')}>Duplicate</Button>
          <Button size="sm" variant="secondary" disabled={busy || !target.trim()} onClick={() => void mutate('rename')}>Rename</Button>
        </div> : null}
      </> : null}
    </div>
  </Section>;
}

function Library({ kind, noun }: { kind: LibraryKind; noun: string }) {
  const controller = useController();
  const { workspace } = useAppState();
  const [state, setState] = React.useState<{ status: 'loading' | 'ready' | 'error'; entries: any[]; error?: string }>({ status: 'loading', entries: [] });
  const [open, setOpen] = React.useState<string | null>(null);
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
  React.useEffect(() => { setOpen(null); }, [kind, workspace]);
  if (blocked) return <Unavailable what={`Listing ${noun}`} why={blocked} />;
  const opened = open ? state.entries.find(entry => entry.name === open) : undefined;
  const editable: string | null = opened && opened.source === 'project' && !opened.overrides ? opened.name : null;
  return (
    <>
      <Section title={workspace ? `As ${baseName(workspace)} sees them` : undefined}
        action={<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => load()}>Refresh</Button>}>
        {state.status === 'loading' && !state.entries.length ? <div className="p-4"><Spinner label="Loading…" className="text-xs" /></div> : null}
        {state.status === 'error' ? <p role="alert" className="p-4 text-xs text-destructive">{state.error}</p> : null}
        {state.status === 'ready' && !state.entries.length ? <Row first title={`No ${noun}`} /> : null}
        {state.entries.map((entry, index) => (
          <button key={`${entry.source}:${entry.name}`} type="button" onClick={() => setOpen(current => current === entry.name ? null : entry.name)}
            aria-expanded={open === entry.name} data-testid={`library-row-${entry.name}`}
            className={cn('block w-full text-left hover:bg-sidebar-hover', focusRing, open === entry.name && 'bg-sidebar-hover')}>
            <Row first={index === 0} title={<span className="font-mono text-[length:calc(13px*var(--ui-scale))]">{entry.name}</span>}
              hint={[entry.description, entry.usedBy?.length ? `Used by ${entry.usedBy.join(', ')}` : ''].filter(Boolean).join(' · ') || undefined}>
              <span className="text-xs">{entry.source}{entry.overrides ? ` · overrides ${entry.overrides}` : ''}</span>
            </Row>
          </button>
        ))}
      </Section>
      {/* An entry from the host or the library (builtin, user, library) is read only: opening it
          to read keeps the New editor; this project's own entries open in the editor. */}
      {!controller.libraryWriteBlock(kind) ? <LibraryEditor key={`${kind}:${workspace}:${editable ?? 'new'}`} kind={kind} selected={editable} onChanged={() => load()} /> : null}
      {open ? <LibraryEntryView kind={kind} name={open} onClose={() => setOpen(null)} /> : null}
      {controller.libraryWriteBlock(kind) ? <Unavailable what={`Editing ${noun}`} why={`${controller.libraryWriteBlock(kind)} Open an entry to read it. Values that can hold secrets (environment, headers, MCP URLs and arguments, hook commands) show as ${HIDDEN}. Changes configure commands the host runs, so edit them on the host with alp.`} /> : null}
    </>
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
    case 'editor': return <Unavailable what="Editor" why="This app opens a workspace's files read only (the Files panel); changing them is the agents' work, or yours on the host." />;
    case 'diagnostics': return <Diagnostics />;
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
    case 'voice': return <Unavailable what="Voice" why="Paseo's dictation and voice mode turn speech into prompts with a speech provider set up on the host. ALP's agents take text, and its hosts have no speech provider to set up." />;
    case 'metadata': return <Unavailable what="Metadata generation" why="A host setting the gateway does not expose." />;
    case 'workspaces': return <Workspaces />;
    case 'usage': return <Unavailable what="Usage and limits" why="Account-wide on the host; check with alp usage there." />;
    case 'terminals': return <Terminals onNavigate={onNavigate} />;
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
