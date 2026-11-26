import { parseArgs } from 'node:util';
import { UsageError } from '../_shared/usage.js';
import { running } from '../daemon/index.js';

/** The models alpd offers now: the live catalog (t-e5ee); --refresh asks every provider again first. */
export async function models(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { refresh: { type: 'boolean' }, json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const client = await running();
  const catalog = await client.request(values.refresh ? 'catalog.refresh' : 'catalog.get', {}).finally(() => client.close());
  if (values.json) { console.log(JSON.stringify(catalog)); return; }
  // any: catalog.get's per-provider state as alpd sends it.
  for (const [runtime, state] of Object.entries<any>(catalog.providers ?? {})) console.log(`${runtime}: ${state.status}${state.fetchedAt ? ` (${state.fetchedAt})` : ''}${state.error ? ` — ${state.error}` : ''}`);
  for (const model of catalog.models) console.log(`${model.id.padEnd(40)} ${model.label}`);
}
