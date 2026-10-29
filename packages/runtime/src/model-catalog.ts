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
export type CatalogSnapshot = { fetchedAt?: string; providers: Partial<Record<CatalogRuntime, ProviderState>> };
export type Probe = (signal: AbortSignal) => Promise<LiveModel[]>;

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
  return { ...(typeof value?.fetchedAt === 'string' ? { fetchedAt: value.fetchedAt } : {}), providers };
}

type Listener = (snapshot: CatalogSnapshot, entries: CatalogEntry[]) => void;

export class ModelCatalog {
  private snapshot: CatalogSnapshot = { providers: {} };
  private current: CatalogEntry[] = staticRows();
  private listeners = new Set<Listener>();
  private timer?: NodeJS.Timeout;
  private running?: Promise<CatalogSnapshot>;
  private readonly file?: string;

  constructor(private readonly options: { home?: string; probes: Partial<Record<CatalogRuntime, Probe>>; timeoutMs?: number; refreshMs?: number; now?: () => Date; apply?: boolean }) {
    this.file = options.home ? catalogCacheFile(options.home) : undefined;
  }

  entries() { return this.current; }
  state() { return this.snapshot; }
  onUpdated(listener: Listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  /** Loads the cache, then refreshes in the background and every refreshMs. Never blocks on a provider. */
  async start() {
    await this.load();
    void this.refresh().catch(() => {});
    const every = this.options.refreshMs ?? REFRESH_MS;
    if (every > 0) { this.timer = setInterval(() => { void this.refresh().catch(() => {}); }, every); this.timer.unref?.(); }
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; this.listeners.clear(); }

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

  private async publish(save: boolean) {
    const next = mergeCatalog(staticRows(), Object.fromEntries(Object.entries(this.snapshot.providers).map(([runtime, state]) => [runtime, state?.models])));
    const changed = JSON.stringify(next) !== JSON.stringify(this.current);
    this.current = next;
    if (this.options.apply !== false) applyCatalog(next);
    if (save && this.file) {
      try { await mkdir(path.dirname(this.file), { recursive: true }); await writeAtomic(this.file, JSON.stringify(this.snapshot, null, 2)); } catch { /* the cache is best effort */ }
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
