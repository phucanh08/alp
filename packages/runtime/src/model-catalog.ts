/**
 * The live model catalog (t-e5ee): ALP serves core MODELS at once, then asks each provider which
 * models it offers now and merges the answer over the static rows. A probe that fails keeps the
 * previous list; the merged answer is cached in ALP_HOME/cache/models.json for the next start.
 */
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MODELS, MODEL_POLICY, catalogCacheFile, mergeCatalog as mergeCatalogRows } from '@anhlp/alp-core/models';
import { writeAtomic } from '@anhlp/alp-core/atomic';
import { applyCatalog, type CatalogEntry } from './catalog.js';

export type CatalogRuntime = 'codex' | 'claude' | 'antigravity';
/** A model as a provider reports it. */
export type LiveModel = { id: string; label?: string; description?: string; efforts?: string[]; effort?: string };
export type ProviderState = { status: 'ok' | 'failed' | 'static'; fetchedAt?: string; error?: string; models: LiveModel[] };
/** What ALP learned of an ACP provider's models (t-d0b0): nothing until a session or an explicit probe tells it. */
export type AcpStatus = 'unprobed' | 'ok' | 'failed';
export type AcpState = { status: AcpStatus; fetchedAt?: string; error?: string; models: LiveModel[] };
export type CatalogSnapshot = { fetchedAt?: string; providers: Partial<Record<CatalogRuntime, ProviderState>>; acp?: Record<string, AcpState> };
export type Probe = (signal: AbortSignal) => Promise<LiveModel[]>;
/** A provider of the library (providers/<id>.json), as loadProvider reads it. */
export type AcpProviderConfig = { id: string; kind?: string; label?: string; description?: string; enabled?: boolean;
  models?: Array<{ id: string; label?: string; description?: string }>; additionalModels?: Array<{ id: string; label?: string; description?: string }> };
export type AcpProbe = (provider: AcpProviderConfig, signal: AbortSignal) => Promise<LiveModel[]>;
/** An ACP row of the catalog: `acp:<provider>` (the agent's own default) and `acp:<provider>/<model>`. */
export type AcpRow = { runtime: 'acp'; provider: string; id: string; label: string; description: string; efforts: string[];
  source: 'configured' | 'live'; enabled: boolean; status: AcpStatus };

const RUNTIMES: CatalogRuntime[] = ['codex', 'claude', 'antigravity'];
export const REFRESH_MS = 6 * 60 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 15_000;

export const POLICY = MODEL_POLICY;
export const mergeCatalog = mergeCatalogRows as (base: CatalogEntry[], live: Partial<Record<CatalogRuntime, LiveModel[] | undefined>>) => CatalogEntry[];

const staticRows = (): CatalogEntry[] => MODELS.map(entry => ({ ...entry, source: 'static' as const })) as CatalogEntry[];

const bounded = <T>(work: (signal: AbortSignal) => Promise<T>, ms: number) => {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work(controller.signal),
    new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error(`timed out after ${ms} ms`)); }, ms); }),
  ]).finally(() => clearTimeout(timer));
};

const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
/** Only well-formed rows: a string id, string label/description/effort, string efforts. */
export function sanitizeModels(value: unknown): LiveModel[] {
  if (!Array.isArray(value)) return [];
  return value.filter(model => model && typeof model === 'object' && typeof model.id === 'string' && model.id.trim()).map(model => ({
    id: model.id,
    ...(typeof model.label === 'string' ? { label: model.label } : {}),
    ...(typeof model.description === 'string' ? { description: model.description } : {}),
    ...(strings(model.efforts) ? { efforts: strings(model.efforts) } : {}),
    ...(typeof model.effort === 'string' ? { effort: model.effort } : {}),
  }));
}
/** A cache file read back: known runtimes only, each with a list of well-formed rows. */
function sanitize(value: any): CatalogSnapshot {
  const providers: CatalogSnapshot['providers'] = {};
  for (const runtime of RUNTIMES) {
    const state = value?.providers?.[runtime];
    if (!state || typeof state !== 'object') continue;
    providers[runtime] = { status: state.status === 'ok' ? 'ok' : 'failed', ...(typeof state.fetchedAt === 'string' ? { fetchedAt: state.fetchedAt } : {}), models: sanitizeModels(state.models) };
  }
  const acp: Record<string, AcpState> = {};
  if (value?.acp && typeof value.acp === 'object') for (const [id, state] of Object.entries<any>(value.acp)) {
    if (!/^[\w.-]+$/.test(id) || !state || typeof state !== 'object') continue;
    acp[id] = { status: state.status === 'ok' ? 'ok' : state.status === 'failed' ? 'failed' : 'unprobed', ...(typeof state.fetchedAt === 'string' ? { fetchedAt: state.fetchedAt } : {}), ...(typeof state.error === 'string' ? { error: state.error } : {}), models: sanitizeModels(state.models) };
  }
  return { ...(typeof value?.fetchedAt === 'string' ? { fetchedAt: value.fetchedAt } : {}), providers, ...(Object.keys(acp).length ? { acp } : {}) };
}

/** The models a `session/new` answer offers (ACP `models.availableModels`, or a model select config option). */
export function acpSessionModels(result: any): LiveModel[] {
  const config = Array.isArray(result?.configOptions) ? result.configOptions.find((option: any) => option?.category === 'model' && option?.type === 'select') : undefined;
  const listed = Array.isArray(result?.models?.availableModels) ? result.models.availableModels
    : config ? (config.options ?? []).flatMap((option: any) => option?.options ?? [option]).map((option: any) => ({ modelId: option?.value, name: option?.name, description: option?.description })) : [];
  return sanitizeModels(listed.map((model: any) => ({ id: model?.modelId ?? model?.id, ...(typeof model?.name === 'string' && model.name ? { label: model.name } : {}), ...(typeof model?.description === 'string' && model.description ? { description: model.description } : {}) })));
}

type Listener = (snapshot: CatalogSnapshot, entries: CatalogEntry[]) => void;

export class ModelCatalog {
  private snapshot: CatalogSnapshot = { providers: {} };
  private current: CatalogEntry[] = staticRows();
  private listeners = new Set<Listener>();
  private timer?: NodeJS.Timeout;
  private running?: Promise<CatalogSnapshot>;
  private readonly file?: string;
  private acpConfigs: AcpProviderConfig[] = [];
  private acpRunning?: Promise<CatalogSnapshot>;
  private acpError?: string;
  private acpLearning = new Map<string, Set<string>>();
  /** Cache writes under way: stop() waits for them, so whoever stopped the catalog may remove its home. */
  private writes = new Set<Promise<void>>();
  /** Set once stop() has drained: a late answer (a session's models, an ingest) still updates memory but writes nothing. */
  private stopped = false;

  /**
   * ACP providers (t-d0b0) come from `acpProviders` (the library's providers/<id>.json) without starting
   * them; their models are learned from sessions (learnAcp) and probed (acpProbe) only by refreshAcp,
   * which alpd calls on catalog.refresh and when the user enables a provider. Never at start or on the timer.
   */
  constructor(private readonly options: { home?: string; probes: Partial<Record<CatalogRuntime, Probe>>; timeoutMs?: number; refreshMs?: number; now?: () => Date; apply?: boolean;
    acpProviders?: () => Promise<AcpProviderConfig[] | { providers: AcpProviderConfig[]; error?: string }>; acpProbe?: AcpProbe }) {
    this.file = options.home ? catalogCacheFile(options.home) : undefined;
  }

  entries() { return this.current; }
  state() { return this.snapshot; }
  onUpdated(listener: Listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** Loads the cache, then refreshes in the background and every refreshMs. Never blocks on a provider. */
  async start() {
    this.stopped = false;
    await this.load();
    await this.loadAcp().catch(() => {});
    void this.refresh().catch(() => {});
    const every = this.options.refreshMs ?? REFRESH_MS;
    if (every > 0) { this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, every); this.timer.unref?.(); }
  }
  /**
   * Stops the timer and the listeners, then waits for what already started (a background refresh, a
   * refreshAcp a saved provider asked for, a learned model's cache write) to finish writing the cache
   * (t-5294.2). After that it writes the cache no more, until start() again. A caller that only stops may
   * ignore the promise; one that removes the home awaits it.
   */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.listeners.clear();
    // A refreshAcp queued behind a running one starts when it ends: wait until nothing runs.
    while (this.running || this.acpRunning || this.writes.size) await Promise.allSettled([this.running, this.acpRunning, ...this.writes]);
    this.stopped = true;
  }

  async load() {
    if (!this.file) return;
    try {
      this.snapshot = sanitize(JSON.parse(await readFile(this.file, 'utf8')));
      await this.publish(false);
    } catch { this.snapshot = { providers: {} }; /* no cache, or unreadable: static rows serve */ }
  }

  /** Asks every provider (or the named ones; a refresh already running answers instead) at once; each answer is bounded, and a failure keeps that provider's previous list. */
  refresh(runtimes: CatalogRuntime[] = RUNTIMES): Promise<CatalogSnapshot> {
    if (this.running) return this.running;
    this.running = (async () => {
      const now = () => (this.options.now?.() ?? new Date()).toISOString();
      const results = await Promise.all(runtimes.filter(runtime => this.options.probes[runtime]).map(async runtime => {
        try { return [runtime, { status: 'ok', fetchedAt: now(), models: sanitizeModels(await bounded(this.options.probes[runtime]!, this.options.timeoutMs ?? PROBE_TIMEOUT_MS)) }] as const; }
        catch (error) {
          const prior = this.snapshot.providers[runtime];
          return [runtime, { status: 'failed', fetchedAt: prior?.fetchedAt, error: error instanceof Error ? error.message : String(error), models: prior?.models ?? [] }] as const;
        }
      }));
      for (const [runtime, state] of results) {
        // An empty answer is no answer: keep what we had.
        if (state.status === 'ok' && !state.models.length) { this.snapshot.providers[runtime] = { ...(this.snapshot.providers[runtime] ?? { models: [] }), status: 'failed', error: 'provider reported no models' }; continue; }
        this.snapshot.providers[runtime] = state as ProviderState;
      }
      this.snapshot.fetchedAt = now();
      await this.publish(true);
      return this.snapshot;
    })().finally(() => { this.running = undefined; });
    return this.running;
  }

  /**
   * A list a session reported on its own (each turn's orchestration context). Additive: it only adds
   * models the catalog does not list yet, after the ones it has, so it never narrows or reshapes what a
   * probe answered; a list with nothing new changes nothing.
   */
  async ingest(runtime: CatalogRuntime, models: LiveModel[]) {
    const prior = this.snapshot.providers[runtime];
    const known = new Set((prior?.models ?? []).map(model => model.id));
    const added = sanitizeModels(models).filter(model => !known.has(model.id));
    if (!added.length) return false;
    this.snapshot.providers[runtime] = { ...(prior ?? { status: 'ok' }), status: prior?.status ?? 'ok', fetchedAt: prior?.fetchedAt ?? (this.options.now?.() ?? new Date()).toISOString(), models: [...(prior?.models ?? []), ...added] };
    await this.publish(true);
    return true;
  }

  /** Rereads the ACP providers' files; starts none of them. */
  async loadAcp() {
    if (!this.options.acpProviders) return;
    // A listing that fails (an unreadable providers directory) keeps the rows ALP had and records why.
    try {
      const loaded = await this.options.acpProviders();
      this.acpConfigs = (Array.isArray(loaded) ? loaded : loaded.providers).filter(provider => provider.kind !== 'antigravity');
      this.acpError = Array.isArray(loaded) ? undefined : loaded.error;
    } catch (error) { this.acpError = error instanceof Error ? error.message : String(error); }
  }
  /** Why the last reading of the ACP providers failed, if it did. */
  acpLoadError(): string | undefined { return this.acpError; }

  /** The ACP rows: each provider's default, then its models (the file's `models` replace learned ones; `additionalModels` add). */
  acpRows(): AcpRow[] {
    const rows: AcpRow[] = [];
    for (const provider of this.acpConfigs) {
      const state = this.snapshot.acp?.[provider.id];
      const status = state?.status ?? 'unprobed';
      const enabled = provider.enabled !== false;
      const label = provider.label ?? provider.id;
      const row = (id: string, text: string, description: string, source: AcpRow['source']): AcpRow => ({ runtime: 'acp', provider: provider.id, id, label: text, description, efforts: [], source, enabled, status });
      rows.push(row(provider.id, `${label} · agent default`, provider.description ?? '', 'configured'));
      const seen = new Set<string>();
      const add = (models: Array<{ id: string; label?: string; description?: string }>, source: AcpRow['source']) => {
        for (const model of models) if (!seen.has(model.id)) { seen.add(model.id); rows.push(row(`${provider.id}/${model.id}`, `${label} · ${model.label ?? model.id}`, model.description ?? '', source)); }
      };
      add(provider.models ?? state?.models ?? [], provider.models ? 'configured' : 'live');
      add(provider.additionalModels ?? [], 'configured');
    }
    return rows;
  }
  /** The models ALP learned or probed for one ACP provider. */
  acpModels(provider: string): LiveModel[] { return this.snapshot.acp?.[provider]?.models ?? []; }

  /**
   * A list an ACP session's `session/new` reported (t-d0b0). Additive, as ingest: it never removes a model
   * a probe answered; a list with nothing new changes nothing.
   */
  async learnAcp(provider: string, models: LiveModel[]) {
    if (!/^[\w.-]+$/.test(provider)) return false;
    const reported = sanitizeModels(models);
    for (const model of reported) this.acpLearning.get(provider)?.add(model.id);
    const prior = this.snapshot.acp?.[provider];
    const known = new Set((prior?.models ?? []).map(model => model.id));
    const added = reported.filter(model => !known.has(model.id));
    if (!added.length) return false;
    this.snapshot.acp = { ...this.snapshot.acp, [provider]: { status: 'ok', fetchedAt: (this.options.now?.() ?? new Date()).toISOString(), models: [...(prior?.models ?? []), ...added] } };
    await this.publish(true);
    return true;
  }

  /**
   * Starts each enabled ACP provider (or the named ones) once to read its models: only on an explicit
   * catalog.refresh or when the user enables a provider. A failure keeps what ALP knew and records why.
   */
  refreshAcp(ids?: string[]): Promise<CatalogSnapshot> {
    if (this.acpRunning) return this.acpRunning.then(() => this.refreshAcp(ids));
    this.acpRunning = (async () => {
      await this.loadAcp();
      const probe = this.options.acpProbe;
      const targets = this.acpConfigs.filter(provider => provider.enabled !== false && (!ids || ids.includes(provider.id)));
      if (!probe || !targets.length) return this.snapshot;
      const now = () => (this.options.now?.() ?? new Date()).toISOString();
      await Promise.all(targets.map(async provider => {
        const learned = new Set<string>();
        this.acpLearning.set(provider.id, learned);
        let outcome: { ok: true; models: LiveModel[] } | { ok: false; error: string };
        try { outcome = { ok: true, models: sanitizeModels(await bounded(signal => probe(provider, signal), this.options.timeoutMs ?? PROBE_TIMEOUT_MS)) }; }
        catch (error) { outcome = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
        this.acpLearning.delete(provider.id);
        // Read at write time: what a session's learnAcp reported during the probe stays.
        const current = this.snapshot.acp?.[provider.id];
        const known = current?.models ?? [];
        let next: AcpState;
        if (outcome.ok) {
          const ids = new Set(outcome.models.map(model => model.id));
          // A successful probe replaces old choices, retaining only learning concurrent with this probe.
          next = { status: 'ok', fetchedAt: now(), models: [...outcome.models, ...known.filter(model => learned.has(model.id) && !ids.has(model.id))] };
        } else next = { status: 'failed', ...(current?.fetchedAt ? { fetchedAt: current.fetchedAt } : {}), error: outcome.error, models: known };
        this.snapshot.acp = { ...this.snapshot.acp, [provider.id]: next };
      }));
      await this.publish(true);
      return this.snapshot;
    })().finally(() => { this.acpRunning = undefined; });
    return this.acpRunning;
  }

  private async publish(save: boolean) {
    const next = mergeCatalog(staticRows(), Object.fromEntries(Object.entries(this.snapshot.providers).map(([runtime, state]) => [runtime, state?.models])));
    const changed = JSON.stringify(next) !== JSON.stringify(this.current);
    this.current = next;
    if (this.options.apply !== false) applyCatalog(next);
    if (save && this.file && !this.stopped) {
      const file = this.file;
      const write = (async () => {
        try { await mkdir(path.dirname(file), { recursive: true }); await writeAtomic(file, JSON.stringify(this.snapshot, null, 2)); } catch { /* the cache is best effort */ }
      })();
      this.writes.add(write);
      try { await write; } finally { this.writes.delete(write); }
    }
    if (save) for (const listener of this.listeners) { try { listener(this.snapshot, next); } catch { /* a listener never stops the catalog */ } }
    return changed;
  }
}

/** Reads a session's orchestration context models (`runtime:id`, label, description, thinking) as live models. */
export function liveFromContext(context: any): { runtime: CatalogRuntime; models: LiveModel[] } | undefined {
  if (!context?.catalogAvailable || !RUNTIMES.includes(context.runtime) || !Array.isArray(context.models)) return undefined;
  if (context.catalogComplete === false) return undefined;
  const prefix = `${context.runtime}:`;
  const models = context.models.filter((model: any) => typeof model?.id === 'string' && model.id.startsWith(prefix)).map((model: any) => ({
    id: model.id.slice(prefix.length), label: model.label, description: model.description,
    efforts: Array.isArray(model.thinking) ? model.thinking.map((effort: any) => typeof effort === 'string' ? effort : effort?.reasoningEffort ?? effort?.id).filter((effort: unknown) => typeof effort === 'string') : undefined,
  }));
  return { runtime: context.runtime, models };
}

let active: ModelCatalog | undefined;
/** The daemon's catalog, which sessions feed opportunistically. */
export function setActiveCatalog(catalog: ModelCatalog | undefined) { active = catalog; }
export function activeCatalog() { return active; }
export function feedCatalog(context: unknown) {
  const live = liveFromContext(context);
  if (live && active) void active.ingest(live.runtime, live.models).catch(() => {});
}
/** An ACP session's `session/new` answer teaches the daemon's catalog that provider's models (t-d0b0). */
export function feedAcpSession(provider: string, result: unknown) {
  const models = acpSessionModels(result);
  if (models.length && active) void active.learnAcp(provider, models).catch(() => {});
}
