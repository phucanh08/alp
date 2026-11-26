import { parseArgs } from 'node:util';
import { commandDecision, profileFor } from '@anhlp/alp-core/permissions';
import { discoverAgents } from '@anhlp/alp-core/resolver';
import { alpHome } from '@anhlp/alp-client/index';
import { taskProject } from '../_shared/project.js';
import { UsageError } from '../_shared/usage.js';

/** alp permissions: the profile each agent runs with, from .alp/settings.json and $ALP_HOME/settings.json. */
export async function permissionsCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' } } });
  const root = await taskProject(values.project);
  if (positionals[0] === 'check') {
    if (positionals.length !== 3) throw new UsageError();
    const profile = await profileFor(root, alpHome(), positionals[1]);
    const decision = profile ? commandDecision(profile, positionals[2]) : undefined;
    const result = { agent: positionals[1], profile: profile?.name ?? null, base: profile?.base ?? null, decision: decision ?? 'mode' };
    if (values.json) { console.log(JSON.stringify(result)); return; }
    // A decision comes only from a profile, so `profile!` holds in its three branches.
    console.log(decision === 'deny' ? `deny: a deny rule of profile ${profile!.name} covers it`
      : decision === 'ask' ? `ask: profile ${profile!.name} asks the user each time`
      : decision === 'allow' ? `allow: profile ${profile!.name} lets ${result.agent} run it, even beyond its ${profile!.base} mode`
      : `no rule covers it: ${result.agent}'s mode decides${profile ? ` (at most ${profile.base})` : ''}`);
    return;
  }
  if (positionals.length) throw new UsageError();
  const rows = [];
  for (const agent of await discoverAgents(root, { library: alpHome() })) rows.push({ agent, profile: await profileFor(root, alpHome(), agent) });
  if (values.json) { console.log(JSON.stringify(rows)); return; }
  for (const { agent, profile } of rows) {
    console.log(profile ? `${agent}  profile ${profile.name}, at most ${profile.base}${profile.beyondMode === 'ask' ? '; asks the user beyond it' : ''}` : `${agent}  no profile: the mode its requester or the user chooses`);
    if (profile?.allow.length) console.log(`  allow: ${profile.allow.join(', ')}`);
    if (profile?.ask.length) console.log(`  ask:   ${profile.ask.join(', ')}`);
    if (profile?.deny.length) console.log(`  deny:  ${profile.deny.join(', ')}`);
  }
}
