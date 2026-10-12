/** Models ALP offers, with the efforts each takes: the runtime's catalog and alp setup read this list. */
const codexFull = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const codexStandard = ['low', 'medium', 'high', 'xhigh', 'max'];
const claudeFull = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
const claudeLegacy = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultracode'];
const claude46 = ['off', 'low', 'medium', 'high', 'max'];

/**
 * @type {Array<{ runtime: 'codex' | 'claude', id: string, label: string, description: string, efforts: string[], effort?: string }>}
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
].map(([runtime, id, label, description, efforts, effort]) => ({ runtime, id, label, description, efforts, ...(effort ? { effort } : {}) }));
