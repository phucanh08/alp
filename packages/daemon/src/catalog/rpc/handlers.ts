/**
 * catalog.get and catalog.refresh (t-e5ee): the model catalog as alpd answers it, the static rows
 * plus the live catalog's providers and ACP rows when there is one. alpd spreads them into its
 * handler table (server.ts).
 */
import { ERROR } from '@anhlp/alp-protocol';
import { DEFAULT_MODEL, models, modes, type ModelCatalog, thinkingOptions } from '@anhlp/alp-runtime/index';
import { RpcError } from '../../rpc/rpc-error.ts';

type CatalogHandler = () => unknown;

/** The handlers over this daemon's live model catalog; without one, catalog.get answers the static rows. */
export function createCatalogHandlers({ modelCatalog }: { modelCatalog: ModelCatalog | undefined }): Record<'catalog.get' | 'catalog.refresh', CatalogHandler> {
  const catalogResult = () => {
    const state = modelCatalog?.state();
    // ACP providers' rows (t-d0b0), from their files and what sessions or an explicit probe taught.
    const acpRows = modelCatalog?.acpRows() ?? [];
    const acpModels = acpRows.map(row => ({ id: `acp:${row.id}`, label: row.label, description: row.description, thinkingOptions: [], runtime: 'acp', provider: row.provider, source: row.source, enabled: row.enabled, status: row.status }));
    const acpProviders = Object.fromEntries([...new Set(acpRows.map(row => row.provider))].map(id => {
      const acp = state?.acp?.[id];
      return [`acp:${id}`, { status: acp?.status ?? 'unprobed', ...(acp?.fetchedAt ? { fetchedAt: acp.fetchedAt } : {}), ...(acp?.error ? { error: acp.error } : {}) }];
    }));
    return { models: [...models, ...acpModels], modes, thinkingOptions, defaultModel: `codex:${DEFAULT_MODEL}`,
      ...(state ? { fetchedAt: state.fetchedAt, providers: { ...Object.fromEntries(Object.entries(state.providers).map(([runtime, provider]) => [runtime, { status: provider!.status, fetchedAt: provider!.fetchedAt, ...(provider!.error ? { error: provider!.error } : {}) }])), ...acpProviders, ...(modelCatalog?.acpLoadError() ? { acp: { status: 'failed', error: modelCatalog.acpLoadError() } } : {}) } } : {}) };
  };
  return {
    'catalog.get': () => catalogResult(),
    'catalog.refresh': async () => {
      if (!modelCatalog) throw new RpcError(ERROR.unavailable, 'The live model catalog is not available');
      // The one place, with a provider's enabling, where ALP starts ACP providers to list their models.
      // An ACP failure must not hide the providers' refresh: each records its own error.
      await Promise.all([modelCatalog.refresh(), modelCatalog.refreshAcp().catch(() => {})]);
      return catalogResult();
    },
  };
}
