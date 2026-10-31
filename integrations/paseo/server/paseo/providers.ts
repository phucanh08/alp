import type { SessionInboundMessage, SessionOutboundMessage } from '@getpaseo/protocol/messages';
import templates from 'alp:templates';
import { ensureLibrary } from '@anhlp/alp-core/library';
import { deleteEntry, getEntry, saveEntry } from '@anhlp/alp-core/library-edit';
import { listProviders, loadProvider, RESERVED_PROVIDERS } from '@anhlp/alp-core/providers';
import { catalogModels } from '@anhlp/alp-core/models';
import { runCommand } from '@anhlp/alp-client/command';
import { probeAcp } from '@anhlp/alp-client/acp-probe';
import { probeAntigravity } from '@anhlp/alp-client/antigravity-probe';
import type { Handler, Outbound } from './gateway.js';

/**
 * Provider snapshots contain an internal team entry for agent launchers, native runtimes, and ACP agents. Settings hides the internal entry; launchers show only it. ALP is carried first,
 * its teams as models; then each provider of the user's library (`providers/<id>.json`), with
 * the models and modes its agent offers, found by starting it once (initialize, session/new) and
 * kept until a refresh or a change. Paseo's app adds one from its catalog, turns it on or off,
 * adds models, removes it and asks for a diagnostic through the daemon's config; ALP writes the
 * library file. Providers are for teams' models (`acp:<id>/<model>`); the app's agent pickers do
 * not offer them (patch 11).
 */

type Inbound<T extends SessionInboundMessage['type']> = Extract<SessionInboundMessage, { type: T }>;
type Model = { id: string; label?: string; description?: string };
type Found = { status: 'loading' | 'ready' | 'error' | 'unavailable'; models?: Model[]; currentModel?: string; modes?: Model[]; currentMode?: string; error?: string; at?: string };
type Entry = Record<string, unknown>;
type ProviderFile = { kind: 'acp' | 'antigravity'; label?: string; description?: string; command: string; args?: string[]; env?: Record<string, string>; models?: Model[]; additionalModels?: Model[]; enabled?: boolean; params?: Record<string, unknown>; readOnlyMode?: 'instructions' | 'reject' };

/** Paseo's ids: the catalog's and the ones its app makes. */
const PASEO_ID = /^[a-z][a-z0-9-]*$/;
/** Snapshots the app asked for by folder, so a finished discovery reaches each of them. */
const KEPT_FOLDERS = 20;

export function createProviders({ home, broadcast, alpEntry, refreshCatalog, log = () => {} }: {
  home?: string;
  /** alpd's catalog.refresh over the local connection (t-086c): asks each native CLI for its models now. */
  refreshCatalog?: () => Promise<unknown>;
  broadcast: (message: Outbound) => void;
  /** ALP's own entry for a folder (agents.ts). */
  alpEntry: (cwd?: string) => Promise<Entry>;
  log?: (message: string) => void;
}) {
  const found = new Map<string, Found>();
  const discovering = new Map<string, Promise<void>>();
  const folders: Array<string | undefined> = [undefined];
  const native = new Map<string, Promise<Entry>>();
  const nativeIds = ['claude', 'codex'];
  function nativeEntry(id: string): Promise<Entry> {
    if (!native.has(id)) native.set(id, (async () => {
      const command = process.env[id === 'claude' ? 'ALP_CLAUDE_BIN' : 'ALP_CODEX_BIN'] ?? id;
      const version = await runCommand(command, ['--version'], { timeoutMs: 10_000 });
      return {
        provider: id, label: id === 'claude' ? 'Claude Code' : 'Codex', source: 'builtin', enabled: true,
        status: version.code === 0 ? 'ready' : 'unavailable',
        ...(version.code !== 0 ? { error: version.stderr.trim() || `${command} is unavailable` } : {}),
        description: 'Native runtime · models from the ALP catalog',
      };
    })());
    // The models are read fresh each time: alpd's live catalog cache may have changed since (t-e5ee).
    return native.get(id)!.then((entry): Entry => ({ ...entry, models: catalogModels(home).filter(model => model.runtime === id).map((model, index) => ({ provider: id, id: model.id, label: model.label, description: model.description, isDefault: index === 0 })) }));
  }

  /** Refreshes alpd's live model catalog; the native entries read its cache again on the next push. */
  async function refreshNativeModels() {
    if (!refreshCatalog) throw new Error('the model list refreshes through the ALP daemon, which this server does not reach');
    await refreshCatalog();
  }

  async function files() {
    if (!home) return [];
    await ensureLibrary(home, { templates });
    const rows: Array<{ id: string; config: ProviderFile }> = [];
    for (const provider of await listProviders(home)) {
      const entry = await getEntry('providers', provider.id, { library: home, scope: 'library' }).catch(() => undefined);
      if (entry) rows.push({ id: provider.id, config: entry.content.provider as ProviderFile });
    }
    return rows;
  }

  /** Starts the provider's agent once to learn its models; the snapshot says loading meanwhile. */
  function discover(id: string) {
    if (discovering.has(id) || !home) return discovering.get(id);
    found.set(id, { ...found.get(id), status: 'loading' });
    const run = (async () => {
      try {
        const provider = await loadProvider(home, id);
        if (!provider) { found.delete(id); return; }
        const result = provider.kind === 'antigravity'
          ? await probeAntigravity(provider, { cwd: home, timeoutMs: 60_000 })
          : await probeAcp(provider, { cwd: home, discover: true, timeoutMs: 60_000 });
        found.set(id, { status: 'ready', models: result.models, currentModel: result.currentModel, modes: result.modes, currentMode: result.currentMode, at: new Date().toISOString() });
      } catch (error: any) {
        const message = String(error?.message ?? error);
        // A command that is not there is "not installed" in the app.
        found.set(id, { status: error?.code === 'ENOENT' || /ENOENT|not found/.test(message) ? 'unavailable' : 'error', error: message.slice(0, 500), at: new Date().toISOString() });
        log(`provider ${id}: ${message}`);
      } finally {
        discovering.delete(id);
        void push();
      }
    })();
    discovering.set(id, run);
    return run;
  }

  function entryOf(id: string, config: ProviderFile): Entry {
    const enabled = config.enabled !== false;
    const state = found.get(id);
    if (enabled && !state) void discover(id);
    const offered = config.models ?? state?.models ?? [];
    const models = [...offered, ...(config.additionalModels ?? []).filter(extra => !offered.some(model => model.id === extra.id))];
    return {
      provider: id,
      status: !enabled ? 'ready' : state?.status ?? 'loading',
      enabled,
      source: 'custom',
      label: config.label ?? id,
      ...(config.description ? { description: config.description } : {}),
      ...(enabled && state?.error ? { error: state.error } : {}),
      models: models.map(model => ({ provider: id, id: model.id, label: model.label ?? model.id, ...(model.description ? { description: model.description } : {}), ...(model.id === state?.currentModel ? { isDefault: true } : {}) })),
      ...(state?.modes ? { modes: state.modes.map(mode => ({ id: mode.id, label: mode.label ?? mode.id, ...(mode.description ? { description: mode.description } : {}) })) } : {}),
      ...(state?.currentMode ? { defaultModeId: state.currentMode } : {}),
      ...(state?.at ? { fetchedAt: state.at } : {}),
    };
  }

  async function entries(cwd?: string) {
    return [await alpEntry(cwd), ...await Promise.all(nativeIds.map(nativeEntry)), ...(await files()).map(({ id, config }) => entryOf(id, config))];
  }

  /** Every snapshot the app holds, again. */
  async function push() {
    for (const cwd of folders) {
      try {
        broadcast({ type: 'providers_snapshot_update', payload: { ...(cwd ? { cwd } : {}), entries: await entries(cwd), generatedAt: new Date().toISOString() } } as SessionOutboundMessage);
      } catch (error: any) {
        log(`providers snapshot for ${cwd ?? 'home'} failed: ${error?.message ?? error}`);
      }
    }
  }

  /** The providers part of Paseo's daemon config. */
  async function config() {
    const view: Record<string, Entry> = {};
    for (const { id, config } of await files()) {
      view[id] = {
        extends: config.kind === 'antigravity' ? 'antigravity' : 'acp',
        label: config.label ?? id,
        ...(config.description ? { description: config.description } : {}),
        command: [config.command, ...(config.args ?? [])],
        env: config.env ?? {},
        enabled: config.enabled !== false,
        ...(config.models ? { models: config.models } : {}),
        ...(config.additionalModels ? { additionalModels: config.additionalModels } : {}),
        ...(config.params ? { params: config.params } : {}),
      };
    }
    return view;
  }

  /** Applies the providers part of a config change: each named provider merged into its file, then removals. */
  async function apply(patch: Record<string, Record<string, unknown>> = {}, remove: string[] = []) {
    if (!home) throw new Error('No ALP library to keep providers in');
    await ensureLibrary(home, { templates });
    for (const [id, change] of Object.entries(patch)) {
      const current = await getEntry('providers', id, { library: home, scope: 'library' }).catch(() => undefined);
      if (RESERVED_PROVIDERS.includes(id) && !(id === 'antigravity' && (change.extends === 'antigravity' || (current?.content.provider as ProviderFile | undefined)?.kind === 'antigravity'))) throw new Error(`${id} is built into ALP; its models are ALP's teams`);
      if (change.extends !== undefined && change.extends !== 'acp' && change.extends !== 'antigravity') throw new Error(`ALP adds ACP agents only, not providers that extend ${String(change.extends)}`);
      if (!current) {
        if (!PASEO_ID.test(id)) throw new Error(`'${id}' cannot name a provider: use lowercase letters, digits and '-', starting with a letter`);
        if (change.extends !== 'acp' && change.extends !== 'antigravity') throw new Error('A new provider must be an ACP agent ("extends": "acp")');
      }
      const before = (current?.content.provider ?? { kind: (change.extends === 'antigravity' ? 'antigravity' : 'acp') }) as ProviderFile;
      const next: Record<string, unknown> = { ...before, kind: change.extends === 'antigravity' ? 'antigravity' : (before.kind ?? 'acp') };
      if (change.command !== undefined) {
        if (!Array.isArray(change.command) || !change.command.length || !change.command.every(part => typeof part === 'string')) throw new Error('command must list the program and its arguments');
        next.command = change.command[0];
        next.args = change.command.slice(1);
        if (!(next.args as string[]).length) delete next.args;
      }
      for (const key of ['label', 'description', 'env', 'enabled', 'models', 'additionalModels', 'params'] as const) {
        if (change[key] === undefined) continue;
        if (change[key] === null) delete next[key]; else next[key] = change[key];
      }
      // Paseo's model entries may carry isDefault; ALP keeps id, label and description.
      for (const key of ['models', 'additionalModels'] as const) {
        if (Array.isArray(next[key])) next[key] = (next[key] as Array<Record<string, unknown>>).map(model => ({ id: model.id, ...(model.label ? { label: model.label } : {}), ...(model.description ? { description: model.description } : {}) }));
      }
      if (!next.command) throw new Error(`${id} needs a command`);
      await saveEntry('providers', id, { provider: next }, { scope: 'library', library: home, revision: current?.revision ?? null });
      const reprobe = ['command', 'env', 'enabled'].some(key => change[key] !== undefined);
      if (reprobe || !found.has(id)) found.delete(id);
    }
    for (const id of remove) {
      if (RESERVED_PROVIDERS.includes(id) && id !== 'antigravity') throw new Error(`${id} is built into ALP and cannot be removed`);
      await deleteEntry('providers', id, { library: home, scope: 'library' });
      found.delete(id);
    }
    void push();
  }

  /** The text the app shows when asked to diagnose a provider. */
  async function diagnostic(id: string) {
    if (nativeIds.includes(id)) {
      native.delete(id);
      let refreshed = 'Model list refreshed from the provider.';
      try { await refreshNativeModels(); } catch (error: any) { refreshed = `Model list not refreshed: ${error?.message ?? error}`; }
      const entry = await nativeEntry(id);
      void push();
      return `${entry.label}: ${entry.status === 'ready' ? 'installed' : entry.error}. Models are from the ALP catalog; access depends on your account.\n${refreshed}\nModels: ${(entry.models as Model[] | undefined)?.map(model => model.id).join(', ') || 'none'}`;
    }
    if (id === 'alp') return 'ALP runs its teams of Codex and Claude Code agents. Check them with: alp doctor';
    if (home) await ensureLibrary(home, { templates });
    const provider = home ? await loadProvider(home, id) : undefined;
    if (!provider) return `No provider '${id}' in ${home ?? 'the library'}/providers.`;
    const lines = [`Provider: ${provider.label} (${id})`, `Command: ${[provider.command, ...provider.args].join(' ')}`, `Enabled: ${provider.enabled === false ? 'no' : 'yes'}`];
    try {
      if (provider.kind === 'antigravity') {
        const result = await probeAntigravity(provider, { cwd: home, timeoutMs: 60_000 });
        lines.push(`Antigravity: ${result.version || 'installed'}`);
        lines.push('Modes: read-only, workspace-write and full-access, enforced by agy (--sandbox, --mode, permission settings).');
        lines.push(`Models: ${result.models?.length ? result.models.map((model: Model) => model.id).join(', ') : 'none reported'}`);
        if (result.modes?.length) lines.push(`Modes: ${result.modes.map((mode: Model) => mode.id).join(', ')}`);
        found.set(id, { status: 'ready', models: result.models, currentModel: result.currentModel, modes: result.modes, currentMode: result.currentMode, at: new Date().toISOString() });
      } else {
        const result = await probeAcp(provider, { cwd: home, discover: true, timeoutMs: 60_000 });
        lines.push(`ACP: version ${result.protocolVersion}${result.agent ? `, ${[result.agent.title ?? result.agent.name, result.agent.version].filter(Boolean).join(' ')}` : ''}`);
        lines.push(`Resumes sessions: ${result.loadSession ? 'yes' : 'no'}; MCP over HTTP: ${result.mcpHttp ? 'yes' : 'no'}`);
        if (result.authMethods.length) lines.push(`Sign-in methods: ${result.authMethods.join(', ')}`);
        lines.push(`Models: ${result.models?.length ? result.models.map((model: Model) => model.id).join(', ') : 'none reported'}`);
        if (result.modes?.length) lines.push(`Modes: ${result.modes.map((mode: Model) => mode.id).join(', ')}`);
        found.set(id, { status: 'ready', models: result.models, currentModel: result.currentModel, modes: result.modes, currentMode: result.currentMode, at: new Date().toISOString() });
      }
    } catch (error: any) {
      lines.push(`Error: ${error?.message ?? error}`);
    }
    void push();
    return lines.join('\n');
  }

  const handlers: Record<string, Handler> = {
    async get_providers_snapshot_request(message: Inbound<'get_providers_snapshot_request'>) {
      const cwd = message.cwd || undefined;
      if (!folders.includes(cwd)) { folders.push(cwd); if (folders.length > KEPT_FOLDERS) folders.splice(1, 1); }
      return { type: 'get_providers_snapshot_response', payload: { requestId: message.requestId, entries: await entries(cwd) as any, generatedAt: new Date().toISOString() } } satisfies Outbound;
    },

    async refresh_providers_snapshot_request(message: Inbound<'refresh_providers_snapshot_request'>) {
      const ids = message.providers?.length ? message.providers : (await files()).map(row => row.id);
      if (!message.providers?.length) native.clear();
      // Native models come from alpd's live catalog: ask it to refresh, then push the new lists.
      if (ids.some(id => nativeIds.includes(id))) void refreshNativeModels().then(() => push(), error => log(`model catalog refresh failed: ${error?.message ?? error}`));
      for (const id of ids) {
        if (nativeIds.includes(id)) native.delete(id);
        else if (id !== 'alp') { found.delete(id); void discover(id); }
      }
      void push();
      return { type: 'refresh_providers_snapshot_response', payload: { requestId: message.requestId, acknowledged: true } } satisfies SessionOutboundMessage;
    },

    async provider_diagnostic_request(message: Inbound<'provider_diagnostic_request'>) {
      return { type: 'provider_diagnostic_response', payload: { requestId: message.requestId, provider: message.provider, diagnostic: await diagnostic(message.provider) } } satisfies SessionOutboundMessage;
    },
  };

  // providerRemoval: the app offers Remove on the library's providers.
  return { handlers, features: { providerRemoval: true }, config, apply, push };
}

export type Providers = ReturnType<typeof createProviders>;
