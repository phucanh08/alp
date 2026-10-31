import { copyFile, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { initProject } from '@anhlp/alp-core/init';
import { catalogModels, useLiveModels } from '@anhlp/alp-core/models';
import { fitEffort, modelEfforts } from '@anhlp/alp-core/profiles';
import { resolveTeam } from '@anhlp/alp-core/teams';
import { validateSettings } from '@anhlp/alp-core/validation';
import { Cancelled, select, text } from './prompt.js';

const PROVIDERS = ['claude', 'codex'];
const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex' };
/** Each seat's model and effort per provider. Main runs on the preferred provider's only; peers may run on any model of an enabled provider. */
const DEFAULTS = {
  main: { claude: ['claude-opus-5-5', 'high'], codex: ['gpt-6.1-sol', 'high'] },
  worker: { claude: ['claude-opus-5-5', 'high'], codex: ['gpt-6.1-sol', 'high'] },
  supervisor: { claude: ['claude-sonnet-5', 'medium'], codex: ['gpt-6-luna', 'medium'] },
  oracle: { claude: ['claude-fable-5-1', 'high'], codex: ['gpt-6-astra', 'high'] },
};
const FLAGS = { main: 'model', worker: 'model', supervisor: 'supervisor', oracle: 'oracle' };
const SEAT_LABEL = { main: 'main', worker: 'lead, reviewer', supervisor: 'supervisor', oracle: 'oracle' };
const ANY_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Write Phở and Cafe's agent profiles into a project's .alp/settings.json, without installing software or calling models. */
export async function setup(args, home) {
  // Effort fitting reads alpd's cached live catalog when there is one (t-086c); no provider is asked.
  useLiveModels(catalogModels(home));
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: Object.fromEntries(
    ['runtime', 'prefer', ...PROVIDERS.flatMap(provider => Object.values(FLAGS).map(flag => `${provider}-${flag}`))].map(name => [name, { type: 'string' }]),
  ) });
  if (positionals.length > 1) throw new Error('setup takes at most one directory');
  const root = path.resolve(positionals[0] ?? process.cwd());
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  try {
    const runtime = values.runtime ?? (interactive ? await select({ message: 'Runtime', initial: 'mix', choices: [
      { label: 'Mix', value: 'mix', hint: 'Claude and Codex: main runs on one, the others can run on either' },
      { label: 'Codex only', value: 'codex' },
      { label: 'Claude only', value: 'claude' },
    ] }) : undefined);
    if (runtime === undefined) throw new Error('Pass --runtime codex, claude or mix when setup is not running in a terminal');
    if (!['codex', 'claude', 'mix'].includes(runtime)) throw new Error('--runtime must be codex, claude or mix');
    const prefer = values.prefer ?? (runtime !== 'mix' ? runtime : interactive ? await select({ message: 'Main runs on', initial: 'claude', choices: [
      { label: 'Claude', value: 'claude', hint: 'Claude first for the others too' },
      { label: 'Codex', value: 'codex', hint: 'Codex first for the others too' },
    ] }) : 'claude');
    if (!PROVIDERS.includes(prefer) || (runtime !== 'mix' && prefer !== runtime)) throw new Error('--prefer must be an enabled runtime');
    // The preferred provider comes first: it is each agent's default, the other one a choice.
    const enabled = runtime === 'mix' ? [prefer, ...PROVIDERS.filter(provider => provider !== prefer)] : [runtime];
    for (const provider of PROVIDERS) {
      for (const flag of Object.values(FLAGS)) {
        if (!enabled.includes(provider) && values[`${provider}-${flag}`]) throw new Error(`--${provider}-${flag} is unavailable in ${runtime}-only mode`);
      }
    }
    /** @type {Record<string, Array<{ provider: string, model: string, effort?: string }>>} */
    const seats = {};
    for (const [seat, flag] of Object.entries(FLAGS)) {
      seats[seat] = (seat === 'main' ? [prefer] : enabled).map(provider => {
        const option = `${provider}-${flag}`;
        const [fallback, effort] = DEFAULTS[seat][provider];
        const model = nativeModel(values[option] ?? fallback, provider, `--${option}`);
        return { provider, model, effort: fitEffort(`${provider}:${model}`, effort) };
      });
    }
    const peers = enabled.map(provider => `${provider}:*`);

    const file = path.join(root, '.alp/settings.json');
    const settings = await readFile(file, 'utf8').then(content => {
      try { return JSON.parse(content); } catch (error) { throw new Error(`${file} is not valid JSON: ${error.message}`); }
    }, error => {
      if (error.code === 'ENOENT') return undefined;
      throw new Error(`${file}: ${error.message}`);
    });
    const show = () => {
      for (const [seat, choices] of Object.entries(seats)) console.log(`  ${SEAT_LABEL[seat]}: ${choices.map(describe).join(', ')}`);
      console.log(`  peer: ${peers.join(', ')} (any model: whoever assigns a peer picks its model and effort for the task)`);
    };
    console.log(`Profiles for Phở and Cafe in ${file}:`);
    show();
    const replaced = ['pho', 'cafe'].filter(id => (settings?.team ?? settings?.profile)?.[id]);
    if (replaced.length) console.log(`These replace the ${replaced.join(' and ')} profiles already in the file; a backup is kept in ${file}.bak.`);
    if (interactive) {
      for (;;) {
        const next = await select({ message: 'Save these profiles?', initial: 'save', choices: [
          { label: 'Save', value: 'save' },
          { label: 'Change a model', value: 'change' },
          { label: 'Cancel', value: 'cancel' },
        ] });
        if (next === 'cancel') throw new Cancelled();
        if (next === 'save') break;
        await change(seats, home);
        show();
      }
    }
    const profile = await profiles(root, home, seats, peers, settings);
    validateSettings({ ...(settings ?? {}), team: { ...(settings?.profile ?? {}), ...(settings?.team ?? {}), ...profile } }, file);
    if (!settings) await initProject(root, { library: home });
    else if (replaced.length) await copyFile(file, `${file}.bak`);
    const written = settings ?? JSON.parse(await readFile(file, 'utf8'));
    const next = { ...written, team: { ...(written.profile ?? {}), ...(written.team ?? {}), ...profile } };
    delete next.profile;
    await writeFile(file, JSON.stringify(next, null, 2) + '\n');
    console.log('Setup saved. New sessions in this project use these profiles; edit the file to change one agent. Run alp doctor to check that each CLI is installed and logged in.');
  } catch (error) {
    if (!(error instanceof Cancelled)) throw error;
    console.log(error.message);
  }
}

const describe = choice => `${choice.provider}:${choice.model}${choice.effort ? `:${choice.effort}` : ''}`;

/** Pick one seat and provider, then its model and effort. */
async function change(seats, home) {
  // alpd's live catalog (t-e5ee) when it has one, else the static rows.
  const catalog = catalogModels(home);
  const [seat, at] = await select({ message: 'Which model?', choices: Object.entries(seats).flatMap(([seat, choices]) =>
    choices.map((choice, at) => ({ label: `${SEAT_LABEL[seat]} · ${PROVIDER_LABEL[choice.provider]}`, value: [seat, at], hint: describe(choice) }))) });
  const current = seats[seat][at];
  const offered = catalog.filter(model => model.runtime === current.provider);
  const picked = await select({ message: `${SEAT_LABEL[seat]} on ${PROVIDER_LABEL[current.provider]}`, initial: current.model, choices: [
    ...offered.map(model => ({ label: model.label, value: model.id, hint: `${model.id} · ${model.description}` })),
    { label: 'Other…', value: undefined, hint: 'type a model ID' },
  ] });
  const model = picked ?? nativeModel(await text(`${PROVIDER_LABEL[current.provider]} model ID:`), current.provider, 'The model ID');
  const efforts = catalog.find(entry => entry.runtime === current.provider && entry.id === model)?.efforts ?? modelEfforts(`${current.provider}:${model}`) ?? ANY_EFFORT;
  const effort = efforts.length > 1 ? await select({ message: 'Effort', initial: efforts.includes(current.effort) ? current.effort : DEFAULTS[seat][current.provider][1],
    choices: efforts.map(effort => ({ label: effort, value: effort })) }) : efforts[0];
  seats[seat][at] = { provider: current.provider, model, ...(effort ? { effort } : {}) };
}

/** Every Phở and Cafe agent's profiles, keeping each agent's own compaction setting and "/" commands (t-efa3). */
async function profiles(root, home, seats, peers, settings) {
  const profile = {};
  for (const id of ['pho', 'cafe']) {
    const team = await resolveTeam(root, id, { library: home });
    const agents = {};
    const seat = (name, choices) => {
      const old = (settings?.team ?? settings?.profile)?.[id]?.[name];
      agents[name] = { profiles: choices.map(choice => typeof choice === 'string' ? choice : describe(choice)), autocompact: old?.autocompact ?? 'auto', ...(old?.commands ? { commands: old.commands } : {}) };
    };
    for (const [name, member] of Object.entries(team.members)) {
      if (name !== 'oracle') seat(name, name === team.main ? seats.main : member.role === 'peer' ? peers : seats.worker);
    }
    if (team.supervisor) seat(team.supervisor.agent, seats.supervisor);
    if (team.members.oracle) seat('oracle', seats.oracle);
    profile[id] = agents;
  }
  return profile;
}

/** A model for one provider: a native ID, or one prefixed with that provider. */
function nativeModel(id, provider, where) {
  const model = id.startsWith(`${provider}:`) ? id.slice(provider.length + 1) : id;
  if (!model || /\s/.test(model) || /^(codex|claude):/.test(model) || (model.includes(':') && !id.startsWith(`${provider}:`))) throw new Error(`${where} expects a ${provider} model, got '${id}'`);
  return model;
}
