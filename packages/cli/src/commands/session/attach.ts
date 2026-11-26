import { parseArgs } from 'node:util';
import { UsageError } from '../_shared/usage.js';
import { running } from '../daemon/index.js';
import { follow, printer } from './output.js';

export async function attach(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length !== 1) throw new UsageError();
  const client = await running();
  try {
    const done = follow(client, positionals[0], printer(values.json), { untilIdle: false, interactive: !values.json && process.stdin.isTTY });
    const { session } = await client.request('session.attach', { sessionId: positionals[0] });
    if (session.id !== positionals[0]) console.error(`Following root ${session.id}`);
    // A closed session has only history; resume it with alp send.
    if (session.status === 'idle' || session.status === 'running') await done;
    else console.error(`Session is ${session.lastError?.code ?? session.status}; resume it with: alp send ${session.id} <text>`);
  } finally {
    client.close();
  }
}
