import { parseArgs } from 'node:util';
import { isTrusted, revokeProject, trustProject, trustedProjects } from '@anhlp/alp-core/trust';
import { alpHome } from '@anhlp/alp-client/index';
import { taskProject } from '../_shared/project.js';
import { UsageError } from '../_shared/usage.js';

/** alp trust: the workspaces whose hooks run without asking (ALPD §45). */
export async function trustCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, revoke: { type: 'boolean' }, list: { type: 'boolean' }, json: { type: 'boolean' } } });
  if (positionals.length || (values.revoke && values.list)) throw new UsageError();
  if (values.list) {
    const rows = await trustedProjects(alpHome());
    if (values.json) console.log(JSON.stringify(rows));
    else console.log(rows.length ? rows.map(row => `${row.root}  since ${row.trustedAt.slice(0, 10)} (${row.by})`).join('\n') : 'No workspace is trusted yet; ALP asks before a project\'s hooks first run.');
    return;
  }
  const root = await taskProject(values.project);
  if (values.revoke) {
    const was = await revokeProject(alpHome(), root);
    console.log(was ? `ALP asks again before the hooks of ${root} run.` : `${root} was not trusted.`);
    return;
  }
  if (await isTrusted(alpHome(), root)) { console.log(`${root} is already trusted.`); return; }
  await trustProject(alpHome(), root, 'alp trust');
  console.log(`The hooks of ${root} now run without asking, including hooks added or changed later.`);
}
