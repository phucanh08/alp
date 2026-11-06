import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { initProject } from '@anhlp/alp-core/init';
import { catalogModels, useLiveModels } from '@anhlp/alp-core/models';
import { fitEffort, modelEfforts, profileDefaults, profileFingerprint, projectProfiles } from '@anhlp/alp-core/profiles';
import { BUILTIN_TEAMS, resolveTeam, teamSources } from '@anhlp/alp-core/teams';
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

/**
 * Write Phở and Cafe's agent profiles into a project's .alp/settings.json, without installing software or calling models.
 * Only entries ALP wrote are rewritten: the template's defaults (templateDefaults) and setup's own earlier output
 * (its record in .alp/state/setup-profiles.json, or for a project without one, what setup writes with its default models). A profile
 * list the user wrote, or one a team override of Phở or Cafe pins in its team.json, is kept and named. Other teams are
 * left alone and named with the settings keys to edit: their team.json carries their author's model choices.
 */
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
    const seats = seatsFor(enabled, prefer, values);
    const peers = peersFor(enabled);

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
    // Which existing entries are ALP's to rewrite, and which are the user's (p-47ce54f6): decided before any prompt.
    const owners = await ownership(root, home, settings);
    const replaced = BUILTIN_TEAMS.filter(id => Object.keys(currentTeams(settings)?.[id] ?? {}).some(name => owners.rewrites(id, name)));
    if (replaced.length) console.log(`These replace the ${replaced.join(' and ')} profiles ALP or an earlier alp setup wrote; a backup is kept in ${file}.bak.`);
    for (const line of owners.kept) console.log(line);
    for (const line of owners.others) console.log(line);
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
    // Checked before anything is written: no scaffold, backup or partial file for settings that would not load.
    validateSettings(merge(settings ?? {}, await profiles(root, home, seats, peers, settings), owners).next, file);
    if (!settings) await initProject(root, { library: home });
    else if (replaced.length) await copyFile(file, `${file}.bak`);
    const written = settings ?? JSON.parse(await readFile(file, 'utf8'));
    const { next, record } = merge(written, await profiles(root, home, seats, peers, written), owners);
    validateSettings(next, file);
    await writeFile(file, JSON.stringify(next, null, 2) + '\n');
    await writeRecord(root, record, owners.newer);
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

/** Each seat's choices for the enabled providers: main on the preferred one, the others on each. */
function seatsFor(enabled, prefer, values = {}) {
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
  return seats;
}
/** A peer takes any model of an enabled provider: whoever assigns it picks the model and effort. */
const peersFor = enabled => enabled.map(provider => `${provider}:*`);
const currentTeams = settings => settings && ({ ...(settings.profile ?? {}), ...(settings.team ?? {}) });

/** Each agent's profile list for one team, by its role: main, supervisor and oracle by seat, a peer on any model, the others as workers. */
function teamProfiles(team, seats, peers) {
  const strings = choices => choices.map(choice => typeof choice === 'string' ? choice : describe(choice));
  /** @type {Record<string, string[]>} */
  const agents = {};
  for (const [name, member] of Object.entries(team.members)) {
    if (name !== 'oracle') agents[name] = strings(name === team.main ? seats.main : member.role === 'peer' ? peers : seats.worker);
  }
  if (team.supervisor) agents[team.supervisor.agent] = strings(seats.supervisor);
  if (team.members.oracle) agents.oracle = strings(seats.oracle);
  return agents;
}

/** Every Phở and Cafe agent's profiles, keeping each agent's own compaction setting and "/" commands (t-efa3). */
async function profiles(root, home, seats, peers, settings) {
  const profile = {};
  for (const id of BUILTIN_TEAMS) {
    const team = await resolveTeam(root, id, { library: home });
    const agents = {};
    for (const [name, list] of Object.entries(teamProfiles(team, seats, peers))) {
      const old = currentTeams(settings)?.[id]?.[name];
      agents[name] = { profiles: list, autocompact: old?.autocompact ?? 'auto', ...(old?.commands ? { commands: old.commands } : {}) };
    }
    profile[id] = agents;
  }
  return profile;
}

/**
 * Who owns each existing Phở and Cafe entry. setup rewrites an entry ALP wrote: one matching the template's
 * defaults (unless a team override pins that agent's model itself), setup's record of what it wrote, or (a
 * project set up before that record existed) what setup writes for some runtime with its default models.
 * Anything else is the user's, and the user's own configuration is authoritative (p-47ce54f6).
 */
/**
 * Fingerprints of the profiles alp setup last wrote, by team and agent. They live in project state, not in
 * settings.json: validateSettings refuses an unknown top-level key, so a settings key would make an older ALP
 * reject the file. The directory ignores itself in Git (this checkout's bookkeeping, not configuration). A record
 * that is missing, unreadable, malformed or of another version counts as empty: setup falls back to its known
 * defaults, and never refuses to run over it.
 */
const RECORD_VERSION = 1;
const recordFile = root => path.join(root, '.alp', 'state', 'setup-profiles.json');
async function readRecord(root) {
  let value;
  try { value = JSON.parse(await readFile(recordFile(root), 'utf8')); } catch { return { teams: {}, newer: false }; }
  // A newer ALP's record is left for it, unread and unwritten.
  if (Number.isSafeInteger(value?.version) && value.version > RECORD_VERSION) return { teams: {}, newer: true };
  const teams = value?.version === RECORD_VERSION && value.teams && typeof value.teams === 'object' && !Array.isArray(value.teams) ? value.teams : {};
  return { newer: false, teams: Object.fromEntries(Object.entries(teams).filter(([, agents]) => agents && typeof agents === 'object' && !Array.isArray(agents))
    .map(([id, agents]) => [id, Object.fromEntries(Object.entries(agents).filter(([, hash]) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)))])) };
}
/** Saves the record; settings are already saved, so a failure here is reported, not thrown. */
async function writeRecord(root, teams, newer) {
  if (newer) return;
  const directory = path.dirname(recordFile(root));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, '.gitignore'), '*\n', { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await writeFile(recordFile(root), JSON.stringify({ version: RECORD_VERSION, teams }, null, 2) + '\n');
  } catch (error) {
    console.log(`Could not save ${recordFile(root)} (${error.message}); the next alp setup recognizes these profiles by setup's defaults instead.`);
  }
}

async function ownership(root, home, existing) {
  const { teams: record, newer } = await readRecord(root);
  // A project without settings is judged as alp init is about to write it, so a team override's pinned model counts there too.
  const initial = existing ? undefined : await projectProfiles({ root, library: home });
  const settings = existing ?? { team: initial, templateDefaults: profileDefaults(initial) };
  const teams = currentTeams(settings) ?? {};
  const file = path.join(root, '.alp/settings.json');
  /** @type {Record<string, Record<string, string[]>>} */
  const legacy = {};
  /** @type {Record<string, Record<string, string>>} */
  const pinned = {};
  for (const id of BUILTIN_TEAMS) {
    const team = await resolveTeam(root, id, { library: home });
    const builtin = await resolveTeam(undefined, id, { library: '' });
    legacy[id] = {};
    for (const runtime of [...PROVIDERS, 'mix']) {
      for (const prefer of runtime === 'mix' ? PROVIDERS : [runtime]) {
        const enabled = runtime === 'mix' ? [prefer, ...PROVIDERS.filter(provider => provider !== prefer)] : [runtime];
        for (const [name, list] of Object.entries(teamProfiles(team, seatsFor(enabled, prefer), peersFor(enabled)))) {
          (legacy[id][name] ??= []).push(profileFingerprint({ profiles: list }, name));
        }
      }
    }
    // A library or project override of Phở or Cafe that names a member's model itself made that choice on purpose.
    pinned[id] = {};
    if (team.source !== 'builtin') {
      for (const [name, member] of Object.entries(team.members)) {
        if (name !== 'oracle' && member.model && member.model !== builtin.members[name]?.model) pinned[id][name] = member.model;
      }
      if (team.supervisor && team.supervisor.model && team.supervisor.model !== (builtin.supervisor && builtin.supervisor.agent === team.supervisor.agent ? builtin.supervisor.model : undefined)) pinned[id][team.supervisor.agent] = team.supervisor.model;
      if (team.members.oracle && team.oracleModels && JSON.stringify(team.oracleModels) !== JSON.stringify(builtin.oracleModels)) pinned[id].oracle = team.oracleModels.join(', ');
    }
  }
  const rewrites = (id, name) => {
    const config = teams[id]?.[name];
    if (!config) return true;
    const fingerprint = profileFingerprint(config, name);
    if (record[id]?.[name] === fingerprint || legacy[id]?.[name]?.includes(fingerprint)) return true;
    return settings?.templateDefaults?.[id]?.[name] === fingerprint && !pinned[id]?.[name];
  };
  const kept = [];
  for (const id of BUILTIN_TEAMS) {
    for (const [name, config] of Object.entries(teams[id] ?? {})) {
      if (rewrites(id, name)) continue;
      const list = (config.profiles ?? []).map(profile => typeof profile === 'string' ? profile : describe(profile)).join(', ');
      kept.push(pinned[id]?.[name] && settings?.templateDefaults?.[id]?.[name] === profileFingerprint(config, name)
        ? `Kept team.${id}.${name}.profiles (${list}): the ${id} team's team.json names its model (${pinned[id][name]}). Delete the entry from the file and run alp setup again to replace it.`
        : `Kept team.${id}.${name}.profiles (${list}): written by hand, not by ALP. Delete the entry from the file and run alp setup again to replace it.`);
    }
  }
  const others = [];
  for (const [id, found] of await teamSources(root, { library: home })) {
    if (BUILTIN_TEAMS.includes(id)) continue;
    const team = await resolveTeam(root, id, { library: home }).catch(() => undefined);
    const agents = team ? [...Object.keys(team.members).filter(name => name !== 'oracle'), ...(team.supervisor ? [team.supervisor.agent] : []), ...(team.members.oracle ? ['oracle'] : [])] : [];
    others.push(`Team ${id} (${found.source}) is not Phở or Cafe, so alp setup leaves its profiles as they are: its team.json chooses its models. To change them, edit team.${id}.<agent>.profiles in ${file}${agents.length ? ` (agents: ${agents.join(', ')})` : ''}.`);
  }
  return { rewrites, kept, others, record, newer };
}

/** The settings with setup's profiles where setup may write them and every other entry kept, and the record of what setup wrote. */
function merge(written, profile, owners) {
  const next = { ...written, team: currentTeams(written) };
  delete next.profile;
  const record = structuredClone(owners.record);
  for (const [id, agents] of Object.entries(profile)) {
    const team = { ...(next.team[id] ?? {}) };
    for (const [name, config] of Object.entries(agents)) {
      if (!owners.rewrites(id, name)) { if (record[id]) delete record[id][name]; continue; }
      team[name] = config;
      (record[id] ??= {})[name] = profileFingerprint(config, name);
    }
    next.team[id] = team;
    if (record[id] && !Object.keys(record[id]).length) delete record[id];
  }
  return { next, record };
}

/** A model for one provider: a native ID, or one prefixed with that provider. */
function nativeModel(id, provider, where) {
  const model = id.startsWith(`${provider}:`) ? id.slice(provider.length + 1) : id;
  if (!model || /\s/.test(model) || /^(codex|claude):/.test(model) || (model.includes(':') && !id.startsWith(`${provider}:`))) throw new Error(`${where} expects a ${provider} model, got '${id}'`);
  return model;
}
