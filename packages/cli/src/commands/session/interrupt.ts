import { UsageError } from '../_shared/usage.ts';
import { running } from '../daemon/index.ts';

export async function interrupt(args: string[]) {
  if (args.length !== 1) throw new UsageError();
  const client = await running();
  await client.request('session.interrupt', { sessionId: args[0] }).finally(() => client.close());
  console.log('Interrupted');
}
