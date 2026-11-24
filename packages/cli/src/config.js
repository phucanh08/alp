import { parseArgs } from 'node:util';
import { explainProfile, permissionScopes } from '@anhlp/alp-core/permissions';
import { discoverAgents } from '@anhlp/alp-core/resolver';
import { alpHome } from '@anhlp/alp-client/index';
import { UsageError } from './usage.js';
import { taskProject } from './tasks.js';

const SCOPE_LABEL = { project: 'project', user: 'user', default: 'default' };

/** `project  <file>  (<key>; <reason>)`, or `default  (<reason>)`: where one value came from. */
function origin(entry) {
  const notes = [entry.key, entry.reason].filter(Boolean).join('; ');
  return `${SCOPE_LABEL[entry.scope]}${entry.file ? `  ${entry.file}` : ''}${notes ? `  (${notes})` : ''}`;
}

function printAgent(row) {
  if (row.error) { console.log(`${row.agent}\n  error: ${row.error}`); return; }
  const { agent, profile, provenance, warnings } = row;
  if (!profile) {
    console.log(`${agent}\n  no profile: no settings file maps ${agent} to one; the mode its requester or the user chooses applies (default)`);
    return;
  }
  console.log(agent);
  const width = Math.max(...[profile.name, profile.base, profile.beyondMode].map(value => value.length));
  const line = (label, value, entry) => console.log(`  ${label.padEnd(11)} ${value.padEnd(width)}  ${origin(entry)}`);
  line('profile', profile.name, provenance.name);
  for (const shadowed of provenance.name.overrides ?? []) console.log(`  ${' '.repeat(11)} ${' '.repeat(width)}  overrides ${shadowed.value} from ${shadowed.scope}  ${shadowed.file}`);
  line('base', profile.base, provenance.base);
  line('beyondMode', profile.beyondMode, provenance.beyondMode);
  if (provenance.workdir) line('workdir', 'copy', provenance.workdir);
  for (const kind of ['allow', 'ask', 'deny']) {
    for (const { rule, sources } of provenance[kind]) console.log(`  ${kind.padEnd(5)} ${rule}  ${sources.map(source => `${source.scope}  ${source.file}`).join(' + ')}`);
  }
  for (const warning of warnings) console.log(`  warning: ${warning.message}`);
}

/**
 * alp config explain: where each value of every agent's permission profile comes from (scope and
 * settings file), with a warning where the project scope gives more than the user scope. A warning
 * never blocks and never changes the exit code; a settings file ALP cannot use does (exit 1), as
 * an agent could not start with it either.
 */
async function configCommand(args) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, agent: { type: 'string', multiple: true }, json: { type: 'boolean' } } });
  if (positionals.length !== 1 || positionals[0] !== 'explain') throw new UsageError();
  const root = await taskProject(values.project);
  const home = alpHome();
  const scopes = await permissionScopes(root, home);
  // Every agent the project can run, and any other a settings file maps to a profile.
  const agents = values.agent ?? [...new Set([...await discoverAgents(root, { library: home }), ...scopes.flatMap(scope => Object.keys(scope.agents))])];
  const rows = [];
  for (const agent of agents) {
    try { rows.push(await explainProfile(root, home, agent)); }
    catch (error) {
      if (error?.code !== 'INVALID_SETTINGS') throw error;
      rows.push({ agent, error: error.message });
    }
  }
  const files = scopes.map(({ scope, file, exists }) => ({ scope, file, exists }));
  const warnings = rows.flatMap(row => row.warnings ?? []);
  if (rows.some(row => row.error)) process.exitCode = 1;
  if (values.json) { console.log(JSON.stringify({ project: root, scopes: files, agents: rows, warnings })); return; }
  console.log('Permission settings, in the order ALP reads them (the project first):');
  for (const { scope, file, exists } of files) console.log(`  ${scope.padEnd(7)} ${file}${exists ? '' : '  (no such file)'}`);
  for (const row of rows) { console.log(''); printAgent(row); }
  if (warnings.length) {
    console.log(`\n${warnings.length} warning${warnings.length === 1 ? '' : 's'}: the project's settings give more than your own settings do. They apply as written; ALP only reports them. Read ${files[0].file} if you did not write it.`);
  }
}

export { configCommand };
