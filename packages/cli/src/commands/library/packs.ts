import path from 'node:path';
import { parseArgs } from 'node:util';
import { installPack, listPacks, packStatus } from '@anhlp/alp-core/packs';
import { alpHome } from '@anhlp/alp-client/index';
import { projectFlag, taskProject } from '../_shared/project.js';
import { UsageError } from '../_shared/usage.js';

/**
 * alp packs [--project DIR] [--json]: the optional packs ALP ships, and whether the library or the
 * project has them. alp pack install <id> [--project [DIR]] [--assign] [--json]: copies a pack's
 * skills, agents and teams into the library (or the project's .alp/), keeping any entry already
 * there; --assign (library) gives its suggested skills to roles in role-skills.json.
 */
export async function packsCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const root = path.resolve(values.project ?? process.cwd());
  const rows: Array<Awaited<ReturnType<typeof listPacks>>[number] & { installed: Awaited<ReturnType<typeof packStatus>> }> = [];
  for (const pack of await listPacks()) rows.push({ ...pack, installed: await packStatus(pack, { root, library: alpHome() }) });
  if (values.json) { console.log(JSON.stringify(rows)); return; }
  const width = Math.max(...rows.map(row => row.id.length));
  for (const row of rows) {
    const contents = [row.skills.length ? `skills: ${row.skills.join(', ')}` : '', row.agents.length ? `agents: ${row.agents.join(', ')}` : '', row.teams.length ? `teams: ${row.teams.join(', ')}` : ''].filter(Boolean).join('; ');
    const where = [row.installed.library ? 'library' : '', row.installed.project ? 'project' : ''].filter(Boolean).join(', ');
    console.log(`${row.id.padEnd(width)}  ${row.description}\n${' '.repeat(width)}  ${contents}${where ? `  [installed: ${where}]` : ''}`);
  }
  console.log('Install one with: alp pack install <id> [--project] [--assign]');
}

export async function packCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args: projectFlag(args), allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' }, assign: { type: 'boolean' } } });
  const [action, id] = positionals;
  if (action !== 'install' || !id || positionals.length > 2) throw new UsageError();
  const scope = values.project !== undefined ? 'project' : 'library';
  const root = values.project !== undefined ? path.resolve(values.project) : undefined;
  if (scope === 'project') await taskProject(root);
  const result = await installPack(id, { scope, root, library: alpHome(), assign: values.assign });
  if (values.json) { console.log(JSON.stringify(result)); return; }
  const where = scope === 'project' ? `the project ${root}` : `your library ${alpHome()}`;
  for (const entry of result.installed) console.log(`installed ${entry.kind.replace(/s$/, '')} ${entry.name}  ${entry.path}`);
  for (const entry of result.kept) console.log(`kept      ${entry.kind.replace(/s$/, '')} ${entry.name}: one already exists, and stays as it is (${entry.path})`);
  for (const line of result.permissions.set) console.log(`permission ${line} (agent capped by its permission profile)`);
  for (const line of result.permissions.conflicts) console.log(`warning: ${line}`);
  if (result.assigned.length) console.log(`assigned  ${result.assigned.join(', ')} in role-skills.json`);
  else if (!values.assign && scope === 'library' && result.installed.some(entry => entry.kind === 'skills')) console.log('No role has these skills yet: rerun with --assign for the pack\'s suggestion, or alp agent edit <agent> --skills a,b.');
  console.log(`Pack ${id} in ${where}. Start a new session (or close and resume) for agents to see it.`);
}
