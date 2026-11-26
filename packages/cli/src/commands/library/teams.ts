import path from 'node:path';
import { parseArgs } from 'node:util';
import { listTeams, resolveTeam } from '@anhlp/alp-core/teams';
import { alpHome } from '@anhlp/alp-client/index';
import type { ResolvedTeam, TeamRow } from '@anhlp/alp-core/teams';
import { UsageError } from '../_shared/usage.js';

/** alp teams: each team with where it comes from, its main, members and delegation. */
export async function teamsCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const root = path.resolve(values.project ?? process.cwd());
  const options = { library: alpHome() };
  const rows: Array<TeamRow & { team?: ResolvedTeam }> = [];
  for (const row of await listTeams(root, options)) rows.push(row.error ? row : { ...row, team: await resolveTeam(root, row.id, options) });
  if (values.json) { console.log(JSON.stringify(rows.map(({ team, ...row }) => ({ ...row, ...(team ? { main: team.main, members: team.members, delegation: team.delegation, maxPeers: team.maxPeers, supervisor: team.supervisor } : {}) })))); return; }
  for (const { team, ...row } of rows) {
    const where = row.source === 'builtin' ? 'built-in' : row.source;
    console.log(`${row.id}  ${row.label ?? ''}  ${where}${row.overrides ? `, overrides the ${row.overrides === 'builtin' ? 'built-in' : row.overrides} one` : ''}`);
    if (row.error) { console.log(`  error: ${row.error}`); continue; }
    const member = (name: string, { role, model, thinking }: { role?: string; model?: string; thinking?: string }) => `${name}${role ? ` (${role})` : ' (main)'}${model ? ` on ${model}${thinking ? `, ${thinking}` : ''}` : ''}`;
    // A row without an error was resolved above, so it has its team.
    console.log(`  members: ${Object.entries(team!.members).map(([name, value]) => member(name, value)).join(', ')}`);
    console.log(`  delegation: ${Object.entries(team!.delegation).map(([owner, targets]) => `${owner} → ${targets.join(', ')}`).join('; ') || 'none'}`);
    console.log(`  supervisor: ${team!.supervisor ? member(team!.supervisor.agent, { role: 'watches main', model: team!.supervisor.model, thinking: team!.supervisor.thinking }) : 'none'}${team!.maxPeers ? `; at most ${team!.maxPeers} peers` : ''}`);
  }
}
