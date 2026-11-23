import * as React from 'react';
import {
  ArrowDown, ArrowLeft, ArrowUp, Ban, Bell, BookOpen, Bot, Boxes, CalendarClock, ChevronRight, CircleCheck, Code, Files as FilesIcon, FolderGit2, Gauge, History, Info,
  ListChecks, MessageSquare, Network, PanelLeft, Palette, Plug, Plus, Search, Server, Settings as SettingsIcon, SquareTerminal,
  Github, Stethoscope, Users, Webhook,
} from 'lucide-react';
import { can } from '../lib/gateway.js';
import { describe } from '../lib/errors.js';
import { diagnosticsSections, diagnosticsText, type DiagnosticsInput } from '../lib/diagnostics.js';
import { CONTENT_WIDTH_WIDE, LIMITS, type ChatDisplay, type Preferences, type SendBehavior, type SendShortcut, type SidebarItem, type SidebarItemId, type SyntaxTheme, type ThemePreference } from '../lib/preferences.js';
import { DEFAULT_MONO_FONT_STACK, DEFAULT_UI_FONT_STACK, THEME_OPTIONS, contentWidthPreset } from '../lib/theme';
import { THEME_PREVIEWS } from '../lib/theme-previews.js';
import { SYNTAX_THEME_OPTIONS } from '../lib/syntax';
import { Switch } from '../components/ui/switch';
import { RichText } from './RichText';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Spinner } from '../components/ui/spinner';
import { modeLabel } from '../lib/format';
import { cn } from '../lib/utils';
import { useAppState, useController, useOwner } from './store';
import { sendTestNotification, useNotificationPermission } from './attention';
import { Row, Section, Select, focusRing, type Page } from './settings/parts';
import { ProjectsPage, ProvidersPage, TerminalsPage, UsagePage, WorkspacesPage } from './settings/HostPages';
import { EditorPage, LibraryPage } from './settings/LibraryPages';

/*
 * Settings as the old ALP web (the Paseo fork) lays them out: a full screen with its own sidebar
 * ("Back", then the App and Host groups, the host's ALP screens among them) and the
 * chosen page on the right, in cards. What the gateway does not offer is a page that says so; no
 * page falls back to the old app. Voice, Pair device, Plugins and Metadata are not pages at all
 * (t-a95b, docs/breaking-changes.md): ALP has no speech provider, pairing is `alp dashboard pair`
 * on the host, ALP has no way to install a plugin from the app, and ALP has no session title or
 * branch generation to set up. The host and library pages live in
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
  // Paseo's Notifications page (desktop-notifications-section.tsx); ALP's browser has it too.
  { id: 'notifications', label: 'Notifications', icon: Bell },
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
  schedules: { label: 'Schedules', icon: CalendarClock },
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

/**
 * Paseo's Settings › Notifications (desktop-notifications-section.tsx): the permission with its
 * Refresh, Play sound, and Test notification. The browser asks on the Enable click.
 */
function NotificationsSection() {
  // One permission for every row: the Test row turns on as soon as Enable is answered.
  const notifications = useNotificationPermission();
  const controller = useController();
  const { preferences } = useAppState();
  return (
    <Section title="Notifications">
      <NotificationsRow {...notifications} />
      <Row title="Play sound" hint="Notifications play the system's sound. Off, they arrive silently.">
        <Switch checked={preferences.notificationSound} aria-label="Play sound" data-testid="notification-sound"
          onCheckedChange={notificationSound => controller.updatePreferences({ notificationSound })} />
      </Row>
      <TestNotificationRow permission={notifications.permission} sound={preferences.notificationSound} />
    </Section>
  );
}

function NotificationsRow({ permission, request, refresh }: ReturnType<typeof useNotificationPermission>) {
  const hint = permission === 'unsupported' ? 'This browser cannot show notifications.'
    : permission === 'denied' ? 'Blocked. Allow notifications for ALP in the system or browser settings, then Refresh.'
    : permission === 'granted' ? 'On: a notification when a session waits for your answer while you are elsewhere. The tab icon shows it too.'
    : 'Get a notification when a session waits for your answer while you are elsewhere. The browser asks first.';
  return (
    <Row first title="Notifications" hint={hint}>
      <div className="flex items-center gap-2">
        {permission === 'default' ? <Button size="sm" variant="secondary" onClick={() => { void request(); }}>Enable</Button>
          : <span className="text-sm text-muted-foreground" data-testid="notification-permission">{permission === 'granted' ? 'Allowed' : permission === 'denied' ? 'Blocked' : 'Unavailable'}</span>}
        {permission !== 'unsupported' ? <Button size="sm" variant="ghost" onClick={refresh} data-testid="notification-permission-refresh" aria-label="Refresh notification permission">Refresh</Button> : null}
      </div>
    </Row>
  );
}

/**
 * Paseo's "Test notification" (desktop-notifications-section.tsx): sends one now, once notifications
 * are allowed, and says whether it was handed over. It plays the sound as Play sound says.
 */
function TestNotificationRow({ permission, sound }: { permission: ReturnType<typeof useNotificationPermission>['permission']; sound: boolean }) {
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null);
  const granted = permission === 'granted';
  return (
    <Row title="Test notification" hint={granted ? 'Send a notification to check how they appear.' : 'Allow notifications before testing.'}>
      <div className="flex flex-col items-end gap-1">
        <Button size="sm" variant="secondary" disabled={!granted} data-testid="notification-test"
          onClick={() => setResult(sendTestNotification(sound) ? { ok: true, message: 'Test notification sent.' } : { ok: false, message: 'Unable to send a test notification.' })}>Send</Button>
        {result ? <span role="status" className={cn('text-xs', result.ok ? 'text-muted-foreground' : 'text-destructive')} data-testid="notification-test-result">{result.message}</span> : null}
      </div>
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

/** Languages offered first; `alp language` takes any name of at most 40 characters. */
const LANGUAGE_SUGGESTIONS = ['Vietnamese', 'English', 'French', 'German', 'Spanish', 'Japanese', 'Korean', 'Chinese'];
const LANGUAGE_CHARS = 40;

/**
 * The language agents and ALP write to the user in (`alp language`, alpd settings.language.get/set),
 * the only language setting ALP has: the app itself is English. The host owner's own dashboard sets
 * it (settings.language.set, an owner method); any other token reads it. Host › Overview shows it.
 */
function LanguageRow() {
  const controller = useController();
  const owner = useOwner();
  const { settings } = useAppState();
  const language = settings.language;
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { void controller.loadSettings(); }, [controller]);
  React.useEffect(() => { setDraft(language?.applies ?? ''); }, [language?.applies]);
  const set = async (value: string | null) => {
    setBusy(true); setError(null);
    try { await controller.ownerRequest('settings.language.set', { language: value }); await controller.loadSettings(); }
    catch (failure) { setError(describe(failure).message); }
    finally { setBusy(false); }
  };
  const current = settings.status === 'loading' && !language ? 'Loading…' : language ? `${language.applies}${language.language ? '' : ' (default)'}` : 'Not available';
  const valid = draft.trim().length > 0 && draft.trim().length <= LANGUAGE_CHARS;
  return (
    <Row first title="Agents' language" hint={owner
      ? `The language agents and ALP write to you in (alp language): any language name, up to ${LANGUAGE_CHARS} characters. New sessions use it. This app itself is in English.`
      : 'The language agents and ALP write to you in. Only you on the host itself (ALP.app or alp dashboard) can change it; this app itself is in English.'}>
      {owner && language ? (
        <span className="flex flex-col items-end gap-1">
          <span className="flex items-center gap-2">
            <Input aria-label="Agents' language" list="alp-language-suggestions" value={draft} maxLength={LANGUAGE_CHARS} disabled={busy}
              onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && valid) { event.preventDefault(); void set(draft.trim()); } }} className="h-8 w-40" />
            <datalist id="alp-language-suggestions">{LANGUAGE_SUGGESTIONS.map(name => <option key={name} value={name} />)}</datalist>
            <Button size="sm" variant="secondary" disabled={busy || !valid || draft.trim() === language.applies} onClick={() => { void set(draft.trim()); }}>Set</Button>
            {language.language ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void set(null); }} title={`Back to the default, ${language.default}`}>Reset</Button> : null}
          </span>
          <span className="text-xs" data-testid="agents-language">Now: {current}</span>
          {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
        </span>
      ) : <span data-testid="agents-language">{current}</span>}
    </Row>
  );
}

function General({ mobile }: { mobile: boolean }) {
  const controller = useController();
  const { preferences } = useAppState();
  return (
    <>
      <Section title="General">
        <LanguageRow />
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
      {!mobile ? <OpenLocationSection /> : null}
      <Section title="This browser">
        <Row first title="Saved settings" hint="Every App setting and your last New session choices (team, model, thinking, permissions) stay in this browser. The access token never does.">
          <Button size="sm" variant="secondary" onClick={() => controller.resetPreferences()}>Reset</Button>
        </Row>
      </Section>
    </>
  );
}

/** Paseo's Open location rows ALP has: where a file or change opens when clicked. */
const OPEN_LOCATION_ROWS: Array<{ source: keyof Preferences['openInSidePane']; title: string; hint: string }> = [
  { source: 'explorerFiles', title: 'Clicking a file in the Explorer sidebar', hint: 'Open files selected in the Explorer sidebar beside your work' },
  { source: 'diffs', title: 'Clicking a change in the Explorer sidebar', hint: 'Open diffs from Changes beside your work' },
  { source: 'chatFiles', title: 'Clicking a file in an agent chat', hint: 'Open file links and tool-call files beside the conversation' },
];

/**
 * Paseo's Settings › General › Open location (open-location-section.tsx), for the sources ALP has:
 * Main panel opens in the focused pane, On the side in the side pane (made at the right of the
 * center when there is none). Not offered on a narrow screen, which shows one pane.
 */
function OpenLocationSection() {
  const controller = useController();
  const { preferences } = useAppState();
  return (
    <Section title="Open location">
      {OPEN_LOCATION_ROWS.map((row, index) => (
        <Row key={row.source} first={index === 0} title={row.title} hint={row.hint}>
          <Select<'main' | 'side'> label={row.title} value={preferences.openInSidePane[row.source] ? 'side' : 'main'}
            onChange={value => controller.updatePreferences({ openInSidePane: { ...preferences.openInSidePane, [row.source]: value === 'side' } })}
            options={[{ value: 'main', label: 'Main panel' }, { value: 'side', label: 'On the side' }]} />
        </Row>
      ))}
    </Section>
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

/** Paseo's theme tile sketch (ThemePicker ThemePreview): a sidebar, lines of text and an accent bubble in a theme's colours. */
function ThemeSketch({ theme }: { theme: Exclude<ThemePreference, 'system'> }) {
  const colors = THEME_PREVIEWS[theme];
  const line = (width: string, color: string, height = 4) => <span className="block rounded-sm opacity-60" style={{ width, height, backgroundColor: color }} />;
  return (
    <span className="flex aspect-video w-full overflow-hidden" style={{ backgroundColor: colors.background }}>
      <span className="flex w-9 shrink-0 flex-col gap-[5px] px-1.5 py-2" style={{ backgroundColor: colors.sidebar }}>
        {line('100%', colors.muted)}{line('60%', colors.muted)}{line('80%', colors.muted)}
      </span>
      <span className="flex flex-1 flex-col gap-[5px] p-2">
        <span className="block h-[5px] w-[55%] rounded-sm" style={{ backgroundColor: colors.foreground }} />
        {line('90%', colors.muted)}{line('65%', colors.muted)}
        <span className="mt-auto block h-2.5 w-[45%] self-end rounded-[5px]" style={{ backgroundColor: colors.accent }} />
      </span>
    </span>
  );
}

/**
 * Paseo's ThemePicker (Settings › Appearance › Theme): every theme as a tile with a small preview
 * in its own colours, System first (light on the left half, dark on the right); a tile applies
 * its theme at once. Two columns, four from medium screens.
 */
function ThemePicker({ value, onChange }: { value: ThemePreference; onChange: (theme: ThemePreference) => void }) {
  const options = [...THEME_OPTIONS.filter(option => option.value === 'system'), ...THEME_OPTIONS.filter(option => option.value !== 'system')];
  return (
    <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-3 p-4 md:grid-cols-4" data-testid="theme-picker">
      {options.map(option => {
        const selected = option.value === value;
        return (
          <button key={option.value} type="button" role="radio" aria-checked={selected} aria-label={option.label} data-testid={`theme-tile-${option.value}`}
            onClick={() => onChange(option.value)}
            className={cn('flex min-w-0 flex-col gap-1 rounded-lg border-2 p-1 text-left', selected ? 'border-primary' : 'border-transparent hover:bg-secondary', focusRing)}>
            <span className="block overflow-hidden rounded-md border border-border">
              {option.value === 'system' ? (
                <span className="relative block">
                  <ThemeSketch theme="light" />
                  <span className="absolute inset-y-0 left-1/2 w-1/2 overflow-hidden"><span className="block w-[200%] -translate-x-1/2"><ThemeSketch theme="dark" /></span></span>
                </span>
              ) : <ThemeSketch theme={option.value} />}
            </span>
            <span className="truncate px-1 text-xs text-foreground">{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Appearance() {
  const controller = useController();
  const { preferences } = useAppState();
  const preset = contentWidthPreset(preferences);
  return (
    <>
      <Section title="Theme">
        <ThemePicker value={preferences.theme} onChange={theme => controller.setTheme(theme)} />
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
        <Row first title="Content width" hint={preset === null && typeof preferences.contentMaxWidth === 'number' ? `Custom width · ${preferences.contentMaxWidth} px` : 'Width of chat, composer, and Markdown previews'}>
          {/* Paseo's SegmentedControl: Default, Wide, Full; a custom width from before selects none. */}
          <div role="radiogroup" aria-label="Content width" className="flex rounded-lg bg-muted p-0.5" data-testid="content-width-options">
            {([['default', 'Default', null], ['wide', 'Wide', CONTENT_WIDTH_WIDE], ['full', 'Full', 'full']] as const).map(([id, label, value]) => (
              <button key={id} type="button" role="radio" aria-checked={preset === id} data-testid={`content-width-${id}`}
                onClick={() => controller.updatePreferences({ contentMaxWidth: value })}
                className={cn('rounded-md px-3 py-1 text-xs', preset === id ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground', focusRing)}>{label}</button>
            ))}
          </div>
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

/**
 * Paseo's Settings › Sidebar: per section, each row with Move up, Move down and a show switch. The
 * host owner's header slot reads New workspace (what the sidebar shows there for the owner) and
 * lists Schedules; anyone else sees New session and no Schedules row (its place is kept).
 */
function SidebarSettings() {
  const controller = useController();
  const { preferences } = useAppState();
  const owner = useOwner();
  const change = (section: 'header' | 'footer', rows: SidebarItem[]) => controller.updatePreferences({ sidebar: { ...preferences.sidebar, [section]: rows } });
  const listed = (section: 'header' | 'footer') => preferences.sidebar[section].filter(row => owner || row.id !== 'schedules');
  /** Swaps a listed row with its listed neighbour; a row this page does not list keeps its place. */
  const move = (section: 'header' | 'footer', index: number, by: -1 | 1) => {
    const shown = listed(section);
    const rows = [...preferences.sidebar[section]];
    const from = rows.findIndex(row => row.id === shown[index].id);
    const to = rows.findIndex(row => row.id === shown[index + by].id);
    [rows[from], rows[to]] = [rows[to], rows[from]];
    change(section, rows);
  };
  const card = (section: 'header' | 'footer', title: string, info: string) => (
    <Section title={title}>
      <p className="px-4 pt-3 text-xs text-muted-foreground">{info}</p>
      {listed(section).map((row, index, rows) => {
        const item = row.id === 'new-session' && owner ? { ...SIDEBAR_ITEM_LABELS[row.id], label: 'New workspace' } : SIDEBAR_ITEM_LABELS[row.id];
        return (
          <div key={row.id} className={cn('flex items-center gap-2 p-4', index > 0 && 'border-t border-border')} data-testid={`sidebar-nav-item-${row.id}`}>
            <item.icon aria-hidden strokeWidth={1.75} className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">{item.label}</span>
            <Button size="icon" variant="ghost" className="size-7" aria-label={`Move ${item.label} up`} disabled={index === 0} onClick={() => move(section, index, -1)}><ArrowUp aria-hidden /></Button>
            <Button size="icon" variant="ghost" className="size-7" aria-label={`Move ${item.label} down`} disabled={index === rows.length - 1} onClick={() => move(section, index, 1)}><ArrowDown aria-hidden /></Button>
            <Switch checked={row.visible} aria-label={item.label} onCheckedChange={visible => change(section, preferences.sidebar[section].map(other => other.id === row.id ? { ...other, visible } : other))} />
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
      {/* No "Always expand reasoning": ALP's runtime never emits the agents' reasoning (Codex
          reasoning items are dropped in nativeItem), so there is nothing to expand (t-a95b group C). */}
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

/**
 * Settings › Files: what the Files panel may do on this connection. Paseo's page chose among
 * plugin file panels; ALP has no plugins, so it says who reads and who edits instead.
 */
function Files() {
  const controller = useController();
  const owner = useOwner();
  const { principal } = useAppState();
  const reads = owner ? 'Yes, as the owner of this host' : !controller.filesReadable ? 'No: this host does not offer file reading' : can(principal ?? undefined, 'files.read') ? 'Yes (files.read)' : 'No: this access token lacks files.read';
  return (
    <Section title="Files panel">
      <Row first title="Read files" hint="The Files panel of a workspace lists its folders and opens text files up to 1 MB. Secrets, keys, .git and ALP configuration never show.">
        <span className="text-xs" data-testid="files-read-access">{reads}</span>
      </Row>
      <Row title="Edit files" hint={owner ? 'Open a file, then Edit. See Settings › Editor.' : 'Only the owner of the host edits files, from ALP on the host itself.'}>
        <span className="text-xs" data-testid="files-edit-access">{owner ? 'Yes' : 'No'}</span>
      </Row>
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
/** ALP's repository: Paseo's community links (components/community-links.tsx) keep only the one ALP has, Star. */
const REPOSITORY_URL = 'https://github.com/phucanh08/alp';

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
      <div className="flex flex-wrap items-center justify-center" data-testid="community-links">
        <a href={REPOSITORY_URL} target="_blank" rel="noopener noreferrer" data-testid="community-links-github-star"
          className={cn('flex h-8 items-center gap-1.5 rounded-md px-3 text-sm text-foreground hover:bg-secondary', focusRing)}>
          <Github aria-hidden className="size-3.5" />Star
        </a>
      </div>
    </>
  );
}

function Overview() {
  const controller = useController();
  const { principal, connection, settings } = useAppState();
  const owner = useOwner();
  const [refreshing, setRefreshing] = React.useState(false);
  const [refreshError, setRefreshError] = React.useState<string | null>(null);
  React.useEffect(() => { void controller.loadSettings(); }, [controller]);
  const permissions = ['session.read', 'session.write', 'project.read', 'project.write', 'workspace.write', 'workspace.manage', 'files.read', 'library.write', 'terminal.exec'];
  return (
    <>
      <Section title="Host">
        <Row first title="Machine" hint="The host's name, as it reports it.">{connection.hostname ?? 'unknown'}</Row>
        <Row title="ALP">{connection.daemonVersion ?? 'unknown'}</Row>
        <Row title="Gateway"><span className="break-all font-mono text-xs">{connection.gateway}</span></Row>
        <Row title="Agents' language" hint="Changed in App › General (only by you on the host itself), or with alp language.">
          {settings.status === 'loading' ? <Spinner label="Loading…" className="text-xs" /> : settings.language ? `${settings.language.applies}${settings.language.language ? '' : ' (default)'}` : 'Not available'}
        </Row>
        {settings.status === 'error' ? <p role="alert" className="border-t border-border px-4 py-3 text-xs text-destructive">{settings.error?.message}</p> : null}
      </Section>
      <Section title={`Models new sessions can pick${settings.models.length ? ` (${settings.models.length})` : ''}`}
        action={owner || controller.hasCapability('catalog.live') ? <Button size="sm" variant="ghost" className="h-7 text-xs" data-testid="settings-models-refresh" disabled={refreshing} onClick={() => { setRefreshing(true); setRefreshError(null); void controller.refreshModels().catch(error => setRefreshError(describe(error).message)).finally(() => setRefreshing(false)); }}>{refreshing ? 'Refreshing…' : 'Refresh'}</Button> : undefined}>
        {refreshError ? <p role="alert" className="border-b border-border px-4 py-3 text-xs text-destructive" data-testid="settings-models-refresh-error">{refreshError}</p> : null}
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
    case 'notifications': return <NotificationsSection />;
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
      {/* ALP.app on macOS: room for the traffic lights, this row starts the window's top row (styles.css). */}
      <span aria-hidden className="window-controls-inset" />
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
