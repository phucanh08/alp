/** Models, modes and thinking options the runtime accepts; viewers render them as-is. */
import { MODELS, useLiveModels } from '@anhlp/alp-core/models';

export const DEFAULT_MODEL = 'gpt-5.6-sol';
export const DEFAULT_CLAUDE_MODEL = 'sonnet';
export const DEFAULT_ANTIGRAVITY_MODEL = 'gemini-3.8-flash-high';
// Main's and the supervisor's models and effort come from the session's team: templates/teams/<id>/team.json (ALPD §42).
/** Oracle runs on one of these; main may consult both for two opinions. */
export const ORACLE_MODELS = ['claude:claude-fable-5-1', 'codex:gpt-6-astra'];
export const ORACLE_THINKING = 'high';
export const modes = [{ id: 'read-only', label: 'Read only' }, { id: 'workspace-write', label: 'Workspace write' }, { id: 'full-access', label: 'Full access' }];
const modeRank: Record<string, number> = { 'read-only': 0, 'workspace-write': 1, 'full-access': 2 };
/** Whether a session in `mode` may run with `requested`; a child never exceeds its requester. */
export const withinMode = (requested: string, mode: string) => (modeRank[requested] ?? 3) <= (modeRank[mode] ?? -1);
export const writes = (mode: string) => mode !== 'read-only';
const option = (id: string) => ({ id, label: id });
const options = (ids: string[]) => ids.map(option);
export const thinkingOptions = options(['none', 'off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode']);

const model = (runtime: 'codex' | 'claude' | 'antigravity', id: string, label: string, description: string, modelThinkingOptions: Array<{ id: string; label: string }>, defaultThinkingOptionId?: string) => ({
  id: `${runtime}:${id}`,
  label: `${runtime === 'codex' ? 'Codex' : runtime === 'claude' ? 'Claude Code' : 'Antigravity'} · ${label}`,
  description,
  thinkingOptions: modelThinkingOptions,
  ...(defaultThinkingOptionId ? { defaultThinkingOptionId } : {}),
});

export type CatalogEntry = { runtime: 'codex' | 'claude' | 'antigravity'; id: string; label: string; description: string; efforts: string[]; effort?: string; source?: 'live' | 'fallback' | 'static' };
const toModel = (entry: CatalogEntry) => model(entry.runtime, entry.id, entry.label, entry.description, options(entry.efforts), entry.effort);
/** The rows every consumer reads: core MODELS at start, replaced in place by the live catalog (model-catalog.ts). */
export const entries: CatalogEntry[] = MODELS.map(entry => ({ ...entry, source: 'static' as const })) as CatalogEntry[];
export const models = entries.map(toModel);
/** Replaces the catalog in place so every module holding `models`/`entries` sees the new rows. */
export function applyCatalog(next: CatalogEntry[]) {
  entries.splice(0, entries.length, ...next);
  models.splice(0, models.length, ...next.map(toModel));
  // Core's effort checks and fitting (validation.js, profiles.js) consult the same rows (t-086c).
  useLiveModels(next);
}

export function thinkingOptionsFor(runtime: 'codex' | 'claude' | 'antigravity', nativeModel: string) {
  return models.find(candidate => candidate.id === `${runtime}:${nativeModel}`)?.thinkingOptions ?? thinkingOptions;
}
