import { parseArgs } from 'node:util';
import { ago } from '@anhlp/alp-client/render';
import { AGENT_MARKER, isAgentProcess } from '@anhlp/alp-core/tasks';
import { UsageError } from '../_shared/usage.js';
import { running } from '../daemon/index.js';

export async function questions(args: string[]) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { json: { type: 'boolean' } } });
  if (positionals.length) throw new UsageError();
  const client = await running();
  const { questions: pending } = await client.request('question.list').finally(() => client.close());
  if (values.json) { console.log(JSON.stringify(pending)); return; }
  if (!pending.length) { console.log('No questions wait for you'); return; }
  for (const question of pending) {
    console.log(`${question.id}  ${question.agent}  ${ago(question.askedAt)} ago  root ${question.rootId}`);
    console.log(`  ${question.body.replace(/\n/g, '\n  ')}`);
    if (question.options?.length) console.log(`  options: ${question.options.join(' | ')}`);
  }
}

export async function answer(args: string[]) {
  const { values, positionals: [questionId, ...words] } = parseArgs({ args, allowPositionals: true, options: { dismiss: { type: 'boolean' }, reason: { type: 'string' } } });
  const text = words.join(' ').trim();
  if (!questionId || (values.dismiss ? text : !text)) throw new UsageError();
  // An answer speaks for the user: never from a process an ALP agent started (t-ca1f).
  if (isAgentProcess()) throw new Error(`Only the user answers a question; this process runs under an ALP agent (${AGENT_MARKER})`);
  const client = await running();
  const result = await client.request('question.answer', values.dismiss ? { questionId, dismiss: true, reason: values.reason } : { questionId, text }).finally(() => client.close());
  console.log(`${values.dismiss ? 'Dismissed' : 'Answered'} ${result.questionId}`);
}
