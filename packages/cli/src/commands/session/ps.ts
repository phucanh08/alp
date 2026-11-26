import { parseArgs } from 'node:util';
import { renderPs } from '@anhlp/alp-client/render';
import { UsageError } from '../_shared/usage.js';
import { running } from '../daemon/index.js';
import { printPauses } from './pause.js';

export async function ps(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { all: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const client = await running();
  const [{ sessions }, pauses] = await Promise.all([client.request('session.list', { includeClosed: values.all }), client.request('daemon.pauses')]).finally(() => client.close());
  printPauses(pauses, false);
  if (!sessions.length) { console.log(values.all ? 'No sessions' : 'No live sessions'); return; }
  for (const line of renderPs(sessions)) console.log(line);
}
