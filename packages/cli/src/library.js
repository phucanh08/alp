import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { seedLibrary } from '@anhlp/alp-core/library';
import { libraryEntries } from '@anhlp/alp-core/resolver';
import { listTeams, resolveTeam } from '@anhlp/alp-core/teams';
import { deleteEntry, duplicateEntry, getEntry, renameEntry, saveEntry } from '@anhlp/alp-core/library-edit';
import { testEntry } from '@anhlp/alp-client/library-test';
import { alpHome } from '@anhlp/alp-client/index';
import { UsageError } from './usage.js';
import { taskProject } from './tasks.js';

async function libraryCommand(kind, args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  if (kind === 'providers') await seedLibrary(alpHome());
  // Outside a project only the built-ins and the library apply.
  const root = path.resolve(values.project ?? process.cwd());
  const rows = await libraryEntries(kind, root, { library: alpHome() });
  if (values.json) { console.log(JSON.stringify(rows)); return; }
  if (!rows.length) { console.log(kind === 'providers' ? `No providers in ${path.join(alpHome(), kind)}; add an ACP agent with alp provider add` : `No ${kind} in ${path.join(alpHome(), kind)} or ${path.join(root, '.alp', kind)}`); return; }
  const width = Math.max(...rows.map(row => row.name.length));
  for (const row of rows) {
    const where = row.source === 'builtin' ? 'built-in' : row.source;
    const notes = [
      row.overrides ? `overrides the ${row.overrides === 'builtin' ? 'built-in' : row.overrides} one` : '',
      row.usedBy ? `used by ${row.usedBy.join(', ')}` : '',
      row.description ?? '',
    ].filter(Boolean);
    console.log(`${row.name.padEnd(width)}  ${where.padEnd(8)}${notes.length ? `  ${notes.join('; ')}` : ''}`);
  }
}

/** `--project` may stand alone, meaning the current directory. */

function projectFlag(args) {
  const result = [...args];
  for (let i = 0; i < result.length; i++) if (result[i] === '--project' && (i + 1 === result.length || result[i + 1].startsWith('-'))) result.splice(i + 1, 0, '.');
  return result;
}

const pairs = (list, what) => Object.fromEntries((list ?? []).map(item => {
  const at = item.indexOf('=');
  if (at <= 0) throw new Error(`${what} takes name=value, not '${item}'`);
  return [item.slice(0, at), item.slice(at + 1)];
}));

const names = text => text === undefined ? undefined : text.split(',').map(name => name.trim()).filter(Boolean);

const EDIT_OPTIONS = {
  project: { type: 'string' }, json: { type: 'boolean' }, from: { type: 'string' }, description: { type: 'string', short: 'd' },
  // agent
  provider: { type: 'string' }, model: { type: 'string' }, thinking: { type: 'string' }, mode: { type: 'string' },
  skills: { type: 'string' }, mcp: { type: 'string' }, hooks: { type: 'string' }, instructions: { type: 'string' },
  // team
  label: { type: 'string' }, main: { type: 'string' }, member: { type: 'string', multiple: true }, 'member-model': { type: 'string', multiple: true },
  'member-thinking': { type: 'string', multiple: true }, delegate: { type: 'string', multiple: true }, 'max-peers': { type: 'string' },
  supervisor: { type: 'string' }, 'supervisor-model': { type: 'string' }, 'supervisor-thinking': { type: 'string' }, 'no-supervisor': { type: 'boolean' }, rules: { type: 'string' },
  // skill, mcp, hook
  file: { type: 'string' }, command: { type: 'string' }, arg: { type: 'string', multiple: true }, env: { type: 'string', multiple: true }, cwd: { type: 'string' },
  url: { type: 'string' }, header: { type: 'string', multiple: true }, event: { type: 'string' }, blocking: { type: 'boolean' }, timeout: { type: 'string' },
  'match-agent': { type: 'string' }, 'match-label': { type: 'string' },
  // provider
  kind: { type: 'string' },
  'read-only-mode': { type: 'string' },
  models: { type: 'string' },
};

/** The content of an entry after a CLI new or edit: the current content with the options applied. */

async function edited(kind, name, current, values) {
  const content = structuredClone(current ?? {});
  const set = (target, key, value) => { if (value !== undefined) { if (value === '') delete target[key]; else target[key] = value; } };
  if (kind === 'agents') {
    if (values.instructions !== undefined) content.instructions = await readFile(values.instructions, 'utf8');
    content.instructions ??= `# ${name}\n\nDescribe what this agent does, and how.\n`;
    const config = content.config ?? {};
    set(config, 'description', values.description);
    for (const key of ['provider', 'model', 'thinking', 'mode']) set(config, key, values[key]);
    for (const key of ['skills', 'mcp', 'hooks']) { const list = names(values[key]); if (list) { if (list.length) config[key] = list; else delete config[key]; } }
    content.config = config;
  } else if (kind === 'teams') {
    const team = content.team ?? { label: name, main: 'main', members: { main: {} }, delegation: {} };
    set(team, 'label', values.label);
    set(team, 'description', values.description);
    if (values.main !== undefined && values.main !== team.main) {
      // The old main leaves the team with its place in the graph.
      delete team.members[team.main];
      delete team.delegation[team.main];
      team.main = values.main;
      team.members[values.main] = { ...(team.members[values.main] ?? {}) };
      delete team.members[values.main].role;
    }
    if (values.member?.length) {
      const roles = pairs(values.member, '--member');
      team.members = { [team.main]: team.members[team.main] ?? {}, ...Object.fromEntries(Object.entries(roles).filter(([member]) => member !== team.main).map(([member, role]) => [member, { ...(team.members[member] ?? {}), role }])) };
    }
    for (const [option, key] of [['member-model', 'model'], ['member-thinking', 'thinking']]) {
      for (const [member, value] of Object.entries(pairs(values[option], `--${option}`))) {
        if (!team.members[member]) throw new Error(`--${option}: ${member} is not a member of ${name}`);
        set(team.members[member], key, value);
      }
    }
    if (values.delegate?.length) team.delegation = Object.fromEntries(Object.entries(pairs(values.delegate, '--delegate')).map(([owner, targets]) => [owner, names(targets)]));
    if (values['max-peers'] !== undefined) { if (values['max-peers'] === '') delete team.maxPeers; else team.maxPeers = Number(values['max-peers']); }
    if (values['no-supervisor']) team.supervisor = false;
    else if (values.supervisor !== undefined || values['supervisor-model'] !== undefined || values['supervisor-thinking'] !== undefined) {
      const watcher = team.supervisor || { agent: 'supervisor' };
      set(watcher, 'agent', values.supervisor);
      set(watcher, 'model', values['supervisor-model']);
      set(watcher, 'thinking', values['supervisor-thinking']);
      team.supervisor = watcher;
    }
    content.team = team;
    if (values.rules !== undefined) content.houseRules = await readFile(values.rules, 'utf8');
  } else if (kind === 'skills') {
    if (values.file !== undefined) content.body = await readFile(values.file, 'utf8');
    content.body ??= `---\nname: ${name}\ndescription: When to use this skill.\n---\n\n# ${name}\n\nSteps and checks.\n`;
  } else if (kind === 'mcp') {
    if (values.command !== undefined || values.url !== undefined) content.server = {};
    const server = content.server ?? {};
    set(server, 'command', values.command);
    if (values.arg?.length) server.args = values.arg;
    if (values.env?.length) server.env = pairs(values.env, '--env');
    set(server, 'cwd', values.cwd);
    set(server, 'url', values.url);
    if (values.header?.length) server.headers = pairs(values.header, '--header');
    content.server = server;
  } else if (kind === 'hooks') {
    const hook = content.hook ?? {};
    set(hook, 'description', values.description);
    set(hook, 'event', values.event);
    set(hook, 'command', values.command);
    if (values.blocking !== undefined) hook.blocking = values.blocking;
    if (values.timeout !== undefined) hook.timeoutSec = Number(values.timeout);
    if (values['match-agent'] !== undefined || values['match-label'] !== undefined) {
      const match = hook.match ?? {};
      set(match, 'agent', values['match-agent']);
      set(match, 'label', values['match-label']);
      if (Object.keys(match).length) hook.match = match; else delete hook.match;
    }
    content.hook = hook;
  } else if (kind === 'providers') {
    const isAntigravity = name === 'antigravity' || values.kind === 'antigravity';
    const provider = content.provider ?? { kind: isAntigravity ? 'antigravity' : 'acp' };
    if (values.kind !== undefined) provider.kind = values.kind;
    if (isAntigravity) {
      if (provider.command === undefined && values.command === undefined) provider.command = 'agy';
      if (provider.label === undefined && values.label === undefined) provider.label = 'Antigravity';
    }
    set(provider, 'label', values.label);
    set(provider, 'description', values.description);
    set(provider, 'command', values.command);
    set(provider, 'readOnlyMode', values['read-only-mode']);
    if (values.arg?.length) provider.args = values.arg;
    if (values.env?.length) provider.env = pairs(values.env, '--env');
    const models = names(values.models);
    if (models) { if (models.length) provider.models = models.map(id => provider.models?.find(model => model.id === id) ?? { id }); else delete provider.models; }
    content.provider = provider;
  }
  return content;
}

/** alp agent|team|skill|mcp|hook: create, change, copy, rename, remove and test library entries. */

async function editCommand(kind, args) {
  const { values, positionals } = parseArgs({ args: projectFlag(args), allowPositionals: true, options: EDIT_OPTIONS });
  const [action, name, target] = positionals;
  if (kind === 'providers' && action !== 'add') await seedLibrary(alpHome());
  const creates = { agents: 'new', teams: 'new', skills: 'new', mcp: 'add', hooks: 'add', providers: 'add' }[kind];
  if (!name || positionals.length > (['cp', 'mv'].includes(action) ? 3 : 2) || (['cp', 'mv'].includes(action) && !target)) throw new UsageError();
  const scope = values.project !== undefined ? 'project' : 'library';
  let root = values.project !== undefined ? path.resolve(values.project) : undefined;
  if (scope === 'project') await taskProject(root);
  // A library edit still sees the current project, for what it uses.
  root ??= await access(path.join(process.cwd(), '.alp')).then(() => process.cwd(), () => undefined);
  const options = { scope, root, library: alpHome() };
  const done = (result, line) => console.log(values.json ? JSON.stringify(result) : line);
  const where = scope === 'project' ? `the project ${root}` : `your library ${alpHome()}`;
  if (action === 'show') {
    const entry = await getEntry(kind, name, { root, library: alpHome(), ...(values.project !== undefined ? { scope } : {}) });
    if (values.json) { console.log(JSON.stringify(entry)); return; }
    console.log(`${name}  ${entry.source === 'builtin' ? 'built-in' : entry.source}${entry.overrides ? `, overrides the ${entry.overrides === 'builtin' ? 'built-in' : entry.overrides} one` : ''}${entry.usedBy.length ? `; used by ${entry.usedBy.join(', ')}` : ''}`);
    for (const [key, value] of Object.entries(entry.content)) console.log(`--- ${key}\n${typeof value === 'string' ? value.trimEnd() : JSON.stringify(value, null, 2)}`);
    return;
  }
  if (action === 'rm') { const result = await deleteEntry(kind, name, options); done(result, `Removed ${name} from ${where}${result.now ? `; the ${result.now === 'builtin' ? 'built-in' : result.now} one applies again` : ''}.`); return; }
  if (action === 'mv') { done(await renameEntry(kind, name, target, options), `Renamed ${name} to ${target} in ${where}.`); return; }
  if (action === 'cp') { done(await duplicateEntry(kind, name, target, options), `Copied ${name} to ${target} in ${where}.`); return; }
  if (action === 'test') {
    if (!['mcp', 'hooks', 'providers'].includes(kind)) throw new UsageError();
    const result = await testEntry(kind, name, { root, library: alpHome(), ...(values.project !== undefined ? { scope } : {}) });
    if (values.json) console.log(JSON.stringify(result));
    else if (kind === 'providers') {
      if (result.agent?.name === 'antigravity') {
        console.log(`${name}: ${result.agent?.title ?? 'Antigravity'} ${result.agent?.version ?? ''} (models: ${result.models?.length ?? 0}, mode: ${result.currentMode ?? 'full-access'})`);
      } else {
        console.log(`${name}: ${result.agent?.title ?? result.agent?.name ?? 'agent'} ${result.agent?.version ?? ''} speaks ACP ${result.protocolVersion}; ${result.loadSession ? 'resumes sessions' : 'cannot resume sessions'}${result.mcpHttp ? '; takes HTTP MCP servers' : ''}${result.authMethods?.length ? `; signs in with ${result.authMethods.join(', ')}` : ''}`);
      }
    }
    else if (kind === 'mcp') console.log(`${name}: ${result.server?.name ?? 'server'} ${result.server?.version ?? ''} offers ${result.tools.length} tools${result.tools.length ? `:\n${result.tools.map(tool => `  ${tool.name}${tool.description ? `  ${tool.description.split('\n')[0]}` : ''}`).join('\n')}` : ''}`);
    else console.log(`${name}: ${result.timedOut ? 'timed out' : `exit ${result.exitCode ?? result.signal}`} in ${result.durationMs} ms${result.wouldBlock ? '; as a blocking hook it would refuse the action' : ''}${result.stdout.trim() ? `\nstdout: ${result.stdout.trim()}` : ''}${result.stderr.trim() ? `\nstderr: ${result.stderr.trim()}` : ''}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action !== creates && action !== 'edit') throw new UsageError();
  let current;
  let revision = null;
  if (action === creates) {
    if (values.from !== undefined) current = (await getEntry(kind, values.from, { root, library: alpHome() })).content;
  } else {
    // Editing an entry that only a lower layer has makes this scope's copy of it.
    const entry = await getEntry(kind, name, { root, library: alpHome() }).catch(error => { if (error.code === 'NOT_FOUND') throw new Error(`No ${kind} entry '${name}'; create it with alp ${kind.replace(/s$/, '')} ${creates}`); throw error; });
    const own = await getEntry(kind, name, { root, library: alpHome(), scope }).catch(() => undefined);
    current = (own ?? entry).content;
    revision = own ? own.revision : null;
  }
  const result = await saveEntry(kind, name, await edited(kind, name, current, values), { ...options, revision });
  done(result, `${action === 'edit' ? 'Saved' : 'Created'} ${name} in ${where}.`);
}

/** alp trust: the workspaces whose hooks run without asking (ALPD §45). */

async function teamsCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const root = path.resolve(values.project ?? process.cwd());
  const options = { library: alpHome() };
  const rows = [];
  for (const row of await listTeams(root, options)) rows.push(row.error ? row : { ...row, team: await resolveTeam(root, row.id, options) });
  if (values.json) { console.log(JSON.stringify(rows.map(({ team, ...row }) => ({ ...row, ...(team ? { main: team.main, members: team.members, delegation: team.delegation, maxPeers: team.maxPeers, supervisor: team.supervisor } : {}) })))); return; }
  for (const { team, ...row } of rows) {
    const where = row.source === 'builtin' ? 'built-in' : row.source;
    console.log(`${row.id}  ${row.label ?? ''}  ${where}${row.overrides ? `, overrides the ${row.overrides === 'builtin' ? 'built-in' : row.overrides} one` : ''}`);
    if (row.error) { console.log(`  error: ${row.error}`); continue; }
    const member = (name, { role, model, thinking }) => `${name}${role ? ` (${role})` : ' (main)'}${model ? ` on ${model}${thinking ? `, ${thinking}` : ''}` : ''}`;
    console.log(`  members: ${Object.entries(team.members).map(([name, value]) => member(name, value)).join(', ')}`);
    console.log(`  delegation: ${Object.entries(team.delegation).map(([owner, targets]) => `${owner} → ${targets.join(', ')}`).join('; ') || 'none'}`);
    console.log(`  supervisor: ${team.supervisor ? member(team.supervisor.agent, { role: 'watches main', model: team.supervisor.model, thinking: team.supervisor.thinking }) : 'none'}${team.maxPeers ? `; at most ${team.maxPeers} peers` : ''}`);
  }
}

export { libraryCommand, projectFlag, pairs, names, EDIT_OPTIONS, edited, editCommand, teamsCommand };
