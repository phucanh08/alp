import type { PluginTheme } from '@getpaseo/plugin';
import { type PluginSurfaceProps, useRpc } from '@getpaseo/plugin/client';
import { Icon, ScrollView } from '@getpaseo/plugin/client/react-native';
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { usageGet, type UsageData } from '../shared/usage';
import { Button, Pill } from './side-nav';

type Provider = UsageData['providers'][number];

export function UsageScreen({ theme, layout }: PluginSurfaceProps) {
  const read = useRpc(usageGet);
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const forceRefresh = useRef(false);
  useEffect(() => {
    let live = true;
    setLoading(true);
    const refresh = forceRefresh.current;
    forceRefresh.current = false;
    read({ refresh }).then(result => { if (live) { setData(result); setError(null); } })
      .catch(cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [read, tick]);
  useEffect(() => {
    const timer = setInterval(() => setTick(value => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  return <UsageView theme={theme} compact={layout.compact} data={data} loading={loading} error={error} onRefresh={() => { forceRefresh.current = true; setTick(value => value + 1); }} />;
}

function dateLabel(value: string) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Unknown';
}
function resetLabel(value: string | null, now: number) {
  if (!value) return 'Reset time unavailable';
  const minutes = Math.ceil((Date.parse(value) - now) / 60_000);
  if (minutes <= 0) return 'Reset time passed · awaiting provider update';
  const duration = minutes >= 1440 ? `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h` : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
  return `Resets in ${duration} · ${dateLabel(value)}`;
}

/** Pure view so provider data, empty states and narrow layouts can be verified independently. */
export function UsageView({ theme, compact, data, loading, error, onRefresh, now = Date.now() }: {
  theme: PluginTheme; compact: boolean; data: UsageData | null; loading: boolean; error: string | null; onRefresh(): void; now?: number;
}) {
  const { colors } = theme;
  const muted = { color: colors.foregroundMuted, fontSize: 13, lineHeight: 20 };
  const providers = data?.providers ?? [];
  const parked = providers.reduce((sum, provider) => sum + provider.parked, 0);
  return (
    <ScrollView contentContainerStyle={{ padding: compact ? 16 : 28, gap: 24 }}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 28, fontWeight: '600', letterSpacing: -0.7 }}>Usage</Text>
          <Button theme={theme} label={loading ? 'Refreshing…' : 'Refresh'} icon="RefreshCw" disabled={loading} onPress={onRefresh} accessibilityLabel="Refresh usage" />
        </View>
        <Text style={muted}>Your provider limits, reset windows and paused work in one place.</Text>
      </View>
      {error ? <View accessibilityRole="alert" style={{ padding: 14, borderWidth: 1, borderColor: colors.statusDanger, borderRadius: 10, gap: 4 }}>
        <Text style={{ color: colors.statusDanger, fontWeight: '600' }}>Could not refresh usage</Text>
        <Text style={muted}>{error}</Text>
        {data ? <Text style={muted}>Showing the last received data.</Text> : null}
      </View> : null}
      {parked > 0 ? <View style={{ padding: 14, backgroundColor: colors.surface1, borderLeftWidth: 3, borderLeftColor: colors.statusWarning, gap: 4 }}>
        <Text style={{ color: colors.foreground, fontWeight: '600' }}>{parked} {parked === 1 ? 'assignment waiting' : 'assignments waiting'}</Text>
        <Text style={muted}>Parked work stays saved while its runtime is paused.</Text>
      </View> : null}
      {!data && loading ? <Text accessibilityLiveRegion="polite" style={muted}>Checking Codex and Claude usage…</Text> : null}
      <View style={{ flexDirection: compact ? 'column' : 'row', flexWrap: 'wrap', gap: 16 }}>
        {providers.map(provider => <ProviderCard key={provider.runtime} theme={theme} provider={provider} compact={compact} now={now} />)}
      </View>
      <View style={{ borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 16, gap: 4 }}>
        <Text style={muted}>Account limits reported by each provider, shared with usage outside ALP.</Text>
        <Text style={{ ...muted, fontSize: 12 }}>Updates every minute while this screen is open. Readings are cached for up to 30 seconds. This is not a billing or token-spend report.</Text>
      </View>
    </ScrollView>
  );
}

function ProviderCard({ theme, provider, compact, now }: { theme: PluginTheme; provider: Provider; compact: boolean; now: number }) {
  const { colors } = theme;
  const status = provider.pause ? 'Paused' : !provider.available ? 'Unavailable' : provider.limited ? 'Limit reached' : 'Available';
  const tone = provider.pause || provider.limited ? 'warning' : provider.available ? 'success' : 'muted';
  const muted = { color: colors.foregroundMuted, fontSize: 12, lineHeight: 18 };
  return <View style={{ flexGrow: 1, flexBasis: compact ? 'auto' : 320, width: compact ? '100%' : undefined, minWidth: 0, padding: 20, backgroundColor: colors.surface1, borderWidth: 1, borderColor: colors.border, borderRadius: 14, gap: 20 }}>
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
      <View style={{ gap: 4 }}>
        <Text accessibilityRole="header" style={{ color: colors.foreground, fontSize: 20, fontWeight: '600' }}>{provider.runtime === 'codex' ? 'Codex' : 'Claude'}</Text>
        <Text style={muted}>{provider.plan ? `${provider.plan} plan` : 'Plan not reported'}</Text>
      </View>
      <Pill theme={theme} label={status} tone={tone} />
    </View>
    {provider.pause ? <View style={{ gap: 5 }}>
      <Text style={{ color: colors.statusWarning, fontSize: 13 }}>{provider.pause.reason}</Text>
      {provider.pause.resetsAt ? <Text style={muted}>{resetLabel(provider.pause.resetsAt, now)}</Text> : null}
      <Text style={muted}>{provider.parked} {provider.parked === 1 ? 'assignment parked' : 'assignments parked'}</Text>
    </View> : null}
    {!provider.available ? <View style={{ gap: 8, paddingVertical: 16 }}>
      <Icon name="CircleHelp" size={22} color={colors.foregroundMuted} />
      <Text style={{ color: colors.foreground, fontSize: 14, fontWeight: '500' }}>Usage is not available</Text>
      <Text style={muted}>The provider did not return usage data. Check that its CLI is installed and signed in, then refresh.</Text>
    </View> : provider.windows.length === 0 ? <Text style={muted}>The provider has not reported any usage windows.</Text> : provider.windows.map((window, index) => {
      const used = window.usedPercent;
      const color = used === null ? colors.foregroundMuted : used >= 95 ? colors.statusDanger : used >= 80 ? colors.statusWarning : colors.accent;
      return <View key={`${window.name}-${index}`} style={{ gap: 8 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
          <Text style={{ color: colors.foreground, fontSize: 13, flex: 1, textTransform: 'capitalize' }}>{window.name}</Text>
          <Text style={{ color, fontSize: 25, fontWeight: '600', fontVariant: ['tabular-nums'] }}>{used === null ? '—' : `${Math.round(used)}%`}</Text>
        </View>
        <View accessibilityRole="progressbar" accessibilityLabel={`${window.name} used`} accessibilityValue={used === null ? { text: 'Usage unknown' } : { min: 0, max: 100, now: used }} style={{ height: 6, backgroundColor: colors.surface2, borderRadius: 3, overflow: 'hidden' }}>
          <View style={{ height: 6, width: `${used ?? 0}%`, backgroundColor: color, borderRadius: 3 }} />
        </View>
        <Text style={muted}>{used === null ? 'Usage percentage unavailable' : `${Math.round(100 - used)}% remaining`}</Text>
        <Text style={muted}>{resetLabel(window.resetsAt, now)}</Text>
      </View>;
    })}
    <Text style={{ ...muted, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: 12 }}>Checked {dateLabel(provider.checkedAt)}</Text>
  </View>;
}
