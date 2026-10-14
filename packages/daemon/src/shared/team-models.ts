/** Model plans change the runtime choices, preserving the template's roles and delegation. */
export type ModelChoice = { id: string; label: string; efforts: string[]; effort?: string };
export const MODEL_PRESETS = [
  { label: 'Claude only', value: 'claude' },
  { label: 'Codex only', value: 'codex' },
  { label: 'OpenCode only', value: 'opencode' },
  { label: 'Antigravity only', value: 'antigravity' },
  { label: 'Mix · Claude + Codex', value: 'mix' },
];
export function presetTeamModels(team: Record<string, any>, preset: string, models: ModelChoice[]) {
  const next = JSON.parse(JSON.stringify(team));
  const find = (provider: string) => models.find(model => provider === 'opencode' ? model.id === 'acp:opencode' || model.id.startsWith('acp:opencode/') : model.id.startsWith(`${provider}:`));
  const primary = find(preset === 'mix' ? 'claude' : preset);
  const secondary = preset === 'mix' ? find('codex') : primary;
  if (!primary || !secondary) throw new Error('No models available for this preset. Configure the provider in Settings first.');
  const assign = (target: Record<string, any>, model: ModelChoice) => {
    target.model = model.id;
    if (model.effort) target.thinking = model.effort; else delete target.thinking;
  };
  for (const [name, member] of Object.entries(next.members ?? {})) {
    if (name !== 'oracle') assign(member as Record<string, any>, name === next.main ? primary : secondary);
  }
  if (next.supervisor) assign(next.supervisor, secondary);
  if (next.members?.oracle) {
    next.oracleModels = [...new Set([primary.id, secondary.id])];
    next.oracleThinking = Object.fromEntries([primary, secondary].filter(model => model.effort).map(model => [model.id, model.effort]));
  }
  next.modelSetup = { mode: 'default', preset };
  return next;
}

/** Recover presets saved by the earlier editor, which stored models without the selected mode. */
export function modelSetupFor(team: Record<string, any>, models: ModelChoice[]) {
  if (team.modelSetup) return team.modelSetup;
  for (const { value } of MODEL_PRESETS) {
    let expected: Record<string, any>;
    try { expected = presetTeamModels(team, value, models); } catch { continue; }
    const same = (a: Record<string, any>, b: Record<string, any>) => a.model === b.model && a.thinking === b.thinking;
    if (!Object.entries(team.members ?? {}).filter(([name]) => name !== 'oracle').every(([name, member]) => same(member as Record<string, any>, expected.members[name]))) continue;
    if (team.supervisor && !same(team.supervisor, expected.supervisor)) continue;
    if (team.members?.oracle && (JSON.stringify(team.oracleModels) !== JSON.stringify(expected.oracleModels) || expected.oracleModels.some((id: string) => (team.oracleThinking?.[id] ?? team.oracleThinking?.[id.split(':')[0]]) !== expected.oracleThinking?.[id]))) continue;
    return { mode: 'default', preset: value };
  }
  return { mode: 'custom' };
}
