import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { connect } from '@anhlp/alp-client/index';
import { UsageError } from '../_shared/usage.ts';
import { start } from '../daemon/index.ts';
import { follow, printer } from './output.ts';

export async function run(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    agent: { type: 'string' }, team: { type: 'string' }, profile: { type: 'string' }, workflow: { type: 'string' }, model: { type: 'string' }, mode: { type: 'string' },
    thinking: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' },
  } });
  const text = positionals.join(' ').trim();
  if (!text) throw new UsageError();
  // --profile and --workflow are the option's names before teams.
  const teams = [values.team, values.profile, values.workflow].filter(Boolean);
  if (new Set(teams).size > 1) throw new UsageError();
  const client = await connect(await start(), { name: 'alp-cli', version: '1' });
  try {
    const spec = { cwd: path.resolve(values.project ?? process.cwd()), persist: true, agent: values.agent, workflow: teams[0], model: values.model, mode: values.mode, thinking: values.thinking };
    const sessionId = `cli-${randomUUID()}`;
    const done = follow(client, sessionId, printer(values.json), { untilIdle: true, interactive: !values.json && process.stdin.isTTY });
    await client.request('session.create', { sessionId, spec });
    await client.request('session.prompt', { sessionId, clientMessageId: randomUUID(), content: [{ type: 'text', text }] });
    if (!await done) process.exitCode = 1;
    await client.request('session.release', { sessionId }).catch(() => {});
  } finally {
    client.close();
  }
}
