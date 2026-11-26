import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { seedLibrary } from '@anhlp/alp-core/library';
import { libraryEntries } from '@anhlp/alp-core/resolver';
import { deleteEntry, duplicateEntry, getEntry, renameEntry, restoreSkill, saveEntry, withSkillName } from '@anhlp/alp-core/library-edit';
import { testEntry } from '@anhlp/alp-client/library-test';
import { formatValidation, validateSkill } from '@anhlp/alp-core/skill-validate';
import { alpHome } from '@anhlp/alp-client/index';
import { projectFlag, taskProject } from '../_shared/project.ts';
import { UsageError } from '../_shared/usage.ts';

/** The library kinds an entry command edits. */
type EntryKind = 'agents' | 'skills' | 'mcp' | 'hooks' | 'teams' | 'providers';

export const pairs = (list: string[] | undefined, what: string): Record<string, string> => Object.fromEntries((list ?? []).map(item => {
  const at = item.indexOf('=');
  if (at <= 0) throw new Error(`${what} takes name=value, not '${item}'`);
  return [item.slice(0, at), item.slice(at + 1)];
}));

export const names = (text: string | undefined) => text === undefined ? undefined : text.split(',').map(name => name.trim()).filter(Boolean);

export const EDIT_OPTIONS = {
  project: { type: 'string' }, json: { type: 'boolean' }, from: { type: 'string' }, description: { type: 'string', short: 'd' },
  // agent
  provider: { type: 'string' }, model: { type: 'string' }, thinking: { type: 'string' }, mode: { type: 'string' },
  skills: { type: 'string' }, mcp: { type: 'string' }, hooks: { type: 'string' }, instructions: { type: 'string' },
  // team
  label: { type: 'string' }, main: { type: 'string' }, member: { type: 'string', multiple: true }, 'member-model': { type: 'string', multiple: true },
  'member-thinking': { type: 'string', multiple: true }, delegate: { type: 'string', multiple: true }, 'max-peers': { type: 'string' },
  supervisor: { type: 'string' }, 'supervisor-model': { type: 'string' }, 'supervisor-thinking': { type: 'string' }, 'no-supervisor': { type: 'boolean' }, rules: { type: 'string' },
  // skill, mcp, hook
  file: { type: 'string' }, roles: { type: 'string' }, 'no-roles': { type: 'boolean' }, command: { type: 'string' }, arg: { type: 'string', multiple: true }, env: { type: 'string', multiple: true }, cwd: { type: 'string' },
  url: { type: 'string' }, header: { type: 'string', multiple: true }, event: { type: 'string' }, blocking: { type: 'boolean' }, timeout: { type: 'string' },
  'match-agent': { type: 'string' }, 'match-label': { type: 'string' }, strict: { type: 'boolean' },
  // provider
  kind: { type: 'string' },
  models: { type: 'string' },
} as const;

/** The content of an entry after a CLI new or edit: the current content with the options applied. */

export async function edited(
  kind: string,
  name: string,
  // any: the entry's content as the library stores it (agent, team, skill, mcp, hook or provider JSON).
  current: any,
  // any: the parsed EDIT_OPTIONS, or the same names from the dashboard owner's request params.
  values: any,
  // any: the new content, of the same shape as `current`.
): Promise<any> {
  const content = structuredClone(current ?? {});
  // any: a part of that content.
  const set = (target: any, key: string, value: unknown) => { if (value !== undefined) { if (value === '') delete target[key]; else target[key] = value; } };
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
    content.body ??= `---\nname: ${name}\ndescription: ${JSON.stringify(values.description ?? `What ${name} does. Use when the work it is for comes up.`)}\n---\n\n# ${name}\n\n## When to use\n\n## Workflow\n\n## Verification\n`;
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
    delete provider.readOnlyMode; // Drop the retired no-op setting when saving an existing definition.
    if (values.arg?.length) provider.args = values.arg;
    if (values.env?.length) provider.env = pairs(values.env, '--env');
    const models = names(values.models);
    if (models) { if (models.length) provider.models = models.map(id => provider.models?.find((model: { id: string }) => model.id === id) ?? { id }); else delete provider.models; }
    content.provider = provider;
  }
  return content;
}

/**
 * alp skill check [name|DIR] [--project [DIR]] [--strict] [--json]: validates skills (Agent Skills
 * format, packages/core/src/skill-validate.js). Without a name, every skill the project and the
 * library hold; a name, the one that applies; a path, that directory. Existing skills are checked in
 * legacy mode (format problems are warnings) unless --strict. Reads only; exit 1 on an error.
 */
async function checkSkills(name: string | undefined, positionals: string[], values: { project?: string; strict?: boolean; json?: boolean }) {
  if (positionals.length > 2) throw new UsageError();
  const root = path.resolve(values.project ?? process.cwd());
  const mode = values.strict ? 'strict' : 'legacy';
  let targets: string[];
  if (name !== undefined && (name.includes('/') || name.includes(path.sep) || name.startsWith('.'))) targets = [path.resolve(name)];
  else {
    const rows = await libraryEntries('skills', root, { library: alpHome() });
    const chosen = name === undefined ? rows : rows.filter(row => row.name === name);
    if (name !== undefined && !chosen.length) throw new Error(`No skill '${name}' in ${path.join(root, '.alp', 'skills')} or ${path.join(alpHome(), 'skills')}`);
    // Every skill entry is a file on disk (SKILL.md), so it has a path.
    targets = chosen.map(row => path.dirname(row.path!));
  }
  const reports: Awaited<ReturnType<typeof validateSkill>>[] = [];
  for (const target of targets) reports.push(await validateSkill(target, { mode }));
  if (values.json) console.log(JSON.stringify(reports));
  else {
    for (const report of reports) console.log(formatValidation(report));
    const failed = reports.filter(report => !report.ok).length;
    const warned = reports.filter(report => report.warnings.length).length;
    console.log(`${reports.length} skill${reports.length === 1 ? '' : 's'} checked (${mode}): ${failed} with errors, ${warned} with warnings.${mode === 'legacy' && warned ? ' Warnings do not stop a skill from loading; fix them when you next edit it.' : ''}`);
  }
  if (reports.some(report => !report.ok)) process.exitCode = 1;
}

/** alp agent|team|skill|mcp|hook: create, change, copy, rename, remove and test library entries. */

export async function editCommand(kind: EntryKind, args: string[]) {
  if (kind === 'providers' && args.some(arg => arg === '--read-only-mode' || arg.startsWith('--read-only-mode='))) throw new Error('--read-only-mode was removed; delete readOnlyMode from provider JSON and choose the session --mode read-only, workspace-write or full-access. Existing native sessions keep their mode.');
  const { values, positionals } = parseArgs({ args: projectFlag(args), allowPositionals: true, options: EDIT_OPTIONS });
  const [action, name, target] = positionals;
  if (kind === 'skills' && action === 'restore') {
    if (!name || positionals.length > 2 || values.project !== undefined || (values.roles !== undefined && values['no-roles'])) throw new UsageError();
    const roles = values['no-roles'] ? [] : names(values.roles);
    const result = await restoreSkill(name, { library: alpHome(), from: values.from, roles });
    console.log(values.json ? JSON.stringify(result) : `Restored ${name} to ${result.restored} from ${result.from}; ${result.roles.length ? `given to ${result.roles.join(', ')}` : 'given to no role'}.`);
    return;
  }
  if (kind === 'skills' && action === 'check') { await checkSkills(name, positionals, values); return; }
  if (kind === 'providers' && action !== 'add') await seedLibrary(alpHome());
  const creates = ({ agents: 'new', teams: 'new', skills: 'new', mcp: 'add', hooks: 'add', providers: 'add' } as Record<string, string | undefined>)[kind];
  if (!name || positionals.length > (['cp', 'mv'].includes(action) ? 3 : 2) || (['cp', 'mv'].includes(action) && !target)) throw new UsageError();
  const scope = values.project !== undefined ? 'project' : 'library';
  let root = values.project !== undefined ? path.resolve(values.project) : undefined;
  if (scope === 'project') await taskProject(root);
  // A library edit still sees the current project, for what it uses.
  root ??= await access(path.join(process.cwd(), '.alp')).then(() => process.cwd(), () => undefined);
  const options = { scope, root, library: alpHome() };
  const done = (result: unknown, line: string) => console.log(values.json ? JSON.stringify(result) : line);
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
    // any: testEntry answers per kind (provider probe, MCP listing or hook run); each branch below reads its own kind's fields.
    const result: any = await testEntry(kind, name, { root, library: alpHome(), ...(values.project !== undefined ? { scope } : {}) });
    if (values.json) console.log(JSON.stringify(result));
    else if (kind === 'providers') {
      if (result.agent?.name === 'antigravity') {
        console.log(`${name}: ${result.agent?.title ?? 'Antigravity'} ${result.agent?.version ?? ''} (models: ${result.models?.length ?? 0}, mode: ${result.currentMode ?? 'full-access'})`);
      } else {
        console.log(`${name}: ${result.agent?.title ?? result.agent?.name ?? 'agent'} ${result.agent?.version ?? ''} speaks ACP ${result.protocolVersion}; ${result.loadSession ? 'resumes sessions' : 'cannot resume sessions'}${result.mcpHttp ? '; takes HTTP MCP servers' : ''}${result.authMethods?.length ? `; signs in with ${result.authMethods.join(', ')}` : ''}`);
      }
    }
    else if (kind === 'mcp') console.log(`${name}: ${result.server?.name ?? 'server'} ${result.server?.version ?? ''} offers ${result.tools.length} tools${result.tools.length ? `:\n${result.tools.map((tool: { name: string; description?: string }) => `  ${tool.name}${tool.description ? `  ${tool.description.split('\n')[0]}` : ''}`).join('\n')}` : ''}`);
    else console.log(`${name}: ${result.timedOut ? 'timed out' : `exit ${result.exitCode ?? result.signal}`} in ${result.durationMs} ms${result.wouldBlock ? '; as a blocking hook it would refuse the action' : ''}${result.stdout.trim() ? `\nstdout: ${result.stdout.trim()}` : ''}${result.stderr.trim() ? `\nstderr: ${result.stderr.trim()}` : ''}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  if (action !== creates && action !== 'edit') throw new UsageError();
  // any: the entry's content as the library stores it (see edited).
  let current: any;
  let revision = null;
  if (action === creates) {
    if (values.from !== undefined) current = (await getEntry(kind, values.from, { root, library: alpHome() })).content;
    // A skill made from another names itself, as its directory does.
    if (kind === 'skills' && current?.body !== undefined) current = { ...current, body: withSkillName(current.body, name) };
  } else {
    // Editing an entry that only a lower layer has makes this scope's copy of it.
    const entry = await getEntry(kind, name, { root, library: alpHome() }).catch((error: { code?: string }) => { if (error.code === 'NOT_FOUND') throw new Error(`No ${kind} entry '${name}'; create it with alp ${kind.replace(/s$/, '')} ${creates}`); throw error; });
    const own = await getEntry(kind, name, { root, library: alpHome(), scope }).catch(() => undefined);
    current = (own ?? entry).content;
    revision = own ? own.revision : null;
  }
  // A new skill meets the skill format strictly; an edit of an existing one is saved as before, and told what to fix.
  const result = await saveEntry(kind, name, await edited(kind, name, current, values), { ...options, revision, strict: kind === 'skills' && action === creates });
  done(result, `${action === 'edit' ? 'Saved' : 'Created'} ${name} in ${where}.`);
  if (kind === 'skills' && !values.json) {
    // A project scope has a root: taskProject(root) checked it above.
    const directory = path.join(scope === 'project' ? path.join(root!, '.alp') : alpHome(), 'skills', name);
    const report = await validateSkill(directory);
    const notes = [...(result.warnings ?? []), ...report.errors.map(finding => finding.message), ...report.warnings.map(finding => finding.message)];
    for (const note of [...new Set(notes)]) console.log(`note: ${note}`);
  }
}
