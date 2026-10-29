import { readFileSync } from 'node:fs';
import path from 'node:path';

/** Models ALP offers when no provider has answered yet (the live catalog, t-e5ee, merges provider lists over these), with the efforts each takes: the runtime's catalog and alp setup read this list. */
const codexFull = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const codexStandard = ['low', 'medium', 'high', 'xhigh', 'max'];
const claudeFull = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
const claudeLegacy = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
const claude46 = ['off', 'low', 'medium', 'high', 'max'];

/**
 * @type {Array<{ runtime: 'codex' | 'claude' | 'antigravity', id: string, label: string, description: string, efforts: string[], effort?: string }>}
 */
export const MODELS = [
  ['codex', 'gpt-6.1-sol', 'GPT-6.1-Sol', 'Latest workhorse model for coding and everyday work.', codexFull, 'low'],
  // ALP runs GPT-6 Astra at low effort only.
  ['codex', 'gpt-6-astra', 'GPT-6-Astra', 'Frontier intelligence for the most demanding work.', ['low'], 'low'],
  ['codex', 'gpt-6-sol', 'GPT-6-Sol', 'Previous generation workhorse model.', codexFull, 'low'],
  ['codex', 'gpt-6-luna', 'GPT-6-Luna', 'Fast and affordable model for easier tasks.', codexStandard, 'low'],
  ['codex', 'gpt-5.6-sol', 'GPT-5.6-Sol', 'Older generation workhorse model.', codexFull, 'low'],
  ['codex', 'gpt-5.6-terra', 'GPT-5.6-Terra', 'Older balanced model for straightforward work.', codexFull, 'low'],
  ['codex', 'gpt-5.6-luna', 'GPT-5.6-Luna', 'Older fast and efficient model.', codexStandard, 'low'],
  ['claude', 'claude-opus-5-5', 'Opus 5.5', 'Latest release.', claudeFull, 'medium'],
  ['claude', 'claude-opus-5', 'Opus 5', 'Previous release.', claudeLegacy, 'high'],
  ['claude', 'claude-fable-5-1', 'Fable 5.1', 'Most powerful model.', claudeFull, 'high'],
  ['claude', 'claude-fable-5', 'Fable 5', 'Previous release.', claudeFull, 'high'],
  ['claude', 'claude-opus-4-8[1m]', 'Opus 4.8 1M', 'Opus 4.8 with 1M context window.', claudeLegacy, 'high'],
  ['claude', 'claude-opus-4-8', 'Opus 4.8', 'Previous release.', claudeLegacy, 'high'],
  ['claude', 'claude-sonnet-5-5', 'Sonnet 5.5', 'Best for everyday tasks.', claudeFull, 'medium'],
  ['claude', 'claude-sonnet-5', 'Sonnet 5', 'Previous release.', claudeLegacy, 'high'],
  ['claude', 'claude-sonnet-5[1m]', 'Sonnet 5 1M', 'Sonnet 5 with 1M context window.', claudeLegacy, 'high'],
  ['claude', 'claude-opus-4-7[1m]', 'Opus 4.7 1M', 'Opus 4.7 with 1M context window.', claudeLegacy, 'high'],
  ['claude', 'claude-opus-4-7', 'Opus 4.7', 'Previous release.', claudeLegacy, 'high'],
  ['claude', 'claude-opus-4-6[1m]', 'Opus 4.6 1M', 'Opus 4.6 with 1M context window.', claude46, 'high'],
  ['claude', 'claude-opus-4-6', 'Opus 4.6', 'Most capable for complex work.', claude46, 'high'],
  ['claude', 'claude-sonnet-4-6[1m]', 'Sonnet 4.6 1M', 'Sonnet 4.6 with 1M context window.', claude46, 'high'],
  ['claude', 'claude-sonnet-4-6', 'Sonnet 4.6', 'Best for everyday tasks.', claude46, 'high'],
  ['claude', 'claude-haiku-4-5', 'Haiku 4.5', 'Fastest for quick answers.', [], undefined],
  ['claude', 'sonnet', 'sonnet', 'From Claude settings.json model.', [], undefined],
  ['antigravity', 'gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)', 'High reasoning effort workhorse for complex tasks.', [], undefined],
  ['antigravity', 'gemini-3.8-flash-medium', 'Gemini 3.8 Flash (Medium)', 'Balanced speed and reasoning.', [], undefined],
  ['antigravity', 'gemini-3.8-flash-low', 'Gemini 3.8 Flash (Low)', 'Fast and efficient for straightforward work.', [], undefined],
  ['antigravity', 'gemini-2.5-pro', 'Gemini 2.5 Pro', 'Deep reasoning for coding and analysis.', [], undefined],
  ['antigravity', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 'Fast and versatile everyday model.', [], undefined],
  ['antigravity', 'claude-sonnet-4-6', 'Claude Sonnet 4.6', 'Sonnet 4.6 via Antigravity.', [], undefined],
  ['antigravity', 'claude-opus-4-6-thinking', 'Claude Opus 4.6 Thinking', 'Opus 4.6 with thinking via Antigravity.', [], undefined],
  ['antigravity', 'gpt-oss-120b-medium', 'GPT-OSS 120B (Medium)', 'Open weights model via Antigravity.', [], undefined],
].map(([runtime, id, label, description, efforts, effort]) => ({ runtime, id, label, description, efforts, ...(effort ? { effort } : {}) }));

/** ALP policy applied over whatever a provider reports. */
export const MODEL_POLICY = {
  // ALP runs GPT-6 Astra at low effort only.
  'codex:gpt-6-astra': { efforts: ['low'], effort: 'low' },
};
const CATALOG_RUNTIMES = ['codex', 'claude', 'antigravity'];

/**
 * Live over static (t-e5ee): a runtime with a live list shows its live models first, in the provider's
 * order, with the provider's label and description; a live model ALP knows keeps ALP's efforts (plus any
 * new ones the provider adds) and ALP's default effort, a new one takes the provider's. Static rows the
 * provider did not report stay as `fallback` (aliases, 1M variants). A runtime without a live list keeps
 * its static rows. MODEL_POLICY applies last.
 * @param {typeof MODELS} base
 * @param {Partial<Record<string, Array<{ id: string, label?: string, description?: string, efforts?: string[], effort?: string }> | undefined>>} live
 * @returns {Array<(typeof MODELS)[number] & { source?: 'live' | 'fallback' | 'static' }>}
 */
export function mergeCatalog(base, live) {
  const out = [];
  for (const runtime of CATALOG_RUNTIMES) {
    const known = base.filter(entry => entry.runtime === runtime);
    const listed = live?.[runtime];
    const reported = (Array.isArray(listed) ? listed : []).filter(model => typeof model?.id === 'string' && model.id.trim());
    if (!reported.length) { out.push(...known); continue; }
    const seen = new Set();
    for (const model of reported) {
      if (seen.has(model.id)) continue;
      seen.add(model.id);
      const prior = known.find(entry => entry.id === model.id);
      const priorEfforts = prior?.efforts ?? [];
      const efforts = [...priorEfforts, ...(Array.isArray(model.efforts) ? model.efforts : []).filter(effort => typeof effort === 'string' && !priorEfforts.includes(effort))];
      const effort = prior?.effort ?? (typeof model.effort === 'string' && efforts.includes(model.effort) ? model.effort : undefined);
      const text = value => typeof value === 'string' && value ? value : undefined;
      out.push({ runtime, id: model.id, label: text(model.label) ?? prior?.label ?? model.id, description: text(model.description) ?? prior?.description ?? '', efforts, ...(effort ? { effort } : {}), source: 'live' });
    }
    for (const entry of known) if (!seen.has(entry.id)) out.push({ ...entry, source: 'fallback' });
  }
  return out.map(entry => {
    const policy = MODEL_POLICY[`${entry.runtime}:${entry.id}`];
    return policy ? { ...entry, ...policy } : entry;
  });
}

/** Where alpd caches the live catalog: ALP_HOME/cache/models.json. @param {string} home */
export const catalogCacheFile = home => path.join(home, 'cache', 'models.json');

/**
 * The catalog as alpd last saw it, for readers outside alpd (alp setup, the Paseo plugin): static rows
 * when there is no cache or it is unreadable. @param {string | undefined} home
 */
export function catalogModels(home) {
  if (!home) return MODELS;
  try {
    const cached = JSON.parse(readFileSync(catalogCacheFile(home), 'utf8'));
    const providers = cached?.providers && typeof cached.providers === 'object' ? cached.providers : {};
    return mergeCatalog(MODELS, Object.fromEntries(Object.entries(providers).map(([runtime, state]) => [runtime, Array.isArray(state?.models) ? state.models : undefined])));
  } catch { return MODELS; }
}
