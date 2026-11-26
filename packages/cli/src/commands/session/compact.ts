import { UsageError } from '../_shared/usage.js';
import { running } from '../daemon/index.js';

/** alp compact <session>: compacts a root's context now, or at its next turn boundary (t-0e56). */
export async function compact(args: string[]) {
  if (args.length !== 1) throw new UsageError();
  const client = await running();
  const { status } = await client.request('session.compact', { sessionId: args[0] }).finally(() => client.close());
  console.log(status === 'started' ? 'Compacting: main writes a checkpoint, then its context is compacted' : status === 'running' ? 'A compaction is already running' : 'Compaction queued for the next turn boundary');
}
