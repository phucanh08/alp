import path from 'node:path';
import { parseArgs } from 'node:util';
import { seedLibrary } from '@anhlp/alp-core/library';
import { libraryEntries } from '@anhlp/alp-core/resolver';
import { listRetiredSkills } from '@anhlp/alp-core/library-edit';
import { alpHome } from '@anhlp/alp-client/index';
import { UsageError } from '../_shared/usage.js';

/** Lists one library kind: where each entry comes from, what it overrides, and who uses it. */
export async function libraryCommand(kind: string, args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { project: { type: 'string' }, json: { type: 'boolean' }, ...(kind === 'skills' ? { retired: { type: 'boolean' } } : {}) } });
  if (positionals.length) throw new UsageError();
  if (values.retired) {
    if (values.project !== undefined) throw new UsageError();
    const rows = await listRetiredSkills({ library: alpHome() });
    if (values.json) { console.log(JSON.stringify(rows)); return; }
    if (!rows.length) { console.log(`No retired skills in ${path.join(alpHome(), 'retired-skills')}`); return; }
    const width = Math.max(...rows.map(row => row.name.length));
    for (const row of rows) console.log(`${row.name.padEnd(width)}  ${row.retiredAt}  ${row.roles === null ? 'roles not recorded' : `roles: ${row.roles.join(', ') || 'none'}`}${row.agent ? `; by ${row.agent}` : ''}${row.invalid ? `; warning: invalid retired metadata: ${row.invalid}` : ''}  ${row.directory}`);
    return;
  }
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
