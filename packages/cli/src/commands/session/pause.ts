import { parseArgs } from 'node:util';
import { ago } from '@anhlp/alp-client/render';
import { UsageError } from '../_shared/usage.ts';
import { running } from '../daemon/index.ts';

/** Pauses and parked assignments, one line each; `always` also says when nothing is paused. */
// any: daemon.pauses as alpd sends it (all, runtimes, parked).
export function printPauses({ all, runtimes, parked }: any, always = true) {
  // any: one pause record of daemon.pauses.
  const line = (name: string, pause: any) => console.log(`⏸ ${name} paused since ${pause.since.slice(0, 16).replace('T', ' ')} by ${pause.by}: ${pause.reason}${pause.resetsAt ? `; the limit resets ${pause.resetsAt}` : ''}${pause.checkedAt ? `; ${name} last asked ${ago(pause.checkedAt)} ago` : ''}`);
  if (all) line('ALP', all);
  for (const [kind, pause] of Object.entries(runtimes)) line(kind, pause);
  for (const entry of parked) console.log(`  parked ${entry.agent} ${entry.assignmentId} (${entry.runtime}): ${entry.reason}`);
  if (always && !all && !Object.keys(runtimes).length) console.log('Nothing is paused');
}

/** alp pause: hold delegation and wakes on one runtime, or all; --now also parks running assignments. */

export async function pause(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { now: { type: 'boolean' }, message: { type: 'string', short: 'm' }, json: { type: 'boolean' } } });
  if (positionals.length > 1 || (positionals[0] && !['codex', 'claude', 'status'].includes(positionals[0]))) throw new UsageError();
  const client = await running();
  const state = await (positionals[0] === 'status'
    ? client.request('daemon.pauses')
    : client.request('daemon.pause', { ...(positionals[0] ? { runtime: positionals[0] } : {}), now: !!values.now, ...(values.message ? { reason: values.message } : {}) })).finally(() => client.close());
  if (values.json) console.log(JSON.stringify(state));
  else printPauses(state);
}

/** alp resume: lift a pause; parked assignments continue where they stopped. */

export async function resume(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length > 1 || (positionals[0] && !['codex', 'claude'].includes(positionals[0]))) throw new UsageError();
  const client = await running();
  const state = await client.request('daemon.resume', positionals[0] ? { runtime: positionals[0] } : {}).finally(() => client.close());
  if (values.json) console.log(JSON.stringify(state));
  else printPauses(state);
}
