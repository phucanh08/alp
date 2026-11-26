import { parseArgs } from 'node:util';
import { renderLog } from '@anhlp/alp-client/render';
import { UsageError } from '../_shared/usage.js';
import { running } from '../daemon/index.js';

/** The tree's assignment log: delegations, mail, handoffs, worktrees and questions to the user. */

export async function log(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length !== 1) throw new UsageError();
  const client = await running();
  const { rootId, entries } = await client.request('session.log', { sessionId: positionals[0] }).finally(() => client.close());
  if (values.json) { for (const entry of entries) console.log(JSON.stringify(entry)); return; }
  if (!entries.length) { console.log(`No assignment log for ${rootId}`); return; }
  for (const line of renderLog(rootId, entries)) console.log(line);
}
