import { Fragment, useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useRpc } from '@getpaseo/plugin/client';
import { SettingsInput, SettingsRow, SettingsSection, SettingsSelect } from '@getpaseo/plugin/client/ui';
import type { PluginTheme } from '@getpaseo/plugin';
import { libraryModels } from '../shared/library';
import { MODEL_PRESETS, modelSetupFor, presetTeamModels, type ModelChoice } from '../shared/team-models';
import { Button } from './side-nav';

type Team = Record<string, any>;
const clone = (team: Team): Team => JSON.parse(JSON.stringify(team));
/** Changes live in the template draft and are saved with the editor's Save action. */
export function TeamModelSettings({ team, theme, onChange }: { team: Team; theme?: PluginTheme; onChange(team: Team): void }) {
  const readModels = useRpc(libraryModels);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [error, setError] = useState('');
  const [customFields, setCustomFields] = useState<Record<string, boolean>>({});
  const setup = modelSetupFor(team, models);
  const mode = setup.mode;
  const preset = setup.preset ?? 'mix';
  useEffect(() => {
    let live = true;
    readModels({}).then(result => { if (live) { setModels(result.models); setError(''); } }).catch(cause => { if (live) setError(String(cause.message ?? cause)); });
    return () => { live = false; };
  }, [readModels]);
  const edit = (work: (next: Team) => void) => { const next = clone(team); next.modelSetup = { mode: 'custom' }; work(next); onChange(next); setError(''); };
  const selectPreset = (value: string) => {
    try { onChange(presetTeamModels(team, value, models)); setCustomFields({}); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const chooseModel = (label: string, value: string, set: (next: Team, id: string, effort?: string) => void) => {
    const known = models.find(model => model.id === value);
    const options = [...(label.startsWith('oracle-') ? [] : [{ label: 'Inherit', value: '' }]), ...models.map(model => ({ value: model.id, label: model.label }))];
    if (value && !known) options.push({ label: value, value });
    options.push({ label: 'Custom model ID', value: '__custom' });
    return <>
      <SettingsSelect label="Model" value={customFields[label] ? '__custom' : value} options={options} onValueChange={id => {
        setCustomFields(previous => ({ ...previous, [label]: id === '__custom' }));
        if (id !== '__custom') edit(next => set(next, id, models.find(model => model.id === id)?.effort));
      }} />
      {customFields[label] || (value && !known) ? <SettingsInput key={`${label}-custom`} label="Custom model ID" hint="claude:model, codex:model, antigravity:model or acp:provider/model" initialValue={value} onChangeText={id => edit(next => set(next, id.trim()))} /> : null}
    </>;
  };
  const effort = (model: string, value: string, set: (next: Team, effort: string) => void) => {
    const known = models.find(choice => choice.id === model);
    const values = known ? known.efforts : ['none', 'off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'ultracode'];
    const options = [{ label: 'Inherit', value: '' }, ...[...new Set([...values, ...(value ? [value] : [])])].map(value => ({ label: value, value }))];
    return <SettingsSelect label="Effort" value={value} options={options} onValueChange={value => edit(next => set(next, value))} />;
  };
  const assign = (target: Team, id: string, thinking?: string) => {
    if (id) target.model = id; else delete target.model;
    if (thinking) target.thinking = thinking; else delete target.thinking;
  };
  const setEffort = (target: Team, value: string) => { if (value) target.thinking = value; else delete target.thinking; };
  const lenses: string[] = team.oracleModels ?? ['claude:claude-fable-5-1', 'codex:gpt-6-astra'];
  return <>
    <SettingsSection title="Model setup">
      <SettingsSelect label="Mode" value={mode} options={[{ label: 'Default presets', value: 'default' }, { label: 'Custom', value: 'custom' }]} onValueChange={value => value === 'default' ? selectPreset(preset) : edit(() => {})} />
      {mode === 'default' ? <SettingsSelect label="Preset" value={preset} options={MODEL_PRESETS} onValueChange={selectPreset} /> : null}
      <SettingsRow label="Save with template" hint="Save writes these model choices into settings.json for this team immediately. Project template overrides still apply to Host templates." />
      {error ? <Text accessibilityRole="alert" style={{ color: theme?.colors.statusDanger }}>{error}</Text> : null}
    </SettingsSection>
    {mode === 'default' ? <SettingsSection title="Preset models">
      {Object.entries(team.members ?? {}).filter(([name]) => name !== 'oracle').map(([name, member]) => <SettingsRow key={name} label={name} hint={(member as Team).model} />)}
      {team.supervisor ? <SettingsRow label="Supervisor" hint={team.supervisor.model} /> : null}
      {team.members?.oracle ? <SettingsRow label="Oracle" hint={lenses.join(', ')} /> : null}
    </SettingsSection> : <Fragment key="custom-models">
      {Object.entries(team.members ?? {}).filter(([name]) => name !== 'oracle').map(([name, member]) => {
        const config = member as Team;
        return <SettingsSection key={name} title={name === team.main ? `${name} · main` : name}>
          {chooseModel(name, config.model ?? '', (next, id, effort) => assign(next.members[name], id, effort))}
          {effort(config.model ?? team.members[team.main]?.model ?? '', config.thinking ?? '', (next, value) => setEffort(next.members[name], value))}
        </SettingsSection>;
      })}
      {team.supervisor ? <SettingsSection title="Supervisor">
        {chooseModel('supervisor', team.supervisor.model ?? '', (next, id, effort) => assign(next.supervisor, id, effort))}
        {effort(team.supervisor.model ?? '', team.supervisor.thinking ?? '', (next, value) => setEffort(next.supervisor, value))}
      </SettingsSection> : null}
      {team.members?.oracle ? <>
        {lenses.map((id, index) => <SettingsSection key={index} title={`Oracle ${index + 1}`}>
          {chooseModel(`oracle-${index}`, id, (next, value, effort) => { next.oracleModels = [...lenses]; next.oracleModels[index] = value; next.oracleThinking ??= {}; delete next.oracleThinking[id]; if (effort) next.oracleThinking[value] = effort; })}
          {effort(id, team.oracleThinking?.[id] ?? team.oracleThinking?.[id.split(':')[0]] ?? '', (next, value) => { next.oracleThinking ??= {}; delete next.oracleThinking[id.split(':')[0]]; if (value) next.oracleThinking[id] = value; else delete next.oracleThinking[id]; })}
          {theme && lenses.length > 1 ? <Button theme={theme} label="Remove model" onPress={() => edit(next => { next.oracleModels = lenses.filter((_, i) => i !== index); })} /> : null}
        </SettingsSection>)}
        {theme ? <Button theme={theme} label="Add oracle model" onPress={() => edit(next => { next.oracleModels = [...lenses, ''];
          setCustomFields(previous => ({ ...previous, [`oracle-${lenses.length}`]: true })); })} /> : null}
      </> : null}
    </Fragment>}
    {JSON.stringify(team).includes('antigravity:') ? <SettingsSection title="Antigravity"><SettingsRow label="Advisory roles" hint={'agy enforces read-only, workspace-write and full-access itself; a tool the mode does not allow is denied. Review copies and custom permission rules are unsupported.'} /></SettingsSection> : null}
  </>;
}
