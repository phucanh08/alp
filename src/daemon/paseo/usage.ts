import type { SessionOutboundMessage } from '@getpaseo/protocol/messages';
import type { AlpRuntime } from '../../runtime/runtime.js';
import type { Handler } from './gateway.js';

type Snapshot = Awaited<ReturnType<AlpRuntime['usage']>>;
const id = (runtime: string) => `alp-${runtime}`;

/** Both generations of Paseo's Usage drawer read the same ALP snapshot as its panel. */
export function createUsage(read: (refresh?: boolean) => Promise<Snapshot>) {
  const providers = async (refresh = false) => (await read(refresh)).providers.map(provider => ({
    providerId: id(provider.runtime), displayName: provider.runtime === 'codex' ? 'Codex' : 'Claude',
    status: provider.available ? 'available' as const : 'unavailable' as const,
    planLabel: provider.plan, sourceLabel: 'ALP', fetchedAt: provider.checkedAt,
    windows: provider.available ? provider.windows.map((window, index) => ({
      id: `${id(provider.runtime)}-${index}`, label: window.name,
      usedPct: window.usedPercent, remainingPct: window.usedPercent === null ? null : 100 - window.usedPercent,
      resetsAt: window.resetsAt, summary: index === 0,
      tone: window.usedPercent !== null && window.usedPercent >= 95 ? 'danger' as const : window.usedPercent !== null && window.usedPercent >= 80 ? 'warning' as const : 'default' as const,
    })) : [],
    details: [
      ...(provider.pause ? [{ id: 'pause', label: 'Paused', value: provider.pause.reason, tone: 'warning' as const }] : []),
      ...(provider.limited ? [{ id: 'limit', label: 'Status', value: 'Limit reached', tone: 'warning' as const }] : []),
      ...(provider.parked ? [{ id: 'parked', label: 'Parked assignments', value: String(provider.parked), tone: 'warning' as const }] : []),
    ],
    error: provider.available ? null : 'The provider did not return usage data. Check that its CLI is installed and signed in, then refresh.',
  }));
  const handlers: Record<string, Handler> = {
    async 'provider.usage.list.request'(message) {
      return { type: 'provider.usage.list.response', payload: { requestId: message.requestId, fetchedAt: new Date().toISOString(), providers: await providers() } } satisfies SessionOutboundMessage;
    },
    async 'usage.list_reports.request'(message, client) {
      for (const provider of await providers(message.forceRefresh === true)) {
        if (Array.isArray(message.reportIds) && !message.reportIds.includes(provider.providerId)) continue;
        client.emit({ type: 'usage.list_reports.update', payload: { requestId: message.requestId, report: {
          id: provider.providerId, account: {}, sourceId: provider.providerId, sourceLabel: provider.displayName, fetchedAt: provider.fetchedAt,
          report: provider.status === 'available' ? { status: 'available', ...(provider.planLabel ? { planLabel: provider.planLabel } : {}), windows: provider.windows, details: provider.details }
            : { status: 'unavailable', problem: { kind: 'no_quota', detail: provider.error! } },
        } } } satisfies SessionOutboundMessage);
      }
      return { type: 'usage.list_reports.response', payload: { requestId: message.requestId, error: null } } satisfies SessionOutboundMessage;
    },
  };
  return { handlers, features: { providerUsageList: true, usageSources: true } };
}
