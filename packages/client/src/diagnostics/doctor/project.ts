import { access, constants, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CommandRunner } from '../../_shared/command.ts';
import { jsonObject, agentSources, resolveAgent } from '@anhlp/alp-core/resolver';
import { loadHooks } from '@anhlp/alp-core/hooks';
import { isTrusted } from '@anhlp/alp-core/trust';
import { settingsWarnings, validateSettings } from '@anhlp/alp-core/validation';
import type { LoadedHook } from '@anhlp/alp-core/hooks';
import type { DoctorCheck } from './types.ts';

/** A hook with the agents that use it. */
type UsedHook = LoadedHook & { agents: string[] };

export async function projectChecks(project: string, home: string): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const file = path.join(project, '.alp', 'settings.json');
  let settings;
  try {
    settings = await jsonObject(file, 'INVALID_SETTINGS');
    validateSettings(settings, file);
    const warnings = settingsWarnings(settings, 'project');
    checks.push(warnings.length
      ? { id: 'settings', status: 'warn', summary: `${file}: ${warnings.length} key${warnings.length > 1 ? 's' : ''} ALP ignores`, details: warnings }
      : { id: 'settings', status: 'ok', summary: file });
  } catch (error) {
    checks.push({ id: 'settings', status: 'fail', summary: (error as Error).message });
    return checks;
  }
  const sources = await agentSources(project, { library: home });
  const agents = [...sources.keys()].sort((a, b) => a.localeCompare(b));
  const broken: string[] = [];
  const shadows: string[] = [];
  const hooks = new Map<string, UsedHook>();
  // An override replaces the whole agent, so it misses later updates to the one it replaces.
  for (const [agent, { source, overrides }] of sources) if (overrides) shadows.push(`${agent}: the ${source}'s copy replaces the ${overrides === 'builtin' ? 'built-in' : 'library'} agent`);
  for (const agent of agents) {
    try {
      const resolved = await resolveAgent(project, { agent, library: home });
      for (const hook of await loadHooks(resolved)) hooks.set(hook.path, { ...hook, agents: [...(hooks.get(hook.path)?.agents ?? []), agent] });
      for (const skill of resolved.skills) if (!skill.path.startsWith(home + path.sep)) {
        const library = path.join(home, 'skills', skill.name, 'SKILL.md');
        if (await lstat(library).then(() => true, () => false)) shadows.push(`${agent}: ${skill.name} from the project replaces the library's`);
      }
    } catch (error) { broken.push(`${agent}: ${(error as Error).message}`); }
  }
  if (!agents.length) checks.push({ id: 'agents', status: 'fail', summary: 'no agents: neither ALP\'s built-ins nor the library nor the project define one' });
  else if (broken.length) checks.push({ id: 'agents', status: 'fail', summary: `${broken.length} of ${agents.length} agents cannot start`, details: broken });
  else checks.push({ id: 'agents', status: shadows.length ? 'info' : 'ok', summary: `${agents.length} agents resolve: ${agents.join(', ')}`, ...(shadows.length ? { details: shadows } : {}) });
  if (hooks.size) checks.push(await hooksCheck(project, home, [...hooks.values()]));
  if (settings.defaultAgent && !agents.includes(settings.defaultAgent)) checks.push({ id: 'agents', status: 'fail', summary: `defaultAgent ${settings.defaultAgent} is not an agent of this project` });
  return checks;
}

/** The command a hook starts, when it is a plain program name or path: the first word of its shell command. */
const program = (command: string): string | undefined => /^\s*([\w./-]+)/.exec(command)?.[1];
const SHELL_WORDS = new Set(['cd', 'test', '[', 'echo', 'exit', 'true', 'false', 'set', 'export', 'if', 'for', 'while', 'exec', 'env', 'command', 'printf', 'read', 'source', '.']);

/** Hooks the agents use: whether the project's may run, and whether their programs exist (ALPD §45). */
async function hooksCheck(project: string, home: string, hooks: UsedHook[]): Promise<DoctorCheck> {
  const missing: string[] = [];
  for (const hook of hooks) {
    const name = program(hook.command);
    if (!name || SHELL_WORDS.has(name)) continue;
    const candidates = name.includes('/') ? [path.resolve(project, name)] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, name));
    let found = false;
    for (const candidate of candidates) if (await access(candidate, constants.X_OK).then(() => true, () => false)) { found = true; break; }
    if (!found) missing.push(`${hook.name} (${hook.event}, used by ${hook.agents.join(', ')}): ${name} is not found`);
  }
  const fromProject = hooks.filter(hook => hook.project);
  const trusted = fromProject.length ? await isTrusted(home, project) : true;
  const details = [...missing, ...(!trusted ? [`not trusted yet: ${fromProject.map(hook => hook.name).join(', ')}; alpd asks the first time one runs, or run alp trust`] : [])];
  return {
    id: 'hooks', status: missing.length ? 'warn' : trusted ? 'ok' : 'info',
    summary: `${hooks.length} hook${hooks.length > 1 ? 's' : ''}${fromProject.length ? `, ${fromProject.length} from the project${trusted ? ', which the user trusts' : ', not trusted yet'}` : ''}${missing.length ? `; ${missing.length} cannot start` : ''}`,
    ...(details.length ? { details } : {}),
  };
}

/** Worktrees git lost track of, and alp/* branches: merged ones are dead weight, unmerged ones hold kept work. */
export async function branchCheck(project: string, home: string, run: CommandRunner): Promise<DoctorCheck[]> {
  const git = (args: string[]) => run('git', args, { cwd: project });
  const top = await git(['rev-parse', '--show-toplevel']);
  if (top.code !== 0) return [];
  const checks: DoctorCheck[] = [];
  const worktrees = (await git(['worktree', 'list', '--porcelain'])).stdout.split('\n\n').filter(Boolean);
  const prunable = worktrees.filter(block => /^prunable/m.test(block)).map(block => block.match(/^worktree (.*)$/m)?.[1]).filter(Boolean) as string[];
  if (prunable.length) checks.push({
    id: 'worktrees', status: 'warn', summary: `git still lists ${prunable.length} worktree${prunable.length > 1 ? 's' : ''} that no longer exist`, details: prunable,
    fix: { describe: 'git worktree prune', async apply() { await git(['worktree', 'prune']); return 'pruned'; } },
  });
  const checkedOut = new Set(worktrees.map(block => block.match(/^branch refs\/heads\/(.*)$/m)?.[1]).filter(Boolean));
  let live = [];
  try { live = JSON.parse(await readFile(path.join(home, 'state', 'live.json'), 'utf8')); } catch {}
  const inUse = new Set([...checkedOut, ...(Array.isArray(live) ? live.map(entry => entry?.worktree?.branch).filter(Boolean) : [])]);
  const branches = (await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/alp/'])).stdout.split('\n').filter(Boolean);
  if (!branches.length) return checks;
  const merged = new Set((await git(['branch', '--format=%(refname:short)', '--merged', 'HEAD', '--list', 'alp/*'])).stdout.split('\n').filter(Boolean));
  const spare = branches.filter(branch => merged.has(branch) && !inUse.has(branch));
  const kept = branches.filter(branch => !merged.has(branch) && !inUse.has(branch));
  if (spare.length) checks.push({
    id: 'branches', status: 'warn', summary: `${spare.length} alp/* branch${spare.length > 1 ? 'es are' : ' is'} already merged into HEAD`, details: spare,
    fix: {
      describe: `delete ${spare.length > 1 ? 'them' : 'it'} with git branch -d`,
      async apply() {
        let deleted = 0;
        for (const branch of spare) if ((await git(['branch', '-d', branch])).code === 0) deleted++;
        return `deleted ${deleted}`;
      },
    },
  });
  if (kept.length) checks.push({ id: 'branches', status: 'info', summary: `${kept.length} alp/* branch${kept.length > 1 ? 'es hold' : ' holds'} unmerged work from finished or interrupted assignments; merge or delete ${kept.length > 1 ? 'them' : 'it'} yourself`, details: kept });
  if (!spare.length && !kept.length) checks.push({ id: 'branches', status: 'ok', summary: `${branches.length} alp/* branch${branches.length > 1 ? 'es' : ''} in use` });
  return checks;
}
