import * as React from 'react';
import { LoaderCircle, Pin, RotateCw, Settings as Gear } from 'lucide-react';
import { Button } from '../../../components/ui/button';
import { Switch } from '../../../components/ui/switch';
import { describe } from '../../../lib/errors.js';
import { readUsage, readUsageSetting, runtimeName, setUsageSetting, usageStatus, type UsageProvider } from '../../../lib/owner-host.js';
import {
  balanceText, displayPercent, formatDisplayPct, formatResetLabel, formatResetTime, isCardOn, isPinned, setCardOn, togglePin, windowTone, windowsOf,
  type DisplayAs, type ResolvedWindow, type UsagePrefs,
} from '../../../lib/usage-prefs.js';
import { cn } from '../../../lib/utils';
import { useAppState, useController } from '../../store';
import { ProviderIcon } from '../../ProviderIcon';
import { focusRing } from '../parts';
import { changeUsagePrefs, useUsagePrefs } from './prefs';

/*
 * Settings › Usage for the host owner, as Paseo's Usage page (packages/app/src/usage: usage-section,
 * controls, options, card, window-bar, meter, balance-bar): "Plan usage" with Refresh all and the
 * settings cog (Check usage, the host's; Summary in sidebar and Percentages, this browser's), then
 * one card per provider: its plan, a refresh and an on/off switch, each window's share, bar and
 * reset time (the whole row pins the window to the sidebar summary), its details, balances and
 * account. Check usage off shows Paseo's off view with Turn on.
 */

type Setting = { supported: boolean | null; enabled: boolean; host: string; pending: boolean; error: string | null };
type Data = { providers: UsageProvider[]; disabled: boolean };

/** An owner request's error: the host's own words when it answered one, else describe()'s. */
function errorText(cause: unknown) {
  const answered = cause && typeof cause === 'object' && typeof (cause as { code?: unknown }).code === 'number' ? (cause as { message?: unknown }).message : undefined;
  return typeof answered === 'string' && answered ? answered : describe(cause).message;
}

/** A clock that ticks each minute, so countdowns move while the page is open. */
function useNow() {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  return now;
}

export function OwnerUsage() {
  const controller = useController();
  const { connection, owner } = useAppState();
  const online = connection.phase === 'open' && owner;
  const fallbackHost = connection.hostname ?? 'this host';
  const prefs = useUsagePrefs();
  const now = useNow();
  const [data, setData] = React.useState<Data | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // What is being refreshed: every card ('all'), one card (its runtime; daemon.usage refreshes every
  // provider, so only the spinner is that card's), or nothing.
  const [refreshing, setRefreshing] = React.useState<string | null>(null);
  const [setting, setSetting] = React.useState<Setting>({ supported: null, enabled: true, host: '', pending: false, error: null });

  const load = React.useCallback(async (refresh: boolean, which = 'all') => {
    setRefreshing(which); setError(null);
    try { setData(await readUsage(controller, refresh)); } catch (cause) { setError(errorText(cause)); } finally { setRefreshing(null); }
  }, [controller]);
  // Read again whenever the owner's connection opens (a grant change or a restart reconnects it).
  React.useEffect(() => {
    if (!online) return;
    void load(false);
    let live = true;
    // A host without the setting (older alpd) has no Check usage switch, as Paseo's unsupported host.
    readUsageSetting(controller).then(
      value => { if (live) setSetting(current => ({ ...current, supported: true, ...value })); },
      () => { if (live) setSetting(current => ({ ...current, supported: false })); },
    );
    return () => { live = false; };
  }, [online, load, controller]);

  const setEnabled = React.useCallback(async (enabled: boolean) => {
    setSetting(current => ({ ...current, pending: true, error: null }));
    try {
      const value = await setUsageSetting(controller, enabled);
      setSetting(current => ({ ...current, ...value, supported: true, pending: false }));
      if (value.enabled) await load(false); else setData({ providers: [], disabled: true });
    } catch (cause) {
      setSetting(current => ({ ...current, pending: false, error: errorText(cause) }));
    }
  }, [controller, load]);

  const host = setting.host || fallbackHost;
  const off = data?.disabled === true || (setting.supported === true && !setting.enabled);
  const providers = data?.providers ?? [];
  return (
    <section className="mb-6" data-testid="usage-section">
      <div className="mb-3 ml-1 flex items-center justify-between gap-2">
        <h3 className="text-sm font-normal text-muted-foreground">Plan usage</h3>
        <div className="flex items-center gap-1">
          {off ? null : (
            <IconButton label="Refresh all" testId="usage-refresh-all" disabled={refreshing !== null} onClick={() => void load(true)}>
              {refreshing === 'all' || (!data && refreshing) ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCw aria-hidden />}
            </IconButton>
          )}
          <UsageOptions setting={setting} host={host} prefs={prefs} onSetEnabled={enabled => void setEnabled(enabled)} />
        </div>
      </div>
      {off ? (
        <div className="flex flex-col gap-3" data-testid="usage-off">
          <Message text={`Usage is off on ${host}.`} />
          {setting.error ? <p role="alert" className="ml-1 text-xs text-destructive">{setting.error}</p> : null}
          <div><Button size="sm" disabled={setting.pending} onClick={() => void setEnabled(true)} data-testid="usage-turn-on">Turn on</Button></div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {error ? <p role="alert" className="rounded-lg border border-destructive/40 px-4 py-3 text-xs text-destructive">Unable to refresh usage: {error}{data ? ' Showing the last received data.' : ''}</p> : null}
          {!data && !error ? <Message text="Loading usage..." /> : null}
          {data && !providers.length ? <Message text="No usage data" /> : null}
          {providers.map(provider => (
            <UsageCard key={provider.runtime} provider={provider} prefs={prefs} providers={providers} now={now}
              refreshing={refreshing === provider.runtime} busy={refreshing !== null} onRefresh={() => void load(true, provider.runtime)} />
          ))}
        </div>
      )}
    </section>
  );
}

function Message({ text }: { text: string }) {
  return <div className="rounded-lg border border-border bg-card p-4 text-center text-sm text-muted-foreground">{text}</div>;
}

function IconButton({ label, testId, onClick, disabled, active, children, ...rest }: React.ComponentProps<'button'> & { label: string; testId?: string; active?: boolean }) {
  return (
    <button type="button" aria-label={label} title={label} data-testid={testId} onClick={onClick} disabled={disabled} {...rest}
      className={cn('inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-60 [&_svg]:size-4',
        active && 'bg-accent text-foreground', focusRing)}>
      {children}
    </button>
  );
}

// ---- The settings cog --------------------------------------------------------------------------

/**
 * Paseo's usage options: a popover under the cog with Check usage (the host's setting: owner only,
 * for every device), Summary in sidebar and Percentages (this browser's).
 */
function UsageOptions({ setting, host, prefs, onSetEnabled }: { setting: Setting; host: string; prefs: UsagePrefs; onSetEnabled: (enabled: boolean) => void }) {
  const [open, setOpen] = React.useState(false);
  const button = React.useRef<HTMLButtonElement>(null);
  const panel = React.useRef<HTMLDivElement>(null);
  const id = React.useId();
  React.useEffect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !button.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Escape closes the popover, not Settings behind it.
      event.preventDefault(); event.stopPropagation();
      setOpen(false); button.current?.focus();
    };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', key, true); };
  }, [open]);
  React.useEffect(() => { if (open) panel.current?.querySelector<HTMLElement>('button:not([disabled])')?.focus(); }, [open]);
  return (
    <div className="relative">
      <IconButton ref={button} label="Settings" testId="usage-options-menu" active={open} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen(value => !value)}>
        <Gear aria-hidden />
      </IconButton>
      {open ? (
        <div ref={panel} id={id} role="dialog" aria-label="Usage settings" data-testid="usage-options-surface"
          className="absolute right-0 top-full z-50 mt-1 w-[340px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-border bg-popover shadow-xl shadow-[var(--shadow)]">
          {setting.error ? <p role="alert" className="px-4 pt-3 text-xs text-destructive">{setting.error}</p> : null}
          {setting.supported !== false ? (
            <OptionRow label="Check usage" hint={`Applies to ${host} on every device`}>
              <Switch checked={setting.enabled} disabled={setting.supported !== true || setting.pending} onCheckedChange={onSetEnabled} aria-label="Check usage" data-testid="usage-check-usage" />
            </OptionRow>
          ) : null}
          <OptionRow label="Summary in sidebar" hint="Pinned windows show in the sidebar footer" border={setting.supported !== false}>
            <Switch checked={prefs.inSidebar} onCheckedChange={inSidebar => changeUsagePrefs(current => ({ ...current, inSidebar }))} aria-label="Summary in sidebar" data-testid="usage-show-in-sidebar" />
          </OptionRow>
          <OptionRow label="Percentages" border>
            <Segmented value={prefs.displayAs} onChange={displayAs => changeUsagePrefs(current => ({ ...current, displayAs }))} />
          </OptionRow>
        </div>
      ) : null}
    </div>
  );
}

function OptionRow({ label, hint, border, children }: { label: string; hint?: string; border?: boolean; children: React.ReactNode }) {
  return (
    <div className={cn('flex items-center justify-between gap-4 px-4 py-4', border && 'border-t border-border')}>
      <div className="min-w-0">
        <div className="text-sm text-foreground">{label}</div>
        {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

const DISPLAY_OPTIONS: Array<{ value: DisplayAs; label: string }> = [{ value: 'used', label: 'Used' }, { value: 'remaining', label: 'Remaining' }];

/** Paseo's segmented control: the choice on a filled pill, the other plain. */
function Segmented({ value, onChange }: { value: DisplayAs; onChange: (value: DisplayAs) => void }) {
  return (
    <div role="radiogroup" aria-label="Percentages" className="flex shrink-0 items-center gap-0.5" data-testid="usage-display-as">
      {DISPLAY_OPTIONS.map(option => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} onClick={() => onChange(option.value)} data-testid={`usage-display-${option.value}`}
          className={cn('rounded-full px-3 py-1 text-sm transition-colors', value === option.value ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground', focusRing)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

// ---- A provider's card --------------------------------------------------------------------------

const DOT = { success: 'bg-status-success', warning: 'bg-status-warning', muted: 'bg-muted-foreground' } as const;

function UsageCard({ provider, providers, prefs, now, refreshing, busy, onRefresh }: {
  provider: UsageProvider; providers: UsageProvider[]; prefs: UsagePrefs; now: number; refreshing: boolean; busy: boolean; onRefresh: () => void;
}) {
  const name = runtimeName(provider.runtime);
  const on = isCardOn(prefs, provider.runtime);
  const plan = provider.planLabel ?? provider.plan;
  const status = usageStatus(provider);
  const windows = windowsOf(provider);
  const details = Array.isArray(provider.details) ? provider.details : [];
  const balances = Array.isArray(provider.balances) ? provider.balances : [];
  const email = provider.account?.email;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4" data-testid="usage-provider" data-runtime={provider.runtime} data-on={on}>
      <div className="flex min-h-7 items-center gap-2">
        <ProviderIcon runtime={provider.runtime} className="size-4 text-foreground" />
        <span className="truncate text-sm text-foreground">{name}</span>
        {plan && on ? <span className="shrink-0 rounded-full bg-accent px-2 py-0.5 text-xs text-muted-foreground" data-testid="usage-plan">{plan}</span> : null}
        <span className="flex-1" />
        {on && status.label !== 'Available' ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="usage-status">
            <span aria-hidden className={cn('size-2 rounded-full', DOT[status.tone])} />{status.label}
          </span>
        ) : null}
        {on ? (
          <IconButton label={`Refresh ${name}`} testId="usage-refresh" disabled={busy} onClick={onRefresh} title={`Checked ${new Date(provider.checkedAt).toLocaleString()}`}>
            {refreshing ? <LoaderCircle aria-hidden className="animate-spin" /> : <RotateCw aria-hidden />}
          </IconButton>
        ) : null}
        <Switch checked={on} onCheckedChange={value => changeUsagePrefs(current => setCardOn(current, provider.runtime, value))} aria-label={`Show ${name}`} data-testid={`usage-card-switch-${provider.runtime}`} />
      </div>
      {on ? (
        <>
          {provider.pause ? (
            <p className="text-sm text-muted-foreground" data-testid="usage-pause">
              {[provider.pause.reason, formatResetLabel(provider.pause.resetsAt, now), `${provider.parked} parked`].filter(Boolean).join(' · ')}
            </p>
          ) : null}
          {!provider.available ? <p className="text-sm text-muted-foreground">The provider did not return usage data. Check that its CLI is installed and signed in on the host, then refresh.</p> : null}
          {windows.length || balances.length ? (
            <div className="flex flex-col gap-1">
              {windows.map(window => (
                <WindowRow key={window.id} runtime={provider.runtime} name={name} window={window} now={now} displayAs={prefs.displayAs}
                  pinnable={prefs.inSidebar} pinned={isPinned(prefs, { runtime: provider.runtime, windowId: window.id }, providers)}
                  onTogglePin={() => changeUsagePrefs(current => togglePin(current, { runtime: provider.runtime, windowId: window.id }, providers))} />
              ))}
              {balances.map(balance => (
                <div key={balance.id} className="flex items-center justify-between gap-2 py-1.5 text-sm" data-testid="usage-balance" data-balance-id={balance.id}>
                  <span className="truncate font-medium text-foreground">{balance.label}</span>
                  <span className="shrink-0 text-foreground">{balanceText(balance)}</span>
                </div>
              ))}
            </div>
          ) : provider.available ? <p className="text-sm text-muted-foreground">The provider has not reported any usage windows.</p> : null}
          {details.length ? (
            <div className="flex flex-col gap-1">
              {details.map(detail => (
                <div key={detail.id} className="flex justify-between gap-2 text-sm" data-testid="usage-detail" data-detail-id={detail.id}>
                  <span className="truncate text-muted-foreground">{detail.label}</span>
                  <span className="shrink-0 text-foreground">{detail.value}</span>
                </div>
              ))}
            </div>
          ) : null}
          {email ? <div className="truncate text-sm text-muted-foreground" data-testid="usage-account">{email}</div> : null}
        </>
      ) : null}
    </div>
  );
}

const FILL = { default: 'bg-status-success', warning: 'bg-status-warning', danger: 'bg-status-danger' } as const;

/**
 * A window's row: its label, share and pin glyph, the bar, and "resets in 3h 46m · 12:09 PM". While
 * the sidebar summary is on, the whole row pins the window to it (Paseo's checkbox row).
 */
function WindowRow({ runtime, name, window, now, displayAs, pinnable, pinned, onTogglePin }: {
  runtime: string; name: string; window: ResolvedWindow; now: number; displayAs: DisplayAs; pinnable: boolean; pinned: boolean; onTogglePin: () => void;
}) {
  const shown = displayPercent(window, displayAs);
  const value = shown === null ? '—' : formatDisplayPct(shown, displayAs);
  const datapoints = [formatResetLabel(window.resetsAt, now), formatResetTime(window.resetsAt, now)].filter((item): item is string => !!item);
  const content = (
    <>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{window.label}</span>
        <span className="shrink-0 text-sm tabular-nums text-foreground" data-testid="usage-window-value">{value}</span>
        {pinnable ? <Pin aria-hidden data-testid={pinned ? 'usage-pin-glyph-pinned' : 'usage-pin-glyph-unpinned'}
          className={cn('size-3 shrink-0', pinned ? 'fill-current text-foreground' : 'text-muted-foreground')} /> : null}
      </div>
      <div role="progressbar" aria-label={`${name} ${window.label} ${displayAs === 'used' ? 'used' : 'left'}`} aria-valuemin={0} aria-valuemax={100}
        {...(shown === null ? { 'aria-valuetext': 'Usage unknown' } : { 'aria-valuenow': Math.round(shown) })}
        className="h-1.5 overflow-hidden rounded-[3px] bg-bubble">
        <div className={cn('h-full rounded-full', FILL[windowTone(window.usedPercent)])} style={{ width: `${shown ?? 0}%` }} data-testid="usage-window-fill" />
      </div>
      {datapoints.length ? <div className="text-sm text-muted-foreground">{datapoints.join(' · ')}</div> : null}
    </>
  );
  const common = { 'data-testid': 'usage-window', 'data-window-id': window.id, className: 'flex w-full flex-col gap-[3px] py-1.5 text-left' };
  if (!pinnable) return <div {...common}>{content}</div>;
  return (
    <button type="button" role="checkbox" aria-checked={pinned} onClick={onTogglePin} title={pinned ? 'Unpin' : 'Pin'}
      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${name} ${window.label} ${value}${datapoints.length ? `, ${datapoints.join(' · ')}` : ''}`}
      {...common} data-pin={`${runtime}:${window.id}`} className={cn(common.className, 'cursor-pointer rounded-md', focusRing)}>
      {content}
    </button>
  );
}
