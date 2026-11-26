import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { connect } from '@anhlp/alp-client/index';
import { UsageError } from '../_shared/usage.ts';
import { start } from '../daemon/index.ts';
import { follow, printer } from './output.ts';

/** Steers a running root, prompts an idle one, or resumes a closed one; then follows it until idle. */

export async function send(args: string[]) {
  const { values, positionals: [sessionId, ...words] } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' }, prompt: { type: 'boolean' } } });
  const text = words.join(' ').trim();
  if (!sessionId || !text) throw new UsageError();
  const client = await connect(await start(), { name: 'alp-cli', version: '1' });
  let subscriptionId: string | undefined;
  try {
    const { session } = await client.request('session.get', { sessionId });
    if (session.parentId && !values.prompt) {
      // An assignment gets the text as mail from the user, in its running turn.
      await client.request('session.message', { sessionId, text });
      if (!values.json) console.error(`Sent to ${session.agent} as mail from the user`);
      return;
    }
    const live = session.status === 'idle' || session.status === 'running';
    if (values.prompt && !live) throw new Error('Explicit prompts require a live session; use default alp send to reopen a root');
    const clientMessageId = randomUUID();
    const done = follow(client, sessionId, printer(values.json), { untilIdle: true, interactive: !values.json && process.stdin.isTTY, targetOnly: !!session.parentId, promptId: clientMessageId });
    if (live) {
      const attached = await client.request('session.attach', { sessionId, replay: false });
      subscriptionId = attached.session.id; // A child attaches its root for observation only.
    } else {
      await client.request('session.create', { sessionId, spec: { cwd: session.projectRoot } });
      subscriptionId = sessionId;
    }
    const steer = !values.prompt && live && !!session.activeTurnId;
    await client.request('session.prompt', { sessionId, clientMessageId, delivery: steer ? 'steer' : 'auto', content: [{ type: 'text', text }] });
    if (!values.json) console.error(values.prompt ? 'Submitted an explicit prompt' : steer ? 'Steered the running turn' : live ? 'Started a turn' : 'Resumed the session');
    if (!await done) process.exitCode = 1;
  } finally {
    if (subscriptionId) await client.request('session.release', { sessionId: subscriptionId }).catch(() => {});
    client.close();
  }
}
